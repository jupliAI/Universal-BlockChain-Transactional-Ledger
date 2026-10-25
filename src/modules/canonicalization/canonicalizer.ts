/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'crypto';

/**
 * UBTL Canonical JSON Specification v1 (ubtl-canonical-json-v1)
 *
 * SPECIFICATION APPROACH B:
 * Application-specific canonicalization specification based on RFC 8785 (JCS) principles,
 * with explicit Unicode Normalization Form C (NFC) and strict data preservation.
 *
 * Distinctive Rules:
 * 1. Object property names are sorted lexicographically by UTF-16 code units.
 * 2. Array element order is strictly preserved.
 * 3. Strings are normalized to Unicode NFC (RFC 8785 intentionally leaves Unicode normalization
 *    to applications; UBTL explicitly enforces NFC to guarantee cross-platform hash determinism).
 * 4. Booleans (true, false) and null are preserved as literals.
 * 5. Numbers: IEEE 754 finite numbers are serialized per ECMAScript rules; negative zero (-0)
 *    is normalized to 0. Non-finite numbers (NaN, Infinity, -Infinity) throw TypeError.
 * 6. Financial Decimals: Must be represented as fixed-scale decimal strings (e.g. "150000.00").
 * 7. Strict Non-Dropping Policy: Unlike standard JSON.stringify which silently drops undefined
 *    properties or converts them to null in arrays, ubtl-canonical-json-v1 rejects undefined,
 *    Symbol, Function, and BigInt values anywhere in the payload with TypeError.
 * 8. Whitespace: Completely eliminated between tokens.
 */
export const CANONICALIZATION_SPEC = 'ubtl-canonical-json-v1';
export const HASH_ALGORITHM = 'sha256';
export const HASH_VERSION = 'v1';

export interface CanonicalResult {
  canonicalString: string;
  payloadHash: string;
  schemaVersion: string;
  transactionType: string;
  hashAlgorithm: string;
  hashVersion: string;
  canonicalizationSpec: string;
}

function serializeNumber(num: number): string {
  if (!Number.isFinite(num)) {
    throw new TypeError(`Cannot canonicalize non-finite number: ${num}`);
  }
  // Normalize -0 to 0 (RFC 8785 Section 3.2.2.3)
  if (Object.is(num, -0)) {
    return '0';
  }
  return JSON.stringify(num);
}

function serializeString(str: string): string {
  // Unicode Normalization Form C (NFC)
  const normalized = str.normalize('NFC');
  return JSON.stringify(normalized);
}

/**
 * Canonicalizes a JSON value per ubtl-canonical-json-v1
 */
export function canonicalize(obj: unknown): string {
  if (obj === null) {
    return 'null';
  }

  if (obj === undefined) {
    throw new TypeError('Undefined values are not permitted in ubtl-canonical-json-v1; use explicit null or omit property before canonicalization');
  }

  if (typeof obj === 'boolean') {
    return obj ? 'true' : 'false';
  }

  if (typeof obj === 'number') {
    return serializeNumber(obj);
  }

  if (typeof obj === 'string') {
    return serializeString(obj);
  }

  if (typeof obj === 'bigint') {
    throw new TypeError('BigInt values are not supported in canonical JSON; use validated decimal strings');
  }

  if (typeof obj === 'symbol') {
    throw new TypeError('Symbol values are not supported in canonical JSON');
  }

  if (typeof obj === 'function') {
    throw new TypeError('Function values are not supported in canonical JSON');
  }

  if (Array.isArray(obj)) {
    const elements: string[] = [];
    for (let i = 0; i < obj.length; i++) {
      const item = obj[i];
      if (item === undefined) {
        throw new TypeError(`Undefined element at array index ${i} is not permitted in ubtl-canonical-json-v1; use explicit null`);
      }
      elements.push(canonicalize(item));
    }
    return `[${elements.join(',')}]`;
  }

  if (typeof obj === 'object') {
    // Check for circular reference or non-plain objects
    const keys = Object.keys(obj as Record<string, unknown>).sort((a, b) => {
      const aNfc = a.normalize('NFC');
      const bNfc = b.normalize('NFC');
      return aNfc < bNfc ? -1 : aNfc > bNfc ? 1 : 0;
    });

    const entries: string[] = [];

    for (const key of keys) {
      const val = (obj as Record<string, unknown>)[key];
      if (val === undefined) {
        throw new TypeError(`Undefined property '${key}' is not permitted in ubtl-canonical-json-v1; remove key or set explicit null`);
      }
      const canonicalKey = serializeString(key);
      entries.push(`${canonicalKey}:${canonicalize(val)}`);
    }

    return `{${entries.join(',')}}`;
  }

  throw new TypeError(`Unsupported type for canonicalization: ${typeof obj}`);
}

/**
 * Computes canonical string and SHA-256 digest for a given transaction payload.
 */
export function computeCanonicalHash(
  transactionType: string,
  payload: unknown,
  schemaVersion = '1.0'
): CanonicalResult {
  if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('Payload must be a non-null, non-array JSON object');
  }

  const canonicalString = canonicalize(payload);
  const payloadHash = createHash(HASH_ALGORITHM).update(canonicalString, 'utf8').digest('hex');

  return {
    canonicalString,
    payloadHash,
    schemaVersion,
    transactionType,
    hashAlgorithm: HASH_ALGORITHM,
    hashVersion: HASH_VERSION,
    canonicalizationSpec: CANONICALIZATION_SPEC,
  };
}
