/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Outcome of reconciling a single transaction.
 *   CONFIRMED    → verified provider commit evidence; the transaction was advanced to COMMITTED
 *   FAILED       → verified provider rejection; the transaction was advanced to FAILED
 *   INCONCLUSIVE → no usable evidence; RECONCILIATION_REQUIRED is preserved (no state change)
 *   ERROR        → the reconciliation attempt itself threw; no state change
 */
export type ReconciliationOutcome = 'CONFIRMED' | 'FAILED' | 'INCONCLUSIVE' | 'ERROR';

export interface ReconciliationRecord {
  id: string;
  runId: string;
  transactionId: string;
  gatewayRequestId: string;
  correlationId: string;
  internalStatus: string;
  lifecycleState: string;
  /** SHA-256 hash of the canonical payload UBTL stored off-chain (the evidence anchor). */
  internalHash: string;
  /** On-ledger payload hash observed while gathering evidence, when retrievable. */
  ledgerHash?: string | null;
  outcome: ReconciliationOutcome;
  /** Where the evidence came from, or null when none was available. */
  evidenceSource: string | null;
  ledgerStatus: string | null;
  blockNumber: number | null;
  /**
   * Block hash reported by the INDEPENDENT block-level evidence source
   * (Prompt 09.7). Kept separate from the payload hash and from the block
   * number so the three anchors can never be conflated. Null when the decision
   * did not come from an independent verifier.
   */
  blockHash?: string | null;
  /**
   * The independent commit-verification verdict that drove this decision
   * (e.g. VERIFIED_COMMITTED, NOT_FOUND, EVIDENCE_UNAVAILABLE). Null when the
   * decision came from the legacy adapter-observation path.
   */
  verificationVerdict?: string | null;
  /** Result of cross-checking the ledger payload hash, when a proof was available. */
  payloadHashMatched: boolean | null;
  /** Bounded reconciliation attempt number for this transaction. */
  attemptNumber: number;
  /** True when attempts were exhausted and the case is escalated for operator review. */
  escalated: boolean;
  /** Sanitized (secret-redacted, truncated) error text. Safe to persist/log. */
  sanitizedError: string | null;
  checkedAt: string;
}

/**
 * Storage for reconciliation evidence.
 *
 * The reconciliation ATTEMPT BUDGET is derived from the number of persisted
 * records for a transaction, so it survives a restart when the store is
 * durable. A store that loses records on restart therefore also loses the
 * escalation budget — that is precisely why a durable implementation is
 * required in production.
 */
export interface ReconciliationRecordStore {
  readonly kind: 'in-memory' | 'postgresql';
  readonly isDurable: boolean;
  append(record: ReconciliationRecord): Promise<void>;
  /** Most recent records first. */
  list(outcomeFilter?: ReconciliationOutcome, limit?: number): Promise<ReconciliationRecord[]>;
  /** Number of reconciliation attempts already recorded for a transaction. */
  countAttempts(gatewayRequestId: string): Promise<number>;
}

/**
 * Non-durable store used for development and unit tests. Records (and therefore
 * the escalation budget they encode) are lost on restart.
 */
export class InMemoryReconciliationRecordStore implements ReconciliationRecordStore {
  readonly kind = 'in-memory' as const;
  readonly isDurable = false;

  private records: ReconciliationRecord[] = [];

  constructor(private readonly maxRecords = 1000) {}

  async append(record: ReconciliationRecord): Promise<void> {
    this.records.unshift(record);
    if (this.records.length > this.maxRecords) {
      this.records.length = this.maxRecords;
    }
  }

  async list(outcomeFilter?: ReconciliationOutcome, limit = 1000): Promise<ReconciliationRecord[]> {
    const filtered = outcomeFilter
      ? this.records.filter((r) => r.outcome === outcomeFilter)
      : this.records;
    return filtered.slice(0, limit);
  }

  async countAttempts(gatewayRequestId: string): Promise<number> {
    return this.records.filter((r) => r.gatewayRequestId === gatewayRequestId).length;
  }
}
