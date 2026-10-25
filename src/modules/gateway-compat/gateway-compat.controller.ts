/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Request, Response } from 'express';
import { AuthService } from '../auth/auth.service.ts';
import { BlockchainAdapter } from '../blockchain-adapter/adapter.interface.ts';
import { computeCanonicalHash } from '../canonicalization/canonicalizer.ts';
import { HashingService } from '../canonicalization/hashing.service.ts';
import { OutboxService } from '../outbox/outbox.service.ts';
import {
  IdempotencyConflictError,
  TransactionsService,
  ValidationError,
} from '../transactions/transactions.service.ts';

/**
 * Optional observability providers injected by the composition root so the
 * public health probe can report aggregate webhook / reconciliation state
 * WITHOUT exposing secrets, credentials, or raw transaction payloads. When not
 * supplied (e.g. in unit tests) those sections are simply omitted.
 */
export interface HealthMetricsProviders {
  webhookMetrics?: () => Promise<Record<string, unknown>>;
  reconciliationMetrics?: () => Promise<Record<string, unknown>>;
  /**
   * Live connectivity probe for the durable backend, injected by the
   * composition root when a database client is wired. Returns true only when a
   * real round-trip to the database succeeded, so the health endpoint never
   * reports "connected" based on configuration alone. Omitted (undefined) in
   * in-memory / unit-test runs.
   */
  databaseProbe?: () => Promise<boolean>;
}

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export class GatewayCompatController {
  private hashingService: HashingService;

  constructor(
    private readonly authService: AuthService,
    private readonly transactionsService: TransactionsService,
    private readonly outboxService: OutboxService,
    private readonly blockchainAdapter: BlockchainAdapter,
    private readonly metricsProviders?: HealthMetricsProviders
  ) {
    this.hashingService = transactionsService.getHashingService();
  }

  /**
   * Switching Ingestion Endpoint: POST /v1/transactions
   * Accepts correlationId, idempotencyKey (header or body), transactionType, payload
   * Returns HTTP 202 { gatewayRequestId, status: "pending" } (or external status)
   * Returns HTTP 409 Conflict on idempotency key mismatch with different payload
   */
  async submitTransaction(req: Request, res: Response): Promise<void> {
    const apiKey = (req.headers['x-api-key'] || req.headers['authorization']) as string | undefined;
    const authContext = this.authService.validateSwitchingApiKey(apiKey);

    if (!authContext) {
      res.status(401).json({
        statusCode: 401,
        error: 'Unauthorized',
        errorCode: 'UNAUTHORIZED',
        message: 'Missing or invalid X-Api-Key header for Switching Gateway Ingestion',
      });
      return;
    }

    // Layer 2 — HMAC-SHA256 integrity + anti-replay over the exact bytes
    // Switching signed (`${timestamp}.${rawBody}`), using its default
    // `x-switching-signature` / `x-switching-timestamp` convention. The raw
    // body is captured by the express.json({ verify }) hook in server.ts;
    // re-serializing req.body would not reproduce the signed bytes.
    const signatureResult = this.authService.validateInboundSignature({
      signature: req.headers['x-switching-signature'] as string | undefined,
      timestamp: req.headers['x-switching-timestamp'] as string | undefined,
      rawBody: (req as unknown as { rawBody?: string }).rawBody,
    });

    if (!signatureResult.accepted) {
      res.status(401).json({
        statusCode: 401,
        error: 'Unauthorized',
        errorCode: 'INVALID_SIGNATURE',
        message: `Request signature verification failed: ${signatureResult.reason ?? 'unknown'}`,
      });
      return;
    }

    if (signatureResult.reason && !signatureResult.verified) {
      // Honest operational signal: accepted, but the caller was NOT
      // cryptographically authenticated (secret not configured, or the
      // graceful-rollout window is still open).
      console.warn(`[UBTL] Inbound signature not verified: ${signatureResult.reason}`);
    }

    const headerIdempotencyKey = req.headers['idempotency-key'] as string | undefined;
    const headerCorrelationId = req.headers['x-correlation-id'] as string | undefined;

    const body = req.body || {};
    const correlationId = body.correlationId || headerCorrelationId;
    const idempotencyKey = headerIdempotencyKey || body.idempotencyKey;
    const { transactionType, payload } = body;

    if (!correlationId || typeof correlationId !== 'string' || correlationId.trim() === '') {
      res.status(400).json({
        statusCode: 400,
        error: 'Bad Request',
        errorCode: 'MISSING_CORRELATION_ID',
        message: "Missing or invalid required field 'correlationId'",
      });
      return;
    }

    if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
      res.status(400).json({
        statusCode: 400,
        error: 'Bad Request',
        errorCode: 'MISSING_IDEMPOTENCY_KEY',
        message: "Missing or invalid required field 'idempotencyKey' (must be provided in body or Idempotency-Key header)",
      });
      return;
    }

    if (!transactionType || typeof transactionType !== 'string' || transactionType.trim() === '') {
      res.status(400).json({
        statusCode: 400,
        error: 'Bad Request',
        errorCode: 'MISSING_TRANSACTION_TYPE',
        message: "Missing or invalid required field 'transactionType'",
      });
      return;
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      res.status(400).json({
        statusCode: 400,
        error: 'Bad Request',
        errorCode: 'INVALID_PAYLOAD',
        message: "Missing or invalid required field 'payload' (must be a JSON object)",
      });
      return;
    }

    try {
      // ingest() atomically persists the transaction row, its initial status
      // history and its initial DISPATCH_LEDGER outbox event in one unit of
      // work. A persistence failure therefore rejects here and MUST NOT be
      // reported as a misleading HTTP 202.
      const ingestionResult = await this.transactionsService.ingest({
        correlationId,
        idempotencyKey,
        transactionType,
        payload,
        organizationId: authContext.organizationId,
      });

      // Return HTTP 202 Accepted with durable acceptance details
      // Note: In Switching contract, status represents current external state
      res.status(202).json({
        gatewayRequestId: ingestionResult.gatewayRequestId,
        status: ingestionResult.status,
        lifecycleState: ingestionResult.transaction.lifecycleState,
        isSimulated: this.blockchainAdapter.mode === 'mock',
        // Additive, non-breaking: tells Switching whether its HMAC signature
        // was actually verified, so it never assumes protection it did not get.
        signatureVerified: signatureResult.verified,
      });
    } catch (err: unknown) {
      if (err instanceof IdempotencyConflictError) {
        res.status(409).json({
          statusCode: 409,
          error: 'Conflict',
          errorCode: err.code,
          message: err.message,
        });
        return;
      }

      if (err instanceof ValidationError) {
        res.status(400).json({
          statusCode: 400,
          error: 'Bad Request',
          errorCode: err.code,
          message: err.message,
          details: err.errors,
        });
        return;
      }

      // Unexpected/internal failure (e.g. persistence unavailable). We must NOT
      // echo raw internal/database messages (information disclosure) and must
      // NOT report a misleading success. Log server-side, return a safe 500.
      console.error('[UBTL] Transaction ingestion failed:', err);
      res.status(500).json({
        statusCode: 500,
        error: 'Internal Server Error',
        errorCode: 'INGESTION_FAILED',
        message:
          'Transaction could not be durably persisted; no acceptance has been recorded. Retry with the same Idempotency-Key.',
      });
    }
  }

  /**
   * Switching Query Status Endpoint: GET /v1/transactions/:gatewayRequestId
   * Protected endpoint requiring authentication
   */
  async getTransactionStatus(req: Request, res: Response): Promise<void> {
    const apiKey = (req.headers['x-api-key'] || req.headers['authorization']) as string | undefined;
    const authContext =
      this.authService.validateSwitchingApiKey(apiKey) || this.authService.validateAdminApiKey(apiKey);

    if (!authContext) {
      res.status(401).json({
        statusCode: 401,
        error: 'Unauthorized',
        errorCode: 'UNAUTHORIZED',
        message: 'Missing or invalid authentication header',
      });
      return;
    }

    const { gatewayRequestId } = req.params;

    // Boundary validation: gateway_request_id is a UUID column. A non-UUID
    // value (e.g. a peer polling with a legacy/mock id) makes Prisma throw
    // P2023; unhandled, that rejection killed the whole process and took the
    // service down for every peer. Reject malformed ids deterministically.
    if (!UUID_PATTERN.test(gatewayRequestId)) {
      res.status(400).json({
        statusCode: 400,
        error: 'Bad Request',
        errorCode: 'INVALID_GATEWAY_REQUEST_ID',
        message: `gatewayRequestId '${gatewayRequestId}' is not a valid UUID`,
      });
      return;
    }

    let tx;
    try {
      tx = await this.transactionsService.getById(gatewayRequestId);
    } catch (err) {
      // Never let a persistence failure become an unhandled rejection.
      console.error('[UBTL] Transaction status lookup failed:', err);
      res.status(500).json({
        statusCode: 500,
        error: 'Internal Server Error',
        errorCode: 'LOOKUP_FAILED',
        message: 'Transaction status could not be read from the durable store.',
      });
      return;
    }

    if (!tx) {
      res.status(404).json({
        statusCode: 404,
        error: 'Not Found',
        errorCode: 'TRANSACTION_NOT_FOUND',
        message: `Transaction with gatewayRequestId '${gatewayRequestId}' not found`,
      });
      return;
    }

    res.status(200).json({
      gatewayRequestId: tx.gatewayRequestId,
      correlationId: tx.correlationId,
      status: tx.status,
      lifecycleState: tx.lifecycleState,
      blockchainTxHash: tx.blockchainTxHash,
      payloadHash: tx.payloadHash,
      hashAlgorithm: tx.hashAlgorithm,
      hashVersion: tx.hashVersion,
      canonicalizationSpec: tx.canonicalizationSpec,
      fabricTransactionId: tx.fabricTransactionId,
      blockNumber: tx.blockNumber ? Number(tx.blockNumber) : null,
      isSimulated: this.blockchainAdapter.mode === 'mock',
      submittedAt: tx.submittedAt,
      confirmedAt: tx.confirmedAt,
      errorMessage: tx.errorMessage,
    });
  }

  /**
   * Cryptographic Verification Endpoint: POST /v1/transactions/verify
   * Protected endpoint requiring authentication
   * Strictly enforces honest mock-mode semantics (does not claim real Fabric commit in mock mode)
   */
  async verifyTransaction(req: Request, res: Response): Promise<void> {
    const apiKey = (req.headers['x-api-key'] || req.headers['authorization']) as string | undefined;
    const authContext =
      this.authService.validateSwitchingApiKey(apiKey) || this.authService.validateAdminApiKey(apiKey);

    if (!authContext) {
      res.status(401).json({
        statusCode: 401,
        error: 'Unauthorized',
        errorCode: 'UNAUTHORIZED',
        message: 'Missing or invalid authentication header for transaction verification',
      });
      return;
    }

    const { gatewayRequestId, payload } = req.body || {};

    if (!gatewayRequestId) {
      res.status(400).json({
        statusCode: 400,
        errorCode: 'MISSING_GATEWAY_REQUEST_ID',
        message: 'Missing gatewayRequestId',
      });
      return;
    }

    // Same boundary guard as GET /v1/transactions/:gatewayRequestId. This
    // endpoint accepts a client-supplied gatewayRequestId too, so an unvalidated
    // non-UUID value reaches the UUID-typed Prisma column and raises P2023 as an
    // unhandled rejection — which terminated the whole process and took the
    // service down for every peer.
    if (typeof gatewayRequestId !== 'string' || !UUID_PATTERN.test(gatewayRequestId)) {
      res.status(400).json({
        statusCode: 400,
        errorCode: 'INVALID_GATEWAY_REQUEST_ID',
        message: `gatewayRequestId '${gatewayRequestId}' is not a valid UUID`,
      });
      return;
    }

    let tx;
    try {
      tx = await this.transactionsService.getById(gatewayRequestId);
    } catch (err) {
      // Never let a persistence failure become an unhandled rejection.
      console.error('[UBTL] Transaction verification lookup failed:', err);
      res.status(500).json({
        statusCode: 500,
        errorCode: 'LOOKUP_FAILED',
        message: 'Transaction could not be read from the durable store.',
      });
      return;
    }
    if (!tx) {
      res.status(404).json({
        statusCode: 404,
        errorCode: 'TRANSACTION_NOT_FOUND',
        message: `Transaction with gatewayRequestId '${gatewayRequestId}' not found`,
      });
      return;
    }

    // Verify stored payload or supplied payload
    const payloadToVerify = payload || tx.rawPayload;

    const verificationResult = this.hashingService.verifyPayload(
      tx.transactionType,
      payloadToVerify,
      tx.payloadHash,
      tx.schemaVersion,
      { correlationId: tx.correlationId, gatewayRequestId: tx.gatewayRequestId }
    );

    const isMock = this.blockchainAdapter.mode === 'mock';
    let simulatedCommitObserved = false;
    let realLedgerCommitVerified = false;

    if (tx.fabricTransactionId) {
      const proof = await this.blockchainAdapter.getTransactionProof(tx.fabricTransactionId);
      if (proof && proof.payloadHash === tx.payloadHash) {
        if (isMock) {
          simulatedCommitObserved = true;
          // In mock mode, we MUST NOT claim a real production ledger commit!
          realLedgerCommitVerified = false;
        } else {
          realLedgerCommitVerified = true;
        }
      }
    }

    if (verificationResult.verified && (realLedgerCommitVerified || simulatedCommitObserved)) {
      await this.transactionsService.markVerified(tx.gatewayRequestId);
    }

    res.status(200).json({
      verified: verificationResult.verified,
      computedHash: verificationResult.computedHash,
      storedPayloadHash: tx.payloadHash,
      // Honest mock-mode semantics
      ledgerCommitVerified: realLedgerCommitVerified,
      simulatedCommitObserved: isMock ? simulatedCommitObserved : undefined,
      isSimulated: isMock,
      simulationNotice: isMock
        ? 'Ledger commit was verified in local mock simulator (BLOCKCHAIN_ADAPTER_MODE=mock). No production Hyperledger Fabric network was contacted.'
        : undefined,
      blockNumber: tx.blockNumber ? Number(tx.blockNumber) : null,
      fabricTransactionId: tx.fabricTransactionId,
      canonicalPayload: verificationResult.canonicalPayload,
      hashAlgorithm: verificationResult.hashAlgorithm,
      hashVersion: verificationResult.hashVersion,
      canonicalizationSpec: verificationResult.canonicalizationSpec,
      error: verificationResult.error || null,
    });
  }

  /**
   * Health Endpoint: GET /v1/health (Public operational endpoint)
   * Honestly reports database persistence durability and adapter mode
   */
  async getHealth(_req: Request, res: Response): Promise<void> {
    const adapterHealth = await this.blockchainAdapter.healthCheck();
    const storageMetadata = this.transactionsService.getStorageMetadata();
    const workerObservability = await this.outboxService.getObservability();

    // Aggregate webhook / reconciliation observability. Only surfaced when the
    // composition root injects providers; never includes secrets or raw payloads.
    const webhookMetrics = this.metricsProviders?.webhookMetrics
      ? await this.metricsProviders.webhookMetrics()
      : undefined;
    const reconciliationMetrics = this.metricsProviders?.reconciliationMetrics
      ? await this.metricsProviders.reconciliationMetrics()
      : undefined;

    // Live database round-trip (only when a durable backend is wired). A failed
    // probe must NOT be reported as "connected" — the operator needs to know the
    // configured backend is unreachable. A probe failure also flips the overall
    // service status to "degraded" so uptime checks can react.
    let databaseProbe: 'reachable' | 'unreachable' | 'not-configured' = 'not-configured';
    if (this.metricsProviders?.databaseProbe) {
      try {
        databaseProbe = (await this.metricsProviders.databaseProbe()) ? 'reachable' : 'unreachable';
      } catch {
        databaseProbe = 'unreachable';
      }
    }
    const databaseReachable = databaseProbe !== 'unreachable';

    res.status(200).json({
      status: databaseReachable ? 'healthy' : 'degraded',
      service: 'Universal Blockchain Transaction Ledger (UBTL)',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      adapterMode: adapterHealth.mode,
      database: {
        status: storageMetadata.isDurable ? 'connected' : 'in-memory-simulation',
        storageType: storageMetadata.storageType,
        durable: storageMetadata.isDurable,
        productionReady: storageMetadata.productionReady,
        details: storageMetadata.details,
        probe: databaseProbe,
      },
      blockchainAdapter: adapterHealth,
      worker: {
        workerId: workerObservability.workerId,
        running: workerObservability.isRunning,
        isShuttingDown: workerObservability.isShuttingDown,
        lastPollTime: workerObservability.lastPollTime,
        activeProcessingCount: workerObservability.activeProcessingCount,
      },
      outbox: {
        ...workerObservability.metrics,
        inProgressCount: workerObservability.metrics.processingCount, // Backward compatibility
        failedCount: workerObservability.metrics.deadLetterCount,     // Backward compatibility
      },
      ...(webhookMetrics ? { webhook: webhookMetrics } : {}),
      ...(reconciliationMetrics ? { reconciliation: reconciliationMetrics } : {}),
    });
  }
}
