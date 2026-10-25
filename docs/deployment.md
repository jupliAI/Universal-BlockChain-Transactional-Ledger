# Universal Blockchain Transaction Ledger (UBTL)
## Deployment & Operational Runbook

### 1. Deployment Topology
UBTL is packaged as a cloud-native container image deployable on Docker Compose (local dev/staging) and Kubernetes (production).

```
   [ Cloud Load Balancer / Ingress (TLS Termination) ]
                         |
           +-------------+-------------+
           |                           |
           v                           v
   [ UBTL API Pod 1 ]          [ UBTL API Pod 2 ]
           |                           |
           +-------------+-------------+
                         |
                         v
              [ PgBouncer Connection Pooler ]
                         |
                         v
             [ PostgreSQL 16 Primary + Replica ]
                         ^
                         |
           +-------------+-------------+
           |                           |
   [ UBTL Outbox Worker 1 ]    [ UBTL Outbox Worker 2 ]
           |                           |
           v                           v
     [ External Hyperledger Fabric Network Provider Gateway ]
```

---

### 2. Local Development Deployment (`docker-compose.yml`)

A minimal local development environment consists of:
- **PostgreSQL 16**: Relational storage for transactions and outbox events.
- **UBTL Core Service**: Running in Mock Mode (`BLOCKCHAIN_ADAPTER_MODE=mock`).
- **Mock Switching Receiver**: Lightweight mock server receiving webhook callbacks.

```yaml
version: '3.8'

services:
  postgres:
    image: postgres:16-alpine
    container_name: ubtl-postgres
    environment:
      POSTGRES_USER: ubtl_user
      POSTGRES_PASSWORD: ubtl_password
      POSTGRES_DB: ubtl_db
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ubtl_user -d ubtl_db"]
      interval: 5s
      timeout: 5s
      retries: 5

  ubtl-api:
    build: .
    container_name: ubtl-api
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=development
      - DATABASE_URL=postgresql://ubtl_user:ubtl_password@postgres:5432/ubtl_db?schema=public
      - BLOCKCHAIN_ADAPTER_MODE=mock
      - SWITCHING_BASE_URL=http://mock-switching:4000
    depends_on:
      postgres:
        condition: service_healthy

volumes:
  pgdata:
```

---

### 3. Production Deployment Guidelines (Kubernetes)

1. **Pod Segregation**:
   - **API Deployment**: Handles synchronous HTTP traffic (`POST /v1/transactions`, `GET /v1/transactions/:id`). Auto-scales horizontally based on CPU and request latency.
   - **Worker Deployment**: Dedicated worker pods running outbox processors and stuck recovery tasks (`SELECT ... FOR UPDATE SKIP LOCKED`). Scales dynamically based on pending outbox queue depth.
2. **Worker Configuration & Tuning**:
   - `OUTBOX_POLL_INTERVAL_MS`: Polling interval in ms (default: `2000`).
   - `OUTBOX_BATCH_SIZE`: Events claimed per batch per worker (default: `25`).
   - `OUTBOX_MAX_RETRIES`: Maximum total attempts allowed before dead-lettering (default: `5`).
   - `OUTBOX_BACKOFF_BASE_MS`: Base exponential backoff delay (default: `1000`).
   - `OUTBOX_STUCK_TIMEOUT_MS`: Threshold before an in-progress event is considered stuck (default: `60000`).
3. **Webhook Delivery Configuration**:
   - `SWITCHING_BASE_URL`: Base URL of the Switching receiver (default: `http://localhost:4000`).
   - `SWITCHING_WEBHOOK_ENDPOINT`: Callback path (default: `/api/v1/webhooks/gateway`).
   - `SWITCHING_WEBHOOK_API_KEY`: Shared `X-Api-Key` sent on every outbound callback. Mount as a secret.
   - `SWITCHING_WEBHOOK_TIMEOUT_MS`: Per-attempt connection/request timeout (default: `5000`).
   - `SWITCHING_WEBHOOK_MAX_RETRIES`: Total delivery attempts for `DELIVER_WEBHOOK` (default: `5`), independent of ledger retries.
   - Delivery is **at-least-once**; the Switching receiver must deduplicate by `(gatewayRequestId, status)`. Exhausted retries dead-letter the webhook event **without** touching ledger state.
4. **Reconciliation Engine Configuration**:
   - `RECONCILIATION_INTERVAL_MINUTES`: Scheduler interval (default: `60`).
   - `RECONCILIATION_LOOKBACK_HOURS`: Age after which a stuck `SUBMITTED`/`AWAITING_COMMIT` transaction becomes eligible (default: `24`).
   - `RECONCILIATION_BATCH_SIZE`: Max transactions per run (default: `50`).
   - `RECONCILIATION_MAX_ATTEMPTS`: Bounded attempts before an inconclusive case is escalated (default: `5`).
   - `RECONCILIATION_LOCK_TTL_SECONDS`: Durable lock **lease TTL** in seconds (default: `120`). Bounds crash recovery: a worker that dies without releasing keeps the lock for at most this long before another worker may reclaim it. Must be greater than the longest expected reconciliation run; the heartbeat renews it at roughly `TTL / 3`.
   - The scheduler is started with the process and stopped during graceful shutdown.
   - **Multi-worker coordination is durable by default.** When `DATABASE_URL` is set and reachable, the process injects `PostgresReconciliationLock`, a single-row lease in the `reconciliation_locks` table (see `docs/outbox-design.md` §8.4), so multiple worker replicas coordinate through PostgreSQL. Only when no durable database is wired does it fall back to `SingleProcessReconciliationLock` (safe within one process only) and log an explicit warning. The lock is **fail-closed**: if acquiring throws, the run is skipped and audited (`RECONCILIATION_LOCK_ERROR`) rather than proceeding unprotected.
   - PostgreSQL advisory locks are deliberately **not** used (they are connection-bound and unsafe with a pooled driver); the lease row is claimed with a single atomic `INSERT ... ON CONFLICT ... RETURNING` and self-heals on expiry.
5. **Database Pooling & Atomic Row Locking**:
   - Deploy PgBouncer in transaction-pooling mode between UBTL and PostgreSQL.
   - The worker uses atomic row locking (`FOR UPDATE SKIP LOCKED`) which commits immediately upon claiming, preventing database connections from stalling while contacting external peers.
   - Reconciliation gathers evidence on plain reads and never holds a row lock across a provider call.
6. **Graceful Shutdown Discipline**:
   - Upon receiving `SIGTERM` or `SIGINT`, the service invokes `worker.stop(gracePeriodMs = 5000)` and `reconciliationService.stop()`.
   - `isShuttingDown` flag is immediately set to `true` to reject new event claims.
   - In-flight tasks (including in-flight webhook deliveries) are given up to the grace period to complete cleanly before the process exits.
7. **Zero-Downtime Database Migrations**:
   - Apply Prisma migrations (`npx prisma migrate deploy`) in an initContainer before the API containers start.
   - All migrations maintain backward compatibility:
     ```bash
     npx prisma migrate deploy
     npx prisma migrate status
     ```
8. **Persistence Guarantees**:
   - **PostgreSQL Mode**: Full ACID atomicity for transaction creation and outbox event scheduling. Cross-process row lock safety. The **entire runtime** is durable in this mode: transactions, lifecycle history, idempotency index, audit trail, outbox events and reconciliation evidence all live in PostgreSQL, so a restart loses nothing.
   - **In-Memory Mode**: Development simulation only (`durable: false`). In-process concurrency safety, but resets on container restart. Must not be used for production.
9. **Persistence Backend Selection** (`UBTL_PERSISTENCE_BACKEND`, default `auto`):
   | Value | Behaviour |
   | :--- | :--- |
   | `auto` *(default)* | PostgreSQL when `DATABASE_URL` is configured; otherwise in-memory. In `NODE_ENV=production` an unreachable database **aborts startup**; in development it logs a loud warning and falls back to in-memory. |
   | `postgres` | **Requires** a reachable database. Missing `DATABASE_URL`, or an unreachable database, aborts startup (`[PERSISTENCE_FAIL_FAST]` / `CRITICAL`). Never degrades silently. |
   | `in-memory` | Explicit non-durable simulation for local development. Rejected at startup when `NODE_ENV=production` (`[PERSISTENCE_FAIL_FAST]`). |
   - The resolved backend is printed once at boot (`[UBTL] Persistence backend: …`) and the effective choice is reflected in `GET /v1/health` (`database.storageType`, `database.durable`, `database.productionReady`).
   - When the backend is PostgreSQL, **one** Prisma client (one connection pool) is shared by the transaction repository, the outbox repository, the audit sink, the reconciliation evidence store and the reconciliation lock, and is disconnected **last** during graceful shutdown.
   - The durable path resolves the Switching tenant's logical id to its real `organizations.id` UUID once at boot (the `transactions.organizationId → organizations.id` foreign key is a UUID column, so the logical id cannot be persisted directly).
10. **Production Credential Requirements (fail-closed)**:
   - `UBTL_API_KEY` (Switching ingestion) and `UBTL_ADMIN_API_KEY` (operator/admin) **must** be set to strong, unique values when `NODE_ENV=production`. Both have hardcoded development fallbacks that are published in `.env.example`; a production runtime whose key is missing **or** equal to a published default aborts startup with `[AUTH_FAIL_FAST]`. Without this check an unconfigured deployment would silently accept a publicly-known key (full admin access in the `UBTL_ADMIN_API_KEY` case).
   - `SWITCHING_OUTBOUND_SIGNATURE_REQUIRED=true` without `SWITCHING_OUTBOUND_SIGNING_SECRET` aborts startup with `[SIGNATURE_FAIL_FAST]`. Configure the secret **and** enforcement together: a configured secret with enforcement off gives no protection while appearing to (see `docs/switching-integration.md` §7).
11. **Payload Size Limits**: request bodies are parsed with a `10mb` limit (`express.json({ limit: '10mb' })`). Oversized bodies are rejected with HTTP `413 PAYLOAD_TOO_LARGE`; malformed JSON with HTTP `400 MALFORMED_JSON`. Neither response echoes parser internals or the offending payload.

#### 3.1 Required Environment Variables (quick reference)

| Variable | Required when | Notes |
| :--- | :--- | :--- |
| `NODE_ENV` | always | `production` enables the fail-closed checks below. |
| `DATABASE_URL` | `UBTL_PERSISTENCE_BACKEND=postgres`, or `auto` with a durable backend | No placeholder fallback: an empty value means "no database configured". |
| `UBTL_PERSISTENCE_BACKEND` | optional (default `auto`) | `auto` \| `postgres` \| `in-memory`. |
| `UBTL_API_KEY` | **production** (non-default) | Switching ingestion credential. |
| `UBTL_ADMIN_API_KEY` | **production** (non-default) | Admin/operator credential. |
| `BLOCKCHAIN_ADAPTER_MODE` | always | `mock` (default) or `provider`. `provider` requires every `FABRIC_GATEWAY_*` value. |
| `SWITCHING_OUTBOUND_SIGNING_SECRET` | when `SWITCHING_OUTBOUND_SIGNATURE_REQUIRED=true` | Shared secret for verifying Switching's inbound signature. |
| `SWITCHING_WEBHOOK_SIGNING_SECRET` | when UBTL callbacks must be signed | When empty, outbound signature headers are omitted. |
| `RECONCILIATION_LOCK_TTL_SECONDS` | optional (default `120`) | Durable lock lease TTL; bounds crash recovery. |

---

### 4. Fabric Provider Mode (Operational Notes)

Mock mode is the default and requires **no** Fabric credentials and **no** Docker.
Switch to provider mode only when a real Hyperledger Fabric network is reachable.

```bash
BLOCKCHAIN_ADAPTER_MODE=provider
FABRIC_GATEWAY_PEER_ENDPOINT=peer0.org1.example.com:7051
FABRIC_GATEWAY_TLS_CERT_PATH=/etc/ubtl/fabric/tls-ca.crt
FABRIC_GATEWAY_CLIENT_CERT_PATH=/etc/ubtl/fabric/client.crt
FABRIC_GATEWAY_CLIENT_KEY_PATH=/etc/ubtl/fabric/client.key
FABRIC_GATEWAY_MSP_ID=Org1MSP
FABRIC_GATEWAY_CHANNEL_NAME=ubtl-channel
FABRIC_GATEWAY_CHAINCODE_NAME=ubtl-ledger
FABRIC_GATEWAY_COMMIT_TIMEOUT_SECONDS=60
FABRIC_GATEWAY_DISCOVERY_AS_LOCALHOST=false
```

1. **Fail-fast, never silent fallback**: when `BLOCKCHAIN_ADAPTER_MODE=provider`,
   startup validation requires all of the settings above. Missing or malformed
   values abort startup — the adapter **never** silently falls back to mock mode.
2. **Credential handling**: certificate/key paths are read by
   `FileSystemFabricCredentialSource`. Credentials are used only to build the
   gRPC channel and signer; their contents are **never logged**. Only the
   *environment variable name* is surfaced on a credential error.
3. **Secret hygiene**: certificates, private keys and API keys must be mounted
   as read-only secrets (Kubernetes Secret / Docker secret). Do not bake them
   into the image or commit them to the repository.
4. **Terminology**: the *peer endpoint* is the gRPC target of the Fabric peer
   (host:port); the *Gateway* is the client-side connection object created by the
   Fabric Gateway SDK (not a separate network address); the *MSP identity*
   identifies which organization this client belongs to; the *channel* is the
   Fabric channel (ledger partition); the *chaincode* is the smart contract that
   implements the ledger record functions.
5. **Chaincode prerequisite**: this repository does **not** ship or deploy a UBTL
   chaincode. Provider mode requires the chaincode interface documented in
   [`provider-requirements.md`](./provider-requirements.md) (§3.4/§3.6/§3.7) to
   be deployed on the target channel with the UBTL ledger functions.

---

### 5. Known Limitations & Outstanding Conditions

- **Live Fabric integration is NOT EXECUTED.** The Fabric adapter is verified
  only against an in-process SDK test double (`TC-FABRIC-01..20`). `TC-FABRIC-21`
  is the opt-in live test and is **SKIPPED** without a reachable network. No live
  Fabric commit, transaction ID or block number has been observed.
- **Commit status cannot be queried by transaction ID.** The Fabric Gateway client
  protocol exposes no "query commit status by transaction ID" RPC;
  `Commit.getStatus()` is only available from the `SubmittedTransaction` returned
  by `submit()` in the same process. Cross-restart reconciliation relies on the
  documented UBTL chaincode fallback (a UBTL-defined contract, **not** a native
  Fabric capability).
- **R-1 — PostgreSQL live concurrency verification: EXECUTED (PASS).** The
  project-aligned Prisma dependencies (`prisma@6.19.3`, `@prisma/client@6.19.3`)
  were installed, migrations applied to a dedicated test database with
  `prisma migrate deploy`, and `TC-PG-01..14` run against a live PostgreSQL
  (Neon, direct endpoint): **14 passed, 0 failed** (exit `0`). This covers
  `SELECT ... FOR UPDATE SKIP LOCKED` claiming, transaction/outbox atomicity,
  rollback, stale-event reclaim, idempotency conflicts **and the durable
  multi-worker reconciliation lock** (cross-connection and cross-**process**
  exclusion, crash/expiry reclaim, heartbeat renewal, two-worker exactly-once
  reconciliation, ambiguous-result fail-closed).
- **R-2 — `prisma migrate diff`: EXECUTED (PASS).** With the Prompt 07
  `reconciliation_locks` migration applied,
  `migrate diff --from-migrations prisma/migrations --to-schema-datamodel
  --shadow-database-url "<shadow>"` and `migrate diff --from-url "<live DB>"
  --to-schema-datamodel` both print `No difference detected.` (exit `0`), and
  `prisma validate` is green — migrations ≡ schema ≡ live database. (The earlier
  `@@unique` database-index-name drift on `transactions` was fixed
  non-destructively in `schema.prisma` via `map:`.)
  > Modelling note: `name:` on `@@unique` renames the Prisma Client compound
  > accessor (breaking `organizationId_idempotencyKey`); use only `map:` to set
  > the database index name.
- **Durable runtime wiring: EXECUTED (Prompt 08).** The composition root
  (`server.ts`) no longer instantiates in-memory repositories: it resolves an
  explicit persistence backend and, when PostgreSQL is selected, wires
  `PrismaTransactionRepository`, `PrismaOutboxRepository`, `PrismaAuditLogSink`
  and `PostgresReconciliationRecordStore` onto one shared client. `AuditService`
  and `ReconciliationService` previously held process-local state (audit log,
  reconciliation evidence and the escalation attempt budget) that was lost on
  restart; both are now store-backed. Restart therefore preserves transactions,
  the idempotency index, lifecycle history, outbox state, audit entries and
  reconciliation results — **in PostgreSQL mode**. The in-memory mode remains a
  development simulation and still resets on restart.
- **Restart recovery: EXECUTED at the persistence layer; NOT EXECUTED end-to-end
  with a live chaincode.** A two-process probe against live PostgreSQL confirmed
  that a crashed worker's stale lease is reclaimed by a restarted process
  (`reclaimStuckEvents`) and that no transaction is marked `COMMITTED` without
  provider evidence. The crash/restart paths that depend on a real Fabric
  network (stuck flushes, `AWAITING_COMMIT`, cross-restart commit-status
  lookups) remain in-memory only. No transaction is advanced to `COMMITTED`
  without verified provider evidence on any path.
- **Cross-restart reconciliation is incomplete.** The Fabric Gateway exposes no
  native commit-status-by-transaction-ID query; `Commit.getStatus()` is
  process-bound. Cross-restart recovery depends on a **UBTL-defined chaincode
  query that is not yet deployed or verified on a real network**. Until then,
  such transactions remain `RECONCILIATION_REQUIRED` (inconclusive) rather than
  being resolved or fabricated.
- **Webhook delivery is at-least-once, not exactly-once.** Duplicate callbacks
  are expected; the Switching receiver must be idempotent. UBTL signs outbound
  callbacks (`x-gateway-signature` / `x-gateway-timestamp`, HMAC-SHA256 over
  `` `${timestamp}.${rawBody}` ``) **only when a signing secret is configured**;
  when none is configured the signature headers are omitted (see
  `docs/switching-integration.md` §8).
- **Multi-worker reconciliation coordination: DURABLE (Prompt 07).** The
  `SingleProcessReconciliationLock` is no longer the production default: with a
  reachable `DATABASE_URL` the process uses `PostgresReconciliationLock`
  (`reconciliation_locks` lease row), verified cross-process by `TC-PG-07..14`.
  A `RECONCILIATION_LOCK_ERROR` is fail-closed. The remaining multi-worker gap is
  only the chaincode-dependent cross-restart recovery below.
- **Not production-ready** until a live restart-recovery run against a real
  deployed chaincode, at least one executed live Fabric integration test
  (`TC-FABRIC-21`), and joint finalization of the Switching callback
  authentication/integrity contract are completed. (R-1, R-2 and the durable
  multi-worker reconciliation lock are now executed and passing — see above.)
  Additionally, the durable runtime wiring added in Prompt 08 has been exercised
  end-to-end only in **in-memory** mode in this environment (no reachable
  PostgreSQL): the PostgreSQL integration suite (`TC-PG-*`) is opt-in and
  reported **SKIPPED** when `DATABASE_URL` is unreachable. Re-run it against the
  `ubtl_pgtest` database before final acceptance.

---

### 6. Health Metrics & Troubleshooting

#### 6.1 `GET /v1/health` (public)

The top-level `status` is `healthy`, or `degraded` when the injected database
probe reports the configured durable backend as unreachable.

`database`
- `status` — `connected` (durable backend) or `in-memory-simulation`.
- `storageType`, `durable`, `productionReady`, `details` — the effective
  persistence choice, taken from the active repository (never from configuration
  alone).
- `probe` — a **live** round-trip result: `reachable` | `unreachable` |
  `not-configured`. `not-configured` means no durable client is wired (in-memory
  mode / unit tests). An `unreachable` probe flips the top-level `status` to
  `degraded`, so an uptime check reacts to a database that went away after boot
  without the endpoint ever claiming a false `connected`.

Beyond adapter/database/worker/outbox figures, when the observability providers
are wired the response includes:

`webhook`
- `pendingCount`, `processingCount`, `retryPendingCount`, `completedCount`,
  `deadLetterCount` — queue state scoped to `DELIVER_WEBHOOK` events.
- `oldestPendingAgeMs` — age of the oldest pending webhook event.
- `totalAttempts`, `successCount`, `failureCount`, `retryableFailureCount`,
  `permanentFailureCount`, `ambiguousCount`.
- `lastSuccessAt`, `lastAttemptAt`, `lastErrorCode` — last successful webhook
  delivery and last outcome.

`reconciliation`
- `currentRunActive`, `scheduled`, `totalRuns`, `skippedOverlaps`.
- `lastRunAt`, `lastRunDurationMs`, `lastRunSummary`.
- `totalConfirmed`, `totalInconclusive`, `totalFailed`, `totalErrors`.
- `unresolvedCount` — transactions currently in `RECONCILIATION_REQUIRED`.
- `escalatedCount` — inconclusive cases that exhausted `RECONCILIATION_MAX_ATTEMPTS`.
- `config` — the effective interval / lookback / batch size / max attempts.

The health endpoint exposes **no** secrets, credentials, certificates or raw
transaction payloads.

#### 6.2 Administrative endpoints (require `X-Api-Key: <UBTL_ADMIN_API_KEY>`)

| Method | Path | Description |
| :--- | :--- | :--- |
| `GET` | `/v1/admin/outbox` | Outbox metrics and 50 most recent events. |
| `GET` | `/v1/admin/reconciliation?outcome=CONFIRMED\|FAILED\|INCONCLUSIVE\|ERROR` | Reconciliation records, optionally filtered by outcome. |
| `POST` | `/v1/admin/reconciliation/run` | Trigger a bounded reconciliation run now. |

#### 6.3 Troubleshooting

| Symptom | Likely cause | Action |
| :--- | :--- | :--- |
| `webhook.deadLetterCount` rising | Receiver returning permanent 4xx, or retries exhausted on 5xx/timeouts. | Check receiver availability and `X-Api-Key`; inspect `webhook.lastErrorCode`. Safe to re-drive via a fresh `DELIVER_WEBHOOK`; ledger state is unaffected. |
| High `webhook.oldestPendingAgeMs` with `processingCount > 0` | A worker crashed mid-delivery; event is stuck until `OUTBOX_STUCK_TIMEOUT_MS`. | Stuck webhook events are automatically reclaimed and re-delivered; no manual ledger intervention needed. |
| `reconciliation.unresolvedCount` not decreasing | No provider evidence (chaincode query unavailable) → inconclusive by design. | Deploy the UBTL chaincode and verify against a real network; do **not** force a commit. |
| `reconciliation.escalatedCount` rising | Inconclusive cases exhausted bounded attempts. | Operator review of the transaction's ledger record and provider logs. |
| Reconciliation apparently skipped | Overlap guard, or the injected lock is held. | Check `reconciliation.skippedOverlaps` and `currentRunActive`. |
| Health shows `database.durable=false` | Running against the in-memory repository. | Configure a reachable `DATABASE_URL`; in-memory mode is development-only. |
| `status: "degraded"` with `database.probe: "unreachable"` | The configured durable backend became unreachable after boot. | Restore database connectivity; the endpoint is deliberately honest rather than reporting a stale `connected`. |
| Startup aborts with `[PERSISTENCE_FAIL_FAST]` | `UBTL_PERSISTENCE_BACKEND=postgres` without `DATABASE_URL`, or `in-memory` under `NODE_ENV=production`. | Fix the configuration; do not disable the check. |
| Startup aborts with `[AUTH_FAIL_FAST]` | Production is missing `UBTL_API_KEY` / `UBTL_ADMIN_API_KEY`, or they still hold the published development defaults. | Set strong, unique values. |
| Startup aborts with `[SIGNATURE_FAIL_FAST]` | `SWITCHING_OUTBOUND_SIGNATURE_REQUIRED=true` without `SWITCHING_OUTBOUND_SIGNING_SECRET`. | Configure the shared secret, or disable enforcement. |

---

### 7. Backup, Restore & Rollback

#### 7.1 What must be backed up
The durable backend is the single source of truth for the runtime. A backup
must cover the entire PostgreSQL database — there is no state held outside it
that cannot be regenerated:

| Table | Content | Consequence of loss |
| :--- | :--- | :--- |
| `transactions` | Accepted transactions, payload hash, lifecycle state, block number | Accepted (HTTP 202) work is lost. |
| `transaction_status_history` | Lifecycle transitions | Audit trail of state changes is lost. |
| `outbox_events` | Pending/in-flight/completed dispatch + webhook events | Undelivered work is lost; duplicates are safe to re-deliver. |
| `reconciliation_records` | Reconciliation evidence + escalation budget | `RECONCILIATION_MAX_ATTEMPTS` could be bypassed by repeatedly losing evidence. |
| `audit_logs` | Security/operational audit trail | Audit trail is lost. |
| `organizations` | Tenant rows (incl. the Switching tenant UUID) | The `transactions.organizationId` foreign key would dangle. |
| `reconciliation_locks` | Single lease row | **Not** business data; it self-heals on lease expiry. |

#### 7.2 Backup
- Use the managed provider's automated snapshots/PITR (or `pg_dump` for
  self-managed PostgreSQL) on a schedule, and store them encrypted off-site.
- The `outbox_events`, `reconciliation_records` and `reconciliation_locks`
  tables are high-churn; take backups with `--no-owner` dumps and verify
  restorability in a **non-production** database regularly.
- Never point a backup/restore exercise at production without explicit approval.

#### 7.3 Restore
1. Provision a fresh PostgreSQL instance (PostgreSQL 16).
2. Restore the snapshot/`pg_dump` into the new instance.
3. Confirm the schema is current: `npx prisma migrate status` must report no
   pending migrations (the snapshot already contains the applied schema).
4. Start UBTL with `UBTL_PERSISTENCE_BACKEND=postgres`; verify
   `GET /v1/health` reports `database.status=connected` and
   `database.probe=reachable`.
5. Transactions restored in a non-terminal state resume automatically: pending
   outbox events are re-claimed by the worker, and
   `RECONCILIATION_REQUIRED` transactions are picked up by the reconciliation
   scheduler. Stale worker leases are reclaimed after
   `RECONCILIATION_LOCK_TTL_SECONDS` / `OUTBOX_STUCK_TIMEOUT_MS`.
6. Webhook delivery is **at-least-once**: a restore can re-deliver callbacks
   that Switching already processed. Switching must deduplicate by
   `(gatewayRequestId, status)`.

#### 7.4 Rollback
- **Application rollback**: redeploy the previous image. The schema is
  backward-compatible (additive migrations only — see §3.7), so an older binary
  can run against the newer schema. Do **not** roll the database back to an
  older schema while a newer application version may have written to it.
- **Configuration rollback**: reverting `UBTL_PERSISTENCE_BACKEND` from
  `postgres` to `auto`/`in-memory` under `NODE_ENV=production` is **refused at
  startup** by design (`[PERSISTENCE_FAIL_FAST]`). A production rollback that
  requires non-durable storage is not supported.
- **Data rollback** is a restore (§7.3), not a migration reversal. Prisma
  migrations are forward-only here; do not author destructive down-migrations
  without explicit approval.
- **Verification after any rollback**: `GET /v1/health` (`status=healthy`,
  `database.probe=reachable`), `GET /v1/admin/outbox` (no runaway
  `deadLetterCount`), and `GET /v1/admin/reconciliation` (no unexpected growth in
  `unresolvedCount`).
