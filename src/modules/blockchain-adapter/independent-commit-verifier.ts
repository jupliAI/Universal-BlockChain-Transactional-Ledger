/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * =============================================================================
 * INDEPENDENT COMMIT VERIFIER (PROMPT 09.7)
 * =============================================================================
 *
 * Pure decision logic. It consumes a {@link BlockEvidenceSource} and answers a
 * single question: "is this Fabric transaction PROVABLY committed and valid for
 * THIS payload hash?"
 *
 * GUARANTEES
 *  - `VERIFIED_COMMITTED` requires ALL of: an independent source, a found
 *    transaction, a positive block number, a non-empty block hash, a matching
 *    transaction ID, Fabric validation code 0, and (when an expectation was
 *    supplied) an identical payload hash.
 *  - A chaincode-state source (`isIndependent === false`) can never produce
 *    `VERIFIED_COMMITTED` — `GetCommitProof` is NOT accepted as commit evidence.
 *  - A transaction ID alone, a block number alone, or a chaincode record alone
 *    are each insufficient.
 *  - `NOT_FOUND` is explicitly retryable and is NEVER reported as a permanent
 *    failure: ordering + commit latency means absence of evidence is not
 *    evidence of failure.
 *  - `TIMEOUT` and `EVIDENCE_UNAVAILABLE` are ambiguous and never success.
 *  - This class never throws for an evidential reason; it throws only for a
 *    programmer error (e.g. a missing source), which is a fail-fast defect.
 */

import {
  BlockEvidenceLookup,
  BlockEvidenceSource,
} from './block-evidence.source.ts';
import {
  CommitExpectation,
  CommitVerificationAuditSink,
  CommitVerificationChecks,
  CommitVerificationDecision,
  CommitVerificationResult,
  CommitVerifier,
  VerifiedCommitEvidence,
} from './commit-verification.types.ts';

const PAYLOAD_HASH_PATTERN = /^[0-9a-f]{64}$/;

export interface IndependentCommitVerifierOptions {
  /** Optional audit sink. Failures inside the sink never change a verdict. */
  auditSink?: CommitVerificationAuditSink;
  /** Injectable clock (ISO-8601 timestamps only; no secrets involved). */
  now?: () => string;
}

export class IndependentCommitVerifier implements CommitVerifier {
  readonly verifierName = 'independent-commit-verifier';

  private readonly source: BlockEvidenceSource;
  private readonly auditSink?: CommitVerificationAuditSink;
  private readonly nowFn: () => string;

  constructor(source: BlockEvidenceSource, options: IndependentCommitVerifierOptions = {}) {
    if (!source || typeof source.lookupTransaction !== 'function') {
      throw new Error(
        '[COMMIT_VERIFIER_FAIL_FAST] IndependentCommitVerifier requires a BlockEvidenceSource.'
      );
    }
    this.source = source;
    this.auditSink = options.auditSink;
    this.nowFn = options.now ?? (() => new Date().toISOString());
  }

  async verifyCommit(expectation: CommitExpectation): Promise<CommitVerificationResult> {
    const result = await this.evaluate(expectation);
    this.emitDecision(expectation, result);
    return result;
  }

  // -------------------------------------------------------------------------
  // Decision logic
  // -------------------------------------------------------------------------

  private async evaluate(expectation: CommitExpectation): Promise<CommitVerificationResult> {
    const fabricTransactionId = expectation.fabricTransactionId;
    const base = emptyChecks(this.source.isIndependent);

    if (typeof fabricTransactionId !== 'string' || fabricTransactionId.trim() === '') {
      return this.build('EVIDENCE_UNAVAILABLE', expectation, null, base, [], {
        errorCode: 'INVALID_TRANSACTION_ID',
        errorMessage: 'A non-empty Fabric transaction ID is required to verify a commit.',
      });
    }

    // A malformed expectation makes the payload-hash comparison impossible. We
    // refuse to compare (rather than comparing against garbage) and never
    // confirm: an unverifiable expectation is missing evidence.
    if (
      expectation.expectedPayloadHash !== undefined &&
      expectation.expectedPayloadHash !== null &&
      !PAYLOAD_HASH_PATTERN.test(expectation.expectedPayloadHash)
    ) {
      return this.build('EVIDENCE_UNAVAILABLE', expectation, null, base, [], {
        errorCode: 'MALFORMED_EXPECTED_PAYLOAD_HASH',
        errorMessage:
          'expectedPayloadHash is not a 64-character lowercase hexadecimal SHA-256 digest; payload comparison was refused.',
      });
    }

    let lookup: BlockEvidenceLookup;
    try {
      lookup = await this.source.lookupTransaction(fabricTransactionId);
    } catch (err: unknown) {
      const timedOut = isTimeoutError(err);
      return this.build(
        timedOut ? 'TIMEOUT' : 'EVIDENCE_UNAVAILABLE',
        expectation,
        null,
        base,
        [],
        {
          errorCode: timedOut ? 'EVIDENCE_QUERY_TIMEOUT' : 'EVIDENCE_QUERY_FAILED',
          errorMessage: sanitize(err),
        }
      );
    }

    if (lookup.kind === 'NOT_FOUND') {
      return this.build('NOT_FOUND', expectation, null, base, [], {
        errorCode: 'LEDGER_TRANSACTION_NOT_FOUND',
        errorMessage:
          'No block-level ledger evidence for this transaction yet; ordering or commit latency may still be pending.',
      });
    }

    if (lookup.kind === 'EVIDENCE_UNAVAILABLE') {
      return this.build('EVIDENCE_UNAVAILABLE', expectation, null, base, [], {
        errorCode: lookup.errorCode,
        errorMessage: lookup.reason,
      });
    }

    if (lookup.kind === 'TIMEOUT') {
      return this.build('TIMEOUT', expectation, null, base, [], {
        errorCode: lookup.errorCode,
        errorMessage: lookup.reason,
      });
    }

    // FOUND — evaluate every mandatory check.
    const tx = lookup.transaction;
    const expectedHash = expectation.expectedPayloadHash;
    const payloadHashCompared = PAYLOAD_HASH_PATTERN.test(expectedHash ?? '');
    const payloadHashMatched = payloadHashCompared
      ? tx.payloadHash === expectedHash
      : null;

    const checks: CommitVerificationChecks = {
      sourceIsIndependent: this.source.isIndependent === true,
      transactionFound: true,
      blockEvidencePresent: true,
      blockNumberPositive: Number.isInteger(tx.blockNumber) && tx.blockNumber > 0,
      blockHashPresent: typeof tx.blockHash === 'string' && tx.blockHash.trim() !== '',
      transactionIdMatches: tx.fabricTransactionId === fabricTransactionId,
      validationCodeValid: tx.valid === true && Number(tx.validationCode) === 0,
      payloadHashCompared,
      payloadHashMatched,
    };

    const mismatches = collectMismatches(checks, tx);
    const evidence: VerifiedCommitEvidence = {
      fabricTransactionId: tx.fabricTransactionId,
      blockNumber: tx.blockNumber,
      blockHash: tx.blockHash,
      validationCode: tx.validationCode,
      valid: tx.valid,
      payloadHash: tx.payloadHash,
      gatewayRequestId: tx.gatewayRequestId,
      idempotencyKey: tx.idempotencyKey,
      transactionType: tx.transactionType,
      correlationId: tx.correlationId,
      chaincodeName: tx.chaincodeName,
      evidenceSource: this.source.sourceName,
    };

    // Evaluation order is deliberate: structural contradictions first (they
    // invalidate the evidence itself), then a definitive ledger invalidity,
    // then missing/unmatched integrity metadata.
    if (!checks.sourceIsIndependent) {
      return this.build(
        'EVIDENCE_UNAVAILABLE',
        expectation,
        evidence,
        checks,
        mismatches,
        {
          errorCode: 'SOURCE_NOT_INDEPENDENT',
          errorMessage:
            'The evidence source is not block-level independent; a chaincode record can never prove a commit.',
        }
      );
    }

    if (!checks.transactionIdMatches) {
      return this.build('INCONSISTENT_EVIDENCE', expectation, evidence, checks, mismatches, {
        errorCode: 'TRANSACTION_ID_MISMATCH',
        errorMessage: 'The block-level evidence belongs to a different Fabric transaction ID.',
      });
    }

    if (!checks.blockNumberPositive || !checks.blockHashPresent) {
      return this.build('INCONSISTENT_EVIDENCE', expectation, evidence, checks, mismatches, {
        errorCode: 'INCOMPLETE_BLOCK_EVIDENCE',
        errorMessage:
          'Block-level evidence is incomplete: a positive block number AND a block hash are both required.',
      });
    }

    if (!checks.validationCodeValid) {
      return this.build('VERIFIED_INVALID', expectation, evidence, checks, mismatches, {
        errorCode: 'LEDGER_COMMIT_VALIDATION_FAILURE',
        errorMessage: `The transaction is present in block ${tx.blockNumber} but was not applied (Fabric validation code ${tx.validationCode}).`,
      });
    }

    if (payloadHashCompared && tx.payloadHash === null) {
      return this.build('EVIDENCE_UNAVAILABLE', expectation, evidence, checks, mismatches, {
        errorCode: 'PAYLOAD_HASH_UNREADABLE',
        errorMessage:
          'The committed transaction did not expose a readable payload hash; a transaction ID alone is not sufficient commit evidence.',
      });
    }

    if (payloadHashCompared && payloadHashMatched === false) {
      return this.build('INCONSISTENT_EVIDENCE', expectation, evidence, checks, mismatches, {
        errorCode: 'PAYLOAD_HASH_MISMATCH',
        errorMessage:
          'The committed payload hash does not match the expected payload hash; the transaction must not be confirmed and requires manual review.',
      });
    }

    return this.build('VERIFIED_COMMITTED', expectation, evidence, checks, mismatches, {});
  }

  // -------------------------------------------------------------------------
  // Result construction & audit
  // -------------------------------------------------------------------------

  private build(
    verdict: CommitVerificationResult['verdict'],
    expectation: CommitExpectation,
    evidence: VerifiedCommitEvidence | null,
    checks: CommitVerificationChecks,
    mismatches: string[],
    extra: { errorCode?: string; errorMessage?: string }
  ): CommitVerificationResult {
    return {
      verdict,
      fabricTransactionId: expectation.fabricTransactionId,
      evidence,
      checks,
      mismatches,
      // The consulted source is ALWAYS named — including for a refusal. An audit
      // trail that cannot say WHICH source refused a commit is not auditable.
      evidenceSource: evidence?.evidenceSource ?? this.source.sourceName,
      verified: verdict === 'VERIFIED_COMMITTED',
      isSimulated: false,
      ...(extra.errorCode ? { errorCode: extra.errorCode } : {}),
      ...(extra.errorMessage ? { errorMessage: extra.errorMessage } : {}),
    };
  }

  private emitDecision(
    expectation: CommitExpectation,
    result: CommitVerificationResult
  ): void {
    if (!this.auditSink) return;
    const decision: CommitVerificationDecision = {
      verdict: result.verdict,
      fabricTransactionId: result.fabricTransactionId,
      gatewayRequestId: expectation.gatewayRequestId ?? null,
      idempotencyKey: expectation.idempotencyKey ?? null,
      evidenceSource: result.evidenceSource,
      blockNumber: result.evidence?.blockNumber ?? null,
      blockHash: result.evidence?.blockHash ?? null,
      mismatches: result.mismatches,
      checks: result.checks,
      errorCode: result.errorCode ?? null,
      errorMessage: result.errorMessage ?? null,
      decidedAt: this.nowFn(),
    };
    try {
      this.auditSink.record(decision);
    } catch {
      // An audit failure must never alter a verdict.
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyChecks(sourceIsIndependent: boolean): CommitVerificationChecks {
  return {
    sourceIsIndependent: sourceIsIndependent === true,
    transactionFound: false,
    blockEvidencePresent: false,
    blockNumberPositive: false,
    blockHashPresent: false,
    transactionIdMatches: false,
    validationCodeValid: false,
    payloadHashCompared: false,
    payloadHashMatched: null,
  };
}

function collectMismatches(
  checks: CommitVerificationChecks,
  tx: { blockNumber: number; blockHash: string; validationCode: number }
): string[] {
  const mismatches: string[] = [];
  if (!checks.sourceIsIndependent) mismatches.push('source_is_not_block_level_independent');
  if (!checks.transactionIdMatches) mismatches.push('transaction_id_does_not_match_evidence');
  if (!checks.blockNumberPositive) mismatches.push(`block_number_not_positive:${tx.blockNumber}`);
  if (!checks.blockHashPresent) mismatches.push('block_hash_missing');
  if (!checks.validationCodeValid) mismatches.push(`validation_code_not_valid:${tx.validationCode}`);
  if (checks.payloadHashCompared && checks.payloadHashMatched === false) {
    mismatches.push('payload_hash_mismatch');
  }
  return mismatches;
}

function isTimeoutError(err: unknown): boolean {
  const anyErr = err as { code?: unknown; message?: unknown } | null;
  const code = typeof anyErr?.code === 'number' ? anyErr.code : undefined;
  if (code === 4) return true; // gRPC DEADLINE_EXCEEDED
  const message = String(anyErr?.message ?? err ?? '').toUpperCase();
  return (
    message.includes('DEADLINE_EXCEEDED') ||
    message.includes('DEADLINE EXCEEDED') ||
    message.includes('TIMEOUT') ||
    message.includes('ETIMEDOUT')
  );
}

/** Caps length and strips anything credential-shaped from provider text. */
function sanitize(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/((?:key|secret|token|password|auth|authorization)=)['"]?[^&'"\s]+['"]?/gi, '$1[REDACTED]')
    .replace(/(?:Bearer\s+)[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .slice(0, 300);
}
