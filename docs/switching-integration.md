# Universal Blockchain Transaction Ledger (UBTL)
## Digital Switching Integration Specification

### 1. Context & Purpose
This document captures the integration interface between **Universal Blockchain Transaction Ledger (UBTL)** and the **Digital Switching** system located at `https://github.com/talentseeker64-lang/switching-revisi`.

Per UBTL Project Constitution Axiom 2, the Switching repository is an external, unmodifiable upstream caller. UBTL must fulfill the draft contract specified in `switching-revisi/docs/api-contract.md` §4 ("Blockchain Gateway Integration Contract — DRAFT, pending joint finalization with the Gateway team").

---

### 2. Analysis of the Switching Draft Contract

In `switching-revisi/docs/api-contract.md` §4, the Switching team documented the following baseline behavior:

1. **Submission Endpoint**:
   - `POST {GATEWAY_BASE_URL}/v1/transactions`
   - Headers: `X-Api-Key`, `X-Correlation-Id`, `Idempotency-Key`
   - Body: `{ correlationId: string, idempotencyKey: string, transactionType: string, payload: { } }`
   - Response: `HTTP 202 { gatewayRequestId: string, status: "submitted" }`

2. **Query Status Endpoint**:
   - `GET {GATEWAY_BASE_URL}/v1/transactions/{gatewayRequestId}`
   - Response: `HTTP 200 { gatewayRequestId: string, status: "submitted"|"pending"|"confirmed"|"failed"|"timeout", blockchainTxHash: string|null, errorMessage: string|null }`

3. **Inbound Webhook Callback**:
   - `POST {SWITCHING_BASE_URL}/api/v1/webhooks/gateway`
   - Headers: `X-Api-Key` (`GATEWAY_WEBHOOK_API_KEY`)
   - Body: `{ gatewayRequestId, correlationId, status, blockchainTxHash, errorMessage }`
   - Switching Response: `HTTP 200 { received: true, applied: boolean }`
   - Switching design rule: Switching's webhook endpoint **never returns 404**; if `gatewayRequestId` is unknown on Switching's side, it logs the event and returns `{ received: true, applied: false }`.

4. **Switching Polling & Timeout Mechanisms**:
   - Switching dispatches transactions synchronously, moving to `TIMEOUT` if the Gateway response exceeds `GATEWAY_TIMEOUT_MS`.
   - Switching has a retry queue polling every 5s with backoff up to `RETRY_MAX_ATTEMPTS`.
   - Switching runs a stuck-transaction scanner every 10s.
   - Switching polls `GET /v1/transactions/{gatewayRequestId}` every 5s for pending transactions as a safety net alongside webhooks. Whichever arrives first wins.

---

### 3. Confirmed Architectural Decisions & Alignments

| Item | Switching Baseline | UBTL Implementation | Status |
| :--- | :--- | :--- | :--- |
| **Ingestion Route** | `POST /v1/transactions` | Implemented in `GatewayCompatController` | Confirmed |
| **Ingestion Status Code** | HTTP 202 Accepted | Returns HTTP 202 with `{ gatewayRequestId, status: "pending", lifecycleState: "OUTBOX_PENDING" }` | Confirmed |
| **Status Polling Route** | `GET /v1/transactions/:id` | Implemented in `GatewayCompatController` | Confirmed |
| **Callback Endpoint** | `POST {SWITCHING_BASE_URL}/api/v1/webhooks/gateway` | Outbox worker dispatches to this exact URI via decoupled `DELIVER_WEBHOOK` event | Confirmed |
| **Lifecycle Statuses** | `submitted`, `pending`, `confirmed`, `failed`, `timeout` | 100% alignment in UBTL state machine (`pending` -> `submitted` -> `confirmed`) | Confirmed |
| **Legacy Field Compatibility**| `blockchainTxHash` | Populated in response with `fabricTransactionId` (or `null`) | Confirmed |
| **Internal Decoupling** | N/A | UBTL maintains separate internal fields: `payloadHash`, `fabricTransactionId`, `blockNumber` | Confirmed |

---

### 4. Unresolved Integration Decisions (Open Flagged Items)

Per the master task operating rules, we document unresolved items without inventing arbitrary fixes:

#### DECISION REQUIRED 01: Authentication Protocol for Production
- **Current Draft**: Simple header `X-Api-Key: <TOKEN>` in both directions.
- **Limitation**: Insufficient for high-value financial settlements between distinct legal entities.
- **Proposed Alternatives for Joint Session**:
  1. Mutual TLS (mTLS) with client certificates issued by a mutually trusted Root CA.
  2. OAuth 2.0 Client Credentials Grant (RFC 6749) with short-lived JWTs.
- **Interim Action in UBTL**: Enforce `X-Api-Key` matching `UBTL_API_KEY` for inbound calls, and send `SWITCHING_WEBHOOK_API_KEY` for outbound callbacks, while preparing mTLS configuration hooks.

#### DECISION REQUIRED 02: Webhook HMAC Signature & Non-Repudiation
- **Current Draft**: Switching draft contract does not specify a signature header on incoming webhooks.
- **Risk**: A network adversary or misconfigured proxy could forge status callbacks (e.g. spoofing a `confirmed` status).
- **Recommendation for Joint Session**: Introduce `X-UBTL-Signature: sha256=<HMAC_HEX>` header using a shared webhook secret, timestamp validation (`X-UBTL-Timestamp`), and replay prevention.
- **Interim Action in UBTL**: Deliver payload with standard `X-Api-Key` header, optionally appending `X-UBTL-Signature` without breaking Switching's parser.

#### DECISION REQUIRED 03: Switching Polling vs Webhook Race Condition
- **Observation**: Switching runs a 5-second polling loop alongside listening for webhooks.
- **Risk**: Both webhook and poll response may arrive at Switching simultaneously.
- **Mitigation**: Switching's internal handler must use optimistic concurrency or transactional row locks. UBTL guarantees that once a transaction reaches a terminal state (`confirmed`, `failed`), all subsequent queries return the exact same terminal state.

#### DECISION REQUIRED 04: Standardized Business Payload Schemas
- **Current Draft**: Switching contract defines `payload: { }` as an unconstrained generic JSON object.
- **UBTL Requirement**: To compute deterministic cryptographic hashes, UBTL defines versioned schemas for 7 key domains (Sales, Loans, Tax Payments, Gold Purchases, Donations, Waqf, Land Documents).
- **Interim Action in UBTL**: If `transactionType` matches one of the 7 schemas, UBTL validates required fields and computes the `ubtl-canonical-json-v1` canonical hash. If an unclassified or custom type is submitted, UBTL serializes the object using `ubtl-canonical-json-v1` rules and records schema version as `custom-v1`.

---

### 5. Outbound Webhook Delivery Contract (UBTL -> Switching)

This section documents what UBTL **actually sends** in Prompt 04. It is a faithful
description of the implemented dispatcher, not a proposed future contract.

#### 5.1 Request shape

```http
POST {SWITCHING_BASE_URL}{SWITCHING_WEBHOOK_ENDPOINT}   # default: /api/v1/webhooks/gateway
Content-Type: application/json
X-Api-Key: {SWITCHING_WEBHOOK_API_KEY}
X-Correlation-Id: {correlationId}
x-gateway-signature: {hmac-sha256-hex}      # only when SWITCHING_WEBHOOK_SIGNING_SECRET is set
x-gateway-timestamp: {epoch-ms}             # only when SWITCHING_WEBHOOK_SIGNING_SECRET is set
```

```json
{
  "gatewayRequestId": "…",
  "correlationId": "…",
  "status": "submitted | pending | confirmed | failed | timeout",
  "blockchainTxHash": "… | null",
  "errorMessage": "… | null"
}
```

- `SWITCHING_WEBHOOK_ENDPOINT` is configurable; the default `/api/v1/webhooks/gateway`
  matches the Switching draft contract.
- The connection/request timeout is `SWITCHING_WEBHOOK_TIMEOUT_MS` (default `5000`),
  enforced with an `AbortSignal.timeout()` per attempt.
- `blockchainTxHash` carries the UBTL `fabricTransactionId` (provider transaction
  ID) or `null`. **It is never the SHA-256 payload hash.** See §6.

#### 5.2 Delivery semantics — at-least-once, receiver-side idempotency

UBTL does **not** promise exactly-once webhook delivery. It guarantees
**at-least-once** delivery and requires the Switching receiver to deduplicate:

- Retries preserve the same logical event identity — `gatewayRequestId` (+ `correlationId`)
  and terminal `status` are byte-identical across every attempt.
- A callback may be delivered more than once (e.g. UBTL times out waiting for the
  HTTP response after Switching already applied it). The receiver must key
  idempotency on `(gatewayRequestId, status)` and treat re-application as a no-op
  (`{ received: true, applied: false }`).
- A webhook failure **never** rolls back or reverses a confirmed ledger commit.

#### 5.3 Delivery outcome classification & retry policy

Each attempt is classified and routed through the shared outbox retry policy
(bounded exponential backoff + jitter):

| Outcome | Classification | Action |
| :--- | :--- | :--- |
| HTTP 2xx | success | Mark `DELIVER_WEBHOOK` event `COMPLETED`. |
| HTTP 5xx, 408, 425, 429 | `TRANSIENT` | Retry with backoff until `SWITCHING_WEBHOOK_MAX_RETRIES`. |
| Other HTTP 4xx | `PERMANENT` | Do **not** retry indefinitely; the event is dead-lettered and surfaced for operator review. |
| Connection failure (`ECONNREFUSED`/`ECONNRESET`/`ENOTFOUND`/…) | `TRANSIENT` | Retry with backoff. |
| Client timeout (`AbortSignal.timeout`) | `AMBIGUOUS` | The receiver may already have applied it. Retry is safe only because delivery is at-least-once and the receiver deduplicates. |

- Exhausted retries produce the documented dead-letter behavior (`DEAD_LETTER`).
- Only the **delivery state** of the webhook event changes on failure; ledger commit
  state is never touched.
- Stuck `DELIVER_WEBHOOK` events (a worker crashed mid-delivery) are safely
  reclaimable because webhook delivery is idempotent at the receiver; recovery
  records an audit event (`STUCK_WEBHOOK_EVENT_RECOVERED`) and never touches
  ledger state.

#### 5.4 Duplicate-prevention of the *initial* event

The initial `DELIVER_WEBHOOK` event is guarded by a durable deduplication
constraint on ``webhook:${status}:${transactionId}`` (unique
`deduplicationKey`). Re-triggering the same logical transition cannot create a
second initial event. Retries reuse the **same** event record/id.

#### 5.5 Secret hygiene

- Credentials, `X-Api-Key` values, Bearer tokens and credential-shaped
  substrings are redacted from all webhook logs, audit metadata and API responses
  (`redactSecrets` / `sanitizeForLog`).
- Raw transaction payloads are never sent to Switching and never logged by the
  dispatcher.
- Upstream response bodies are sanitized before being persisted to the audit
  trail and are never returned verbatim by an API.

---

### 6. Terminology Guard: Payload Hash vs. Fabric Transaction ID

These three values are distinct and must not be conflated:

| Value | Meaning | Where it appears |
| :--- | :--- | :--- |
| `payloadHash` | SHA-256 digest of the `ubtl-canonical-json-v1` canonical form of the business payload. | Off-chain ledger record; on-chain anchor argument. |
| `fabricTransactionId` | Provider-assigned Hyperledger Fabric transaction ID returned by proposal submission. | `GET /v1/transactions/:id` (`fabricTransactionId`); surfaced to Switching as `blockchainTxHash`. |
| `blockNumber` | Ledger block height of the committed transaction (must be `> 0` per Axiom 5). | `GET /v1/transactions/:id` (`blockNumber`). |

A `blockchainTxHash` value in a callback is **not** a payload hash and does not,
by itself, prove a commit. Switching must treat `status: "confirmed"` as the
authoritative commit signal.

---

### 7. Unresolved Integration Contract Items (carried forward, not closed by Prompt 05)

The following remain **open** and are **not** silently resolved by the Prompt 05
implementation.

1. **Authentication protocol for production** (see DECISION 01) — UBTL currently
   sends the shared header `X-Api-Key: {SWITCHING_WEBHOOK_API_KEY}`. Mutual TLS
   or OAuth 2.0 client-credentials is **not** implemented.
2. **Webhook HMAC signature & non-repudiation** (see DECISION 02) — a joint
   convention now exists (see §8) and is implemented as **optional** in both
   directions. Signing/verification is **enabled only when the shared secrets are
   configured**; it is not mandatory in any environment yet, and
   `SWITCHING_OUTBOUND_SIGNATURE_REQUIRED` / Switching's
   `GATEWAY_WEBHOOK_SIGNATURE_REQUIRED` default to **not enforced**.
3. **Inbound callback authentication for the `POST /api/v1/webhooks/gateway`
   direction** — implemented in the Switching repository's
   `GatewayWebhookGuard` (Layer 1 `X-Api-Key`, Layer 2 HMAC). UBTL does not own
   this endpoint; production enforcement is a Switching deployment decision that
   remains **unverified** end-to-end.
4. **Producer-side webhook delivery receipt** — Switching's response
   `{ received, applied }` is recorded only as a sanitized audit metadata field.
   Whether UBTL should act on `applied: false` (e.g. escalate) is **undecided** and
   **not implemented**.
5. **Cross-application live verification** — all Prompt 05 integration tests use
   in-process test doubles. The real Switching backend (`D:\switching-main`) has no
   installed `node_modules`/`.env`, so a real cross-application run was **NOT
   EXECUTED**. See §9.

Until the above are jointly closed, treat callback integrity as
**at-least-once with receiver-side idempotency plus optional HMAC**, and do not
assume non-repudiation.

---

### 8. Jointly Agreed Signature Contract (Prompt 05)

Per Prompt 05's requirement to **jointly document the agreed contract before
implementing authentication**, the following convention was adopted (it is
Switching's existing one — no new header names or signature formats were
introduced).

#### 8.1 Canonical signing string

Both directions compute `HMAC-SHA256(secret, `${timestamp}.${rawBody}`)` and
hex-encode the digest, where:
- `timestamp` is epoch **milliseconds** as a decimal string;
- `rawBody` is the **exact received byte string** of the JSON body (captured
  before parsing, not a re-serialization).

Comparison is **constant-time**. A timestamp outside the tolerance window
(`SIGNATURE_TOLERANCE_MS`, default `300000` ms) is rejected — replay protection.

#### 8.2 Header convention

| Direction | Signature header | Timestamp header | Secret (UBTL env) | Secret (Switching env) |
| :--- | :--- | :--- | :--- | :--- |
| Switching → UBTL (submit) | `x-switching-signature` | `x-switching-timestamp` | `SWITCHING_OUTBOUND_SIGNING_SECRET` | `GATEWAY_OUTBOUND_SHARED_SECRET` |
| UBTL → Switching (callback) | `x-gateway-signature` | `x-gateway-timestamp` | `SWITCHING_WEBHOOK_SIGNING_SECRET` | `GATEWAY_WEBHOOK_SHARED_SECRET` |

The two secrets are independent and are configured on both sides with the same
value per direction.

#### 8.3 Enforcement

- **UBTL inbound**: `SWITCHING_OUTBOUND_SIGNATURE_REQUIRED=true` rejects invalid
  or missing signatures with `401 INVALID_SIGNATURE`; `false` = verify-if-present
  (graceful rollout), accepted requests report `signatureVerified: false`. UBTL
  **fails fast at startup** if enforcement is enabled without a secret.
- **Switching inbound**: `GATEWAY_WEBHOOK_SIGNATURE_REQUIRED=true` in Switching's
  `GatewayWebhookGuard`; when the shared secret is empty the layer is skipped.

#### 8.4 Idempotency & order guarantees (both sides)

- Retries **preserve** the logical event identity: `gatewayRequestId`,
  `correlationId`, and the idempotency key are byte-identical across attempts. The
  signature **timestamp is regenerated per attempt** (fresh replay window) while
  the signed body is unchanged.
- The receiver must deduplicate on `(gatewayRequestId, status)`; a repeated
  callback returns `{ received: true, applied: false }` and performs no second
  business transition.
- Terminal states are immutable; an out-of-order (lower-precedence) status must
  not overwrite a higher one.

---

### 9. Cross-Application Verification Status (Prompt 05, updated after Prompt 06)

| Item | Status |
| :--- | :--- |
| Automated integration tests | **EXECUTED** — in-process test doubles (Simulated Switching receiver). Labeled simulated; no real network. |
| Real cross-application run (`D:\switching-main` ↔ UBTL) | **NOT EXECUTED** — Switching `node_modules`/`.env` absent; both apps and PostgreSQL/Fabric dependencies not simultaneously runnable. |
| R-1 PostgreSQL live concurrency | **EXECUTED — PASS** (Prompt 06 follow-up) — `TC-PG-01..06` run twice against live PostgreSQL (Neon) on a clean database: 6 passed, 0 failed each (exit `0`). |
| R-2 `prisma migrate diff` | **EXECUTED — PASS** (Prompt 06 follow-up) — `--from-url` (live DB) and `--from-migrations` (shadow DB) both print `-- This is an empty migration.` (exit `0`); a real index-name drift was found and fixed non-destructively with `map:`. |
| Restart recovery against a durable store | **EXECUTED at the persistence layer** — a two-process probe against live PostgreSQL reclaimed a crashed worker's stale lease across a real process restart and did not fabricate commit evidence. End-to-end restart with a live chaincode remains **NOT EXECUTED**. |
| Live Hyperledger Fabric integration | **NOT EXECUTED** |
| Cross-restart reconciliation | Depends on the deployed and verified UBTL chaincode query — **NOT VERIFIED** |
| Multi-worker reconciliation coordination | Requires durable coordination (DB lock) beyond the current single-process guard — **NOT IMPLEMENTED** |
