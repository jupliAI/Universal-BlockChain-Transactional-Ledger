# Transactional Outbox & Background Worker Subsystem Specification

## 1. Overview & Architecture

The Transactional Outbox pattern guarantees **at-least-once asynchronous delivery** of accepted transactions to external blockchain peers (Hyperledger Fabric) and downstream webhook endpoints (Switching integration) without distributed transactions (2PC) or dual-write inconsistencies.

```
+-----------------------------------------------------------------------------------------+
|                                    TRANSACTION API                                      |
|                               POST /v1/transactions                                     |
+-------------------------------------------+---------------------------------------------+
                                            |
                                            v
+-----------------------------------------------------------------------------------------+
|                           ATOMIC DATABASE UNIT OF WORK                                  |
|   BEGIN TRANSACTION                                                                     |
|     1. Persist Transaction record (status: 'pending', lifecycleState: 'OUTBOX_PENDING') |
|     2. Persist initial Status History record                                            |
|     3. Persist initial OutboxEvent record (type: 'DISPATCH_LEDGER', status: 'PENDING')  |
|   COMMIT TRANSACTION                                                                    |
+-------------------------------------------+---------------------------------------------+
                                            | HTTP 202 Accepted { status: "pending" }
                                            v
+-----------------------------------------------------------------------------------------+
|                                   OUTBOX WORKER                                         |
|                                                                                         |
|   1. Atomic Claim: SELECT ... FOR UPDATE SKIP LOCKED (PostgreSQL)                       |
|      - Updates status to 'PROCESSING', records workerId, lockedAt, increments attempts  |
|      - Commits claim transaction BEFORE contacting external blockchain peer             |
|                                                                                         |
|   2. Dispatch: submitProposal to BlockchainAdapter                                      |
|      - On Success: marks Transaction 'submitted', enqueues 'VERIFY_COMMIT' and webhook  |
|      - On Timeout / Ambiguous: sets tx 'RECONCILIATION_REQUIRED', queries adapter       |
|      - On Transient Error: schedules backoff retry                                      |
|      - On Permanent Error: marks event 'DEAD_LETTER', marks tx 'FAILED'                 |
|                                                                                         |
|   3. Commit Verification: queryCommitStatus                                             |
|      - When Block Included (blockNumber > 0): marks tx 'confirmed'/'COMMITTED'          |
|      - Enqueues 'DELIVER_WEBHOOK' for confirmed status                                  |
+-----------------------------------------------------------------------------------------+
```

---

## 2. Outbox Data Model

The `outbox_events` table (and its in-memory mirror) tracks asynchronous operations:

| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | `UUID` | Primary key identifier. |
| `transactionId` | `UUID` | Associated transaction foreign key. |
| `eventType` | `ENUM` | `DISPATCH_LEDGER`, `VERIFY_COMMIT`, or `DELIVER_WEBHOOK`. |
| `status` | `ENUM` | `PENDING`, `PROCESSING`, `RETRY_PENDING`, `COMPLETED`, `DEAD_LETTER`. |
| `payload` | `JSONB` | Minimal protected payload (correlation IDs, references; sensitive payloads are omitted). |
| `attemptCount` | `INTEGER` | Current attempt counter (starts at 0, incremented upon claiming). |
| `maxAttempts` | `INTEGER` | Maximum total attempts before dead-lettering (default: 5). |
| `nextAttemptAt` | `TIMESTAMPTZ` | Timestamp when the event becomes eligible for worker polling. |
| `lockedAt` | `TIMESTAMPTZ` | Timestamp when event was locked by a worker. Null when not processing. |
| `lockedBy` | `VARCHAR` | Worker instance identifier (`worker-<uuid>`). |
| `lastErrorCode` | `VARCHAR` | Sanitized machine-readable error code (e.g. `ETIMEDOUT`, `INVALID_ARGUMENT`). |
| `lastError` | `TEXT` | Sanitized error message (credentials and keys redacted). |
| `processedAt` | `TIMESTAMPTZ` | Timestamp of completion. |
| `deduplicationKey` | `VARCHAR(128)` | Unique constraint preventing duplicate event generation for the same logical stage. |

---

## 3. Worker Concurrency & Claiming Strategy

### 3.1 PostgreSQL Engine
In PostgreSQL mode, workers run concurrently across multiple container instances without message loss or double-processing:

```sql
BEGIN;
SELECT id
FROM outbox_events
WHERE status IN ('PENDING', 'RETRY_PENDING')
  AND "nextAttemptAt" <= NOW()
ORDER BY "nextAttemptAt" ASC
LIMIT $1
FOR UPDATE SKIP LOCKED;

UPDATE outbox_events
SET status = 'PROCESSING',
    "lockedAt" = NOW(),
    "lockedBy" = $2,
    "attemptCount" = "attemptCount" + 1,
    "updatedAt" = NOW()
WHERE id = ANY($selected_ids);
COMMIT;
```

**Critical Invariant**: Database row locks are **committed immediately** after claiming. Workers **never** hold database row locks open while waiting on network I/O with Hyperledger Fabric peers or webhook endpoints.

### 3.2 In-Memory Development Simulator
In local development / preview mode, `InMemoryOutboxRepository` provides atomic synchronous claiming with distinct worker identities and FIFO sorting, but is scoped to the Node.js process.

---

## 4. Retry Policy & Exponential Backoff with Bounded Jitter

UBTL implements truncated exponential backoff with bounded full jitter:

$$\text{delay} = \min(\text{maxDelay}, \text{baseDelay} \times 2^{\text{attemptCount} - 1}) + \text{jitter}$$

where:
- `baseDelay`: Configured via `OUTBOX_BACKOFF_BASE_MS` (default: 1000 ms).
- `maxDelay`: Capped at 60,000 ms (1 minute).
- `attemptCount`: 1-indexed attempt number.
- `jitter`: Random value between $0$ and $\min(500, \text{cappedBase} \times 0.25)$.
- `OUTBOX_MAX_RETRIES`: Represents **total attempts allowed** (default: 5).

### Error Classification Table

| Classification | Trigger Conditions | Worker Action |
| :--- | :--- | :--- |
| **TRANSIENT** | Network reset (`ECONNRESET`), socket timeout, 503 Service Unavailable, peer unavailable | Reschedule event to `RETRY_PENDING` with exponential backoff if `attemptCount < maxAttempts`. If attempts exhausted, mark `DEAD_LETTER`. |
| **PERMANENT** | Schema validation error (`VALIDATION_ERROR`), bad argument, authorization failure (`UNAUTHORIZED`) | Immediately transition event to `DEAD_LETTER`. Mark transaction lifecycle to `FAILED`. Never retry indefinitely. |
| **AMBIGUOUS** | Peer proposal timeout (`ETIMEDOUT`, `PROPOSAL_TIMEOUT`), commit timeout | Mark transaction `RECONCILIATION_REQUIRED`. Check adapter via `findTransactionByIdempotencyKey`. Do not resubmit blindly. |

---

## 5. Stuck Event Recovery & Crash Resilience

If a worker process crashes, terminates abruptly, or is killed by an OOM event while holding an event in `PROCESSING`:

1. The lock timestamp `lockedAt` remains in the past.
2. The background recovery loop (`recoverStuckEvents()`) periodically scans for:
   $$\text{status} = \text{'PROCESSING'} \quad \text{AND} \quad \text{lockedAt} < \text{NOW}() - \text{OUTBOX\_STUCK\_TIMEOUT\_MS}$$
3. **Ambiguity Check**: Before reclaiming:
   - For `DISPATCH_LEDGER`: Queries adapter via `findTransactionByIdempotencyKey(gatewayRequestId)` to verify if the proposal reached the peer prior to the crash.
   - If found: adopts provider ID, advances status to `submitted`, and enqueues `VERIFY_COMMIT`.
   - If confirmed absent: resets event to `RETRY_PENDING` with backoff.
   - If undetermined: marks `RECONCILIATION_REQUIRED` for operational investigation.
4. If max attempts are exhausted, marks event as `DEAD_LETTER` with `STUCK_MAX_ATTEMPTS_EXHAUSTED`.

---

## 6. Switching Webhook Decoupling

Delivery of external webhook callbacks (`DELIVER_WEBHOOK`) is completely decoupled from ledger consensus:
- Callback failures **never** roll back or invalidate a confirmed blockchain transaction.
- Webhook events have their own retry policy, attempt counter, and backoff schedule.
- Payload data sent to Switching webhooks contains minimal routing references (`gatewayRequestId`, `correlationId`, `status`, `blockchainTxHash`, `errorMessage`) and **never exposes confidential payload details**.

### 6.1 Delivery Semantics (At-Least-Once)

UBTL provides **at-least-once** delivery for both ledger dispatch and webhook
callbacks. It does **not** guarantee exactly-once external delivery:

- A callback may be delivered more than once — e.g. when the Switching receiver
  processes the callback but UBTL's sender times out before receiving the HTTP
  response, the event is retried after backoff.
- Therefore the **receiver (Switching) is responsible for deduplicating
  callbacks**, keyed on `gatewayRequestId` (and/or `correlationId`) plus the
  terminal status. Re-applying an already-applied callback must be idempotent on
  the receiver side.
- UBTL never resubmits a blockchain proposal that may already have committed
  without first reconciling; ambiguous submission outcomes enter
  `RECONCILIATION_REQUIRED` rather than being blindly retried.
- The original gateway request ID and idempotency key are preserved across all
  retries so receivers can correlate retried deliveries.

### 6.2 Webhook Attempt Classification & Retry Policy

Each `DELIVER_WEBHOOK` attempt returns an explicit classification (never derived
loosely from a status code embedded in text) so the shared retry policy applies:

| Attempt outcome | Classification | Worker action |
| :--- | :--- | :--- |
| HTTP 2xx | success | `COMPLETED`. |
| HTTP 5xx, 408, 425, 429 | `TRANSIENT` | Backoff retry until `SWITCHING_WEBHOOK_MAX_RETRIES`. |
| Other HTTP 4xx | `PERMANENT` | Dead-letter immediately; surface for operator review. |
| Connection failure (`ECONNREFUSED`, `ECONNRESET`, `ENOTFOUND`, …) | `TRANSIENT` | Backoff retry. |
| Client timeout (`AbortSignal.timeout`) | `AMBIGUOUS` | Retry is safe **only** because delivery is at-least-once and the receiver deduplicates. |

- The webhook event's `maxAttempts` uses `SWITCHING_WEBHOOK_MAX_RETRIES` (default
  `5`), independent of the ledger `OUTBOX_MAX_RETRIES`.
- The dispatcher (`WebhookService.deliverWebhook`) **never throws** and **never
  mutates ledger/transaction state**; it only records delivery metrics and an
  audit entry. A webhook failure can therefore never reverse a confirmed commit.
- Initial `DELIVER_WEBHOOK` events are de-duplicated by the durable unique
  `deduplicationKey` `webhook:${status}:${transactionId}`, so the same logical
  transition cannot enqueue two initial events.

---

## 7. Observability & Health Metrics

`GET /v1/health` and `GET /v1/admin/outbox` expose real-time worker metrics:
- `worker.running`: Boolean running state.
- `worker.workerId`: Active worker instance identity.
- `worker.lastPollTime`: Timestamp of latest poll cycle.
- `outbox.pendingCount`: Events awaiting initial claim.
- `outbox.processingCount`: Events currently claimed and executing.
- `outbox.retryPendingCount`: Events waiting for backoff timer expiry.
- `outbox.completedCount`: Successfully executed events.
- `outbox.deadLetterCount`: Failed events after retry exhaustion.
- `outbox.oldestPendingAgeMs`: Age of oldest waiting pending event in milliseconds.
- `outbox.lastErrorCode`: Most recent error code recorded by the worker.

When the composition root injects the optional observability providers,
`GET /v1/health` additionally includes a `webhook` section (queue state scoped to
`DELIVER_WEBHOOK` events plus in-process delivery outcomes) and a
`reconciliation` section (see §8). Both contain only aggregates — never secrets,
credentials, or raw transaction payloads.

---

## 8. Reconciliation Job

### 8.1 Purpose & eligibility

The reconciliation job is a **bounded, observable** process that resolves
transactions whose ledger outcome is ambiguous — primarily those in
`RECONCILIATION_REQUIRED` (e.g. an ambiguous submission timeout). Explicitly
eligible states:

- `RECONCILIATION_REQUIRED` — always eligible (primary target).
- `SUBMITTED` / `AWAITING_COMMIT` older than `RECONCILIATION_LOOKBACK_HOURS` —
  potentially stuck after a worker crash and otherwise never advancing.

All other states (terminal `CONFIRMED`/`FAILED`/`VERIFIED`, and pre-submission
`OUTBOX_PENDING`) are **never** reconciled.

### 8.2 Evidence-first discipline

For every eligible transaction the job **queries provider evidence before any
state change** (`gatherEvidence`, a read-only call):

1. Preferred: the UBTL-defined request-id / idempotency-anchor chaincode query
   (`BlockchainAdapter.findTransactionByIdempotencyKey`) — the only viable source
   **after a process restart**.
2. Fallback: `queryCommitStatus(providerTransactionId)` — best-effort only,
   because Fabric Gateway exposes commit status only for the same-process
   `SubmittedTransaction`.

**Critical limitation (unresolved).** Fabric Gateway provides **no native
"query commit status by transaction ID" RPC**; `Commit.getStatus()` is process-bound.
Cross-restart reconciliation therefore depends on the UBTL-defined chaincode query,
which is **not yet deployed or verified against a real Fabric network**. Until
then, if the adapter cannot produce evidence after a restart, the transaction is
**inconclusive** and `RECONCILIATION_REQUIRED` is preserved. No provider evidence
is ever invented.

### 8.3 Outcome rules

| Evidence | Outcome | State change |
| :--- | :--- | :--- |
| `CONFIRMED` **with** `blockNumber > 0` and matching payload-hash proof (or no proof available) | `CONFIRMED` | Advance to `COMMITTED` (Axiom 5). |
| `CONFIRMED` **without** a positive block number | `INCONCLUSIVE` | None; `RECONCILIATION_REQUIRED` preserved. |
| `CONFIRMED` but ledger payload hash **mismatch** | `INCONCLUSIVE` (escalated) | None; flagged for manual review. |
| `FAILED` (definitive rejection) | `FAILED` | Advance to `FAILED`. |
| `FAILED` with a "not found" code | `INCONCLUSIVE` | None; absence of a record is not proof of failure. |
| `PENDING` / `TIMEOUT` | `INCONCLUSIVE` | None. |
| No usable evidence | `INCONCLUSIVE` | None. |
| Attempt threw | `ERROR` | None. |

Commit is **never** inferred from a submission acknowledgement.

### 8.4 Concurrency, bounds & auditability

- **No self-overlap**: an in-flight promise guard makes a second concurrent
  `runReconciliation()` return immediately as `skipped` (`overlap-in-process`).
- **Cross-worker coordination**: a `ReconciliationLock` is injected.
  - **Durable (default when a database is configured):** `PostgresReconciliationLock`
    coordinates multiple worker processes against PostgreSQL. It is a **single-row
    lease** (`reconciliation_locks`, one row per lock key) claimed with one atomic
    `INSERT ... ON CONFLICT ("lockKey") DO UPDATE ... RETURNING` whose `WHERE`
    accepts only an **expired** lease or the **same owner** — so exactly one owner
    holds a key at a time.
  - **Not `pg_try_advisory_lock`.** PostgreSQL advisory locks are bound to one
    backend connection; a pooled driver (Prisma) cannot pin a connection across
    statements, so acquire/release could land on different backends. The lease row
    is driver-agnostic and self-heals: a crashed worker's lease **expires** after
    `ttlMs` (`RECONCILIATION_LOCK_TTL_SECONDS`) and is then reclaimable, so a lock
    is never held permanently. A live run keeps its lease via a heartbeat; release
    is owner-scoped (`WHERE "ownerId" = $2`) and can expire only its own lease.
  - **Fail-closed.** If acquire **throws** (database unavailable/misconfigured) the
    run is **skipped** and an `RECONCILIATION_LOCK_ERROR` audit record is written —
    the job never proceeds without the lock.
  - **Single-process fallback:** `SingleProcessReconciliationLock` is used only when
    no durable database is wired and is safe **within one process only**.
- **Bounded**: `RECONCILIATION_BATCH_SIZE`, `RECONCILIATION_LOOKBACK_HOURS`,
  `RECONCILIATION_INTERVAL_MINUTES`, `RECONCILIATION_MAX_ATTEMPTS`.
- **No locks held over network I/O**: evidence is gathered on plain reads and
  state changes are short single-row updates; the job never holds a database row
  lock while calling the provider.
- **Auditable & sanitized**: every per-transaction outcome and every run emits an
  audit record (`RECONCILIATION_*`) with attempt number, evidence source, ledger
  status, block number, payload-hash match, escalation flag and a **secret-redacted**
  error string. Inconclusive cases that exhaust `RECONCILIATION_MAX_ATTEMPTS` are
  escalated (`escalated: true`) for operator review; unresolved cases remain
  visible via `GET /v1/health` (`reconciliation.unresolvedCount`).
