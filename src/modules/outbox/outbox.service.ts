/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { UbtlConfig } from '../../config/environment.ts';
import { AuditService } from '../audit/audit.service.ts';
import { BlockchainAdapter } from '../blockchain-adapter/adapter.interface.ts';
import { TransactionsService } from '../transactions/transactions.service.ts';
import { WebhookService } from '../webhooks/webhook.service.ts';
import { InMemoryOutboxRepository } from './in-memory-outbox.repository.ts';
import { OutboxWorker } from './outbox-worker.ts';
import { OutboxRepository } from './outbox.repository.ts';
import {
  OutboxEventRecord,
  OutboxEventStatus,
  OutboxEventType,
  OutboxMetrics,
  WorkerObservability,
} from './outbox.types.ts';

export type {
  OutboxEventRecord,
  OutboxEventStatus,
  OutboxEventType,
  OutboxMetrics,
  WorkerObservability,
};

export class OutboxService {
  private repository: OutboxRepository;
  private worker: OutboxWorker;

  constructor(
    private readonly config: UbtlConfig,
    private readonly transactionsService: TransactionsService,
    private readonly blockchainAdapter: BlockchainAdapter,
    private readonly webhookService: WebhookService,
    private readonly auditService: AuditService,
    repository?: OutboxRepository,
    worker?: OutboxWorker
  ) {
    this.repository = repository || new InMemoryOutboxRepository();
    this.worker =
      worker ||
      new OutboxWorker(
        this.config,
        this.repository,
        this.transactionsService,
        this.blockchainAdapter,
        this.webhookService,
        this.auditService
      );
  }

  getRepository(): OutboxRepository {
    return this.repository;
  }

  getWorker(): OutboxWorker {
    return this.worker;
  }

  enqueueEvent(
    transactionId: string,
    gatewayRequestId: string,
    eventType: OutboxEventType,
    payload: Record<string, unknown>,
    deduplicationKey?: string
  ): OutboxEventRecord {
    // If deduplicationKey is not supplied, generate a default one to protect initial submissions
    const key =
      deduplicationKey ||
      (eventType === 'DISPATCH_LEDGER'
        ? `dispatch:${transactionId}`
        : undefined);

    const event = (this.repository as any).enqueueAtomic({
      transactionId,
      gatewayRequestId,
      eventType,
      status: 'PENDING',
      payload,
      attemptCount: 0,
      attempts: 0,
      maxAttempts: this.config.outboxMaxRetries,
      nextAttemptAt: Date.now(),
      lockedAt: null,
      lockedBy: null,
      lastErrorCode: null,
      lastError: null,
      processedAt: null,
      deduplicationKey: key || null,
    });

    return event;
  }

  startWorker(): void {
    this.worker.start();
  }

  stopWorker(): void {
    this.worker.stop();
  }

  async processNextBatch(): Promise<number> {
    return this.worker.pollAndProcess();
  }

  async getMetrics() {
    // `await` also tolerates the synchronous in-memory implementation.
    const rawMetrics = (await this.repository.getMetrics(Date.now())) as OutboxMetrics;
    return {
      totalEvents: rawMetrics.totalEvents,
      pendingCount: rawMetrics.pendingCount,
      processingCount: rawMetrics.processingCount,
      inProgressCount: rawMetrics.processingCount, // Backward compatibility alias
      retryPendingCount: rawMetrics.retryPendingCount,
      completedCount: rawMetrics.completedCount,
      failedCount: rawMetrics.deadLetterCount, // Backward compatibility alias
      deadLetterCount: rawMetrics.deadLetterCount,
      oldestPendingAgeMs: rawMetrics.oldestPendingAgeMs,
      lastErrorCode: rawMetrics.lastErrorCode,
    };
  }

  async getObservability(): Promise<WorkerObservability> {
    return this.worker.getObservability();
  }

  /**
   * Webhook delivery observability (queue state + in-process attempt metrics).
   * Delegated to the worker, which owns the outbox repository and webhook service.
   */
  async getWebhookMetrics() {
    return this.worker.getWebhookMetrics();
  }

  async getRecentEvents(limit = 50): Promise<OutboxEventRecord[]> {
    const res = await this.repository.getRecentEvents(limit);
    return Array.isArray(res) ? res : [];
  }
}
