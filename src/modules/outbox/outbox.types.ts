/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type OutboxEventType = 'DISPATCH_LEDGER' | 'VERIFY_COMMIT' | 'DELIVER_WEBHOOK';

export type OutboxEventStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'RETRY_PENDING'
  | 'COMPLETED'
  | 'DEAD_LETTER'
  | 'IN_PROGRESS' // Backward-compatible alias for PROCESSING
  | 'FAILED';     // Backward-compatible alias for DEAD_LETTER

export interface OutboxEventRecord {
  id: string;
  transactionId: string;
  gatewayRequestId: string;
  eventType: OutboxEventType;
  status: OutboxEventStatus;
  payload: Record<string, unknown>;
  attemptCount: number;
  attempts: number; // Backward-compatibility alias
  maxAttempts: number;
  nextAttemptAt: number; // Milliseconds timestamp
  lockedAt: number | null; // Milliseconds timestamp
  lockedBy: string | null;
  lastErrorCode: string | null;
  lastError: string | null;
  processedAt: string | null;
  deduplicationKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OutboxMetrics {
  totalEvents: number;
  pendingCount: number;
  processingCount: number;
  retryPendingCount: number;
  completedCount: number;
  deadLetterCount: number;
  oldestPendingAgeMs: number;
  lastErrorCode: string | null;
}

export interface WorkerObservability {
  workerId: string;
  isRunning: boolean;
  isShuttingDown: boolean;
  lastPollTime: string | null;
  activeProcessingCount: number;
  totalProcessedCount: number;
  totalErrorsCount: number;
  metrics: OutboxMetrics;
}

export type ErrorClassification = 'TRANSIENT' | 'PERMANENT' | 'AMBIGUOUS';

export interface ClassifiedError {
  classification: ErrorClassification;
  code: string;
  sanitizedMessage: string;
}
