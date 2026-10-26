/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { InitialOutboxEventSpec, TransactionRecord } from '../transactions.service.ts';

export interface StorageMetadata {
  storageType: 'in-memory' | 'postgresql';
  isDurable: boolean;
  productionReady: boolean;
  details: string;
}

export interface InitialStatusHistorySpec {
  toStatus?: string;
  reason?: string;
  details?: Record<string, unknown>;
}

/**
 * Read-side narrowing applied by `getAll`. Both fields are optional and are
 * additive: omitted means "no constraint on this dimension".
 */
export interface TransactionQueryFilter {
  /** Exact match on `transactionType` (e.g. `PURCHASE`). Case-sensitive by design. */
  transactionType?: string;
  /** Case-insensitive substring match across the identifier columns. */
  search?: string;
}

export interface TransactionRepository {
  readonly storageMetadata: StorageMetadata;
  /**
   * Persists the transaction row, its initial status history row and its initial
   * outbox event as ONE atomic unit of work. Durable implementations MUST wrap
   * all three writes in a single database transaction so that a crash can never
   * leave an accepted transaction without its dispatch event (or vice versa).
   */
  createAtomic(
    transaction: TransactionRecord,
    initialStatusHistory?: InitialStatusHistorySpec,
    outboxEvent?: InitialOutboxEventSpec
  ): Promise<void>;
  findByGatewayRequestId(gatewayRequestId: string): Promise<TransactionRecord | null>;
  findByIdempotencyKey(organizationId: string, idempotencyKey: string): Promise<TransactionRecord | null>;
  update(transaction: TransactionRecord): Promise<void>;
  getAll(limit?: number, filter?: TransactionQueryFilter): Promise<TransactionRecord[]>;
}
