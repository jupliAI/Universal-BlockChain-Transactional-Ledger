# Universal Blockchain Transaction Ledger (UBTL)

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/Status-Provider--Neutral_Foundation-green.svg)](#)
[![Fabric Gateway](https://img.shields.io/badge/Hyperledger_Fabric-Gateway_v2.5+-orange.svg)](#)

> **Universal Blockchain Transaction Ledger (UBTL)** is an enterprise-grade, provider-neutral transaction ledger service. It anchors high-value transactions to Hyperledger Fabric networks with sub-second API ingestion, RFC 8785 canonical SHA-256 cryptographic hashing, a transactional outbox guarantee, and strict API compatibility with the Digital Switching system (`https://github.com/talentseeker64-lang/switching-revisi`).

---

## 1. Key Capabilities & Architectural Disciplines

- **Provider Neutrality**: Seamlessly runs locally in **Mock Mode** (`BLOCKCHAIN_ADAPTER_MODE=mock`) with zero external network dependencies, or in **Provider Mode** (`BLOCKCHAIN_ADAPTER_MODE=provider`) interfacing with managed Hyperledger Fabric consortia.
- **Switching Compatibility**: Implements the draft Blockchain Gateway API in `switching-revisi/docs/api-contract.md`:
  - `POST /v1/transactions` (Returns HTTP 202 `{ gatewayRequestId, status: "submitted" }`).
  - `GET /v1/transactions/:gatewayRequestId` (Returns lifecycle status and legacy `blockchainTxHash`).
  - Delivers asynchronous webhooks to `POST {SWITCHING_BASE_URL}/api/v1/webhooks/gateway`.
- **Deterministic Canonical Hashing**: Full implementation of RFC 8785 (JSON Canonicalization Scheme) with Unicode NFC normalization, explicit null handling, decimal string representation, and SHA-256 hex digest calculation.
- **Commit Verification Discipline**: Strict prohibition against pre-emptive confirmations. A transaction is marked `CONFIRMED` only after cryptographic proof of ledger block commit.
- **Guaranteed At-Least-Once Delivery**: PostgreSQL Transactional Outbox pattern with `SKIP LOCKED` polling, exponential backoff, and dead-letter queues.
- **Off-Chain Privacy**: Plaintext payloads and sensitive business details stay in off-chain relational storage; only mathematical state anchors (`payloadHash`) are committed on-chain.

---

## 2. Documentation Suite

Comprehensive architecture, security, and integration documentation is available in the `docs/` directory:

| Document | Description |
| :--- | :--- |
| **[`PROJECT_CONSTITUTION.md`](./PROJECT_CONSTITUTION.md)** | Core engineering axioms, security invariants, and boundary rules. |
| **[`docs/PRD.md`](./docs/PRD.md)** | Product Requirements Document: stakeholders, requirements, and SLAs. |
| **[`docs/architecture.md`](./docs/architecture.md)** | High-level system architecture, module boundaries, and async execution flows. |
| **[`docs/data-model.md`](./docs/data-model.md)** | PostgreSQL + Prisma schema, entity diagrams, and index optimization. |
| **[`docs/api-contract.md`](./docs/api-contract.md)** | Full OpenAPI 3.1 contract for Gateway ingestion, status, webhooks, and health. |
| **[`docs/switching-integration.md`](./docs/switching-integration.md)** | Integration analysis of `switching-revisi`, confirmed assumptions & unresolved decisions. |
| **[`docs/hash-specification.md`](./docs/hash-specification.md)** | RFC 8785 JCS rules and versioned schemas (Sales, Loans, Tax, Gold, Waqf, Land). |
| **[`docs/state-machine.md`](./docs/state-machine.md)** | Transaction lifecycle state machine, transition guards, and retry rules. |
| **[`docs/security.md`](./docs/security.md)** | STRIDE threat model, tamper detection, mTLS, and non-repudiation. |
| **[`docs/provider-requirements.md`](./docs/provider-requirements.md)** | Technical specification for external Hyperledger Fabric network providers. |
| **[`docs/testing-strategy.md`](./docs/testing-strategy.md)** | Test pyramid: unit, integration, contract, and E2E verification suites. |
| **[`docs/deployment.md`](./docs/deployment.md)** | Docker Compose local setup, Kubernetes manifests, and PgBouncer runbook. |

---

## 3. Quickstart (Local Development)

### Prerequisites
- Node.js 20+ / 22+
- npm or yarn

### 1. Configure Environment
Copy the example environment configuration:
```bash
cp .env.example .env
```
By default, `BLOCKCHAIN_ADAPTER_MODE="mock"` is enabled, allowing full local execution without external blockchain credentials.

### 2. Install Dependencies
```bash
npm install
```

### 3. Start Development Server
```bash
npm run dev
```
The server starts on port `3000` with:
- Full Gateway API endpoints (`POST /v1/transactions`, `GET /v1/transactions/:id`).
- Health endpoint (`GET /v1/health`).
- Interactive UBTL Verification Portal & Visual Dashboard at `http://localhost:3000`.

---

## 4. Switching Gateway API Quick Reference

### Ingestion Request
```bash
curl -X POST http://localhost:3000/v1/transactions \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: ubtl_dev_key_secret_switch_2026" \
  -d '{
    "correlationId": "corr-sales-001",
    "idempotencyKey": "idemp-sales-001",
    "transactionType": "SALES",
    "payload": {
      "orderId": "ORD-9901",
      "buyerId": "BUYER-1",
      "sellerId": "MERCHANT-8",
      "amount": "1500000.00",
      "currency": "IDR",
      "items": [{"sku": "GOLD-1G", "quantity": 1, "unitPrice": "1500000.00"}],
      "timestamp": "2026-10-23T18:30:00.000Z"
    }
  }'
```

**Response (`202 Accepted`)**:
```json
{
  "gatewayRequestId": "a3b8e8f2-91e2-4f74-8b54-1b48b9415662",
  "status": "submitted"
}
```

### Query Status
```bash
curl -X GET http://localhost:3000/v1/transactions/a3b8e8f2-91e2-4f74-8b54-1b48b9415662 \
  -H "X-Api-Key: ubtl_dev_key_secret_switch_2026"
```

---

## 5. Implementation Status (Roadmap)
1. **Prompt 01**: Ingestion & Canonical Hashing Module (controllers, `ubtl-canonical-json-v1` canonicalizer, schema validators, golden test vectors). — **DONE**
2. **Prompt 02**: PostgreSQL Transactional Outbox & Background Worker Engine (Atomic transactions, `SKIP LOCKED` polling, backoff with jitter). — **DONE**
3. **Prompt 03**: Blockchain Adapter Layer (Mock adapter with simulated consensus latency; Hyperledger Fabric Gateway provider adapter with commit verification and documented reconciliation). — **DONE** (Fabric adapter verified against an in-process SDK test double only; live Fabric integration NOT EXECUTED).
4. **Prompt 04**: Switching Webhook Dispatcher & Reconciliation Job (Decoupled `DELIVER_WEBHOOK` outbox event with classified retry/dead-letter policy; bounded, observable reconciliation job for `RECONCILIATION_REQUIRED`). — **DONE** (webhook delivery and reconciliation verified against in-process test doubles only; **no live Switching or live Fabric network was contacted**. See `docs/testing-strategy.md` §4.)

> Canonicalization note: UBTL uses **`ubtl-canonical-json-v1`** (NFC normalization
> before UTF-16 key sorting), which **diverges from RFC 8785/JCS**. See
> [`docs/hash-specification.md`](./docs/hash-specification.md).
