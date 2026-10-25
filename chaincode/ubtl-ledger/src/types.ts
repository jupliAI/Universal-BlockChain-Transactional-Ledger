/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * =============================================================================
 * UBTL LEDGER CHAINCODE — FRAMEWORK-NEUTRAL PORT & RECORD SCHEMA
 * =============================================================================
 *
 * This module declares the ledger-facing contract of the UBTL chaincode WITHOUT
 * depending on any Fabric chaincode framework (fabric-shim /
 * fabric-contract-api). The runtime binding is supplied by
 * `fabric-binding.ts`, which maps a Fabric `ChaincodeStub` onto this port.
 *
 * WHY THIS SPLIT:
 *   The contract logic must be unit-testable on a plain workstation with no
 *   Fabric peer, no Docker network and no chaincode runtime. Keeping the logic
 *   free of framework types makes that possible while still allowing the same
 *   code to be bound to a real peer at deployment time.
 *
 * DEPLOYMENT ASSUMPTION (NOT CLAIMED AS VERIFIED):
 *   The intended runtime is a Hyperledger Fabric v2.x peer with the Node.js
 *   chaincode runtime available (`fabric-shim`). No target network has been
 *   provided, so compatibility with any specific peer/nodeenv version is
 *   UNVERIFIED. See `CHAINCODE_CONTRACT.md` §8.
 *
 * ON-CHAIN DATA MINIMISATION:
 *   Only integrity metadata is written to the ledger. Business documents and
 *   sensitive payloads NEVER enter chaincode state — only their SHA-256 digest
 *   plus opaque correlation identifiers.
 */

/** Schema version of the on-ledger record. Bump only with a documented migration. */
export const UBTL_LEDGER_SCHEMA_VERSION = 1;

/** Error codes returned to the adapter. Mapped onto UBTL's permanent/transient taxonomy. */
export const UbtlLedgerErrorCode = {
  /** Malformed or missing argument. Permanent — retrying cannot succeed. */
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  /** Same idempotency key re-used with a different payload hash. Permanent. */
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  /** Reverse index points at a record that is missing or does not match. Permanent. */
  INCONSISTENT_RECORD: 'INCONSISTENT_RECORD',
  /** Caller MSP is not permitted to invoke this function. Permanent. */
  UNAUTHORIZED_MSP: 'UNAUTHORIZED_MSP',
} as const;
export type UbtlLedgerErrorCode =
  (typeof UbtlLedgerErrorCode)[keyof typeof UbtlLedgerErrorCode];

export class UbtlLedgerError extends Error {
  public readonly code: UbtlLedgerErrorCode;
  constructor(code: UbtlLedgerErrorCode, message: string) {
    super(message);
    this.name = 'UbtlLedgerError';
    this.code = code;
  }
}

/**
 * The record persisted on-ledger. Deliberately contains NO block number, block
 * hash or commit timestamp: a chaincode cannot observe the block that will
 * contain its own transaction. Block-level evidence is obtained outside the
 * chaincode (see `CHAINCODE_CONTRACT.md` §5).
 */
export interface UbtlTransactionRecord {
  schemaVersion: number;
  idempotencyKey: string;
  gatewayRequestId: string;
  payloadHash: string;
  transactionType: string;
  correlationId: string;
  clientTimestamp: string;
  fabricTransactionId: string;
  submittingMspId: string;
  ledgerWriteTimestamp: string;
}

/** Provenance marker for the commit-proof response. */
export const COMMIT_PROOF_SOURCE = 'CHAINCODE_STATE' as const;
export type CommitProofSource = typeof COMMIT_PROOF_SOURCE;

/** Explicit statement that block-level evidence is not obtainable in-chaincode. */
export const BLOCK_EVIDENCE_UNAVAILABLE = 'UNAVAILABLE_FROM_CHAINCODE' as const;

/**
 * Response of `GetCommitProof`. It is honest about its own limits: it proves a
 * record EXISTS on the ledger, and explicitly reports that block number, block
 * hash and commit timestamp are NOT available from chaincode state.
 */
export interface UbtlCommitProof {
  schemaVersion: number;
  gatewayRequestId: string;
  idempotencyKey: string;
  fabricTransactionId: string;
  payloadHash: string;
  transactionType: string;
  correlationId: string;
  submittingMspId: string;
  ledgerWriteTimestamp: string;
  proofSource: CommitProofSource;
  blockEvidence: typeof BLOCK_EVIDENCE_UNAVAILABLE;
  blockNumber: null;
  blockHash: null;
  commitTimestamp: null;
}

/**
 * Ledger access port. Implemented by `createLedgerContextFromStub()` for a real
 * Fabric stub, and by an in-memory fake in the unit tests.
 */
export interface LedgerContext {
  /** Read a key. Returns `null` when the key is absent or holds an empty value. */
  getState(key: string): Promise<Uint8Array | null>;
  /** Write a key. */
  putState(key: string, value: Uint8Array): Promise<void>;
  /** Fabric transaction ID assigned to the currently executing invocation. */
  getTransactionId(): string;
  /** MSP ID of the invoking identity. */
  getMspId(): string;
  /** Invocation timestamp as an ISO-8601 UTC string. */
  getTimestampIso(): string;
}

/**
 * Structural mirror of the subset of Fabric's `ChaincodeStub` this chaincode
 * uses. Declared structurally so no framework type leaks into the core.
 */
export interface FabricStubLike {
  getState(key: string): Promise<Uint8Array>;
  putState(key: string, value: Uint8Array): Promise<void>;
  getTxId(): string;
  getMspId(): string;
  /** Protobuf Timestamp; `seconds` may be a Long-like object in some runtimes. */
  getTxTimestamp(): {
    seconds: number | { low: number; high: number; unsigned?: boolean };
    nanos: number;
  };
}

/** Deterministic state-key prefixes. */
export const STATE_KEY_PREFIX = {
  /** Primary record keyed by idempotency key: `UBTL_TX~<idempotencyKey>`. */
  RECORD: 'UBTL_TX~',
  /** Reverse index gateway request id -> idempotency key: `UBTL_REQ~<gatewayRequestId>`. */
  REQUEST_INDEX: 'UBTL_REQ~',
  /** Reverse index Fabric transaction id -> idempotency key: `UBTL_FTX~<fabricTransactionId>`. */
  FABRIC_TX_INDEX: 'UBTL_FTX~',
} as const;

export function recordKey(idempotencyKey: string): string {
  return `${STATE_KEY_PREFIX.RECORD}${idempotencyKey}`;
}

export function requestIndexKey(gatewayRequestId: string): string {
  return `${STATE_KEY_PREFIX.REQUEST_INDEX}${gatewayRequestId}`;
}

export function fabricTxIndexKey(fabricTransactionId: string): string {
  return `${STATE_KEY_PREFIX.FABRIC_TX_INDEX}${fabricTransactionId}`;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

export function encodeUtf8(value: string): Uint8Array {
  return encoder.encode(value);
}

export function decodeUtf8(value: Uint8Array): string {
  return decoder.decode(value);
}
