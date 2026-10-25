/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { timingSafeEqual } from 'crypto';
import { AuditService } from '../audit/audit.service.ts';
import {
  CANONICALIZATION_SPEC,
  CanonicalResult,
  computeCanonicalHash,
  HASH_ALGORITHM,
  HASH_VERSION,
} from './canonicalizer.ts';

export interface HashVerificationResult {
  verified: boolean;
  computedHash: string;
  expectedHash: string;
  canonicalPayload: string;
  hashAlgorithm: string;
  hashVersion: string;
  canonicalizationSpec: string;
  error?: string;
}

export class HashingService {
  constructor(private readonly auditService: AuditService) {}

  /**
   * Validates whether a string is a valid 64-character lowercase SHA-256 hexadecimal digest
   */
  isValidSha256Hex(hash: string): boolean {
    return typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash);
  }

  /**
   * Computes authoritative server-side payload hash
   */
  hashPayload(transactionType: string, payload: unknown, schemaVersion = '1.0'): CanonicalResult {
    return computeCanonicalHash(transactionType, payload, schemaVersion);
  }

  /**
   * Verifies that the authoritative stored payload matches an expected hash
   * Uses crypto.timingSafeEqual for constant-time comparison
   */
  verifyPayload(
    transactionType: string,
    payload: unknown,
    expectedHash: string,
    schemaVersion = '1.0',
    auditContext?: { correlationId?: string; gatewayRequestId?: string }
  ): HashVerificationResult {
    // 1. Reject malformed expected hash
    if (!this.isValidSha256Hex(expectedHash)) {
      this.auditService.record({
        actorType: 'SYSTEM',
        action: 'HASH_VERIFICATION_MALFORMED_INPUT',
        correlationId: auditContext?.correlationId,
        resourceType: 'TRANSACTION',
        resourceId: auditContext?.gatewayRequestId,
        metadata: { expectedHash, error: 'Malformed SHA-256 digest input' },
      });

      return {
        verified: false,
        computedHash: '',
        expectedHash,
        canonicalPayload: '',
        hashAlgorithm: HASH_ALGORITHM,
        hashVersion: HASH_VERSION,
        canonicalizationSpec: CANONICALIZATION_SPEC,
        error: 'Malformed expected hash: must be 64-character lowercase hex string',
      };
    }

    // 2. Compute canonical hash of the stored payload
    let canonicalResult: CanonicalResult;
    try {
      canonicalResult = computeCanonicalHash(transactionType, payload, schemaVersion);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        verified: false,
        computedHash: '',
        expectedHash,
        canonicalPayload: '',
        hashAlgorithm: HASH_ALGORITHM,
        hashVersion: HASH_VERSION,
        canonicalizationSpec: CANONICALIZATION_SPEC,
        error: `Canonicalization failed: ${errorMsg}`,
      };
    }

    // 3. Constant-time digest comparison
    const bufComputed = Buffer.from(canonicalResult.payloadHash, 'utf8');
    const bufExpected = Buffer.from(expectedHash, 'utf8');

    const hashesMatch =
      bufComputed.length === bufExpected.length && timingSafeEqual(bufComputed, bufExpected);

    if (!hashesMatch) {
      // Record auditable integrity violation
      this.auditService.record({
        actorType: 'SYSTEM',
        action: 'INTEGRITY_VIOLATION_TAMPER_DETECTED',
        correlationId: auditContext?.correlationId,
        resourceType: 'TRANSACTION',
        resourceId: auditContext?.gatewayRequestId,
        metadata: {
          storedHash: expectedHash,
          recomputedHash: canonicalResult.payloadHash,
          transactionType,
          warning: 'Authoritative stored payload diverged from recorded cryptographic hash anchor',
        },
      });
    }

    return {
      verified: hashesMatch,
      computedHash: canonicalResult.payloadHash,
      expectedHash,
      canonicalPayload: canonicalResult.canonicalString,
      hashAlgorithm: HASH_ALGORITHM,
      hashVersion: HASH_VERSION,
      canonicalizationSpec: CANONICALIZATION_SPEC,
      error: hashesMatch ? undefined : 'Computed hash does not match expected hash',
    };
  }
}
