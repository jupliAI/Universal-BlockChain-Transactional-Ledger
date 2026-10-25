/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { OutboxEventRecord, OutboxEventType, OutboxMetrics } from './outbox.types.ts';

export interface OutboxRepository {
  enqueueAtomic(
    event: Omit<OutboxEventRecord, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<OutboxEventRecord> | OutboxEventRecord;

  /**
   * Atomically claims up to `batchSize` eligible events for `workerId` by
   * transitioning them to PROCESSING, recording the lease (`lockedAt`/`lockedBy`)
   * and incrementing the attempt counter. The claim transaction MUST be committed
   * before the caller performs any external network call, and two workers MUST
   * NEVER be able to claim the same event.
   */
  claimBatch(workerId: string, batchSize: number, now: number): Promise<OutboxEventRecord[]>;

  completeEvent(id: string, now: number): Promise<void>;

  scheduleRetry(
    id: string,
    nextAttemptAt: number,
    lastErrorCode: string,
    lastError: string,
    now: number
  ): Promise<void>;

  markDeadLetter(
    id: string,
    lastErrorCode: string,
    lastError: string,
    now: number
  ): Promise<void>;

  /**
   * Recovers events whose PROCESSING lease expired (crashed worker). The recovery
   * MUST be atomic and mutually exclusive: it re-leases the reclaimed rows to the
   * calling `workerId` so that a second worker cannot concurrently reclaim the same
   * event while the first worker is still applying its recovery decision.
   */
  reclaimStuckEvents(stuckTimeoutMs: number, now: number, workerId?: string): Promise<OutboxEventRecord[]>;

  releaseClaim(id: string, now: number): Promise<void>;

  getMetrics(now?: number): Promise<OutboxMetrics> | OutboxMetrics;

  /**
   * Metrics scoped to a single outbox event type. Used to report webhook
   * delivery queue state (pending / retrying / dead-letter / oldest age) without
   * conflating it with ledger dispatch or commit-verification events.
   */
  getMetricsByType(
    eventType: OutboxEventType,
    now?: number
  ): Promise<OutboxMetrics> | OutboxMetrics;

  getRecentEvents(limit?: number): Promise<OutboxEventRecord[]> | OutboxEventRecord[];

  findById(id: string): Promise<OutboxEventRecord | null> | OutboxEventRecord | null;
}
