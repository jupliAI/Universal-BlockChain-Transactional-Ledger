# Universal Blockchain Transaction Ledger (UBTL)
## Data Model & PostgreSQL / Prisma Specification

### 1. Relational Design Principles
- **Strict ACID Guarantees**: Transaction entity, status history, and outbox event are persisted in a single atomic database unit of work.
- **Durable Idempotency**: Enforced by compound unique constraint `@@unique([organizationId, idempotencyKey])`.
- **Off-Chain Payload Isolation**: Plaintext payloads and business documents remain in JSONB off-chain; only deterministic SHA-256 hashes (`payloadHash`) and blockchain identifiers are anchored on-chain.
- **Specification Metadata**: Every transaction stores its canonicalization specification (`canonicalizationSpec`), hash algorithm (`hashAlgorithm`), and hash version (`hashVersion`).

---

### 2. Prisma Schema (`prisma/schema.prisma`)

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

enum TransactionStatus {
  SUBMITTED
  PENDING
  CONFIRMED
  FAILED
  TIMEOUT
}

enum TransactionType {
  SALE
  PURCHASE
  SAVINGS
  LOAN
  LAND_CERTIFICATE_EVENT
  TAX_PAYMENT
  GOLD_PURCHASE
  WAQF
  DONATION
  CUSTOM_EVENT
}

enum OutboxEventType {
  DISPATCH_LEDGER
  VERIFY_COMMIT
  DELIVER_WEBHOOK
}

enum OutboxEventStatus {
  PENDING
  PROCESSING
  RETRY_PENDING
  COMPLETED
  DEAD_LETTER
  IN_PROGRESS // Backward-compatibility alias for PROCESSING
  FAILED      // Backward-compatibility alias for DEAD_LETTER
}

model Organization {
  id           String        @id @default(uuid()) @db.Uuid
  code         String        @unique @db.VarChar(64)
  name         String        @db.VarChar(255)
  apiKeyHash   String        @db.VarChar(128)
  isActive     Boolean       @default(true)
  createdAt    DateTime      @default(now()) @db.Timestamptz(6)
  updatedAt    DateTime      @updatedAt @db.Timestamptz(6)
  transactions Transaction[]

  @@map("organizations")
}

model Transaction {
  id                   String                    @id @default(uuid()) @db.Uuid
  gatewayRequestId     String                    @unique @default(uuid()) @db.Uuid
  organizationId       String                    @db.Uuid
  correlationId        String                    @db.VarChar(128)
  idempotencyKey       String                    @db.VarChar(128)
  transactionType      TransactionType
  schemaVersion       String                    @default("1.0") @db.VarChar(16)
  status               TransactionStatus         @default(PENDING)
  lifecycleState       String                    @default("OUTBOX_PENDING") @db.VarChar(32)
  
  // Cryptographic & Blockchain Identifiers
  payloadHash          String                    @db.Char(64) // SHA-256 hex string (256 bits = 64 hex chars)
  hashAlgorithm        String                    @default("sha256") @db.VarChar(32)
  hashVersion          String                    @default("v1") @db.VarChar(16)
  canonicalizationSpec String                    @default("ubtl-canonical-json-v1") @db.VarChar(64)
  fabricTransactionId  String?                   @db.VarChar(128)
  blockNumber          BigInt?                   @db.BigInt
  blockchainTxHash     String?                   @db.VarChar(256) // Legacy compatibility field
  
  // Off-Chain Payload Data
  rawPayload           Json                      @db.JsonB
  canonicalPayload     String                    @db.Text
  attemptCount         Int                       @default(0)
  
  // Failure / Timeout Metadata
  errorCode            String?                   @db.VarChar(64)
  errorMessage         String?                   @db.Text
  submittedAt          DateTime                  @default(now()) @db.Timestamptz(6)
  confirmedAt          DateTime?                 @db.Timestamptz(6)
  failedAt             DateTime?                 @db.Timestamptz(6)
  createdAt            DateTime                  @default(now()) @db.Timestamptz(6)
  updatedAt            DateTime                  @updatedAt @db.Timestamptz(6)

  organization         Organization              @relation(fields: [organizationId], references: [id], onDelete: Restrict)
  statusHistory        TransactionStatusHistory[]
  outboxEvents         OutboxEvent[]
  reconciliationRows   ReconciliationRecord[]

  @@unique([organizationId, idempotencyKey], name: "uq_org_idempotency_key")
  @@index([correlationId], name: "idx_transactions_correlation_id")
  @@index([status], name: "idx_transactions_status")
  @@index([payloadHash], name: "idx_transactions_payload_hash")
  @@index([fabricTransactionId], name: "idx_transactions_fabric_tx_id")
  @@index([createdAt], name: "idx_transactions_created_at")
  @@map("transactions")
}

model TransactionStatusHistory {
  id            String            @id @default(uuid()) @db.Uuid
  transactionId String            @db.Uuid
  fromStatus    TransactionStatus?
  toStatus      TransactionStatus
  reason        String?           @db.VarChar(255)
  details       Json?             @db.JsonB
  createdAt     DateTime          @default(now()) @db.Timestamptz(6)

  transaction   Transaction       @relation(fields: [transactionId], references: [id], onDelete: Cascade)

  @@index([transactionId, createdAt], name: "idx_status_history_tx_time")
  @@map("transaction_status_history")
}

model OutboxEvent {
  id               String            @id @default(uuid()) @db.Uuid
  transactionId    String            @db.Uuid
  eventType        OutboxEventType
  status           OutboxEventStatus @default(PENDING)
  payload          Json              @db.JsonB
  attemptCount     Int               @default(0)
  attempts         Int               @default(0) // Backward-compatible alias
  maxAttempts      Int               @default(5)
  nextAttemptAt    DateTime          @default(now()) @db.Timestamptz(6)
  lockedAt         DateTime?         @db.Timestamptz(6)
  lockedBy         String?           @db.VarChar(128)
  lastErrorCode    String?           @db.VarChar(64)
  lastError        String?           @db.Text
  processedAt      DateTime?         @db.Timestamptz(6)
  deduplicationKey String?           @unique @db.VarChar(128)
  createdAt        DateTime          @default(now()) @db.Timestamptz(6)
  updatedAt        DateTime          @updatedAt @db.Timestamptz(6)

  transaction   Transaction       @relation(fields: [transactionId], references: [id], onDelete: Cascade)

  @@index([status, nextAttemptAt], name: "idx_outbox_polling")
  @@index([transactionId], name: "idx_outbox_transaction_id")
  @@index([status, lockedAt], name: "idx_outbox_stuck_recovery")
  @@map("outbox_events")
}

model ReconciliationRecord {
  id                 String       @id @default(uuid()) @db.Uuid
  transactionId      String       @db.Uuid
  gatewayRequestId   String       @db.Uuid
  internalStatus     String       @db.VarChar(32)
  ledgerStatus       String?      @db.VarChar(32)
  isMatched          Boolean
  internalHash       String       @db.Char(64)
  ledgerHash         String?      @db.Char(64)
  discrepancyDetails Json?        @db.JsonB
  checkedAt          DateTime     @default(now()) @db.Timestamptz(6)

  transaction        Transaction  @relation(fields: [transactionId], references: [id], onDelete: Cascade)

  @@index([isMatched, checkedAt], name: "idx_reconciliation_matched_time")
  @@map("reconciliation_records")
}

model AuditLog {
  id            String   @id @default(uuid()) @db.Uuid
  actorType     String   @db.VarChar(32) // "SYSTEM", "SWITCHING", "OPERATOR"
  actorId       String?  @db.VarChar(128)
  action        String   @db.VarChar(64)
  correlationId String?  @db.VarChar(128)
  resourceType  String   @db.VarChar(64)
  resourceId    String?  @db.VarChar(128)
  endpoint      String?  @db.VarChar(255)
  httpStatus    Int?
  ipAddress     String?  @db.VarChar(64)
  metadata      Json?    @db.JsonB
  timestamp     DateTime @default(now()) @db.Timestamptz(6)

  @@index([correlationId], name: "idx_audit_logs_correlation_id")
  @@index([actorType, timestamp], name: "idx_audit_logs_actor_time")
  @@map("audit_logs")
}

// Durable, multi-process coordination for the reconciliation scheduler.
// One row per lock key. Ownership is a LEASE: `expiresAt` bounds how long an
// owner may hold the lock without renewing, so a crashed worker's lock is
// reclaimed after the TTL instead of leaking permanently. Acquire/release are
// single atomic statements (see PostgresReconciliationLock) — the row is never
// read-modify-written.
model ReconciliationLock {
  lockKey    String   @id @db.VarChar(128)
  ownerId    String   @db.VarChar(128)
  acquiredAt DateTime @default(now()) @db.Timestamptz(6)
  renewedAt  DateTime @default(now()) @db.Timestamptz(6)
  expiresAt  DateTime @db.Timestamptz(6)

  @@map("reconciliation_locks")
}
```

---

### 3. Database Migration Command
When running against a live PostgreSQL instance, migrations are generated and applied via Prisma:
```bash
npx prisma migrate dev --name init_ubtl_ingestion_engine
```
For production deployments:
```bash
npx prisma migrate deploy
```

Committed migration ledger (applied in order):

| Migration | Change |
|---|---|
| `20260101000000_baseline_init` | Baseline tables/enums (`organizations`, `transactions`, `transaction_status_history`, `outbox_events`, `reconciliation_records`, `audit_logs`). |
| `20261024010000_outbox_subsystem_hardening` | Adds `OutboxEventStatus.PROCESSING`/`RETRY_PENDING` and the outbox `attemptCount`/`lockedAt`/`lockedBy`/`lastErrorCode`/`deduplicationKey` columns. |
| `20261025000000_durable_reconciliation_lock` | **ADD-only.** Creates `reconciliation_locks` (Prompt 07 durable multi-worker reconciliation lease). |

Equivalence is verified with `npx prisma migrate diff --from-migrations
prisma/migrations --to-schema-datamodel prisma/schema.prisma
--shadow-database-url "<shadow>"` (must report *no difference*).
