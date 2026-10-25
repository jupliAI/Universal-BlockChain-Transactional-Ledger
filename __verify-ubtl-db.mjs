import { PrismaClient } from '@prisma/client';

// Read-only verification of the UBTL durable target. No writes, no migrations.
process.loadEnvFile('.env');

const prisma = new PrismaClient();

try {
  const identity = await prisma.$queryRawUnsafe(
    'SELECT current_database() AS db, current_schema() AS schema, version() AS v',
  );
  console.log(`DB_NAME=${identity[0]?.db} SCHEMA=${identity[0]?.schema}`);

  const tables = await prisma.$queryRawUnsafe(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
  );
  console.log(`TABLE_COUNT=${tables.length}`);
  for (const t of tables) console.log(`TABLE=${t.table_name}`);

  const migrations = await prisma.$queryRawUnsafe(
    'SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at',
  ).catch(() => null);
  if (migrations) {
    console.log(`MIGRATION_ROWS=${migrations.length}`);
    for (const m of migrations) {
      console.log(
        `MIGRATION=${m.migration_name} finished=${m.finished_at ? 'YES' : 'NO'} rolled_back=${m.rolled_back_at ? 'YES' : 'NO'}`,
      );
    }
  } else {
    console.log('MIGRATION_ROWS=NO_MIGRATIONS_TABLE');
  }

  for (const t of ['transactions', 'outbox_events', 'audit_logs']) {
    const c = await prisma
      .$queryRawUnsafe(`SELECT COUNT(*)::int AS c FROM "${t}"`)
      .catch(() => null);
    console.log(`ROWCOUNT_${t.toUpperCase()}=${c ? c[0].c : 'N/A'}`);
  }

  for (const [table, column] of [
    ['transactions', 'status'],
    ['outbox_events', 'status'],
  ]) {
    const rows = await prisma
      .$queryRawUnsafe(
        `SELECT "${column}" AS k, COUNT(*)::int AS c FROM "${table}" GROUP BY "${column}" ORDER BY "${column}"`,
      )
      .catch(() => null);
    if (!rows) continue;
    for (const r of rows) console.log(`GROUP_${table}.${column}=${r.k}:${r.c}`);
  }
} catch (err) {
  console.error('VERIFY_FAILED:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
