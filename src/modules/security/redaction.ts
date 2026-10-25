/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Single source of truth for secret redaction. Kept dependency-free so that
 * every layer that logs or persists (webhook delivery, audit trail,
 * reconciliation evidence) can reuse the exact same rules without importing a
 * higher-level module.
 */

/**
 * Redacts credential-shaped substrings from any text before it is logged,
 * persisted to the audit trail, or surfaced through an API. This is a
 * best-effort scrubber, not a substitute for never embedding secrets in a
 * message in the first place.
 */
export function redactSecrets(input: string): string {
  return input
    .replace(/((?:key|secret|token|password|passwd|auth|authorization|apikey|api_key)=)['"]?[^&'"\s]+['"]?/gi, '$1[REDACTED]')
    .replace(/(?:Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(
      /(x[-_]?[a-z0-9_-]*(?:key|secret|token|signature|auth|credential)[a-z0-9_-]*\s*[:=]\s*)['"]?[^'"\s,}]+['"]?/gi,
      '$1[REDACTED]'
    );
}

/**
 * Records whose values must never be copied into logs, audit metadata or APIs.
 *
 * Matching is done on a NORMALIZED key ({@link normalizeKeyForComparison}:
 * lowercased with every non-alphanumeric character removed), and a key is
 * sensitive when it CONTAINS one of these fragments. Two defects of the previous
 * literal-list approach are fixed by this:
 *
 *  - Header-style and differently-cased names were missed entirely. `x-api-key`,
 *    `xApiKey` and `X_API_KEY` all normalize to `xapikey`, which contains
 *    `apikey`; `x-switching-signature` contains `signature`; `tlsCert` /
 *    `clientCert` contain `cert`.
 *  - Mixed-case entries could never match at all, because the compared key was
 *    lowercased (`'tlscert' !== 'tlsCert'`). The list below is therefore stored
 *    already normalized.
 *
 * Fragments are deliberately chosen so that a legitimately non-secret
 * identifier stays readable: `idempotencyKey`, `deduplicationKey`,
 * `gatewayRequestId`, `blockHash`, `evidenceSource` and `verdict` are NOT
 * redacted (no bare `key` fragment is used).
 */
const SENSITIVE_KEY_FRAGMENTS = [
  'apikey',
  'authorization',
  'authentication',
  'bearer',
  'cert',
  'certificate',
  'clientkey',
  'credential',
  'mnemonic',
  'passphrase',
  'passwd',
  'password',
  'privatekey',
  'secret',
  'signature',
  'signingkey',
  'token',
];

/**
 * Keys that are sensitive only as a whole word. `auth` is kept exact so that an
 * unrelated key such as `author` is not silently redacted.
 */
const SENSITIVE_KEY_EXACT = ['auth'];

/**
 * Normalizes a key for comparison. Casing and separators must not be able to
 * smuggle a secret past the redactor: `x-api-key`, `xApiKey`, `X_API_KEY` and
 * `xapikey` are the same header.
 */
export function normalizeKeyForComparison(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** `true` when the value of `key` must never reach a log, audit entry or API. */
export function isSensitiveKeyName(key: string): boolean {
  const normalized = normalizeKeyForComparison(key);
  if (normalized === '') return false;
  if (SENSITIVE_KEY_EXACT.includes(normalized)) return true;
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

/**
 * Recursively sanitizes an arbitrary value for logging: redacts credential
 * shaped strings, replaces values of sensitive keys, bounds depth, and
 * truncates long strings. Raw transaction payloads must never be logged.
 */
export function sanitizeForLog(value: unknown, depth = 0, maxStringLength = 200): unknown {
  if (depth > 4) return '[TRUNCATED]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return redactSecrets(value).slice(0, maxStringLength);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((v) => sanitizeForLog(v, depth + 1, maxStringLength));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKeyName(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = sanitizeForLog(v, depth + 1, maxStringLength);
      }
    }
    return out;
  }
  return '[UNSERIALIZABLE]';
}
