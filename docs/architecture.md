# Universal Blockchain Transaction Ledger (UBTL)
## Architecture & Technical Design

### 1. High-Level Architecture
UBTL sits between the **Digital Switching** system and external **Distributed Ledger Networks**. It is built on a clean hexagonal / ports-and-adapters architecture to guarantee that domain logic, hashing, and outbox state engines remain totally independent of external blockchain infrastructure.

```
       +-------------------------------------------------------------+
       |             Digital Switching System (Client)               |
       |             https://github.com/talentseeker64-lang/         |
       |             switching-revisi                                |
       +------------------------------+------------------------------+
                                      |
                      (HTTP Ingestion / Polling)
                      POST /v1/transactions
                      GET  /v1/transactions/:id
                                      v
       +-------------------------------------------------------------+
       |                     UBTL Gateway Boundary                   |
       |  +-------------------------+  +--------------------------+  |
       |  | Authentication / Guards |  | Request Validation Layer |  |
       |  +------------+------------+  +------------+-------------+  |
       |               |                            |                |
       |               v                            v                |
       |  +-------------------------------------------------------+  |
       |  | Ingestion Controller & Canonical Serializer (UBTL v1)   |  |
       |  +---------------------------+---------------------------+  |
       |                              |                              |
       |        Atomic ACID Write     v                              |
       |  +-------------------------------------------------------+  |
       |  | PostgreSQL Database                                   |  |
       |  |  * transactions (payload, status, payloadHash)        |  |
       |  |  * outbox_events (dispatch_ledger, send_webhook)     |  |
       |  |  * transaction_status_history                         |  |
       |  +---------------------------+---------------------------+  |
       |                              |                              |
       |       Transactional Outbox   | Polling / SKIP LOCKED        |
       |       Background Workers     v                              |
       |  +-------------------------------------------------------+  |
       |  | Outbox Processor & Retry Engine                       |  |
       |  +-------------+---------------------------+-------------+  |
       |                |                           |                |
       |  (Webhook)     v                           v (Ledger Port)  |
       |  +----------------------+      +-------------------------+  |
       |  | Webhook Dispatcher   |      | BlockchainAdapter Port  |  |
       |  +-----------+----------+      +------------+------------+  |
       |              |                              |               |
       +--------------|------------------------------|---------------+
                      |                              |
    POST /api/v1/     |                              | gRPC Gateway
    webhooks/gateway  |                              |
                      v                              v
           +--------------------+      +---------------------------+
           | Switching Webhook  |      | Managed Hyperledger       |
           | Receiver           |      | Fabric Provider Network   |
           +--------------------+      | (or Local Mock Adapter)   |
                                       +---------------------------+
```

---

### 2. Module Decomposition

UBTL is structured into clean, cohesive modules:

1. **`auth` (Authentication & Authorization)**:
   - Validates inbound API keys (`X-Api-Key`), IP whitelists, and client organization contexts.
   - Distinct guards for Gateway Ingestion, Operator Dashboard, and Webhook Receiver.

2. **`organizations` (Organizations & Source Systems)**:
   - Manages registered source systems (e.g., Digital Switching, Partner Financial Institutions).
   - Enforces multi-tenant isolation, authorization policies, and quota management.

3. **`gateway-compat` (Switching Gateway API Compatibility)**:
   - Strict implementation of the draft API contract expected by Switching.
   - `POST /v1/transactions` returning HTTP 202 `{ gatewayRequestId, status: "submitted" }`.
   - `GET /v1/transactions/:gatewayRequestId` returning current status and legacy `blockchainTxHash`.

4. **`transactions` (Transaction Ingestion & Lifecycle)**:
   - Ingestion coordinator, payload persistence, idempotency verification, and state transitions.
   - Manages historical audit snapshots in `transaction_status_history`.

5. **`canonicalization` (Canonicalization & Hashing)**:
   - Implements `ubtl-canonical-json-v1` (based on RFC 8785 JCS principles, with documented divergences — see `docs/hash-specification.md` §5).
   - Produces deterministic, collision-resistant SHA-256 hashes (`payloadHash`).
   - Houses versioned schema validators for all 7 transaction categories.

6. **`blockchain-adapter` (Blockchain Abstraction Port & Implementations)**:
   - `BlockchainAdapter` interface (the single port the domain depends on):
     - `submitProposal(input: BlockchainSubmissionInput): Promise<BlockchainSubmissionResult>`
     - `queryCommitStatus(fabricTxId: string): Promise<CommitStatusResult>`
     - `getTransactionProof(fabricTxId: string): Promise<LedgerProof | null>`
     - `healthCheck(): Promise<AdapterHealth>`
     - `findTransactionByIdempotencyKey?(gatewayRequestId: string): Promise<CommitStatusResult | null>` (optional reconciliation hook)
   - `MockBlockchainAdapter`: Local in-memory simulator with deterministic commit delay and chaos simulation. Emits only `simulated-*` identifiers.
   - `FabricGatewayAdapter`: Real Hyperledger Fabric Gateway client. Provider mode only.

   **SDK isolation (Axiom 1 — Provider Neutrality)**. No `@hyperledger/fabric-gateway`
   type crosses the adapter boundary. The dependency is confined to the
   `blockchain-adapter` module, where exactly one file imports the SDK:

   | File | Responsibility |
   | --- | --- |
   | `fabric-sdk.port.ts` | Structural declaration of the *minimal* verified SDK surface UBTL consumes. Imports no SDK. |
   | `fabric-gateway-connector.ts` | The **only** module that imports `@hyperledger/fabric-gateway` and `@grpc/grpc-js` (lazy dynamic `import()`). |
   | `fabric-credentials.ts` | Loads and PEM-validates TLS root / client cert / client key. Imports no SDK. |
   | `fabric-adapter.ts` | Implements `BlockchainAdapter` against the port. Imports no SDK. |

   Because the SDK sits behind an injectable port, the outbox worker, the domain
   and the tests never require a Fabric network — tests inject a deterministic
   in-process test double of `FabricGatewayConnector`.

   **Fail-fast, never fall back**. Provider mode validates all mandatory
   configuration before touching the filesystem or the SDK, and aborts with
   `FABRIC_GATEWAY_PROVIDER_FAIL_FAST` / `FABRIC_GATEWAY_CREDENTIAL_FAIL_FAST`
   / `FABRIC_GATEWAY_INIT_FAILED`. It never degrades to mock mode.

7. **`outbox` (Transactional Outbox & Workers)**:
   - Persistent worker processes polling `outbox_events` with `SELECT ... FOR UPDATE SKIP LOCKED`.
   - Guaranteed at-least-once delivery semantics for ledger commits and webhooks.
   - Exponential backoff with jitter and dead-letter queue (DLQ) support.

8. **`webhooks` (Webhook Delivery Service)**:
   - Formats and dispatches callbacks to `POST {SWITCHING_BASE_URL}/api/v1/webhooks/gateway`.
   - Handles timeout detection, HTTP connection pooling, and delivery audit records.

9. **`reconciliation` (Reconciliation Engine)**:
   - Scheduled job comparing internal database status against blockchain ledger state.
   - Flags discrepancies, orphan outbox jobs, and unconfirmed transactions for operator inspection.

10. **`audit` (Audit Logging & Compliance)**:
    - Immutable event logging of every API invocation, status mutation, and adapter response.

11. **`dashboard` (Verification & Management UI)**:
    - Interactive user interface and verification portal for inspecting transaction chains, testing canonical hashes, and validating ledger proofs.

---

### 3. Asynchronous Data Flow & Execution Sequences

#### Phase 1: Ingestion & Fast Acknowledgment
1. Switching sends `POST /v1/transactions` with `correlationId`, `idempotencyKey`, `transactionType`, and `payload`.
2. Auth Guard checks `X-Api-Key`.
3. Ingestion service checks `idempotencyKey` in repository:
   - If found with identical payload, returns existing `gatewayRequestId` and status immediately.
   - If found with different payload, returns `HTTP 409 Conflict`.
4. Payload is validated against the versioned JSON Schema for `transactionType`.
5. Canonical serializer formats payload per `ubtl-canonical-json-v1`; authoritative SHA-256 hash is calculated (`payloadHash`).
6. Single ACID transaction atomically creates:
   - `transactions` row (status: `PENDING`, lifecycleState: `OUTBOX_PENDING`, `payloadHash`, raw payload).
   - `transaction_status_history` row (transition: `NONE` -> `PENDING`).
   - `outbox_events` row (type: `DISPATCH_LEDGER`, status: `PENDING`, deduplicationKey: `dispatch:<id>`).
7. Returns HTTP `202 Accepted` to Switching with `{ "gatewayRequestId": "<uuid>", "status": "pending", "lifecycleState": "OUTBOX_PENDING" }`.

#### Phase 2: Ledger Dispatch Worker & Atomic Claiming
1. Outbox Worker atomically claims `DISPATCH_LEDGER` event via `SELECT ... FOR UPDATE SKIP LOCKED` (PostgreSQL) or mutex in-memory.
2. Commits claim transaction, marking event `PROCESSING` with worker identity and lock timestamp.
3. Invokes `blockchainAdapter.submitProposal()` outside of any open database transaction.
4. If proposal accepted by peers:
   - Transaction status updates from `pending` (`OUTBOX_PENDING`) to `submitted` (`SUBMITTED`).
   - Outbox event marked `COMPLETED`.
   - Enqueues `outbox_events` row (type: `VERIFY_COMMIT`).
   - Enqueues `outbox_events` row (type: `DELIVER_WEBHOOK`, status: `submitted`).
5. If timeout or ambiguous outcome:
   - Transaction status updates to `timeout` (`RECONCILIATION_REQUIRED`).
   - Reconciles with adapter via `findTransactionByIdempotencyKey`.

#### Phase 3: Ledger Commit Verification
1. Outbox Worker claims `VERIFY_COMMIT` event.
2. Invokes `blockchainAdapter.queryCommitStatus(fabricTxId)`.
3. If committed to block:
   - Transaction status moves to `confirmed` (`COMMITTED`).
   - Captures `blockNumber` (> 0) and commit timestamp.
   - Enqueues `outbox_events` row (type: `DELIVER_WEBHOOK`, status: `confirmed`, `blockchainTxHash`: `fabricTransactionId`).
4. If peer rejected endorsement:
   - Transaction status moves to `failed` (`FAILED`) with specific `errorCode` and `errorMessage`.
   - Enqueues webhook delivery with status `failed`.
5. If block pending:
   - Re-enqueues for next polling cycle with backoff.

#### Phase 4: Webhook Delivery to Switching
1. Webhook Outbox Worker picks up `DELIVER_WEBHOOK` event.
2. Formats payload matching Switching draft contract:
   `{ gatewayRequestId, correlationId, status, blockchainTxHash, errorMessage }`.
3. Sends `POST {SWITCHING_BASE_URL}/api/v1/webhooks/gateway` with header `X-Api-Key: <SWITCHING_WEBHOOK_API_KEY>`.
4. Webhook failures are retried independently and **never roll back a committed ledger transaction**.
5. Outbox record marked `COMPLETED`.

---

### 4. Fabric Adapter: Submission, Commit Verification & Reconciliation

#### 4.1 Submission is not a commit
`FabricGatewayAdapter.submitProposal()` performs the Fabric Gateway
proposal → endorse → submit sequence and returns
`{ accepted: true, status: 'PENDING', fabricTransactionId }`.

`PENDING` here means *the endorsed transaction was accepted by the ordering
service*. It is **not** a commit. `submitProposal()` never returns
`CONFIRMED`, never returns a block number, and never attaches a commit
timestamp.

#### 4.2 What evidence the SDK actually provides
The Fabric Gateway client protocol provides commit status **only** through the
`Commit.getStatus()` handle attached to the `SubmittedTransaction` returned by
`submit()` **in the same process**:

| Evidence | Source | Meaning |
| --- | --- | --- |
| `Status.successful === true` and `Status.blockNumber > 0` | `Commit.getStatus()` from the in-process `SubmittedTransaction` | Definitive, verified commit |
| `Status.successful === false` | same | Definitive *unsuccessful* commit (validation code preserved) |
| Deadline expiry / deadline exceeded (gRPC status 4) | same | **Ambiguous** — outcome unknown |
| No `SubmittedTransaction` handle (e.g. after a process restart) | — | No native lookup exists |

The client protocol has **no `query commit status by transaction ID` RPC**.
`Commit.getStatus()` cannot be reconstructed for an arbitrary transaction ID.

#### 4.3 Documented reconciliation strategy (explicitly NOT a native Fabric capability)
Because the protocol exposes no commit-status-by-ID lookup, UBTL defines its own
two-tier strategy:

1. **Fast path (same process).** A process-local `Map<fabricTransactionId,
   CommitHandle>` is populated by `submitProposal()` and consulted by
   `queryCommitStatus()`. It is volatile and is intentionally cleared once a
   terminal status is observed.
2. **Fallback (post-restart).** An explicitly UBTL-defined, read-only chaincode
   query (`GetCommitProof` / `QueryTransactionByRequestId`) keyed on the durable
   UBTL metadata (`payloadHash`, `gatewayRequestId`, `idempotencyKey`,
   `fabricTransactionId`). This requires a **deployed UBTL chaincode** and relies
   on read-your-write semantics.

If neither tier yields evidence, the adapter reports `PENDING` with
`errorCode: 'COMMIT_EVIDENCE_UNAVAILABLE'`. It never guesses `CONFIRMED` or
`FAILED`. See `docs/provider-requirements.md` §3.6–3.7 for the provider-facing
contract.

#### 4.4 Commit discipline (Axiom 5)
Only verified commit evidence may transition a transaction to
`COMMITTED`/`confirmed`, and the lifecycle guard additionally requires
`blockNumber > 0`.

| Adapter outcome | Lifecycle effect |
| --- | --- |
| `PENDING` (submitted) | `SUBMITTED` / `submitted` |
| `CONFIRMED` (successful + block > 0) | `COMMITTED` / `confirmed` |
| `FAILED` (unsuccessful commit or permanent rejection) | `FAILED` / `failed` |
| `TIMEOUT` (ambiguous) | `RECONCILIATION_REQUIRED` / `timeout` |
| Thrown `AMBIGUOUS` error | `RECONCILIATION_REQUIRED`, event retained for reconciliation |
| Thrown `TRANSIENT` error | Retried with exponential backoff + bounded jitter |
| Thrown `PERMANENT` error | Dead-lettered; transaction marked `failed` |

Recovery never blindly resubmits an ambiguously completed operation: the stuck
event and ambiguous-submission paths consult
`findTransactionByIdempotencyKey()` first and adopt the existing
`fabricTransactionId` if the operation already reached the ledger. Retries
always reuse the original `gatewayRequestId` and `idempotencyKey`.

Webhook delivery is decoupled from ledger processing; a webhook delivery failure
does not and cannot reverse a confirmed ledger commit.

#### 4.5 Provider error classification
`FabricGatewayAdapter` maps provider/gRPC failures onto the same taxonomy the
outbox worker uses, so re-thrown adapter errors classify identically:

| Provider signal | UBTL classification | Code |
| --- | --- | --- |
| gRPC 4 / `DEADLINE_EXCEEDED` / timeout text | AMBIGUOUS | `COMMIT_TIMEOUT` |
| gRPC 3 / 9 / 7 / 16, `INVALID_ARGUMENT`, `ENDORSEMENT_POLICY_FAILURE` | PERMANENT | `ENDORSEMENT_POLICY_FAILURE` |
| anything else (e.g. gRPC 14 `UNAVAILABLE`, connection reset) | TRANSIENT | `FABRIC_PROVIDER_TRANSIENT_ERROR` |

Surfaced messages are sanitized (secrets/tokens redacted, length capped at 300
characters) before they can be logged or persisted.

#### 4.6 Health reporting honesty
`healthCheck()` returns `status: 'degraded'` once the client is constructed and
`'offline'` otherwise, with `isSimulated: false`, `currentBlockHeight: 0` and
`latencyMs: 0`. The Fabric Gateway client connects lazily and `initialize()`
performs no live round trip, so UBTL does not claim `online` and does not
fabricate a block height or latency.

