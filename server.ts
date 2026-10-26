/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express, { NextFunction, Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import { loadConfig, validateEnvironment } from './src/config/environment.ts';
import { createPrismaClient, resolvePersistenceDecision } from './src/config/persistence.ts';
import { AuditService } from './src/modules/audit/audit.service.ts';
import { PrismaAuditLogSink } from './src/modules/audit/prisma-audit-log.sink.ts';
import { AuthService } from './src/modules/auth/auth.service.ts';
import { BlockchainAdapterFactory } from './src/modules/blockchain-adapter/adapter.factory.ts';
import { CommitVerificationAuditSink } from './src/modules/blockchain-adapter/commit-verification.types.ts';
import { GatewayCompatController } from './src/modules/gateway-compat/gateway-compat.controller.ts';
import { PostgresOrganizationsService } from './src/modules/organizations/prisma-organizations.service.ts';
import { InMemoryOutboxRepository } from './src/modules/outbox/in-memory-outbox.repository.ts';
import { OutboxService } from './src/modules/outbox/outbox.service.ts';
import { PrismaOutboxRepository } from './src/modules/outbox/prisma-outbox.repository.ts';
import { PostgresReconciliationLock } from './src/modules/reconciliation/postgres-reconciliation.lock.ts';
import { PostgresReconciliationRecordStore } from './src/modules/reconciliation/postgres-reconciliation.store.ts';
import { ReconciliationService } from './src/modules/reconciliation/reconciliation.service.ts';
import {
  InMemoryReconciliationRecordStore,
  ReconciliationRecordStore,
} from './src/modules/reconciliation/reconciliation.store.ts';
import { InMemoryTransactionRepository } from './src/modules/transactions/repository/in-memory-transaction.repository.ts';
import { PrismaTransactionRepository } from './src/modules/transactions/repository/prisma-transaction.repository.ts';
import { TransactionRepository } from './src/modules/transactions/repository/transaction.repository.ts';
import { TransactionsService } from './src/modules/transactions/transactions.service.ts';
import { WebhookService } from './src/modules/webhooks/webhook.service.ts';

async function bootstrap() {
  console.log('------------------------------------------------------------');
  console.log(' Universal Blockchain Transaction Ledger (UBTL) - Bootstrapping');
  console.log('------------------------------------------------------------');

  // 1. Environment Validation (Fail-fast in provider mode)
  const envValidation = validateEnvironment();
  if (!envValidation.isValid) {
    console.error('CRITICAL: Environment validation failed:');
    for (const err of envValidation.errors) {
      console.error(`  [X] ${err}`);
    }
    process.exit(1);
  }

  for (const warning of envValidation.warnings) {
    console.warn(`  [!] ${warning}`);
  }

  const config = loadConfig();
  console.log(`[UBTL] Operational Mode: ${config.blockchainAdapterMode.toUpperCase()}`);

  // 2. Persistence backend selection.
  //
  // This is an EXPLICIT, logged decision — never an implicit fallback. When the
  // durable backend is required ('postgres', or production with a DATABASE_URL)
  // an unreachable database aborts startup instead of silently degrading to a
  // store where an accepted transaction would not survive a restart.
  const persistence = resolvePersistenceDecision(config);
  console.log(`[UBTL] Persistence backend: ${persistence.backend.toUpperCase()} (${persistence.reason})`);

  // A database client is opened ONLY when the resolved backend is PostgreSQL.
  // An explicit UBTL_PERSISTENCE_BACKEND=in-memory must be honoured literally:
  // connecting anyway would waste a pool, emit a misleading "falling back"
  // warning, and activate the durable reconciliation lock under a non-durable
  // evidence store.
  const needsDatabase = persistence.backend === 'postgres';
  let prismaClient: any = null;
  if (needsDatabase) {
    try {
      // One client (one connection pool) is shared by every durable component:
      // transaction/outbox repositories, audit sink, reconciliation evidence
      // store and the cross-worker reconciliation lock.
      prismaClient = await createPrismaClient();
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      if (persistence.failFastOnUnavailable) {
        console.error(`CRITICAL: Required durable persistence is unavailable: ${reason}`);
        console.error('Refusing to start. Set UBTL_PERSISTENCE_BACKEND=in-memory ONLY for local development.');
        process.exit(1);
      }
      console.warn(
        `[UBTL WARNING] PostgreSQL is unavailable (${reason}). Falling back to the non-durable in-memory store: ` +
          'transactions, idempotency records, outbox state and reconciliation results will NOT survive a restart.'
      );
    }
  }

  const useDurableStores = persistence.backend === 'postgres' && prismaClient !== null;

  let outboxRepository;
  let transactionRepository: TransactionRepository;
  let auditSink;
  let reconciliationStore: ReconciliationRecordStore;
  let switchingOrganizationId: string | undefined;

  if (useDurableStores) {
    outboxRepository = new PrismaOutboxRepository(prismaClient);
    transactionRepository = new PrismaTransactionRepository(prismaClient);
    auditSink = new PrismaAuditLogSink(prismaClient);
    reconciliationStore = new PostgresReconciliationRecordStore(prismaClient);

    // `transactions.organizationId` is a UUID with a foreign key to
    // `organizations.id`, while the auth layer identifies the tenant with a
    // logical id. Resolve it ONCE here; writing the logical id through would
    // make PostgreSQL reject every ingestion with an invalid-UUID error.
    switchingOrganizationId = await new PostgresOrganizationsService(prismaClient).ensureOrganization({
      code: 'SWITCHING_SYSTEM',
      name: 'Digital Switching System Primary Node',
    });
    console.log(
      `[UBTL] Durable persistence active (PostgreSQL): transactions, lifecycle history, idempotency, audit, outbox and reconciliation evidence.`
    );
  } else {
    outboxRepository = new InMemoryOutboxRepository();
    transactionRepository = new InMemoryTransactionRepository(outboxRepository);
    reconciliationStore = new InMemoryReconciliationRecordStore();
  }

  // 3. Initialize Core Services
  const authService = new AuthService(config, { switchingOrganizationId });
  const auditService = new AuditService(auditSink);
  const webhookService = new WebhookService(config, auditService);

  // The transaction store and the outbox worker queue MUST share the same
  // outbox repository instance, otherwise the DISPATCH_LEDGER event persisted
  // atomically with the transaction during ingestion would never be polled.
  const transactionsService = new TransactionsService(
    auditService,
    undefined,
    undefined,
    transactionRepository,
    { maxAttempts: config.outboxMaxRetries }
  );
  const storageMeta = transactionsService.getStorageMetadata();
  console.log(`[UBTL] Persistence Engine: ${storageMeta.storageType.toUpperCase()} (Durable: ${storageMeta.isDurable}, ProductionReady: ${storageMeta.productionReady})`);
  if (!storageMeta.isDurable) {
    console.warn(`[UBTL WARNING] ${storageMeta.details}`);
  }
  // Fail fast: production MUST NOT silently run on non-durable in-memory storage,
  // which would make acceptance (HTTP 202) non-durable and unable to survive a restart.
  if (config.nodeEnv === 'production' && !storageMeta.isDurable) {
    console.error('CRITICAL: Production mode requires a durable (PostgreSQL) TransactionRepository, but the active repository is in-memory. Refusing to start.');
    process.exit(1);
  }

  // 4. Blockchain Adapter (Mock or Provider)
  //
  // INDEPENDENT COMMIT VERIFICATION (Prompt 09.7): every verification decision
  // is written to the same durable audit trail as the lifecycle transitions, so
  // a COMMITTED row — and an INCONSISTENT_EVIDENCE / payload-hash-mismatch
  // alert — always carries the evidence that produced it (source, block number,
  // block hash, verdict). The sink never throws into the verification path, so
  // an audit outage can never turn a verified commit into a failure or vice
  // versa.
  //
  // The block-level EVIDENCE SOURCE is deliberately NOT supplied here: choosing
  // a transport (qscc ACL, explorer, offline decode) requires the target
  // network's privileges, which are unknown (BLOCKED). Provider mode therefore
  // stays fail-closed — the adapter's injected verifier reports
  // EVIDENCE_UNAVAILABLE for every lookup instead of falling back to chaincode
  // state or to the mock adapter.
  const commitVerificationAuditSink: CommitVerificationAuditSink = {
    record: (decision) => {
      auditService.record({
        actorType: 'SYSTEM',
        action: `COMMIT_VERIFICATION_${decision.verdict}`,
        resourceType: 'TRANSACTION',
        resourceId: decision.gatewayRequestId ?? decision.fabricTransactionId,
        metadata: {
          verdict: decision.verdict,
          fabricTransactionId: decision.fabricTransactionId,
          gatewayRequestId: decision.gatewayRequestId,
          idempotencyKey: decision.idempotencyKey,
          evidenceSource: decision.evidenceSource,
          blockNumber: decision.blockNumber,
          blockHash: decision.blockHash,
          mismatches: decision.mismatches,
          checks: decision.checks,
          errorCode: decision.errorCode,
          decidedAt: decision.decidedAt,
        },
      });
    },
  };

  const blockchainAdapter = BlockchainAdapterFactory.create(config, {
    commitVerificationAuditSink,
  });
  await blockchainAdapter.initialize();
  console.log(`[UBTL] Blockchain Adapter initialized in ${blockchainAdapter.mode.toUpperCase()} mode (Simulated: ${blockchainAdapter.mode === 'mock'}).`);

  // 5. Outbox Engine & Reconciliation
  const outboxService = new OutboxService(
    config,
    transactionsService,
    blockchainAdapter,
    webhookService,
    auditService,
    outboxRepository
  );
  outboxService.startWorker();
  console.log('[UBTL] Transactional Outbox worker started.');

  // Durable, cross-worker reconciliation lock.
  //
  // The reconciliation scheduler must not run concurrently in two worker
  // processes for the same transaction. A shared PostgreSQL database provides
  // the durable coordination primitive (lease row with atomic acquire and
  // owner-scoped release, self-healing after a crash). When no database is
  // configured/reachable we fall back to the single-process lock, which is safe
  // only within this process — and we say so loudly rather than implying
  // multi-worker safety we do not have.
  const durableReconciliationLock = prismaClient
    ? new PostgresReconciliationLock(prismaClient, {
        ttlMs: config.reconciliationLockTtlSeconds * 1000,
      })
    : undefined;

  if (durableReconciliationLock) {
    console.log(`[UBTL] Durable reconciliation lock active (PostgreSQL lease, TTL ${config.reconciliationLockTtlSeconds}s).`);
  } else {
    console.warn(
      '[UBTL WARNING] No reachable database. Using the single-process reconciliation lock; ' +
        'multi-worker coordination is NOT active.'
    );
  }

  const reconciliationService = new ReconciliationService(
    config,
    transactionsService,
    blockchainAdapter,
    auditService,
    durableReconciliationLock,
    reconciliationStore
  );
  reconciliationService.start();
  console.log(`[UBTL] Reconciliation scheduler started (interval: ${config.reconciliationIntervalMinutes}m, lookback: ${config.reconciliationLookbackHours}h, batch: ${config.reconciliationBatchSize}, durableEvidence: ${reconciliationService.isDurable()}).`);

  const gatewayController = new GatewayCompatController(
    authService,
    transactionsService,
    outboxService,
    blockchainAdapter,
    {
      webhookMetrics: () => outboxService.getWebhookMetrics(),
      reconciliationMetrics: async () =>
        (await reconciliationService.getMetrics()) as unknown as Record<string, unknown>,
      // Real connectivity probe: the health endpoint must report what IS, not
      // what the configuration declares.
      databaseProbe: prismaClient
        ? async () => {
            try {
              await prismaClient.$queryRaw`SELECT 1`;
              return true;
            } catch {
              return false;
            }
          }
        : undefined,
    }
  );

  // 6. Express Application
  const app = express();
  // Capture the raw request bytes so inbound HMAC verification runs over the
  // exact payload Switching signed. Re-serializing req.body would produce a
  // different string and break signature matching 100% of the time.
  app.use(
    express.json({
      limit: '10mb',
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: string }).rawBody = buf.toString('utf8');
      },
    })
  );

  // Request correlation and audit middleware
  app.use((req, res, next) => {
    const correlationId = (req.headers['x-correlation-id'] as string) || `corr-${Date.now()}`;
    req.headers['x-correlation-id'] = correlationId;
    res.setHeader('X-Correlation-Id', correlationId);
    next();
  });

  // Health Endpoints (public operational probes; contain no secrets)
  app.get('/health', (req, res) => gatewayController.getHealth(req, res));
  app.get('/v1/health', (req, res) => gatewayController.getHealth(req, res));

  // Administrator / Operator authorization guard. All /v1/admin/* endpoints
  // require a valid UBTL_ADMIN_API_KEY; the Switching ingestion key is NOT
  // sufficient to read ledger, outbox, audit or reconciliation data.
  const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
    const apiKey = (req.headers['x-api-key'] || req.headers['authorization']) as string | undefined;
    const authContext = authService.validateAdminApiKey(apiKey);
    if (!authContext) {
      res.status(401).json({
        statusCode: 401,
        error: 'Unauthorized',
        errorCode: 'ADMIN_UNAUTHORIZED',
        message: 'Missing or invalid X-Api-Key header for administrative endpoints',
      });
      return;
    }
    (req as any).authContext = authContext;
    next();
  };

  // Switching Compatibility Gateway Endpoints
  app.post('/v1/transactions', (req, res) => gatewayController.submitTransaction(req, res));
  app.get('/v1/transactions/:gatewayRequestId', (req, res) => gatewayController.getTransactionStatus(req, res));
  app.post('/v1/transactions/verify', (req, res) => gatewayController.verifyTransaction(req, res));

  // Operational & Admin API Endpoints (admin-authorized)
  app.get('/v1/admin/transactions', requireAdmin, async (req, res) => {
    const limit = parseInt((req.query.limit as string) || '50', 10);
    const transactionType = typeof req.query.transactionType === 'string' ? req.query.transactionType.trim() : '';
    const search = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 200) : '';

    try {
      res.json({
        transactions: await transactionsService.getAll(limit, {
          transactionType: transactionType || undefined,
          search: search || undefined,
        }),
      });
    } catch (error) {
      // Express 4 does not forward rejected promises from async handlers, so
      // without this catch an unexpected query failure would terminate the
      // whole process instead of returning an error to the caller.
      console.error('[UBTL] Admin ledger query failed:', error);
      res.status(500).json({
        errorCode: 'LEDGER_QUERY_FAILED',
        message: error instanceof Error ? error.message : 'Ledger query failed',
      });
    }
  });

  app.get('/v1/admin/outbox', requireAdmin, async (_req, res) => {
    res.json({
      metrics: await outboxService.getMetrics(),
      events: await outboxService.getRecentEvents(50),
    });
  });

  app.get('/v1/admin/audit', requireAdmin, (_req, res) => {
    res.json({ logs: auditService.getRecentLogs(50), durable: auditService.isDurable() });
  });

  app.get('/v1/admin/reconciliation', requireAdmin, async (req, res) => {
    const outcome = req.query.outcome as string | undefined;
    res.json({ records: await reconciliationService.getRecords(outcome as any) });
  });

  app.post('/v1/admin/reconciliation/run', requireAdmin, async (_req, res) => {
    const result = await reconciliationService.runReconciliation();
    res.json({ success: true, result });
  });

  // Terminal error handler. A malformed or oversized JSON body is raised by the
  // body parser BEFORE any route runs, so without this the client receives
  // Express's default HTML page (and, outside production, a stack trace). This
  // converts parser failures into the same JSON envelope the API uses, and never
  // echoes parser internals or the offending payload.
  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    if (!err) {
      next();
      return;
    }
    const isClientError = typeof err.status === 'number' && err.status >= 400 && err.status < 500;
    const status = isClientError ? err.status : 500;
    const tooLarge = status === 413 || err.type === 'entity.too.large';
    const malformed = err.type === 'entity.parse.failed';
    if (!isClientError) {
      console.error('[UBTL] Unhandled request error:', err instanceof Error ? err.name : typeof err);
    }
    res.status(status).json({
      statusCode: status,
      error: tooLarge ? 'Payload Too Large' : 'Bad Request',
      errorCode: tooLarge ? 'PAYLOAD_TOO_LARGE' : malformed ? 'MALFORMED_JSON' : 'REQUEST_REJECTED',
      message: tooLarge
        ? 'Request body exceeds the configured size limit'
        : malformed
          ? 'Request body could not be parsed as JSON'
          : 'Request could not be processed',
    });
  });

  // 7. Vite Middleware Integration for Development Portal & Verification UI
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  // 8. Start Listening on Port 3000
  const server = app.listen(config.port, config.host, () => {
    console.log(`[UBTL] Server running on http://${config.host}:${config.port}`);
    console.log(`[UBTL] Gateway API: POST /v1/transactions, GET /v1/transactions/:id`);
    console.log(`[UBTL] Health API: GET /v1/health`);
  });

  // Graceful Shutdown
  const shutdown = () => {
    console.log('[UBTL] Gracefully shutting down...');
    reconciliationService.stop();
    // Stop the lock heartbeat (if any) before releasing the shared pool.
    if (durableReconciliationLock) durableReconciliationLock.stop();
    outboxService.stopWorker();
    // Provider adapter releases the Gateway and gRPC channel when supported.
    const adapterWithClose = blockchainAdapter as unknown as { close?: () => void };
    if (typeof adapterWithClose.close === 'function') {
      adapterWithClose.close();
    }
    server.close(() => {
      const finish = () => {
        console.log('[UBTL] HTTP server closed.');
        process.exit(0);
      };
      // Release the single shared Prisma connection pool last: everything that
      // could still hold a query (worker poll, lock heartbeat) has been stopped.
      if (prismaClient?.$disconnect) {
        void prismaClient.$disconnect().then(finish).catch(finish);
        return;
      }
      finish();
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

bootstrap().catch((err) => {
  console.error('[UBTL] Bootstrap failed:', err);
  process.exit(1);
});
