/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'crypto';
import { AuditService } from '../audit/audit.service.ts';
import {
  CANONICALIZATION_SPEC,
  CanonicalResult,
  HASH_ALGORITHM,
  HASH_VERSION,
} from '../canonicalization/canonicalizer.ts';
import { HashingService, HashVerificationResult } from '../canonicalization/hashing.service.ts';
import { TransactionTypeRegistry } from './registry/transaction-type-registry.ts';
import { InMemoryTransactionRepository } from './repository/in-memory-transaction.repository.ts';
import { StorageMetadata, TransactionQueryFilter, TransactionRepository } from './repository/transaction.repository.ts';
import {
  ExternalSwitchingStatus,
  InternalLifecycleState,
} from './state-machine/lifecycle-state.ts';

export class IdempotencyConflictError extends Error {
  public readonly code = 'IDEMPOTENCY_CONFLICT';
  constructor(message: string) {
    super(message);
    this.name = 'IdempotencyConflictError';
  }
}

export class ValidationError extends Error {
  public readonly code = 'VALIDATION_ERROR';
  public readonly errors: string[];
  constructor(message: string, errors: string[] = []) {
    super(message);
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

export interface TransactionRecord {
  id: string;
  gatewayRequestId: string;
  organizationId: string;
  correlationId: string;
  idempotencyKey: string;
  transactionType: string;
  schemaVersion: string;
  status: ExternalSwitchingStatus;
  lifecycleState: InternalLifecycleState;

  // Cryptographic & Blockchain Identifiers
  payloadHash: string;
  hashAlgorithm: string;
  hashVersion: string;
  canonicalizationSpec: string;
  fabricTransactionId: string | null;
  blockNumber: number | null;
  blockchainTxHash: string | null;

  // Off-Chain Payloads
  rawPayload: Record<string, unknown>;
  canonicalPayload: string;

  // Metrics, Errors & Timestamps
  attemptCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  submittedAt: string;
  confirmedAt: string | null;
  failedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IngestionInput {
  correlationId: string;
  idempotencyKey: string;
  transactionType: string;
  payload: Record<string, unknown>;
  organizationId: string;
}

export interface IngestionResult {
  isDuplicate: boolean;
  gatewayRequestId: string;
  status: ExternalSwitchingStatus;
  transaction: TransactionRecord;
}

/**
 * Describes the initial outbox event that must be persisted in the SAME
 * database transaction as the transaction row itself.
 */
export interface InitialOutboxEventSpec {
  eventType: 'DISPATCH_LEDGER';
  payload: Record<string, unknown>;
  deduplicationKey: string;
  maxAttempts: number;
}

export class TransactionsService {
  private repository: TransactionRepository;
  private typeRegistry: TransactionTypeRegistry;
  private hashingService: HashingService;

  constructor(
    private readonly auditService: AuditService,
    typeRegistry?: TransactionTypeRegistry,
    hashingService?: HashingService,
    repository?: TransactionRepository,
    private readonly outboxDefaults: { maxAttempts: number } = { maxAttempts: 5 }
  ) {
    this.typeRegistry = typeRegistry || new TransactionTypeRegistry();
    this.hashingService = hashingService || new HashingService(this.auditService);
    this.repository = repository || new InMemoryTransactionRepository();
  }

  getTypeRegistry(): TransactionTypeRegistry {
    return this.typeRegistry;
  }

  getHashingService(): HashingService {
    return this.hashingService;
  }

  getRepository(): TransactionRepository {
    return this.repository;
  }

  getStorageMetadata(): StorageMetadata {
    return this.repository.storageMetadata;
  }

  /**
   * Atomic Transaction Ingestion Pipeline:
   * RECEIVED → VALIDATED → HASHED → PERSISTED → OUTBOX_PENDING
   *
   * The transaction row, its initial status history row and its initial
   * DISPATCH_LEDGER outbox event are persisted through a single repository
   * call so that durable (PostgreSQL) repositories can wrap them in one
   * database transaction. Persistence failures are propagated to the caller:
   * a database error must never be reported as a successful HTTP 202.
   *
   * Note on Status Consistency:
   * Durable acceptance (OUTBOX_PENDING) marks status as 'pending' (accepted,
   * awaiting submission). A newly accepted transaction is NOT marked
   * 'submitted' before submission has actually occurred, and is never
   * represented as blockchain-confirmed before commit verification.
   */
  async ingest(input: IngestionInput): Promise<IngestionResult> {
    const idempotencyKey = input.idempotencyKey?.trim();
    if (!idempotencyKey) {
      throw new ValidationError("Missing or invalid required field 'idempotencyKey'");
    }

    // 1. Pipeline: RECEIVED
    this.auditService.record({
      actorType: 'SWITCHING',
      action: 'TRANSACTION_RECEIVED',
      correlationId: input.correlationId,
      resourceType: 'TRANSACTION',
      metadata: { transactionType: input.transactionType, idempotencyKey },
    });

    // 2. Pipeline: VALIDATED
    const canonicalType = this.typeRegistry.getCanonicalType(input.transactionType);
    if (!canonicalType) {
      throw new ValidationError(
        `Unsupported transaction type: '${input.transactionType}'. Supported types: ${this.typeRegistry.getSupportedTypes().join(', ')}`
      );
    }

    const validation = this.typeRegistry.validate(canonicalType, input.payload);
    if (!validation.isValid) {
      throw new ValidationError(
        `Payload validation failed for type '${canonicalType}': ${validation.errors.join('; ')}`,
        validation.errors
      );
    }

    // 3. Pipeline: HASHED (Server-authoritative canonical SHA-256 via ubtl-canonical-json-v1)
    const canonicalResult: CanonicalResult = this.hashingService.hashPayload(
      canonicalType,
      input.payload,
      '1.0'
    );

    // 4. Idempotency Check with Strict Hash & Type Equality
    const existing = await this.repository.findByIdempotencyKey(
      input.organizationId,
      idempotencyKey
    );
    if (existing) {
      // Conflict Check: Same key + DIFFERENT payload -> HTTP 409 Conflict
      if (
        existing.payloadHash !== canonicalResult.payloadHash ||
        existing.transactionType !== canonicalType
      ) {
        this.auditService.record({
          actorType: 'SWITCHING',
          action: 'IDEMPOTENCY_CONFLICT_DETECTED',
          correlationId: input.correlationId,
          resourceType: 'TRANSACTION',
          resourceId: existing.gatewayRequestId,
          metadata: {
            idempotencyKey,
            existingHash: existing.payloadHash,
            newHash: canonicalResult.payloadHash,
            existingType: existing.transactionType,
            newType: canonicalType,
          },
        });

        throw new IdempotencyConflictError(
          `Idempotency key '${idempotencyKey}' was previously used for a different transaction payload or type`
        );
      }

      // Replay: Same key + SAME payload -> Return existing transaction without new outbox dispatch
      this.auditService.record({
        actorType: 'SWITCHING',
        action: 'TRANSACTION_IDEMPOTENT_REPLAY',
        correlationId: input.correlationId,
        resourceType: 'TRANSACTION',
        resourceId: existing.gatewayRequestId,
        metadata: { idempotencyKey, status: existing.status },
      });

      return {
        isDuplicate: true,
        gatewayRequestId: existing.gatewayRequestId,
        status: existing.status,
        transaction: existing,
      };
    }

    // 5. Pipeline: PERSISTED & OUTBOX_PENDING (Atomic DB Unit of Work)
    const now = new Date().toISOString();
    const gatewayRequestId = randomUUID();
    const id = randomUUID();

    const record: TransactionRecord = {
      id,
      gatewayRequestId,
      organizationId: input.organizationId,
      correlationId: input.correlationId,
      idempotencyKey,
      transactionType: canonicalType,
      schemaVersion: canonicalResult.schemaVersion,
      status: 'pending', // Accurate status: accepted and pending submission to blockchain
      lifecycleState: 'OUTBOX_PENDING',
      payloadHash: canonicalResult.payloadHash,
      hashAlgorithm: HASH_ALGORITHM,
      hashVersion: HASH_VERSION,
      canonicalizationSpec: CANONICALIZATION_SPEC,
      fabricTransactionId: null,
      blockNumber: null,
      blockchainTxHash: null,
      rawPayload: input.payload,
      canonicalPayload: canonicalResult.canonicalString,
      attemptCount: 0,
      errorCode: null,
      errorMessage: null,
      submittedAt: now,
      confirmedAt: null,
      failedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    const initialStatusHistory: Record<string, unknown> = {
      toStatus: 'PENDING',
      reason: 'TRANSACTION_ACCEPTED',
      details: { lifecycleState: 'OUTBOX_PENDING', payloadHash: record.payloadHash },
    };

    const initialOutboxEvent: InitialOutboxEventSpec = {
      eventType: 'DISPATCH_LEDGER',
      payload: {
        gatewayRequestId,
        transactionId: id,
        correlationId: input.correlationId,
        transactionType: canonicalType,
        payloadHash: record.payloadHash,
      },
      deduplicationKey: `dispatch:${id}`,
      maxAttempts: this.outboxDefaults.maxAttempts,
    };

    // Atomic creation (single unit of work: transaction + history + outbox event).
    // Any persistence failure propagates so the API cannot return a misleading 202.
    try {
      await this.repository.createAtomic(record, initialStatusHistory, initialOutboxEvent);
    } catch (persistError) {
      // Concurrent identical-submission race: the unique constraint on
      // (organizationId, idempotencyKey) is the authoritative guard. If the
      // winning request has already persisted this key, resolve the loser as an
      // idempotent replay instead of surfacing a database error.
      const winner = await this.repository.findByIdempotencyKey(
        input.organizationId,
        idempotencyKey
      );
      if (!winner) {
        throw persistError;
      }
      if (
        winner.payloadHash !== canonicalResult.payloadHash ||
        winner.transactionType !== canonicalType
      ) {
        throw new IdempotencyConflictError(
          `Idempotency key '${idempotencyKey}' was previously used for a different transaction payload or type`
        );
      }
      this.auditService.record({
        actorType: 'SWITCHING',
        action: 'TRANSACTION_IDEMPOTENT_REPLAY',
        correlationId: input.correlationId,
        resourceType: 'TRANSACTION',
        resourceId: winner.gatewayRequestId,
        metadata: { idempotencyKey, status: winner.status, resolvedFromRace: true },
      });
      return {
        isDuplicate: true,
        gatewayRequestId: winner.gatewayRequestId,
        status: winner.status,
        transaction: winner,
      };
    }

    this.auditService.record({
      actorType: 'SWITCHING',
      action: 'TRANSACTION_PERSISTED',
      correlationId: input.correlationId,
      resourceType: 'TRANSACTION',
      resourceId: gatewayRequestId,
      metadata: {
        payloadHash: record.payloadHash,
        transactionType: canonicalType,
        idempotencyKey,
        lifecycleState: 'OUTBOX_PENDING',
        storageType: this.repository.storageMetadata.storageType,
      },
    });

    return {
      isDuplicate: false,
      gatewayRequestId,
      status: 'pending',
      transaction: record,
    };
  }

  async getById(gatewayRequestId: string): Promise<TransactionRecord | null> {
    return this.repository.findByGatewayRequestId(gatewayRequestId);
  }

  async getAll(limit = 100, filter: TransactionQueryFilter = {}): Promise<TransactionRecord[]> {
    return this.repository.getAll(limit, filter);
  }

  /**
   * Pipeline: OUTBOX_PENDING → SUBMITTED (Proposal dispatched to blockchain network)
   */
  async markSubmitted(gatewayRequestId: string, fabricTransactionId: string): Promise<TransactionRecord> {
    const tx = await this.requireTransaction(gatewayRequestId);

    tx.lifecycleState = 'SUBMITTED';
    tx.status = 'submitted'; // Now actually submitted to the blockchain network!
    tx.fabricTransactionId = fabricTransactionId;
    tx.blockchainTxHash = fabricTransactionId;
    tx.attemptCount += 1;
    tx.updatedAt = new Date().toISOString();

    await this.repository.update(tx);
    return tx;
  }

  /**
   * Compatibility alias
   */
  async markPending(gatewayRequestId: string, fabricTransactionId: string): Promise<TransactionRecord> {
    return this.markSubmitted(gatewayRequestId, fabricTransactionId);
  }

  /**
   * Pipeline: SUBMITTED → AWAITING_COMMIT (Proposal endorsed, waiting for block)
   */
  async markAwaitingCommit(gatewayRequestId: string): Promise<TransactionRecord> {
    const tx = await this.requireTransaction(gatewayRequestId);

    tx.lifecycleState = 'AWAITING_COMMIT';
    tx.status = 'pending';
    tx.updatedAt = new Date().toISOString();

    await this.repository.update(tx);
    return tx;
  }

  /**
   * Pipeline: AWAITING_COMMIT / SUBMITTED → COMMITTED (Verified block inclusion)
   * Axiom 5: Strict check requiring blockNumber > 0
   */
  async markCommitted(
    gatewayRequestId: string,
    blockNumber: bigint | number,
    commitTimestamp = new Date().toISOString()
  ): Promise<TransactionRecord> {
    const tx = await this.requireTransaction(gatewayRequestId);

    const numericBlock = typeof blockNumber === 'bigint' ? Number(blockNumber) : blockNumber;

    if (numericBlock <= 0) {
      throw new Error('Axiom 5 Guard: blockNumber must be > 0 to confirm on ledger');
    }

    tx.lifecycleState = 'COMMITTED';
    tx.status = 'confirmed';
    tx.blockNumber = numericBlock;
    tx.confirmedAt = commitTimestamp;
    tx.updatedAt = new Date().toISOString();

    await this.repository.update(tx);

    this.auditService.record({
      actorType: 'SYSTEM',
      action: 'TRANSACTION_COMMITTED',
      correlationId: tx.correlationId,
      resourceType: 'TRANSACTION',
      resourceId: tx.gatewayRequestId,
      metadata: {
        blockNumber: numericBlock,
        fabricTransactionId: tx.fabricTransactionId,
        payloadHash: tx.payloadHash,
      },
    });

    return tx;
  }

  /**
   * Compatibility alias
   */
  async markConfirmed(
    gatewayRequestId: string,
    blockNumber: bigint | number,
    commitTimestamp = new Date().toISOString()
  ): Promise<TransactionRecord> {
    return this.markCommitted(gatewayRequestId, blockNumber, commitTimestamp);
  }

  /**
   * Pipeline: COMMITTED → VERIFIED (Cryptographic proof verified against stored payload)
   */
  async markVerified(gatewayRequestId: string): Promise<TransactionRecord> {
    const tx = await this.requireTransaction(gatewayRequestId);

    tx.lifecycleState = 'VERIFIED';
    tx.status = 'confirmed';
    tx.updatedAt = new Date().toISOString();

    await this.repository.update(tx);
    return tx;
  }

  /**
   * Pipeline: * → FAILED
   */
  async markFailed(gatewayRequestId: string, errorCode: string, errorMessage: string): Promise<TransactionRecord> {
    const tx = await this.requireTransaction(gatewayRequestId);

    tx.lifecycleState = 'FAILED';
    tx.status = 'failed';
    tx.errorCode = errorCode;
    tx.errorMessage = errorMessage;
    tx.failedAt = new Date().toISOString();
    tx.updatedAt = tx.failedAt;

    await this.repository.update(tx);

    this.auditService.record({
      actorType: 'SYSTEM',
      action: 'TRANSACTION_FAILED',
      correlationId: tx.correlationId,
      resourceType: 'TRANSACTION',
      resourceId: tx.gatewayRequestId,
      metadata: { errorCode, errorMessage },
    });

    return tx;
  }

  /**
   * Pipeline: * → TIMEOUT / RECONCILIATION_REQUIRED
   */
  async markTimeout(gatewayRequestId: string, errorMessage: string): Promise<TransactionRecord> {
    const tx = await this.requireTransaction(gatewayRequestId);

    tx.lifecycleState = 'RECONCILIATION_REQUIRED';
    tx.status = 'timeout';
    tx.errorCode = 'COMMIT_TIMEOUT';
    tx.errorMessage = errorMessage;
    tx.updatedAt = new Date().toISOString();

    await this.repository.update(tx);

    this.auditService.record({
      actorType: 'SYSTEM',
      action: 'TRANSACTION_TIMEOUT',
      correlationId: tx.correlationId,
      resourceType: 'TRANSACTION',
      resourceId: tx.gatewayRequestId,
      metadata: { errorMessage },
    });

    return tx;
  }

  /**
   * Verifies the cryptographic hash of a stored transaction
   */
  async verifyStoredTransaction(gatewayRequestId: string): Promise<HashVerificationResult> {
    const tx = await this.repository.findByGatewayRequestId(gatewayRequestId);
    if (!tx) {
      return {
        verified: false,
        computedHash: '',
        expectedHash: '',
        canonicalPayload: '',
        hashAlgorithm: HASH_ALGORITHM,
        hashVersion: HASH_VERSION,
        canonicalizationSpec: CANONICALIZATION_SPEC,
        error: `Transaction with gatewayRequestId '${gatewayRequestId}' not found`,
      };
    }

    return this.hashingService.verifyPayload(
      tx.transactionType,
      tx.rawPayload,
      tx.payloadHash,
      tx.schemaVersion,
      { correlationId: tx.correlationId, gatewayRequestId: tx.gatewayRequestId }
    );
  }

  private async requireTransaction(gatewayRequestId: string): Promise<TransactionRecord> {
    const tx = await this.repository.findByGatewayRequestId(gatewayRequestId);
    if (!tx) throw new Error(`Transaction ${gatewayRequestId} not found`);
    return tx;
  }
}
