# Universal Blockchain Transaction Ledger (UBTL)
## Project Constitution & Engineering Principles

### 1. Purpose & Authority
The **Universal Blockchain Transaction Ledger (UBTL)** is an enterprise-grade, provider-neutral transaction ledger service. It bridges the Digital Switching system (`https://github.com/talentseeker64-lang/switching-revisi`) and underlying distributed ledger technologies (specifically Hyperledger Fabric managed by external network providers).

This Constitution establishes non-negotiable architectural axioms, security invariants, data integrity rules, and execution disciplines governing all UBTL code, schemas, documentation, and operational procedures.

---

### 2. Core Axioms

#### Axiom 1: Provider Neutrality
UBTL core domain logic must remain strictly decoupled from any single blockchain network provider, cloud vendor, or infrastructure host.
- The core application interfaces with distributed ledgers exclusively via the abstract `BlockchainAdapter` port.
- Local and test environments run in **Mock Mode** (`BLOCKCHAIN_ADAPTER_MODE=mock`) with zero provider dependencies or external network credentials.
- When configured for **Provider Mode** (`BLOCKCHAIN_ADAPTER_MODE=provider`), the application must validate all mandatory provider credentials and fail-fast at boot with clear diagnostics if any parameter is missing or malformed.
- Provider connection parameters, MSP IDs, channel topologies, and chaincode names are externalized to environment variables and provider contracts.

#### Axiom 2: Zero Silent Assumptions & Immutable Boundaries
- The Digital Switching repository (`talentseeker64-lang/switching-revisi`) is an external system of record and **must never be modified**.
- UBTL conforms strictly to the draft Gateway API specification in the Switching repository (`docs/api-contract.md`).
- Where the draft contract contains ambiguities or unfinalized decisions (such as mutual authentication, webhook HMAC signatures, or rate-limiting tiers), they must be explicitly documented as `UNRESOLVED INTEGRATION DECISION` and flagged for joint governance, never silently implemented with fabricated assumptions.

#### Axiom 3: Absolute Ledger Immutability & Non-Repudiation
- Ledger transactions are immutable once committed. UBTL never performs destructive updates or deletions on recorded transaction histories or audit entries.
- Every ingested payload is canonically serialized and hashed using versioned SHA-256 before ledger submission.
- The ledger stores cryptographic proofs:
  - `payloadHash`: SHA-256 of the canonically serialized payload.
  - `fabricTransactionId`: Transaction proposal identifier assigned by the Hyperledger Fabric client / peer.
  - `blockNumber`: Monotonically increasing ledger block height containing the committed transaction.
- The legacy Switching response field `blockchainTxHash` is maintained purely for contract backwards-compatibility and maps internally to `fabricTransactionId` (or format `fabricTxId:blockNumber`).

#### Axiom 4: Strict Separation of Off-Chain Payloads and On-Chain Hashes
- Sensitive business payloads, Personally Identifiable Information (PII), national identity numbers, medical data, and confidential commercial terms are **never stored on the public/permissioned distributed ledger state directly**.
- Only the cryptographic state anchor (`payloadHash`), transaction metadata, timestamp, organization IDs, and validation receipts are committed on-chain.
- Full payloads reside in encrypted, access-controlled off-chain relational storage (PostgreSQL).

#### Axiom 5: The Ledger Commit Verification Discipline
- **A transaction is NEVER marked `CONFIRMED` merely because a request was accepted, queued, or dispatched.**
- Ingestion returns HTTP `202 Accepted` with initial status `submitted`.
- Transition to `confirmed` occurs **only after cryptographic proof of ledger inclusion** is obtained from the blockchain network (successful block commit event or validated commit-status query).
- If the submission times out or unrecoverably fails, status transitions to `timeout` or `failed` with granular error codes.

#### Axiom 6: Guaranteed At-Least-Once Delivery via Transactional Outbox
- All asynchronous operations—including blockchain ledger dispatches and webhook callback deliveries to Switching—must use the **PostgreSQL Transactional Outbox Pattern**.
- State transitions and outbox events are written in the exact same atomic database transaction.
- Persistent workers poll the outbox table, execute dispatches with exponential backoff and jitter, and guarantee at-least-once delivery.
- Inbound endpoints enforce idempotency via client-supplied `idempotencyKey` and database unique constraints.

---

### 3. Roles and Responsibilities
- **Principal Software Architect**: Defines contracts, interfaces, and boundary guardrails; enforces provider neutrality.
- **Senior NestJS Engineer**: Implements modular, resilient backend services conforming to NestJS idiomatic patterns.
- **Hyperledger Fabric Integration Engineer**: Designs adapter implementations, Gateway SDK integration, gRPC client lifecycle, and commit status verifiers.
- **PostgreSQL Architect**: Architects relational schemas, Prisma data models, transactional outbox tables, indexing, and uniqueness constraints.
- **Application Security Engineer**: Audits authentication, RBAC, input sanitization, canonical hash algorithms, secret hygiene, and webhook signatures.
- **QA & Reliability Engineer**: Builds contract tests, unit/integration suites, fault-injection tests, and end-to-end verification workflows.

---

### 4. Code of Conduct for Incremental Delivery
1. Inspect available upstream contracts first and document explicit assumptions.
2. Build foundation documentation, schemas, and specifications before writing runtime business logic.
3. Keep scaffolding clean, modular, and testable at every intermediate milestone.
4. Never commit credentials, private keys, or certificates to version control.
5. All tests must be deterministic, self-contained, and run green without external cloud dependencies.
