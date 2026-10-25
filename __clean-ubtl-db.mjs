import { PrismaClient } from '@prisma/client';

// Authorized cleanup of the UBTL *test* database only (ubtl_pgtest).
// Schema and _prisma_migrations are intentionally untouched.
process.loadEnvFile('.env');

const TABLES = [
  'transaction_status_history',
  'outbox_events',
  'transactions',
  'reconciliation_records',
  'reconciliation_locks',
  'audit_logs',
  'organizations',
];

const prisma = new PrismaClient();

async function counts(label) {
  for (const t of TABLES) {
    const rows = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS c FROM "${t}"`);
    console.log(`${label}_${t}=${rows[0].c}`);
  }
}

try {
  const id = await prisma.$queryRawUnsafe('SELECT current_database() AS db');
  console.log(`TARGET_DB=${id[0].db}`);
  if (id[0].db !== 'ubtl_pgtest') {
    throw new Error('Refusing to clean: target database is not ubtl_pgtest');
  }

  await counts('BEFORE');
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
  await counts('AFTER');

  const mig = await prisma.$queryRawUnsafe('SELECT COUNT(*)::int AS c FROM _prisma_migrations');
  console.log(`MIGRATIONS_PRESERVED=${mig[0].c}`);
} catch (err) {
  console.error('CLEAN_FAILED:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
