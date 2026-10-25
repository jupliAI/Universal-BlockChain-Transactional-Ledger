/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { UbtlConfig } from './environment.ts';

export type PersistenceBackendKind = 'postgres' | 'in-memory';

/**
 * The outcome of resolving which persistence backend the runtime must use.
 *
 * This is deliberately a pure decision (no I/O) so that the composition root's
 * choice can be asserted in tests without a database, and so the behaviour is
 * never implicit: every field states exactly what the runtime will do and why.
 */
export interface PersistenceDecision {
  backend: PersistenceBackendKind;
  /** True when the decision came from an explicit env setting (not 'auto'). */
  explicit: boolean;
  /** True only for the durable PostgreSQL backend. */
  isDurable: boolean;
  /**
   * When PostgreSQL is selected, controls what happens if the database cannot
   * be reached: `true` aborts startup (fail closed), `false` allows the
   * development fallback to the in-memory store after a loud warning.
   */
  failFastOnUnavailable: boolean;
  /** Human-readable justification, surfaced in startup logs and health. */
  reason: string;
}

/**
 * Resolves the persistence backend from configuration alone.
 *
 * Rules:
 *  - `UBTL_PERSISTENCE_BACKEND=postgres`  → PostgreSQL, fail fast if unreachable.
 *  - `UBTL_PERSISTENCE_BACKEND=in-memory` → non-durable simulation (dev only;
 *    `validateEnvironment()` rejects it under NODE_ENV=production).
 *  - `auto` + DATABASE_URL configured     → PostgreSQL. In production an
 *    unreachable database aborts startup; in development it falls back to
 *    in-memory with a warning.
 *  - `auto` + no DATABASE_URL             → in-memory (development), which the
 *    composition root refuses under NODE_ENV=production.
 */
export function resolvePersistenceDecision(config: UbtlConfig): PersistenceDecision {
  const mode = config.persistenceBackend;
  const hasDatabaseUrl = typeof config.databaseUrl === 'string' && config.databaseUrl.trim() !== '';
  const isProduction = config.nodeEnv === 'production';

  if (mode === 'postgres') {
    return {
      backend: 'postgres',
      explicit: true,
      isDurable: true,
      failFastOnUnavailable: true,
      reason: 'UBTL_PERSISTENCE_BACKEND=postgres (explicit durable backend)',
    };
  }

  if (mode === 'in-memory') {
    return {
      backend: 'in-memory',
      explicit: true,
      isDurable: false,
      failFastOnUnavailable: false,
      reason: 'UBTL_PERSISTENCE_BACKEND=in-memory (explicit non-durable development simulation)',
    };
  }

  // auto
  if (hasDatabaseUrl) {
    return {
      backend: 'postgres',
      explicit: false,
      isDurable: true,
      failFastOnUnavailable: isProduction,
      reason: 'DATABASE_URL is configured (auto)',
    };
  }

  return {
    backend: 'in-memory',
    explicit: false,
    isDurable: false,
    // Under production this must abort: see the composition root guard.
    failFastOnUnavailable: isProduction,
    reason: 'No DATABASE_URL configured (auto)',
  };
}

/**
 * Creates and connects a Prisma client using a non-literal specifier so that
 * TypeScript does not statically require `@prisma/client` (keeping the core
 * buildable in environments where it is absent). Throws when the client cannot
 * be resolved or the database is unreachable — the caller decides whether that
 * is fatal.
 */
export async function createPrismaClient(): Promise<any> {
  const prismaModuleSpecifier = '@prisma/client';
  const prismaModule: any = await import(/* @vite-ignore */ prismaModuleSpecifier);
  const PrismaClientCtor = prismaModule.PrismaClient || prismaModule.default?.PrismaClient;
  if (!PrismaClientCtor) {
    throw new Error('PrismaClient export could not be resolved from @prisma/client');
  }
  const client = new PrismaClientCtor();
  await client.$connect();
  return client;
}
