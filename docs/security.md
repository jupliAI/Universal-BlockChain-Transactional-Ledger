# Universal Blockchain Transaction Ledger (UBTL)
## Application Security & Non-Repudiation Architecture

### 1. Security Architecture Principles
UBTL is architected for defense-in-depth, strict zero-trust boundary validation, and immutable auditability:
- **Zero Raw PII on Ledger**: Distributed ledger states are immutable and shared across consortium nodes; full plaintext identities, tax IDs, and confidential amounts must never be broadcast onto chaincode state.
- **Cryptographic State Anchoring**: Off-chain databases store the detailed record; the blockchain anchors only the immutable SHA-256 fingerprint (`payloadHash`), transaction ID, and timestamp.
- **Mutual Authentication**: Ingress and egress network traffic must be authenticated and encrypted using modern cryptographic protocols.

---

### 2. STRIDE Threat Model & Mitigations

| Threat Category | Potential Attack Vector | UBTL Architectural Defense |
| :--- | :--- | :--- |
| **Spoofing** | Attacker impersonates Switching or calls `/v1/transactions` unauthorized. | Mandatory `X-Api-Key` guard; IP whitelisting; mutual TLS (mTLS) in production environments. |
| **Tampering** | Rogue DBA or compromised server alters payload in PostgreSQL database. | **Tamper Detection**: On-the-fly verification recomputes the `ubtl-canonical-json-v1` canonical hash. Any modification breaks equality with the on-chain anchored `payloadHash`. |
| **Repudiation** | Partner or Switching claims a transaction was never submitted or had different contents. | Client-supplied `idempotencyKey`, canonical `payloadHash`, monotonically increasing `blockNumber`, and signed Fabric proposal receipts provide mathematical non-repudiation. |
| **Information Disclosure** | Competitor reads consortium ledger to observe trading volume or customer names. | Sensitive payload fields remain in off-chain encrypted PostgreSQL storage; only hashes are committed to public/consortium chaincode. |
| **Denial of Service** | Flooding UBTL with duplicate transactions or unparseable JSON payloads. | Enforce a request-body size limit (currently `10mb`, `express.json({ limit })`), schema validation before the DB transaction, database unique constraints, and rate limiting. Oversized bodies → `413 PAYLOAD_TOO_LARGE`; malformed JSON → `400 MALFORMED_JSON` (never echoing parser internals). |
| **Elevation of Privilege** | Caller attempts to trigger administrative reconciliation or audit export without authority. | Role-Based Access Control (RBAC) separating `INGESTION_CLIENT`, `OPERATOR`, and `ADMIN` credentials. |

---

### 3. Authentication & Authorization Guardrails

#### 3.1 Gateway Ingestion Auth
- Inbound requests from the Switching system require the `X-Api-Key` header matching the provisioned organization credential.
- **Implemented**: the credential is compared against the configured `UBTL_API_KEY` (`AuthService.validateSwitchingApiKey`) and the resulting organization id is resolved to its durable `organizations.id` UUID before persistence. The `organizations` row carries an `apiKeyHash` (SHA-256). *Known weakness*: the comparison is a plain string equality, not constant-time — acceptable for a high-entropy shared key, but a constant-time comparison would remove the timing side channel.
- **Implemented (layer 2)**: an inbound HMAC-SHA256 signature over `` `${timestamp}.${rawBody}` `` is verified (`x-switching-signature` / `x-switching-timestamp`) with an anti-replay tolerance window and a constant-time digest comparison. It is enforced (HTTP 401) when `SWITCHING_OUTBOUND_SIGNATURE_REQUIRED=true`; see §3.4 and `docs/switching-integration.md`.
- **Implemented (admin separation)**: `/v1/admin/*` requires a *distinct* `UBTL_ADMIN_API_KEY`; the ingestion key is insufficient (`ADMIN_UNAUTHORIZED`).
- Future joint alignment with Switching will evaluate mTLS (X.509 certificate validation) as defined in `docs/switching-integration.md`.

#### 3.2 Outbound Webhook Delivery Auth
- **Implemented**: UBTL sends `X-Api-Key: <SWITCHING_WEBHOOK_API_KEY>` and `X-Correlation-Id` on all outbound callbacks (`POST {SWITCHING_BASE_URL}/api/v1/webhooks/gateway`).
- **Implemented**: when `SWITCHING_WEBHOOK_SIGNING_SECRET` is configured, UBTL also signs every callback with HMAC-SHA256 over `` `${timestamp}.${rawBody}` `` using Switching's `x-gateway-signature` / `x-gateway-timestamp` convention (each retry carries a fresh timestamp; the logical event identity is unchanged). When no secret is configured the signature headers are omitted. Switching should set its `GATEWAY_WEBHOOK_SIGNATURE_REQUIRED=true` to enforce verification.
- Delivery is **at-least-once**; the receiver must deduplicate callbacks by `(gatewayRequestId, status)`.

#### 3.3 Blockchain Network Provider Auth
- In `provider` mode, UBTL connects to the external Fabric Gateway using X.509 client certificates and private keys issued by the consortium's Certificate Authority (CA).
- Private keys are stored in secure Kubernetes secrets or Hardware Security Modules (HSM/KMS), never committed to code repositories.

#### 3.4 Fail-Closed Startup Controls
Startup validation (`validateEnvironment`) aborts the process rather than running in
an insecure or non-durable state. Each control has a greppable error tag:

| Tag | Trigger | Rationale |
| :--- | :--- | :--- |
| `[AUTH_FAIL_FAST]` | `NODE_ENV=production` with `UBTL_API_KEY` / `UBTL_ADMIN_API_KEY` **unset or equal to the published development default**. | `loadConfig()` has hardcoded dev fallbacks (published in `.env.example`); without this check an unconfigured deployment would accept a publicly-known credential — full admin access for the admin key. |
| `[PERSISTENCE_FAIL_FAST]` | `UBTL_PERSISTENCE_BACKEND=postgres` without `DATABASE_URL`; or `in-memory` under `NODE_ENV=production`. | An accepted (HTTP 202) transaction must survive a restart; running durably is a correctness requirement, not a preference. |
| `[SIGNATURE_FAIL_FAST]` | `SWITCHING_OUTBOUND_SIGNATURE_REQUIRED=true` without `SWITCHING_OUTBOUND_SIGNING_SECRET`. | Requiring a signature with no shared secret would reject every legitimate call. |
| `[PROVIDER_MODE_FAIL_FAST]` | `BLOCKCHAIN_ADAPTER_MODE=provider` with any missing/malformed `FABRIC_GATEWAY_*` value. | The adapter must never silently fall back to mock while claiming provider mode. |

#### 3.5 Log Hygiene
- Secrets, API keys, certificate/key contents and full payloads are never logged.
- Log values pass through `sanitizeForLog` / `redactSecrets` (single source of truth: `src/modules/security/redaction.ts`, re-exported by `webhooks/webhook.service.ts`), which redacts credential-shaped substrings and replaces the values of sensitive keys (e.g. `apiKey`, `authorization`, `secret`, `privateKey`, `token`, `cert`) with `[REDACTED]`, bounds recursion depth and truncates long strings before an audit entry or log line is emitted.
- Durable persistence failures and reconciliation evidence-store failures log only the error *name*, never the message (which could embed connection strings).

---

### 4. Cryptographic Proof & Verification Endpoint

UBTL exposes an automated verification engine (`POST /v1/transactions/verify`) that allows any auditor to verify the cryptographic chain of custody:

```
  Off-Chain Payload (PostgreSQL) 
              |
              v (ubtl-canonical-json-v1)
     Canonical String
              |
              v (SHA-256)
     Recomputed Hash  <====== Compare ======>  On-Chain Anchored Hash
                                                   (Fabric Block N)
```

If even a single byte, whitespace, or decimal point is tampered with off-chain, the computed hash will diverge, immediately exposing the tampering attempt.
