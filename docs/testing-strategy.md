# Universal Blockchain Transaction Ledger (UBTL)
## Testing & Quality Assurance Strategy

### 1. Methodology & Test Suites
UBTL enforces high-assurance verification covering canonicalization, hashing determinism, state transitions, atomic persistence, durable idempotency, concurrent outbox worker claiming, exponential backoff, ambiguous timeout reconciliation, and crash recovery.

All tests run via `npm test` (`tsx test/run-all-tests.ts`). Every test is registered with an unambiguous ID (`TC-*`) and tracked in the test inventory.

---

### 2. Comprehensive Test Catalog (134 Formal Test Cases)

#### Suite 1: Canonicalization (`TC-CANON-01` .. `TC-CANON-11`)
- **TC-CANON-01**: Property order permutation produces identical canonical output.
- **TC-CANON-02**: Nested objects are sorted recursively by UTF-16 code units.
- **TC-CANON-03**: Array element order is strictly preserved and not sorted.
- **TC-CANON-04**: Unicode strings are normalized to NFC.
- **TC-CANON-05**: Booleans and explicit null values are preserved as literals.
- **TC-CANON-06**: Negative zero (-0) is normalized to 0.
- **TC-CANON-07**: Unsupported values (BigInt, Symbol, Function) throw TypeError.
- **TC-CANON-08**: Undefined values throw TypeError rather than being silently omitted.
- **TC-CANON-09**: Non-finite numbers (NaN, Infinity) throw TypeError.
- **TC-CANON-10**: Specification is explicitly versioned as `ubtl-canonical-json-v1`.
- **TC-CANON-11**: Published hash-specification example reproduces its documented canonical form and digest.

#### Suite 2: Hashing (`TC-HASH-01` .. `TC-HASH-07`)
- **TC-HASH-01**: Identical canonical payload always produces identical SHA-256 digest.
- **TC-HASH-02**: Changed payload produces completely different SHA-256 digest.
- **TC-HASH-03**: Digest matches independently computed SHA-256 test vector.
- **TC-HASH-04**: Server computes authoritative hash; client cannot override it.
- **TC-HASH-05**: Tampering with stored payload causes verification failure.
- **TC-HASH-06**: Tamper attempt creates auditable `INTEGRITY_VIOLATION` event.
- **TC-HASH-07**: Malformed expected hashes are rejected before comparison.

#### Suite 3: Ingestion (`TC-INGEST-01` .. `TC-INGEST-09`)
- **TC-INGEST-01**: Valid request is accepted, persisted, and marked `OUTBOX_PENDING`.
- **TC-INGEST-02**: Invalid payloads are rejected without creating outbox or DB entries.
- **TC-INGEST-03**: Repeated identical requests return original transaction (Idempotent 202).
- **TC-INGEST-04**: Reusing idempotency key with different payload throws `IdempotencyConflictError` (HTTP 409).
- **TC-INGEST-05**: Concurrent identical submissions resolve to exactly one transaction record.
- **TC-INGEST-06**: Transaction record and outbox event are coordinated atomically.
- **TC-INGEST-07**: Validation failure aborts processing before returning HTTP 202.
- **TC-INGEST-08**: Protected ingestion endpoint enforces API key authentication.
- **TC-INGEST-09**: Sensitive credentials and API keys are redacted from audit logs.

#### Suite 4: Lifecycle (`TC-LIFE-01` .. `TC-LIFE-06`)
- **TC-LIFE-01**: Newly accepted transaction is `OUTBOX_PENDING`/`pending` and distinct from `submitted`.
- **TC-LIFE-02**: Outbox submission transitions state to `SUBMITTED`/`submitted`.
- **TC-LIFE-03**: Ledger block inclusion transitions state to `COMMITTED`/`confirmed`.
- **TC-LIFE-04**: Axiom 5 Guard rejects confirmation with non-positive blockNumber.
- **TC-LIFE-05**: Submission timeout moves to `RECONCILIATION_REQUIRED`, never false commit.
- **TC-LIFE-06**: Payload hash (SHA-256) is strictly distinguished from Fabric transaction ID and block height.

#### Suite 5: Mock Semantics (`TC-MOCK-01` .. `TC-MOCK-03`)
- **TC-MOCK-01**: Mock adapter proposal acceptance is deterministic with zero failure rate.
- **TC-MOCK-02**: Simulated transaction IDs and block hashes are explicitly prefixed (`simulated-*`).
- **TC-MOCK-03**: Verification endpoint returns `ledgerCommitVerified=false` in mock mode.

#### Suite 6: Authentication (`TC-AUTH-01` .. `TC-AUTH-02`)
- **TC-AUTH-01**: `POST /v1/transactions/verify` requires valid authentication.
- **TC-AUTH-02**: `GET /v1/transactions/:id` rejects missing authentication.

#### Suite 7: Persistence (`TC-PERSIST-01` .. `TC-PERSIST-06`)
- **TC-PERSIST-01**: Repository explicitly declares in-memory non-durable storage metadata in mock mode.
- **TC-PERSIST-02**: `GET /v1/health` honestly reports non-durable database simulation.
- **TC-PERSIST-03**: Persistence failure yields HTTP 500 and never a misleading HTTP 202 acceptance (and leaks no raw database details).
- **TC-PERSIST-04**: A failed atomic creation leaves no partial state and permits a safe retry.
- **TC-PERSIST-05**: Ingestion writes its dispatch event into the same outbox store the worker polls.
- **TC-PERSIST-06**: Every supported registry transaction type is representable in the Prisma `TransactionType` enum (guards schema/registry drift).

#### Suite 8: Regression (`TC-REGRESS-01` .. `TC-REGRESS-02`)
- **TC-REGRESS-01**: Baseline environment validates successfully in mock mode.
- **TC-REGRESS-02**: Provider mode fails-fast when mandatory provider parameters are absent.

#### Suite 9: Outbox & Worker Subsystem (`TC-OUTBOX-01` .. `TC-OUTBOX-23`)
- **TC-OUTBOX-01**: Transaction and initial outbox event are committed atomically.
- **TC-OUTBOX-02**: Worker does not process an uncommitted outbox event.
- **TC-OUTBOX-03**: A pending event is claimed exactly once under concurrent database workers.
- **TC-OUTBOX-04**: Two workers cannot claim the same event simultaneously.
- **TC-OUTBOX-05**: Successful submission updates the expected state.
- **TC-OUTBOX-06**: Submission acknowledgement alone does not mark the transaction committed.
- **TC-OUTBOX-07**: Confirmed commit updates the transaction lifecycle correctly.
- **TC-OUTBOX-08**: Transient failure schedules a retry.
- **TC-OUTBOX-09**: Backoff follows the documented formula.
- **TC-OUTBOX-10**: Permanent errors do not retry indefinitely.
- **TC-OUTBOX-11**: Ambiguous timeout triggers reconciliation rather than blind resubmission.
- **TC-OUTBOX-12**: Retry preserves the original transaction ID and idempotency key.
- **TC-OUTBOX-13**: A crash after claim can be recovered safely.
- **TC-OUTBOX-14**: A crash after submission triggers reconciliation.
- **TC-OUTBOX-15**: A crash after result receipt does not cause false commit status.
- **TC-OUTBOX-16**: Exhausted retries produce the documented dead-letter behavior.
- **TC-OUTBOX-17**: Stuck event recovery checks ambiguity before retrying.
- **TC-OUTBOX-18**: Switching callback failure does not roll back a committed ledger transaction.
- **TC-OUTBOX-19**: Callback retries are independent of blockchain submission retries.
- **TC-OUTBOX-20**: Graceful shutdown prevents new claims and safely handles active work.
- **TC-OUTBOX-21**: Health reporting distinguishes mock mode from real provider health.
- **TC-OUTBOX-22**: Invalid worker configuration fails fast.
- **TC-OUTBOX-23**: Existing Prompt 00, Prompt 01 and Prompt 02 tests continue to pass.

#### Suite 10: Fabric Gateway Adapter Provider Mode (`TC-FABRIC-01` .. `TC-FABRIC-21`)
- **TC-FABRIC-01**: Provider mode fails fast when mandatory Fabric parameters are absent (never silently falls back to mock).
- **TC-FABRIC-02**: Missing or malformed credentials fail fast without leaking PEM/secret material.
- **TC-FABRIC-03**: Adapter initialization fails explicitly when the Fabric SDK is unavailable.
- **TC-FABRIC-04**: Proposal submission yields `PENDING` with a provider-assigned transaction ID distinct from the UBTL request ID and idempotency key.
- **TC-FABRIC-05**: Ledger chaincode arguments are exactly `[payloadHash, transactionType, correlationId, timestamp, gatewayRequestId, idempotencyKey]`.
- **TC-FABRIC-06**: A permanent endorsement rejection maps to `FAILED`.
- **TC-FABRIC-07**: A transient provider error is surfaced and classified `TRANSIENT`.
- **TC-FABRIC-08**: Verified commit evidence (`successful:true`, `blockNumber>0`) transitions to `CONFIRMED`.
- **TC-FABRIC-09**: An unsuccessful commit status is `FAILED` and never `CONFIRMED` (validation code preserved).
- **TC-FABRIC-10**: A commit status without a positive block number is never `CONFIRMED` (Axiom 5).
- **TC-FABRIC-11**: A commit timeout is ambiguous — never `FAILED` and never `CONFIRMED`.
- **TC-FABRIC-12**: Absent commit evidence stays `PENDING` and no proof is fabricated.
- **TC-FABRIC-13**: Reconciliation falls back to the documented chaincode query after process restart.
- **TC-FABRIC-14**: Reconciliation by UBTL gateway request ID uses the dedicated chaincode query.
- **TC-FABRIC-15**: Retries preserve the original UBTL request ID and idempotency key (byte-identical ledger arguments).
- **TC-FABRIC-16**: Provider errors map onto the transient/permanent/ambiguous taxonomy.
- **TC-FABRIC-17**: Provider error messages are sanitized before they are surfaced.
- **TC-FABRIC-18**: Neither mock nor provider mode reports a commit without verified evidence.
- **TC-FABRIC-19**: Provider health is reported honestly and `close()` releases gateway and gRPC resources.
- **TC-FABRIC-20**: Environment validation fails fast on invalid provider-mode Fabric settings; mock mode requires no Fabric configuration.
- **TC-FABRIC-21**: LIVE Fabric network integration (opt-in via `UBTL_FABRIC_LIVE_TEST=true`; **SKIPPED** unless an accessible Fabric network is present).

**Scope of evidence (important).** Every Fabric test except `TC-FABRIC-21` runs against an **in-process test double** that implements `fabric-sdk.port.ts` (the structural SDK port). These tests verify UBTL's own adapter logic, error classification, commit discipline and reconciliation ordering. They **prove nothing about a live Hyperledger Fabric network** — no real peer, orderer, channel or chaincode is contacted. `TC-FABRIC-21` is the only test that would touch a real network, and it reports `SKIP` when infrastructure is unavailable (see §5). No live Fabric integration test has been executed.

#### Suite 11: Webhook Dispatcher (`TC-WEBHOOK-01` .. `TC-WEBHOOK-12`)
- **TC-WEBHOOK-01**: Confirmed transaction enqueues a webhook only after the durable state transition.
- **TC-WEBHOOK-02**: Webhook delivery succeeds and reports success (simulated HTTP 200).
- **TC-WEBHOOK-03**: HTTP 5xx triggers a bounded retry (`TRANSIENT`).
- **TC-WEBHOOK-04**: Permanent HTTP 4xx follows the documented permanent-error policy.
- **TC-WEBHOOK-05**: A client timeout is classified safely as `AMBIGUOUS` and retried.
- **TC-WEBHOOK-06**: Callback retry preserves the logical event identity and idempotency.
- **TC-WEBHOOK-07**: Duplicate initial webhook events are rejected by a durable deduplication constraint.
- **TC-WEBHOOK-08**: A webhook failure never reverses a confirmed ledger commit.
- **TC-WEBHOOK-09**: Stuck webhook events are safely recovered without touching ledger state.
- **TC-WEBHOOK-10**: Graceful shutdown allows an in-flight delivery to complete.
- **TC-WEBHOOK-11**: Webhook aggregate metrics report queue state and delivery outcomes.
- **TC-WEBHOOK-12**: Secrets are redacted from webhook error text and log payloads.

#### Suite 12: Reconciliation (`TC-RECON-01` .. `TC-RECON-12`)
- **TC-RECON-01**: Reconciliation confirms only with verified adapter commit evidence.
- **TC-RECON-02**: A `CONFIRMED` status without a positive block number is never treated as committed.
- **TC-RECON-03**: Reconciliation preserves `RECONCILIATION_REQUIRED` when no provider evidence exists.
- **TC-RECON-04**: Restart recovery does not fabricate Fabric commit evidence.
- **TC-RECON-05**: Concurrent reconciliation runs do not duplicate unsafe work.
- **TC-RECON-06**: Invalid reconciliation configuration fails fast.
- **TC-RECON-07**: Reconciliation preserves the original gateway request id and idempotency key.
- **TC-RECON-08**: Reconciliation outcomes are auditable and sanitized (no secrets).
- **TC-RECON-09**: Reconciliation metrics expose run state, counts and configuration.
- **TC-RECON-10**: The reconciliation scheduler starts and stops cleanly.
- **TC-RECON-11**: A payload hash mismatch is escalated and never treated as committed.
- **TC-RECON-12**: A `PENDING` provider acknowledgement is never inferred as a commit.

#### Suite 13: Observability (`TC-OBS-01` .. `TC-OBS-02`, `TC-REGRESS-03`)
- **TC-OBS-01**: Health endpoint reports webhook and reconciliation aggregates without secrets.
- **TC-OBS-02**: Health endpoint omits optional aggregates when no providers are injected.
- **TC-REGRESS-03**: All Prompt 00–04 suites remain registered and green.

#### Suite 14: Cross-Application Integration (`TC-E2E-01` .. `TC-E2E-16`, `TC-REGRESS-04`)
- **SIMULATED**: These tests use in-process **test doubles**. The "Switching" side
  is a local `SimulatedSwitchingReceiver` that re-implements Switching's
  documented receive contract (HMAC-SHA256 over `${timestamp}.${rawBody}`, the
  `x-switching-*`/`x-gateway-*` header convention, `{ received, applied }`
  responses, and `(gatewayRequestId, status)` deduplication). **No real Switching
  instance and no real HTTP endpoint were contacted.**
- **TC-E2E-01** successful submission + status propagation; **TC-E2E-02**
  idempotent duplicate submissions (one transaction, same `gatewayRequestId`);
  **TC-E2E-03** conflicting idempotency key → `409 IDEMPOTENCY_CONFLICT`;
  **TC-E2E-04** authentication failures → `401`; **TC-E2E-05** valid Switching
  HMAC accepted + `signatureVerified:true`; **TC-E2E-06** tampered body/signature
  → `401 INVALID_SIGNATURE` (no transaction persisted); **TC-E2E-07** stale
  timestamp replay → `401`; **TC-E2E-08** configured-but-not-enforced accepts
  with `signatureVerified:false`; **TC-E2E-09** UBTL outbound webhook signature
  verifies against Switching guard semantics; **TC-E2E-10** no signature headers
  when no secret (API key still sent); **TC-E2E-11** duplicate callback → no
  double transition; **TC-E2E-12** out-of-order callbacks do not regress status;
  **TC-E2E-13** webhook timeout is AMBIGUOUS and retry preserves event identity;
  **TC-E2E-14** failure recovery never fabricates a confirmation; **TC-E2E-15**
  payload SHA-256 hash never confused with the Fabric transaction id;
  **TC-E2E-16** enforcement without a secret fails fast at startup.
- **TC-REGRESS-04**: All Prompt 00–05 suites remain registered and green.

**Scope of evidence (webhook, reconciliation & cross-app).** Every webhook test
stubs the global `fetch` with an in-process fake (simulated HTTP responses),
every reconciliation test injects an in-process `BlockchainAdapter` test double,
and every cross-application test uses the in-process `SimulatedSwitchingReceiver`.
These tests exercise UBTL's own dispatcher/reconciliation/signature logic — retry
classification, identity preservation, deduplication, inconclusive preservation
and cost bounds. They **prove nothing about a live Switching receiver or a live
Fabric network**; no real HTTP endpoint and no real peer/chaincode were contacted.

---

### 3. Execution Results (Unit + In-Memory Integration)
```text
================================================================================
 UBTL TEST SUITE — PROMPTS 00–05 (CANONICALIZATION, OUTBOX, WORKER, FABRIC ADAPTER, WEBHOOKS, RECONCILIATION, CROSS-APP INTEGRATION)
================================================================================
Discovered: 134 formal test cases across 14 suites.

 TEST SUMMARY:
 Discovered: 134
 Executed:   133
 Passed:     133
 Failed:     0
 Skipped:    1
 Suites:     14
================================================================================
```

Command: `npx tsx test/run-all-tests.ts` (also `npm test`) — exit code `0`.
The single skip is `TC-FABRIC-21` (live Fabric network integration), which is
opt-in and was not enabled because no accessible Fabric network was available.
`Discovered: 134` vs. `Executed: 133` differs by that one skipped case.

All tests execute deterministically using injectable clocks and random generators, without flaky sleeps or external cloud dependencies.

---

### 4. Test-Double vs. Live-Network Evidence Boundary

UBTL's Fabric coverage is deliberately split by the strength of the evidence:

| Category | Tests | Touches a real Fabric network? | What it proves |
|---|---|---|---|
| Unit / logic | `TC-CANON-*`, `TC-HASH-*`, `TC-LIFE-*`, `TC-OUTBOX-*`, `TC-FABRIC-01..20` | No | UBTL's own logic. Fabric tests use an in-process test double implementing `fabric-sdk.port.ts`. |
| Unit / logic (webhook & reconciliation) | `TC-WEBHOOK-*`, `TC-RECON-*`, `TC-OBS-*` | No | Dispatcher classification/retry/dedup and reconciliation evidence discipline. Webhook tests stub global `fetch`; reconciliation tests inject an in-process `BlockchainAdapter` double. |
| In-memory integration | `TC-INGEST-*`, `TC-AUTH-*`, `TC-PERSIST-*`, `TC-MOCK-*`, `TC-REGRESS-*` | No | Wire-level behaviour over the in-memory repository. |
| Live Fabric | `TC-FABRIC-21` | Yes (when enabled) | Real peer/orderer/channel/chaincode interaction. **NOT EXECUTED.** |

> A passing `TC-FABRIC-01..20` does **not** demonstrate that UBTL can commit
> against a real Hyperledger Fabric network, that a UBTL chaincode is deployed,
> or that any transaction ID/block number is genuine. Only `TC-FABRIC-21`, run
> against an accessible network, could provide that evidence.

---

### 5. PostgreSQL Integration Tests (Opt-In) — R-1

The repository concurrency, atomic-creation, stale-reclaim and idempotency
guarantees that depend on real PostgreSQL semantics (`SELECT ... FOR UPDATE SKIP
LOCKED`, unique constraints, one-unit-of-work commits) — plus the **durable
multi-worker reconciliation lock** — are exercised by a separate, opt-in harness:
`test/pg-integration.test.ts` (`TC-PG-01` .. `TC-PG-14`).

```bash
UBTL_PG_TESTS=true DATABASE_URL=postgresql://user:pass@host:5432/ubtl npx tsx test/pg-integration.test.ts
```

If the opt-in flag, `DATABASE_URL`, or `@prisma/client` are unavailable, the
harness prints an explicit `SKIPPED` notice and exits `0`. It never fabricates a
pass.

**Status: EXECUTED — 14/14 PASS against a live PostgreSQL (Neon).** Project-aligned
Prisma dependencies are installed (`prisma@6.19.3` devDependency,
`@prisma/client@6.19.3` dependency — no major bump), and the schema is applied to
a **dedicated test database** that is kept separate from any other database:

- test database: `ubtl_pgtest` (Neon direct endpoint, non-pooler)
- shadow database: `ubtl_pgtest_shadow` (used only by `migrate diff --from-migrations`)

```bash
# provision (once)
CREATE DATABASE ubtl_pgtest; CREATE DATABASE ubtl_pgtest_shadow;

# apply the committed migrations to the test DB only
DATABASE_URL="postgresql://.../ubtl_pgtest?sslmode=require" npx prisma migrate deploy

# run the concurrency + durable-lock harness on a clean database
UBTL_PG_TESTS=true DATABASE_URL="postgresql://.../ubtl_pgtest?sslmode=require" npx tsx test/pg-integration.test.ts
```

| Run | Database state | Result | Exit |
|---|---|---|---|
| RUN 1 | `TRUNCATE ... CASCADE` (clean) | 6 passed, 0 failed, 6 total | 0 |
| RUN 2 | `TRUNCATE ... CASCADE` (clean) | 6 passed, 0 failed, 6 total | 0 |
| RUN 3 (Prompt 07) | clean + `reconciliation_locks` migration applied | 14 passed, 0 failed, 14 total | 0 |

Both early runs are deterministic (`TC-PG-01` .. `TC-PG-06` all pass on a clean
database), so the live concurrency guarantee — `SELECT ... FOR UPDATE SKIP
LOCKED` mutually-exclusive claiming, transaction/outbox atomicity, rollback,
stale-event reclaim and idempotency conflicts — is now **exercised against real
PostgreSQL**, not in-memory doubles.

**Durable multi-worker reconciliation lock (`TC-PG-07` .. `TC-PG-14`).** These
tests exercise `PostgresReconciliationLock` (the `reconciliation_locks` lease row,
see [`outbox-design.md`](./outbox-design.md) §8.4) against the live database:

| ID | Guarantee proven against live PostgreSQL |
|---|---|
| `TC-PG-07` | Exclusive ownership across **independent connections**; the same owner may re-acquire its own lease; after release a peer can acquire. |
| `TC-PG-08` | Release is **owner-scoped** — a non-owner cannot free another worker's lock. |
| `TC-PG-09` | A crashed worker's lease **expires** and is reclaimed (no permanent lock), while a live lease is never stolen. |
| `TC-PG-10` | The **heartbeat** renews the lease so a long run keeps exclusivity beyond the TTL. |
| `TC-PG-11` | Exclusion holds across a **separate OS process** (`test/helpers/lock-holder-worker.ts` spawned via `npx tsx`). |
| `TC-PG-12` | **Two workers reconcile the same transaction exactly once** (one `skipped`, one `confirmed`, exactly one provider evidence query; `COMMITTED` at `blockNumber 4242`). |
| `TC-PG-13` | Under contention an **ambiguous** provider result preserves `RECONCILIATION_REQUIRED` and never fabricates a block number. |
| `TC-PG-14` | After a crashed lease expires, a surviving worker **re-acquires** and completes a verified commit (`blockNumber 777`). |

These tests write only the `reconciliation_locks` rows keyed by per-run unique
`lockKey`s and delete exactly those rows in `finally` (`DELETE FROM
reconciliation_locks WHERE "lockKey" = $1`); they never truncate or delete any
other table and never touch a production database.

> `TC-PG-04` (`reclaimStuckEvents`) assumes a clean database and is sensitive to
> accumulated state: each run MUST be preceded by
> `TRUNCATE TABLE "outbox_events","transaction_status_history","reconciliation_records","audit_logs","transactions","organizations" CASCADE;`.
> Without it the test fails with `Expected exactly one reclaim across both
> workers, got 14` — a stale-state artefact, not a double-reclaim defect.

---

### 6. Carried-Forward Conditions R-1 and R-2 (Status After Prompt 07)

These two conditions were raised by the Prompt 02.1 audit. In the Prompt 06
follow-up both gates were **executed against a live PostgreSQL** (Neon) and now
**PASS**; Prompt 07 extended R-1 to include the durable multi-worker lock.

| ID | Condition | Status after Prompt 07 |
|---|---|---|
| **R-1** | PostgreSQL live concurrency verification (concurrent claims, transaction/outbox atomicity, rollback, stale-event recovery, idempotency conflicts, **durable multi-worker reconciliation lock**). | **EXECUTED — PASS.** `TC-PG-01..14` ran against live PostgreSQL: **14 passed, 0 failed** (exit `0`), including cross-connection and cross-**process** lease exclusion, crash/expiry reclaim, heartbeat renewal, two-worker exactly-once reconciliation and ambiguous-result fail-closed. |
| **R-2** | `prisma migrate diff` (migrations vs. `schema.prisma` vs. live database). | **EXECUTED — PASS.** With the Prompt 07 `reconciliation_locks` migration applied, `migrate diff --from-migrations prisma/migrations --to-schema-datamodel --shadow-database-url "<shadow>"` and `migrate diff --from-url "<live DB>" --to-schema-datamodel` both print `No difference detected.` (exit `0`). Migrations ≡ schema ≡ live database. |

**R-2 drift was found and fixed.** `prisma migrate diff --from-empty
--to-schema-datamodel prisma/schema.prisma --script` emitted
`CREATE UNIQUE INDEX "transactions_organizationId_idempotencyKey_key"`, whereas
`prisma/migrations/20260101000000_baseline_init/migration.sql` creates
`CREATE UNIQUE INDEX "uq_org_idempotency_key"`. The cause was a Prisma modelling
detail: on `@@unique`, the `name:` argument names the **client-side** key only;
the **database** index name is derived from the field list unless `map:` is
given. The fix added `map: "uq_org_idempotency_key"` to `schema.prisma` —
a **datamodel-only, non-destructive** change: no migration was edited, no SQL was
executed, and existing databases are unaffected. After the fix the generated DDL
matches the migration exactly, `prisma validate` returns *valid*, and both live
diffs are empty.

> **A second, client-side defect was caught only by running against a real
> database.** An interim attempt to also set `name: "uq_org_idempotency_key"`
> silently renamed the Prisma Client compound accessor away from the default
> `organizationId_idempotencyKey`, which the repository code relies on
> (`findByIdempotencyKey`). `TC-PG-05` then failed with
> `Unknown argument 'organizationId_idempotencyKey' ... Available options are
> marked with ? uq_org_idempotency_key?`. Removing `name:` and keeping `map:`
> alone restored the default accessor and `TC-PG-05` passed. This confirms that
> live-database execution (not static inspection) is required to validate the
> datamodel/client contract.

**Durable crash/restart recovery: EXECUTED at the persistence layer (PASS).** On
the same live PostgreSQL, a two-process probe demonstrated that a crashed worker's
lease is recoverable across a real process restart:

1. **Phase A (process 1)** created a transaction + outbox event atomically,
   claimed the event (`claimBatch('worker-1')` → `status=PROCESSING`,
   `lockedBy=worker-1`) and then **exited without completing it** (simulated
   crash).
2. **Phase B (process 2, new `PrismaClient`)** re-read the durable state and ran
   `reclaimStuckEvents(1, now, 'recoverer-after-restart')`: the stale lease was
   re-leased to the recovering worker, and the transaction was confirmed **not**
   `COMMITTED` and `blockNumber` stayed `null` — no fabricated commit evidence.

**Still BLOCKED / not covered (unchanged).** Live Hyperledger Fabric
(`TC-FABRIC-21`) and **end-to-end** restart recovery against a real deployed
chaincode (the probe above and `TC-PG-14` cover the durable repository/lease and
lock layers only — the cross-restart `findTransactionByIdempotencyKey` chaincode
query is a UBTL-defined contract that is **not yet deployed or verified** against
a real network). Multi-worker reconciliation coordination is **no longer** in
this list: Prompt 07 supplies the durable `PostgresReconciliationLock`, verified
cross-process by `TC-PG-07..14`. Passing R-1/R-2 and the durable-lock tests does
**not** close the Fabric/chaincode gates.

