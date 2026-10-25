# Universal Blockchain Transaction Ledger (UBTL)
## API Specification & Contract (OpenAPI 3.1 Compatible)

This document formalizes the public REST APIs implemented by UBTL, strictly conforming to the Switching draft Gateway contract (`switching-revisi/docs/api-contract.md` §4) and extended with idempotent conflict handling and constant-time verification.

---

### 1. Inbound Ingestion API (Switching -> UBTL)

#### 1.1 Submit Transaction
```http
POST /v1/transactions
```
Accepts a transaction proposal, executes schema validation, generates server-authoritative canonical SHA-256 hash, verifies durable idempotency, atomically commits transaction + outbox records, and returns HTTP 202.

**Headers**:
| Header | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `X-Api-Key` | String | Yes | Shared API key authenticating the Switching system (`UBTL_API_KEY`). |
| `X-Correlation-Id` | String | No | Correlation identifier passed down the distributed call chain. |
| `Idempotency-Key` | String | Optional* | Unique idempotency key (*Can be passed via header or body `idempotencyKey`). |
| `x-switching-signature` | String | Conditional | Hex-encoded HMAC-SHA256 of `${x-switching-timestamp}.${rawBody}`. Required only when `SWITCHING_OUTBOUND_SIGNATURE_REQUIRED=true`. See §1.5. |
| `x-switching-timestamp` | String | Conditional | Unix epoch milliseconds used in the signature payload; must be within `SIGNATURE_TOLERANCE_MS` of server time. See §1.5. |

**Request Body (JSON)**:
```json
{
  "correlationId": "corr-example-001",
  "idempotencyKey": "txn-example-001",
  "transactionType": "SALE",
  "payload": {
    "invoiceNumber": "INV-001",
    "amount": "150000.00",
    "currency": "IDR"
  }
}
```

**Supported Transaction Types**:
`SALE`, `PURCHASE`, `SAVINGS`, `LOAN`, `LAND_CERTIFICATE_EVENT`, `TAX_PAYMENT`, `GOLD_PURCHASE`, `WAQF`, `DONATION`, `CUSTOM_EVENT`.

**Response 202 Accepted**:
A newly accepted transaction is durably persisted in `OUTBOX_PENDING`/`pending` —
it is **not** yet submitted to, or confirmed by, the blockchain.
```json
{
  "gatewayRequestId": "a3b8e8f2-91e2-4f74-8b54-1b48b9415662",
  "status": "pending",
  "lifecycleState": "OUTBOX_PENDING",
  "isSimulated": true,
  "signatureVerified": false
}
```
> `isSimulated` reflects `BLOCKCHAIN_ADAPTER_MODE=mock`. Once the outbox worker
> submits the proposal, `GET /v1/transactions/{gatewayRequestId}` reports
> `status: "submitted"`; only after verified block inclusion does it report
> `status: "confirmed"`.
>
> `signatureVerified` is **additive** and reports whether a valid Switching HMAC
> signature (`x-switching-signature`) was verified on this request. It is `false`
> when the signature layer is skipped (no `SWITCHING_OUTBOUND_SIGNING_SECRET`
> configured) or when verification failed while enforcement is off (graceful
> rollout). It is **never** reported as `true` unless the signature was actually
> verified. See §1.5.

**Response 500 Internal Server Error (Durable Persistence Failure)**:
Returned when the transaction could not be durably persisted (e.g. database
unavailable). No acceptance is recorded, so the caller may safely retry with the
same `Idempotency-Key`.
```json
{
  "statusCode": 500,
  "error": "Internal Server Error",
  "errorCode": "INGESTION_FAILED",
  "message": "Transaction could not be durably persisted; no acceptance has been recorded. Retry with the same Idempotency-Key."
}
```

**Response 409 Conflict (Idempotency Key Collision)**:
Returned when the same `idempotencyKey` is submitted for the same organization with a different transaction payload or type:
```json
{
  "statusCode": 409,
  "error": "Conflict",
  "errorCode": "IDEMPOTENCY_CONFLICT",
  "message": "Idempotency key 'txn-example-001' was previously used for a different transaction payload or type"
}
```

**Response 400 Bad Request (Validation Failure)**:
```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "errorCode": "VALIDATION_ERROR",
  "message": "Payload validation failed for type 'SALE': Field 'amount' must be a valid decimal string (e.g. \"150000.00\")",
  "details": [
    "Field 'amount' must be a valid decimal string (e.g. \"150000.00\")"
  ]
}
```

**Response 401 Unauthorized**:
```json
{
  "statusCode": 401,
  "error": "Unauthorized",
  "errorCode": "UNAUTHORIZED",
  "message": "Missing or invalid X-Api-Key header for Switching Gateway Ingestion"
}
```

---

#### 1.5 Request Signature & Replay Protection (jointly agreed, Prompt 05)

The shared `X-Api-Key` alone provides no message integrity or replay
protection. Both directions therefore sign the ASCII string
`` `${timestamp}.${rawBody}` `` with HMAC-SHA256 and hex-encode the digest. This
convention is Switching's **existing** one — no new header names were invented.

| Direction | Signature header | Timestamp header | Secret |
| :--- | :--- | :--- | :--- |
| Switching → UBTL (submit) | `x-switching-signature` | `x-switching-timestamp` | `SWITCHING_OUTBOUND_SIGNING_SECRET` |
| UBTL → Switching (callback) | `x-gateway-signature` | `x-gateway-timestamp` | `SWITCHING_WEBHOOK_SIGNING_SECRET` |

**Verification rules (UBTL inbound, submit):**
1. `x-switching-timestamp` must parse as epoch milliseconds and be within
   `SIGNATURE_TOLERANCE_MS` of server time (default `300000` ms) — otherwise the
   request is stale/forged (replay protection).
2. The recomputed HMAC is compared to `x-switching-signature` in **constant
   time**.
3. `rawBody` is the exact received byte string (captured before JSON parsing),
   not a re-serialization of the parsed object.

**Enforcement modes:**
- `SWITCHING_OUTBOUND_SIGNATURE_REQUIRED=true` — a missing or invalid signature
  returns HTTP 401 `INVALID_SIGNATURE` and no transaction is persisted. UBTL
  **fails fast at startup** if enforcement is enabled without a secret.
- `SWITCHING_OUTBOUND_SIGNATURE_REQUIRED=false` — a configured secret verifies
  signatures when present but does **not** reject unsigned/invalid requests
  (graceful rollout); such requests are accepted with `signatureVerified: false`.

**Response 401 Unauthorized (signature layer)**:
```json
{
  "statusCode": 401,
  "error": "Unauthorized",
  "errorCode": "INVALID_SIGNATURE",
  "message": "Request signature verification failed: Signature mismatch"
}
```
> The diagnostic suffix (e.g. "Missing signature timestamp header",
> "Signature mismatch", "Timestamp outside tolerance window") is a generic
> verification category only — it never contains the secret, the expected
> signature, or the request body.

---

#### 1.2 Query Transaction Status
```http
GET /v1/transactions/{gatewayRequestId}
```
Fetches current status, granular lifecycle state, timestamps, and cryptographic proof data.

**Headers**:
| Header | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `X-Api-Key` | String | Yes | Shared API key (`UBTL_API_KEY` or `UBTL_ADMIN_API_KEY`). |

**Response 200 OK**:
```json
{
  "gatewayRequestId": "a3b8e8f2-91e2-4f74-8b54-1b48b9415662",
  "correlationId": "corr-example-001",
  "status": "confirmed",
  "lifecycleState": "COMMITTED",
  "blockchainTxHash": "fb082e66dd43ab1a9e88390bca38241517454228965f32a762df2ba7778bca61",
  "payloadHash": "80db2fa0cb3071de1f5998e060185cd39bcc4289e8d4fa0a89e1242075bb256e",
  "hashAlgorithm": "sha256",
  "hashVersion": "v1",
  "canonicalizationSpec": "ubtl-canonical-json-v1",
  "fabricTransactionId": "fb082e66dd43ab1a9e88390bca38241517454228965f32a762df2ba7778bca61",
  "blockNumber": 14209,
  "submittedAt": "2026-10-23T18:30:01.120Z",
  "confirmedAt": "2026-10-23T18:30:02.450Z",
  "errorMessage": null
}
```

---

#### 1.3 Cryptographic Verification Endpoint
```http
POST /v1/transactions/verify
```
Recomputes canonical hash from authoritative stored payload and executes constant-time digest verification.

**Headers**:
| Header | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `X-Api-Key` | String | Yes | Shared API key (`UBTL_API_KEY` or `UBTL_ADMIN_API_KEY`). |

**Request Body**:
```json
{
  "gatewayRequestId": "a3b8e8f2-91e2-4f74-8b54-1b48b9415662"
}
```

**Response 200 OK**:
```json
{
  "verified": true,
  "computedHash": "80db2fa0cb3071de1f5998e060185cd39bcc4289e8d4fa0a89e1242075bb256e",
  "storedPayloadHash": "80db2fa0cb3071de1f5998e060185cd39bcc4289e8d4fa0a89e1242075bb256e",
  "ledgerCommitVerified": true,
  "blockNumber": 14209,
  "fabricTransactionId": "fb082e66dd43ab1a9e88390bca38241517454228965f32a762df2ba7778bca61",
  "canonicalPayload": "{\"amount\":\"150000.00\",\"currency\":\"IDR\",\"invoiceNumber\":\"INV-001\"}",
  "hashAlgorithm": "sha256",
  "hashVersion": "v1",
  "canonicalizationSpec": "ubtl-canonical-json-v1",
  "error": null
}
```

---

#### 1.4 Health Check Endpoint
```http
GET /v1/health
```

**Response 200 OK**:
```json
{
  "status": "healthy",
  "service": "Universal Blockchain Transaction Ledger (UBTL)",
  "version": "1.0.0",
  "timestamp": "2026-10-24T01:41:21.395Z",
  "adapterMode": "mock",
  "database": {
    "status": "in-memory-simulation",
    "storageType": "in-memory",
    "durable": false,
    "productionReady": false,
    "details": "Non-durable in-memory repository (local mock/testing mode). Transactions and idempotency index will reset on process restart."
  },
  "blockchainAdapter": {
    "status": "online",
    "mode": "mock",
    "isSimulated": true,
    "peerEndpoint": "local://mock-peer0.org1.ubtl.internal:7051",
    "channelName": "ubtl-channel-mock",
    "currentBlockHeight": 14200,
    "latencyMs": 1,
    "details": "Mock Fabric Adapter running in local memory simulator"
  },
  "worker": {
    "workerId": "worker-1a2b3c4d",
    "running": true,
    "isShuttingDown": false,
    "lastPollTime": "2026-10-24T01:41:20.900Z",
    "activeProcessingCount": 0
  },
  "outbox": {
    "totalEvents": 0,
    "pendingCount": 0,
    "processingCount": 0,
    "retryPendingCount": 0,
    "completedCount": 0,
    "deadLetterCount": 0,
    "oldestPendingAgeMs": 0,
    "lastErrorCode": null,
    "inProgressCount": 0,
    "failedCount": 0
  },
  "webhook": {
    "pendingCount": 0,
    "processingCount": 0,
    "retryPendingCount": 0,
    "completedCount": 0,
    "deadLetterCount": 0,
    "oldestPendingAgeMs": 0,
    "totalAttempts": 0,
    "successCount": 0,
    "failureCount": 0,
    "retryableFailureCount": 0,
    "permanentFailureCount": 0,
    "ambiguousCount": 0,
    "lastSuccessAt": null,
    "lastAttemptAt": null,
    "lastErrorCode": null
  },
  "reconciliation": {
    "currentRunActive": false,
    "scheduled": true,
    "totalRuns": 0,
    "skippedOverlaps": 0,
    "lastRunAt": null,
    "lastRunDurationMs": null,
    "lastRunSummary": null,
    "totalConfirmed": 0,
    "totalInconclusive": 0,
    "totalFailed": 0,
    "totalErrors": 0,
    "unresolvedCount": 0,
    "escalatedCount": 0,
    "config": {
      "intervalMinutes": 60,
      "lookbackHours": 24,
      "batchSize": 50,
      "maxAttempts": 5
    }
  }
}
```
> The health endpoint is a **public** operational probe and contains no secrets.
> `database.durable`, `database.productionReady`, `blockchainAdapter.isSimulated`
> and the `worker` object are reported honestly: in mock/in-memory mode they
> clearly indicate simulation and non-durability. `outbox.inProgressCount` and
> `outbox.failedCount` are backward-compatibility aliases for
> `processingCount` and `deadLetterCount`.
>
> The `webhook` and `reconciliation` sections are **conditional**: they appear
> only when the composition root injects the observability providers, and are
> omitted (not stubbed) when they are not wired. They contain only aggregates —
> never credentials, certificates, private keys or raw transaction payloads.

---

### 2. Administrative API (Operator -> UBTL)

All `/v1/admin/*` endpoints require the administrative credential
`X-Api-Key: <UBTL_ADMIN_API_KEY>`. The Switching ingestion key (`UBTL_API_KEY`)
is **not** accepted for these endpoints; an invalid or missing key returns
`401 { "errorCode": "ADMIN_UNAUTHORIZED" }`.

| Method | Path | Description |
| :--- | :--- | :--- |
| `GET` | `/v1/admin/transactions?limit=50` | List recent transactions. |
| `GET` | `/v1/admin/outbox` | Outbox metrics and 50 most recent events. |
| `GET` | `/v1/admin/audit` | 50 most recent audit log entries. |
| `GET` | `/v1/admin/reconciliation?outcome=CONFIRMED\|FAILED\|INCONCLUSIVE\|ERROR` | Reconciliation records, optionally filtered by outcome. |
| `POST` | `/v1/admin/reconciliation/run` | Trigger a bounded reconciliation run now. |

**Response 401 Unauthorized**:
```json
{
  "statusCode": 401,
  "error": "Unauthorized",
  "errorCode": "ADMIN_UNAUTHORIZED",
  "message": "Missing or invalid X-Api-Key header for administrative endpoints"
}
```
