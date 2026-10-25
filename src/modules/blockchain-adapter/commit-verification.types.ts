/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * =============================================================================
 * INDEPENDENT COMMIT VERIFICATION — RESULT CONTRACT (PROMPT 09.7)
 * =============================================================================
 *
 * WHY THIS EXISTS
 *   UBTL may only report a transaction as CONFIRMED when an INDEPENDENT
 *   block-level ledger source proves that the transaction was committed AND
 *   applied (Fabric validation code 0). A chaincode response is NOT such a
 *   source: a chaincode executes before its own block exists, so it can neither
 *   know the block number nor the block hash. Treating a chaincode-supplied
 *   block number as commit evidence is exactly the defect this contract closes.
 *
 * VERDICT VOCABULARY
 *   These verdicts are deliberately distinct from `CommitStatusResult.status`
 *   (`CONFIRMED | PENDING | FAILED | TIMEOUT`). A verdict describes what was
 *   PROVEN, not what was ASSUMED:
 *
 *     VERIFIED_COMMITTED   committed and valid, all mandatory checks passed
 *     VERIFIED_INVALID     present in a block but not applied (validation != 0)
 *     NOT_FOUND            no ledger record yet — retryable, NEVER a failure
 *     EVIDENCE_UNAVAILABLE evidence source absent/unusable (incl. chaincode-only)
 *     INCONSISTENT_EVIDENCE evidence contradicts itself or the expectation
 *     TIMEOUT              the query did not complete in time — ambiguous
 *
 *   `verified === true` (i.e. `VERIFIED_COMMITTED`) is the ONLY verdict that may
 *   drive a business transition to COMMITTED.
 */

export type CommitVerificationVerdict =
  | 'VERIFIED_COMMITTED'
  | 'VERIFIED_INVALID'
  | 'NOT_FOUND'
  | 'EVIDENCE_UNAVAILABLE'
  | 'INCONSISTENT_EVIDENCE'
  | 'TIMEOUT';

/** Identity and expectations a verification call is judged against. */
export interface CommitExpectation {
  /** Fabric transaction ID to look up in the ledger. */
  fabricTransactionId: string;
  /** UBTL gateway request ID (durable anchor). Optional for anchor-less probes. */
  gatewayRequestId?: string;
  /** UBTL idempotency key. Optional. */
  idempotencyKey?: string;
  /**
   * The authoritative payload hash UBTL persisted. When supplied, the ledger
   * value is compared against it and a mismatch can never be CONFIRMED.
   */
  expectedPayloadHash?: string;
}

/** Evidence read from block-level ledger data (never from chaincode state alone). */
export interface VerifiedCommitEvidence {
  fabricTransactionId: string;
  blockNumber: number;
  blockHash: string;
  /** Fabric TxValidationCode (0 === VALID). */
  validationCode: number;
  /** `true` when the ledger itself reports the transaction as applied. */
  valid: boolean;
  /** Payload hash recovered from the committed transaction args, when readable. */
  payloadHash: string | null;
  gatewayRequestId: string | null;
  idempotencyKey: string | null;
  transactionType: string | null;
  correlationId: string | null;
  chaincodeName: string | null;
  /** Name of the block-level source that produced this evidence. */
  evidenceSource: string;
}

/**
 * Individual checks. EVERY field except `payloadHashMatched` must be true for a
 * verdict of VERIFIED_COMMITTED; `payloadHashMatched` must be `true` whenever a
 * comparison was requested (`payloadHashCompared === true`).
 */
export interface CommitVerificationChecks {
  sourceIsIndependent: boolean;
  transactionFound: boolean;
  blockEvidencePresent: boolean;
  blockNumberPositive: boolean;
  blockHashPresent: boolean;
  transactionIdMatches: boolean;
  validationCodeValid: boolean;
  payloadHashCompared: boolean;
  /** `null` when no comparison was requested. */
  payloadHashMatched: boolean | null;
}

export interface CommitVerificationResult {
  verdict: CommitVerificationVerdict;
  fabricTransactionId: string;
  evidence: VerifiedCommitEvidence | null;
  checks: CommitVerificationChecks;
  /** Human-readable list of every failed/contradictory check (auditable alert). */
  mismatches: string[];
  evidenceSource: string | null;
  /** True ONLY for VERIFIED_COMMITTED. */
  verified: boolean;
  /** Never a simulated result: this contract is provider-mode only. */
  isSimulated: false;
  errorCode?: string;
  errorMessage?: string;
}

/** One auditable record per verification decision. Contains no secrets. */
export interface CommitVerificationDecision {
  verdict: CommitVerificationVerdict;
  fabricTransactionId: string;
  gatewayRequestId: string | null;
  idempotencyKey: string | null;
  evidenceSource: string | null;
  blockNumber: number | null;
  blockHash: string | null;
  mismatches: string[];
  checks: CommitVerificationChecks;
  errorCode: string | null;
  errorMessage: string | null;
  decidedAt: string;
}

/**
 * Optional durable/audit sink. Implementations MUST NOT throw into the
 * verification path: an audit failure may never change a verdict.
 */
export interface CommitVerificationAuditSink {
  record(decision: CommitVerificationDecision): void;
}

/**
 * The verifier port consumed by the adapter, the outbox worker and the
 * reconciliation job. Implementations are provider-neutral: they depend only on
 * a {@link BlockEvidenceSource} (`block-evidence.source.ts`).
 */
export interface CommitVerifier {
  readonly verifierName: string;
  verifyCommit(expectation: CommitExpectation): Promise<CommitVerificationResult>;
}
