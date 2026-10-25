/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { UbtlConfig } from '../../config/environment.ts';
import { verifyInboundSignature } from './hmac-signature.ts';

/**
 * Constant-time comparison of two secret strings (defect D-2).
 *
 * Both inputs are SHA-256 digested before comparison so that inputs of
 * differing length are handled in constant time too: `timingSafeEqual` throws
 * on length mismatch, and an early `a.length !== b.length` return would leak
 * the expected credential's length through timing.
 */
function timingSafeStringEqual(a: string | undefined, b: string | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aDigest = createHash('sha256').update(a, 'utf8').digest();
  const bDigest = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(aDigest, bDigest);
}

export interface AuthContext {
  organizationId: string;
  organizationCode: string;
  roles: string[];
}

/**
 * Outcome of the inbound-signature layer (Switching -> UBTL).
 *   - `accepted` false  -> the request MUST be rejected with HTTP 401.
 *   - `accepted` true, `verified` false -> accepted during the documented
 *     graceful-rollout window but NOT cryptographically verified; callers
 *     should surface this honestly (never claim the request was signed).
 */
export interface InboundSignatureResult {
  accepted: boolean;
  verified: boolean;
  reason?: string;
}

/** Logical (non-durable) organization identifier used when no database is wired. */
export const LOGICAL_SWITCHING_ORGANIZATION_ID = 'org-switching-primary-001';

export interface AuthServiceOptions {
  /**
   * Durable `organizations.id` (UUID) for the Switching ingestion tenant.
   *
   * `transactions.organizationId` is a UUID column with a foreign key to
   * `organizations.id`, so the runtime cannot persist the logical identifier
   * directly. The composition root resolves it once and injects the UUID here.
   * Left undefined for the in-memory path, which keys on the logical id.
   */
  switchingOrganizationId?: string;
}

export class AuthService {
  constructor(
    private readonly config: UbtlConfig,
    private readonly options: AuthServiceOptions = {}
  ) {}

  /**
   * Validates inbound API key from Digital Switching system
   */
  validateSwitchingApiKey(apiKey?: string): AuthContext | null {
    if (!apiKey) return null;

    // In local dev/mock, accepts configured UBTL_API_KEY
    if (timingSafeStringEqual(apiKey, this.config.ubtlApiKey)) {
      return {
        organizationId: this.options.switchingOrganizationId || LOGICAL_SWITCHING_ORGANIZATION_ID,
        organizationCode: 'SWITCHING_SYSTEM',
        roles: ['INGESTION_CLIENT'],
      };
    }

    return null;
  }

  /**
   * Verifies Switching's outbound HMAC-SHA256 signature over
   * `${timestamp}.${rawBody}` (its default `x-switching-signature` /
   * `x-switching-timestamp` convention).
   *
   * Parity with Switching's own `GatewayWebhookGuard` is intentional:
   *   - No shared secret configured  -> layer 2 is SKIPPED (accepted).
   *   - Secret configured, invalid   -> rejected ONLY when
   *     SWITCHING_OUTBOUND_SIGNATURE_REQUIRED=true; otherwise accepted but
   *     reported as NOT verified (graceful rollout window).
   *
   * This is a real trade-off, not a silent bypass: a configured secret without
   * enforcement provides no protection while appearing to. Deployments that
   * configure the secret MUST also set ..._REQUIRED=true.
   */
  validateInboundSignature(params: {
    signature?: string;
    timestamp?: string;
    rawBody?: string;
  }): InboundSignatureResult {
    const secret = this.config.switchingOutboundSigningSecret;
    const required = this.config.switchingOutboundSignatureRequired;

    if (!secret) {
      return {
        accepted: true,
        verified: false,
        reason: required
          ? 'Signature required but no shared secret is configured'
          : 'No shared secret configured; signature layer skipped',
      };
    }

    const result = verifyInboundSignature({
      secret,
      timestamp: params.timestamp,
      rawBody: params.rawBody,
      signature: params.signature,
      toleranceMs: this.config.signatureToleranceMs,
    });

    if (result.valid) {
      return { accepted: true, verified: true };
    }

    if (required) {
      return { accepted: false, verified: false, reason: result.reason };
    }

    // Graceful rollout: a secret exists but the Gateway/Switching team has not
    // flipped enforcement on yet. Accept, but report honestly that the request
    // was NOT cryptographically verified.
    return {
      accepted: true,
      verified: false,
      reason: `Signature invalid but not enforced: ${result.reason ?? 'unknown'}`,
    };
  }

  /**
   * Validates administrative / operator API key
   */
  validateAdminApiKey(apiKey?: string): AuthContext | null {
    if (!apiKey) return null;

    if (timingSafeStringEqual(apiKey, this.config.ubtlAdminApiKey)) {
      return {
        organizationId: 'org-ubtl-operator-001',
        organizationCode: 'UBTL_ADMIN',
        roles: ['OPERATOR', 'ADMIN'],
      };
    }

    return null;
  }
}
