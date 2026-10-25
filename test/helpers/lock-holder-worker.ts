/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * =============================================================================
 * CROSS-PROCESS DURABLE-LOCK PROBE (Prompt 07 verification helper)
 * =============================================================================
 *
 * Runs as a SEPARATE OS process so the PostgreSQL lease lock can be verified
 * across real process boundaries (not merely two clients in one process).
 *
 * It acquires the durable reconciliation lock under the given owner id, prints
 * one JSON line describing the outcome, then — if it acquired — holds the lock
 * (with heartbeat) for `holdMs` and releases it before exiting.
 *
 * Usage:
 *   tsx test/helpers/lock-holder-worker.ts <lockKey> <ownerId> <holdMs>
 *
 * stdout contract (one JSON object per line):
 *   {"event":"acquired","acquired":true|false}
 *   {"event":"released"}              (only when acquired)
 */

import { PostgresReconciliationLock } from '../../src/modules/reconciliation/postgres-reconciliation.lock.ts';

const [lockKey, ownerId, holdMsRaw] = process.argv.slice(2);
const holdMs = Number(holdMsRaw);

if (!lockKey || !ownerId || !Number.isFinite(holdMs)) {
  process.stderr.write('usage: tsx lock-holder-worker.ts <lockKey> <ownerId> <holdMs>\n');
  process.exit(2);
}

const prismaModuleSpecifier = '@prisma/client';
const prismaModule: any = await import(/* @vite-ignore */ prismaModuleSpecifier);
const PrismaClientCtor = prismaModule.PrismaClient || prismaModule.default?.PrismaClient;
if (!PrismaClientCtor) {
  process.stderr.write('@prisma/client PrismaClient could not be resolved\n');
  process.exit(2);
}

const prisma = new PrismaClientCtor();
await prisma.$connect();

// A generous TTL with a heartbeat mirrors a healthy worker holding the lease.
const lock = new PostgresReconciliationLock(prisma, { lockKey, ttlMs: 15000, renewIntervalMs: 1000 });

const acquired = await lock.tryAcquire(ownerId);
process.stdout.write(`${JSON.stringify({ event: 'acquired', acquired })}\n`);

if (acquired) {
  await new Promise((resolve) => setTimeout(resolve, holdMs));
  await lock.release(ownerId);
  lock.stop();
  process.stdout.write(`${JSON.stringify({ event: 'released' })}\n`);
}

await prisma.$disconnect();
process.exit(0);
