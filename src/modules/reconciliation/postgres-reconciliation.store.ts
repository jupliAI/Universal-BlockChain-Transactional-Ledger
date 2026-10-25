/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ReconciliationOutcome,
  ReconciliationRecord,
  ReconciliationRecordStore,
} from './reconciliation.store.ts';

/**
 * Durable reconciliation evidence store backed by the `reconciliation_records`
 * table.
 *
 * The table predates the richer in-process record shape, so the additional
 * fields are carried inside the `discrepancyDetails` JSONB column and decoded on
 * read. `internalHash` is the stored canonical payload hash (the evidence
 * anchor); `isMatched` mirrors a CONFIRMED outcome so the existing
 * `idx_reconciliation_matched_time` index remains useful.
 */
export class PostgresReconciliationRecordStore implements ReconciliationRecordStore {
  readonly kind = 'postgresql' as const;
  readonly isDurable = true;

  constructor(private readonly prismaClient: any) {}

  async append(record: ReconciliationRecord): Promise<void> {
    if (!this.prismaClient) {
      throw new Error('PrismaClient is not initialized. Connect PostgreSQL and verify DATABASE_URL.');
    }

    await this.prismaClient.reconciliationRecord.create({
      data: {
        id: record.id,
        transactionId: record.transactionId,
        gatewayRequestId: record.gatewayRequestId,
        internalStatus: record.internalStatus.slice(0, 32),
        ledgerStatus: record.ledgerStatus ? record.ledgerStatus.slice(0, 32) : null,
        isMatched: record.outcome === 'CONFIRMED',
        internalHash: record.internalHash,
        ledgerHash: record.ledgerHash ?? null,
        discrepancyDetails: {
          runId: record.runId,
          correlationId: record.correlationId,
          lifecycleState: record.lifecycleState,
          outcome: record.outcome,
          evidenceSource: record.evidenceSource,
          blockNumber: record.blockNumber,
          blockHash: record.blockHash ?? null,
          verificationVerdict: record.verificationVerdict ?? null,
          payloadHashMatched: record.payloadHashMatched,
          attemptNumber: record.attemptNumber,
          escalated: record.escalated,
          sanitizedError: record.sanitizedError,
        },
        checkedAt: new Date(record.checkedAt),
      },
    });
  }

  async list(outcomeFilter?: ReconciliationOutcome, limit = 1000): Promise<ReconciliationRecord[]> {
    if (!this.prismaClient) return [];

    const rows = await this.prismaClient.reconciliationRecord.findMany({
      where: outcomeFilter
        ? { discrepancyDetails: { path: ['outcome'], equals: outcomeFilter } }
        : {},
      orderBy: { checkedAt: 'desc' },
      take: limit,
    });

    return rows.map((row: any) => this.mapRowToRecord(row));
  }

  async countAttempts(gatewayRequestId: string): Promise<number> {
    if (!this.prismaClient) return 0;
    return this.prismaClient.reconciliationRecord.count({ where: { gatewayRequestId } });
  }

  private mapRowToRecord(row: any): ReconciliationRecord {
    const details: Record<string, any> =
      row.discrepancyDetails && typeof row.discrepancyDetails === 'object'
        ? row.discrepancyDetails
        : {};

    return {
      id: row.id,
      runId: typeof details.runId === 'string' ? details.runId : '',
      transactionId: row.transactionId,
      gatewayRequestId: row.gatewayRequestId,
      correlationId: typeof details.correlationId === 'string' ? details.correlationId : '',
      internalStatus: row.internalStatus,
      lifecycleState: typeof details.lifecycleState === 'string' ? details.lifecycleState : '',
      internalHash: row.internalHash,
      ledgerHash: row.ledgerHash ?? null,
      outcome:
        (details.outcome as ReconciliationOutcome) ??
        (row.isMatched ? 'CONFIRMED' : 'INCONCLUSIVE'),
      evidenceSource: typeof details.evidenceSource === 'string' ? details.evidenceSource : null,
      ledgerStatus: row.ledgerStatus ?? null,
      blockNumber: typeof details.blockNumber === 'number' ? details.blockNumber : null,
      blockHash: typeof details.blockHash === 'string' ? details.blockHash : null,
      verificationVerdict:
        typeof details.verificationVerdict === 'string' ? details.verificationVerdict : null,
      payloadHashMatched:
        typeof details.payloadHashMatched === 'boolean' ? details.payloadHashMatched : null,
      attemptNumber: typeof details.attemptNumber === 'number' ? details.attemptNumber : 0,
      escalated: details.escalated === true,
      sanitizedError: typeof details.sanitizedError === 'string' ? details.sanitizedError : null,
      checkedAt: row.checkedAt ? new Date(row.checkedAt).toISOString() : new Date().toISOString(),
    };
  }
}
