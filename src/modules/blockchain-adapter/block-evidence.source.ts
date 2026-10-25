/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * =============================================================================
 * BLOCK-LEVEL EVIDENCE SOURCE PORT (PROMPT 09.7)
 * =============================================================================
 *
 * A {@link BlockEvidenceSource} answers ONE question against a BLOCK-LEVEL
 * ledger source:
 *
 *     "Which block contains Fabric transaction <txId>, is that transaction
 *      valid, and what integrity metadata did it carry?"
 *
 * Legitimate implementations (in order of preference):
 *   1. System chaincode `qscc` via `GetBlockByTxID` (see
 *      `qscc-block-evidence.source.ts`), or `GetTransactionByID` + block lookup.
 *   2. A block explorer / ledger API operated outside the chaincode under test.
 *   3. Operator tooling: `peer channel fetch` followed by an independent block
 *      decode on the operator's machine.
 *
 * An implementation backed by the UBTL chaincode's `GetCommitProof` is NOT a
 * legitimate independent source and MUST declare `isIndependent = false`. The
 * verifier refuses such a source rather than trusting a chaincode's claim about
 * its own commit.
 *
 * TRANSFER NOTE: nothing here requires `@hyperledger/fabric-gateway` types; the
 * port is structural, so a test double (or an explorer HTTP client) can supply
 * evidence without a Fabric SDK.
 */

/** A transaction entry decoded from a real block, plus its block-level anchors. */
export interface DecodedBlockTransaction {
  /** Block number taken from the block header (MUST be > 0 for a real block). */
  blockNumber: number;
  /**
   * Block hash derived INDEPENDENTLY from the fetched block bytes (Fabric: the
   * SHA-256 digest of the block header). A source must never copy this from a
   * chaincode response.
   */
  blockHash: string;
  /** Transaction ID as recorded inside the block envelope. */
  fabricTransactionId: string;
  /** Fabric TxValidationCode (0 === VALID). */
  validationCode: number;
  /** `true` when the ledger marks the transaction as applied. */
  valid: boolean;
  /** Payload hash recovered from the committed chaincode arguments, if readable. */
  payloadHash: string | null;
  gatewayRequestId: string | null;
  idempotencyKey: string | null;
  transactionType: string | null;
  correlationId: string | null;
  /** Chaincode that was invoked by the transaction. */
  chaincodeName: string | null;
}

/** Result of a block-level lookup. Never throws for an ordinary miss. */
export type BlockEvidenceLookup =
  | { kind: 'FOUND'; transaction: DecodedBlockTransaction }
  | { kind: 'NOT_FOUND' }
  | { kind: 'EVIDENCE_UNAVAILABLE'; reason: string; errorCode: string }
  | { kind: 'TIMEOUT'; reason: string; errorCode: string };

export interface BlockEvidenceSource {
  /** Stable, non-secret name recorded in audit entries. */
  readonly sourceName: string;
  /**
   * MUST be `true` only for block-level sources. A source that reports
   * chaincode state (or an in-process cache) MUST declare `false`.
   */
  readonly isIndependent: boolean;
  /** Look up the block evidence for a Fabric transaction ID. */
  lookupTransaction(fabricTransactionId: string): Promise<BlockEvidenceLookup>;
}

/**
 * An explicit, safe stand-in for "the only evidence we have is the chaincode's
 * own record". It never returns FOUND: a chaincode cannot witness its own block.
 *
 * Use this when a deployment has no `qscc`/explorer access yet, so the failure
 * mode is an explicit `EVIDENCE_UNAVAILABLE` instead of an unverified success.
 */
export function createChaincodeStateEvidenceSource(reason: string): BlockEvidenceSource {
  return {
    sourceName: 'chaincode-state',
    isIndependent: false,
    async lookupTransaction(): Promise<BlockEvidenceLookup> {
      return {
        kind: 'EVIDENCE_UNAVAILABLE',
        reason,
        errorCode: 'CHAINCODE_STATE_IS_NOT_COMMIT_EVIDENCE',
      };
    },
  };
}

/** A source that is permanently unavailable (fail-closed placeholder). */
export function createUnavailableEvidenceSource(
  sourceName: string,
  reason: string,
  errorCode = 'EVIDENCE_SOURCE_UNAVAILABLE'
): BlockEvidenceSource {
  return {
    sourceName,
    isIndependent: true,
    async lookupTransaction(): Promise<BlockEvidenceLookup> {
      return { kind: 'EVIDENCE_UNAVAILABLE', reason, errorCode };
    },
  };
}
