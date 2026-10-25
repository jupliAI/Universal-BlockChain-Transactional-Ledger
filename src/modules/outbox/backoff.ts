/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ClassifiedError, ErrorClassification } from './outbox.types.ts';

export interface BackoffPolicyConfig {
  baseDelayMs: number;
  maxDelayMs: number;
  maxRetries: number; // Represents total attempts allowed (including attempt 1)
  jitterRatio?: number; // e.g. 0.25 (up to 25% jitter)
}

/**
 * Calculates exponential backoff with bounded jitter according to the UBTL standard policy:
 * delay = min(maxDelay, baseDelay * 2^(attemptCount - 1)) + boundedJitter
 *
 * @param attemptCount Number of attempts already performed (1-indexed for the completed attempt)
 * @param config Backoff configuration
 * @param randomFn Injectable random source (returns [0, 1)) for deterministic testing
 */
export function calculateBackoffDelay(
  attemptCount: number,
  config: BackoffPolicyConfig,
  randomFn: () => number = Math.random
): number {
  if (attemptCount <= 0) return 0;

  // Base exponential delay
  const exponential = config.baseDelayMs * Math.pow(2, attemptCount - 1);
  const cappedBase = Math.min(config.maxDelayMs, exponential);

  // Bounded jitter (0 to jitterMax, default max 25% of cappedBase or 500ms)
  const jitterRatio = config.jitterRatio !== undefined ? config.jitterRatio : 0.25;
  const jitterMax = Math.min(500, cappedBase * jitterRatio);
  const jitter = Math.min(jitterMax, Math.floor(randomFn() * (jitterMax + 1)));

  return cappedBase + jitter;
}

/**
 * Classifies an error into TRANSIENT, PERMANENT, or AMBIGUOUS.
 * Sanitizes the message to remove API keys, secrets, and raw stack traces.
 */
export function classifyError(error: unknown): ClassifiedError {
  let rawMessage = '';
  let rawCode = '';

  if (error instanceof Error) {
    rawMessage = error.message;
    rawCode = (error as any).code || error.name;
  } else if (typeof error === 'string') {
    rawMessage = error;
  } else if (typeof error === 'object' && error !== null) {
    rawMessage = (error as any).message || JSON.stringify(error);
    rawCode = (error as any).code || (error as any).errorCode || '';
  } else {
    rawMessage = String(error);
  }

  // 1. Sanitize sensitive information (tokens, keys, secrets). The capturing
  //    group preserves the parameter name while redacting the value.
  const sanitized = rawMessage
    .replace(/((?:key|secret|token|password|auth|authorization)=)['"]?[^&'"\s]+['"]?/gi, '$1[REDACTED]')
    .replace(/(?:Bearer\s+)[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .slice(0, 300);

  const normalized = (rawCode + ' ' + rawMessage).toUpperCase();

  // 2. Honor an explicit classification when the throwing layer already knows the
  //    outcome (e.g. WebhookDeliveryError distinguishes retryable 5xx from
  //    permanent 4xx from an ambiguous client timeout). This avoids brittle
  //    re-derivation from status codes embedded in error text.
  const explicit = (error as { errorClassification?: unknown } | null)?.errorClassification;
  if (explicit === 'TRANSIENT' || explicit === 'PERMANENT' || explicit === 'AMBIGUOUS') {
    return {
      classification: explicit,
      code: rawCode || `${explicit}_ERROR`,
      sanitizedMessage: sanitized,
    };
  }

  // 3. Classify: PERMANENT (never retry indefinitely)
  if (
    normalized.includes('VALIDATION_ERROR') ||
    normalized.includes('INVALID_PAYLOAD') ||
    normalized.includes('MISSING_') ||
    normalized.includes('UNSUPPORTED_TYPE') ||
    normalized.includes('UNAUTHORIZED') ||
    normalized.includes('FORBIDDEN') ||
    normalized.includes('PERMISSION_DENIED') ||
    normalized.includes('BAD_REQUEST') ||
    normalized.includes('INVALID_ARGUMENT') ||
    normalized.includes('ENDORSEMENT_POLICY_FAILURE')
  ) {
    return {
      classification: 'PERMANENT',
      code: rawCode || 'PERMANENT_ERROR',
      sanitizedMessage: sanitized,
    };
  }

  // 3. Classify: AMBIGUOUS (do NOT blindly resubmit without reconciliation)
  if (
    normalized.includes('TIMEOUT') ||
    normalized.includes('DEADLINE_EXCEEDED') ||
    normalized.includes('ETIMEDOUT') ||
    normalized.includes('ESOCKETTIMEDOUT') ||
    normalized.includes('PROPOSAL_TIMEOUT') ||
    normalized.includes('COMMIT_TIMEOUT') ||
    normalized.includes('AMBIGUOUS') ||
    normalized.includes('UNKNOWN_OUTCOME')
  ) {
    return {
      classification: 'AMBIGUOUS',
      code: rawCode || 'TIMEOUT_AMBIGUOUS',
      sanitizedMessage: sanitized,
    };
  }

  // 4. Classify: TRANSIENT (safe to retry with exponential backoff)
  return {
    classification: 'TRANSIENT',
    code: rawCode || 'TRANSIENT_NETWORK_ERROR',
    sanitizedMessage: sanitized,
  };
}
