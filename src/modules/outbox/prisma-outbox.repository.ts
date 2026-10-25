/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { OutboxRepository } from './outbox.repository.ts';
import { OutboxEventRecord, OutboxEventType, OutboxMetrics } from './outbox.types.ts';

export class PrismaOutboxRepository implements OutboxRepository {
  constructor(private readonly prismaClient: any) {}

  async enqueueAtomic(
    eventData: Omit<OutboxEventRecord, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<OutboxEventRecord> {
    if (!this.prismaClient) {
      throw new Error('PrismaClient is not initialized');
    }

    const row = await this.prismaClient.outboxEvent.create({
      data: {
        transactionId: eventData.transactionId,
        eventType: eventData.eventType,
        status: eventData.status,
        // outbox_events has no gatewayRequestId column: it is carried in the JSONB
        // payload so the worker can resolve the owning transaction after a restart.
        payload: { ...(eventData.payload || {}), gatewayRequestId: eventData.gatewayRequestId },
        attemptCount: eventData.attemptCount || 0,
        attempts: eventData.attemptCount || 0,
        maxAttempts: eventData.maxAttempts || 5,
        nextAttemptAt: new Date(eventData.nextAttemptAt),
        deduplicationKey: eventData.deduplicationKey,
      },
    });

    return this.mapRowToRecord(row);
  }

  async claimBatch(workerId: string, batchSize: number, now: number): Promise<OutboxEventRecord[]> {
    if (!this.prismaClient) return [];

    // Atomic claim using FOR UPDATE SKIP LOCKED
    return await this.prismaClient.$transaction(async (tx: any) => {
      // 1. Select eligible pending or retryable events with SKIP LOCKED
      const selectQuery = `
        SELECT id
        FROM outbox_events
        WHERE status IN ('PENDING', 'RETRY_PENDING')
          AND "nextAttemptAt" <= $1
        ORDER BY "nextAttemptAt" ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED;
      `;
      const eligibleIdsRows: { id: string }[] = await tx.$queryRawUnsafe(
        selectQuery,
        new Date(now),
        batchSize
      );

      if (!eligibleIdsRows || eligibleIdsRows.length === 0) {
        return [];
      }

      const eligibleIds = eligibleIdsRows.map((r) => r.id);
      const nowIso = new Date(now);

      // 2. Mark claimed rows as PROCESSING with worker identity and lock timestamp
      await tx.outboxEvent.updateMany({
        where: { id: { in: eligibleIds } },
        data: {
          status: 'PROCESSING',
          lockedAt: nowIso,
          lockedBy: workerId,
          attemptCount: { increment: 1 },
          attempts: { increment: 1 },
          updatedAt: nowIso,
        },
      });

      // 3. Retrieve updated rows to return to worker
      const claimedRows = await tx.outboxEvent.findMany({
        where: { id: { in: eligibleIds } },
      });

      return claimedRows.map((r: any) => this.mapRowToRecord(r));
    });
  }

  async completeEvent(id: string, now: number): Promise<void> {
    if (!this.prismaClient) return;

    await this.prismaClient.outboxEvent.update({
      where: { id },
      data: {
        status: 'COMPLETED',
        lockedAt: null,
        lockedBy: null,
        processedAt: new Date(now),
        updatedAt: new Date(now),
      },
    });
  }

  async scheduleRetry(
    id: string,
    nextAttemptAt: number,
    lastErrorCode: string,
    lastError: string,
    now: number
  ): Promise<void> {
    if (!this.prismaClient) return;

    await this.prismaClient.outboxEvent.update({
      where: { id },
      data: {
        status: 'RETRY_PENDING',
        nextAttemptAt: new Date(nextAttemptAt),
        lockedAt: null,
        lockedBy: null,
        lastErrorCode,
        lastError,
        updatedAt: new Date(now),
      },
    });
  }

  async markDeadLetter(
    id: string,
    lastErrorCode: string,
    lastError: string,
    now: number
  ): Promise<void> {
    if (!this.prismaClient) return;

    await this.prismaClient.outboxEvent.update({
      where: { id },
      data: {
        status: 'DEAD_LETTER',
        lockedAt: null,
        lockedBy: null,
        lastErrorCode,
        lastError,
        updatedAt: new Date(now),
      },
    });
  }

  async reclaimStuckEvents(
    stuckTimeoutMs: number,
    now: number,
    workerId?: string
  ): Promise<OutboxEventRecord[]> {
    if (!this.prismaClient) return [];

    const threshold = new Date(now - stuckTimeoutMs);
    const nowDate = new Date(now);
    const reclaimer = workerId || 'stuck-recovery';

    // Atomic + mutually exclusive reclaim. A single UPDATE ... WHERE id IN
    // (SELECT ... FOR UPDATE SKIP LOCKED) re-leases expired rows to the calling
    // worker so two recovering workers can never both own the same event.
    return await this.prismaClient.$transaction(async (tx: any) => {
      const selectQuery = `
        SELECT id
        FROM outbox_events
        WHERE status = 'PROCESSING'
          AND "lockedAt" IS NOT NULL
          AND "lockedAt" < $1
        ORDER BY "lockedAt" ASC
        LIMIT 100
        FOR UPDATE SKIP LOCKED;
      `;
      const staleRows: { id: string }[] = await tx.$queryRawUnsafe(selectQuery, threshold);

      if (!staleRows || staleRows.length === 0) {
        return [];
      }

      const staleIds = staleRows.map((r) => r.id);

      await tx.outboxEvent.updateMany({
        where: { id: { in: staleIds } },
        data: { lockedAt: nowDate, lockedBy: reclaimer, updatedAt: nowDate },
      });

      const reclaimed = await tx.outboxEvent.findMany({
        where: { id: { in: staleIds } },
      });

      return reclaimed.map((r: any) => this.mapRowToRecord(r));
    });
  }

  async releaseClaim(id: string, now: number): Promise<void> {
    if (!this.prismaClient) return;

    await this.prismaClient.outboxEvent.update({
      where: { id },
      data: {
        status: 'RETRY_PENDING',
        lockedAt: null,
        lockedBy: null,
        updatedAt: new Date(now),
      },
    });
  }

  async getMetrics(now: number = Date.now()): Promise<OutboxMetrics> {
    return this.computeMetrics(now);
  }

  async getMetricsByType(eventType: OutboxEventType, now: number = Date.now()): Promise<OutboxMetrics> {
    return this.computeMetrics(now, eventType);
  }

  private async computeMetrics(now: number, eventType?: OutboxEventType): Promise<OutboxMetrics> {
    if (!this.prismaClient) {
      return {
        totalEvents: 0,
        pendingCount: 0,
        processingCount: 0,
        retryPendingCount: 0,
        completedCount: 0,
        deadLetterCount: 0,
        oldestPendingAgeMs: 0,
        lastErrorCode: null,
      };
    }

    const typeFilter = eventType ? { eventType } : {};

    const [totalEvents, pendingCount, processingCount, retryPendingCount, completedCount, deadLetterCount, oldestPending] =
      await Promise.all([
        this.prismaClient.outboxEvent.count({ where: { ...typeFilter } }),
        this.prismaClient.outboxEvent.count({ where: { ...typeFilter, status: 'PENDING' } }),
        this.prismaClient.outboxEvent.count({ where: { ...typeFilter, status: { in: ['PROCESSING', 'IN_PROGRESS'] } } }),
        this.prismaClient.outboxEvent.count({ where: { ...typeFilter, status: 'RETRY_PENDING' } }),
        this.prismaClient.outboxEvent.count({ where: { ...typeFilter, status: 'COMPLETED' } }),
        this.prismaClient.outboxEvent.count({ where: { ...typeFilter, status: { in: ['DEAD_LETTER', 'FAILED'] } } }),
        this.prismaClient.outboxEvent.findFirst({
          where: { ...typeFilter, status: { in: ['PENDING', 'RETRY_PENDING'] } },
          orderBy: { nextAttemptAt: 'asc' },
          select: { nextAttemptAt: true },
        }),
      ]);

    const oldestTime = oldestPending?.nextAttemptAt ? new Date(oldestPending.nextAttemptAt).getTime() : 0;
    const oldestPendingAgeMs = oldestTime > 0 && oldestTime <= now ? now - oldestTime : 0;

    return {
      totalEvents,
      pendingCount,
      processingCount,
      retryPendingCount,
      completedCount,
      deadLetterCount,
      oldestPendingAgeMs,
      lastErrorCode: null,
    };
  }

  async getRecentEvents(limit = 50): Promise<OutboxEventRecord[]> {
    if (!this.prismaClient) return [];
    const rows = await this.prismaClient.outboxEvent.findMany({
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r: any) => this.mapRowToRecord(r));
  }

  async findById(id: string): Promise<OutboxEventRecord | null> {
    if (!this.prismaClient) return null;
    const row = await this.prismaClient.outboxEvent.findUnique({
      where: { id },
    });
    return row ? this.mapRowToRecord(row) : null;
  }

  private mapRowToRecord(row: any): OutboxEventRecord {
    return {
      id: row.id,
      transactionId: row.transactionId,
      gatewayRequestId: row.payload?.gatewayRequestId || row.transactionId,
      eventType: row.eventType,
      status: row.status,
      payload: row.payload || {},
      attemptCount: row.attemptCount || row.attempts || 0,
      attempts: row.attemptCount || row.attempts || 0,
      maxAttempts: row.maxAttempts || 5,
      nextAttemptAt: row.nextAttemptAt ? new Date(row.nextAttemptAt).getTime() : Date.now(),
      lockedAt: row.lockedAt ? new Date(row.lockedAt).getTime() : null,
      lockedBy: row.lockedBy || null,
      lastErrorCode: row.lastErrorCode || null,
      lastError: row.lastError || null,
      processedAt: row.processedAt ? new Date(row.processedAt).toISOString() : null,
      deduplicationKey: row.deduplicationKey || null,
      createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : new Date().toISOString(),
      updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : new Date().toISOString(),
    };
  }
}
