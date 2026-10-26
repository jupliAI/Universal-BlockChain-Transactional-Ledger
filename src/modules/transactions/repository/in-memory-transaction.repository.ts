/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'crypto';
import { OutboxRepository } from '../../outbox/outbox.repository.ts';
import { InitialOutboxEventSpec, TransactionRecord } from '../transactions.service.ts';
import {
  InitialStatusHistorySpec,
  StorageMetadata,
  TransactionQueryFilter,
  TransactionRepository,
} from './transaction.repository.ts';

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export class InMemoryTransactionRepository implements TransactionRepository {
  readonly storageMetadata: StorageMetadata = {
    storageType: 'in-memory',
    isDurable: false,
    productionReady: false,
    details: 'Non-durable in-memory repository (local mock/testing mode). Transactions and idempotency index will reset on process restart.',
  };

  private transactions = new Map<string, TransactionRecord>();
  private idempotencyIndex = new Map<string, string>();
  public statusHistory = new Map<string, any[]>();
  public outboxEvents = new Map<string, any[]>();

  /**
   * @param outboxRepository Optional shared outbox store. When provided, the
   * initial outbox event created during ingestion is written into the SAME store
   * that the outbox worker polls, keeping transaction + dispatch event coupled.
   */
  constructor(private readonly outboxRepository?: OutboxRepository) {}

  async createAtomic(
    transaction: TransactionRecord,
    initialStatusHistory?: InitialStatusHistorySpec,
    outboxEvent?: InitialOutboxEventSpec
  ): Promise<void> {
    const idempotencyKey = `${transaction.organizationId}:${transaction.idempotencyKey}`;

    // Simulate database unique constraint check
    if (this.idempotencyIndex.has(idempotencyKey)) {
      throw new Error(`Unique constraint violation: Transaction with idempotency key '${transaction.idempotencyKey}' already exists for organization '${transaction.organizationId}'`);
    }

    const nowIso = new Date().toISOString();

    if (this.statusHistory.has(transaction.id)) {
      throw new Error(`Duplicate initial status history for transaction '${transaction.id}'`);
    }

    this.transactions.set(transaction.gatewayRequestId, { ...transaction });
    this.idempotencyIndex.set(idempotencyKey, transaction.gatewayRequestId);

    if (initialStatusHistory) {
      this.statusHistory.set(transaction.id, [
        {
          id: transaction.id,
          toStatus: (initialStatusHistory.toStatus || transaction.status.toUpperCase()),
          reason: initialStatusHistory.reason || 'TRANSACTION_ACCEPTED',
          details: initialStatusHistory.details || {},
          createdAt: nowIso,
        },
      ]);
    }

    if (outboxEvent) {
      this.outboxEvents.set(transaction.id, [
        {
          transactionId: transaction.id,
          gatewayRequestId: transaction.gatewayRequestId,
          eventType: outboxEvent.eventType || 'DISPATCH_LEDGER',
          status: 'PENDING',
          payload: outboxEvent.payload || {},
          deduplicationKey: outboxEvent.deduplicationKey,
          createdAt: nowIso,
        },
      ]);

      // Couple the dispatch event to the shared worker queue when wired.
      if (this.outboxRepository) {
        await this.outboxRepository.enqueueAtomic({
          transactionId: transaction.id,
          gatewayRequestId: transaction.gatewayRequestId,
          eventType: outboxEvent.eventType || 'DISPATCH_LEDGER',
          status: 'PENDING',
          payload: outboxEvent.payload || {},
          attemptCount: 0,
          attempts: 0,
          maxAttempts: outboxEvent.maxAttempts || 5,
          nextAttemptAt: Date.parse(nowIso),
          lockedAt: null,
          lockedBy: null,
          lastErrorCode: null,
          lastError: null,
          processedAt: null,
          deduplicationKey: outboxEvent.deduplicationKey || `dispatch:${transaction.id}`,
        });
      }
    }
  }

  async findByGatewayRequestId(gatewayRequestId: string): Promise<TransactionRecord | null> {
    const tx = this.transactions.get(gatewayRequestId);
    return tx ? { ...tx } : null;
  }

  async findByIdempotencyKey(organizationId: string, idempotencyKey: string): Promise<TransactionRecord | null> {
    const key = `${organizationId}:${idempotencyKey}`;
    const gatewayRequestId = this.idempotencyIndex.get(key);
    if (!gatewayRequestId) return null;
    return this.findByGatewayRequestId(gatewayRequestId);
  }

  async update(transaction: TransactionRecord): Promise<void> {
    const existing = this.transactions.get(transaction.gatewayRequestId);
    if (!existing) {
      throw new Error(`Transaction with gatewayRequestId '${transaction.gatewayRequestId}' not found`);
    }

    // Lifecycle parity with the durable repository: every real status change
    // appends a row to the transaction's status history. Without this the
    // in-memory and PostgreSQL stores would diverge in observable behaviour.
    if (existing.status !== transaction.status || existing.lifecycleState !== transaction.lifecycleState) {
      const nowIso = new Date().toISOString();
      const history = this.statusHistory.get(transaction.id) || [];
      history.push({
        id: randomUUID(),
        fromStatus: existing.status.toUpperCase(),
        toStatus: transaction.status.toUpperCase(),
        reason: `LIFECYCLE_${transaction.lifecycleState}`,
        details: {
          lifecycleState: transaction.lifecycleState,
          errorCode: transaction.errorCode ?? null,
        },
        createdAt: nowIso,
      });
      this.statusHistory.set(transaction.id, history);
    }

    this.transactions.set(transaction.gatewayRequestId, { ...transaction });
  }

  async getAll(limit = 100, filter: TransactionQueryFilter = {}): Promise<TransactionRecord[]> {
    const needle = filter.search?.toLowerCase();
    const type = filter.transactionType;

    return Array.from(this.transactions.values())
      .filter((tx) => (type ? tx.transactionType === type : true))
      .filter((tx) => {
        if (!needle) return true;
        // Mirrors PrismaTransactionRepository: `gatewayRequestId` is a uuid
        // column there, so only a complete UUID matches it, while the text
        // columns support case-insensitive substring matching.
        return (
          tx.correlationId.toLowerCase().includes(needle) ||
          tx.idempotencyKey.toLowerCase().includes(needle) ||
          (tx.payloadHash ?? '').toLowerCase().includes(needle) ||
          (UUID_PATTERN.test(needle) && tx.gatewayRequestId.toLowerCase() === needle)
        );
      })
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, limit);
  }
}
