# Universal Blockchain Transaction Ledger (UBTL)
## Product Requirements Document (PRD)

### 1. Executive Summary
The **Universal Blockchain Transaction Ledger (UBTL)** is an enterprise middleware service designed to anchor high-value financial, legal, and operational transactions to an immutable distributed ledger (Hyperledger Fabric) while maintaining sub-second API response times and robust provider neutrality.

UBTL acts as the dedicated Gateway layer consumed by the **Digital Switching** system (`switching-revisi`). Switching orchestrates high-throughput payment routing, partner transformations, and dispatching, while UBTL guarantees cryptographic non-repudiation, hash integrity, ledger commit verification, and automated callback notifications.

---

### 2. Stakeholders & Personas

| Persona | Role | Primary Goal |
| :--- | :--- | :--- |
| **Digital Switching System** | Upstream Caller / Ingestion Client | Submits transactions via HTTP API, expects fast HTTP 202, queries status, and consumes webhooks. |
| **Enterprise Auditor & Regulator** | Compliance Officer | Verifies transaction authenticity, compares raw payload hashes against ledger block proofs, and inspects non-repudiation trails. |
| **Ledger Node Operator** | Platform Engineer | Monitors ingestion queues, outbox lag, blockchain node latency, and reconciliation anomalies. |
| **External Network Provider** | Fabric Infrastructure Consortium | Operates peer nodes, orderer nodes, and channel infrastructure; supplies connectivity parameters. |

---

### 3. Business & Technical Objectives

1. **Sub-200ms Ingestion Latency (p99)**: Ingestion endpoint stores the transaction, computes canonical hash, queues blockchain dispatch via Transactional Outbox, and returns HTTP 202 without blocking on distributed ledger consensus.
2. **Provider Neutrality**: Seamlessly switch between local mock simulation and external managed Fabric networks without modifying application code.
3. **Zero Data Loss & At-Least-Once Delivery**: Transactional Outbox ensures all ledger submissions and webhook callbacks survive application crashes, network partitions, or peer downtime.
4. **Cryptographic Integrity**: SHA-256 canonical hashing across 7 standardized business transaction types (Sales, Loans, Tax Payments, Gold Purchases, Donations, Waqf, Land Documents).
5. **No False Confirmations**: Strict confirmation policy — status moves to `confirmed` only after verified inclusion in a committed Hyperledger Fabric block.

---

### 4. Scope & Functional Requirements

#### 4.1 Ingestion & Gateway API Compatibility
- **FR-01**: Provide `POST /v1/transactions` accepting `correlationId`, `idempotencyKey`, `transactionType`, and `payload`.
- **FR-02**: Enforce strict idempotency: identical `idempotencyKey` submissions return the previously issued `gatewayRequestId` and status without creating duplicate records.
- **FR-03**: Return HTTP `202 Accepted` with payload `{ "gatewayRequestId": "<uuid>", "status": "submitted" }`.
- **FR-04**: Provide `GET /v1/transactions/:gatewayRequestId` returning current lifecycle status, timestamps, `payloadHash`, `fabricTransactionId`, `blockNumber`, and legacy field `blockchainTxHash`.

#### 4.2 Canonicalization & Cryptographic Hashing
- **FR-05**: Implement the versioned `ubtl-canonical-json-v1` canonical serialization (based on RFC 8785 JCS principles; see `docs/hash-specification.md` for documented divergences).
- **FR-06**: Compute SHA-256 hash of canonicalized JSON.
- **FR-07**: Support versioned schemas for:
  1. `sales` (v1)
  2. `loans` (v1)
  3. `tax_payments` (v1)
  4. `gold_purchases` (v1)
  5. `donations` (v1)
  6. `waqf` (v1)
  7. `land_documents` (v1)
- **FR-08**: Ensure deterministic handling of Unicode (NFC), numbers/decimals, null values, and key sorting.

#### 4.3 Blockchain Ledger Adapter
- **FR-09**: Abstract ledger interactions behind the `BlockchainAdapter` interface (`submitProposal`, `queryCommitStatus`, `getTransactionRecord`, `healthCheck`).
- **FR-10**: Provide high-fidelity `MockBlockchainAdapter` for local development with configurable latency and error simulation.
- **FR-11**: Provide production-ready `FabricGatewayAdapter` implementing Hyperledger Fabric Gateway v2.4+/v2.5+ client specifications.
- **FR-12**: Enforce fail-fast startup validation when `BLOCKCHAIN_ADAPTER_MODE=provider` and required connection profiles are missing.

#### 4.4 Transactional Outbox & Background Workers
- **FR-13**: Persist ledger dispatch events to `outbox_events` table within the same ACID transaction as the transaction record.
- **FR-14**: Dedicated worker polls outbox events, dispatches to `BlockchainAdapter`, and updates transaction lifecycle to `pending`.
- **FR-15**: Verify commit status via event listeners or status queries before transitioning to `confirmed`.
- **FR-16**: Exponential backoff retry policy with jitter and max attempt limits.

#### 4.5 Webhook Delivery to Switching
- **FR-17**: Deliver asynchronous status notifications to `POST {SWITCHING_BASE_URL}/api/v1/webhooks/gateway`.
- **FR-18**: Support callback payload schema: `{ "gatewayRequestId", "correlationId", "status", "blockchainTxHash", "errorMessage" }`.
- **FR-19**: Deliver callbacks for states: `submitted`, `pending`, `confirmed`, `failed`, `timeout`.
- **FR-20**: Handle Switching response (`200 { received: true, applied: boolean }`) and record webhook audit logs.

#### 4.6 Reconciliation & Auditing
- **FR-21**: Automated periodic reconciliation job comparing internal database status against ledger block queries.
- **FR-22**: Flag discrepancies (mismatched hashes, uncommitted transactions, timeout mismatches) into `reconciliation_records`.
- **FR-23**: Provide full audit logging for all API requests, ledger submissions, and status transitions.

---

### 5. Non-Functional Requirements

- **Security**: Authenticate callers via `X-Api-Key` headers; support mutual TLS (mTLS) for production Fabric peer connections. Off-chain storage for sensitive payload data.
- **Reliability & Fault Tolerance**: Zero data loss across process crashes via transactional outbox.
- **Auditability**: Complete trace history of every status change with exact microsecond timestamps.
- **Performance**: Horizontal scaling of worker nodes using distributed advisory locks or optimistic concurrency.
