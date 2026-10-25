# UBTL Ledger Chaincode — Contract Specification

**Status:** DRAFT — spec + locally-tested reference implementation.
**Deployment status:** NOT DEPLOYED. No chaincode exists on any Fabric network.
**Compatibility claim:** NONE. No target network has been provided, so
compatibility with any specific peer / chaincode-runtime version is UNVERIFIED.

Related code:
- `src/types.ts` — ledger port, record schema, error codes
- `src/contract.ts` — contract logic (`UbtlLedgerContract`)
- `src/fabric-binding.ts` — Fabric stub binding (`createLedgerContextFromStub`)
- `test/contract.test.ts` — 10 local acceptance tests

---

## 1. Why the chaincode lives in this repository

The UBTL adapter (`src/modules/blockchain-adapter/fabric-adapter.ts`) invokes
three contract functions **by name**. Until a chaincode implementing them exists
on a real network, provider mode can never function. This directory is the
integration-side deliverable: an explicit, testable specification plus a
reference implementation that the chaincode owner can adopt, adapt or replace.

Nothing here changes application state, connects to a network, or enables
provider mode.

---

## 2. Language / framework decision

| Candidate | Locally testable here | Decision |
|---|---|---|
| Go (`fabric-contract-api-go`) | No — Go toolchain is **not installed** on this workstation | Not selected for the reference implementation |
| Node.js (`fabric-shim` / `fabric-contract-api`) | Yes — Node 22 + `tsx` + `tsc` are present and the repository is already TS/ESM | **Selected** |
| Java | No JDK/toolchain verified | Not selected |

The reference implementation separates **pure contract logic** (no framework
types) from a **structural stub binding**, so it can be unit-tested with an
in-memory fake instead of a Fabric peer. The same logic binds to
`fabric-shim` at deployment time via `createLedgerContextFromStub()`.

> Node.js chaincode requires the target peer to provide a Node chaincode
> runtime. Whether the eventual network does so is an **open item owned by the
> network administrator** (§10).

---

## 3. Function contracts

Function names are the adapter defaults
(`DEFAULT_FABRIC_CHAINCODE_FUNCTIONS` in `fabric-adapter.ts`) and are
configurable only by changing the adapter, not the chaincode.

### 3.1 `SubmitTransactionProposal`

**Type:** invoke (writes state). **Idempotent on `idempotencyKey`.**

Positional arguments, in this exact order — they match
`buildLedgerArguments()` in the adapter:

| # | Argument | Type | Validation |
|---|---|---|---|
| 0 | `payloadHash` | string | `^[0-9a-f]{64}$` (lowercase hex SHA-256) |
| 1 | `transactionType` | string | non-empty, ≤ 64, `^[A-Za-z0-9_.:-]+$` |
| 2 | `correlationId` | string | non-empty, ≤ 128 |
| 3 | `timestamp` | string | non-empty, ≤ 64, ISO-8601 parseable |
| 4 | `gatewayRequestId` | string | non-empty, ≤ 128 |
| 5 | `idempotencyKey` | string | non-empty, ≤ 128; **defaults to `gatewayRequestId`** when empty |

**Return:** the stored record as a JSON `Uint8Array` (§4).

**Behaviour**

| Case | Result |
|---|---|
| Key absent | Create record; write primary + 2 reverse indexes |
| Key present, same `payloadHash` | Return the **existing** record unchanged. No second logical record. |
| Key present, different `payloadHash` | `IDEMPOTENCY_CONFLICT` (permanent) |
| `gatewayRequestId` already bound to a different key | `IDEMPOTENCY_CONFLICT` (permanent) |
| Any argument invalid | `INVALID_ARGUMENT` (permanent); **no partial state written** |

**Critical:** the return value is **not** commit evidence. The adapter ignores it
and reports `PENDING` from the orderer submission. Do not treat a returned record
as proof of commit.

### 3.2 `QueryTransactionByRequestId`

**Type:** read-only (`evaluateTransaction`). **Argument:** `gatewayRequestId` (string).

**Return:** the record JSON, or an **empty payload** on a miss.

> The empty payload is the agreed miss representation: the adapter's
> `parseLedgerRecord()` maps an empty/`null` response to `null` and never
> fabricates a ledger state. Do **not** return an error for a miss.

Inconsistent state (index → missing record, record/request mismatch, unsupported
schema, malformed stored hash) is raised explicitly as `INCONSISTENT_RECORD`,
never silently returned as a miss.

### 3.3 `GetCommitProof`

**Type:** read-only. **Argument:** `fabricTransactionId` (string).

**Return:** the proof JSON (§5), or an **empty payload** when the transaction id
is unknown or the transaction was never recorded by this chaincode.

---

## 4. On-ledger record schema (schemaVersion 1)

```json
{
  "schemaVersion": 1,
  "idempotencyKey": "…",
  "gatewayRequestId": "…",
  "payloadHash": "64-hex",
  "transactionType": "PURCHASE_ORDER",
  "correlationId": "…",
  "clientTimestamp": "2026-10-25T12:00:00.000Z",
  "fabricTransactionId": "…",
  "submittingMspId": "UBTLMSP",
  "ledgerWriteTimestamp": "2026-10-25T12:00:03.120Z"
}
```

Deliberately **absent**: business payloads, documents, personal data, and all
block-level fields. Only integrity metadata is on-chain.

**State keys** (deterministic, no scanning):

| Key | Value |
|---|---|
| `UBTL_TX~<idempotencyKey>` | record JSON (primary) |
| `UBTL_REQ~<gatewayRequestId>` | `idempotencyKey` |
| `UBTL_FTX~<fabricTransactionId>` | `idempotencyKey` |

Range queries are never required; every lookup is a point read.

---

## 5. Commit-proof design (and its explicit limitation)

```json
{
  "…record fields…",
  "proofSource": "CHAINCODE_STATE",
  "blockEvidence": "UNAVAILABLE_FROM_CHAINCODE",
  "blockNumber": null,
  "blockHash": null,
  "commitTimestamp": null
}
```

**Rationale.** A chaincode executes *before* the block containing its
transaction exists, so it cannot know that block's number or hash. Fabric's
chaincode API exposes no block-lookup call. Therefore this contract
**refuses to invent** `blockNumber`, `blockHash` or `commitTimestamp`, and marks
its own provenance and limitation in the response.

**Where block evidence legitimately comes from:**

1. **In-process (same adapter run):** the Gateway's
   `SubmittedTransaction.getStatus()` → `{ successful, blockNumber }`. This is a
   real Fabric response and is what the adapter uses today.
2. **Independent verification (required for claims of independent success):**
   a block-level ledger source — the system chaincode `qscc`
   (`GetBlockByTxID` / `GetTransactionByID`), a block explorer, or an operator
   `peer channel fetch`. The client computes the block hash from the fetched
   block and compares it to the recorded anchor.
3. **After adapter restart:** only (2) can recover block evidence; (1) is
   process-local and is intentionally discarded.

**Honest consequence:** the adapter's existing fallback path
(`queryCommitStatus` → `GetCommitProof` → `CONFIRMED if blockNumber > 0`) can
**never** yield `CONFIRMED` with an honest chaincode, because this contract
returns `blockNumber: null`. That fallback currently treats a chaincode-supplied
`blockNumber` as commit evidence **without independent verification** — see
Phase D findings in the PROMPT 09.6 report. A `qscc`-based verifier does not
exist in the repository today.

---

## 6. Error taxonomy

| Chaincode code | Meaning | Adapter classification |
|---|---|---|
| `INVALID_ARGUMENT` | malformed argument | PERMANENT |
| `IDEMPOTENCY_CONFLICT` | key reused with a different payload | PERMANENT |
| `INCONSISTENT_RECORD` | ledger state contradicts itself | PERMANENT |
| `UNAUTHORIZED_MSP` | caller MSP not permitted | PERMANENT |

Permanent errors must **not** be retried indefinitely by the outbox worker.
Transient/ambiguous conditions (peer unavailable, deadline exceeded) are raised
by the runtime, not by this contract, and remain the adapter's responsibility.

---

## 7. Idempotency & reconciliation

- The adapter is required to preserve the **original** `gatewayRequestId` and
  `idempotencyKey` across every retry.
- Fabric assigns a **new** transaction id per retry; the chaincode therefore keys
  on `idempotencyKey`, not on the Fabric transaction id.
- An ambiguous submit (deadline exceeded) followed by a retry with the same
  anchors is safe: the second invocation returns the first record unchanged.
- The `UBTL_FTX~` index of the *first* attempt is retained; a later retry does not
  orphan it, and `QueryTransactionByRequestId` remains the authoritative lookup.

---

## 8. Binding & deployment notes (not performed here)

`createFabricContractClass()` is **not** invoked in this repository. A deployment
would, on the chaincode owner's side:

1. Add `fabric-shim` / `fabric-contract-api` to a dedicated chaincode package.
2. Wrap `UbtlLedgerContract` in a `Contract` subclass whose methods receive
   `ctx.stub`, map it via `createLedgerContextFromStub(ctx.stub)`, and pass the
   positional arguments through verbatim.
3. Package for the target runtime (`peer lifecycle chaincode package`), install,
   approve, and commit on the channel — **none of which is authorised here**.

**Open items (owner: network administrator / chaincode owner):** chaincode
runtime (Node vs Go), endorsement policy, channel name, chaincode name, and the
MSP IDs allowed to submit/query.

---

## 9. Acceptance criteria ↔ tests

| # | Requirement | Test |
|---|---|---|
| 1 | First submit → one logical record | `01` |
| 2 | Replay (same key + hash) → no duplicate | `02` |
| 3 | Same key + different hash → `IDEMPOTENCY_CONFLICT` | `03` |
| 4 | Unknown request id → miss | `04` |
| 5 | Invalid input rejected, no partial state | `05` |
| 6 | Hash mismatch never yields a confirmed status | `06` |
| 7 | No proof before a verified commit | `07` |
| 8 | MSP policy on invoke and query | `08` |
| 9 | Schema version + record compatibility | `09` |
| 10 | Reconciliation after ambiguous submit | `10` |

Run locally (no peer, no Docker, no credentials):

```powershell
node --import tsx --test chaincode/ubtl-ledger/test/contract.test.ts
```

---

## 10. Open items / blockers

| Item | Owner | Status |
|---|---|---|
| Chaincode deployed on a real channel | Chaincode owner | BLOCKED |
| Channel / chaincode names + endorsement policy | Network administrator | BLOCKED |
| Permitted MSP IDs for submit/query | Network administrator | BLOCKED |
| Chaincode runtime language confirmed for the target peer | Network administrator | BLOCKED |
| Independent (`qscc` / explorer) commit verifier in the adapter | UBTL maintainers | NOT IMPLEMENTED |
| Real Fabric network reachable from UBTL | Network administrator | BLOCKED |

No Fabric commit success is claimed by this document. The ledger remains
simulated (`BLOCKCHAIN_ADAPTER_MODE=mock`).
