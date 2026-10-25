-- ============================================================================
-- DURABLE MULTI-WORKER RECONCILIATION LOCK (Prompt 07)
-- ============================================================================
-- Replaces the process-local SingleProcessReconciliationLock with a durable
-- coordination primitive that is safe across multiple worker processes sharing
-- one PostgreSQL database.
--
-- Design: a single-row lease. `expiresAt` bounds how long an owner may hold the
-- lock without renewing, so a crashed worker or a severed connection can never
-- hold the lock forever. Acquire and release are single atomic statements
-- (INSERT ... ON CONFLICT ... DO UPDATE / UPDATE ... WHERE ownerId = ...) so no
-- read-modify-write race exists between workers.
--
-- This migration is ADD-only: it creates one new table and touches nothing else.
-- ============================================================================

-- CreateTable
CREATE TABLE "reconciliation_locks" (
    "lockKey" VARCHAR(128) NOT NULL,
    "ownerId" VARCHAR(128) NOT NULL,
    "acquiredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "renewedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "reconciliation_locks_pkey" PRIMARY KEY ("lockKey")
);
