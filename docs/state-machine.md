# Universal Blockchain Transaction Ledger (UBTL)
## State Machine Specifications: Transaction & Outbox Lifecycles

This document details the two distinct, decoupled state machines operating within UBTL:
1. **Transaction Domain Lifecycle** (reflects real ledger consensus and external Switching status).
2. **Outbox Event Processing State Machine** (controls asynchronous worker claiming, retries, and delivery).

---

## 1. Transaction Domain Lifecycle

```
                  [POST /v1/transactions]
                             |
                             v
                        +----------+
                        | RECEIVED |
                        +----+-----+
                             |
                             v
                        +-----------+
                        | VALIDATED |  ----(Schema invalid)----> [ REJECTED ] (HTTP 400)
                        +----+------+
                             |
                             v
                        +----------+
                        |  HASHED  |  (ubtl-canonical-json-v1 SHA-256 computed)
                        +----+-----+
                             |
       (Idempotency Conflict |
        different payload)   v
        [ REJECTED (409) ] <-+----> [ PERSISTED ] (Atomic DB commit)
                                           |
                                           v
                                   +----------------+
                                   | OUTBOX_PENDING | (HTTP 202 Accepted: status="pending")
                                   +-------+--------+
                                           |
                              (Outbox worker dispatches proposal)
                                           v
                                   +----------------+
                                   |   SUBMITTED    | (Proposal accepted: status="submitted")
                                   +-------+--------+
                                           |
                     +---------------------+---------------------+
                     |                     |                     |
        (Block commit verified)   (Peer rejected)         (Commit timeout)
                     v                     v                     v
              +-------------+       +--------------+      +-------------------------+
              |  COMMITTED  |       |    FAILED    |      | RECONCILIATION_REQUIRED |
              +------+------+       +--------------+      |    (status="timeout")   |
                     |                                    +-------------------------+
         (Cryptographic audit)
                     v
              +-------------+
              |  VERIFIED   | (status="confirmed")
              +-------------+
```

### Transaction State Mapping (Internal to External Switching Contract)

| Internal Lifecycle State | External Switching Status | HTTP API Code | Description |
| :--- | :--- | :--- | :--- |
| **`RECEIVED`** | `pending` | N/A (Internal) | Ingestion request accepted into memory buffer. |
| **`VALIDATED`** | `pending` | N/A (Internal) | Payload validated against transaction type schema. |
| **`HASHED`** | `pending` | N/A (Internal) | Canonical string and authoritative SHA-256 computed. |
| **`PERSISTED`** | `pending` | N/A (Internal) | Transaction record committed to relational database. |
| **`OUTBOX_PENDING`** | `pending` | **HTTP 202** | Initial acceptance committed; waiting for worker dispatch. |
| **`SUBMITTED`** | `submitted` | HTTP 200 | Peer proposal acknowledged; awaiting block inclusion. |
| **`COMMITTED`** | `confirmed` | HTTP 200 | Block inclusion verified (`blockNumber > 0`). |
| **`VERIFIED`** | `confirmed` | HTTP 200 | Payload hash matched against ledger commit proof. |
| **`REJECTED`** | `failed` | **HTTP 400 / 409** | Validation failure or idempotency conflict. |
| **`RETRY_PENDING`** | `pending` | HTTP 200 | Transient peer error; enqueued for worker retry. |
| **`FAILED`** | `failed` | HTTP 200 | Permanent rejection or consensus failure. |
| **`RECONCILIATION_REQUIRED`**| `timeout` | HTTP 200 | Proposal or commit timeout; flagged for reconciliation. |

---

## 2. Outbox Event Processing State Machine

The outbox queue is an autonomous state machine that processes events (`DISPATCH_LEDGER`, `VERIFY_COMMIT`, `DELIVER_WEBHOOK`) independently from transaction lifecycles.

```
                    +--------------------+
                    |      PENDING       | <------------------------------------+
                    +---------+----------+                                      |
                              |                                                 |
                   (Worker claims via lock)                                     |
                              |                                                 |
                              v                                                 |
                    +--------------------+                                      |
                    |     PROCESSING     |                                      |
                    +----+----------+----+                                      |
                         |          |                                           |
         (Success)       |          | (Transient failure /                      |
             v           |          |  attempts < maxAttempts)                  |
     +---------------+   |          v                                           |
     |   COMPLETED   | <-+  +--------------------+                              |
     +---------------+      |   RETRY_PENDING    |                              |
                            +---------+----------+                              |
                                      |                                         |
                                      +---(backoff timer expires: now >= next)--+
                                      |
                            (Permanent failure /
                             attempts >= maxAttempts)
                                      |
                                      v
                            +--------------------+
                            |    DEAD_LETTER     |
                            +--------------------+
```

### Outbox Transition Matrix

| From State | Event / Condition | To State | Action Taken |
| :--- | :--- | :--- | :--- |
| `PENDING` | Worker claim (`claimBatch`) | `PROCESSING` | Sets `lockedAt = now`, `lockedBy = workerId`, increments `attemptCount`. |
| `RETRY_PENDING` | Backoff elapsed & claimed | `PROCESSING` | Sets `lockedAt = now`, `lockedBy = workerId`, increments `attemptCount`. |
| `PROCESSING` | Operation succeeds | `COMPLETED` | Sets `processedAt = now`, clears `lockedAt` and `lockedBy`. |
| `PROCESSING` | Transient network failure (`attempts < maxAttempts`) | `RETRY_PENDING` | Sets `nextAttemptAt = now + backoffDelay`, records `lastErrorCode` and sanitized `lastError`. |
| `PROCESSING` | Permanent error (e.g. `VALIDATION_ERROR`) | `DEAD_LETTER` | Immediately moves to dead letter without retrying. |
| `PROCESSING` | Max attempts reached (`attempts >= maxAttempts`) | `DEAD_LETTER` | Sets `status = 'DEAD_LETTER'`, marks transaction `FAILED`. |
| `PROCESSING` | Worker crashes (`lockedAt < now - stuckTimeout`) | `RETRY_PENDING` | Stuck recovery resets lock if proposal not found on adapter. |
| `PROCESSING` | Worker crashes but proposal succeeded on adapter | `COMPLETED` | Stuck recovery advances tx to `submitted` and enqueues `VERIFY_COMMIT`. |

---

## 3. Discrepancy Prevention Invariants

1. **Transaction $\neq$ Outbox State**:
   A transaction being in `OUTBOX_PENDING` means the database has accepted the transaction and enqueued its outbox task. The outbox event status is `PENDING`.
2. **Never Conflate Submission with Ledger Commit**:
   A transaction whose proposal has been accepted by an endorsement peer transitions to `SUBMITTED`. It remains in `submitted` until `VERIFY_COMMIT` proves actual block inclusion on the ledger with a block number $> 0$.
3. **Decoupled Callbacks**:
   Switching webhook callbacks are scheduled as `DELIVER_WEBHOOK` outbox events. If downstream Switching webhook services fail or return HTTP 500, the `DELIVER_WEBHOOK` event enters `RETRY_PENDING`. The committed blockchain transaction is **never** rolled back.
