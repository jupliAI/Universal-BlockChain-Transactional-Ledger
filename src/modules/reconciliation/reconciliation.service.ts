/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'crypto';
import { UbtlConfig } from '../../config/environment.ts';
import { AuditService } from '../audit/audit.service.ts';
import { BlockchainAdapter, CommitStatusResult } from '../blockchain-adapter/adapter.interface.ts';
import {
  CommitExpectation,
  CommitVerificationResult,
  CommitVerifier,
} from '../blockchain-adapter/commit-verification.types.ts';
import { TransactionRecord, TransactionsService } from '../transactions/transactions.service.ts';
import { redactSecrets } from '../webhooks/webhook.service.ts';
import {
  InMemoryReconciliationRecordStore,
  ReconciliationOutcome,
  ReconciliationRecord,
  ReconciliationRecordStore,
} from './reconciliation.store.ts';

// The record shape and the store contract live in ./reconciliation.store.ts so
// that durable implementations do not have to import this service (avoiding a
// runtime import cycle). Re-exported here for existing consumers.
export type { ReconciliationOutcome, ReconciliationRecord, ReconciliationRecordStore };

export interface ReconciliationRunResult {
  runId: string;
  /** True when a concurrent run (or a held lock) caused this invocation to be skipped. */
  skipped: boolean;
  eligibleCount: number;
  checked: number;
  confirmed: number;
  failed: number;
  inconclusive: number;
  errors: number;
  escalated: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** Sanitized run-level failure note (null on success). */
  runError: string | null;
}

export interface ReconciliationMetrics {
  currentRunActive: boolean;
  scheduled: boolean;
  totalRuns: number;
  skippedOverlaps: number;
  lastRunAt: string | null;
  lastRunDurationMs: number | null;
  lastRunSummary: ReconciliationRunResult | null;
  totalConfirmed: number;
  totalInconclusive: number;
  totalFailed: number;
  totalErrors: number;
  /** Transactions currently in RECONCILIATION_REQUIRED (operator visibility). */
  unresolvedCount: number;
  /** Inconclusive cases that exhausted their bounded attempt budget. */
  escalatedCount: number;
  config: {
    intervalMinutes: number;
    lookbackHours: number;
    batchSize: number;
    maxAttempts: number;
  };
}

/**
 * Coordination primitive that prevents overlapping reconciliation runs.
 *
 * - Within a process, ReconciliationService additionally guards with an
 *   in-flight promise so two concurrent calls can never double-process.
 * - Across processes/workers, a DURABLE implementation is required. Use
 *   `PostgresReconciliationLock` (lease row in PostgreSQL, atomic acquire /
 *   owner-scoped release, crash-safe lease expiry) whenever more than one
 *   worker process shares one durable database.
 */
export interface ReconciliationLock {
  tryAcquire(ownerId: string): Promise<boolean>;
  release(ownerId: string): Promise<void>;
}

/**
 * In-memory lock that is ONLY safe within a single process.
 *
 * It is retained for single-process deployments and unit tests. It offers NO
 * cross-process protection: two worker processes each hold their own instance
 * and would both "acquire". Do NOT use it where multiple schedulers share a
 * durable database — inject `PostgresReconciliationLock` there instead.
 */
export class SingleProcessReconciliationLock implements ReconciliationLock {
  private ownerId: string | null = null;

  async tryAcquire(ownerId: string): Promise<boolean> {
    if (this.ownerId !== null) return false;
    this.ownerId = ownerId;
    return true;
  }

  async release(ownerId: string): Promise<void> {
    if (this.ownerId === ownerId) this.ownerId = null;
  }
}

const EMPTY_METRICS_COUNTERS = {
  totalRuns: 0,
  skippedOverlaps: 0,
  totalConfirmed: 0,
  totalInconclusive: 0,
  totalFailed: 0,
  totalErrors: 0,
};

/**
 * Invariant part of a reconciliation record: everything that is known before a
 * decision is reached. Both the legacy adapter-observation path and the
 * independent-verifier path start from this shape.
 */
interface ReconciliationRecordBase {
  id: string;
  runId: string;
  transactionId: string;
  gatewayRequestId: string;
  correlationId: string;
  internalStatus: string;
  lifecycleState: string;
  internalHash: string;
  attemptNumber: number;
  checkedAt: string;
}

export class ReconciliationService {
  private activeRun: Promise<ReconciliationRunResult> | null = null;
  private timer: NodeJS.Timeout | null = null;

  private metrics = { ...EMPTY_METRICS_COUNTERS };
  private lastRunAt: string | null = null;
  private lastRunDurationMs: number | null = null;
  private lastRunSummary: ReconciliationRunResult | null = null;

  private readonly lookbackMs: number;
  private readonly intervalMs: number;

  constructor(
    private readonly config: UbtlConfig,
    private readonly transactionsService: TransactionsService,
    private readonly blockchainAdapter: BlockchainAdapter,
    private readonly auditService: AuditService,
    private readonly lock: ReconciliationLock = new SingleProcessReconciliationLock(),
    /**
     * Where reconciliation evidence is persisted. Defaults to the non-durable
     * store (development/unit tests); the composition root injects the
     * PostgreSQL store whenever a durable database is active, so that neither
     * the evidence nor the per-transaction attempt budget is lost on restart.
     */
    private readonly store: ReconciliationRecordStore = new InMemoryReconciliationRecordStore()
  ) {
    this.lookbackMs = config.reconciliationLookbackHours * 60 * 60 * 1000;
    this.intervalMs = config.reconciliationIntervalMinutes * 60 * 1000;
  }

  /** True when reconciliation evidence is persisted durably. */
  isDurable(): boolean {
    return this.store.isDurable;
  }

  /**
   * Schedules periodic reconciliation at the configured interval.
   * The first run happens after one interval (not immediately), so callers can
   * control startup timing explicitly.
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.runReconciliation().catch((err) => {
        console.error('[Reconciliation] Scheduled run failed:', err instanceof Error ? err.message : err);
      });
    }, this.intervalMs);
    // Do not keep the event loop alive purely for reconciliation.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isScheduled(): boolean {
    return this.timer !== null;
  }

  /**
   * Bounded, observable reconciliation run.
   *
   * Guarantees:
   *  - Never overlaps with itself within this process (in-flight guard) and
   *    coordinates across workers via the injected lock.
   *  - Queries provider evidence BEFORE any state change.
   *  - Never infers commit from a submission acknowledgement: only verified
   *    commit evidence (CONFIRMED + blockNumber > 0, payload hash consistent)
   *    advances a transaction to COMMITTED.
   *  - Inconclusive results preserve RECONCILIATION_REQUIRED (no fabricated
   *    success OR failure).
   *  - Does not hold database row locks while calling the provider (evidence
   *    is gathered on plain reads; state changes are short single-row updates).
   */
  runReconciliation(): Promise<ReconciliationRunResult> {
    if (this.activeRun) {
      // Overlap guard: return immediately without touching any transaction.
      this.metrics.skippedOverlaps++;
      return Promise.resolve(this.skippedResult('overlap-in-process'));
    }

    const runId = `recon-${randomUUID().slice(0, 8)}`;
    const run = this.executeRun(runId).finally(() => {
      this.activeRun = null;
    });
    this.activeRun = run;
    return run;
  }

  private async executeRun(runId: string): Promise<ReconciliationRunResult> {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();

    let acquired: boolean;
    try {
      acquired = await this.lock.tryAcquire(runId);
    } catch (err: unknown) {
      // Fail closed: if durable lock coordination is unavailable, we MUST NOT
      // run. Proceeding without a verifiable lock could let two workers process
      // the same transaction. Skip the run and surface the failure.
      const runError = this.sanitize(err);
      this.metrics.skippedOverlaps++;
      this.auditService.record({
        actorType: 'SYSTEM',
        action: 'RECONCILIATION_LOCK_ERROR',
        resourceType: 'RECONCILIATION',
        metadata: { runId, error: runError },
      });
      return { ...this.skippedResult(runId, startedAt), runError };
    }

    if (!acquired) {
      this.metrics.skippedOverlaps++;
      return this.skippedResult(runId, startedAt);
    }

    try {
      const now = Date.now();
      const all = await this.transactionsService.getAll(1000);
      const eligible = all
        .filter((tx) => this.isEligible(tx, now))
        .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt))
        .slice(0, this.config.reconciliationBatchSize);

      let confirmed = 0;
      let failed = 0;
      let inconclusive = 0;
      let errors = 0;
      let escalated = 0;

      for (const tx of eligible) {
        const record = await this.reconcileOne(tx, runId, now);
        if (record.outcome === 'CONFIRMED') confirmed++;
        else if (record.outcome === 'FAILED') failed++;
        else if (record.outcome === 'ERROR') errors++;
        else inconclusive++;
        if (record.escalated) escalated++;
      }

      const finishedAtMs = Date.now();
      const result: ReconciliationRunResult = {
        runId,
        skipped: false,
        eligibleCount: eligible.length,
        checked: eligible.length,
        confirmed,
        failed,
        inconclusive,
        errors,
        escalated,
        startedAt,
        finishedAt: new Date(finishedAtMs).toISOString(),
        durationMs: finishedAtMs - startedAtMs,
        runError: null,
      };

      this.applyRunMetrics(result);

      this.auditService.record({
        actorType: 'SYSTEM',
        action: 'RECONCILIATION_RUN_COMPLETED',
        resourceType: 'RECONCILIATION',
        metadata: {
          runId,
          eligibleCount: result.eligibleCount,
          confirmed,
          failed,
          inconclusive,
          errors,
          escalated,
          durationMs: result.durationMs,
          providerMode: this.blockchainAdapter.mode,
        },
      });

      return result;
    } catch (err: unknown) {
      const runError = this.sanitize(err);
      this.metrics.totalRuns++;
      this.lastRunAt = startedAt;
      this.auditService.record({
        actorType: 'SYSTEM',
        action: 'RECONCILIATION_RUN_FAILED',
        resourceType: 'RECONCILIATION',
        metadata: { runId, error: runError },
      });
      const finishedAtMs = Date.now();
      return {
        runId,
        skipped: false,
        eligibleCount: 0,
        checked: 0,
        confirmed: 0,
        failed: 0,
        inconclusive: 0,
        errors: 1,
        escalated: 0,
        startedAt,
        finishedAt: new Date(finishedAtMs).toISOString(),
        durationMs: finishedAtMs - startedAtMs,
        runError,
      };
    } finally {
      await this.lock.release(runId);
    }
  }

  /**
   * Explicitly eligible states for reconciliation:
   *  - RECONCILIATION_REQUIRED: the primary target (e.g. ambiguous submission timeout).
   *  - SUBMITTED / AWAITING_COMMIT older than the configured lookback window:
   *    potentially stuck after a worker crash and may never advance otherwise.
   * All other states (including terminal CONFIRMED/FAILED/VERIFIED and
   * pre-submission OUTBOX_PENDING) are never reconciled.
   */
  private isEligible(tx: TransactionRecord, now: number): boolean {
    if (tx.lifecycleState === 'RECONCILIATION_REQUIRED') return true;
    if (tx.lifecycleState === 'SUBMITTED' || tx.lifecycleState === 'AWAITING_COMMIT') {
      const updatedAt = Date.parse(tx.updatedAt);
      if (Number.isNaN(updatedAt)) return false;
      return now - updatedAt >= this.lookbackMs;
    }
    return false;
  }

  private async reconcileOne(
    tx: TransactionRecord,
    runId: string,
    _now: number
  ): Promise<ReconciliationRecord> {
    // The attempt budget is derived from the PERSISTED evidence: with a durable
    // store it therefore survives a restart, so escalation cannot be reset by
    // simply bouncing the process.
    const attemptNumber = (await this.store.countAttempts(tx.gatewayRequestId)) + 1;

    const base: ReconciliationRecordBase = {
      id: randomUUID(),
      runId,
      transactionId: tx.id,
      gatewayRequestId: tx.gatewayRequestId,
      correlationId: tx.correlationId,
      internalStatus: tx.status,
      lifecycleState: tx.lifecycleState,
      internalHash: tx.payloadHash,
      attemptNumber,
      checkedAt: new Date().toISOString(),
    };

    try {
      // INDEPENDENT VERIFICATION PATH (Prompt 09.7).
      //
      // Whenever the adapter offers a block-level commit verifier — provider
      // mode always does — a business transition to COMMITTED requires a
      // VERIFIED_COMMITTED verdict. The adapter's own observation
      // (`queryCommitStatus`, e.g. a chaincode-supplied block number) is then
      // only a hint and can never, on its own, confirm a commit.
      const commitVerifier = this.blockchainAdapter.getCommitVerifier?.() ?? null;
      if (commitVerifier) {
        return await this.reconcileWithIndependentVerifier(tx, base, attemptNumber, commitVerifier);
      }

      const evidence = await this.gatherEvidence(tx);

      if (!evidence.result) {
        // No provider evidence: inconclusive. RECONCILIATION_REQUIRED is preserved.
        return this.finalize({
          ...base,
          outcome: 'INCONCLUSIVE',
          evidenceSource: evidence.source,
          ledgerStatus: null,
          blockNumber: null,
          payloadHashMatched: null,
          escalated: attemptNumber >= this.config.reconciliationMaxAttempts,
          sanitizedError:
            evidence.error ||
            'No provider evidence available; transaction remains in RECONCILIATION_REQUIRED',
        });
      }

      const result = evidence.result;

      if (result.status === 'CONFIRMED') {
        // Axiom 5: a positive block number is mandatory for commit confirmation.
        const blockNumber = result.blockNumber !== undefined && result.blockNumber !== null
          ? Number(result.blockNumber)
          : 0;
        if (!blockNumber || blockNumber <= 0) {
          return this.finalize({
            ...base,
            outcome: 'INCONCLUSIVE',
            evidenceSource: evidence.source,
            ledgerStatus: 'CONFIRMED',
            blockNumber: null,
            payloadHashMatched: null,
            escalated: attemptNumber >= this.config.reconciliationMaxAttempts,
            sanitizedError:
              'Provider reported CONFIRMED without a positive block number; not sufficient commit evidence',
          });
        }

        // Cross-check the ledger payload hash when a proof is retrievable. A
        // mismatch is NOT auto-resolved in either direction.
        let payloadHashMatched: boolean | null = null;
        let ledgerHash: string | null = null;
        const proofTxId = result.fabricTransactionId || tx.fabricTransactionId;
        if (proofTxId) {
          try {
            const proof = await this.blockchainAdapter.getTransactionProof(proofTxId);
            if (proof) {
              ledgerHash = proof.payloadHash;
              payloadHashMatched = proof.payloadHash === tx.payloadHash;
            }
          } catch {
            // Proof unavailable: fall back to the CONFIRMED status evidence.
          }
        }

        if (payloadHashMatched === false) {
          return this.finalize({
            ...base,
            outcome: 'INCONCLUSIVE',
            evidenceSource: evidence.source,
            ledgerStatus: 'CONFIRMED',
            ledgerHash,
            blockNumber,
            payloadHashMatched,
            escalated: true,
            sanitizedError:
              'Ledger payload hash does not match the stored payload hash; manual review required',
          });
        }

        await this.transactionsService.markCommitted(
          tx.gatewayRequestId,
          blockNumber,
          result.commitTimestamp
        );

        return this.finalize({
          ...base,
          outcome: 'CONFIRMED',
          evidenceSource: evidence.source,
          ledgerStatus: 'CONFIRMED',
          ledgerHash,
          blockNumber,
          payloadHashMatched,
          escalated: false,
          sanitizedError: null,
        });
      }

      if (result.status === 'FAILED') {
        const code = (result.errorCode || '').toUpperCase();
        // "Not found" is NOT definitive failure evidence — the provider may
        // simply have no record yet. Preserve RECONCILIATION_REQUIRED.
        if (code.includes('NOT_FOUND')) {
          return this.finalize({
            ...base,
            outcome: 'INCONCLUSIVE',
            evidenceSource: evidence.source,
            ledgerStatus: 'FAILED',
            blockNumber: null,
            payloadHashMatched: null,
            escalated: attemptNumber >= this.config.reconciliationMaxAttempts,
            sanitizedError:
              'Provider has no record of this transaction; commit evidence is inconclusive',
          });
        }

        await this.transactionsService.markFailed(
          tx.gatewayRequestId,
          result.errorCode || 'LEDGER_COMMIT_FAILED',
          result.errorMessage || 'Commit rejected by provider'
        );

        return this.finalize({
          ...base,
          outcome: 'FAILED',
          evidenceSource: evidence.source,
          ledgerStatus: 'FAILED',
          blockNumber: null,
          payloadHashMatched: null,
          escalated: false,
          sanitizedError: this.sanitize(result.errorMessage || result.errorCode || null),
        });
      }

      // PENDING or TIMEOUT: ambiguous, still in flight. Inconclusive.
      return this.finalize({
        ...base,
        outcome: 'INCONCLUSIVE',
        evidenceSource: evidence.source,
        ledgerStatus: result.status,
        blockNumber: null,
        payloadHashMatched: null,
        escalated: attemptNumber >= this.config.reconciliationMaxAttempts,
        sanitizedError: null,
      });
    } catch (err: unknown) {
      return this.finalize({
        ...base,
        outcome: 'ERROR',
        evidenceSource: null,
        ledgerStatus: null,
        blockNumber: null,
        payloadHashMatched: null,
        escalated: false,
        sanitizedError: this.sanitize(err),
      });
    }
  }

  /**
   * Reconciles a single transaction through the adapter's INDEPENDENT commit
   * verifier (Prompt 09.7).
   *
   * Guarantees:
   *  - A transition to COMMITTED requires a VERIFIED_COMMITTED verdict: an
   *    independent block-level source, a positive block number, a non-empty
   *    block hash, a matching Fabric transaction ID, Fabric validation code 0
   *    and — when the stored payload hash is supplied — an identical payload
   *    hash. A chaincode record, a transaction ID or a block number on its own
   *    can never confirm a commit.
   *  - NOT_FOUND is retryable and is NEVER recorded as a permanent failure:
   *    ordering/commit latency means absence of evidence is not evidence of
   *    failure.
   *  - EVIDENCE_UNAVAILABLE and TIMEOUT never confirm and never fail the
   *    transaction: RECONCILIATION_REQUIRED is preserved.
   *  - INCONSISTENT_EVIDENCE (including a payload-hash mismatch) is escalated
   *    immediately for operator review and can never become CONFIRMED.
   *  - VERIFIED_INVALID is verified proof that the transaction was committed
   *    but NOT applied, so it is recorded as a definitive failure.
   *  - Every decision is audited with its verdict plus the block number and the
   *    block hash, so previously recorded commit evidence is never overwritten
   *    without a trace.
   */
  private async reconcileWithIndependentVerifier(
    tx: TransactionRecord,
    base: ReconciliationRecordBase,
    attemptNumber: number,
    verifier: CommitVerifier
  ): Promise<ReconciliationRecord> {
    const budgetExhausted = attemptNumber >= this.config.reconciliationMaxAttempts;

    // A block-level lookup is keyed on the Fabric transaction ID. The durable
    // request-id anchor query may DISCOVER that id, but it is never treated as
    // commit evidence in itself.
    let fabricTransactionId = tx.fabricTransactionId ?? null;
    if (!fabricTransactionId && this.blockchainAdapter.findTransactionByIdempotencyKey) {
      try {
        const anchor = await this.blockchainAdapter.findTransactionByIdempotencyKey(
          tx.gatewayRequestId
        );
        if (anchor && anchor.fabricTransactionId) {
          fabricTransactionId = anchor.fabricTransactionId;
        }
      } catch {
        // Discovery is best-effort; the decision below stays inconclusive.
      }
    }

    if (!fabricTransactionId) {
      return this.finalize({
        ...base,
        outcome: 'INCONCLUSIVE',
        evidenceSource: null,
        ledgerStatus: null,
        blockNumber: null,
        blockHash: null,
        verificationVerdict: null,
        payloadHashMatched: null,
        escalated: budgetExhausted,
        sanitizedError:
          'No Fabric transaction ID is available to query the independent block-level evidence source',
      });
    }

    const expectation: CommitExpectation = {
      fabricTransactionId,
      gatewayRequestId: tx.gatewayRequestId,
      idempotencyKey: tx.idempotencyKey,
      expectedPayloadHash: tx.payloadHash,
    };

    let verification: CommitVerificationResult;
    try {
      verification = await verifier.verifyCommit(expectation);
    } catch (err: unknown) {
      return this.finalize({
        ...base,
        outcome: 'ERROR',
        evidenceSource: verifier.verifierName,
        ledgerStatus: null,
        blockNumber: null,
        blockHash: null,
        verificationVerdict: null,
        payloadHashMatched: null,
        escalated: false,
        sanitizedError: this.sanitize(err),
      });
    }

    const evidenceSource = verification.evidenceSource ?? verifier.verifierName;
    const blockNumber = verification.evidence ? Number(verification.evidence.blockNumber) : null;
    const blockHash = verification.evidence?.blockHash ?? null;

    if (
      verification.verified &&
      verification.evidence &&
      blockNumber !== null &&
      Number.isFinite(blockNumber) &&
      blockNumber > 0
    ) {
      await this.transactionsService.markCommitted(tx.gatewayRequestId, blockNumber);

      return this.finalize({
        ...base,
        outcome: 'CONFIRMED',
        evidenceSource,
        ledgerStatus: 'CONFIRMED',
        ledgerHash: verification.evidence.payloadHash ?? null,
        blockNumber,
        blockHash,
        verificationVerdict: verification.verdict,
        payloadHashMatched: verification.checks.payloadHashMatched,
        escalated: false,
        sanitizedError: null,
      });
    }

    if (verification.verdict === 'VERIFIED_INVALID') {
      const errorCode = verification.errorCode || 'LEDGER_COMMIT_VALIDATION_FAILURE';
      await this.transactionsService.markFailed(
        tx.gatewayRequestId,
        errorCode,
        verification.errorMessage || 'Transaction is present in a block but was not applied'
      );

      return this.finalize({
        ...base,
        outcome: 'FAILED',
        evidenceSource,
        ledgerStatus: 'INVALID',
        blockNumber,
        blockHash,
        verificationVerdict: verification.verdict,
        payloadHashMatched: verification.checks.payloadHashMatched,
        escalated: false,
        sanitizedError: this.sanitize(verification.errorMessage ?? errorCode),
      });
    }

    // NOT_FOUND / EVIDENCE_UNAVAILABLE / INCONSISTENT_EVIDENCE / TIMEOUT:
    // ambiguous. Never a commit, and never a permanent failure.
    return this.finalize({
      ...base,
      outcome: 'INCONCLUSIVE',
      evidenceSource,
      ledgerStatus: verification.verdict,
      blockNumber,
      blockHash,
      verificationVerdict: verification.verdict,
      payloadHashMatched: verification.checks.payloadHashMatched,
      // A self-contradictory ledger observation needs operator review straight
      // away; a merely absent/ambiguous one waits for the attempt budget.
      escalated: verification.verdict === 'INCONSISTENT_EVIDENCE' || budgetExhausted,
      sanitizedError:
        verification.errorMessage ||
        `Independent commit verification is inconclusive (${verification.verdict})`,
    });
  }

  /**
   * Gathers provider evidence WITHOUT mutating state.
   *
   * Order of preference:
   *  1. Request-id / idempotency-anchor query (the UBTL-defined chaincode query
   *     used for cross-restart recovery; NOT a native Fabric capability).
   *  2. Commit-status query for a recorded provider transaction id — only
   *     available in-process for the same-process SubmittedTransaction, so it is
   *     a best-effort fallback after a restart.
   */
  private async gatherEvidence(
    tx: TransactionRecord
  ): Promise<{ result: CommitStatusResult | null; source: string | null; error: string | null }> {
    if (this.blockchainAdapter.findTransactionByIdempotencyKey) {
      try {
        const found = await this.blockchainAdapter.findTransactionByIdempotencyKey(
          tx.gatewayRequestId
        );
        if (found) {
          return { result: found, source: 'adapter_request_id_query', error: null };
        }
      } catch (err: unknown) {
        // Continue to the next evidence source.
        const note = this.sanitize(err);
        if (tx.fabricTransactionId) {
          try {
            const found = await this.blockchainAdapter.queryCommitStatus(tx.fabricTransactionId);
            return { result: found, source: 'commit_status_query', error: null };
          } catch (fallbackErr: unknown) {
            return { result: null, source: null, error: this.sanitize(fallbackErr) };
          }
        }
        return { result: null, source: null, error: note };
      }
    }

    if (tx.fabricTransactionId) {
      try {
        const found = await this.blockchainAdapter.queryCommitStatus(tx.fabricTransactionId);
        return { result: found, source: 'commit_status_query', error: null };
      } catch (err: unknown) {
        return { result: null, source: null, error: this.sanitize(err) };
      }
    }

    return {
      result: null,
      source: null,
      error:
        'No provider evidence source is available (no recorded provider transaction id and no request-id query support)',
    };
  }

  private async finalize(record: ReconciliationRecord): Promise<ReconciliationRecord> {
    this.auditService.record({
      actorType: 'SYSTEM',
      action: `RECONCILIATION_${record.outcome}`,
      correlationId: record.correlationId,
      resourceType: 'TRANSACTION',
      resourceId: record.gatewayRequestId,
      metadata: {
        runId: record.runId,
        transactionId: record.transactionId,
        outcome: record.outcome,
        evidenceSource: record.evidenceSource,
        ledgerStatus: record.ledgerStatus,
        blockNumber: record.blockNumber,
        blockHash: record.blockHash ?? null,
        verificationVerdict: record.verificationVerdict ?? null,
        payloadHashMatched: record.payloadHashMatched,
        attemptNumber: record.attemptNumber,
        escalated: record.escalated,
        sanitizedError: record.sanitizedError,
      },
    });

    // Evidence persistence is best-effort by design: the business state change
    // (COMMITTED / FAILED / unchanged) has ALREADY been recorded durably before
    // we get here, and the audit entry above carries the same outcome. Failing
    // the whole run because the supplementary evidence row could not be written
    // would report an ERROR that did not happen.
    try {
      await this.store.append(record);
    } catch (err: unknown) {
      console.warn(
        `[Reconciliation] Persisting the reconciliation evidence row failed (${
          err instanceof Error ? err.name : typeof err
        }); the outcome was still audited and the transaction state is unchanged.`
      );
    }

    return record;
  }

  private applyRunMetrics(result: ReconciliationRunResult): void {
    this.metrics.totalRuns++;
    this.metrics.totalConfirmed += result.confirmed;
    this.metrics.totalInconclusive += result.inconclusive;
    this.metrics.totalFailed += result.failed;
    this.metrics.totalErrors += result.errors;
    this.lastRunAt = result.startedAt;
    this.lastRunDurationMs = result.durationMs;
    this.lastRunSummary = result;
  }

  private skippedResult(runId: string, at = new Date().toISOString()): ReconciliationRunResult {
    return {
      runId,
      skipped: true,
      eligibleCount: 0,
      checked: 0,
      confirmed: 0,
      failed: 0,
      inconclusive: 0,
      errors: 0,
      escalated: 0,
      startedAt: at,
      finishedAt: at,
      durationMs: 0,
      runError: null,
    };
  }

  private sanitize(err: unknown): string | null {
    if (err === null || err === undefined) return null;
    const raw = err instanceof Error ? err.message : String(err);
    return redactSecrets(raw).slice(0, 300);
  }

  /**
   * Recorded reconciliation outcomes, most recent first.
   *
   * Reads through the injected store, so with the durable store this reflects
   * evidence recorded by EARLIER process lifetimes (i.e. it survives a restart).
   */
  async getRecords(outcomeFilter?: ReconciliationOutcome, limit = 1000): Promise<ReconciliationRecord[]> {
    return this.store.list(outcomeFilter, limit);
  }

  async getMetrics(): Promise<ReconciliationMetrics> {
    const all = await this.transactionsService.getAll(1000);
    const unresolvedCount = all.filter((t) => t.lifecycleState === 'RECONCILIATION_REQUIRED').length;
    const recentRecords = await this.store.list(undefined, 1000);
    const escalatedCount = recentRecords.filter(
      (r) => r.escalated && r.outcome === 'INCONCLUSIVE'
    ).length;

    return {
      currentRunActive: this.activeRun !== null,
      scheduled: this.isScheduled(),
      totalRuns: this.metrics.totalRuns,
      skippedOverlaps: this.metrics.skippedOverlaps,
      lastRunAt: this.lastRunAt,
      lastRunDurationMs: this.lastRunDurationMs,
      lastRunSummary: this.lastRunSummary,
      totalConfirmed: this.metrics.totalConfirmed,
      totalInconclusive: this.metrics.totalInconclusive,
      totalFailed: this.metrics.totalFailed,
      totalErrors: this.metrics.totalErrors,
      unresolvedCount,
      escalatedCount,
      config: {
        intervalMinutes: this.config.reconciliationIntervalMinutes,
        lookbackHours: this.config.reconciliationLookbackHours,
        batchSize: this.config.reconciliationBatchSize,
        maxAttempts: this.config.reconciliationMaxAttempts,
      },
    };
  }
}
