/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Shared HMAC-SHA256 request/response signing for the UBTL <-> Digital
 * Switching integration.
 *
 * This module is the UBTL counterpart of Switching's
 * `backend/src/common/utils/webhook-crypto.util.ts`. The two MUST stay
 * byte-for-byte compatible: both sides sign the ASCII string
 * `${timestamp}.${rawBody}` with HMAC-SHA256 and hex-encode the digest. Any
 * divergence here silently breaks every signature, so the format is
 * intentionally trivial and duplicated (not "refactored") on purpose.
 *
 * The convention adopted for Prompt 05 is Switching's existing one:
 *   - Switching -> UBTL (submit):  `x-switching-signature` / `x-switching-timestamp`
 *   - UBTL -> Switching (webhook): `x-gateway-signature`   / `x-gateway-timestamp`
 *
 * No custom headers are invented.
 */

export const HMAC_ALGORITHM = 'sha256' as const;

/** Default anti-replay window (5 minutes), matching Switching's default. */
export const DEFAULT_SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

/** Header names Switching signs outbound requests with (its default convention). */
export const SWITCHING_OUTBOUND_SIGNATURE_HEADER = 'x-switching-signature';
export const SWITCHING_OUTBOUND_TIMESTAMP_HEADER = 'x-switching-timestamp';

/**
 * Header names Switching's `GatewayWebhookGuard` verifies inbound callbacks
 * with (hardcoded there, see its `x-gateway-*` reads).
 */
export const GATEWAY_WEBHOOK_SIGNATURE_HEADER = 'x-gateway-signature';
export const GATEWAY_WEBHOOK_TIMESTAMP_HEADER = 'x-gateway-timestamp';

/** The exact string both sides sign: `${timestamp}.${rawBody}`. */
export function buildSignedPayload(timestamp: string, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}

/** Hex-encoded HMAC-SHA256 digest of `payload` under `secret`. */
export function computeHmacSha256Hex(secret: string, payload: string): string {
  return createHmac(HMAC_ALGORITHM, secret).update(payload, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of two hex digests. Returns false for length
 * mismatches without leaking a timing side channel over the compared bytes.
 */
export function timingSafeHexEqual(expectedHex: string, providedHex: string): boolean {
  if (typeof expectedHex !== 'string' || typeof providedHex !== 'string') return false;
  const a = Buffer.from(expectedHex, 'utf8');
  const b = Buffer.from(providedHex, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface SignatureVerificationResult {
  valid: boolean;
  reason?: string;
}

export interface VerifySignatureParams {
  secret: string;
  timestamp: string | undefined;
  rawBody: string | undefined;
  signature: string | undefined;
  toleranceMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: number;
}

/**
 * Verifies an inbound HMAC signature over `${timestamp}.${rawBody}` and
 * enforces an anti-replay tolerance window. Mirrors Switching's
 * `verifyWebhookSignature` so both directions reject the same inputs.
 */
export function verifyInboundSignature(params: VerifySignatureParams): SignatureVerificationResult {
  const { secret, timestamp, rawBody, signature } = params;
  const toleranceMs = params.toleranceMs ?? DEFAULT_SIGNATURE_TOLERANCE_MS;

  if (!secret) {
    return { valid: false, reason: 'No shared secret configured' };
  }
  if (!timestamp) {
    return { valid: false, reason: 'Missing signature timestamp header' };
  }
  if (!signature) {
    return { valid: false, reason: 'Missing signature header' };
  }
  if (rawBody === undefined || rawBody === null) {
    return { valid: false, reason: 'Missing raw body (required for HMAC recomputation)' };
  }

  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum)) {
    return { valid: false, reason: 'Invalid signature timestamp (must be numeric UNIX epoch in ms)' };
  }

  const now = params.now ?? Date.now();
  const age = Math.abs(now - tsNum);
  if (age > toleranceMs) {
    return {
      valid: false,
      reason: `Signature timestamp outside tolerance window (age=${age}ms, tolerance=${toleranceMs}ms)`,
    };
  }

  const expected = computeHmacSha256Hex(secret, buildSignedPayload(timestamp, rawBody));
  if (!timingSafeHexEqual(expected, signature.toLowerCase())) {
    return { valid: false, reason: 'Signature mismatch' };
  }

  return { valid: true };
}

export interface SignedHeaders {
  signatureHeaderName: string;
  timestampHeaderName: string;
  signature: string;
  timestamp: string;
}

/**
 * Produces the signature headers for an outbound request. The timestamp is
 * freshly generated so each attempt carries its own replay window; the body
 * (and therefore the logical event identity) is unchanged across retries.
 */
export function signOutboundRequest(
  secret: string,
  rawBody: string,
  headerNames: { signatureHeaderName: string; timestampHeaderName: string },
  now: number = Date.now()
): SignedHeaders {
  const timestamp = String(now);
  const signature = computeHmacSha256Hex(secret, buildSignedPayload(timestamp, rawBody));
  return {
    signatureHeaderName: headerNames.signatureHeaderName,
    timestampHeaderName: headerNames.timestampHeaderName,
    signature,
    timestamp,
  };
}
