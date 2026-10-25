# Universal Blockchain Transaction Ledger (UBTL)
## External Hyperledger Fabric Network Provider Requirements

### 1. Purpose & Scope
This document specifies the technical, operational, and cryptographic requirements for the **external network provider** managing the Hyperledger Fabric consortium network.

UBTL remains strictly provider-neutral: it interacts with the underlying network exclusively through the standardized Hyperledger Fabric Gateway client protocol (Fabric v2.4+/v2.5+). No proprietary SDKs or vendor-locked APIs are permitted.

---

### 2. Dual-Mode Operational Architecture

UBTL supports two operational modes controlled by `BLOCKCHAIN_ADAPTER_MODE`:

1. **Mock Mode (`BLOCKCHAIN_ADAPTER_MODE=mock`)**:
   - Zero external provider credentials required.
   - Built-in deterministic blockchain simulator for local development, CI/CD, and regression testing.
   - Simulates block proposal endorsements, commit event streams, and block height increments.

2. **Provider Mode (`BLOCKCHAIN_ADAPTER_MODE=provider`)**:
   - Connects to the external managed Hyperledger Fabric network provider.
   - **Fail-Fast Rule**: UBTL strictly validates all provider configuration parameters at process startup. If any required certificate, private key, or endpoint is missing or unreachable, the process aborts immediately with unambiguous diagnostic output.

---

### 3. Provider Technical Requirements Specification

#### 3.1 Fabric Gateway Protocol Compatibility
- **Gateway Version**: Hyperledger Fabric Gateway client protocol version **2.4.0 or higher** (preferred v2.5.x LTS).
- **Transport**: gRPC over HTTP/2.
- **Service Discovery**: The provider peer must support Fabric Gateway discovery or provide static endpoint addresses for all endorsing peers and orderers.

#### 3.2 Network Endpoint & TLS Trust Configuration
- **gRPC Endpoint**: Hostname and port (e.g., `peer0.org1.fabric-provider.net:7051`).
- **Server TLS CA Certificate**: Provider must supply a valid PEM-encoded root or intermediate CA certificate (`FABRIC_GATEWAY_TLS_CERT_PATH`) to establish trusted TLS channels.
- **Subject Alternative Name (SAN)**: The TLS certificate presented by the provider peer must match the endpoint hostname or have appropriate `ssl-target-name-override`.

#### 3.3 Client Identity & Credential Provisioning
- **MSP Identifier**: The Membership Service Provider identifier assigned to UBTL (e.g., `Org1MSP`, configured via `FABRIC_GATEWAY_MSP_ID`).
- **Client Enrollment Certificate**: An X.509 certificate in PEM format (`FABRIC_GATEWAY_CLIENT_CERT_PATH`) signed by the organization's Fabric CA.
- **Client Private Key**: An unencrypted PKCS#8 EC (P-256) or RSA private key (`FABRIC_GATEWAY_CLIENT_KEY_PATH`).
- **Certificate Renewal Lifecycle**: Provider must define automated enrollment / re-enrollment procedures (e.g. via Fabric CA Client or Vault) with at least 30 days renewal warning.

#### 3.4 Channel & Chaincode Access
- **Channel Name**: Specified via `FABRIC_GATEWAY_CHANNEL_NAME` (e.g., `ubtl-channel`).
- **Chaincode Name**: Specified via `FABRIC_GATEWAY_CHAINCODE_NAME` (e.g., `ubtl-ledger-cc`).
- **Contract Interface Functions** — the functions UBTL's adapter actually invokes.
  Names are defaults and may be remapped per provider; the *shape* is fixed.

  | Function | Kind | Arguments | Returns |
  | --- | --- | --- | --- |
  | `SubmitTransactionProposal` | submit | `payloadHash, transactionType, correlationId, timestamp, gatewayRequestId, idempotencyKey` | acknowledgement |
  | `GetCommitProof` | read-only | `fabricTransactionId` | JSON ledger record (see §3.6) |
  | `QueryTransactionByRequestId` | read-only | `gatewayRequestId` | JSON ledger record (see §3.6) |

  `SubmitTransactionProposal` **must be idempotent on `idempotencyKey`** so that a
  retried submission cannot record a duplicate ledger event.

  The previously listed `QueryTransactionByHash(payloadHash)` and
  `QueryTransactionById(fabricTxId)` remain useful provider-side/explorer
  helpers, but UBTL's adapter does not call them today.

  **Deployment prerequisite**: no UBTL chaincode is deployed or shipped by this
  repository. The three functions above are the *interface UBTL requires*; until
  a chaincode implementing them is deployed on the target channel, the adapter
  can submit proposals but its post-restart reconciliation queries will return
  no evidence and are reported as `PENDING` / `COMMIT_EVIDENCE_UNAVAILABLE`.

#### 3.5 Endorsement & Authorization Policies
- **Endorsement Policy**: Provider must configure chaincode endorsement policies requiring a quorum of consortium peers (e.g., `AND('Org1MSP.peer', 'Org2MSP.peer')`).
- **Gateway Endorsement Coordination**: The provider's Gateway peer must automatically route proposal endorsements to required peers and assemble the signed envelope for submission to the ordering service.

#### 3.6 Commit-Status Query Support (what the Gateway client protocol does and does not provide)
- The provider Gateway peer must implement the Fabric v2.4+ `CommitStatus` RPC protocol.
- When UBTL submits a transaction, the Gateway client obtains commit validation from
  `Commit.getStatus()` on the `SubmittedTransaction` returned by `submit()`:
  - `successful === true` **and** `blockNumber > 0`: the transaction is verified as
    written to a ledger block. UBTL records `VALID` (code `0`).
  - `successful === false`: the commit is definitively unsuccessful; UBTL preserves
    the Fabric validation code (e.g. `MVCC_READ_CONFLICT`, `BAD_CREATOR_SIGNATURE`)
    and classifies the transaction as `failed`.
  - Deadline expiry (gRPC status 4 / `DEADLINE_EXCEEDED`): the outcome is
    **ambiguous**; UBTL reports `TIMEOUT` and moves the transaction to
    `RECONCILIATION_REQUIRED`. It never reports failed or committed.

  **Important limitation**: `Commit.getStatus()` is only obtainable from the
  `SubmittedTransaction` handle returned by `submit()` **within the same process**.
  The Gateway client protocol exposes **no RPC to query commit status by
  transaction ID** for an arbitrary transaction. UBTL must therefore not assume
  such a capability exists.

- **Ledger record shape** returned by the read-only query functions. The record is
  the UBTL-defined reconciliation contract, not a Fabric primitive:

  ```json
  {
    "fabricTransactionId": "…",
    "payloadHash": "…(sha256 hex)…",
    "blockNumber": 15421,
    "blockHash": "…",
    "commitTimestamp": "2026-10-24T02:00:00.000Z",
    "mspId": "Org1MSP",
    "transactionType": "SALE",
    "correlationId": "…",
    "gatewayRequestId": "…"
  }
  ```

  UBTL treats a record as committed evidence only when `blockNumber > 0` and
  `payloadHash` is present.

#### 3.7 Reconciliation Contract
UBTL's reconciliation strategy is **UBTL-defined and is not a native Fabric
capability** (`docs/architecture.md` §4.3):

1. Fast path: process-local commit handle held by the adapter that submitted the
   transaction.
2. Fallback after a restart: the read-only chaincode queries `GetCommitProof`
   (by Fabric transaction ID) and `QueryTransactionByRequestId` (by UBTL gateway
   request ID), returning the §3.6 record. This relies on read-your-write
   semantics against Fabric world state and therefore **requires the chaincode
   from §3.4 to be deployed**.

If neither path yields evidence, UBTL reports the transaction as pending with
`COMMIT_EVIDENCE_UNAVAILABLE` and retains it for operator reconciliation. It
never fabricates a commit.

The provider must additionally support block height inquiries and block event
subscription for continuous audit reconciliation.


#### 3.8 Availability, Backup, Recovery, and Audit Export
- **Service Level Agreement (SLA)**: Minimum 99.95% uptime for peer and orderer endpoints.
- **Consensus Redundancy**: Raft ordering service with at least 3 (preferably 5) consensus nodes across separate availability zones.
- **Snapshot Retention**: Ledger data snapshot and state database (CouchDB/LevelDB) backups retained for minimum 7 years per financial record retention standards.
- **Audit Export**: Provider must provide cryptographically signed ledger block dumps upon regulatory request.

---

### 4. Provider Startup Validation Checklist

When `BLOCKCHAIN_ADAPTER_MODE=provider`, UBTL executes this checklist during initialization:
1. `FABRIC_GATEWAY_PEER_ENDPOINT` is non-empty and resolves via DNS.
2. `FABRIC_GATEWAY_MSP_ID` is defined.
3. `FABRIC_GATEWAY_CHANNEL_NAME` and `FABRIC_GATEWAY_CHAINCODE_NAME` are defined.
4. `FABRIC_GATEWAY_TLS_CERT_PATH` exists on filesystem and is a valid PEM certificate.
5. `FABRIC_GATEWAY_CLIENT_CERT_PATH` exists and is a valid X.509 certificate.
6. `FABRIC_GATEWAY_CLIENT_KEY_PATH` exists and is a valid private key.
7. TCP/TLS connection handshake to peer endpoint completes within 5000ms.
8. Test proposal query executes successfully.

---

### 5. Live-Acceptance Prerequisites (Prompt 09.8)

**Status: implementation-ready, live integration BLOCKED.**

UBTL's independent commit verification is implemented and fully covered by
fixture tests (see `test/run-all-tests.ts`, suites `FabricBlockDecoder` and
`CommitVerifier`, cases `TC-DECODE-01..12`): a transaction can only become
`VERIFIED_COMMITTED` on complete, independent, self-consistent block-level
evidence, and an invalid or incomplete block can never become `CONFIRMED`.
However, **none of the following external prerequisites has been supplied**, so
no live Fabric acceptance can be claimed:

| # | Prerequisite (owner) | Required by | Available? |
| --- | --- | --- | --- |
| P-1 | Peer gRPC endpoint (host:port) reachable from UBTL (`FABRIC_GATEWAY_PEER_ENDPOINT`) | Gateway connection | **NO** |
| P-2 | Server TLS CA certificate + matching SAN / target-name override (`FABRIC_GATEWAY_TLS_CERT_PATH`) | TLS trust | **NO** |
| P-3 | UBTL client enrolment certificate + private key (`FABRIC_GATEWAY_CLIENT_CERT_PATH`, `..._KEY_PATH`) and MSP ID | Identity | **NO** |
| P-4 | Target channel name (`FABRIC_GATEWAY_CHANNEL_NAME`) with the UBTL identity enrolled on it | Channel | **NO** |
| P-5 | Deployed chaincode implementing `SubmitTransactionProposal`, `GetCommitProof`, `QueryTransactionByRequestId` (§3.4) | Submit + reconciliation | **NO** |
| P-6 | **`qscc` `GetBlockByTxID` permission** for the UBTL identity on the target channel (system chaincode; commonly policy-restricted) | Independent block-level commit verification | **NO** |
| P-7 | Discovery or static endorsing-peer / orderer addresses (§3.1) | Endorsement routing | **NO** |
| P-8 | One real block decoded by UBTL's decoder to confirm the protobuf field-number map (the decoder's only offline-unverifiable assumption) | Decoder acceptance | **NO** |

Notes:
- P-6 is **new in Prompt 09.8**. Without it, UBTL cannot obtain independent
  block-level evidence and therefore cannot confirm a commit; there is
  deliberately **no fallback** to chaincode state (`GetCommitProof` is not
  accepted as commit evidence). If a provider denies `qscc`, an equivalent
  block-level source (block-explorer API, or operator `peer channel fetch` +
  offline decode) must be supplied instead.
- Until **all** of P-1..P-8 are available, UBTL stays fail-closed: the
  `qscc` evidence transport is never constructed by the running server and the
  injected verifier reports `EVIDENCE_UNAVAILABLE` for every lookup.
- The server also requires production secrets (`JWT_SECRET`,
  `GATEWAY_WEBHOOK_SHARED_SECRET`, `GATEWAY_OUTBOUND_SHARED_SECRET`) to be
  provisioned locally by the operator before startup; that is an environment
  task, not a network-provider deliverable.
