-- AlterEnum
ALTER TYPE "OutboxEventStatus" ADD VALUE IF NOT EXISTS 'PROCESSING';
ALTER TYPE "OutboxEventStatus" ADD VALUE IF NOT EXISTS 'RETRY_PENDING';

-- AlterTable
ALTER TABLE "outbox_events" 
  ADD COLUMN IF NOT EXISTS "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "lockedAt" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "lockedBy" VARCHAR(128),
  ADD COLUMN IF NOT EXISTS "lastErrorCode" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "deduplicationKey" VARCHAR(128);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "outbox_events_deduplicationKey_key" ON "outbox_events"("deduplicationKey");
CREATE INDEX IF NOT EXISTS "idx_outbox_stuck_recovery" ON "outbox_events"("status", "lockedAt");
