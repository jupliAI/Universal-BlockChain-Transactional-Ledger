/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * =============================================================================
 * POSTGRESQL INTEGRATION TESTS (OPT-IN)
 * Prompt 02.1 — Section 3 & Section 9
 * =============================================================================
 *
 * These tests exercise the REAL durable repositories (PrismaTransactionRepository
 * and PrismaOutboxRepository) against a reachable PostgreSQL instance, including
 * concurrency semantics that cannot be validated in-memory
 * (SELECT ... FOR UPDATE SKIP LOCKED, unique-constraint idempotency, atomic
 * multi-table units of work, stale-lease recovery).
 *
 * They are OPT-IN because they require infrastructure:
 *
 *   UBTL_PG_TESTS=true DATABASE_URL=postgresql://... npx tsx test/pg-integration.test.ts
 *
 * Behaviour when prerequisites are missing is to print an explicit SKIPPED
 * notice and exit 0. This harness NEVER fabricates a pass: a skipped run is
 * reported as skipped, never as passed.
 *
 * Prerequisites: a reachable PostgreSQL database whose schema was created from
 * prisma/schema.prisma (or prisma/migrations via `prisma migrate deploy`).
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { loadConfig } from '../src/config/environment.ts';
import { AuditService } from '../src/modules/audit/audit.service.ts';
import { PrismaOutboxRepository } from '../src/modules/outbox/prisma-outbox.repository.ts';
import { PostgresReconciliationLock } from '../src/modules/reconciliation/postgres-reconciliation.lock.ts';
import { ReconciliationService } from '../src/modules/reconciliation/reconciliation.service.ts';
import { PrismaTransactionRepository } from '../src/modules/transactions/repository/prisma-transaction.repository.ts';
import { TransactionsService } from '../src/modules/transactions/transactions.service.ts';

dotenv.config();

interface PgTest {
  id: string;
  name: string;
  run: () => Promise<void>;
}

const tests: PgTest[] = [];
const register = (id: string, name: string, run: () => Promise<void>) => tests.push({ id, name, run });

type PrismaLike = any;
let prisma: PrismaLike;
let orgId: string;
let seq = 0;

function unique(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}`;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Opens an INDEPENDENT PrismaClient (its own connection pool), i.e. a distinct
 * "worker" from the database's point of view. Used to prove that coordination is
 * durable and connection-scoped rather than process-local.
 */
async function newPrismaClient(): Promise<PrismaLike> {
  const prismaModuleSpecifier = '@prisma/client';
  const mod: any = await import(/* @vite-ignore */ prismaModuleSpecifier);
  const ctor = mod.PrismaClient || mod.default?.PrismaClient;
  const client = new ctor();
  await client.$connect();
  return client;
}

/** Seeds a transaction left in RECONCILIATION_REQUIRED, durably. */
async function seedReconciliationRequiredPg(client: PrismaLike, organizationId: string): Promise<string> {
  const repo = new PrismaTransactionRepository(client);
  const service = new TransactionsService(new AuditService(), undefined, undefined, repo);
  const key = unique('idemp-rc');
  const ingest = await service.ingest({
    correlationId: unique('corr-rc'),
    idempotencyKey: key,
    transactionType: 'SALE',
    payload: { invoiceNumber: 'INV-PG-RC', amount: '10.00', currency: 'IDR' },
    organizationId,
  });
  await service.markSubmitted(ingest.gatewayRequestId, `fabric-${key}`);
  await service.markTimeout(ingest.gatewayRequestId, 'Ambiguous commit timeout');
  return ingest.gatewayRequestId;
}

/** In-process provider double: no real Fabric network is contacted. */
function makeEvidenceAdapter(
  onQuery: () => void,
  evidence: () => Record<string, unknown>,
  queryDelayMs = 200
): any {
  return {
    mode: 'mock',
    initialize: async () => {},
    submitProposal: async () => ({ accepted: true, fabricTransactionId: 'sim', status: 'PENDING' }),
    queryCommitStatus: async (id: string) => ({ fabricTransactionId: id, status: 'PENDING', isSimulated: true }),
    getTransactionProof: async () => null,
    healthCheck: async () => ({
      status: 'online',
      mode: 'mock',
      isSimulated: true,
      peerEndpoint: 'sim',
      channelName: 'sim',
      currentBlockHeight: 1,
      latencyMs: 0,
      details: 'simulated',
    }),
    findTransactionByIdempotencyKey: async () => {
      onQuery();
      // Hold the durable lease long enough that a peer worker's acquire attempt
      // (nearly simultaneous) observes an active lease.
      await sleep(queryDelayMs);
      return evidence();
    },
  };
}

function buildWorker(
  client: PrismaLike,
  lockKey: string,
  adapter: any,
  ttlMs = 10000
): { service: ReconciliationService; lock: PostgresReconciliationLock } {
  const lock = new PostgresReconciliationLock(client, { lockKey, ttlMs });
  const txService = new TransactionsService(
    new AuditService(),
    undefined,
    undefined,
    new PrismaTransactionRepository(client)
  );
  const service = new ReconciliationService(loadConfig(), txService, adapter, new AuditService(), lock);
  return { service, lock };
}

/** Runs the cross-process lock probe as a separate OS process. */
function runLockHolderWorker(lockKey: string, ownerId: string, holdMs: number): Promise<{ acquired: boolean }> {
  return new Promise((resolve, reject) => {
    const helperPath = fileURLToPath(new URL('./helpers/lock-holder-worker.ts', import.meta.url));
    const child = spawn('npx', ['tsx', helperPath, lockKey, ownerId, String(holdMs)], {
      cwd: process.cwd(),
      env: process.env,
      shell: true,
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`lock-holder-worker timed out. stderr: ${stderr}`));
    }, 90000);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`lock-holder-worker exited with code ${code}. stderr: ${stderr}`));
        return;
      }
      const line = stdout.split('\n').find((l) => l.includes('"event":"acquired"'));
      if (!line) {
        reject(new Error(`No acquire result from child process. stdout=${stdout} stderr=${stderr}`));
        return;
      }
      resolve(JSON.parse(line.trim()));
    });
  });
}

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

async function createOrg(): Promise<string> {
  const id = crypto.randomUUID();
  await prisma.organization.create({
    data: { id, code: unique('ORG'), name: 'PG Test Org', apiKeyHash: 'x'.repeat(64) },
  });
  return id;
}

async function seedTransaction(overrides: Record<string, unknown> = {}): Promise<any> {
  const id = crypto.randomUUID();
  const gatewayRequestId = crypto.randomUUID();
  const record = {
    id,
    gatewayRequestId,
    organizationId: orgId,
    correlationId: unique('corr'),
    idempotencyKey: unique('idemp'),
    transactionType: 'SALE',
    schemaVersion: '1.0',
    status: 'pending',
    lifecycleState: 'OUTBOX_PENDING',
    payloadHash: HASH_A,
    hashAlgorithm: 'sha256',
    hashVersion: 'v1',
    canonicalizationSpec: 'ubtl-canonical-json-v1',
    fabricTransactionId: null,
    blockNumber: null,
    blockchainTxHash: null,
    rawPayload: { invoiceNumber: 'INV-PG', amount: '100.00', currency: 'IDR' },
    canonicalPayload: '{}',
    attemptCount: 0,
    errorCode: null,
    errorMessage: null,
    submittedAt: new Date().toISOString(),
    confirmedAt: null,
    failedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
  return record;
}

// ---------------------------------------------------------------------------
// TC-PG-01 — Atomic creation commits transaction + history + outbox together
// ---------------------------------------------------------------------------
register('TC-PG-01', 'Atomic transaction + status history + outbox event commit in one unit of work', async () => {
  const repo = new PrismaTransactionRepository(prisma);
  const record = await seedTransaction();

  await repo.createAtomic(
    record,
    { toStatus: 'PENDING', reason: 'TRANSACTION_ACCEPTED', details: { lifecycleState: 'OUTBOX_PENDING' } },
    {
      eventType: 'DISPATCH_LEDGER',
      payload: { correlationId: record.correlationId },
      deduplicationKey: `dispatch:${record.id}`,
      maxAttempts: 5,
    }
  );

  const txRow = await prisma.transaction.findUnique({ where: { id: record.id } });
  const history = await prisma.transactionStatusHistory.count({ where: { transactionId: record.id } });
  const outbox = await prisma.outboxEvent.findMany({ where: { transactionId: record.id } });

  if (!txRow) throw new Error('Transaction row was not persisted');
  if (txRow.status !== 'PENDING') {
    throw new Error(`Expected durable status PENDING (not CONFIRMED/SUBMITTED) on acceptance, got ${txRow.status}`);
  }
  if (txRow.lifecycleState !== 'OUTBOX_PENDING') {
    throw new Error(`Expected lifecycleState OUTBOX_PENDING, got ${txRow.lifecycleState}`);
  }
  if (history !== 1) throw new Error(`Expected exactly 1 status history row, got ${history}`);
  if (outbox.length !== 1) throw new Error(`Expected exactly 1 outbox event, got ${outbox.length}`);
  if (outbox[0].payload.gatewayRequestId !== record.gatewayRequestId) {
    throw new Error('Outbox payload is missing the gatewayRequestId needed for restart recovery');
  }
});

// ---------------------------------------------------------------------------
// TC-PG-02 — A failure inside the unit of work rolls the WHOLE unit back
// ---------------------------------------------------------------------------
register('TC-PG-02', 'Failure inside createAtomic rolls back transaction, history and outbox (no partial acceptance)', async () => {
  const repo = new PrismaTransactionRepository(prisma);

  const first = await seedTransaction();
  await repo.createAtomic(first, { toStatus: 'PENDING' }, {
    eventType: 'DISPATCH_LEDGER',
    payload: {},
    deduplicationKey: `dispatch:${first.id}`,
    maxAttempts: 5,
  });

  // Second attempt reuses the same deduplicationKey -> unique violation mid-unit-of-work.
  const second = await seedTransaction();
  let threw = false;
  try {
    await repo.createAtomic(second, { toStatus: 'PENDING' }, {
      eventType: 'DISPATCH_LEDGER',
      payload: {},
      deduplicationKey: `dispatch:${first.id}`,
      maxAttempts: 5,
    });
  } catch {
    threw = true;
  }

  if (!threw) throw new Error('Expected the duplicate deduplicationKey to abort the unit of work');

  const leakedTx = await prisma.transaction.findUnique({ where: { id: second.id } });
  const leakedHistory = await prisma.transactionStatusHistory.count({ where: { transactionId: second.id } });
  if (leakedTx || leakedHistory !== 0) {
    throw new Error('Partial write detected: transaction/history survived a failed unit of work');
  }
});

// ---------------------------------------------------------------------------
// TC-PG-03 — Concurrent workers cannot claim the same event
// ---------------------------------------------------------------------------
register('TC-PG-03', 'Concurrent workers cannot claim the same outbox event (FOR UPDATE SKIP LOCKED)', async () => {
  const seedRepo = new PrismaTransactionRepository(prisma);
  for (let i = 0; i < 10; i++) {
    const record = await seedTransaction();
    await seedRepo.createAtomic(record, { toStatus: 'PENDING' }, {
      eventType: 'DISPATCH_LEDGER',
      payload: {},
      deduplicationKey: `dispatch:${record.id}`,
      maxAttempts: 5,
    });
  }

  const repoA = new PrismaOutboxRepository(prisma);
  const repoB = new PrismaOutboxRepository(prisma);

  const [claimedA, claimedB] = await Promise.all([
    repoA.claimBatch('worker-A', 10, Date.now()),
    repoB.claimBatch('worker-B', 10, Date.now()),
  ]);

  const idsA = new Set(claimedA.map((e) => e.id));
  const overlap = claimedB.filter((e) => idsA.has(e.id));
  if (overlap.length > 0) {
    throw new Error(`Double-claim detected: ${overlap.length} event(s) claimed by two workers simultaneously`);
  }
  if (claimedA.length + claimedB.length === 0) {
    throw new Error('No events were claimed by either worker');
  }
});

// ---------------------------------------------------------------------------
// TC-PG-04 — Two recovery workers cannot re-lease the same stale event
// ---------------------------------------------------------------------------
register('TC-PG-04', 'Two recovery workers cannot re-lease the same stale event (mutually exclusive reclaim)', async () => {
  const seedRepo = new PrismaTransactionRepository(prisma);
  const record = await seedTransaction();
  await seedRepo.createAtomic(record, { toStatus: 'PENDING' }, {
    eventType: 'DISPATCH_LEDGER',
    payload: {},
    deduplicationKey: `dispatch:${record.id}`,
    maxAttempts: 5,
  });

  // Force the single event into a stale PROCESSING lease.
  const staleAt = new Date(Date.now() - 10 * 60 * 1000);
  await prisma.outboxEvent.updateMany({
    where: { transactionId: record.id },
    data: { status: 'PROCESSING', lockedAt: staleAt, lockedBy: 'crashed-worker' },
  });

  const repoA = new PrismaOutboxRepository(prisma);
  const repoB = new PrismaOutboxRepository(prisma);

  const [a, b] = await Promise.all([
    repoA.reclaimStuckEvents(60000, Date.now(), 'recoverer-A'),
    repoB.reclaimStuckEvents(60000, Date.now(), 'recoverer-B'),
  ]);

  const idsA = new Set(a.map((e) => e.id));
  const overlap = b.filter((e) => idsA.has(e.id));
  if (overlap.length > 0) {
    throw new Error(`Stale event was reclaimed twice: ${overlap.map((e) => e.id).join(', ')}`);
  }
  if (a.length + b.length !== 1) {
    throw new Error(`Expected exactly one reclaim across both workers, got ${a.length + b.length}`);
  }
});

// ---------------------------------------------------------------------------
// TC-PG-05 — Idempotency: same key + same payload replays, different payload conflicts
// ---------------------------------------------------------------------------
register('TC-PG-05', 'Same idempotency key + same payload replays; different payload is a conflict', async () => {
  const audit = new AuditService();
  const repo = new PrismaTransactionRepository(prisma);
  const service = new TransactionsService(audit, undefined, undefined, repo);

  const input = {
    correlationId: unique('corr'),
    idempotencyKey: unique('idemp'),
    transactionType: 'SALE',
    payload: { invoiceNumber: 'INV-PG-5', amount: '100.00', currency: 'IDR' },
    organizationId: orgId,
  };

  const first = await service.ingest(input);
  const replay = await service.ingest(input);

  if (!replay.isDuplicate) throw new Error('Expected identical re-submission to be an idempotent replay');
  if (replay.gatewayRequestId !== first.gatewayRequestId) {
    throw new Error('Idempotent replay returned a different gatewayRequestId');
  }

  let conflict = false;
  try {
    await service.ingest({ ...input, payload: { invoiceNumber: 'INV-PG-5', amount: '999.00', currency: 'IDR' } });
  } catch (e: any) {
    conflict = e?.code === 'IDEMPOTENCY_CONFLICT';
  }
  if (!conflict) throw new Error('Reusing the key with a different payload did not raise IDEMPOTENCY_CONFLICT');

  const rows = await prisma.transaction.count({ where: { organizationId: orgId, idempotencyKey: input.idempotencyKey } });
  if (rows !== 1) throw new Error(`Expected exactly 1 persisted row for the key, found ${rows}`);
});

// ---------------------------------------------------------------------------
// TC-PG-06 — Retry scheduling and dead-letter transitions are persisted
// ---------------------------------------------------------------------------
register('TC-PG-06', 'Retry scheduling and dead-letter transitions are persisted durably', async () => {
  const seedRepo = new PrismaTransactionRepository(prisma);
  const record = await seedTransaction();
  await seedRepo.createAtomic(record, { toStatus: 'PENDING' }, {
    eventType: 'DISPATCH_LEDGER',
    payload: {},
    deduplicationKey: `dispatch:${record.id}`,
    maxAttempts: 5,
  });

  const repo = new PrismaOutboxRepository(prisma);
  const event = (await prisma.outboxEvent.findFirst({ where: { transactionId: record.id } })) as any;

  const later = Date.now() + 30000;
  await repo.scheduleRetry(event.id, later, 'TRANSIENT_NETWORK_ERROR', 'timeout', Date.now());
  const afterRetry = await prisma.outboxEvent.findUnique({ where: { id: event.id } });
  if (afterRetry.status !== 'RETRY_PENDING') {
    throw new Error(`Expected RETRY_PENDING after scheduleRetry, got ${afterRetry.status}`);
  }
  if (new Date(afterRetry.nextAttemptAt).getTime() !== later) {
    throw new Error('Retry schedule timestamp was not persisted exactly');
  }
  if (afterRetry.lockedAt !== null || afterRetry.lockedBy !== null) {
    throw new Error('Retry scheduling must clear the lease');
  }

  await repo.markDeadLetter(event.id, 'OUTBOX_RETRIES_EXHAUSTED', 'exhausted', Date.now());
  const afterDead = await prisma.outboxEvent.findUnique({ where: { id: event.id } });
  if (afterDead.status !== 'DEAD_LETTER') {
    throw new Error(`Expected DEAD_LETTER, got ${afterDead.status}`);
  }
});

// ---------------------------------------------------------------------------
// TC-PG-07 — Durable lock: exclusive ownership across independent connections
// ---------------------------------------------------------------------------
register('TC-PG-07', 'Durable reconciliation lock grants exclusive ownership across independent DB connections', async () => {
  const lockKey = unique('recon-lock');
  const clientA = await newPrismaClient();
  const clientB = await newPrismaClient();
  const lockA = new PostgresReconciliationLock(clientA, { lockKey, ttlMs: 8000 });
  const lockB = new PostgresReconciliationLock(clientB, { lockKey, ttlMs: 8000 });
  try {
    if (!(await lockA.tryAcquire('worker-A'))) throw new Error('Worker A failed to acquire a free lock');
    if (await lockB.tryAcquire('worker-B')) {
      throw new Error('Worker B acquired a lock already held by worker A');
    }
    if (!(await lockA.tryAcquire('worker-A'))) {
      throw new Error('The current owner could not re-acquire its own lease');
    }
    await lockA.release('worker-A');
    if (!(await lockB.tryAcquire('worker-B'))) {
      throw new Error('Worker B could not acquire the lock after the owner released it');
    }
    await lockB.release('worker-B');
  } finally {
    lockA.stop();
    lockB.stop();
    await prisma.$executeRawUnsafe('DELETE FROM reconciliation_locks WHERE "lockKey" = $1', lockKey);
    await clientA.$disconnect();
    await clientB.$disconnect();
  }
});

// ---------------------------------------------------------------------------
// TC-PG-08 — Release is owner-scoped (a non-owner cannot free the lock)
// ---------------------------------------------------------------------------
register('TC-PG-08', 'Releasing the durable lock is owner-scoped; a non-owner cannot free it', async () => {
  const lockKey = unique('recon-lock');
  const clientA = await newPrismaClient();
  const clientB = await newPrismaClient();
  const lockA = new PostgresReconciliationLock(clientA, { lockKey, ttlMs: 8000 });
  const lockB = new PostgresReconciliationLock(clientB, { lockKey, ttlMs: 8000 });
  try {
    if (!(await lockA.tryAcquire('owner-A'))) throw new Error('Owner A failed to acquire the lock');

    // A different owner attempts to release A's lease.
    await lockB.release('owner-B');
    if (await lockB.tryAcquire('owner-B')) {
      throw new Error("A non-owner released another worker's lock");
    }

    // The true owner still holds it and can release normally.
    await lockA.release('owner-A');
    if (!(await lockB.tryAcquire('owner-B'))) {
      throw new Error('The lock was not acquirable after the true owner released it');
    }
    await lockB.release('owner-B');
  } finally {
    lockA.stop();
    lockB.stop();
    await prisma.$executeRawUnsafe('DELETE FROM reconciliation_locks WHERE "lockKey" = $1', lockKey);
    await clientA.$disconnect();
    await clientB.$disconnect();
  }
});

// ---------------------------------------------------------------------------
// TC-PG-09 — A crashed worker's lease expires; the lock is never permanent
// ---------------------------------------------------------------------------
register('TC-PG-09', "A crashed worker's lease expires and is reclaimed (no permanently held lock)", async () => {
  const lockKey = unique('recon-lock');
  const clientA = await newPrismaClient();
  const clientB = await newPrismaClient();
  const ttlMs = 800;
  const crashed = new PostgresReconciliationLock(clientA, { lockKey, ttlMs });
  const survivor = new PostgresReconciliationLock(clientB, { lockKey, ttlMs });
  try {
    if (!(await crashed.tryAcquire('crashed-worker'))) throw new Error('Crashed worker failed to acquire');

    // Simulate a crash: the heartbeat stops and the lease is never released.
    crashed.stop();

    if (await survivor.tryAcquire('survivor')) {
      throw new Error('A live lease was ignored and the lock was stolen');
    }
    await sleep(ttlMs + 500);
    if (!(await survivor.tryAcquire('survivor'))) {
      throw new Error('An expired lease was not reclaimed — the lock appears permanently held');
    }
    await survivor.release('survivor');
  } finally {
    crashed.stop();
    survivor.stop();
    await prisma.$executeRawUnsafe('DELETE FROM reconciliation_locks WHERE "lockKey" = $1', lockKey);
    await clientA.$disconnect();
    await clientB.$disconnect();
  }
});

// ---------------------------------------------------------------------------
// TC-PG-10 — Heartbeat renewal keeps exclusivity beyond the lease TTL
// ---------------------------------------------------------------------------
register('TC-PG-10', 'The heartbeat renews the lease so a long run keeps exclusivity beyond the TTL', async () => {
  const lockKey = unique('recon-lock');
  const clientA = await newPrismaClient();
  const clientB = await newPrismaClient();
  const ttlMs = 1000;
  const holder = new PostgresReconciliationLock(clientA, { lockKey, ttlMs, renewIntervalMs: 300 });
  const peer = new PostgresReconciliationLock(clientB, { lockKey, ttlMs });
  try {
    if (!(await holder.tryAcquire('holder'))) throw new Error('Holder failed to acquire the lock');

    // Hold for longer than the TTL: without an active heartbeat the lease would
    // have expired and the peer would be able to take over.
    await sleep(ttlMs + 700);
    const stolenByRenewalGap = await peer.tryAcquire('peer');
    if (stolenByRenewalGap) {
      throw new Error('The lease expired despite an active heartbeat — mutual exclusion was lost');
    }

    holder.stop();
    await holder.release('holder');
    if (!(await peer.tryAcquire('peer'))) {
      throw new Error('The lock was not acquirable after a normal release');
    }
    await peer.release('peer');
  } finally {
    holder.stop();
    peer.stop();
    await prisma.$executeRawUnsafe('DELETE FROM reconciliation_locks WHERE "lockKey" = $1', lockKey);
    await clientA.$disconnect();
    await clientB.$disconnect();
  }
});

// ---------------------------------------------------------------------------
// TC-PG-11 — Cross-PROCESS exclusion (a real second OS process)
// ---------------------------------------------------------------------------
register('TC-PG-11', 'A second OS process cannot acquire the durable lock while the first holds it', async () => {
  const lockKey = unique('recon-lock-xproc');
  const lock = new PostgresReconciliationLock(prisma, { lockKey, ttlMs: 20000 });
  try {
    if (!(await lock.tryAcquire('parent-process'))) throw new Error('Parent process failed to acquire the lock');

    const whileHeld = await runLockHolderWorker(lockKey, 'child-process', 0);
    if (whileHeld.acquired) {
      throw new Error('A second OS process acquired the lock while the first process held it');
    }

    await lock.release('parent-process');

    const afterRelease = await runLockHolderWorker(lockKey, 'child-process-2', 300);
    if (!afterRelease.acquired) {
      throw new Error('A second OS process could not acquire the lock after the parent released it');
    }
  } finally {
    lock.stop();
    await prisma.$executeRawUnsafe('DELETE FROM reconciliation_locks WHERE "lockKey" = $1', lockKey);
  }
});

// ---------------------------------------------------------------------------
// TC-PG-12 — Two workers reconcile the SAME transaction exactly once
// ---------------------------------------------------------------------------
register('TC-PG-12', 'Two independent workers reconcile the same transaction exactly once (durable lease, live DB)', async () => {
  const localOrg = await createOrg();
  const gatewayRequestId = await seedReconciliationRequiredPg(prisma, localOrg);

  const clientA = await newPrismaClient();
  const clientB = await newPrismaClient();
  const lockKey = unique('recon-lock');

  let queriesA = 0;
  let queriesB = 0;
  const evidence = () => ({
    fabricTransactionId: `fabric-${gatewayRequestId}`,
    status: 'CONFIRMED',
    blockNumber: 4242,
    commitTimestamp: new Date().toISOString(),
    isSimulated: true,
  });
  const workerA = buildWorker(clientA, lockKey, makeEvidenceAdapter(() => { queriesA++; }, evidence));
  const workerB = buildWorker(clientB, lockKey, makeEvidenceAdapter(() => { queriesB++; }, evidence));

  try {
    const [ra, rb] = await Promise.all([
      workerA.service.runReconciliation(),
      workerB.service.runReconciliation(),
    ]);

    const skipped = [ra, rb].filter((r) => r.skipped).length;
    if (skipped !== 1) {
      throw new Error(`Expected exactly one skipped overlapping run, got ${skipped}`);
    }

    const winner = ra.skipped ? rb : ra;
    if (winner.confirmed !== 1) {
      throw new Error(`Expected exactly one confirmed outcome, got ${winner.confirmed}`);
    }
    if (queriesA + queriesB !== 1) {
      throw new Error(`Expected a single provider evidence query across both workers, got ${queriesA + queriesB}`);
    }

    const row = await prisma.transaction.findUnique({ where: { gatewayRequestId } });
    if (!row) throw new Error('Transaction row disappeared');
    if (row.lifecycleState !== 'COMMITTED') {
      throw new Error(`Expected the transaction to be COMMITTED exactly once, got ${row.lifecycleState}`);
    }
    if (Number(row.blockNumber) !== 4242) {
      throw new Error(`Expected the verified block number 4242, got ${row.blockNumber}`);
    }
  } finally {
    workerA.lock.stop();
    workerB.lock.stop();
    await prisma.$executeRawUnsafe('DELETE FROM reconciliation_locks WHERE "lockKey" = $1', lockKey);
    await clientA.$disconnect();
    await clientB.$disconnect();
  }
});

// ---------------------------------------------------------------------------
// TC-PG-13 — Ambiguous result under contention stays fail-closed
// ---------------------------------------------------------------------------
register('TC-PG-13', 'Under contention an ambiguous provider result preserves RECONCILIATION_REQUIRED', async () => {
  const localOrg = await createOrg();
  const gatewayRequestId = await seedReconciliationRequiredPg(prisma, localOrg);

  const clientA = await newPrismaClient();
  const clientB = await newPrismaClient();
  const lockKey = unique('recon-lock');

  let queriesA = 0;
  let queriesB = 0;
  const evidence = () => ({
    fabricTransactionId: `fabric-${gatewayRequestId}`,
    status: 'PENDING',
    isSimulated: true,
  });
  const workerA = buildWorker(clientA, lockKey, makeEvidenceAdapter(() => { queriesA++; }, evidence));
  const workerB = buildWorker(clientB, lockKey, makeEvidenceAdapter(() => { queriesB++; }, evidence));

  try {
    const [ra, rb] = await Promise.all([
      workerA.service.runReconciliation(),
      workerB.service.runReconciliation(),
    ]);

    const skipped = [ra, rb].filter((r) => r.skipped).length;
    if (skipped !== 1) throw new Error(`Expected exactly one skipped run, got ${skipped}`);
    if (queriesA + queriesB !== 1) {
      throw new Error(`Expected a single provider evidence query across both workers, got ${queriesA + queriesB}`);
    }

    const row = await prisma.transaction.findUnique({ where: { gatewayRequestId } });
    if (!row) throw new Error('Transaction row disappeared');
    if (row.lifecycleState !== 'RECONCILIATION_REQUIRED') {
      throw new Error(`An ambiguous result must preserve RECONCILIATION_REQUIRED, got ${row.lifecycleState}`);
    }
    if (row.blockNumber !== null) {
      throw new Error('An ambiguous result must never fabricate a block number');
    }
  } finally {
    workerA.lock.stop();
    workerB.lock.stop();
    await prisma.$executeRawUnsafe('DELETE FROM reconciliation_locks WHERE "lockKey" = $1', lockKey);
    await clientA.$disconnect();
    await clientB.$disconnect();
  }
});

// ---------------------------------------------------------------------------
// TC-PG-14 — Crash recovery then retry: the reclaimed lease completes the work
// ---------------------------------------------------------------------------
register('TC-PG-14', 'After a crashed lease expires a surviving worker re-acquires and reconciles successfully', async () => {
  const localOrg = await createOrg();
  const gatewayRequestId = await seedReconciliationRequiredPg(prisma, localOrg);

  const crashedClient = await newPrismaClient();
  const survivorClient = await newPrismaClient();
  const lockKey = unique('recon-lock');
  const ttlMs = 900;

  const crashedLock = new PostgresReconciliationLock(crashedClient, { lockKey, ttlMs });
  const evidence = () => ({
    fabricTransactionId: `fabric-${gatewayRequestId}`,
    status: 'CONFIRMED',
    blockNumber: 777,
    commitTimestamp: new Date().toISOString(),
    isSimulated: true,
  });
  const survivor = buildWorker(survivorClient, lockKey, makeEvidenceAdapter(() => {}, evidence), ttlMs);

  try {
    if (!(await crashedLock.tryAcquire('crashed-worker'))) throw new Error('Crashed worker failed to acquire');
    crashedLock.stop(); // crash: heartbeat stops, lease is never released

    const blockedRun = await survivor.service.runReconciliation();
    if (!blockedRun.skipped) {
      throw new Error('A run started while another worker still held the durable lock');
    }

    await sleep(ttlMs + 600);

    const recoveredRun = await survivor.service.runReconciliation();
    if (recoveredRun.skipped) {
      throw new Error('The expired lease was not reclaimed — the lock stayed permanently held');
    }

    const row = await prisma.transaction.findUnique({ where: { gatewayRequestId } });
    if (!row || row.lifecycleState !== 'COMMITTED' || Number(row.blockNumber) !== 777) {
      throw new Error('The reclaimed lease did not yield a verified, committed reconciliation');
    }
  } finally {
    crashedLock.stop();
    survivor.lock.stop();
    await prisma.$executeRawUnsafe('DELETE FROM reconciliation_locks WHERE "lockKey" = $1', lockKey);
    await crashedClient.$disconnect();
    await survivorClient.$disconnect();
  }
});

async function main(): Promise<void> {
  const enabled = process.env.UBTL_PG_TESTS === 'true' || process.argv.includes('--pg');
  if (!enabled) {
    console.log('================================================================================');
    console.log(' POSTGRESQL INTEGRATION TESTS — SKIPPED');
    console.log(' Reason: opt-in flag not set.');
    console.log(' Enable with: UBTL_PG_TESTS=true DATABASE_URL=postgresql://... npx tsx test/pg-integration.test.ts');
    console.log('================================================================================');
    process.exit(0);
  }

  if (!process.env.DATABASE_URL) {
    console.log('POSTGRESQL INTEGRATION TESTS — SKIPPED: DATABASE_URL is not set.');
    process.exit(0);
  }

  // Non-literal specifier keeps TypeScript from statically requiring @prisma/client.
  const prismaModuleSpecifier = '@prisma/client';
  let PrismaClientCtor: any;
  try {
    const mod: any = await import(/* @vite-ignore */ prismaModuleSpecifier);
    PrismaClientCtor = mod.PrismaClient || mod.default?.PrismaClient;
  } catch {
    console.log('POSTGRESQL INTEGRATION TESTS — SKIPPED: @prisma/client is not installed in this environment.');
    process.exit(0);
  }

  if (!PrismaClientCtor) {
    console.log('POSTGRESQL INTEGRATION TESTS — SKIPPED: PrismaClient could not be resolved.');
    process.exit(0);
  }

  prisma = new PrismaClientCtor();
  try {
    await prisma.$connect();
  } catch (err: any) {
    console.log(`POSTGRESQL INTEGRATION TESTS — SKIPPED: database unreachable (${err?.message || err}).`);
    process.exit(0);
  }

  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  console.log('================================================================================');
  console.log(' POSTGRESQL INTEGRATION TESTS (live database)');
  console.log('================================================================================');

  for (const test of tests) {
    try {
      orgId = await createOrg();
      await test.run();
      console.log(`  [PASS] [${test.id}] ${test.name}`);
      passed++;
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [FAIL] [${test.id}] ${test.name} -> ${msg}`);
      failures.push(`${test.id}: ${msg}`);
      failed++;
    }
  }

  await prisma.$disconnect();

  console.log('\n--------------------------------------------------------------------------------');
  console.log(` PostgreSQL integration: ${passed} passed, ${failed} failed, ${tests.length} total`);
  console.log('--------------------------------------------------------------------------------\n');

  if (failed > 0) {
    for (const f of failures) console.error(`- ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('PostgreSQL integration runner fatal error:', err);
  process.exit(1);
});
