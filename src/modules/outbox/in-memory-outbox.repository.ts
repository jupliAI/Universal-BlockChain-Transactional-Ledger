/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'crypto';
import { OutboxRepository } from './outbox.repository.ts';
import { OutboxEventRecord, OutboxEventType, OutboxMetrics } from './outbox.types.ts';

export class InMemoryOutboxRepository implements OutboxRepository {
  private events = new Map<string, OutboxEventRecord>();
  private dedupIndex = new Set<string>();

  enqueueAtomic(
    eventData: Omit<OutboxEventRecord, 'id' | 'createdAt' | 'updatedAt'>
  ): OutboxEventRecord {
    if (eventData.deduplicationKey) {
      if (this.dedupIndex.has(eventData.deduplicationKey)) {
        throw new Error(
          `Unique constraint violation: Duplicate outbox event with deduplicationKey '${eventData.deduplicationKey}'`
        );
      }
      this.dedupIndex.add(eventData.deduplicationKey);
    }

    const id = randomUUID();
    const nowIso = new Date().toISOString();

    const record: OutboxEventRecord = {
      ...eventData,
      id,
      attemptCount: eventData.attemptCount || 0,
      attempts: eventData.attemptCount || 0,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    this.events.set(id, record);
    return { ...record };
  }

  async claimBatch(workerId: string, batchSize: number, now: number): Promise<OutboxEventRecord[]> {
    const claimed: OutboxEventRecord[] = [];
    const nowIso = new Date(now).toISOString();

    // Sort eligible events by nextAttemptAt ascending (FIFO priority)
    const eligible = Array.from(this.events.values())
      .filter((e) => (e.status === 'PENDING' || e.status === 'RETRY_PENDING') && e.nextAttemptAt <= now)
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt);

    for (const event of eligible) {
      if (claimed.length >= batchSize) break;

      // Atomic lock and transition to PROCESSING
      event.status = 'PROCESSING';
      event.lockedAt = now;
      event.lockedBy = workerId;
      event.attemptCount += 1;
      event.attempts = event.attemptCount;
      event.updatedAt = nowIso;

      claimed.push({ ...event });
    }

    return claimed;
  }

  async completeEvent(id: string, now: number): Promise<void> {
    const event = this.events.get(id);
    if (!event) return;

    event.status = 'COMPLETED';
    event.lockedAt = null;
    event.lockedBy = null;
    event.processedAt = new Date(now).toISOString();
    event.updatedAt = event.processedAt;
  }

  async scheduleRetry(
    id: string,
    nextAttemptAt: number,
    lastErrorCode: string,
    lastError: string,
    now: number
  ): Promise<void> {
    const event = this.events.get(id);
    if (!event) return;

    event.status = 'RETRY_PENDING';
    event.nextAttemptAt = nextAttemptAt;
    event.lockedAt = null;
    event.lockedBy = null;
    event.lastErrorCode = lastErrorCode;
    event.lastError = lastError;
    event.updatedAt = new Date(now).toISOString();
  }

  async markDeadLetter(
    id: string,
    lastErrorCode: string,
    lastError: string,
    now: number
  ): Promise<void> {
    const event = this.events.get(id);
    if (!event) return;

    event.status = 'DEAD_LETTER';
    event.lockedAt = null;
    event.lockedBy = null;
    event.lastErrorCode = lastErrorCode;
    event.lastError = lastError;
    event.updatedAt = new Date(now).toISOString();
  }

  async reclaimStuckEvents(
    stuckTimeoutMs: number,
    now: number,
    workerId?: string
  ): Promise<OutboxEventRecord[]> {
    const stuck: OutboxEventRecord[] = [];
    const threshold = now - stuckTimeoutMs;
    const nowIso = new Date(now).toISOString();

    for (const event of this.events.values()) {
      if (event.status === 'PROCESSING' && event.lockedAt !== null && event.lockedAt < threshold) {
        // Re-lease the row to the recovering worker so a concurrent recovery
        // cannot observe the same stale lease again.
        event.lockedAt = now;
        event.lockedBy = workerId || event.lockedBy;
        event.updatedAt = nowIso;
        stuck.push({ ...event });
      }
    }

    return stuck;
  }

  async releaseClaim(id: string, now: number): Promise<void> {
    const event = this.events.get(id);
    if (!event || event.status !== 'PROCESSING') return;

    event.status = 'RETRY_PENDING';
    event.lockedAt = null;
    event.lockedBy = null;
    event.updatedAt = new Date(now).toISOString();
  }

  getMetrics(now: number = Date.now()): OutboxMetrics {
    return this.computeMetrics(now);
  }

  getMetricsByType(eventType: OutboxEventType, now: number = Date.now()): OutboxMetrics {
    return this.computeMetrics(now, eventType);
  }

  private computeMetrics(now: number, eventType?: OutboxEventType): OutboxMetrics {
    const all = Array.from(this.events.values()).filter(
      (e) => eventType === undefined || e.eventType === eventType
    );
    let pendingCount = 0;
    let processingCount = 0;
    let retryPendingCount = 0;
    let completedCount = 0;
    let deadLetterCount = 0;
    let oldestPendingTime = Infinity;
    let lastErrorCode: string | null = null;

    for (const e of all) {
      if (e.status === 'PENDING') {
        pendingCount++;
        if (e.nextAttemptAt < oldestPendingTime) oldestPendingTime = e.nextAttemptAt;
      } else if (e.status === 'PROCESSING' || e.status === 'IN_PROGRESS') {
        processingCount++;
      } else if (e.status === 'RETRY_PENDING') {
        retryPendingCount++;
        if (e.nextAttemptAt < oldestPendingTime) oldestPendingTime = e.nextAttemptAt;
      } else if (e.status === 'COMPLETED') {
        completedCount++;
      } else if (e.status === 'DEAD_LETTER' || e.status === 'FAILED') {
        deadLetterCount++;
      }

      if (e.lastErrorCode) {
        lastErrorCode = e.lastErrorCode;
      }
    }

    const oldestPendingAgeMs =
      oldestPendingTime !== Infinity && oldestPendingTime <= now ? now - oldestPendingTime : 0;

    return {
      totalEvents: all.length,
      pendingCount,
      processingCount,
      retryPendingCount,
      completedCount,
      deadLetterCount,
      oldestPendingAgeMs,
      lastErrorCode,
    };
  }

  getRecentEvents(limit = 50): OutboxEventRecord[] {
    return Array.from(this.events.values())
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, limit)
      .map((e) => ({ ...e }));
  }

  findById(id: string): OutboxEventRecord | null {
    const e = this.events.get(id);
    return e ? { ...e } : null;
  }
}
