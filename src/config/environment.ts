/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import dotenv from 'dotenv';
import {
  CANONICALIZATION_SPEC,
  HASH_ALGORITHM,
  HASH_VERSION,
} from '../modules/canonicalization/canonicalizer.ts';

dotenv.config();

/**
 * Development-only fallback credentials. They are published verbatim in
 * `.env.example`, so they are NOT secrets. `validateEnvironment()` refuses to
 * start a production runtime that would fall back to them (or run with no value
 * at all): otherwise a deployment that simply forgot to set the key would accept
 * a publicly-known credential — full admin access in the admin-key case.
 */
export const DEV_FALLBACK_API_KEY = 'ubtl_dev_key_secret_switch_2026';
export const DEV_FALLBACK_ADMIN_API_KEY = 'ubtl_admin_secret_key_2026';

export interface UbtlConfig {
  nodeEnv: string;
  port: number;
  host: string;
  appUrl: string;
  logLevel: string;

  // Security
  ubtlApiKey: string;
  ubtlAdminApiKey: string;

  // Switching Integration
  switchingBaseUrl: string;
  switchingWebhookEndpoint: string;
  switchingWebhookApiKey: string;
  switchingWebhookTimeoutMs: number;
  switchingWebhookMaxRetries: number;

  // HMAC signing (Switching's existing convention — see modules/auth/hmac-signature.ts)
  /** Shared secret UBTL uses to VERIFY Switching's outbound submit calls. */
  switchingOutboundSigningSecret: string;
  /** When true, a missing/invalid inbound signature is rejected with HTTP 401. */
  switchingOutboundSignatureRequired: boolean;
  /** Shared secret UBTL uses to SIGN outbound webhook callbacks to Switching. */
  switchingWebhookSigningSecret: string;
  /** Anti-replay tolerance window for both directions (ms). */
  signatureToleranceMs: number;

  // Database
  databaseUrl: string;
  /**
   * Which persistence backend the runtime MUST use for transactions, lifecycle
   * history, idempotency, audit trail, outbox and reconciliation records.
   *  - 'auto'      : PostgreSQL when DATABASE_URL is configured, else in-memory
   *                  (development fallback; refuses to fall back in production).
   *  - 'postgres'  : require a reachable durable database; fail fast otherwise.
   *  - 'in-memory' : explicit non-durable simulation (development only).
   */
  persistenceBackend: 'auto' | 'postgres' | 'in-memory';

  // Blockchain Adapter
  blockchainAdapterMode: 'mock' | 'provider';

  // Mock Adapter Settings
  mockFabricCommitDelayMs: number;
  mockFabricFailureRate: number;
  mockFabricTimeoutRate: number;

  // Provider Settings
  fabricGatewayPeerEndpoint?: string;
  fabricGatewayTlsCertPath?: string;
  fabricGatewayClientCertPath?: string;
  fabricGatewayClientKeyPath?: string;
  fabricGatewayMspId?: string;
  fabricGatewayChannelName?: string;
  fabricGatewayChaincodeName?: string;
  fabricGatewayCommitTimeoutSeconds: number;
  fabricGatewayDiscoveryAsLocalhost: boolean;

    // Outbox & Hashing
  outboxPollIntervalMs: number;
  outboxBatchSize: number;
  outboxMaxRetries: number;
  outboxBackoffBaseMs: number;
  outboxStuckTimeoutMs: number;
  hashAlgorithm: string;
  canonicalizationSpec: string;
  hashVersion: string;

  // Reconciliation Engine
  reconciliationIntervalMinutes: number;
  reconciliationLookbackHours: number;
  reconciliationBatchSize: number;
  reconciliationMaxAttempts: number;
  /**
   * Lease TTL (seconds) for the durable cross-worker reconciliation lock. Bounds
   * crash recovery: a crashed worker's lock is reclaimed after this window.
   */
  reconciliationLockTtlSeconds: number;
}

export interface EnvironmentValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  mode: 'mock' | 'provider';
}

export function validateEnvironment(): EnvironmentValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const mode = (process.env.BLOCKCHAIN_ADAPTER_MODE || 'mock') as 'mock' | 'provider';

  if (mode !== 'mock' && mode !== 'provider') {
    errors.push(`Invalid BLOCKCHAIN_ADAPTER_MODE: "${mode}". Must be either "mock" or "provider".`);
  }

  // Provider Mode Fail-Fast Check
  if (mode === 'provider') {
    const requiredProviderVars = [
      'FABRIC_GATEWAY_PEER_ENDPOINT',
      'FABRIC_GATEWAY_TLS_CERT_PATH',
      'FABRIC_GATEWAY_CLIENT_CERT_PATH',
      'FABRIC_GATEWAY_CLIENT_KEY_PATH',
      'FABRIC_GATEWAY_MSP_ID',
      'FABRIC_GATEWAY_CHANNEL_NAME',
      'FABRIC_GATEWAY_CHAINCODE_NAME',
    ];

    for (const varName of requiredProviderVars) {
      if (!process.env[varName] || process.env[varName]?.trim() === '') {
        errors.push(`[PROVIDER_MODE_FAIL_FAST] Missing required Hyperledger Fabric provider environment variable: ${varName}`);
      }
    }

    // Commit timeout must be a positive integer; a non-numeric value would
    // silently coerce to NaN and make every commit-status deadline invalid.
    const commitTimeoutRaw = process.env.FABRIC_GATEWAY_COMMIT_TIMEOUT_SECONDS;
    if (commitTimeoutRaw !== undefined && commitTimeoutRaw.trim() !== '') {
      const commitTimeout = Number(commitTimeoutRaw);
      if (!Number.isInteger(commitTimeout) || commitTimeout <= 0) {
        errors.push(
          `[PROVIDER_MODE_FAIL_FAST] Invalid FABRIC_GATEWAY_COMMIT_TIMEOUT_SECONDS: "${commitTimeoutRaw}". Must be a positive integer number of seconds.`
        );
      }
    }

    // Localhost discovery behaviour is an explicit boolean flag.
    const discoveryRaw = process.env.FABRIC_GATEWAY_DISCOVERY_AS_LOCALHOST;
    if (discoveryRaw !== undefined && discoveryRaw.trim() !== '' && !['true', 'false'].includes(discoveryRaw.trim())) {
      errors.push(
        `[PROVIDER_MODE_FAIL_FAST] Invalid FABRIC_GATEWAY_DISCOVERY_AS_LOCALHOST: "${discoveryRaw}". Must be "true" or "false".`
      );
    }
  } else {
    // In Mock Mode, give an informational warning
    warnings.push('UBTL running in MOCK BLOCKCHAIN MODE. Ledger commits will be simulated locally.');
  }

  // Listening port. Previously hardcoded to 3000 at the config layer, which
  // silently ignored the documented PORT variable; an invalid value must fail
  // fast instead of coercing to NaN and producing a confusing `listen()` error.
  const portRaw = process.env.PORT;
  if (portRaw !== undefined && portRaw.trim() !== '') {
    const parsedPort = Number(portRaw);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      errors.push(`Invalid PORT: "${portRaw}". Must be an integer between 1 and 65535.`);
    }
  }

  if (!process.env.SWITCHING_BASE_URL) {
    warnings.push('SWITCHING_BASE_URL is not set. Defaulting to http://localhost:4000.');
  }

  // Outbox Configuration Validation (Fails fast on negative, non-finite, or unreasonable values)
  const pollInterval = parseInt(process.env.OUTBOX_POLL_INTERVAL_MS || '2000', 10);
  if (isNaN(pollInterval) || pollInterval <= 0) {
    errors.push(`Invalid OUTBOX_POLL_INTERVAL_MS: "${process.env.OUTBOX_POLL_INTERVAL_MS}". Must be a positive integer.`);
  }

  const batchSize = parseInt(process.env.OUTBOX_BATCH_SIZE || '25', 10);
  if (isNaN(batchSize) || batchSize <= 0 || batchSize > 1000) {
    errors.push(`Invalid OUTBOX_BATCH_SIZE: "${process.env.OUTBOX_BATCH_SIZE}". Must be an integer between 1 and 1000.`);
  }

  const maxRetries = parseInt(process.env.OUTBOX_MAX_RETRIES || '5', 10);
  if (isNaN(maxRetries) || maxRetries < 1) {
    errors.push(`Invalid OUTBOX_MAX_RETRIES: "${process.env.OUTBOX_MAX_RETRIES}". Must be an integer >= 1 (represents total attempts).`);
  }

  const backoffBase = parseInt(process.env.OUTBOX_BACKOFF_BASE_MS || '1000', 10);
  if (isNaN(backoffBase) || backoffBase <= 0) {
    errors.push(`Invalid OUTBOX_BACKOFF_BASE_MS: "${process.env.OUTBOX_BACKOFF_BASE_MS}". Must be a positive integer.`);
  }

  const stuckTimeout = parseInt(process.env.OUTBOX_STUCK_TIMEOUT_MS || '60000', 10);
  if (isNaN(stuckTimeout) || stuckTimeout <= 0) {
    errors.push(`Invalid OUTBOX_STUCK_TIMEOUT_MS: "${process.env.OUTBOX_STUCK_TIMEOUT_MS}". Must be a positive integer.`);
  }

  // Webhook Delivery Configuration Validation (fail fast on unusable values)
  const webhookTimeout = parseInt(process.env.SWITCHING_WEBHOOK_TIMEOUT_MS || '5000', 10);
  if (isNaN(webhookTimeout) || webhookTimeout <= 0) {
    errors.push(`Invalid SWITCHING_WEBHOOK_TIMEOUT_MS: "${process.env.SWITCHING_WEBHOOK_TIMEOUT_MS}". Must be a positive integer.`);
  }

  const webhookMaxRetries = parseInt(process.env.SWITCHING_WEBHOOK_MAX_RETRIES || '5', 10);
  if (isNaN(webhookMaxRetries) || webhookMaxRetries < 1) {
    errors.push(`Invalid SWITCHING_WEBHOOK_MAX_RETRIES: "${process.env.SWITCHING_WEBHOOK_MAX_RETRIES}". Must be an integer >= 1.`);
  }

  // Signature configuration (fail fast on an unusable tolerance window).
  const signatureTolerance = parseInt(process.env.SIGNATURE_TOLERANCE_MS || '300000', 10);
  if (isNaN(signatureTolerance) || signatureTolerance <= 0) {
    errors.push(`Invalid SIGNATURE_TOLERANCE_MS: "${process.env.SIGNATURE_TOLERANCE_MS}". Must be a positive integer.`);
  }

  const outboundSignatureRequired = process.env.SWITCHING_OUTBOUND_SIGNATURE_REQUIRED;
  if (
    outboundSignatureRequired !== undefined &&
    outboundSignatureRequired.trim() !== '' &&
    !['true', 'false'].includes(outboundSignatureRequired.trim())
  ) {
    errors.push(
      `Invalid SWITCHING_OUTBOUND_SIGNATURE_REQUIRED: "${outboundSignatureRequired}". Must be "true" or "false".`
    );
  }

  // Fail closed: requiring signature verification without a configured secret
  // would reject every legitimate call with no way to authenticate — that is a
  // misconfiguration, not a secure default.
  if (
    outboundSignatureRequired?.trim() === 'true' &&
    (!process.env.SWITCHING_OUTBOUND_SIGNING_SECRET || process.env.SWITCHING_OUTBOUND_SIGNING_SECRET.trim() === '')
  ) {
    errors.push(
      '[SIGNATURE_FAIL_FAST] SWITCHING_OUTBOUND_SIGNATURE_REQUIRED=true but SWITCHING_OUTBOUND_SIGNING_SECRET is empty. Set the shared secret or disable enforcement.'
    );
  }

  // Reconciliation Engine Configuration Validation (fail fast on unusable values)
  const reconciliationInterval = parseInt(process.env.RECONCILIATION_INTERVAL_MINUTES || '60', 10);
  if (isNaN(reconciliationInterval) || reconciliationInterval <= 0) {
    errors.push(`Invalid RECONCILIATION_INTERVAL_MINUTES: "${process.env.RECONCILIATION_INTERVAL_MINUTES}". Must be a positive integer.`);
  }

  const reconciliationLookback = parseInt(process.env.RECONCILIATION_LOOKBACK_HOURS || '24', 10);
  if (isNaN(reconciliationLookback) || reconciliationLookback <= 0) {
    errors.push(`Invalid RECONCILIATION_LOOKBACK_HOURS: "${process.env.RECONCILIATION_LOOKBACK_HOURS}". Must be a positive integer.`);
  }

  const reconciliationBatchSize = parseInt(process.env.RECONCILIATION_BATCH_SIZE || '50', 10);
  if (isNaN(reconciliationBatchSize) || reconciliationBatchSize <= 0 || reconciliationBatchSize > 1000) {
    errors.push(`Invalid RECONCILIATION_BATCH_SIZE: "${process.env.RECONCILIATION_BATCH_SIZE}". Must be an integer between 1 and 1000.`);
  }

  const reconciliationMaxAttempts = parseInt(process.env.RECONCILIATION_MAX_ATTEMPTS || '5', 10);
  if (isNaN(reconciliationMaxAttempts) || reconciliationMaxAttempts < 1) {
    errors.push(`Invalid RECONCILIATION_MAX_ATTEMPTS: "${process.env.RECONCILIATION_MAX_ATTEMPTS}". Must be an integer >= 1.`);
  }

  // Durable reconciliation lock lease TTL. Must be a positive integer: a value
  // <= 0 would produce an already-expired lease and break mutual exclusion.
  const reconciliationLockTtl = parseInt(process.env.RECONCILIATION_LOCK_TTL_SECONDS || '120', 10);
  if (isNaN(reconciliationLockTtl) || reconciliationLockTtl <= 0) {
    errors.push(`Invalid RECONCILIATION_LOCK_TTL_SECONDS: "${process.env.RECONCILIATION_LOCK_TTL_SECONDS}". Must be a positive integer.`);
  }

  // Persistence backend selection. An unknown value must be rejected rather
  // than silently treated as 'auto' (which could hide a typo that quietly
  // downgrades the runtime to a non-durable store).
  const persistenceBackend = process.env.UBTL_PERSISTENCE_BACKEND || 'auto';
  if (!['auto', 'postgres', 'in-memory'].includes(persistenceBackend)) {
    errors.push(
      `Invalid UBTL_PERSISTENCE_BACKEND: "${persistenceBackend}". Must be one of "auto", "postgres", "in-memory".`
    );
  }

  // Fail closed: explicitly requiring the durable backend without a database
  // URL is a misconfiguration and must abort startup, never run non-durably.
  if (
    persistenceBackend === 'postgres' &&
    (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim() === '')
  ) {
    errors.push(
      '[PERSISTENCE_FAIL_FAST] UBTL_PERSISTENCE_BACKEND=postgres but DATABASE_URL is empty. Configure a reachable PostgreSQL database or use "in-memory" for development.'
    );
  }

  // Fail closed: an explicit durable backend is meaningless in production if the
  // runtime would be forced onto the in-memory store.
  if (persistenceBackend === 'in-memory' && (process.env.NODE_ENV || '').trim() === 'production') {
    errors.push(
      '[PERSISTENCE_FAIL_FAST] UBTL_PERSISTENCE_BACKEND=in-memory is not permitted with NODE_ENV=production. Acceptance (HTTP 202) would not survive a restart.'
    );
  }

  // Fail closed: production must never authenticate with a missing or
  // publicly-known development credential. `loadConfig()` has hardcoded
  // development fallbacks (published in .env.example), so without this check an
  // unconfigured production deployment would silently accept a known key —
  // including full admin access via UBTL_ADMIN_API_KEY.
  if ((process.env.NODE_ENV || '').trim() === 'production') {
    const apiKey = (process.env.UBTL_API_KEY || '').trim();
    if (apiKey === '') {
      errors.push(
        '[AUTH_FAIL_FAST] UBTL_API_KEY is not set. Production must configure a strong, unique Switching ingestion API key.'
      );
    } else if (apiKey === DEV_FALLBACK_API_KEY) {
      errors.push(
        '[AUTH_FAIL_FAST] UBTL_API_KEY is the published development default. Production must use a strong, unique key.'
      );
    }

    const adminKey = (process.env.UBTL_ADMIN_API_KEY || '').trim();
    if (adminKey === '') {
      errors.push(
        '[AUTH_FAIL_FAST] UBTL_ADMIN_API_KEY is not set. Production must configure a strong, unique administrative API key.'
      );
    } else if (adminKey === DEV_FALLBACK_ADMIN_API_KEY) {
      errors.push(
        '[AUTH_FAIL_FAST] UBTL_ADMIN_API_KEY is the published development default. Production must use a strong, unique key.'
      );
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    mode,
  };
}

export function loadConfig(): UbtlConfig {
  const validation = validateEnvironment();
  if (!validation.isValid) {
    throw new Error(`Environment validation failed:\n${validation.errors.map((e) => `  - ${e}`).join('\n')}`);
  }

  return {
    nodeEnv: process.env.NODE_ENV || 'development',
    port: process.env.PORT && process.env.PORT.trim() !== '' ? Number(process.env.PORT) : 3000,
    host: process.env.HOST || '0.0.0.0',
    appUrl: process.env.APP_URL || 'http://localhost:3000',
    logLevel: process.env.LOG_LEVEL || 'info',

    ubtlApiKey: process.env.UBTL_API_KEY || DEV_FALLBACK_API_KEY,
    ubtlAdminApiKey: process.env.UBTL_ADMIN_API_KEY || DEV_FALLBACK_ADMIN_API_KEY,

    switchingBaseUrl: process.env.SWITCHING_BASE_URL || 'http://localhost:4000',
    switchingWebhookEndpoint: process.env.SWITCHING_WEBHOOK_ENDPOINT || '/api/v1/webhooks/gateway',
    switchingWebhookApiKey: process.env.SWITCHING_WEBHOOK_API_KEY || 'switching_webhook_gateway_key_2026',
    switchingWebhookTimeoutMs: parseInt(process.env.SWITCHING_WEBHOOK_TIMEOUT_MS || '5000', 10),
    switchingWebhookMaxRetries: parseInt(process.env.SWITCHING_WEBHOOK_MAX_RETRIES || '5', 10),

    switchingOutboundSigningSecret: process.env.SWITCHING_OUTBOUND_SIGNING_SECRET || '',
    switchingOutboundSignatureRequired: process.env.SWITCHING_OUTBOUND_SIGNATURE_REQUIRED === 'true',
    switchingWebhookSigningSecret: process.env.SWITCHING_WEBHOOK_SIGNING_SECRET || '',
    signatureToleranceMs: parseInt(process.env.SIGNATURE_TOLERANCE_MS || '300000', 10),

    // Empty when DATABASE_URL is not configured. This is intentional: the
    // persistence decision must distinguish "no database configured" from a
    // real connection string, and must never silently reuse a placeholder URL.
    databaseUrl: process.env.DATABASE_URL || '',
    persistenceBackend: (process.env.UBTL_PERSISTENCE_BACKEND || 'auto') as
      | 'auto'
      | 'postgres'
      | 'in-memory',

    blockchainAdapterMode: validation.mode,
    mockFabricCommitDelayMs: parseInt(process.env.MOCK_FABRIC_COMMIT_DELAY_MS || '1500', 10),
    mockFabricFailureRate: parseFloat(process.env.MOCK_FABRIC_FAILURE_RATE || '0.0'),
    mockFabricTimeoutRate: parseFloat(process.env.MOCK_FABRIC_TIMEOUT_RATE || '0.0'),

    fabricGatewayPeerEndpoint: process.env.FABRIC_GATEWAY_PEER_ENDPOINT,
    fabricGatewayTlsCertPath: process.env.FABRIC_GATEWAY_TLS_CERT_PATH,
    fabricGatewayClientCertPath: process.env.FABRIC_GATEWAY_CLIENT_CERT_PATH,
    fabricGatewayClientKeyPath: process.env.FABRIC_GATEWAY_CLIENT_KEY_PATH,
    fabricGatewayMspId: process.env.FABRIC_GATEWAY_MSP_ID,
    fabricGatewayChannelName: process.env.FABRIC_GATEWAY_CHANNEL_NAME,
    fabricGatewayChaincodeName: process.env.FABRIC_GATEWAY_CHAINCODE_NAME,
    fabricGatewayCommitTimeoutSeconds: parseInt(process.env.FABRIC_GATEWAY_COMMIT_TIMEOUT_SECONDS || '60', 10),
    fabricGatewayDiscoveryAsLocalhost: process.env.FABRIC_GATEWAY_DISCOVERY_AS_LOCALHOST === 'true',

    outboxPollIntervalMs: parseInt(process.env.OUTBOX_POLL_INTERVAL_MS || '2000', 10),
    outboxBatchSize: parseInt(process.env.OUTBOX_BATCH_SIZE || '25', 10),
    outboxMaxRetries: parseInt(process.env.OUTBOX_MAX_RETRIES || '5', 10),
    outboxBackoffBaseMs: parseInt(process.env.OUTBOX_BACKOFF_BASE_MS || '1000', 10),
    outboxStuckTimeoutMs: parseInt(process.env.OUTBOX_STUCK_TIMEOUT_MS || '60000', 10),

    // Canonical hashing identity MUST match the constants enforced by the
    // canonicalizer. Advertising RFC-8785-JCS / SHA-256 / 1 here would be an
    // over-claim: UBTL applies application-specific Unicode NFC normalization.
    hashAlgorithm: process.env.HASH_ALGORITHM || HASH_ALGORITHM,
    canonicalizationSpec: process.env.CANONICALIZATION_SPEC || CANONICALIZATION_SPEC,
    hashVersion: process.env.HASH_VERSION || HASH_VERSION,

    reconciliationIntervalMinutes: parseInt(process.env.RECONCILIATION_INTERVAL_MINUTES || '60', 10),
    reconciliationLookbackHours: parseInt(process.env.RECONCILIATION_LOOKBACK_HOURS || '24', 10),
    reconciliationBatchSize: parseInt(process.env.RECONCILIATION_BATCH_SIZE || '50', 10),
    reconciliationMaxAttempts: parseInt(process.env.RECONCILIATION_MAX_ATTEMPTS || '5', 10),
    reconciliationLockTtlSeconds: parseInt(process.env.RECONCILIATION_LOCK_TTL_SECONDS || '120', 10),
  };
}
