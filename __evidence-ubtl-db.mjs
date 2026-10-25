// READ-ONLY DB evidence collector (UBTL side). No writes.
import { PrismaClient } from '@prisma/client';

process.loadEnvFile('.env');
const prisma = new PrismaClient();

try {
  const id = await prisma.$queryRawUnsafe('SELECT current_database() AS db, current_schema() AS schema');
  console.log(`UBTL_DB=${id[0]?.db} SCHEMA=${id[0]?.schema}`);

  const byStatus = await prisma.$queryRawUnsafe(
    'SELECT "status" AS k, COUNT(*)::int AS c FROM transactions GROUP BY 1 ORDER BY 1',
  );
  for (const r of byStatus) console.log(`UBTL_TX_STATUS=${r.k}:${r.c}`);

  const dupes = await prisma.$queryRawUnsafe(
    'SELECT "idempotencyKey" AS k, COUNT(*)::int AS c FROM transactions GROUP BY 1 HAVING COUNT(*) > 1',
  );
  console.log(`UBTL_DUPLICATE_IDEMPOTENCY_KEYS=${dupes.length}`);

  const e2e = await prisma.$queryRawUnsafe(
    `SELECT "idempotencyKey","transactionType","status","lifecycleState","fabricTransactionId","blockNumber","blockchainTxHash"
     FROM transactions WHERE "idempotencyKey" LIKE 'e2e-%' ORDER BY "createdAt"`,
  );
  for (const r of e2e) {
    console.log(
      `UBTL_E2E_TX key=${r.idempotencyKey} type=${r.transactionType} status=${r.status} lifecycle=${r.lifecycleState} fabricTx=${r.fabricTransactionId} block=${r.blockNumber} hash=${r.blockchainTxHash}`,
    );
  }

  const ob = await prisma.$queryRawUnsafe(
    'SELECT "eventType" AS t, "status" AS s, COUNT(*)::int AS c FROM outbox_events GROUP BY 1,2 ORDER BY 1,2',
  );
  for (const r of ob) console.log(`UBTL_OUTBOX_ALL=${r.t}:${r.s}:${r.c}`);

  const obe = await prisma.$queryRawUnsafe(
    `SELECT oe."eventType" AS t, oe."status" AS s, oe."attemptCount" AS a, oe."lastErrorCode" AS e, t."idempotencyKey" AS k
     FROM outbox_events oe JOIN transactions t ON t.id = oe."transactionId"
     WHERE t."idempotencyKey" LIKE 'e2e-%' ORDER BY oe."createdAt"`,
  );
  for (const r of obe) console.log(`UBTL_E2E_OUTBOX=${r.t}:${r.s}:attempts=${r.a}:err=${r.e ?? 'NONE'}:key=${r.k}`);

  const hist = await prisma.$queryRawUnsafe(
    `SELECT t."idempotencyKey" AS k, h."toStatus" AS s, h."reason" AS r
     FROM transaction_status_history h JOIN transactions t ON t.id = h."transactionId"
     WHERE t."idempotencyKey" LIKE 'e2e-%' ORDER BY h."createdAt"`,
  );
  for (const r of hist) console.log(`UBTL_E2E_HISTORY key=${r.k} -> ${r.s} reason=${String(r.r).slice(0, 60)}`);
} catch (err) {
  console.error(`UBTL_EVIDENCE_FAILED: ${err.message}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
