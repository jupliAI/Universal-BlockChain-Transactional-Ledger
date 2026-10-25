/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { UbtlConfig } from '../../config/environment.ts';
import { AuditService } from '../audit/audit.service.ts';
import {
  GATEWAY_WEBHOOK_SIGNATURE_HEADER,
  GATEWAY_WEBHOOK_TIMESTAMP_HEADER,
  signOutboundRequest,
} from '../auth/hmac-signature.ts';
import { ErrorClassification } from '../outbox/outbox.types.ts';
import { redactSecrets, sanitizeForLog } from '../security/redaction.ts';

// Re-exported for backward compatibility: redaction rules now live in a single
// dependency-free module (src/modules/security/redaction.ts) so that every
// logging/persistence layer applies identical rules.
export { redactSecrets, sanitizeForLog };

export type WebhookStatus = 'submitted' | 'pending' | 'confirmed' | 'failed' | 'timeout';

export interface WebhookPayload {
  gatewayRequestId: string;
  correlationId: string;
  status: WebhookStatus;
  blockchainTxHash: string | null;
  errorMessage: string | null;
}

/**
 * Delivery outcome for a single outbound webhook attempt.
 *
 * `classification` is deliberately explicit so the outbox worker can apply the
 * shared retry policy without re-deriving it from an HTTP status:
 *   - TRANSIENT  → retryable (HTTP 5xx, 408/425/429, connection failures)
 *   - PERMANENT  → do not retry indefinitely (other HTTP 4xx)
 *   - AMBIGUOUS  → the request may have reached the receiver (client timeout);
 *                  safe to retry ONLY because delivery is at-least-once and the
 *                  receiver is required to deduplicate.
 *
 * `success` is true only for a 2xx response. Nothing else is ever reported as a
 * successful delivery.
 */
export interface WebhookDeliveryResult {
  success: boolean;
  httpStatus?: number;
  classification: ErrorClassification | null;
  errorCode?: string;
  /** Sanitized (secret-redacted, truncated) error text — safe to log/persist. */
  error?: string;
  /** Sanitized response body — never the raw upstream body. */
  responseBody?: unknown;
  attemptNumber?: number;
  durationMs: number;
  deliveredAt: string;
}

/**
 * Aggregate, in-process webhook delivery metrics. These describe delivery
 * attempts made by THIS process only; queue-state counts (pending / retrying /
 * dead-letter) live in the outbox metrics and are combined at the health layer.
 */
export interface WebhookDeliveryMetrics {
  totalAttempts: number;
  successCount: number;
  failureCount: number;
  retryableFailureCount: number;
  permanentFailureCount: number;
  ambiguousCount: number;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastErrorCode: string | null;
}

/**
 * Raised by the outbox worker when a webhook delivery does not succeed so that
 * the shared classification/backoff machinery applies. Carries an explicit
 * classification so `classifyError()` does not have to guess from a status code.
 */
export class WebhookDeliveryError extends Error {
  public readonly code: string;
  public readonly errorClassification: ErrorClassification;
  public readonly httpStatus?: number;

  constructor(
    message: string,
    code: string,
    errorClassification: ErrorClassification,
    httpStatus?: number
  ) {
    super(message);
    this.name = 'WebhookDeliveryError';
    this.code = code;
    this.errorClassification = errorClassification;
    this.httpStatus = httpStatus;
  }
}

export class WebhookService {
  private deliveries: Array<{ payload: WebhookPayload; result: WebhookDeliveryResult }> = [];

  private metrics: WebhookDeliveryMetrics = {
    totalAttempts: 0,
    successCount: 0,
    failureCount: 0,
    retryableFailureCount: 0,
    permanentFailureCount: 0,
    ambiguousCount: 0,
    lastSuccessAt: null,
    lastAttemptAt: null,
    lastErrorCode: null,
  };

  constructor(
    private readonly config: UbtlConfig,
    private readonly auditService: AuditService
  ) {}

  /**
   * Delivers asynchronous callback to the Digital Switching system
   * Target: POST {SWITCHING_BASE_URL}{SWITCHING_WEBHOOK_ENDPOINT}
   * (default endpoint: /api/v1/webhooks/gateway)
   *
   * This method NEVER throws: it returns a classified outcome so the caller can
   * decide whether to retry. It never mutates ledger/transaction state.
   */
  async deliverWebhook(payload: WebhookPayload, attemptNumber?: number): Promise<WebhookDeliveryResult> {
    const targetUrl = `${this.config.switchingBaseUrl.replace(/\/$/, '')}${this.config.switchingWebhookEndpoint}`;
    const deliveredAt = new Date().toISOString();
    const startedAtMs = Date.now();

    try {
      const rawBody = JSON.stringify(payload);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Api-Key': this.config.switchingWebhookApiKey,
        'X-Correlation-Id': payload.correlationId,
      };

      // Layer 2 — mirror Switching's GatewayWebhookGuard: when a shared signing
      // secret is configured, sign the exact bytes sent over
      // `${timestamp}.${rawBody}` with HMAC-SHA256 and the `x-gateway-*`
      // header names that guard already verifies. The timestamp is regenerated
      // per attempt (fresh replay window) while the body — and therefore the
      // logical event identity — is unchanged across retries.
      if (this.config.switchingWebhookSigningSecret) {
        const signed = signOutboundRequest(
          this.config.switchingWebhookSigningSecret,
          rawBody,
          {
            signatureHeaderName: GATEWAY_WEBHOOK_SIGNATURE_HEADER,
            timestampHeaderName: GATEWAY_WEBHOOK_TIMESTAMP_HEADER,
          }
        );
        headers[signed.signatureHeaderName] = signed.signature;
        headers[signed.timestampHeaderName] = signed.timestamp;
      }

      const response = await fetch(targetUrl, {
        method: 'POST',
        headers,
        body: rawBody,
        signal: AbortSignal.timeout(this.config.switchingWebhookTimeoutMs),
      });

      const parsedBody = await response.json().catch(() => null);
      const sanitizedBody = sanitizeForLog(parsedBody);

      if (response.ok) {
        const result: WebhookDeliveryResult = {
          success: true,
          httpStatus: response.status,
          classification: null,
          attemptNumber,
          responseBody: sanitizedBody,
          durationMs: Date.now() - startedAtMs,
          deliveredAt,
        };
        this.recordDelivery(payload, result);
        this.auditService.record({
          actorType: 'SYSTEM',
          action: 'WEBHOOK_DELIVERED',
          correlationId: payload.correlationId,
          resourceType: 'TRANSACTION',
          resourceId: payload.gatewayRequestId,
          endpoint: targetUrl,
          httpStatus: response.status,
          metadata: {
            status: payload.status,
            success: true,
            attemptNumber: attemptNumber ?? null,
            durationMs: result.durationMs,
            responseBody: sanitizedBody,
          },
        });
        return result;
      }

      // Non-2xx: classify per documented policy. Nothing here reverses ledger state.
      const classification = this.classifyHttpStatus(response.status);
      const errorCode = `WEBHOOK_HTTP_${response.status}`;
      const result: WebhookDeliveryResult = {
        success: false,
        httpStatus: response.status,
        classification,
        errorCode,
        error: `Switching webhook endpoint returned HTTP ${response.status}`,
        responseBody: sanitizedBody,
        attemptNumber,
        durationMs: Date.now() - startedAtMs,
        deliveredAt,
      };
      this.recordDelivery(payload, result);
      this.auditService.record({
        actorType: 'SYSTEM',
        action: 'WEBHOOK_DELIVERY_FAILED',
        correlationId: payload.correlationId,
        resourceType: 'TRANSACTION',
        resourceId: payload.gatewayRequestId,
        endpoint: targetUrl,
        httpStatus: response.status,
        metadata: {
          status: payload.status,
          classification,
          errorCode,
          attemptNumber: attemptNumber ?? null,
          durationMs: result.durationMs,
          responseBody: sanitizedBody,
        },
      });
      return result;
    } catch (err: unknown) {
      // Network-level failure. Distinguish a client-side timeout (ambiguous:
      // the receiver may have applied the callback) from a connection failure
      // (transient: the request never left).
      const { classification, errorCode, message } = this.classifyTransportError(err);
      const result: WebhookDeliveryResult = {
        success: false,
        classification,
        errorCode,
        error: message,
        attemptNumber,
        durationMs: Date.now() - startedAtMs,
        deliveredAt,
      };
      this.recordDelivery(payload, result);
      this.auditService.record({
        actorType: 'SYSTEM',
        action: 'WEBHOOK_DELIVERY_FAILED',
        correlationId: payload.correlationId,
        resourceType: 'TRANSACTION',
        resourceId: payload.gatewayRequestId,
        endpoint: targetUrl,
        metadata: {
          status: payload.status,
          classification,
          errorCode,
          attemptNumber: attemptNumber ?? null,
          durationMs: result.durationMs,
          error: message,
        },
      });
      return result;
    }
  }

  /**
   * Documented HTTP classification policy for the Switching webhook endpoint.
   *   - 5xx, 408 (Request Timeout), 425 (Too Early), 429 (Too Many Requests) → TRANSIENT
   *   - other 4xx → PERMANENT (do not retry indefinitely; surface for operator review)
   *   - any other non-2xx (e.g. unexpected 3xx) → PERMANENT
   */
  private classifyHttpStatus(status: number): ErrorClassification {
    if (status >= 500) return 'TRANSIENT';
    if (status === 408 || status === 425 || status === 429) return 'TRANSIENT';
    return 'PERMANENT';
  }

  private classifyTransportError(err: unknown): {
    classification: ErrorClassification;
    errorCode: string;
    message: string;
  } {
    const name = err instanceof Error ? err.name : '';
    const rawMessage = err instanceof Error ? err.message : String(err);
    const message = redactSecrets(rawMessage).slice(0, 300);
    const normalized = `${name} ${rawMessage}`.toUpperCase();

    if (
      name === 'TimeoutError' ||
      name === 'AbortError' ||
      normalized.includes('TIMEOUT') ||
      normalized.includes('ABORTED')
    ) {
      // Ambiguous: the request may have been received and applied upstream.
      return {
        classification: 'AMBIGUOUS',
        errorCode: 'WEBHOOK_DELIVERY_TIMEOUT',
        message: `Webhook delivery timed out after ${this.config.switchingWebhookTimeoutMs}ms (outcome ambiguous)`,
      };
    }

    if (
      normalized.includes('ECONNREFUSED') ||
      normalized.includes('ECONNRESET') ||
      normalized.includes('ENOTFOUND') ||
      normalized.includes('EAI_AGAIN') ||
      normalized.includes('EPIPE') ||
      normalized.includes('FETCH FAILED') ||
      normalized.includes('UND_ERR')
    ) {
      return {
        classification: 'TRANSIENT',
        errorCode: 'WEBHOOK_CONNECTION_FAILURE',
        message: `Webhook connection failure: ${message}`,
      };
    }

    return {
      classification: 'TRANSIENT',
      errorCode: 'WEBHOOK_DELIVERY_ERROR',
      message: `Webhook delivery error: ${message}`,
    };
  }

  private recordDelivery(payload: WebhookPayload, result: WebhookDeliveryResult): void {
    this.deliveries.unshift({ payload, result });
    if (this.deliveries.length > 500) this.deliveries.pop();

    this.metrics.totalAttempts++;
    this.metrics.lastAttemptAt = result.deliveredAt;

    if (result.success) {
      this.metrics.successCount++;
      this.metrics.lastSuccessAt = result.deliveredAt;
    } else {
      this.metrics.failureCount++;
      this.metrics.lastErrorCode = result.errorCode || 'WEBHOOK_DELIVERY_FAILED';
      if (result.classification === 'PERMANENT') {
        this.metrics.permanentFailureCount++;
      } else if (result.classification === 'AMBIGUOUS') {
        this.metrics.ambiguousCount++;
      } else {
        this.metrics.retryableFailureCount++;
      }
    }
  }

  /**
   * Aggregate delivery metrics for health/administrative observability.
   * Contains no secrets and no raw transaction payloads.
   */
  getDeliveryMetrics(): WebhookDeliveryMetrics {
    return { ...this.metrics };
  }

  getRecentDeliveries() {
    return this.deliveries.slice(0, 50).map((d) => ({
      payload: d.payload,
      // Only the sanitized outcome is exposed; raw response bodies are never returned.
      result: {
        success: d.result.success,
        httpStatus: d.result.httpStatus,
        classification: d.result.classification,
        errorCode: d.result.errorCode,
        error: d.result.error,
        attemptNumber: d.result.attemptNumber,
        durationMs: d.result.durationMs,
        deliveredAt: d.result.deliveredAt,
      },
    }));
  }
}
