/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'crypto';
import { UbtlConfig } from '../../config/environment.ts';
import { AuditService } from '../audit/audit.service.ts';
import { BlockchainAdapter } from '../blockchain-adapter/adapter.interface.ts';
import {
  CommitExpectation,
  CommitVerifier,
} from '../blockchain-adapter/commit-verification.types.ts';
import { TransactionRecord, TransactionsService } from '../transactions/transactions.service.ts';
import { WebhookDeliveryError, WebhookService } from '../webhooks/webhook.service.ts';
import { calculateBackoffDelay, classifyError } from './backoff.ts';
import { OutboxRepository } from './outbox.repository.ts';
import {
  OutboxEventRecord,
  OutboxMetrics,
  WorkerObservability,
} from './outbox.types.ts';

export class OutboxWorker {
  public readonly workerId: string;
  private isRunning = false;
  private isShuttingDown = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private isPolling = false;
  private lastPollTime: string | null = null;
  private inFlightTasks = new Set<Promise<void>>();

  private totalProcessedCount = 0;
  private totalErrorsCount = 0;

  // Injectable clock and random generator for deterministic testing
  public nowFn: () => number = () => Date.now();
  public randomFn: () => number = Math.random;

  constructor(
    private readonly config: UbtlConfig,
    private readonly repository: OutboxRepository,
    private readonly transactionsService: TransactionsService,
    private readonly blockchainAdapter: BlockchainAdapter,
    private readonly webhookService: WebhookService,
    private readonly auditService: AuditService,
    workerId?: string
  ) {
    this.workerId = workerId || `worker-${randomUUID().slice(0, 8)}`;
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.isShuttingDown = false;

    this.pollTimer = setInterval(async () => {
      if (this.isPolling || this.isShuttingDown) return;
      this.isPolling = true;
      try {
        await this.pollAndProcess();
        // Also periodically check for stuck events
        await this.recoverStuckEvents();
      } catch (err) {
        console.error(`[OutboxWorker ${this.workerId}] Polling cycle error:`, err);
      } finally {
        this.isPolling = false;
      }
    }, this.config.outboxPollIntervalMs);
  }

  async stop(gracePeriodMs = 5000): Promise<void> {
    this.isShuttingDown = true;
    this.isRunning = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // Wait for in-flight tasks to complete or timeout
    if (this.inFlightTasks.size > 0) {
      const waitPromise = Promise.all(Array.from(this.inFlightTasks));
      let timeoutHandle: NodeJS.Timeout;
      const timeoutPromise = new Promise((resolve) => {
        timeoutHandle = setTimeout(resolve, gracePeriodMs);
      });

      await Promise.race([waitPromise, timeoutPromise]);
      clearTimeout(timeoutHandle!);
    }
  }

  /**
   * Main polling step: claims eligible events and dispatches them
   */
  async pollAndProcess(): Promise<number> {
    if (this.isShuttingDown) return 0;
    const now = this.nowFn();
    this.lastPollTime = new Date(now).toISOString();

    // 1. Concurrency-safe atomic claim
    const claimedEvents = await this.repository.claimBatch(
      this.workerId,
      this.config.outboxBatchSize,
      now
    );

    if (claimedEvents.length === 0) {
      return 0;
    }

    // 2. Dispatch claimed events without holding database locks
    for (const event of claimedEvents) {
      const taskPromise = this.processClaimedEvent(event, now);
      this.inFlightTasks.add(taskPromise);
      taskPromise.finally(() => {
        this.inFlightTasks.delete(taskPromise);
      });
    }

    // Await all events in batch
    await Promise.allSettled(Array.from(this.inFlightTasks));
    return claimedEvents.length;
  }

  /**
   * Processes a single claimed outbox event
   */
  async processClaimedEvent(event: OutboxEventRecord, now: number): Promise<void> {
    try {
      switch (event.eventType) {
        case 'DISPATCH_LEDGER':
          await this.handleDispatchLedger(event, now);
          break;
        case 'VERIFY_COMMIT':
          await this.handleVerifyCommit(event, now);
          break;
        case 'DELIVER_WEBHOOK':
          await this.handleDeliverWebhook(event, now);
          break;
        default:
          throw new Error(`Unsupported outbox event type: ${(event as any).eventType}`);
      }

      await this.repository.completeEvent(event.id, this.nowFn());
      this.totalProcessedCount++;
    } catch (err: unknown) {
      this.totalErrorsCount++;
      await this.handleEventError(event, err, now);
    }
  }

  /**
   * Handler: DISPATCH_LEDGER
   */
  private async handleDispatchLedger(event: OutboxEventRecord, now: number): Promise<void> {
    const tx = await this.transactionsService.getById(event.gatewayRequestId);
    if (!tx) {
      throw new Error(`Transaction ${event.gatewayRequestId} not found for dispatch`);
    }

    // If transaction already has a fabricTransactionId (e.g., recovered after timeout), avoid duplicate proposal
    if (tx.fabricTransactionId && tx.status === 'submitted') {
      await this.enqueueVerifyCommit(tx);
      return;
    }

    // Submit proposal to blockchain adapter
    let submissionResult;
    try {
      submissionResult = await this.blockchainAdapter.submitProposal({
        gatewayRequestId: tx.gatewayRequestId,
        correlationId: tx.correlationId,
        transactionType: tx.transactionType,
        payloadHash: tx.payloadHash,
        timestamp: tx.submittedAt,
        idempotencyKey: tx.idempotencyKey,
      });
    } catch (adapterErr) {
      // Check for ambiguity on timeout / network error
      const classified = classifyError(adapterErr);
      if (classified.classification === 'AMBIGUOUS') {
        await this.handleAmbiguousSubmission(tx, event);
        return;
      }
      throw adapterErr;
    }

    if (!submissionResult.accepted) {
      const err = new Error(submissionResult.errorMessage || 'Proposal rejected by peers');
      (err as any).code = submissionResult.errorCode || 'ENDORSEMENT_POLICY_FAILURE';
      throw err;
    }

    // Proposal accepted: update transaction lifecycle to SUBMITTED
    await this.transactionsService.markSubmitted(tx.gatewayRequestId, submissionResult.fabricTransactionId);

    // Enqueue commit verification outbox event
    await this.enqueueVerifyCommit(tx, submissionResult.fabricTransactionId);

    // Enqueue webhook notification for submitted status (decoupled from ledger submission)
    await this.enqueueWebhookNotification(tx, 'submitted', submissionResult.fabricTransactionId);
  }

  /**
   * Handler: VERIFY_COMMIT
   */
  private async handleVerifyCommit(event: OutboxEventRecord, now: number): Promise<void> {
    const tx = await this.transactionsService.getById(event.gatewayRequestId);
    if (!tx) {
      throw new Error(`Transaction ${event.gatewayRequestId} not found for commit verification`);
    }

    const fabricTxId = (event.payload?.fabricTransactionId as string) || tx.fabricTransactionId;
    if (!fabricTxId) {
      throw new Error('Missing fabricTransactionId for commit verification');
    }

    // INDEPENDENT COMMIT VERIFICATION (Prompt 09.7).
    //
    // When the adapter offers a block-level commit verifier — provider mode
    // always does — a transition to COMMITTED requires a VERIFIED_COMMITTED
    // verdict. The adapter's own observation (`queryCommitStatus`, including a
    // chaincode-supplied block number) is then only a hint and can never, on
    // its own, confirm a commit.
    const commitVerifier = this.blockchainAdapter.getCommitVerifier?.() ?? null;
    if (commitVerifier) {
      await this.verifyCommitIndependently(tx, fabricTxId, commitVerifier);
      return;
    }

    const commitResult = await this.blockchainAdapter.queryCommitStatus(fabricTxId);

    if (commitResult.status === 'CONFIRMED' && commitResult.blockNumber) {
      // Confirmed on ledger: update transaction lifecycle to COMMITTED
      await this.transactionsService.markCommitted(
        tx.gatewayRequestId,
        commitResult.blockNumber,
        commitResult.commitTimestamp
      );

      // Enqueue webhook for confirmed status
      await this.enqueueWebhookNotification(tx, 'confirmed', fabricTxId);
    } else if (commitResult.status === 'FAILED') {
      await this.transactionsService.markFailed(
        tx.gatewayRequestId,
        commitResult.errorCode || 'LEDGER_COMMIT_FAILED',
        commitResult.errorMessage || 'Transaction reverted during block commit'
      );

      await this.enqueueWebhookNotification(tx, 'failed', fabricTxId, commitResult.errorMessage);
    } else if (commitResult.status === 'TIMEOUT') {
      await this.transactionsService.markTimeout(
        tx.gatewayRequestId,
        commitResult.errorMessage || 'Ledger commit timed out'
      );

      await this.enqueueWebhookNotification(tx, 'timeout', fabricTxId, commitResult.errorMessage);
    } else {
      // Still PENDING in block formation: schedule transient retry
      const pendingErr = new Error('Block formation in progress (re-verifying)');
      (pendingErr as any).code = 'BLOCK_FORMATION_PENDING';
      throw pendingErr;
    }
  }

  /**
   * Commit verification through the INDEPENDENT block-level verifier
   * (Prompt 09.7).
   *
   *  - VERIFIED_COMMITTED   → the transaction is advanced to COMMITTED with the
   *                           verified block number.
   *  - VERIFIED_INVALID     → verified proof that the transaction was committed
   *                           but NOT applied: recorded as a definitive
   *                           failure, never as a commit.
   *  - TIMEOUT              → ambiguous; recorded as a timeout for
   *                           reconciliation.
   *  - NOT_FOUND            → retryable. Ordering/commit latency means absence
   *                           of evidence is NOT evidence of failure, so the
   *                           event is retried instead of failing the
   *                           transaction.
   *  - EVIDENCE_UNAVAILABLE / INCONSISTENT_EVIDENCE → ambiguous and retried; a
   *                           contradictory observation is never silently
   *                           accepted as a commit.
   */
  private async verifyCommitIndependently(
    tx: TransactionRecord,
    fabricTxId: string,
    verifier: CommitVerifier
  ): Promise<void> {
    const expectation: CommitExpectation = {
      fabricTransactionId: fabricTxId,
      gatewayRequestId: tx.gatewayRequestId,
      idempotencyKey: tx.idempotencyKey,
      expectedPayloadHash: tx.payloadHash,
    };

    const verification = await verifier.verifyCommit(expectation);

    if (verification.verified && verification.evidence) {
      await this.transactionsService.markCommitted(
        tx.gatewayRequestId,
        verification.evidence.blockNumber
      );

      await this.enqueueWebhookNotification(tx, 'confirmed', fabricTxId);
      return;
    }

    if (verification.verdict === 'VERIFIED_INVALID') {
      await this.transactionsService.markFailed(
        tx.gatewayRequestId,
        verification.errorCode || 'LEDGER_COMMIT_VALIDATION_FAILURE',
        verification.errorMessage || 'Transaction is present in a block but was not applied'
      );

      await this.enqueueWebhookNotification(tx, 'failed', fabricTxId, verification.errorMessage);
      return;
    }

    if (verification.verdict === 'TIMEOUT') {
      await this.transactionsService.markTimeout(
        tx.gatewayRequestId,
        verification.errorMessage || 'Ledger commit verification timed out'
      );

      await this.enqueueWebhookNotification(tx, 'timeout', fabricTxId, verification.errorMessage);
      return;
    }

    // NOT_FOUND / EVIDENCE_UNAVAILABLE / INCONSISTENT_EVIDENCE: ambiguous. Never
    // a commit and never a permanent failure — retry the verification event.
    const pendingErr = new Error(
      verification.errorMessage ||
        `Independent commit verification is inconclusive (${verification.verdict})`
    );
    (pendingErr as any).code =
      verification.verdict === 'NOT_FOUND' ? 'BLOCK_FORMATION_PENDING' : 'COMMIT_EVIDENCE_UNAVAILABLE';
    throw pendingErr;
  }

  /**
   * Handler: DELIVER_WEBHOOK
   *
   * Delivers the outbound callback to Switching. The webhook event is created
   * only AFTER the corresponding business status transition has been durably
   * persisted (see enqueueWebhookNotification call sites), so a webhook is never
   * sent for a status that was not durably recorded.
   *
   * A non-success outcome is re-thrown as a classified WebhookDeliveryError so
   * the shared retry/backoff/dead-letter policy in handleEventError applies:
   *   TRANSIENT (5xx / 408 / 425 / 429 / connection failure) → bounded retry
   *   PERMANENT (other 4xx)                                  → dead-letter, operator review
   *   AMBIGUOUS (client timeout)                             → retry (at-least-once; receiver dedups)
   *
   * Failure here changes ONLY the webhook event's delivery state. It never
   * reverses a ledger commit: handleEventError touches transaction state for
   * DISPATCH_LEDGER events only.
   */
  private async handleDeliverWebhook(event: OutboxEventRecord, now: number): Promise<void> {
    const tx = await this.transactionsService.getById(event.gatewayRequestId);
    const correlationId = (event.payload.correlationId as string) || tx?.correlationId || 'unknown';
    const status = (event.payload.status as any) || tx?.status || 'pending';
    const blockchainTxHash = (event.payload.blockchainTxHash as string) || tx?.blockchainTxHash || null;
    const errorMessage = (event.payload.errorMessage as string) || tx?.errorMessage || null;

    // Logical event identity is preserved across retries: the payload (and thus
    // gatewayRequestId + status) is fixed at enqueue time and never regenerated.
    const result = await this.webhookService.deliverWebhook(
      {
        gatewayRequestId: event.gatewayRequestId,
        correlationId,
        status,
        blockchainTxHash,
        errorMessage,
      },
      event.attemptCount
    );

    if (!result.success) {
      this.auditService.record({
        actorType: 'SYSTEM',
        action: 'WEBHOOK_DELIVERY_DEFERRED',
        correlationId,
        resourceType: 'OUTBOX_EVENT',
        resourceId: event.id,
        metadata: {
          gatewayRequestId: event.gatewayRequestId,
          status,
          classification: result.classification,
          errorCode: result.errorCode,
          attemptCount: event.attemptCount,
          maxAttempts: event.maxAttempts,
        },
      });

      throw new WebhookDeliveryError(
        result.error || `Webhook delivery failed (${result.classification || 'TRANSIENT'})`,
        result.errorCode || 'WEBHOOK_DELIVERY_FAILED',
        result.classification || 'TRANSIENT',
        result.httpStatus
      );
    }
  }

  /**
   * Recovers stuck events that exceeded stuckTimeoutMs
   */
  async recoverStuckEvents(): Promise<number> {
    const now = this.nowFn();
    const stuckEvents = await this.repository.reclaimStuckEvents(
      this.config.outboxStuckTimeoutMs,
      now,
      this.workerId
    );

    if (stuckEvents.length === 0) return 0;

    for (const event of stuckEvents) {
      this.auditService.record({
        actorType: 'SYSTEM',
        action: 'STUCK_OUTBOX_EVENT_DETECTED',
        resourceType: 'OUTBOX_EVENT',
        resourceId: event.id,
        metadata: {
          eventType: event.eventType,
          attemptCount: event.attemptCount,
          lockedBy: event.lockedBy,
          lockedAt: event.lockedAt,
        },
      });

      // Check ambiguity before blindly retrying
      if (event.eventType === 'DISPATCH_LEDGER') {
        const tx = await this.transactionsService.getById(event.gatewayRequestId);
        if (tx && tx.fabricTransactionId) {
          // Previous worker already submitted: advance to completed and enqueue verify
          await this.repository.completeEvent(event.id, now);
          await this.enqueueVerifyCommit(tx);
          continue;
        }

        // Query adapter idempotency index if available
        if (this.blockchainAdapter.findTransactionByIdempotencyKey) {
          try {
            const existing = await this.blockchainAdapter.findTransactionByIdempotencyKey(
              event.gatewayRequestId
            );
            if (existing && existing.fabricTransactionId) {
              await this.transactionsService.markSubmitted(
                event.gatewayRequestId,
                existing.fabricTransactionId
              );
              await this.repository.completeEvent(event.id, now);
              if (tx) await this.enqueueVerifyCommit(tx, existing.fabricTransactionId);
              continue;
            }
          } catch {
            // Adapter check failed
          }
        }
      }

      // Stuck webhook events are safe to re-deliver: delivery is at-least-once
      // and the receiver is required to deduplicate by (gatewayRequestId, status).
      // Recovery therefore only touches the OUTBOX event's delivery state — the
      // ledger/transaction state is never modified here.
      if (event.eventType === 'DELIVER_WEBHOOK') {
        this.auditService.record({
          actorType: 'SYSTEM',
          action: 'STUCK_WEBHOOK_EVENT_RECOVERED',
          resourceType: 'OUTBOX_EVENT',
          resourceId: event.id,
          metadata: {
            gatewayRequestId: event.gatewayRequestId,
            status: (event.payload.status as string) ?? null,
            attemptCount: event.attemptCount,
            maxAttempts: event.maxAttempts,
          },
        });
      }

      // If attempts exhausted, dead letter
      if (event.attemptCount >= event.maxAttempts) {
        await this.repository.markDeadLetter(
          event.id,
          'STUCK_MAX_ATTEMPTS_EXHAUSTED',
          'Event was locked beyond timeout repeatedly',
          now
        );
      } else {
        // Safe to retry
        const backoffDelay = calculateBackoffDelay(
          event.attemptCount,
          {
            baseDelayMs: this.config.outboxBackoffBaseMs,
            maxDelayMs: 60000,
            maxRetries: event.maxAttempts,
          },
          this.randomFn
        );
        await this.repository.scheduleRetry(
          event.id,
          now + backoffDelay,
          'STUCK_EVENT_RECOVERED',
          'Lock expired; released for retry',
          now
        );
      }
    }

    return stuckEvents.length;
  }

  /**
   * Handles an ambiguous submission outcome (timeout or unknown outcome)
   */
  private async handleAmbiguousSubmission(
    tx: any,
    event: OutboxEventRecord
  ): Promise<void> {
    this.auditService.record({
      actorType: 'SYSTEM',
      action: 'SUBMISSION_OUTCOME_AMBIGUOUS',
      correlationId: tx.correlationId,
      resourceType: 'TRANSACTION',
      resourceId: tx.gatewayRequestId,
      metadata: { outboxEventId: event.id, attemptCount: event.attemptCount },
    });

    // 1. Move transaction to RECONCILIATION_REQUIRED
    await this.transactionsService.markTimeout(
      tx.gatewayRequestId,
      'Ambiguous timeout during peer proposal dispatch'
    );

    // 2. Query adapter if supported
    if (this.blockchainAdapter.findTransactionByIdempotencyKey) {
      try {
        const found = await this.blockchainAdapter.findTransactionByIdempotencyKey(
          tx.gatewayRequestId
        );
        if (found && found.fabricTransactionId) {
          // Found on adapter! Recover state to submitted
          await this.transactionsService.markSubmitted(tx.gatewayRequestId, found.fabricTransactionId);
          await this.enqueueVerifyCommit(tx, found.fabricTransactionId);
          await this.repository.completeEvent(event.id, this.nowFn());
          return;
        }
      } catch {
        // Fall through to reconciliation retention
      }
    }

    // Retain reconciliation state and schedule retry if under max attempts
    const now = this.nowFn();
    if (event.attemptCount >= event.maxAttempts) {
      await this.repository.markDeadLetter(
        event.id,
        'AMBIGUOUS_MAX_ATTEMPTS',
        'Submission outcome remained ambiguous after max attempts',
        now
      );
    } else {
      const delay = calculateBackoffDelay(
        event.attemptCount,
        {
          baseDelayMs: this.config.outboxBackoffBaseMs,
          maxDelayMs: 60000,
          maxRetries: event.maxAttempts,
        },
        this.randomFn
      );
      await this.repository.scheduleRetry(
        event.id,
        now + delay,
        'TIMEOUT_AMBIGUOUS',
        'Submission outcome ambiguous; awaiting reconciliation',
        now
      );
    }
  }

  /**
   * Handles error transitions for an outbox event
   */
  private async handleEventError(
    event: OutboxEventRecord,
    error: unknown,
    now: number
  ): Promise<void> {
    const classified = classifyError(error);

    // 1. Permanent Errors: Do NOT retry indefinitely
    if (classified.classification === 'PERMANENT') {
      await this.repository.markDeadLetter(
        event.id,
        classified.code,
        classified.sanitizedMessage,
        now
      );

      if (event.eventType === 'DISPATCH_LEDGER') {
        await this.transactionsService.markFailed(
          event.gatewayRequestId,
          classified.code,
          classified.sanitizedMessage
        );
      }
      return;
    }

    // 2. Max attempts reached: DEAD_LETTER
    if (event.attemptCount >= event.maxAttempts) {
      await this.repository.markDeadLetter(
        event.id,
        classified.code,
        `Exhausted all ${event.maxAttempts} attempts: ${classified.sanitizedMessage}`,
        now
      );

      if (event.eventType === 'DISPATCH_LEDGER') {
        await this.transactionsService.markFailed(
          event.gatewayRequestId,
          'OUTBOX_RETRIES_EXHAUSTED',
          `Dispatched ${event.maxAttempts} times without success`
        );
      }
      return;
    }

    // 3. Transient Error: Schedule exponential backoff with bounded jitter
    const backoffDelay = calculateBackoffDelay(
      event.attemptCount,
      {
        baseDelayMs: this.config.outboxBackoffBaseMs,
        maxDelayMs: 60000,
        maxRetries: event.maxAttempts,
      },
      this.randomFn
    );

    await this.repository.scheduleRetry(
      event.id,
      now + backoffDelay,
      classified.code,
      classified.sanitizedMessage,
      now
    );
  }

  private async enqueueVerifyCommit(tx: any, fabricTxId?: string): Promise<void> {
    try {
      await this.repository.enqueueAtomic({
        transactionId: tx.id,
        gatewayRequestId: tx.gatewayRequestId,
        eventType: 'VERIFY_COMMIT',
        status: 'PENDING',
        payload: { fabricTransactionId: fabricTxId || tx.fabricTransactionId },
        attemptCount: 0,
        attempts: 0,
        maxAttempts: this.config.outboxMaxRetries,
        nextAttemptAt: this.nowFn(),
        lockedAt: null,
        lockedBy: null,
        lastErrorCode: null,
        lastError: null,
        processedAt: null,
        deduplicationKey: `verify:${tx.id}`,
      });
    } catch {
      // Deduplication hit or already enqueued
    }
  }

  private async enqueueWebhookNotification(
    tx: any,
    status: string,
    blockchainTxHash?: string,
    errorMessage?: string
  ): Promise<void> {
    try {
      await this.repository.enqueueAtomic({
        transactionId: tx.id,
        gatewayRequestId: tx.gatewayRequestId,
        eventType: 'DELIVER_WEBHOOK',
        status: 'PENDING',
        payload: {
          gatewayRequestId: tx.gatewayRequestId,
          correlationId: tx.correlationId,
          status,
          blockchainTxHash: blockchainTxHash || null,
          errorMessage: errorMessage || null,
        },
        attemptCount: 0,
        attempts: 0,
        maxAttempts: this.config.switchingWebhookMaxRetries,
        nextAttemptAt: this.nowFn(),
        lockedAt: null,
        lockedBy: null,
        lastErrorCode: null,
        lastError: null,
        processedAt: null,
        deduplicationKey: `webhook:${status}:${tx.id}`,
      });
    } catch {
      // Deduplication hit or already enqueued
    }
  }

  /**
   * Webhook-delivery observability: queue state (from the outbox, scoped to
   * DELIVER_WEBHOOK events) combined with in-process delivery attempt metrics.
   * Contains no secrets and no raw transaction payloads.
   */
  async getWebhookMetrics() {
    const outboxMetrics = (await this.repository.getMetricsByType(
      'DELIVER_WEBHOOK',
      this.nowFn()
    )) as OutboxMetrics;
    const delivery = this.webhookService.getDeliveryMetrics();

    return {
      pendingCount: outboxMetrics.pendingCount,
      processingCount: outboxMetrics.processingCount,
      retryPendingCount: outboxMetrics.retryPendingCount,
      completedCount: outboxMetrics.completedCount,
      deadLetterCount: outboxMetrics.deadLetterCount,
      oldestPendingAgeMs: outboxMetrics.oldestPendingAgeMs,
      totalAttempts: delivery.totalAttempts,
      successCount: delivery.successCount,
      failureCount: delivery.failureCount,
      retryableFailureCount: delivery.retryableFailureCount,
      permanentFailureCount: delivery.permanentFailureCount,
      ambiguousCount: delivery.ambiguousCount,
      lastSuccessAt: delivery.lastSuccessAt,
      lastAttemptAt: delivery.lastAttemptAt,
      lastErrorCode: delivery.lastErrorCode ?? outboxMetrics.lastErrorCode,
    };
  }

  async getObservability(): Promise<WorkerObservability> {
    // `await` also tolerates the synchronous in-memory implementation.
    const metrics = (await this.repository.getMetrics(this.nowFn())) as OutboxMetrics;
    return {
      workerId: this.workerId,
      isRunning: this.isRunning,
      isShuttingDown: this.isShuttingDown,
      lastPollTime: this.lastPollTime,
      activeProcessingCount: this.inFlightTasks.size,
      totalProcessedCount: this.totalProcessedCount,
      totalErrorsCount: this.totalErrorsCount,
      metrics,
    };
  }
}
