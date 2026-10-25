-- ============================================================================
-- UBTL BASELINE MIGRATION (Prompt 00 / Prompt 01 schema)
-- ============================================================================
-- The outbox hardening migration (20261024010000_outbox_subsystem_hardening)
-- is an ALTER-only migration and therefore requires this baseline to exist
-- first. Without it, `prisma migrate deploy` against an empty database fails
-- because the referenced tables/enums do not exist.
--
-- This baseline reconstructs the pre-hardening schema declared in
-- prisma/schema.prisma. The hardening migration then adds
-- OutboxEventStatus.PROCESSING/RETRY_PENDING and the
-- attemptCount/lockedAt/lockedBy/lastErrorCode/deduplicationKey columns.
--
-- NOTE: This baseline is hand-authored because no baseline migration was ever
-- committed. When Prisma CLI tooling is available, the authoritative check is:
--   npx prisma migrate diff \
--     --from-migrations prisma/migrations \
--     --to-schema-datamodel prisma/schema.prisma \
--     --shadow-database-url <SHADOW_DB_URL>
-- which must report an empty diff.
-- ============================================================================

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('SUBMITTED', 'PENDING', 'CONFIRMED', 'FAILED', 'TIMEOUT');
CREATE TYPE "TransactionType" AS ENUM ('SALE', 'PURCHASE', 'SAVINGS', 'LOAN', 'LAND_CERTIFICATE_EVENT', 'TAX_PAYMENT', 'GOLD_PURCHASE', 'WAQF', 'DONATION', 'CUSTOM_EVENT');
CREATE TYPE "OutboxEventType" AS ENUM ('DISPATCH_LEDGER', 'VERIFY_COMMIT', 'DELIVER_WEBHOOK');
-- PROCESSING and RETRY_PENDING are appended by the hardening migration.
CREATE TYPE "OutboxEventStatus" AS ENUM ('PENDING', 'COMPLETED', 'DEAD_LETTER', 'IN_PROGRESS', 'FAILED');

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "apiKeyHash" VARCHAR(128) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" UUID NOT NULL,
    "gatewayRequestId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "correlationId" VARCHAR(128) NOT NULL,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "transactionType" "TransactionType" NOT NULL,
    "schemaVersion" VARCHAR(16) NOT NULL DEFAULT '1.0',
    "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING',
    "lifecycleState" VARCHAR(32) NOT NULL DEFAULT 'OUTBOX_PENDING',
    "payloadHash" CHAR(64) NOT NULL,
    "hashAlgorithm" VARCHAR(32) NOT NULL DEFAULT 'sha256',
    "hashVersion" VARCHAR(16) NOT NULL DEFAULT 'v1',
    "canonicalizationSpec" VARCHAR(64) NOT NULL DEFAULT 'ubtl-canonical-json-v1',
    "fabricTransactionId" VARCHAR(128),
    "blockNumber" BIGINT,
    "blockchainTxHash" VARCHAR(256),
    "rawPayload" JSONB NOT NULL,
    "canonicalPayload" TEXT NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "errorCode" VARCHAR(64),
    "errorMessage" TEXT,
    "submittedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMPTZ(6),
    "failedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction_status_history" (
    "id" UUID NOT NULL,
    "transactionId" UUID NOT NULL,
    "fromStatus" "TransactionStatus",
    "toStatus" "TransactionStatus" NOT NULL,
    "reason" VARCHAR(255),
    "details" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transaction_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "transactionId" UUID NOT NULL,
    "eventType" "OutboxEventType" NOT NULL,
    "status" "OutboxEventStatus" NOT NULL DEFAULT 'PENDING',
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "nextAttemptAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "processedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_records" (
    "id" UUID NOT NULL,
    "transactionId" UUID NOT NULL,
    "gatewayRequestId" UUID NOT NULL,
    "internalStatus" VARCHAR(32) NOT NULL,
    "ledgerStatus" VARCHAR(32),
    "isMatched" BOOLEAN NOT NULL,
    "internalHash" CHAR(64) NOT NULL,
    "ledgerHash" CHAR(64),
    "discrepancyDetails" JSONB,
    "checkedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliation_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actorType" VARCHAR(32) NOT NULL,
    "actorId" VARCHAR(128),
    "action" VARCHAR(64) NOT NULL,
    "correlationId" VARCHAR(128),
    "resourceType" VARCHAR(64) NOT NULL,
    "resourceId" VARCHAR(128),
    "endpoint" VARCHAR(255),
    "httpStatus" INTEGER,
    "ipAddress" VARCHAR(64),
    "metadata" JSONB,
    "timestamp" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_code_key" ON "organizations"("code");
CREATE UNIQUE INDEX "transactions_gatewayRequestId_key" ON "transactions"("gatewayRequestId");
CREATE UNIQUE INDEX "uq_org_idempotency_key" ON "transactions"("organizationId", "idempotencyKey");
CREATE INDEX "idx_transactions_correlation_id" ON "transactions"("correlationId");
CREATE INDEX "idx_transactions_status" ON "transactions"("status");
CREATE INDEX "idx_transactions_payload_hash" ON "transactions"("payloadHash");
CREATE INDEX "idx_transactions_fabric_tx_id" ON "transactions"("fabricTransactionId");
CREATE INDEX "idx_transactions_created_at" ON "transactions"("createdAt");
CREATE INDEX "idx_status_history_tx_time" ON "transaction_status_history"("transactionId", "createdAt");
CREATE INDEX "idx_outbox_polling" ON "outbox_events"("status", "nextAttemptAt");
CREATE INDEX "idx_outbox_transaction_id" ON "outbox_events"("transactionId");
CREATE INDEX "idx_reconciliation_matched_time" ON "reconciliation_records"("isMatched", "checkedAt");
CREATE INDEX "idx_audit_logs_correlation_id" ON "audit_logs"("correlationId");
CREATE INDEX "idx_audit_logs_actor_time" ON "audit_logs"("actorType", "timestamp");

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transaction_status_history" ADD CONSTRAINT "transaction_status_history_transactionId_fkey"
    FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_transactionId_fkey"
    FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reconciliation_records" ADD CONSTRAINT "reconciliation_records_transactionId_fkey"
    FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
