/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReconciliationLock } from './reconciliation.service.ts';

/**
 * Durable, multi-process reconciliation lock backed by a PostgreSQL lease row
 * (`reconciliation_locks`).
 *
 * WHY A LEASE TABLE AND NOT `pg_try_advisory_lock`:
 * PostgreSQL session-level advisory locks are bound to a single backend
 * connection and MUST be released on that exact connection. The application
 * reaches PostgreSQL through Prisma's connection pool, which offers no API to
 * pin a connection across statements, so an acquire/release pair could land on
 * two different backends and silently leak (or fail to release) the lock.
 * Transaction-scoped advisory locks (`pg_try_advisory_xact_lock`) would instead
 * require holding a database transaction open for the entire reconciliation run
 * — including the external provider calls the design forbids holding locks
 * across. A single-row lease with atomic UPSERT/UPDATE gives the same mutual
 * exclusion with SELECT-...-style one-statement semantics, works on any pooled
 * driver, and self-heals after a crash via lease expiry.
 *
 * Guarantees:
 *  - Exactly one owner for a lock key at a time (atomic INSERT ... ON CONFLICT).
 *  - Crash/connection-loss safe: the lease expires after `ttlMs`, so no process
 *    can hold the lock permanently.
 *  - Only the current owner can release (`WHERE ownerId = $2`).
 *  - A live run is kept alive by a heartbeat that renews the lease; if renewal
 *    fails the lock is reported as lost rather than silently assumed to be held.
 */
export interface PostgresReconciliationLockOptions {
  /** Lock key (one row per key). Defaults to the global reconciliation run lock. */
  lockKey?: string;
  /** Lease time-to-live in milliseconds; bounds crash recovery. Must be > 0. */
  ttlMs?: number;
  /** Heartbeat interval in milliseconds. Defaults to ~ttlMs / 3 (always < ttlMs). */
  renewIntervalMs?: number;
  /** Where to report lease-renewal loss. Defaults to `console`. */
  logger?: Pick<Console, 'warn'>;
}

const DEFAULT_LOCK_KEY = 'ubtl:reconciliation:run';
const DEFAULT_TTL_MS = 120_000;

// Acquire = atomic "insert, or take over an expired/self-owned lease".
const ACQUIRE_SQL = `
  INSERT INTO reconciliation_locks ("lockKey", "ownerId", "acquiredAt", "renewedAt", "expiresAt")
  VALUES ($1, $2, now(), now(), now() + $3::interval)
  ON CONFLICT ("lockKey") DO UPDATE
    SET "ownerId"    = EXCLUDED."ownerId",
        "acquiredAt" = now(),
        "renewedAt"  = now(),
        "expiresAt"  = EXCLUDED."expiresAt"
    WHERE reconciliation_locks."expiresAt" <= now()
       OR reconciliation_locks."ownerId" = EXCLUDED."ownerId"
  RETURNING "ownerId";
`;

// Release = owner-scoped immediate expiry (a non-owner cannot release).
const RELEASE_SQL = `
  UPDATE reconciliation_locks
  SET "expiresAt" = now(), "renewedAt" = now()
  WHERE "lockKey" = $1 AND "ownerId" = $2;
`;

// Renew = owner-scoped lease extension (heartbeat).
const RENEW_SQL = `
  UPDATE reconciliation_locks
  SET "expiresAt" = now() + $3::interval, "renewedAt" = now()
  WHERE "lockKey" = $1 AND "ownerId" = $2;
`;

export class PostgresReconciliationLock implements ReconciliationLock {
  private readonly lockKey: string;
  private readonly ttlMs: number;
  private readonly renewIntervalMs: number;
  private readonly logger: Pick<Console, 'warn'>;

  private currentOwnerId: string | null = null;
  private renewTimer: NodeJS.Timeout | null = null;
  private lostToAnotherOwner = false;

  constructor(
    private readonly prismaClient: any,
    options: PostgresReconciliationLockOptions = {}
  ) {
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error(`PostgresReconciliationLock: ttlMs must be a positive finite number, got ${ttlMs}`);
    }
    this.ttlMs = ttlMs;
    this.lockKey = options.lockKey ?? DEFAULT_LOCK_KEY;

    // The heartbeat must always fire well before the lease expires, otherwise a
    // healthy run could lose its own lock mid-flight.
    const requestedRenew = options.renewIntervalMs ?? Math.floor(ttlMs / 3);
    this.renewIntervalMs = Math.max(25, Math.min(requestedRenew, Math.floor(ttlMs / 2)));
    this.logger = options.logger ?? console;
  }

  getLockKey(): string {
    return this.lockKey;
  }

  /** True while this instance believes it holds an un-lost lease. */
  isHeld(): boolean {
    return this.currentOwnerId !== null && !this.lostToAnotherOwner;
  }

  /** True when the lease could not be renewed (another owner took over). */
  hasLostLock(): boolean {
    return this.lostToAnotherOwner;
  }

  /**
   * Atomically acquires (or re-acquires) the lease. Returns `false` when another
   * live owner holds it. Database errors propagate so the caller can fail closed.
   */
  async tryAcquire(ownerId: string): Promise<boolean> {
    if (!this.prismaClient) {
      throw new Error('PostgresReconciliationLock requires an initialised PrismaClient');
    }

    const rows: unknown = await this.prismaClient.$queryRawUnsafe(
      ACQUIRE_SQL,
      this.lockKey,
      ownerId,
      this.intervalLiteral()
    );

    const acquired = Array.isArray(rows) && rows.length > 0;
    if (acquired) {
      this.currentOwnerId = ownerId;
      this.lostToAnotherOwner = false;
      this.startRenewal();
    }
    return acquired;
  }

  /**
   * Releases the lease. Only the named owner's lease is expired, so a stale
   * caller (e.g. after a takeover) cannot release the real owner's lock.
   */
  async release(ownerId: string): Promise<void> {
    this.stopRenewal();
    if (this.currentOwnerId === ownerId) this.currentOwnerId = null;
    if (!this.prismaClient) return;

    await this.prismaClient.$executeRawUnsafe(RELEASE_SQL, this.lockKey, ownerId);
  }

  /**
   * Extends the lease for the given owner. Returns `false` when the row is no
   * longer owned by `ownerId` (a takeover happened) and marks the lock lost.
   */
  async renew(ownerId: string): Promise<boolean> {
    if (!this.prismaClient) return false;

    const affected: number = await this.prismaClient.$executeRawUnsafe(
      RENEW_SQL,
      this.lockKey,
      ownerId,
      this.intervalLiteral()
    );

    if (!affected || affected === 0) {
      this.lostToAnotherOwner = true;
      this.stopRenewal();
      this.logger.warn(
        `[ReconciliationLock] Lease for owner '${ownerId}' on '${this.lockKey}' was lost to another owner.`
      );
      return false;
    }
    return true;
  }

  /** Stops the heartbeat without touching the database (used on shutdown/tests). */
  stop(): void {
    this.stopRenewal();
  }

  private intervalLiteral(): string {
    // Fractional seconds are valid for PostgreSQL interval input (e.g. "0.3 seconds").
    return `${this.ttlMs / 1000} seconds`;
  }

  private startRenewal(): void {
    this.stopRenewal();
    const ownerId = this.currentOwnerId;
    if (!ownerId) return;

    this.renewTimer = setInterval(() => {
      this.renew(ownerId).catch((err: unknown) => {
        this.logger.warn(
          `[ReconciliationLock] Lease renewal for '${ownerId}' failed: ${err instanceof Error ? err.message : err}`
        );
      });
    }, this.renewIntervalMs);
    // Never keep the event loop alive purely for the heartbeat.
    if (typeof this.renewTimer.unref === 'function') this.renewTimer.unref();
  }

  private stopRenewal(): void {
    if (this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = null;
    }
  }
}
