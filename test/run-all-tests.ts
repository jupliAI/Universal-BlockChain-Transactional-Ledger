/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'crypto';
import { readFileSync } from 'node:fs';
import {
  DEV_FALLBACK_ADMIN_API_KEY,
  DEV_FALLBACK_API_KEY,
  loadConfig,
  validateEnvironment,
} from '../src/config/environment.ts';
import { resolvePersistenceDecision } from '../src/config/persistence.ts';
import { AuthService } from '../src/modules/auth/auth.service.ts';
import { AuditService } from '../src/modules/audit/audit.service.ts';
import { MockBlockchainAdapter } from '../src/modules/blockchain-adapter/mock-adapter.ts';
import {
  CANONICALIZATION_SPEC,
  canonicalize,
  computeCanonicalHash,
  HASH_ALGORITHM,
  HASH_VERSION,
} from '../src/modules/canonicalization/canonicalizer.ts';
import { HashingService } from '../src/modules/canonicalization/hashing.service.ts';
import { GatewayCompatController } from '../src/modules/gateway-compat/gateway-compat.controller.ts';
import { OutboxService } from '../src/modules/outbox/outbox.service.ts';
import { TransactionTypeRegistry } from '../src/modules/transactions/registry/transaction-type-registry.ts';
import { InMemoryTransactionRepository } from '../src/modules/transactions/repository/in-memory-transaction.repository.ts';
import {
  IdempotencyConflictError,
  TransactionsService,
  ValidationError,
} from '../src/modules/transactions/transactions.service.ts';
import { InMemoryOutboxRepository } from '../src/modules/outbox/in-memory-outbox.repository.ts';
import { OutboxWorker } from '../src/modules/outbox/outbox-worker.ts';
import { calculateBackoffDelay, classifyError } from '../src/modules/outbox/backoff.ts';
import { redactSecrets, sanitizeForLog, WebhookService } from '../src/modules/webhooks/webhook.service.ts';
import {
  BlockchainAdapter,
  BlockchainSubmissionInput,
} from '../src/modules/blockchain-adapter/adapter.interface.ts';
import {
  ReconciliationService,
  SingleProcessReconciliationLock,
} from '../src/modules/reconciliation/reconciliation.service.ts';
import {
  DEFAULT_FABRIC_CHAINCODE_FUNCTIONS,
  FabricGatewayAdapter,
  FabricGatewayOptions,
} from '../src/modules/blockchain-adapter/fabric-adapter.ts';
import {
  FabricCredentialError,
  FabricCredentialMaterial,
  FabricCredentialSource,
} from '../src/modules/blockchain-adapter/fabric-credentials.ts';
import {
  FabricCommitStatus,
  FabricConnectOptions,
  FabricContractHandle,
  FabricGatewayConnector,
  FabricGatewayHandle,
  FabricGrpcClientOptions,
  FabricNetworkHandle,
  FabricProposalHandle,
  FabricSubmittedTransaction,
  FabricTransactionHandle,
} from '../src/modules/blockchain-adapter/fabric-sdk.port.ts';
import {
  BlockEvidenceLookup,
  BlockEvidenceSource,
  DecodedBlockTransaction,
  createChaincodeStateEvidenceSource,
} from '../src/modules/blockchain-adapter/block-evidence.source.ts';
import {
  CommitVerificationDecision,
  CommitVerifier,
} from '../src/modules/blockchain-adapter/commit-verification.types.ts';
import { IndependentCommitVerifier } from '../src/modules/blockchain-adapter/independent-commit-verifier.ts';
import {
  isSensitiveKeyName,
  normalizeKeyForComparison,
} from '../src/modules/security/redaction.ts';
import {
  DEFAULT_SUBMIT_FUNCTION_NAME,
  createFabricProtobufBlockDecoder,
} from '../src/modules/blockchain-adapter/fabric-block-decoder.ts';
import { createQsccBlockEvidenceSource } from '../src/modules/blockchain-adapter/qscc-block-evidence.source.ts';
import { canTransition } from '../src/modules/transactions/state-machine/lifecycle-state.ts';

/**
 * A test case may return the sentinel 'SKIP' to be reported as skipped instead
 * of passed. This exists so that opt-in live-infrastructure tests can be
 * represented honestly (never as a pass they did not earn).
 */
type TestOutcome = void | 'SKIP';

interface TestCase {
  id: string;
  suite: string;
  name: string;
  run: () => Promise<TestOutcome> | TestOutcome;
}

const testInventory: TestCase[] = [];

function registerTest(
  id: string,
  suite: string,
  name: string,
  run: () => Promise<TestOutcome> | TestOutcome
) {
  testInventory.push({ id, suite, name, run });
}

// =========================================================================
// SUITE 1: CANONICALIZATION (ubtl-canonical-json-v1 & Approach B)
// =========================================================================

registerTest('TC-CANON-01', 'Canonicalization', 'Property order permutation produces identical canonical output', async () => {
  const a = { z: 1, a: 'test', m: true };
  const b = { a: 'test', m: true, z: 1 };
  if (canonicalize(a) !== canonicalize(b)) {
    throw new Error('Key sorting produced different results for equivalent objects');
  }
});

registerTest('TC-CANON-02', 'Canonicalization', 'Nested objects are sorted recursively by UTF-16 code units', async () => {
  const nested = { outer: { z: 2, a: 1 }, meta: { id: 'x' } };
  const expected = '{"meta":{"id":"x"},"outer":{"a":1,"z":2}}';
  if (canonicalize(nested) !== expected) {
    throw new Error(`Expected ${expected}, got ${canonicalize(nested)}`);
  }
});

registerTest('TC-CANON-03', 'Canonicalization', 'Array element order is strictly preserved and not sorted', async () => {
  const arr = { list: [3, 1, 2] };
  const expected = '{"list":[3,1,2]}';
  if (canonicalize(arr) !== expected) {
    throw new Error(`Expected array to retain sequence, got ${canonicalize(arr)}`);
  }
});

registerTest('TC-CANON-04', 'Canonicalization', 'Unicode strings are normalized to NFC', async () => {
  const decomposed = 'e\u0301'; // 'e' + acute accent
  const composed = '\u00e9'; // NFC canonical
  if (canonicalize({ text: decomposed }) !== canonicalize({ text: composed })) {
    throw new Error('Unicode strings failed to normalize to identical NFC form');
  }
});

registerTest('TC-CANON-05', 'Canonicalization', 'Booleans and explicit null values are preserved as literals', async () => {
  const data = { active: true, archived: false, deletedAt: null };
  const expected = '{"active":true,"archived":false,"deletedAt":null}';
  if (canonicalize(data) !== expected) {
    throw new Error(`Expected ${expected}, got ${canonicalize(data)}`);
  }
});

registerTest('TC-CANON-06', 'Canonicalization', 'Negative zero (-0) is normalized to 0', async () => {
  const data = { val: -0 };
  const expected = '{"val":0}';
  if (canonicalize(data) !== expected) {
    throw new Error(`Negative zero was not normalized to 0: ${canonicalize(data)}`);
  }
});

registerTest('TC-CANON-07', 'Canonicalization', 'Unsupported values (BigInt, Symbol, Function) throw TypeError', async () => {
  let bigIntError = false;
  try {
    canonicalize({ count: 100n });
  } catch (e) {
    bigIntError = e instanceof TypeError;
  }

  let symbolError = false;
  try {
    canonicalize({ sym: Symbol('x') });
  } catch (e) {
    symbolError = e instanceof TypeError;
  }

  let funcError = false;
  try {
    canonicalize({ fn: () => {} });
  } catch (e) {
    funcError = e instanceof TypeError;
  }

  if (!bigIntError || !symbolError || !funcError) {
    throw new Error('Unsupported values must throw TypeError rather than being silently dropped');
  }
});

registerTest('TC-CANON-08', 'Canonicalization', 'Undefined values throw TypeError rather than being silently omitted', async () => {
  let undefinedError = false;
  try {
    canonicalize({ missingField: undefined });
  } catch (e) {
    undefinedError = e instanceof TypeError;
  }

  let arrayUndefinedError = false;
  try {
    canonicalize([1, undefined, 3]);
  } catch (e) {
    arrayUndefinedError = e instanceof TypeError;
  }

  if (!undefinedError || !arrayUndefinedError) {
    throw new Error('Undefined values must throw TypeError per non-dropping policy');
  }
});

registerTest('TC-CANON-09', 'Canonicalization', 'Non-finite numbers (NaN, Infinity) throw TypeError', async () => {
  let nanError = false;
  try {
    canonicalize({ badNum: NaN });
  } catch (e) {
    nanError = e instanceof TypeError;
  }

  let infError = false;
  try {
    canonicalize({ badNum: Infinity });
  } catch (e) {
    infError = e instanceof TypeError;
  }

  if (!nanError || !infError) {
    throw new Error('Non-finite numbers must be rejected');
  }
});

registerTest('TC-CANON-10', 'Canonicalization', 'Specification is explicitly versioned as ubtl-canonical-json-v1', async () => {
  const res = computeCanonicalHash('SALE', { invoiceNumber: 'INV-1', amount: '100.00', currency: 'IDR' });
  if (res.canonicalizationSpec !== 'ubtl-canonical-json-v1') {
    throw new Error(`Expected spec 'ubtl-canonical-json-v1', got '${res.canonicalizationSpec}'`);
  }
});

registerTest('TC-CANON-11', 'Canonicalization', 'Published hash-specification example reproduces its documented canonical form and digest', async () => {
  // Pins the reproducible vector published in docs/hash-specification.md §3.
  const res = computeCanonicalHash('SALE', {
    currency: 'IDR',
    amount: '1500000.00',
    invoiceNumber: 'INV-2026-001',
  });

  const expectedCanonical = '{"amount":"1500000.00","currency":"IDR","invoiceNumber":"INV-2026-001"}';
  const expectedDigest = '756deccd4b37942bc3f88c870b43475ee29210017663feb4549805097751ef49';

  if (res.canonicalString !== expectedCanonical) {
    throw new Error(`Documented canonical form mismatch: ${res.canonicalString}`);
  }
  if (res.payloadHash !== expectedDigest) {
    throw new Error(`Documented digest mismatch: got ${res.payloadHash}, expected ${expectedDigest}`);
  }

  // Independent recomputation must agree (guards against a coincidental doc/code sync).
  const independent = createHash('sha256').update(expectedCanonical, 'utf8').digest('hex');
  if (independent !== expectedDigest) {
    throw new Error(`Documented digest does not match independently computed SHA-256: ${independent}`);
  }
});

// =========================================================================
// SUITE 2: HASHING & INTEGRITY (sha256 & constant-time verification)
// =========================================================================

registerTest('TC-HASH-01', 'Hashing', 'Identical canonical payload always produces identical SHA-256 digest', async () => {
  const audit = new AuditService();
  const hashing = new HashingService(audit);
  const p1 = { invoiceNumber: 'INV-1', amount: '150000.00', currency: 'IDR' };
  const p2 = { currency: 'IDR', amount: '150000.00', invoiceNumber: 'INV-1' };
  const h1 = hashing.hashPayload('SALE', p1);
  const h2 = hashing.hashPayload('SALE', p2);
  if (h1.payloadHash !== h2.payloadHash) {
    throw new Error('Permuted payload keys produced different SHA-256 digests');
  }
});

registerTest('TC-HASH-02', 'Hashing', 'Changed payload produces completely different SHA-256 digest', async () => {
  const audit = new AuditService();
  const hashing = new HashingService(audit);
  const p1 = { invoiceNumber: 'INV-1', amount: '150000.00', currency: 'IDR' };
  const p2 = { invoiceNumber: 'INV-1', amount: '150000.01', currency: 'IDR' };
  const h1 = hashing.hashPayload('SALE', p1);
  const h2 = hashing.hashPayload('SALE', p2);
  if (h1.payloadHash === h2.payloadHash) {
    throw new Error('Altered amount did not produce different hash');
  }
});

registerTest('TC-HASH-03', 'Hashing', 'Digest matches independently computed SHA-256 test vector', async () => {
  const audit = new AuditService();
  const hashing = new HashingService(audit);
  const p = { invoiceNumber: 'INV-001', amount: '150000.00', currency: 'IDR' };
  const res = hashing.hashPayload('SALE', p);

  // Independent canonical string: {"amount":"150000.00","currency":"IDR","invoiceNumber":"INV-001"}
  const canonicalExpected = '{"amount":"150000.00","currency":"IDR","invoiceNumber":"INV-001"}';
  const independentHash = createHash('sha256').update(canonicalExpected, 'utf8').digest('hex');

  if (res.payloadHash !== independentHash) {
    throw new Error(`Digest mismatch: ${res.payloadHash} !== ${independentHash}`);
  }
});

registerTest('TC-HASH-04', 'Hashing', 'Server computes authoritative hash; client cannot override it', async () => {
  const audit = new AuditService();
  const txService = new TransactionsService(audit);
  const fakeClientHash = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
  const res = await txService.ingest({
    correlationId: 'corr-h4',
    idempotencyKey: 'idemp-h4',
    transactionType: 'SALE',
    payload: { invoiceNumber: 'INV-001', amount: '150000.00', currency: 'IDR' },
    organizationId: 'org-test',
  });

  if (res.transaction.payloadHash === fakeClientHash) {
    throw new Error('Client-supplied fake hash was accepted as authoritative');
  }
  if (!/^[0-9a-f]{64}$/.test(res.transaction.payloadHash)) {
    throw new Error('Server payloadHash is not a valid 64-character lowercase hex digest');
  }
});

registerTest('TC-HASH-05', 'Hashing', 'Tampering with stored payload causes verification failure', async () => {
  const audit = new AuditService();
  const txService = new TransactionsService(audit);
  const res = await txService.ingest({
    correlationId: 'corr-h5',
    idempotencyKey: 'idemp-h5',
    transactionType: 'SALE',
    payload: { invoiceNumber: 'INV-ORIG', amount: '500.00', currency: 'IDR' },
    organizationId: 'org-test',
  });

  // Tamper with off-chain payload directly in storage
  res.transaction.rawPayload.amount = '999999.00';

  const verification = await txService.verifyStoredTransaction(res.gatewayRequestId);
  if (verification.verified) {
    throw new Error('Verification passed despite tampered stored payload');
  }
});

registerTest('TC-HASH-06', 'Hashing', 'Tamper attempt creates auditable INTEGRITY_VIOLATION event', async () => {
  const audit = new AuditService();
  const txService = new TransactionsService(audit);
  const res = await txService.ingest({
    correlationId: 'corr-h6',
    idempotencyKey: 'idemp-h6',
    transactionType: 'SALE',
    payload: { invoiceNumber: 'INV-ORIG', amount: '500.00', currency: 'IDR' },
    organizationId: 'org-test',
  });

  res.transaction.rawPayload.amount = '999999.00';
  await txService.verifyStoredTransaction(res.gatewayRequestId);

  const logs = audit.getLogsByCorrelationId('corr-h6');
  const violation = logs.find((l) => l.action === 'INTEGRITY_VIOLATION_TAMPER_DETECTED');
  if (!violation) {
    throw new Error('INTEGRITY_VIOLATION_TAMPER_DETECTED was not recorded in audit log');
  }
});

registerTest('TC-HASH-07', 'Hashing', 'Malformed expected hashes are rejected before comparison', async () => {
  const audit = new AuditService();
  const hashing = new HashingService(audit);
  const result = hashing.verifyPayload('SALE', { invoiceNumber: '1', amount: '1.00', currency: 'IDR' }, 'not-a-hash');
  if (result.verified || !result.error?.includes('Malformed expected hash')) {
    throw new Error('Malformed hash was not rejected');
  }
});

// =========================================================================
// SUITE 3: INGESTION & DURABLE IDEMPOTENCY
// =========================================================================

registerTest('TC-INGEST-01', 'Ingestion', 'Valid request is accepted, persisted, and marked OUTBOX_PENDING', async () => {
  const audit = new AuditService();
  const txService = new TransactionsService(audit);
  const res = await txService.ingest({
    correlationId: 'corr-i1',
    idempotencyKey: 'idemp-i1',
    transactionType: 'PURCHASE',
    payload: {
      purchaseOrderNumber: 'PO-001',
      supplierId: 'SUPP-1',
      totalAmount: '2500000.00',
      currency: 'IDR',
    },
    organizationId: 'org-test',
  });

  if (res.isDuplicate) throw new Error('Initial submission marked as duplicate');
  if (res.transaction.lifecycleState !== 'OUTBOX_PENDING') {
    throw new Error(`Expected OUTBOX_PENDING, got ${res.transaction.lifecycleState}`);
  }
  // Status consistency: newly accepted transaction is pending submission, NOT submitted
  if (res.status !== 'pending') {
    throw new Error(`Expected external status 'pending' upon durable acceptance, got '${res.status}'`);
  }
});

registerTest('TC-INGEST-02', 'Ingestion', 'Invalid payloads are rejected without creating outbox or DB entries', async () => {
  const audit = new AuditService();
  const txService = new TransactionsService(audit);
  let caught = false;
  try {
    await txService.ingest({
      correlationId: 'corr-i2',
      idempotencyKey: 'idemp-i2',
      transactionType: 'PURCHASE',
      payload: {
        purchaseOrderNumber: 'PO-001',
        totalAmount: 'not-valid-decimal',
        currency: 'IDR',
      },
      organizationId: 'org-test',
    });
  } catch (e) {
    if (e instanceof ValidationError) caught = true;
  }

  if (!caught) throw new Error('Invalid decimal failed to trigger ValidationError');
  if ((await txService.getAll()).length !== 0) throw new Error('Invalid request was persisted');
});

registerTest('TC-INGEST-03', 'Ingestion', 'Repeated identical requests return original transaction (Idempotent 202)', async () => {
  const audit = new AuditService();
  const txService = new TransactionsService(audit);
  const input = {
    correlationId: 'corr-i3',
    idempotencyKey: 'idemp-i3',
    transactionType: 'SAVINGS',
    payload: {
      accountNumber: 'ACC-1',
      accountHolderId: 'CUST-1',
      amount: '50000.00',
      currency: 'IDR',
      operationType: 'DEPOSIT',
    },
    organizationId: 'org-test',
  };

  const first = await txService.ingest(input);
  const second = await txService.ingest(input);

  if (!second.isDuplicate) throw new Error('Second identical request was not flagged as duplicate');
  if (second.gatewayRequestId !== first.gatewayRequestId) {
    throw new Error('Duplicate submission returned a different gatewayRequestId');
  }
});

registerTest('TC-INGEST-04', 'Ingestion', 'Reusing idempotency key with different payload throws IdempotencyConflictError (HTTP 409)', async () => {
  const audit = new AuditService();
  const txService = new TransactionsService(audit);
  await txService.ingest({
    correlationId: 'corr-i4',
    idempotencyKey: 'idemp-i4',
    transactionType: 'SALE',
    payload: { invoiceNumber: 'INV-1', amount: '1000.00', currency: 'IDR' },
    organizationId: 'org-test',
  });

  let conflictThrown = false;
  try {
    await txService.ingest({
      correlationId: 'corr-i4',
      idempotencyKey: 'idemp-i4',
      transactionType: 'SALE',
      payload: { invoiceNumber: 'INV-1', amount: '2000.00', currency: 'IDR' }, // Different amount!
      organizationId: 'org-test',
    });
  } catch (e) {
    if (e instanceof IdempotencyConflictError) conflictThrown = true;
  }

  if (!conflictThrown) {
    throw new Error('Reusing idempotency key with different payload did not throw IdempotencyConflictError');
  }
});

registerTest('TC-INGEST-05', 'Ingestion', 'Concurrent identical submissions resolve to exactly one transaction record', async () => {
  const audit = new AuditService();
  const txService = new TransactionsService(audit);
  const input = {
    correlationId: 'corr-i5',
    idempotencyKey: 'idemp-i5',
    transactionType: 'DONATION',
    payload: { campaignId: 'CMP-1', amount: '10000.00', currency: 'IDR' },
    organizationId: 'org-test',
  };

  const [r1, r2, r3] = await Promise.all([txService.ingest(input), txService.ingest(input), txService.ingest(input)]);
  const persisted = await txService.getAll();
  if (persisted.length !== 1) {
    throw new Error(`Expected exactly 1 persisted record, found ${persisted.length}`);
  }
  if (r1.gatewayRequestId !== r2.gatewayRequestId || r2.gatewayRequestId !== r3.gatewayRequestId) {
    throw new Error('Concurrent identical calls returned differing gatewayRequestIds');
  }
});

registerTest('TC-INGEST-06', 'Ingestion', 'Transaction record and outbox event are coordinated atomically', async () => {
  const config = loadConfig();
  const audit = new AuditService();
  const txService = new TransactionsService(audit);
  const mockAdapter = new MockBlockchainAdapter();
  const webhookService = new WebhookService(config, audit);
  const outboxService = new OutboxService(config, txService, mockAdapter, webhookService, audit);

  const res = await txService.ingest({
    correlationId: 'corr-i6',
    idempotencyKey: 'idemp-i6',
    transactionType: 'GOLD_PURCHASE',
    payload: {
      certificateNumber: 'GOLD-01',
      buyerId: 'B-1',
      weightGrams: '10.0000',
      totalPrice: '14500000.00',
      currency: 'IDR',
    },
    organizationId: 'org-test',
  });

  const outboxEvent = outboxService.enqueueEvent(
    res.transaction.id,
    res.gatewayRequestId,
    'DISPATCH_LEDGER',
    { correlationId: 'corr-i6' }
  );

  if (outboxEvent.transactionId !== res.transaction.id) {
    throw new Error('Outbox event transactionId does not match created transaction');
  }
});

registerTest('TC-INGEST-07', 'Ingestion', 'Validation failure aborts processing before returning HTTP 202', async () => {
  const audit = new AuditService();
  const txService = new TransactionsService(audit);
  let failed = false;
  try {
    await txService.ingest({
      correlationId: 'corr-i7',
      idempotencyKey: '', // Empty key
      transactionType: 'SALE',
      payload: { invoiceNumber: '1', amount: '1.00', currency: 'IDR' },
      organizationId: 'org-test',
    });
  } catch {
    failed = true;
  }

  if (!failed) throw new Error('Missing idempotency key did not abort ingestion');
});

registerTest('TC-INGEST-08', 'Ingestion', 'Protected ingestion endpoint enforces API key authentication', async () => {
  const config = loadConfig();
  const auth = new AuthService(config);
  const valid = auth.validateSwitchingApiKey('ubtl_dev_key_secret_switch_2026');
  const invalid = auth.validateSwitchingApiKey('wrong_key');
  const missing = auth.validateSwitchingApiKey(undefined);

  if (!valid || invalid !== null || missing !== null) {
    throw new Error('AuthService failed to properly validate switching API key');
  }
});

registerTest('TC-INGEST-09', 'Ingestion', 'Sensitive credentials and API keys are redacted from audit logs', async () => {
  const audit = new AuditService();
  audit.record({
    actorType: 'SWITCHING',
    action: 'TEST_ACTION',
    resourceType: 'TEST',
    metadata: { key: 'safe_key', note: 'no secret exposed' },
  });

  const logs = audit.getRecentLogs(10);
  const leaked = logs.some((l) => JSON.stringify(l).includes('ubtl_dev_key_secret'));
  if (leaked) {
    throw new Error('Audit logs contain leaked secret API keys');
  }
});

// =========================================================================
// SUITE 4: LIFECYCLE & STATUS CONSISTENCY
// =========================================================================

registerTest('TC-LIFE-01', 'Lifecycle', 'Newly accepted transaction is OUTBOX_PENDING/pending and distinct from submitted', async () => {
  const audit = new AuditService();
  const txService = new TransactionsService(audit);
  const res = await txService.ingest({
    correlationId: 'corr-l1',
    idempotencyKey: 'idemp-l1',
    transactionType: 'TAX_PAYMENT',
    payload: { billingCode: 'TAX-1', taxpayerId: 'NPWP-1', amount: '100000.00', currency: 'IDR' },
    organizationId: 'org-test',
  });

  // Verify honest status consistency:
  // It must NOT be marked submitted before submission to the blockchain has occurred!
  if (res.transaction.lifecycleState !== 'OUTBOX_PENDING') {
    throw new Error(`Expected lifecycleState OUTBOX_PENDING, got ${res.transaction.lifecycleState}`);
  }
  if (res.status === 'submitted') {
    throw new Error('Defect: Newly accepted transaction was represented as submitted before submission occurred');
  }
  if (res.status !== 'pending') {
    throw new Error(`Expected status 'pending', got '${res.status}'`);
  }
});

registerTest('TC-LIFE-02', 'Lifecycle', 'Outbox submission transitions state to SUBMITTED/submitted', async () => {
  const audit = new AuditService();
  const txService = new TransactionsService(audit);
  const res = await txService.ingest({
    correlationId: 'corr-l2',
    idempotencyKey: 'idemp-l2',
    transactionType: 'LOAN',
    payload: { loanId: 'LN-1', borrowerId: 'B-1', lenderId: 'L-1', principalAmount: '50000.00', currency: 'IDR' },
    organizationId: 'org-test',
  });

  await txService.markSubmitted(res.gatewayRequestId, 'simulated-fabric-tx-99');
  const tx = await txService.getById(res.gatewayRequestId);

  if (tx?.lifecycleState !== 'SUBMITTED' || tx?.status !== 'submitted') {
    throw new Error(`Expected SUBMITTED/submitted, got ${tx?.lifecycleState}/${tx?.status}`);
  }
});

registerTest('TC-LIFE-03', 'Lifecycle', 'Ledger block inclusion transitions state to COMMITTED/confirmed', async () => {
  const audit = new AuditService();
  const txService = new TransactionsService(audit);
  const res = await txService.ingest({
    correlationId: 'corr-l3',
    idempotencyKey: 'idemp-l3',
    transactionType: 'WAQF',
    payload: { waqfCertificateId: 'W-1', waqfType: 'CASH', assetValue: '10000.00', currency: 'IDR', allocationPurpose: 'Masjid' },
    organizationId: 'org-test',
  });

  await txService.markSubmitted(res.gatewayRequestId, 'simulated-fabric-tx-100');
  await txService.markCommitted(res.gatewayRequestId, 14205);
  const tx = await txService.getById(res.gatewayRequestId);

  if (tx?.lifecycleState !== 'COMMITTED' || tx?.status !== 'confirmed') {
    throw new Error(`Expected COMMITTED/confirmed, got ${tx?.lifecycleState}/${tx?.status}`);
  }
  if (tx?.blockNumber !== 14205) {
    throw new Error(`Expected blockNumber 14205, got ${tx?.blockNumber}`);
  }
});

registerTest('TC-LIFE-04', 'Lifecycle', 'Axiom 5 Guard rejects confirmation with non-positive blockNumber', async () => {
  const audit = new AuditService();
  const txService = new TransactionsService(audit);
  const res = await txService.ingest({
    correlationId: 'corr-l4',
    idempotencyKey: 'idemp-l4',
    transactionType: 'LAND_CERTIFICATE_EVENT',
    payload: { parcelId: 'P-1', certificateType: 'SHM', certificateNumber: 'SHM-1', landAreaSqm: '100.00' },
    organizationId: 'org-test',
  });

  let errorCaught = false;
  try {
    await txService.markCommitted(res.gatewayRequestId, 0);
  } catch (e) {
    errorCaught = true;
  }

  if (!errorCaught) {
    throw new Error('Axiom 5 guard failed to reject confirmation with blockNumber 0');
  }
});

registerTest('TC-LIFE-05', 'Lifecycle', 'Submission timeout moves to RECONCILIATION_REQUIRED, never false commit or permanent failure', async () => {
  const audit = new AuditService();
  const txService = new TransactionsService(audit);
  const res = await txService.ingest({
    correlationId: 'corr-l5',
    idempotencyKey: 'idemp-l5',
    transactionType: 'SALE',
    payload: { invoiceNumber: 'INV-T', amount: '100.00', currency: 'IDR' },
    organizationId: 'org-test',
  });

  await txService.markTimeout(res.gatewayRequestId, 'Consensus commit timeout');
  const tx = await txService.getById(res.gatewayRequestId);

  if (tx?.status !== 'timeout' || tx?.lifecycleState !== 'RECONCILIATION_REQUIRED') {
    throw new Error(`Expected timeout/RECONCILIATION_REQUIRED, got ${tx?.status}/${tx?.lifecycleState}`);
  }
  if (tx?.blockNumber !== null) {
    throw new Error('Timeout transaction erroneously has a block number');
  }
});

registerTest('TC-LIFE-06', 'Lifecycle', 'Payload hash (SHA-256) is strictly distinguished from Fabric transaction ID and block height', async () => {
  const audit = new AuditService();
  const txService = new TransactionsService(audit);
  const res = await txService.ingest({
    correlationId: 'corr-l6',
    idempotencyKey: 'idemp-l6',
    transactionType: 'SALE',
    payload: { invoiceNumber: 'INV-D', amount: '200.00', currency: 'IDR' },
    organizationId: 'org-test',
  });

  await txService.markSubmitted(res.gatewayRequestId, 'simulated-fabric-tx-distinct-999');
  await txService.markCommitted(res.gatewayRequestId, 14209);
  const tx = await txService.getById(res.gatewayRequestId);

  if (tx?.payloadHash === tx?.fabricTransactionId) {
    throw new Error('payloadHash and fabricTransactionId must be distinct');
  }
  if (typeof tx?.blockNumber !== 'number' || tx?.blockNumber !== 14209) {
    throw new Error('blockNumber must be a distinct numeric block height');
  }
});

// =========================================================================
// SUITE 5: HONEST MOCK-MODE SEMANTICS & SIMULATION GUARDS
// =========================================================================

registerTest('TC-MOCK-01', 'MockSemantics', 'Mock adapter proposal acceptance is deterministic with zero failure rate', async () => {
  const adapter = new MockBlockchainAdapter(10, 0.0, 0.0);
  await adapter.initialize();
  const sub = await adapter.submitProposal({
    gatewayRequestId: 'gw-m1',
    correlationId: 'corr-m1',
    transactionType: 'SALE',
    payloadHash: '80db2fa0cb3071de1f5998e060185cd39bcc4289e8d4fa0a89e1242075bb256e',
    timestamp: new Date().toISOString(),
  });

  if (!sub.accepted || sub.status !== 'PENDING') {
    throw new Error('Mock adapter failed deterministic proposal acceptance');
  }
});

registerTest('TC-MOCK-02', 'MockSemantics', 'Simulated transaction IDs and block hashes are explicitly prefixed as simulated', async () => {
  const adapter = new MockBlockchainAdapter(10, 0.0, 0.0);
  await adapter.initialize();
  const sub = await adapter.submitProposal({
    gatewayRequestId: 'gw-m2',
    correlationId: 'corr-m2',
    transactionType: 'SALE',
    payloadHash: '80db2fa0cb3071de1f5998e060185cd39bcc4289e8d4fa0a89e1242075bb256e',
    timestamp: new Date().toISOString(),
  });

  if (!sub.fabricTransactionId.startsWith('simulated-fabric-tx-')) {
    throw new Error(`Mock transaction ID '${sub.fabricTransactionId}' is not prefixed with simulated-fabric-tx-`);
  }
  if (!sub.isSimulated) {
    throw new Error('sub.isSimulated must be true in mock adapter mode');
  }
});

registerTest('TC-MOCK-03', 'MockSemantics', 'Verification endpoint returns ledgerCommitVerified=false in mock mode to prevent false claims', async () => {
  const config = loadConfig();
  const audit = new AuditService();
  const txService = new TransactionsService(audit);
  const mockAdapter = new MockBlockchainAdapter(0, 0.0, 0.0);
  await mockAdapter.initialize();
  const webhookService = new WebhookService(config, audit);
  const outboxService = new OutboxService(config, txService, mockAdapter, webhookService, audit);
  const auth = new AuthService(config);

  const controller = new GatewayCompatController(auth, txService, outboxService, mockAdapter);

  const ingest = await txService.ingest({
    correlationId: 'corr-m3',
    idempotencyKey: 'idemp-m3',
    transactionType: 'SALE',
    payload: { invoiceNumber: 'INV-M3', amount: '100.00', currency: 'IDR' },
    organizationId: 'org-test',
  });

  const sub = await mockAdapter.submitProposal({
    gatewayRequestId: ingest.gatewayRequestId,
    correlationId: ingest.transaction.correlationId,
    transactionType: 'SALE',
    payloadHash: ingest.transaction.payloadHash,
    timestamp: new Date().toISOString(),
  });

  await txService.markSubmitted(ingest.gatewayRequestId, sub.fabricTransactionId);
  await txService.markCommitted(ingest.gatewayRequestId, 14201);

  // Mock Request/Response for verifyTransaction
  let statusCode = 0;
  let responseBody: any = null;
  const mockReq: any = {
    headers: { 'x-api-key': 'ubtl_dev_key_secret_switch_2026' },
    body: { gatewayRequestId: ingest.gatewayRequestId },
  };
  const mockRes: any = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: any) {
      responseBody = body;
    },
  };

  await controller.verifyTransaction(mockReq, mockRes);

  if (statusCode !== 200) {
    throw new Error(`Expected HTTP 200, got ${statusCode}`);
  }
  if (responseBody.ledgerCommitVerified !== false) {
    throw new Error('Defect: ledgerCommitVerified must be false in mock mode to avoid false production claims');
  }
  if (!responseBody.isSimulated || responseBody.simulatedCommitObserved !== true) {
    throw new Error('Expected isSimulated: true and simulatedCommitObserved: true in mock mode');
  }
});

// =========================================================================
// SUITE 6: AUTHENTICATION AUDIT
// =========================================================================

registerTest('TC-AUTH-01', 'Authentication', 'POST /v1/transactions/verify requires valid authentication', async () => {
  const config = loadConfig();
  const audit = new AuditService();
  const txService = new TransactionsService(audit);
  const mockAdapter = new MockBlockchainAdapter();
  const webhookService = new WebhookService(config, audit);
  const outboxService = new OutboxService(config, txService, mockAdapter, webhookService, audit);
  const auth = new AuthService(config);

  const controller = new GatewayCompatController(auth, txService, outboxService, mockAdapter);

  let unauthCode = 0;
  const unauthReq: any = {
    headers: {}, // No API key!
    body: { gatewayRequestId: 'some-id' },
  };
  const mockRes: any = {
    status(code: number) {
      unauthCode = code;
      return this;
    },
    json() {},
  };

  await controller.verifyTransaction(unauthReq, mockRes);

  if (unauthCode !== 401) {
    throw new Error(`Expected HTTP 401 Unauthorized for unauthenticated verification, got ${unauthCode}`);
  }
});

registerTest('TC-AUTH-02', 'Authentication', 'GET /v1/transactions/:id rejects missing authentication', async () => {
  const config = loadConfig();
  const audit = new AuditService();
  const txService = new TransactionsService(audit);
  const mockAdapter = new MockBlockchainAdapter();
  const webhookService = new WebhookService(config, audit);
  const outboxService = new OutboxService(config, txService, mockAdapter, webhookService, audit);
  const auth = new AuthService(config);

  const controller = new GatewayCompatController(auth, txService, outboxService, mockAdapter);

  let unauthCode = 0;
  const unauthReq: any = {
    headers: {},
    params: { gatewayRequestId: 'some-id' },
  };
  const mockRes: any = {
    status(code: number) {
      unauthCode = code;
      return this;
    },
    json() {},
  };

  await controller.getTransactionStatus(unauthReq, mockRes);

  if (unauthCode !== 401) {
    throw new Error(`Expected HTTP 401 Unauthorized, got ${unauthCode}`);
  }
});

registerTest('TC-AUTH-03', 'Authentication', 'Production refuses to start on missing or published default API keys', async () => {
  const saved: Record<string, string | undefined> = {
    NODE_ENV: process.env.NODE_ENV,
    UBTL_API_KEY: process.env.UBTL_API_KEY,
    UBTL_ADMIN_API_KEY: process.env.UBTL_ADMIN_API_KEY,
  };
  try {
    // (a) Keys entirely absent: loadConfig() would otherwise fall back to the
    // published development credentials. That must be refused outright.
    process.env.NODE_ENV = 'production';
    delete process.env.UBTL_API_KEY;
    delete process.env.UBTL_ADMIN_API_KEY;
    const missing = validateEnvironment();
    if (missing.isValid || !missing.errors.some((e) => e.includes('[AUTH_FAIL_FAST]'))) {
      throw new Error('Production without API keys must fail fast with [AUTH_FAIL_FAST]');
    }

    // (b) Keys present but equal to the published development defaults: still a
    // publicly-known credential, so still refused.
    process.env.UBTL_API_KEY = DEV_FALLBACK_API_KEY;
    process.env.UBTL_ADMIN_API_KEY = DEV_FALLBACK_ADMIN_API_KEY;
    const defaults = validateEnvironment();
    if (defaults.isValid || !defaults.errors.some((e) => e.includes('[AUTH_FAIL_FAST]'))) {
      throw new Error('Production using the published development API keys must fail fast with [AUTH_FAIL_FAST]');
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

registerTest('TC-AUTH-04', 'Authentication', 'Production accepts strong, unique API keys (no AUTH_FAIL_FAST)', async () => {
  const saved: Record<string, string | undefined> = {
    NODE_ENV: process.env.NODE_ENV,
    UBTL_API_KEY: process.env.UBTL_API_KEY,
    UBTL_ADMIN_API_KEY: process.env.UBTL_ADMIN_API_KEY,
  };
  try {
    process.env.NODE_ENV = 'production';
    process.env.UBTL_API_KEY = 'prod-switching-key-8f2c1a94b7e3';
    process.env.UBTL_ADMIN_API_KEY = 'prod-admin-key-4d9b6e2f7a15';
    const validation = validateEnvironment();
    if (validation.errors.some((e) => e.includes('[AUTH_FAIL_FAST]'))) {
      throw new Error(`Strong unique keys must satisfy the auth requirement, got: ${validation.errors.join('; ')}`);
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// =========================================================================
// SUITE 7: PERSISTENCE HARDENING & STORAGE METADATA
// =========================================================================

registerTest('TC-PERSIST-01', 'Persistence', 'Repository explicitly declares in-memory non-durable storage metadata in mock mode', async () => {
  const repo = new InMemoryTransactionRepository();
  if (repo.storageMetadata.storageType !== 'in-memory') {
    throw new Error(`Expected storageType 'in-memory', got '${repo.storageMetadata.storageType}'`);
  }
  if (repo.storageMetadata.isDurable !== false) {
    throw new Error('In-memory repository must declare isDurable: false');
  }
  if (repo.storageMetadata.productionReady !== false) {
    throw new Error('In-memory repository must declare productionReady: false');
  }
});

registerTest('TC-PERSIST-02', 'Persistence', 'GET /v1/health honestly reports non-durable database simulation', async () => {
  const config = loadConfig();
  const audit = new AuditService();
  const txService = new TransactionsService(audit);
  const mockAdapter = new MockBlockchainAdapter();
  const webhookService = new WebhookService(config, audit);
  const outboxService = new OutboxService(config, txService, mockAdapter, webhookService, audit);
  const auth = new AuthService(config);

  const controller = new GatewayCompatController(auth, txService, outboxService, mockAdapter);

  let statusCode = 0;
  let healthBody: any = null;
  const mockReq: any = {};
  const mockRes: any = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: any) {
      healthBody = body;
    },
  };

  await controller.getHealth(mockReq, mockRes);

  if (statusCode !== 200) {
    throw new Error(`Expected HTTP 200, got ${statusCode}`);
  }
  if (healthBody.database.durable !== false) {
    throw new Error('Health check must honestly report database.durable: false when running in-memory');
  }
  if (healthBody.database.storageType !== 'in-memory') {
    throw new Error(`Expected database.storageType 'in-memory', got '${healthBody.database.storageType}'`);
  }
});

/**
 * Test double: a repository whose atomic creation always fails, simulating an
 * unreachable/unavailable durable database.
 */
class FailingCreateRepository extends InMemoryTransactionRepository {
  public createAtomicCalls = 0;
  async createAtomic(_transaction: any, _history?: any, _outboxEvent?: any): Promise<void> {
    this.createAtomicCalls++;
    throw new Error('connect ECONNREFUSED 127.0.0.1:5432 — durable database unavailable');
  }
}

/**
 * Test double: a repository whose first atomic creation fails (transient
 * database failure) and which succeeds on subsequent attempts.
 */
class FlakyCreateRepository extends InMemoryTransactionRepository {
  public attempts = 0;
  async createAtomic(transaction: any, history?: any, outboxEvent?: any): Promise<void> {
    this.attempts++;
    if (this.attempts === 1) {
      throw new Error('Simulated transient database failure during atomic commit');
    }
    return super.createAtomic(transaction, history, outboxEvent);
  }
}

registerTest('TC-PERSIST-03', 'Persistence', 'Persistence failure yields HTTP 500 and never a misleading HTTP 202 acceptance', async () => {
  // This test targets persistence-failure handling, not inbound signature
  // enforcement, so it pins the security posture explicitly instead of
  // inheriting the operator's live-integration `.env`.
  const config = {
    ...loadConfig(),
    switchingOutboundSigningSecret: '',
    switchingOutboundSignatureRequired: false,
  };
  const audit = new AuditService();
  const repo = new FailingCreateRepository();
  const txService = new TransactionsService(audit, undefined, undefined, repo);
  const mockAdapter = new MockBlockchainAdapter();
  const webhookService = new WebhookService(config, audit);
  const outboxService = new OutboxService(config, txService, mockAdapter, webhookService, audit);
  const auth = new AuthService(config);
  const controller = new GatewayCompatController(auth, txService, outboxService, mockAdapter);

  let statusCode = 0;
  let responseBody: any = null;
  const mockReq: any = {
    headers: { 'x-api-key': 'ubtl_dev_key_secret_switch_2026', 'idempotency-key': 'idemp-p3' },
    body: {
      correlationId: 'corr-p3',
      transactionType: 'SALE',
      payload: { invoiceNumber: 'INV-P3', amount: '100.00', currency: 'IDR' },
    },
  };
  const mockRes: any = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: any) {
      responseBody = body;
    },
  };

  await controller.submitTransaction(mockReq, mockRes);

  if (statusCode === 202) {
    throw new Error('Defect: persistence failure produced a misleading HTTP 202 acceptance');
  }
  if (statusCode !== 500) {
    throw new Error(`Expected HTTP 500 on persistence failure, got ${statusCode}`);
  }
  if (responseBody?.errorCode !== 'INGESTION_FAILED') {
    throw new Error(`Expected errorCode INGESTION_FAILED, got '${responseBody?.errorCode}'`);
  }
  if (repo.createAtomicCalls !== 1) {
    throw new Error(`Expected exactly one atomic creation attempt, got ${repo.createAtomicCalls}`);
  }

  // Information disclosure guard: raw internal/database details must not leak.
  const serialized = JSON.stringify(responseBody);
  if (serialized.includes('ECONNREFUSED') || serialized.includes('5432') || serialized.includes('127.0.0.1')) {
    throw new Error('Defect: error response leaked raw internal database connection details');
  }
});

registerTest('TC-PERSIST-04', 'Persistence', 'A failed atomic creation leaves no partial state and permits a safe retry', async () => {
  const audit = new AuditService();
  const repo = new FlakyCreateRepository();
  const txService = new TransactionsService(audit, undefined, undefined, repo);

  let firstFailed = false;
  try {
    await txService.ingest({
      correlationId: 'corr-p4',
      idempotencyKey: 'idemp-p4',
      transactionType: 'SALE',
      payload: { invoiceNumber: 'INV-P4', amount: '500.00', currency: 'IDR' },
      organizationId: 'org-p4',
    });
  } catch {
    firstFailed = true;
  }

  if (!firstFailed) {
    throw new Error('Expected the transient persistence failure to propagate to the caller');
  }
  if ((await repo.getAll()).length !== 0) {
    throw new Error('Defect: a partial transaction row survived a failed atomic creation');
  }
  if (await repo.findByIdempotencyKey('org-p4', 'idemp-p4')) {
    throw new Error('Defect: the idempotency index retained a stale entry after a failed atomic creation');
  }

  // Retry with the same key must succeed cleanly (no stale partial state blocking it).
  const retry = await txService.ingest({
    correlationId: 'corr-p4',
    idempotencyKey: 'idemp-p4',
    transactionType: 'SALE',
    payload: { invoiceNumber: 'INV-P4', amount: '500.00', currency: 'IDR' },
    organizationId: 'org-p4',
  });

  if (retry.isDuplicate) {
    throw new Error('Defect: retry after a failed creation was incorrectly treated as an idempotent replay');
  }
  if (retry.transaction.lifecycleState !== 'OUTBOX_PENDING') {
    throw new Error(`Expected OUTBOX_PENDING after retry, got ${retry.transaction.lifecycleState}`);
  }
});

registerTest('TC-PERSIST-05', 'Persistence', 'Ingestion writes its dispatch event into the same outbox store the worker polls', async () => {
  const audit = new AuditService();
  const outboxRepo = new InMemoryOutboxRepository();
  // Shared-repository wiring (mirrors server.ts): the ingestion store and the
  // worker queue MUST reference the same outbox repository, otherwise an
  // atomically-created dispatch event is never polled.
  const txRepo = new InMemoryTransactionRepository(outboxRepo);
  const txService = new TransactionsService(audit, undefined, undefined, txRepo);

  const res = await txService.ingest({
    correlationId: 'corr-p5',
    idempotencyKey: 'idemp-p5',
    transactionType: 'SALE',
    payload: { invoiceNumber: 'INV-P5', amount: '750.00', currency: 'IDR' },
    organizationId: 'org-p5',
  });

  const claimed = await outboxRepo.claimBatch('worker-coupling', 10, Date.now());
  if (claimed.length !== 1) {
    throw new Error(`Expected the shared outbox store to expose 1 dispatchable event, got ${claimed.length}`);
  }
  if (claimed[0].transactionId !== res.transaction.id) {
    throw new Error('Dispatch event transactionId does not match the ingested transaction');
  }
  if (claimed[0].eventType !== 'DISPATCH_LEDGER') {
    throw new Error(`Expected DISPATCH_LEDGER event, got ${claimed[0].eventType}`);
  }
});

registerTest('TC-PERSIST-06', 'Persistence', 'Every supported registry transaction type is representable in the Prisma TransactionType enum', async () => {
  const registry = new TransactionTypeRegistry();
  const supported = registry.getSupportedTypes();

  const schemaPath = new URL('../prisma/schema.prisma', import.meta.url);
  const schema = readFileSync(schemaPath, 'utf8');

  const enumMatch = schema.match(/enum\s+TransactionType\s*\{([^}]*)\}/);
  if (!enumMatch) {
    throw new Error('Could not locate the TransactionType enum in prisma/schema.prisma');
  }
  const enumValues = new Set(
    enumMatch[1]
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('//'))
  );

  const missing = supported.filter((type) => !enumValues.has(type));
  if (missing.length > 0) {
    throw new Error(
      `Defect: registry transaction types are absent from the Prisma TransactionType enum: ${missing.join(', ')}`
    );
  }
});

// --- Runtime durable-integration wiring (Prompt 08 §1) ---
//
// These assert the composition root's persistence DECISION, which is pure and
// therefore fully testable without a database. They pin the two properties the
// runtime depends on: (a) the backend choice is explicit and observable, never
// an implicit fallback, and (b) selecting PostgreSQL without a reachable
// configuration fails CLOSED rather than degrading silently to a store where an
// accepted (HTTP 202) transaction would not survive a restart.

registerTest('TC-PERSIST-07', 'Persistence', 'Explicit postgres backend is durable and fails closed', async () => {
  const decision = resolvePersistenceDecision({
    ...loadConfig(),
    persistenceBackend: 'postgres',
    databaseUrl: 'postgresql://user:pass@localhost:5432/ubtl',
    nodeEnv: 'development',
  });
  if (decision.backend !== 'postgres' || !decision.isDurable) {
    throw new Error(`Expected a durable postgres backend, got ${decision.backend} (durable=${decision.isDurable})`);
  }
  if (decision.explicit !== true) {
    throw new Error('An explicit UBTL_PERSISTENCE_BACKEND must be reported as explicit');
  }
  if (decision.failFastOnUnavailable !== true) {
    throw new Error('An explicit postgres backend must fail closed when the database is unreachable');
  }
});

registerTest('TC-PERSIST-08', 'Persistence', 'Explicit in-memory backend is non-durable and rejected in production', async () => {
  const decision = resolvePersistenceDecision({
    ...loadConfig(),
    persistenceBackend: 'in-memory',
    databaseUrl: '',
    nodeEnv: 'development',
  });
  if (decision.backend !== 'in-memory' || decision.isDurable) {
    throw new Error(`Expected a non-durable in-memory backend, got ${decision.backend}`);
  }
  if (decision.failFastOnUnavailable !== false) {
    throw new Error('An explicit in-memory backend must not fail fast in development');
  }
  if (decision.explicit !== true) {
    throw new Error('An explicit UBTL_PERSISTENCE_BACKEND must be reported as explicit');
  }

  // Under production the same setting must be refused outright: accepting a
  // transaction into non-durable storage would violate the durability contract.
  const savedBackend = process.env.UBTL_PERSISTENCE_BACKEND;
  const savedNodeEnv = process.env.NODE_ENV;
  process.env.UBTL_PERSISTENCE_BACKEND = 'in-memory';
  process.env.NODE_ENV = 'production';
  try {
    const validation = validateEnvironment();
    const flagged = !validation.isValid && validation.errors.some((e) => e.includes('[PERSISTENCE_FAIL_FAST]'));
    if (!flagged) {
      throw new Error('UBTL_PERSISTENCE_BACKEND=in-memory must fail fast under NODE_ENV=production');
    }
  } finally {
    if (savedBackend === undefined) delete process.env.UBTL_PERSISTENCE_BACKEND;
    else process.env.UBTL_PERSISTENCE_BACKEND = savedBackend;
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
  }
});

registerTest('TC-PERSIST-09', 'Persistence', 'Auto mode selects PostgreSQL only when a DATABASE_URL is configured', async () => {
  const withUrl = resolvePersistenceDecision({
    ...loadConfig(),
    persistenceBackend: 'auto',
    databaseUrl: 'postgresql://user:pass@localhost:5432/ubtl',
    nodeEnv: 'development',
  });
  if (withUrl.backend !== 'postgres' || !withUrl.isDurable || withUrl.explicit) {
    throw new Error('Auto mode with a DATABASE_URL must resolve to a durable, non-explicit postgres backend');
  }
  // Development tolerates an unreachable database (loud warning + fallback);
  // production must abort instead.
  if (withUrl.failFastOnUnavailable !== false) {
    throw new Error('Auto mode must not fail fast in development');
  }
  const prodDecision = resolvePersistenceDecision({
    ...loadConfig(),
    persistenceBackend: 'auto',
    databaseUrl: 'postgresql://user:pass@localhost:5432/ubtl',
    nodeEnv: 'production',
  });
  if (prodDecision.failFastOnUnavailable !== true) {
    throw new Error('Auto mode in production must fail closed when the database is unreachable');
  }

  const withoutUrl = resolvePersistenceDecision({
    ...loadConfig(),
    persistenceBackend: 'auto',
    databaseUrl: '',
    nodeEnv: 'development',
  });
  if (withoutUrl.backend !== 'in-memory' || withoutUrl.isDurable) {
    throw new Error('Auto mode without a DATABASE_URL must resolve to the non-durable in-memory backend');
  }
});

registerTest('TC-PERSIST-10', 'Persistence', 'Postgres backend without DATABASE_URL fails fast at environment validation', async () => {
  const savedBackend = process.env.UBTL_PERSISTENCE_BACKEND;
  const savedUrl = process.env.DATABASE_URL;
  process.env.UBTL_PERSISTENCE_BACKEND = 'postgres';
  delete process.env.DATABASE_URL;
  try {
    const validation = validateEnvironment();
    const flagged = !validation.isValid && validation.errors.some((e) => e.includes('[PERSISTENCE_FAIL_FAST]'));
    if (!flagged) {
      throw new Error('UBTL_PERSISTENCE_BACKEND=postgres without DATABASE_URL must fail fast at startup');
    }
  } finally {
    if (savedBackend === undefined) delete process.env.UBTL_PERSISTENCE_BACKEND;
    else process.env.UBTL_PERSISTENCE_BACKEND = savedBackend;
    if (savedUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedUrl;
  }
});

registerTest('TC-PERSIST-11', 'Persistence', 'Unknown persistence backend value is rejected at validation', async () => {
  const savedBackend = process.env.UBTL_PERSISTENCE_BACKEND;
  process.env.UBTL_PERSISTENCE_BACKEND = 'sqlite';
  try {
    const validation = validateEnvironment();
    const flagged = !validation.isValid && validation.errors.some((e) => e.includes('Invalid UBTL_PERSISTENCE_BACKEND'));
    if (!flagged) {
      throw new Error('An unknown UBTL_PERSISTENCE_BACKEND value must be rejected');
    }
  } finally {
    if (savedBackend === undefined) delete process.env.UBTL_PERSISTENCE_BACKEND;
    else process.env.UBTL_PERSISTENCE_BACKEND = savedBackend;
  }
});

// =========================================================================
// SUITE 8: REGRESSION & BASELINE
// =========================================================================

registerTest('TC-REGRESS-01', 'Regression', 'Baseline environment validates successfully in mock mode', async () => {
  const envValidation = validateEnvironment();
  if (!envValidation.isValid || envValidation.mode !== 'mock') {
    throw new Error('Default environment validation failed or mode is not mock');
  }
});

registerTest('TC-REGRESS-02', 'Regression', 'Provider mode fails-fast when mandatory provider parameters are absent', async () => {
  const originalMode = process.env.BLOCKCHAIN_ADAPTER_MODE;
  process.env.BLOCKCHAIN_ADAPTER_MODE = 'provider';
  delete process.env.FABRIC_GATEWAY_PEER_ENDPOINT;

  const providerEnv = validateEnvironment();
  const failed = !providerEnv.isValid && providerEnv.errors.some((e) => e.includes('FABRIC_GATEWAY_PEER_ENDPOINT'));

  if (originalMode) process.env.BLOCKCHAIN_ADAPTER_MODE = originalMode;
  else delete process.env.BLOCKCHAIN_ADAPTER_MODE;

  if (!failed) {
    throw new Error('Provider mode did not fail-fast on missing credentials');
  }
});

// =========================================================================
// SUITE 9: TRANSACTIONAL OUTBOX & WORKER SUBSYSTEM (PROMPT 02)
// =========================================================================

registerTest('TC-OUTBOX-01', 'OutboxWorker', 'Transaction and initial outbox event are committed atomically', async () => {
  const repo = new InMemoryTransactionRepository();
  const config = loadConfig();
  const audit = new AuditService();
  const txService = new TransactionsService(audit, undefined, undefined, repo);

  const res = await txService.ingest({
    correlationId: 'corr-atomic-01',
    idempotencyKey: 'idemp-atomic-01',
    transactionType: 'SALES',
    payload: { invoiceNumber: 'INV-ATOM-01', amount: '1000.00', currency: 'IDR' },
    organizationId: 'org-test-uuid',
  });

  const tx = await repo.findByGatewayRequestId(res.gatewayRequestId);
  if (!tx) throw new Error('Transaction was not persisted in repository');
  if (tx.lifecycleState !== 'OUTBOX_PENDING') {
    throw new Error(`Expected OUTBOX_PENDING, got ${tx.lifecycleState}`);
  }

  // Duplicate with different payload must fail atomically without corrupting
  try {
    await txService.ingest({
      correlationId: 'corr-atomic-02',
      idempotencyKey: 'idemp-atomic-01',
      transactionType: 'SALES',
      payload: { invoiceNumber: 'INV-ATOM-DIFF', amount: '2000.00', currency: 'IDR' },
      organizationId: 'org-test-uuid',
    });
    throw new Error('Expected idempotency conflict was not thrown');
  } catch (err: any) {
    if (err.name !== 'IdempotencyConflictError') throw err;
  }
});

registerTest('TC-OUTBOX-02', 'OutboxWorker', 'Worker does not process an uncommitted outbox event', async () => {
  const outboxRepo = new InMemoryOutboxRepository();
  const now = 1000000;

  // Enqueue event with nextAttemptAt in the future (simulating uncommitted or delayed event)
  outboxRepo.enqueueAtomic({
    transactionId: 'tx-002',
    gatewayRequestId: 'gw-002',
    eventType: 'DISPATCH_LEDGER',
    status: 'PENDING',
    payload: {},
    attemptCount: 0,
    attempts: 0,
    maxAttempts: 5,
    nextAttemptAt: now + 5000,
    lockedAt: null,
    lockedBy: null,
    lastErrorCode: null,
    lastError: null,
    processedAt: null,
    deduplicationKey: 'dispatch:tx-002',
  });

  // Claim batch at current time
  const claimed = await outboxRepo.claimBatch('worker-1', 10, now);
  if (claimed.length !== 0) {
    throw new Error('Worker claimed event before its nextAttemptAt was reached');
  }
});

registerTest('TC-OUTBOX-03', 'OutboxWorker', 'A pending event is claimed exactly once under concurrent database workers', async () => {
  const outboxRepo = new InMemoryOutboxRepository();
  const now = 1000000;

  // Enqueue 6 pending events
  for (let i = 1; i <= 6; i++) {
    outboxRepo.enqueueAtomic({
      transactionId: `tx-batch-${i}`,
      gatewayRequestId: `gw-batch-${i}`,
      eventType: 'DISPATCH_LEDGER',
      status: 'PENDING',
      payload: {},
      attemptCount: 0,
      attempts: 0,
      maxAttempts: 5,
      nextAttemptAt: now - 100,
      lockedAt: null,
      lockedBy: null,
      lastErrorCode: null,
      lastError: null,
      processedAt: null,
      deduplicationKey: `dispatch:tx-batch-${i}`,
    });
  }

  // Simulate 3 workers claiming simultaneously
  const [batch1, batch2, batch3] = await Promise.all([
    outboxRepo.claimBatch('worker-1', 2, now),
    outboxRepo.claimBatch('worker-2', 2, now),
    outboxRepo.claimBatch('worker-3', 2, now),
  ]);

  const allClaimed = [...batch1, ...batch2, ...batch3];
  if (allClaimed.length !== 6) {
    throw new Error(`Expected 6 claimed events in total, got ${allClaimed.length}`);
  }

  // Ensure mutually exclusive claims (no duplicates)
  const ids = new Set(allClaimed.map((e) => e.id));
  if (ids.size !== 6) {
    throw new Error('Duplicate events claimed across concurrent workers');
  }
});

registerTest('TC-OUTBOX-04', 'OutboxWorker', 'Two workers cannot claim the same event simultaneously', async () => {
  const outboxRepo = new InMemoryOutboxRepository();
  const now = 1000000;

  outboxRepo.enqueueAtomic({
    transactionId: 'tx-single',
    gatewayRequestId: 'gw-single',
    eventType: 'DISPATCH_LEDGER',
    status: 'PENDING',
    payload: {},
    attemptCount: 0,
    attempts: 0,
    maxAttempts: 5,
    nextAttemptAt: now,
    lockedAt: null,
    lockedBy: null,
    lastErrorCode: null,
    lastError: null,
    processedAt: null,
    deduplicationKey: 'dispatch:tx-single',
  });

  const claim1 = await outboxRepo.claimBatch('worker-A', 5, now);
  const claim2 = await outboxRepo.claimBatch('worker-B', 5, now);

  if (claim1.length !== 1 || claim2.length !== 0) {
    throw new Error(`Worker A claimed ${claim1.length}, Worker B claimed ${claim2.length}; expected [1, 0]`);
  }
});

registerTest('TC-OUTBOX-05', 'OutboxWorker', 'Successful submission updates the expected state', async () => {
  const config = loadConfig();
  const audit = new AuditService();
  const txService = new TransactionsService(audit);
  const mockAdapter = new MockBlockchainAdapter(500, 0, 0);
  const webhookService = new WebhookService(config, audit);
  const outboxRepo = new InMemoryOutboxRepository();
  const worker = new OutboxWorker(config, outboxRepo, txService, mockAdapter, webhookService, audit);

  const ingestRes = await txService.ingest({
    correlationId: 'corr-05',
    idempotencyKey: 'idemp-05',
    transactionType: 'SALES',
    payload: { invoiceNumber: 'INV-05', amount: '500.00', currency: 'IDR' },
    organizationId: 'org-test',
  });

  outboxRepo.enqueueAtomic({
    transactionId: ingestRes.transaction.id,
    gatewayRequestId: ingestRes.gatewayRequestId,
    eventType: 'DISPATCH_LEDGER',
    status: 'PENDING',
    payload: {},
    attemptCount: 0,
    attempts: 0,
    maxAttempts: 5,
    nextAttemptAt: Date.now(),
    lockedAt: null,
    lockedBy: null,
    lastErrorCode: null,
    lastError: null,
    processedAt: null,
    deduplicationKey: `dispatch:${ingestRes.transaction.id}`,
  });

  const processed = await worker.pollAndProcess();
  if (processed !== 1) throw new Error(`Expected 1 processed event, got ${processed}`);

  const updatedTx = await txService.getById(ingestRes.gatewayRequestId);
  if (!updatedTx || updatedTx.status !== 'submitted' || updatedTx.lifecycleState !== 'SUBMITTED') {
    throw new Error(`Transaction state not updated to submitted: status=${updatedTx?.status}`);
  }
  if (!updatedTx.fabricTransactionId || !updatedTx.fabricTransactionId.startsWith('simulated-fabric-tx-')) {
    throw new Error(`Invalid fabricTransactionId: ${updatedTx?.fabricTransactionId}`);
  }
});

registerTest('TC-OUTBOX-06', 'OutboxWorker', 'Submission acknowledgement alone does not mark the transaction committed', async () => {
  const config = loadConfig();
  const audit = new AuditService();
  const txService = new TransactionsService(audit);
  const mockAdapter = new MockBlockchainAdapter(50000, 0, 0); // Long delay to verify commit is distinct
  const webhookService = new WebhookService(config, audit);
  const outboxRepo = new InMemoryOutboxRepository();
  const worker = new OutboxWorker(config, outboxRepo, txService, mockAdapter, webhookService, audit);

  const ingestRes = await txService.ingest({
    correlationId: 'corr-06',
    idempotencyKey: 'idemp-06',
    transactionType: 'SALES',
    payload: { invoiceNumber: 'INV-06', amount: '600.00', currency: 'IDR' },
    organizationId: 'org-test',
  });

  outboxRepo.enqueueAtomic({
    transactionId: ingestRes.transaction.id,
    gatewayRequestId: ingestRes.gatewayRequestId,
    eventType: 'DISPATCH_LEDGER',
    status: 'PENDING',
    payload: {},
    attemptCount: 0,
    attempts: 0,
    maxAttempts: 5,
    nextAttemptAt: Date.now(),
    lockedAt: null,
    lockedBy: null,
    lastErrorCode: null,
    lastError: null,
    processedAt: null,
    deduplicationKey: `dispatch:${ingestRes.transaction.id}`,
  });

  await worker.pollAndProcess();
  const tx = await txService.getById(ingestRes.gatewayRequestId);

  if (!tx) throw new Error('Transaction not found');
  if (tx.status !== 'submitted') {
    throw new Error(`Status must be 'submitted', got '${tx.status}'`);
  }
  if (tx.blockNumber !== null) {
    throw new Error(`blockNumber must remain null until block inclusion, got ${tx.blockNumber}`);
  }
  if (tx.confirmedAt !== null) {
    throw new Error(`confirmedAt must remain null upon submission acknowledgement, got ${tx.confirmedAt}`);
  }
});

registerTest('TC-OUTBOX-07', 'OutboxWorker', 'Confirmed commit updates the transaction lifecycle correctly', async () => {
  const config = loadConfig();
  const audit = new AuditService();
  const txService = new TransactionsService(audit);
  const mockAdapter = new MockBlockchainAdapter(0, 0, 0); // 0ms commit delay
  const webhookService = new WebhookService(config, audit);
  const outboxRepo = new InMemoryOutboxRepository();
  const worker = new OutboxWorker(config, outboxRepo, txService, mockAdapter, webhookService, audit);

  const ingestRes = await txService.ingest({
    correlationId: 'corr-07',
    idempotencyKey: 'idemp-07',
    transactionType: 'SALES',
    payload: { invoiceNumber: 'INV-07', amount: '700.00', currency: 'IDR' },
    organizationId: 'org-test',
  });

  outboxRepo.enqueueAtomic({
    transactionId: ingestRes.transaction.id,
    gatewayRequestId: ingestRes.gatewayRequestId,
    eventType: 'DISPATCH_LEDGER',
    status: 'PENDING',
    payload: {},
    attemptCount: 0,
    attempts: 0,
    maxAttempts: 5,
    nextAttemptAt: Date.now(),
    lockedAt: null,
    lockedBy: null,
    lastErrorCode: null,
    lastError: null,
    processedAt: null,
    deduplicationKey: `dispatch:${ingestRes.transaction.id}`,
  });

  // Step 1: Process DISPATCH_LEDGER
  await worker.pollAndProcess();

  // Step 2: Process VERIFY_COMMIT (mock commit delay is 0ms)
  await worker.pollAndProcess();

  const confirmedTx = await txService.getById(ingestRes.gatewayRequestId);
  if (!confirmedTx || confirmedTx.status !== 'confirmed' || confirmedTx.lifecycleState !== 'COMMITTED') {
    throw new Error(`Expected confirmed/COMMITTED state, got ${confirmedTx?.status}/${confirmedTx?.lifecycleState}`);
  }
  if (!confirmedTx.blockNumber || confirmedTx.blockNumber <= 0) {
    throw new Error(`Expected positive blockNumber, got ${confirmedTx.blockNumber}`);
  }
});

registerTest('TC-OUTBOX-08', 'OutboxWorker', 'Transient failure schedules a retry', async () => {
  const config = loadConfig();
  const audit = new AuditService();
  const txService = new TransactionsService(audit);
  // Failing mock adapter throwing transient error
  const failingAdapter: any = {
    mode: 'mock',
    initialize: async () => {},
    submitProposal: async () => {
      const err = new Error('Connection reset by peer');
      (err as any).code = 'ECONNRESET';
      throw err;
    },
    healthCheck: async () => ({ status: 'online' }),
  };
  const webhookService = new WebhookService(config, audit);
  const outboxRepo = new InMemoryOutboxRepository();
  const worker = new OutboxWorker(config, outboxRepo, txService, failingAdapter, webhookService, audit);
  worker.nowFn = () => 1000000;
  worker.randomFn = () => 0; // Deterministic jitter = 0

  const event = outboxRepo.enqueueAtomic({
    transactionId: 'tx-transient',
    gatewayRequestId: 'gw-transient',
    eventType: 'DISPATCH_LEDGER',
    status: 'PENDING',
    payload: {},
    attemptCount: 0,
    attempts: 0,
    maxAttempts: 5,
    nextAttemptAt: 1000000,
    lockedAt: null,
    lockedBy: null,
    lastErrorCode: null,
    lastError: null,
    processedAt: null,
    deduplicationKey: 'dispatch:tx-transient',
  });

  // Seed transaction
  await txService.getRepository().createAtomic({
    id: 'tx-transient',
    gatewayRequestId: 'gw-transient',
    organizationId: 'org-test',
    correlationId: 'corr-transient',
    idempotencyKey: 'idemp-transient',
    transactionType: 'SALES',
    schemaVersion: '1.0',
    status: 'pending',
    lifecycleState: 'OUTBOX_PENDING',
    payloadHash: 'hash',
    hashAlgorithm: 'sha256',
    hashVersion: '1',
    canonicalizationSpec: 'ubtl-canonical-json-v1',
    fabricTransactionId: null,
    blockNumber: null,
    blockchainTxHash: null,
    rawPayload: {},
    canonicalPayload: '{}',
    attemptCount: 0,
    errorCode: null,
    errorMessage: null,
    submittedAt: new Date().toISOString(),
    confirmedAt: null,
    failedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  await worker.pollAndProcess();

  const updatedEvent = outboxRepo.findById(event.id);
  if (!updatedEvent) throw new Error('Event not found');
  if (updatedEvent.status !== 'RETRY_PENDING') {
    throw new Error(`Expected RETRY_PENDING, got ${updatedEvent.status}`);
  }
  if (updatedEvent.attemptCount !== 1) {
    throw new Error(`Expected attemptCount 1, got ${updatedEvent.attemptCount}`);
  }
  if (updatedEvent.nextAttemptAt <= 1000000) {
    throw new Error('nextAttemptAt must be scheduled in the future');
  }
});

registerTest('TC-OUTBOX-09', 'OutboxWorker', 'Backoff follows the documented formula', async () => {
  const policy = {
    baseDelayMs: 1000,
    maxDelayMs: 30000,
    maxRetries: 5,
    jitterRatio: 0.25,
  };

  // Test with zero jitter
  const zeroJitter = () => 0;
  const delay1 = calculateBackoffDelay(1, policy, zeroJitter);
  const delay2 = calculateBackoffDelay(2, policy, zeroJitter);
  const delay3 = calculateBackoffDelay(3, policy, zeroJitter);
  const delay4 = calculateBackoffDelay(4, policy, zeroJitter);

  if (delay1 !== 1000) throw new Error(`Expected attempt 1 delay 1000, got ${delay1}`);
  if (delay2 !== 2000) throw new Error(`Expected attempt 2 delay 2000, got ${delay2}`);
  if (delay3 !== 4000) throw new Error(`Expected attempt 3 delay 4000, got ${delay3}`);
  if (delay4 !== 8000) throw new Error(`Expected attempt 4 delay 8000, got ${delay4}`);

  // Test with maximum bounded jitter
  const maxJitter = () => 1.0;
  const delayWithJitter = calculateBackoffDelay(1, policy, maxJitter);
  // 1000 + floor(1.0 * 250) = 1250
  if (delayWithJitter < 1000 || delayWithJitter > 1250) {
    throw new Error(`Jitter exceeded bounds: got ${delayWithJitter}`);
  }
});

registerTest('TC-OUTBOX-10', 'OutboxWorker', 'Permanent errors do not retry indefinitely', async () => {
  const config = loadConfig();
  const audit = new AuditService();
  const txService = new TransactionsService(audit);
  const permanentErrorAdapter: any = {
    mode: 'mock',
    initialize: async () => {},
    submitProposal: async () => {
      const err = new Error('Payload format invalid: schema validation error');
      (err as any).code = 'INVALID_ARGUMENT';
      throw err;
    },
    healthCheck: async () => ({ status: 'online' }),
  };
  const webhookService = new WebhookService(config, audit);
  const outboxRepo = new InMemoryOutboxRepository();
  const worker = new OutboxWorker(config, outboxRepo, txService, permanentErrorAdapter, webhookService, audit);
  worker.nowFn = () => 1000000;

  const event = outboxRepo.enqueueAtomic({
    transactionId: 'tx-perm',
    gatewayRequestId: 'gw-perm',
    eventType: 'DISPATCH_LEDGER',
    status: 'PENDING',
    payload: {},
    attemptCount: 0,
    attempts: 0,
    maxAttempts: 5,
    nextAttemptAt: 1000000,
    lockedAt: null,
    lockedBy: null,
    lastErrorCode: null,
    lastError: null,
    processedAt: null,
    deduplicationKey: 'dispatch:tx-perm',
  });

  await txService.getRepository().createAtomic({
    id: 'tx-perm',
    gatewayRequestId: 'gw-perm',
    organizationId: 'org-test',
    correlationId: 'corr-perm',
    idempotencyKey: 'idemp-perm',
    transactionType: 'SALES',
    schemaVersion: '1.0',
    status: 'pending',
    lifecycleState: 'OUTBOX_PENDING',
    payloadHash: 'hash',
    hashAlgorithm: 'sha256',
    hashVersion: '1',
    canonicalizationSpec: 'ubtl-canonical-json-v1',
    fabricTransactionId: null,
    blockNumber: null,
    blockchainTxHash: null,
    rawPayload: {},
    canonicalPayload: '{}',
    attemptCount: 0,
    errorCode: null,
    errorMessage: null,
    submittedAt: new Date().toISOString(),
    confirmedAt: null,
    failedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  await worker.pollAndProcess();

  const updatedEvent = outboxRepo.findById(event.id);
  if (!updatedEvent || updatedEvent.status !== 'DEAD_LETTER') {
    throw new Error(`Expected DEAD_LETTER on permanent error, got ${updatedEvent?.status}`);
  }
  const tx = await txService.getById('gw-perm');
  if (tx?.lifecycleState !== 'FAILED' || tx?.status !== 'failed') {
    throw new Error(`Transaction state not updated to failed: ${tx?.lifecycleState}`);
  }
});

registerTest('TC-OUTBOX-11', 'OutboxWorker', 'Ambiguous timeout triggers reconciliation rather than blind resubmission', async () => {
  const config = loadConfig();
  const audit = new AuditService();
  const txService = new TransactionsService(audit);
  const timeoutAdapter: any = {
    mode: 'mock',
    initialize: async () => {},
    submitProposal: async () => {
      const err = new Error('Peer proposal deadline exceeded');
      (err as any).code = 'ETIMEDOUT';
      throw err;
    },
    healthCheck: async () => ({ status: 'online' }),
  };
  const webhookService = new WebhookService(config, audit);
  const outboxRepo = new InMemoryOutboxRepository();
  const worker = new OutboxWorker(config, outboxRepo, txService, timeoutAdapter, webhookService, audit);
  worker.nowFn = () => 1000000;

  outboxRepo.enqueueAtomic({
    transactionId: 'tx-ambig',
    gatewayRequestId: 'gw-ambig',
    eventType: 'DISPATCH_LEDGER',
    status: 'PENDING',
    payload: {},
    attemptCount: 0,
    attempts: 0,
    maxAttempts: 5,
    nextAttemptAt: 1000000,
    lockedAt: null,
    lockedBy: null,
    lastErrorCode: null,
    lastError: null,
    processedAt: null,
    deduplicationKey: 'dispatch:tx-ambig',
  });

  await txService.getRepository().createAtomic({
    id: 'tx-ambig',
    gatewayRequestId: 'gw-ambig',
    organizationId: 'org-test',
    correlationId: 'corr-ambig',
    idempotencyKey: 'idemp-ambig',
    transactionType: 'SALES',
    schemaVersion: '1.0',
    status: 'pending',
    lifecycleState: 'OUTBOX_PENDING',
    payloadHash: 'hash',
    hashAlgorithm: 'sha256',
    hashVersion: '1',
    canonicalizationSpec: 'ubtl-canonical-json-v1',
    fabricTransactionId: null,
    blockNumber: null,
    blockchainTxHash: null,
    rawPayload: {},
    canonicalPayload: '{}',
    attemptCount: 0,
    errorCode: null,
    errorMessage: null,
    submittedAt: new Date().toISOString(),
    confirmedAt: null,
    failedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  await worker.pollAndProcess();

  const tx = await txService.getById('gw-ambig');
  if (tx?.lifecycleState !== 'RECONCILIATION_REQUIRED' || tx?.status !== 'timeout') {
    throw new Error(`Expected RECONCILIATION_REQUIRED/timeout, got ${tx?.lifecycleState}/${tx?.status}`);
  }
});

registerTest('TC-OUTBOX-12', 'OutboxWorker', 'Retry preserves the original transaction ID and idempotency key', async () => {
  const config = loadConfig();
  const audit = new AuditService();
  const txService = new TransactionsService(audit);
  let attempts = 0;
  const retryAdapter: any = {
    mode: 'mock',
    initialize: async () => {},
    submitProposal: async (input: any) => {
      attempts++;
      if (attempts === 1) {
        throw new Error('Transient 503');
      }
      return {
        accepted: true,
        fabricTransactionId: 'simulated-fabric-tx-retry-success',
        status: 'PENDING',
        isSimulated: true,
      };
    },
    healthCheck: async () => ({ status: 'online' }),
  };
  const webhookService = new WebhookService(config, audit);
  const outboxRepo = new InMemoryOutboxRepository();
  const worker = new OutboxWorker(config, outboxRepo, txService, retryAdapter, webhookService, audit);
  let currentTime = 1000000;
  worker.nowFn = () => currentTime;
  worker.randomFn = () => 0;

  const ingestRes = await txService.ingest({
    correlationId: 'corr-preserve',
    idempotencyKey: 'idemp-preserve-stable',
    transactionType: 'SALES',
    payload: { invoiceNumber: 'INV-12', amount: '120.00', currency: 'IDR' },
    organizationId: 'org-test',
  });

  const event = outboxRepo.enqueueAtomic({
    transactionId: ingestRes.transaction.id,
    gatewayRequestId: ingestRes.gatewayRequestId,
    eventType: 'DISPATCH_LEDGER',
    status: 'PENDING',
    payload: {},
    attemptCount: 0,
    attempts: 0,
    maxAttempts: 5,
    nextAttemptAt: currentTime,
    lockedAt: null,
    lockedBy: null,
    lastErrorCode: null,
    lastError: null,
    processedAt: null,
    deduplicationKey: `dispatch:${ingestRes.transaction.id}`,
  });

  // Attempt 1 fails transiently
  await worker.pollAndProcess();
  let ev = outboxRepo.findById(event.id);
  if (ev?.status !== 'RETRY_PENDING') throw new Error(`Expected RETRY_PENDING after attempt 1, got ${ev?.status}`);

  // Advance time past nextAttemptAt
  currentTime = ev.nextAttemptAt + 10;

  // Attempt 2 succeeds
  await worker.pollAndProcess();
  const finalTx = await txService.getById(ingestRes.gatewayRequestId);

  if (finalTx?.gatewayRequestId !== ingestRes.gatewayRequestId) {
    throw new Error('gatewayRequestId was mutated across retry attempts');
  }
  if (finalTx?.idempotencyKey !== 'idemp-preserve-stable') {
    throw new Error('idempotencyKey was mutated across retry attempts');
  }
  if (finalTx?.status !== 'submitted') {
    throw new Error(`Expected submitted status after retry success, got ${finalTx?.status}`);
  }
});

registerTest('TC-OUTBOX-13', 'OutboxWorker', 'A crash after claim can be recovered safely', async () => {
  const config = loadConfig();
  const audit = new AuditService();
  const txService = new TransactionsService(audit);
  const mockAdapter = new MockBlockchainAdapter();
  const webhookService = new WebhookService(config, audit);
  const outboxRepo = new InMemoryOutboxRepository();
  const worker = new OutboxWorker(config, outboxRepo, txService, mockAdapter, webhookService, audit);

  const now = 1000000;
  worker.nowFn = () => now;

  // Simulate an event left in PROCESSING when a process died 10 minutes ago
  const stuckEvent = outboxRepo.enqueueAtomic({
    transactionId: 'tx-crash-claim',
    gatewayRequestId: 'gw-crash-claim',
    eventType: 'DISPATCH_LEDGER',
    status: 'PROCESSING',
    payload: {},
    attemptCount: 1,
    attempts: 1,
    maxAttempts: 5,
    nextAttemptAt: now - 600000,
    lockedAt: now - 600000,
    lockedBy: 'worker-dead-pid-999',
    lastErrorCode: null,
    lastError: null,
    processedAt: null,
    deduplicationKey: 'dispatch:tx-crash-claim',
  });

  // Run stuck event recovery
  const recoveredCount = await worker.recoverStuckEvents();
  if (recoveredCount !== 1) throw new Error(`Expected 1 recovered event, got ${recoveredCount}`);

  const recovered = outboxRepo.findById(stuckEvent.id);
  if (recovered?.status !== 'RETRY_PENDING') {
    throw new Error(`Expected RETRY_PENDING after stuck recovery, got ${recovered?.status}`);
  }
  if (recovered.lockedBy !== null) {
    throw new Error(`Expected lockedBy to be cleared, got ${recovered.lockedBy}`);
  }
});

registerTest('TC-OUTBOX-14', 'OutboxWorker', 'A crash after submission triggers reconciliation', async () => {
  const config = loadConfig();
  const audit = new AuditService();
  const txService = new TransactionsService(audit);
  const mockAdapter = new MockBlockchainAdapter(1000, 0, 0);
  await mockAdapter.initialize();
  const webhookService = new WebhookService(config, audit);
  const outboxRepo = new InMemoryOutboxRepository();
  const worker = new OutboxWorker(config, outboxRepo, txService, mockAdapter, webhookService, audit);

  const now = 2000000;
  worker.nowFn = () => now;

  // Ingest transaction
  const ingest = await txService.ingest({
    correlationId: 'corr-crash-sub',
    idempotencyKey: 'idemp-crash-sub',
    transactionType: 'SALES',
    payload: { invoiceNumber: 'INV-14', amount: '14.00', currency: 'IDR' },
    organizationId: 'org-test',
  });

  // Simulate proposal already submitted to adapter right before crash
  const subResult = await mockAdapter.submitProposal({
    gatewayRequestId: ingest.gatewayRequestId,
    correlationId: ingest.transaction.correlationId,
    transactionType: ingest.transaction.transactionType,
    payloadHash: ingest.transaction.payloadHash,
    timestamp: ingest.transaction.submittedAt,
  });

  // Event left in PROCESSING
  outboxRepo.enqueueAtomic({
    transactionId: ingest.transaction.id,
    gatewayRequestId: ingest.gatewayRequestId,
    eventType: 'DISPATCH_LEDGER',
    status: 'PROCESSING',
    payload: {},
    attemptCount: 1,
    attempts: 1,
    maxAttempts: 5,
    nextAttemptAt: now - 120000,
    lockedAt: now - 120000,
    lockedBy: 'worker-crashed',
    lastErrorCode: null,
    lastError: null,
    processedAt: null,
    deduplicationKey: `dispatch:${ingest.transaction.id}`,
  });

  // Recovery executes: discovers submission on adapter via idempotency key
  await worker.recoverStuckEvents();

  const updatedTx = await txService.getById(ingest.gatewayRequestId);
  if (updatedTx?.status !== 'submitted') {
    throw new Error(`Expected transaction to be recovered to submitted, got ${updatedTx?.status}`);
  }
  if (updatedTx.fabricTransactionId !== subResult.fabricTransactionId) {
    throw new Error('Reconciliation did not adopt the existing adapter fabricTransactionId');
  }
});

registerTest('TC-OUTBOX-15', 'OutboxWorker', 'A crash after result receipt does not cause false commit status', async () => {
  const config = loadConfig();
  const audit = new AuditService();
  const txService = new TransactionsService(audit);

  const ingest = await txService.ingest({
    correlationId: 'corr-crash-receipt',
    idempotencyKey: 'idemp-crash-receipt',
    transactionType: 'SALES',
    payload: { invoiceNumber: 'INV-15', amount: '15.00', currency: 'IDR' },
    organizationId: 'org-test',
  });

  // Proposal submitted, but worker died before block commit verification
  await txService.markSubmitted(ingest.gatewayRequestId, 'simulated-fabric-tx-receipt');

  const tx = await txService.getById(ingest.gatewayRequestId);
  if (tx?.lifecycleState === 'COMMITTED' || tx?.status === 'confirmed') {
    throw new Error('Transaction was prematurely confirmed before commit verification');
  }
  if (tx?.blockNumber !== null) {
    throw new Error('blockNumber must remain null prior to block inclusion');
  }
});

registerTest('TC-OUTBOX-16', 'OutboxWorker', 'Exhausted retries produce the documented dead-letter behavior', async () => {
  const config = loadConfig();
  const audit = new AuditService();
  const txService = new TransactionsService(audit);
  const failingAdapter: any = {
    mode: 'mock',
    initialize: async () => {},
    submitProposal: async () => {
      throw new Error('Transient 500 error');
    },
    healthCheck: async () => ({ status: 'online' }),
  };
  const webhookService = new WebhookService(config, audit);
  const outboxRepo = new InMemoryOutboxRepository();
  const worker = new OutboxWorker(config, outboxRepo, txService, failingAdapter, webhookService, audit);
  const now = 1000000;
  worker.nowFn = () => now;

  const ingest = await txService.ingest({
    correlationId: 'corr-exhaust',
    idempotencyKey: 'idemp-exhaust',
    transactionType: 'SALES',
    payload: { invoiceNumber: 'INV-16', amount: '16.00', currency: 'IDR' },
    organizationId: 'org-test',
  });

  // Event already on attempt 4 with maxAttempts 5
  const event = outboxRepo.enqueueAtomic({
    transactionId: ingest.transaction.id,
    gatewayRequestId: ingest.gatewayRequestId,
    eventType: 'DISPATCH_LEDGER',
    status: 'PENDING',
    payload: {},
    attemptCount: 4,
    attempts: 4,
    maxAttempts: 5,
    nextAttemptAt: now,
    lockedAt: null,
    lockedBy: null,
    lastErrorCode: null,
    lastError: null,
    processedAt: null,
    deduplicationKey: `dispatch:${ingest.transaction.id}`,
  });

  // Run attempt 5 (fails)
  await worker.pollAndProcess();

  const finalEvent = outboxRepo.findById(event.id);
  if (finalEvent?.status !== 'DEAD_LETTER') {
    throw new Error(`Expected DEAD_LETTER after max attempts exhausted, got ${finalEvent?.status}`);
  }
  const tx = await txService.getById(ingest.gatewayRequestId);
  if (tx?.status !== 'failed' || tx?.lifecycleState !== 'FAILED') {
    throw new Error(`Transaction was not marked failed upon retry exhaustion: status=${tx?.status}`);
  }
});

registerTest('TC-OUTBOX-17', 'OutboxWorker', 'Stuck event recovery checks ambiguity before retrying', async () => {
  const config = loadConfig();
  const audit = new AuditService();
  const txService = new TransactionsService(audit);
  let queryCount = 0;
  const mockAdapter: any = {
    mode: 'mock',
    initialize: async () => {},
    findTransactionByIdempotencyKey: async () => {
      queryCount++;
      return null; // Confirms not on adapter
    },
    healthCheck: async () => ({ status: 'online' }),
  };
  const webhookService = new WebhookService(config, audit);
  const outboxRepo = new InMemoryOutboxRepository();
  const worker = new OutboxWorker(config, outboxRepo, txService, mockAdapter, webhookService, audit);
  const now = 1000000;
  worker.nowFn = () => now;

  outboxRepo.enqueueAtomic({
    transactionId: 'tx-ambig-stuck',
    gatewayRequestId: 'gw-ambig-stuck',
    eventType: 'DISPATCH_LEDGER',
    status: 'PROCESSING',
    payload: {},
    attemptCount: 1,
    attempts: 1,
    maxAttempts: 5,
    nextAttemptAt: now - 80000,
    lockedAt: now - 80000,
    lockedBy: 'worker-dead',
    lastErrorCode: null,
    lastError: null,
    processedAt: null,
    deduplicationKey: 'dispatch:tx-ambig-stuck',
  });

  await worker.recoverStuckEvents();
  if (queryCount !== 1) {
    throw new Error(`Expected adapter check before resetting stuck event, queryCount=${queryCount}`);
  }
});

registerTest('TC-OUTBOX-18', 'OutboxWorker', 'Switching callback failure does not roll back a committed ledger transaction', async () => {
  const config = loadConfig();
  const audit = new AuditService();
  const txService = new TransactionsService(audit);
  const mockAdapter = new MockBlockchainAdapter();
  // Webhook service throwing HTTP 500 error
  const failingWebhookService: any = {
    deliverWebhook: async () => {
      throw new Error('Switching gateway webhook endpoint returned HTTP 500 Internal Server Error');
    },
  };
  const outboxRepo = new InMemoryOutboxRepository();
  const worker = new OutboxWorker(config, outboxRepo, txService, mockAdapter, failingWebhookService, audit);
  const now = 1000000;
  worker.nowFn = () => now;

  // Create committed transaction on ledger
  const ingest = await txService.ingest({
    correlationId: 'corr-cb-fail',
    idempotencyKey: 'idemp-cb-fail',
    transactionType: 'SALES',
    payload: { invoiceNumber: 'INV-18', amount: '180.00', currency: 'IDR' },
    organizationId: 'org-test',
  });
  await txService.markSubmitted(ingest.gatewayRequestId, 'simulated-fabric-tx-18');
  await txService.markCommitted(ingest.gatewayRequestId, 15420);

  // Webhook outbox event
  const webhookEvent = outboxRepo.enqueueAtomic({
    transactionId: ingest.transaction.id,
    gatewayRequestId: ingest.gatewayRequestId,
    eventType: 'DELIVER_WEBHOOK',
    status: 'PENDING',
    payload: { status: 'confirmed', blockchainTxHash: 'simulated-fabric-tx-18' },
    attemptCount: 0,
    attempts: 0,
    maxAttempts: 5,
    nextAttemptAt: now,
    lockedAt: null,
    lockedBy: null,
    lastErrorCode: null,
    lastError: null,
    processedAt: null,
    deduplicationKey: `webhook:confirmed:${ingest.transaction.id}`,
  });

  // Process webhook delivery failure
  await worker.pollAndProcess();

  const txAfter = await txService.getById(ingest.gatewayRequestId);
  if (txAfter?.status !== 'confirmed' || txAfter?.lifecycleState !== 'COMMITTED') {
    throw new Error('Transaction committed ledger state was altered by webhook failure');
  }
  if (txAfter.blockNumber !== 15420) {
    throw new Error('Transaction blockNumber was altered by webhook failure');
  }
  const evAfter = outboxRepo.findById(webhookEvent.id);
  if (evAfter?.status !== 'RETRY_PENDING') {
    throw new Error(`Webhook event should be RETRY_PENDING, got ${evAfter?.status}`);
  }
});

registerTest('TC-OUTBOX-19', 'OutboxWorker', 'Callback retries are independent of blockchain submission retries', async () => {
  const outboxRepo = new InMemoryOutboxRepository();
  const now = 1000000;

  const dispatchEvent = outboxRepo.enqueueAtomic({
    transactionId: 'tx-19',
    gatewayRequestId: 'gw-19',
    eventType: 'DISPATCH_LEDGER',
    status: 'COMPLETED',
    payload: {},
    attemptCount: 1,
    attempts: 1,
    maxAttempts: 5,
    nextAttemptAt: now,
    lockedAt: null,
    lockedBy: null,
    lastErrorCode: null,
    lastError: null,
    processedAt: new Date(now).toISOString(),
    deduplicationKey: 'dispatch:tx-19',
  });

  const webhookEvent = outboxRepo.enqueueAtomic({
    transactionId: 'tx-19',
    gatewayRequestId: 'gw-19',
    eventType: 'DELIVER_WEBHOOK',
    status: 'RETRY_PENDING',
    payload: {},
    attemptCount: 3,
    attempts: 3,
    maxAttempts: 5,
    nextAttemptAt: now + 4000,
    lockedAt: null,
    lockedBy: null,
    lastErrorCode: 'WEBHOOK_TIMEOUT',
    lastError: 'HTTP timeout',
    processedAt: null,
    deduplicationKey: 'webhook:submitted:tx-19',
  });

  if (dispatchEvent.attemptCount === webhookEvent.attemptCount) {
    throw new Error('Callback retry attempt count is coupled to dispatch attempt count');
  }
  if (dispatchEvent.status === webhookEvent.status) {
    throw new Error('Callback status is coupled to dispatch status');
  }
});

registerTest('TC-OUTBOX-20', 'OutboxWorker', 'Graceful shutdown prevents new claims and safely handles active work', async () => {
  const config = loadConfig();
  const audit = new AuditService();
  const txService = new TransactionsService(audit);
  const mockAdapter = new MockBlockchainAdapter();
  const webhookService = new WebhookService(config, audit);
  const outboxRepo = new InMemoryOutboxRepository();
  const worker = new OutboxWorker(config, outboxRepo, txService, mockAdapter, webhookService, audit);

  outboxRepo.enqueueAtomic({
    transactionId: 'tx-shutdown',
    gatewayRequestId: 'gw-shutdown',
    eventType: 'DISPATCH_LEDGER',
    status: 'PENDING',
    payload: {},
    attemptCount: 0,
    attempts: 0,
    maxAttempts: 5,
    nextAttemptAt: Date.now(),
    lockedAt: null,
    lockedBy: null,
    lastErrorCode: null,
    lastError: null,
    processedAt: null,
    deduplicationKey: 'dispatch:tx-shutdown',
  });

  // Stop worker gracefully
  await worker.stop();

  // Subsequent poll must refuse to claim
  const claimed = await worker.pollAndProcess();
  if (claimed !== 0) {
    throw new Error(`Worker claimed ${claimed} events after stop() was called`);
  }
});

registerTest('TC-OUTBOX-21', 'OutboxWorker', 'Health reporting distinguishes mock mode from real provider health', async () => {
  const config = loadConfig();
  const audit = new AuditService();
  const txService = new TransactionsService(audit);
  const mockAdapter = new MockBlockchainAdapter();
  const webhookService = new WebhookService(config, audit);
  const outboxRepo = new InMemoryOutboxRepository();
  const outboxService = new OutboxService(config, txService, mockAdapter, webhookService, audit, outboxRepo);
  const auth = new AuthService(config);

  const controller = new GatewayCompatController(auth, txService, outboxService, mockAdapter);

  let responseBody: any = null;
  const mockRes: any = {
    status: () => mockRes,
    json: (body: any) => {
      responseBody = body;
    },
  };

  await controller.getHealth({} as any, mockRes);

  if (responseBody.adapterMode !== 'mock') {
    throw new Error(`Expected adapterMode 'mock', got ${responseBody.adapterMode}`);
  }
  if (!responseBody.blockchainAdapter.isSimulated) {
    throw new Error('Adapter must report isSimulated: true in mock mode');
  }
  if (responseBody.worker === undefined || responseBody.worker.running === undefined) {
    throw new Error('Health check missing worker observability state');
  }
  if (responseBody.outbox === undefined || responseBody.outbox.pendingCount === undefined) {
    throw new Error('Health check missing outbox metrics');
  }
});

registerTest('TC-OUTBOX-22', 'OutboxWorker', 'Invalid worker configuration fails fast', async () => {
  const origPoll = process.env.OUTBOX_POLL_INTERVAL_MS;
  process.env.OUTBOX_POLL_INTERVAL_MS = '-1000';

  const validation = validateEnvironment();
  const hasError = !validation.isValid && validation.errors.some((e) => e.includes('OUTBOX_POLL_INTERVAL_MS'));

  if (origPoll) process.env.OUTBOX_POLL_INTERVAL_MS = origPoll;
  else delete process.env.OUTBOX_POLL_INTERVAL_MS;

  if (!hasError) {
    throw new Error('Environment validation did not fail fast on negative OUTBOX_POLL_INTERVAL_MS');
  }
});

registerTest('TC-OUTBOX-23', 'OutboxWorker', 'Existing Prompt 00 and Prompt 01 tests continue to pass', async () => {
  // Guard ensuring the previous suites are registered and verified
  const suiteNames = new Set(testInventory.map((t) => t.suite));
  const expectedSuites = [
    'Canonicalization',
    'Hashing',
    'Ingestion',
    'Lifecycle',
    'MockSemantics',
    'Authentication',
    'Persistence',
    'Regression',
    'OutboxWorker',
    'FabricAdapter',
  ];

  for (const s of expectedSuites) {
    if (!suiteNames.has(s)) {
      throw new Error(`Missing expected test suite: '${s}'`);
    }
  }
});

// =========================================================================
// SUITE 10: FABRIC GATEWAY ADAPTER (PROVIDER MODE)
// =========================================================================
//
// ⚠ SCOPE OF EVIDENCE — READ BEFORE INTERPRETING RESULTS
//
// Every test below (except TC-FABRIC-21) exercises the adapter against a
// DETERMINISTIC, IN-PROCESS TEST DOUBLE of the Fabric Gateway SDK. They prove
// how UBTL behaves given a documented SDK response; they prove NOTHING about a
// live Hyperledger Fabric network, and no real Fabric transaction ID, block
// number or commit event is produced or claimed here.
//
// The single live-network test is TC-FABRIC-21. It is opt-in and honestly
// reports SKIP when no Fabric network and credentials are supplied.
// =========================================================================

const FABRIC_TEST_MATERIAL: FabricCredentialMaterial = {
  tlsRootCert: Buffer.from('-----BEGIN CERTIFICATE-----\nTLS-ROOT-DOUBLE\n-----END CERTIFICATE-----'),
  clientCertificate: Buffer.from('-----BEGIN CERTIFICATE-----\nCLIENT-CERT-DOUBLE\n-----END CERTIFICATE-----'),
  clientPrivateKey: Buffer.from('-----BEGIN PRIVATE KEY-----\nKEY-DOUBLE\n-----END PRIVATE KEY-----'),
};

const FABRIC_VALID_OPTIONS: FabricGatewayOptions = {
  peerEndpoint: 'peer0.org1.ubtl.example.com:7051',
  tlsCertPath: '/secrets/ca.pem',
  clientCertPath: '/secrets/client.pem',
  clientKeyPath: '/secrets/client-key.pem',
  mspId: 'Org1MSP',
  channelName: 'ubtl-channel',
  chaincodeName: 'ubtl-ledger',
  commitTimeoutSeconds: 30,
  discoveryAsLocalhost: false,
};

interface FabricDoubleScenario {
  transactionId?: string;
  endorseError?: unknown;
  submitError?: unknown;
  commitStatus?: FabricCommitStatus;
  commitStatusError?: unknown;
}

/**
 * Deterministic in-process test double for the Fabric Gateway SDK. Records
 * every call so tests can assert on the exact ledger contract and on the
 * distinction between submission and commit.
 */
class FabricGatewayConnectorDouble implements FabricGatewayConnector {
  public sdkError: Error | null = null;
  public loadSdkCalls = 0;
  public createGrpcClientCalls = 0;
  public lastGrpcAddress: string | null = null;
  public gatewayCloseCount = 0;
  public grpcCloseCount = 0;
  public proposals: Array<{ name: string; args: Array<string | Uint8Array> }> = [];
  public evaluations: Array<{ name: string; args: Array<string | Uint8Array> }> = [];
  public scenario: FabricDoubleScenario = {};
  public evaluateHandler:
    | ((name: string, args: Array<string | Uint8Array>) => Uint8Array | null)
    | null = null;

  async loadSdk(): Promise<void> {
    this.loadSdkCalls++;
    if (this.sdkError) throw this.sdkError;
  }

  createGrpcClient(address: string, _tlsRootCert: Buffer, _options: FabricGrpcClientOptions): unknown {
    this.createGrpcClientCalls++;
    this.lastGrpcAddress = address;
    return { close: () => { this.grpcCloseCount++; } };
  }

  newSigner(_privateKeyPem: Buffer): unknown {
    return { signer: 'test-double' };
  }

  closeGrpcClient(client: unknown): void {
    (client as { close: () => void }).close();
  }

  connect(options: FabricConnectOptions): FabricGatewayHandle {
    const contract: FabricContractHandle = {
      getChaincodeName: () => 'ubtl-ledger',
      evaluateTransaction: async (name, ...args) => {
        this.evaluations.push({ name, args });
        const result = this.evaluateHandler ? this.evaluateHandler(name, args) : null;
        return result ?? new Uint8Array();
      },
      newProposal: (name, proposalOptions) => {
        const args = proposalOptions?.arguments ?? [];
        this.proposals.push({ name, args });
        const transactionId = this.scenario.transactionId ?? 'fabric-double-tx-0001';
        const proposal: FabricProposalHandle = {
          getTransactionId: () => transactionId,
          endorse: async () => {
            if (this.scenario.endorseError) throw this.scenario.endorseError;
            const transaction: FabricTransactionHandle = {
              getTransactionId: () => transactionId,
              submit: async (): Promise<FabricSubmittedTransaction> => {
                if (this.scenario.submitError) throw this.scenario.submitError;
                return {
                  getTransactionId: () => transactionId,
                  getResult: () => new Uint8Array(),
                  getStatus: async () => {
                    if (this.scenario.commitStatusError) throw this.scenario.commitStatusError;
                    return (
                      this.scenario.commitStatus ?? {
                        blockNumber: 0n,
                        code: 0,
                        successful: false,
                        transactionId,
                      }
                    );
                  },
                };
              },
            };
            return transaction;
          },
        };
        return proposal;
      },
    };

    const network: FabricNetworkHandle = {
      getName: () => 'ubtl-channel',
      getContract: () => contract,
    };

    // `options` is intentionally unused by the double, but the adapter must
    // still have supplied a complete identity/signer/tls hash for a real peer.
    if (!options.identity?.mspId || !options.tlsClientCertificateHash) {
      throw new Error('[TEST-DOUBLE] connect() received an incomplete identity or mTLS hash');
    }

    return {
      getNetwork: () => network,
      close: () => { this.gatewayCloseCount++; },
    };
  }
}

class StubFabricCredentialSource implements FabricCredentialSource {
  public loadCalls = 0;
  constructor(private readonly outcome: FabricCredentialMaterial | Error) {}
  load(): FabricCredentialMaterial {
    this.loadCalls++;
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }
}

function createFabricFixture(options?: Partial<FabricGatewayOptions>) {
  const connector = new FabricGatewayConnectorDouble();
  const credentialSource = new StubFabricCredentialSource(FABRIC_TEST_MATERIAL);
  const adapter = new FabricGatewayAdapter(
    { ...FABRIC_VALID_OPTIONS, ...(options ?? {}) },
    { connector, credentialSource, now: () => 1_000_000 }
  );
  return { adapter, connector, credentialSource };
}

function fabricSubmissionInput(
  overrides?: Partial<BlockchainSubmissionInput>
): BlockchainSubmissionInput {
  return {
    gatewayRequestId: 'gw-req-0001',
    correlationId: 'corr-0001',
    transactionType: 'SALE',
    payloadHash: 'a'.repeat(64),
    timestamp: '2026-10-24T00:00:00.000Z',
    idempotencyKey: 'idem-0001',
    ...(overrides ?? {}),
  };
}

registerTest('TC-FABRIC-01', 'FabricAdapter', 'Provider mode fails fast when mandatory Fabric parameters are missing', async () => {
  const connector = new FabricGatewayConnectorDouble();
  const credentialSource = new StubFabricCredentialSource(FABRIC_TEST_MATERIAL);
  const adapter = new FabricGatewayAdapter({}, { connector, credentialSource });

  if (adapter.mode !== 'provider') {
    throw new Error(`Adapter must report provider mode (never silently mock), got '${adapter.mode}'`);
  }

  let message = '';
  try {
    await adapter.initialize();
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }

  if (!message.includes('FABRIC_GATEWAY_PROVIDER_FAIL_FAST')) {
    throw new Error(`Expected the provider fail-fast marker in the error, got: ${message}`);
  }
  for (const param of [
    'peerEndpoint',
    'tlsCertPath',
    'clientCertPath',
    'clientKeyPath',
    'mspId',
    'channelName',
    'chaincodeName',
  ]) {
    if (!message.includes(param)) {
      throw new Error(`Fail-fast message did not identify the missing parameter '${param}': ${message}`);
    }
  }
  if (connector.loadSdkCalls !== 0) {
    throw new Error('SDK must not be loaded while provider configuration is incomplete');
  }
  if (credentialSource.loadCalls !== 0) {
    throw new Error('Credentials must not be read while provider configuration is incomplete');
  }
});

registerTest('TC-FABRIC-02', 'FabricAdapter', 'Missing or malformed credentials fail fast without leaking secret material', async () => {
  const connector = new FabricGatewayConnectorDouble();
  const credentialSource = new StubFabricCredentialSource(
    new FabricCredentialError(
      'FABRIC_CREDENTIAL_MISSING',
      '[FABRIC_GATEWAY_CREDENTIAL_FAIL_FAST] Missing mandatory credential setting FABRIC_GATEWAY_TLS_CERT_PATH.'
    )
  );
  const adapter = new FabricGatewayAdapter(FABRIC_VALID_OPTIONS, { connector, credentialSource });

  let error: unknown = null;
  try {
    await adapter.initialize();
  } catch (err) {
    error = err;
  }

  if (!(error instanceof FabricCredentialError)) {
    throw new Error('Expected a FabricCredentialError to propagate out of initialize()');
  }
  if (error.code !== 'FABRIC_CREDENTIAL_MISSING') {
    throw new Error(`Unexpected credential error code: ${error.code}`);
  }
  if (!error.message.includes('FABRIC_GATEWAY_TLS_CERT_PATH')) {
    throw new Error('Credential error must name the offending environment variable');
  }
  if (error.message.includes('KEY-DOUBLE') || error.message.includes('CERT-DOUBLE')) {
    throw new Error('Credential error leaked file contents into its message');
  }
  if (adapter.mode !== 'provider') {
    throw new Error('Adapter must remain in provider mode; it must never silently fall back to mock');
  }
  if (connector.loadSdkCalls !== 0) {
    throw new Error('SDK must not be loaded when credentials are unavailable');
  }
});

registerTest('TC-FABRIC-03', 'FabricAdapter', 'Adapter initialization fails explicitly when the Fabric SDK is unavailable', async () => {
  const { adapter, connector } = createFabricFixture();
  connector.sdkError = new Error('[FABRIC_GATEWAY_SDK_UNAVAILABLE] the client package is missing');

  let message = '';
  try {
    await adapter.initialize();
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }

  if (!message.includes('FABRIC_GATEWAY_INIT_FAILED')) {
    throw new Error(`Expected an explicit initialization failure marker, got: ${message}`);
  }
  if (!message.includes('FABRIC_GATEWAY_SDK_UNAVAILABLE')) {
    throw new Error(`Expected the SDK-unavailable reason to be preserved, got: ${message}`);
  }
  if (connector.createGrpcClientCalls !== 0) {
    throw new Error('A gRPC channel must not be created when the SDK is unavailable');
  }

  const health = await adapter.healthCheck();
  if (health.status !== 'offline') {
    throw new Error(`Expected offline health after a failed init, got '${health.status}'`);
  }
  if (health.mode !== 'provider' || health.isSimulated) {
    throw new Error('Provider adapter must never degrade to a simulated mock health state');
  }
});

registerTest('TC-FABRIC-04', 'FabricAdapter', 'Proposal submission yields PENDING with a provider-assigned transaction ID', async () => {
  const { adapter, connector } = createFabricFixture();
  connector.scenario = { transactionId: 'fabric-double-tx-9001' };
  await adapter.initialize();

  const input = fabricSubmissionInput();
  const result = await adapter.submitProposal(input);

  if (!result.accepted) {
    throw new Error('Expected the endorsed proposal to be accepted');
  }
  if (result.status !== 'PENDING') {
    throw new Error(`Submission acknowledgement must be PENDING, got '${result.status}'`);
  }
  if (result.fabricTransactionId !== 'fabric-double-tx-9001') {
    throw new Error(`Provider transaction ID was not mapped through: ${result.fabricTransactionId}`);
  }
  if (result.isSimulated === true) {
    throw new Error('Provider-mode results must never be marked as simulated');
  }
  if (result.fabricTransactionId === input.gatewayRequestId) {
    throw new Error('The Fabric transaction ID must be distinct from the UBTL gateway request ID');
  }
  if (result.fabricTransactionId === input.idempotencyKey) {
    throw new Error('The Fabric transaction ID must be distinct from the UBTL idempotency key');
  }
  if ('blockNumber' in result) {
    throw new Error('A submission acknowledgement must not carry a block number');
  }
});

registerTest('TC-FABRIC-05', 'FabricAdapter', 'Ledger arguments carry integrity metadata only and preserve the UBTL anchors', async () => {
  const { adapter, connector } = createFabricFixture();
  await adapter.initialize();

  const input = fabricSubmissionInput({
    payloadHash: 'b'.repeat(64),
    transactionType: 'SALE',
    correlationId: 'corr-ledger-args',
    timestamp: '2026-10-24T01:02:03.000Z',
    gatewayRequestId: 'gw-req-ledger-args',
    idempotencyKey: 'idem-ledger-args',
  });
  await adapter.submitProposal(input);

  if (connector.proposals.length !== 1) {
    throw new Error(`Expected exactly one proposal, got ${connector.proposals.length}`);
  }
  const { name, args } = connector.proposals[0];
  if (name !== DEFAULT_FABRIC_CHAINCODE_FUNCTIONS.submitTransactionProposal) {
    throw new Error(`Unexpected chaincode submit function '${name}'`);
  }

  // Contract (order pinned deliberately): payload hash, type, correlation,
  // timestamp, gateway request ID, idempotency key. Nothing else goes on-chain.
  const expected = [
    'b'.repeat(64),
    'SALE',
    'corr-ledger-args',
    '2026-10-24T01:02:03.000Z',
    'gw-req-ledger-args',
    'idem-ledger-args',
  ];
  if (args.length !== expected.length) {
    throw new Error(`Expected ${expected.length} ledger arguments, got ${args.length}`);
  }
  expected.forEach((value, index) => {
    if (args[index] !== value) {
      throw new Error(`Ledger argument ${index} mismatch: expected '${value}', got '${String(args[index])}'`);
    }
  });
});

registerTest('TC-FABRIC-06', 'FabricAdapter', 'A permanent endorsement rejection is FAILED and never committed', async () => {
  const { adapter, connector } = createFabricFixture();
  connector.scenario = {
    endorseError: { code: 9, message: 'ENDORSEMENT_POLICY_FAILURE: failed to collect enough endorsements' },
  };
  await adapter.initialize();

  const result = await adapter.submitProposal(fabricSubmissionInput());
  if (result.accepted !== false) {
    throw new Error('Expected the proposal to be rejected permanently');
  }
  if (result.status !== 'FAILED') {
    throw new Error(`Expected FAILED, got '${result.status}'`);
  }
  if (result.errorCode !== 'ENDORSEMENT_POLICY_FAILURE') {
    throw new Error(`Expected the ENDORSEMENT_POLICY_FAILURE code, got '${result.errorCode}'`);
  }
});

registerTest('TC-FABRIC-07', 'FabricAdapter', 'A transient provider error is surfaced for retry, not converted into a fabricated outcome', async () => {
  const { adapter, connector } = createFabricFixture();
  connector.scenario = { endorseError: new Error('connection reset by peer') };
  await adapter.initialize();

  let error: unknown = null;
  try {
    await adapter.submitProposal(fabricSubmissionInput());
  } catch (err) {
    error = err;
  }

  if (!error) {
    throw new Error('A transient provider error must be surfaced, not silently converted into a result');
  }
  const classified = classifyError(error);
  if (classified.classification !== 'TRANSIENT') {
    throw new Error(`Expected TRANSIENT classification, got '${classified.classification}'`);
  }
});

registerTest('TC-FABRIC-08', 'FabricAdapter', 'Verified commit evidence transitions to CONFIRMED with the real block number', async () => {
  const { adapter, connector } = createFabricFixture();
  connector.scenario = {
    transactionId: 'fabric-double-tx-commit',
    commitStatus: { blockNumber: 15421n, code: 0, successful: true, transactionId: 'fabric-double-tx-commit' },
  };
  await adapter.initialize();

  const submitted = await adapter.submitProposal(fabricSubmissionInput());
  const status = await adapter.queryCommitStatus(submitted.fabricTransactionId);

  if (status.status !== 'CONFIRMED') {
    throw new Error(`Expected CONFIRMED, got '${status.status}'`);
  }
  if (Number(status.blockNumber) !== 15421) {
    throw new Error(`Expected block 15421, got ${String(status.blockNumber)}`);
  }
  if (status.validationCode !== 0) {
    throw new Error(`Expected validation code 0 (VALID), got ${String(status.validationCode)}`);
  }
  if (status.isSimulated === true) {
    throw new Error('Provider-mode commit results must never be marked as simulated');
  }
});

registerTest('TC-FABRIC-09', 'FabricAdapter', 'An unsuccessful commit status is FAILED and never CONFIRMED', async () => {
  const { adapter, connector } = createFabricFixture();
  connector.scenario = {
    transactionId: 'fabric-double-tx-invalid',
    commitStatus: { blockNumber: 15422n, code: 10, successful: false, transactionId: 'fabric-double-tx-invalid' },
  };
  await adapter.initialize();

  const submitted = await adapter.submitProposal(fabricSubmissionInput());
  const status = await adapter.queryCommitStatus(submitted.fabricTransactionId);

  if (status.status !== 'FAILED') {
    throw new Error(`An unsuccessful commit status must be FAILED, got '${status.status}'`);
  }
  if (status.errorCode !== 'LEDGER_COMMIT_VALIDATION_FAILURE') {
    throw new Error(`Expected LEDGER_COMMIT_VALIDATION_FAILURE, got '${status.errorCode}'`);
  }
  if (status.validationCode !== 10) {
    throw new Error(`Expected the Fabric validation code 10 to be preserved, got ${String(status.validationCode)}`);
  }
});

registerTest('TC-FABRIC-10', 'FabricAdapter', 'A commit status without a block number is never CONFIRMED (Axiom 5)', async () => {
  const { adapter, connector } = createFabricFixture();
  connector.scenario = {
    transactionId: 'fabric-double-tx-noblock',
    commitStatus: { blockNumber: 0n, code: 0, successful: true, transactionId: 'fabric-double-tx-noblock' },
  };
  await adapter.initialize();

  const submitted = await adapter.submitProposal(fabricSubmissionInput());
  const status = await adapter.queryCommitStatus(submitted.fabricTransactionId);

  if (status.status === 'CONFIRMED') {
    throw new Error('Transaction was confirmed without a block number (Axiom 5 violation)');
  }
  if (status.status !== 'FAILED') {
    throw new Error(`An unusable commit status must be FAILED, got '${status.status}'`);
  }
});

registerTest('TC-FABRIC-11', 'FabricAdapter', 'A commit timeout is ambiguous and never FAILED or CONFIRMED', async () => {
  const { adapter, connector } = createFabricFixture();
  connector.scenario = {
    transactionId: 'fabric-double-tx-timeout',
    commitStatusError: { code: 4, message: 'DEADLINE_EXCEEDED: commit status deadline exceeded' },
  };
  await adapter.initialize();

  const submitted = await adapter.submitProposal(fabricSubmissionInput());
  const status = await adapter.queryCommitStatus(submitted.fabricTransactionId);

  if (status.status !== 'TIMEOUT') {
    throw new Error(`An unknown commit outcome must be reported as TIMEOUT, got '${status.status}'`);
  }
  if (status.errorCode !== 'COMMIT_TIMEOUT') {
    throw new Error(`Expected the COMMIT_TIMEOUT code, got '${status.errorCode}'`);
  }
  if (status.blockNumber !== undefined) {
    throw new Error('An ambiguous commit must not report a block number');
  }
});

registerTest('TC-FABRIC-12', 'FabricAdapter', 'Absent commit evidence is PENDING and no proof is fabricated', async () => {
  const { adapter, connector } = createFabricFixture();
  connector.evaluateHandler = () => null; // chaincode unavailable / no record
  await adapter.initialize();

  const status = await adapter.queryCommitStatus('fabric-tx-unknown-to-this-process');
  if (status.status !== 'PENDING') {
    throw new Error(`Absent evidence must be PENDING, got '${status.status}'`);
  }
  if (status.errorCode !== 'COMMIT_EVIDENCE_UNAVAILABLE') {
    throw new Error(`Expected COMMIT_EVIDENCE_UNAVAILABLE, got '${status.errorCode}'`);
  }
  if (status.blockNumber !== undefined) {
    throw new Error('PENDING must not carry a block number');
  }

  const proof = await adapter.getTransactionProof('fabric-tx-unknown-to-this-process');
  if (proof !== null) {
    throw new Error('A ledger proof must never be fabricated when no committed record exists');
  }
});

registerTest('TC-FABRIC-13', 'FabricAdapter', 'Reconciliation falls back to the documented chaincode query after a restart', async () => {
  const { adapter, connector } = createFabricFixture();
  const record = {
    fabricTransactionId: 'fabric-tx-recovered',
    payloadHash: 'c'.repeat(64),
    blockNumber: 16000,
    blockHash: 'block-hash-recovered',
    commitTimestamp: '2026-10-24T02:00:00.000Z',
    mspId: 'Org1MSP',
  };
  connector.evaluateHandler = (name) =>
    name === DEFAULT_FABRIC_CHAINCODE_FUNCTIONS.getCommitProof
      ? Buffer.from(JSON.stringify(record))
      : null;
  await adapter.initialize();

  const status = await adapter.queryCommitStatus('fabric-tx-recovered');
  if (status.status !== 'CONFIRMED') {
    throw new Error(`Expected CONFIRMED from the chaincode record, got '${status.status}'`);
  }
  if (Number(status.blockNumber) !== 16000) {
    throw new Error(`Expected block 16000, got ${String(status.blockNumber)}`);
  }

  const proof = await adapter.getTransactionProof('fabric-tx-recovered');
  if (!proof) {
    throw new Error('Expected an independent ledger proof from the chaincode record');
  }
  if (proof.payloadHash !== 'c'.repeat(64)) {
    throw new Error('Ledger proof payload hash does not match the on-chain record');
  }
  if (proof.blockHash !== 'block-hash-recovered') {
    throw new Error('Ledger proof block hash does not match the on-chain record');
  }
});

registerTest('TC-FABRIC-14', 'FabricAdapter', 'Reconciliation by UBTL request ID uses the dedicated chaincode query', async () => {
  const { adapter, connector } = createFabricFixture();
  const committed = {
    fabricTransactionId: 'fabric-tx-by-request',
    payloadHash: 'd'.repeat(64),
    blockNumber: '17000',
    blockHash: 'block-hash-by-request',
    commitTimestamp: '2026-10-24T03:00:00.000Z',
  };
  connector.evaluateHandler = (name, args) => {
    if (name !== DEFAULT_FABRIC_CHAINCODE_FUNCTIONS.queryTransactionByRequestId) return null;
    if (args[0] !== 'gw-req-committed') return null;
    return Buffer.from(JSON.stringify(committed));
  };
  await adapter.initialize();

  const found = await adapter.findTransactionByIdempotencyKey('gw-req-committed');
  if (!found) {
    throw new Error('Expected the committed record to be found by its UBTL request ID');
  }
  if (found.status !== 'CONFIRMED') {
    throw new Error(`Expected CONFIRMED, got '${found.status}'`);
  }
  if (found.fabricTransactionId !== 'fabric-tx-by-request') {
    throw new Error('The Fabric transaction ID was not adopted from the ledger record');
  }

  const missing = await adapter.findTransactionByIdempotencyKey('gw-req-unknown');
  if (missing !== null) {
    throw new Error('An unknown UBTL request ID must resolve to null, not to a fabricated status');
  }
});

registerTest('TC-FABRIC-15', 'FabricAdapter', 'Retries preserve the original UBTL request ID and idempotency key', async () => {
  const { adapter, connector } = createFabricFixture();
  await adapter.initialize();
  const input = fabricSubmissionInput({ gatewayRequestId: 'gw-req-retry', idempotencyKey: 'idem-retry' });

  await adapter.submitProposal(input);
  await adapter.submitProposal({ ...input }); // a retry of the same UBTL operation

  if (connector.proposals.length !== 2) {
    throw new Error(`Expected two proposals, got ${connector.proposals.length}`);
  }
  const first = connector.proposals[0].args;
  const second = connector.proposals[1].args;
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new Error('A retry altered the ledger arguments; the idempotency anchor was not preserved');
  }
  if (first[4] !== 'gw-req-retry') {
    throw new Error('The gateway request ID was not preserved across retries');
  }
  if (first[5] !== 'idem-retry') {
    throw new Error('The idempotency key was not preserved across retries');
  }
});

registerTest('TC-FABRIC-16', 'FabricAdapter', 'Provider errors map onto the transient/permanent/ambiguous taxonomy', async () => {
  for (const code of [3, 7, 9, 16]) {
    const { adapter, connector } = createFabricFixture();
    connector.scenario = { endorseError: { code, message: 'provider rejected the proposal' } };
    await adapter.initialize();
    const result = await adapter.submitProposal(fabricSubmissionInput());
    if (result.status !== 'FAILED') {
      throw new Error(`gRPC status ${code} must map to a permanent FAILED result, got '${result.status}'`);
    }
  }

  const transientFixture = createFabricFixture();
  transientFixture.connector.scenario = {
    endorseError: { code: 14, message: 'transport is unavailable' },
  };
  await transientFixture.adapter.initialize();
  let transientError: unknown = null;
  try {
    await transientFixture.adapter.submitProposal(fabricSubmissionInput());
  } catch (err) {
    transientError = err;
  }
  if (!transientError) {
    throw new Error('gRPC status 14 (UNAVAILABLE) must be retryable, not terminal');
  }
  if (classifyError(transientError).classification !== 'TRANSIENT') {
    throw new Error('gRPC status 14 must classify as TRANSIENT');
  }

  const ambiguousFixture = createFabricFixture();
  ambiguousFixture.connector.scenario = {
    endorseError: { code: 4, message: 'DEADLINE_EXCEEDED' },
  };
  await ambiguousFixture.adapter.initialize();
  let ambiguousError: unknown = null;
  try {
    await ambiguousFixture.adapter.submitProposal(fabricSubmissionInput());
  } catch (err) {
    ambiguousError = err;
  }
  if (!ambiguousError) {
    throw new Error('A provider deadline must be surfaced as ambiguous');
  }
  if (classifyError(ambiguousError).classification !== 'AMBIGUOUS') {
    throw new Error('A provider deadline must classify as AMBIGUOUS');
  }
});

registerTest('TC-FABRIC-17', 'FabricAdapter', 'Provider error messages are sanitized before they are surfaced', async () => {
  const { adapter, connector } = createFabricFixture();
  connector.scenario = { endorseError: new Error('rpc failure token=supersecretvalue') };
  await adapter.initialize();

  let thrown: unknown = null;
  try {
    await adapter.submitProposal(fabricSubmissionInput());
  } catch (err) {
    thrown = err;
  }
  if (!thrown) {
    throw new Error('Expected the transient error to be surfaced');
  }
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  if (message.includes('supersecretvalue')) {
    throw new Error('A secret value leaked into the surfaced error message');
  }
  if (!message.includes('[REDACTED]')) {
    throw new Error('Expected the offending value to be redacted');
  }

  const bearerFixture = createFabricFixture();
  bearerFixture.connector.scenario = {
    endorseError: new Error('rpc failure Bearer eyJhbGciOiJIUzI1NiJ9.payloadpart'),
  };
  await bearerFixture.adapter.initialize();
  let bearerThrown: unknown = null;
  try {
    await bearerFixture.adapter.submitProposal(fabricSubmissionInput());
  } catch (err) {
    bearerThrown = err;
  }
  if (!bearerThrown) {
    throw new Error('Expected the transient error to be surfaced');
  }
  const bearerMessage = bearerThrown instanceof Error ? bearerThrown.message : String(bearerThrown);
  if (bearerMessage.includes('eyJhbGciOiJIUzI1NiJ9')) {
    throw new Error('A bearer token leaked into the surfaced error message');
  }
});

registerTest('TC-FABRIC-18', 'FabricAdapter', 'Neither mock nor provider mode reports a commit without verified evidence', async () => {
  // Mock mode: the submission is explicitly simulated and remains PENDING.
  const mock = new MockBlockchainAdapter(60000, 0, 0);
  await mock.initialize();
  const mockSubmission = await mock.submitProposal(fabricSubmissionInput());
  if (mockSubmission.status !== 'PENDING') {
    throw new Error(`A mock submission must be PENDING, got '${mockSubmission.status}'`);
  }
  if (mockSubmission.isSimulated !== true) {
    throw new Error('Mock results must be explicitly identified as simulated');
  }
  const mockCommit = await mock.queryCommitStatus(mockSubmission.fabricTransactionId);
  if (mockCommit.status === 'CONFIRMED') {
    throw new Error('Mock mode confirmed a transaction before the simulated commit delay elapsed');
  }

  // Provider mode: no submission acknowledgement may carry a commit.
  const { adapter } = createFabricFixture();
  await adapter.initialize();
  const providerSubmission = await adapter.submitProposal(fabricSubmissionInput());
  if (providerSubmission.status !== 'PENDING' || providerSubmission.isSimulated === true) {
    throw new Error('Provider mode must return an explicit, non-simulated PENDING acknowledgement');
  }
});

registerTest('TC-FABRIC-19', 'FabricAdapter', 'Provider health is reported honestly and close() releases resources', async () => {
  const { adapter, connector } = createFabricFixture();
  await adapter.initialize();

  const health = await adapter.healthCheck();
  if (health.mode !== 'provider') {
    throw new Error(`Expected provider mode, got '${health.mode}'`);
  }
  if (health.isSimulated) {
    throw new Error('Provider health must not be marked as simulated');
  }
  if (health.status !== 'degraded') {
    throw new Error(`Unverified connectivity must be reported as degraded, got '${health.status}'`);
  }
  if (health.currentBlockHeight !== 0) {
    throw new Error(`Block height must never be fabricated, got ${health.currentBlockHeight}`);
  }
  if (health.latencyMs !== 0) {
    throw new Error(`Latency must never be fabricated, got ${health.latencyMs}`);
  }
  if (!health.peerEndpoint.includes('peer0.org1.ubtl.example.com')) {
    throw new Error('Health must report the configured peer endpoint');
  }

  adapter.close();
  if (connector.gatewayCloseCount !== 1) {
    throw new Error('close() must release the gateway connection');
  }
  if (connector.grpcCloseCount !== 1) {
    throw new Error('close() must release the gRPC transport');
  }
});

registerTest('TC-FABRIC-20', 'FabricAdapter', 'Environment validation fails fast on invalid provider-mode Fabric settings', async () => {
  const keys = [
    'BLOCKCHAIN_ADAPTER_MODE',
    'FABRIC_GATEWAY_PEER_ENDPOINT',
    'FABRIC_GATEWAY_TLS_CERT_PATH',
    'FABRIC_GATEWAY_CLIENT_CERT_PATH',
    'FABRIC_GATEWAY_CLIENT_KEY_PATH',
    'FABRIC_GATEWAY_MSP_ID',
    'FABRIC_GATEWAY_CHANNEL_NAME',
    'FABRIC_GATEWAY_CHAINCODE_NAME',
    'FABRIC_GATEWAY_COMMIT_TIMEOUT_SECONDS',
    'FABRIC_GATEWAY_DISCOVERY_AS_LOCALHOST',
  ];
  const saved = new Map<string, string | undefined>();
  for (const key of keys) saved.set(key, process.env[key]);

  try {
    process.env.BLOCKCHAIN_ADAPTER_MODE = 'provider';
    process.env.FABRIC_GATEWAY_PEER_ENDPOINT = 'peer0.org1.ubtl.example.com:7051';
    process.env.FABRIC_GATEWAY_TLS_CERT_PATH = '/secrets/ca.pem';
    process.env.FABRIC_GATEWAY_CLIENT_CERT_PATH = '/secrets/client.pem';
    process.env.FABRIC_GATEWAY_CLIENT_KEY_PATH = '/secrets/client-key.pem';
    process.env.FABRIC_GATEWAY_MSP_ID = 'Org1MSP';
    process.env.FABRIC_GATEWAY_CHANNEL_NAME = 'ubtl-channel';
    process.env.FABRIC_GATEWAY_CHAINCODE_NAME = 'ubtl-ledger';
    process.env.FABRIC_GATEWAY_COMMIT_TIMEOUT_SECONDS = 'not-a-number';
    process.env.FABRIC_GATEWAY_DISCOVERY_AS_LOCALHOST = 'yes';

    const validation = validateEnvironment();
    if (validation.isValid) {
      throw new Error('A provider-mode misconfiguration must fail environment validation');
    }
    const joined = validation.errors.join('\n');
    if (!joined.includes('FABRIC_GATEWAY_COMMIT_TIMEOUT_SECONDS')) {
      throw new Error('Missing commit-timeout validation error');
    }
    if (!joined.includes('FABRIC_GATEWAY_DISCOVERY_AS_LOCALHOST')) {
      throw new Error('Missing discovery-flag validation error');
    }

    delete process.env.FABRIC_GATEWAY_MSP_ID;
    const missingValidation = validateEnvironment();
    if (missingValidation.isValid) {
      throw new Error('A missing mandatory provider variable must fail validation');
    }
    if (!missingValidation.errors.some((e) => e.includes('FABRIC_GATEWAY_MSP_ID'))) {
      throw new Error('The missing MSP ID was not reported');
    }

    process.env.BLOCKCHAIN_ADAPTER_MODE = 'mock';
    delete process.env.FABRIC_GATEWAY_PEER_ENDPOINT;
    const mockValidation = validateEnvironment();
    if (!mockValidation.isValid) {
      throw new Error(
        `Mock mode must not require Fabric configuration: ${mockValidation.errors.join('; ')}`
      );
    }
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

registerTest('TC-FABRIC-21', 'FabricAdapter', 'LIVE Fabric network integration (opt-in; SKIPPED without a reachable network)', async () => {
  // This is the ONLY test here that would talk to a real Hyperledger Fabric
  // network. It is gated behind an explicit opt-in and the standard
  // FABRIC_GATEWAY_* environment variables. Without them it reports SKIP and no
  // live-Fabric claim is made. Set UBTL_FABRIC_LIVE_TEST=true plus the
  // FABRIC_GATEWAY_* variables to run it against an accessible network.
  if (process.env.UBTL_FABRIC_LIVE_TEST !== 'true') {
    return 'SKIP';
  }

  const required = [
    'FABRIC_GATEWAY_PEER_ENDPOINT',
    'FABRIC_GATEWAY_TLS_CERT_PATH',
    'FABRIC_GATEWAY_CLIENT_CERT_PATH',
    'FABRIC_GATEWAY_CLIENT_KEY_PATH',
    'FABRIC_GATEWAY_MSP_ID',
    'FABRIC_GATEWAY_CHANNEL_NAME',
    'FABRIC_GATEWAY_CHAINCODE_NAME',
  ];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `UBTL_FABRIC_LIVE_TEST=true but required Fabric variables are missing: ${missing.join(', ')}`
    );
  }

  const adapter = new FabricGatewayAdapter({
    peerEndpoint: process.env.FABRIC_GATEWAY_PEER_ENDPOINT,
    tlsCertPath: process.env.FABRIC_GATEWAY_TLS_CERT_PATH,
    clientCertPath: process.env.FABRIC_GATEWAY_CLIENT_CERT_PATH,
    clientKeyPath: process.env.FABRIC_GATEWAY_CLIENT_KEY_PATH,
    mspId: process.env.FABRIC_GATEWAY_MSP_ID,
    channelName: process.env.FABRIC_GATEWAY_CHANNEL_NAME,
    chaincodeName: process.env.FABRIC_GATEWAY_CHAINCODE_NAME,
    commitTimeoutSeconds: Number(process.env.FABRIC_GATEWAY_COMMIT_TIMEOUT_SECONDS || '30'),
    discoveryAsLocalhost: process.env.FABRIC_GATEWAY_DISCOVERY_AS_LOCALHOST === 'true',
  });

  try {
    await adapter.initialize();
    const health = await adapter.healthCheck();
    if (health.mode !== 'provider' || health.isSimulated) {
      throw new Error('The live provider adapter reported an invalid mode or a simulated health state');
    }
  } finally {
    adapter.close();
  }
});

// =========================================================================
// SUITE 11: SWITCHING WEBHOOK DISPATCHER (PROMPT 04)
// =========================================================================
// IMPORTANT: every webhook delivery in this suite uses a stubbed global
// `fetch` (an in-process test double). These are SIMULATED deliveries — no real
// Switching system is contacted and no result here may be described as a live
// Switching integration test.

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type StubFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<unknown>;

async function withStubbedFetch(impl: StubFetch, fn: () => Promise<void>): Promise<void> {
  const original = (globalThis as any).fetch;
  (globalThis as any).fetch = impl;
  try {
    await fn();
  } finally {
    (globalThis as any).fetch = original;
  }
}

interface WebhookContext {
  config: ReturnType<typeof loadConfig>;
  audit: AuditService;
  txService: TransactionsService;
  adapter: any;
  webhookService: WebhookService;
  outboxRepo: InMemoryOutboxRepository;
  worker: OutboxWorker;
  now: number;
}

function createWebhookContext(adapterOverrides: Record<string, unknown> = {}): WebhookContext {
  const config = loadConfig();
  const audit = new AuditService();
  const txService = new TransactionsService(audit);
  const adapter: any = {
    mode: 'mock',
    initialize: async () => {},
    submitProposal: async () => ({
      accepted: true,
      fabricTransactionId: 'sim-proposal',
      status: 'PENDING',
      isSimulated: true,
    }),
    queryCommitStatus: async (id: string) => ({
      fabricTransactionId: id,
      status: 'CONFIRMED',
      blockNumber: 4000,
      isSimulated: true,
    }),
    getTransactionProof: async () => null,
    healthCheck: async () => ({
      status: 'online',
      mode: 'mock',
      isSimulated: true,
      peerEndpoint: 'sim',
      channelName: 'sim',
      currentBlockHeight: 1,
      latencyMs: 0,
      details: 'simulated',
    }),
    ...adapterOverrides,
  };
  const webhookService = new WebhookService(config, audit);
  const outboxRepo = new InMemoryOutboxRepository();
  const worker = new OutboxWorker(config, outboxRepo, txService, adapter, webhookService, audit);
  const now = 1000000;
  worker.nowFn = () => now;
  return { config, audit, txService, adapter, webhookService, outboxRepo, worker, now };
}

async function seedCommittedWithWebhook(
  ctx: WebhookContext,
  status: string,
  suffix: string
): Promise<{ ingest: any; event: any }> {
  const ingest = await ctx.txService.ingest({
    correlationId: `corr-wh-${suffix}`,
    idempotencyKey: `idemp-wh-${suffix}`,
    transactionType: 'SALES',
    payload: { invoiceNumber: `INV-WH-${suffix}`, amount: '100.00', currency: 'IDR' },
    organizationId: 'org-webhook',
  });
  await ctx.txService.markSubmitted(ingest.gatewayRequestId, `sim-fabric-${suffix}`);
  await ctx.txService.markCommitted(ingest.gatewayRequestId, 1000);

  const event = ctx.outboxRepo.enqueueAtomic({
    transactionId: ingest.transaction.id,
    gatewayRequestId: ingest.gatewayRequestId,
    eventType: 'DELIVER_WEBHOOK',
    status: 'PENDING',
    payload: {
      gatewayRequestId: ingest.gatewayRequestId,
      correlationId: ingest.transaction.correlationId,
      status,
      blockchainTxHash: `sim-fabric-${suffix}`,
      errorMessage: null,
    },
    attemptCount: 0,
    attempts: 0,
    maxAttempts: ctx.config.switchingWebhookMaxRetries,
    nextAttemptAt: ctx.now,
    lockedAt: null,
    lockedBy: null,
    lastErrorCode: null,
    lastError: null,
    processedAt: null,
    deduplicationKey: `webhook:${status}:${ingest.transaction.id}`,
  });

  return { ingest, event };
}

registerTest('TC-WEBHOOK-01', 'WebhookDispatcher', 'Confirmed transaction enqueues a webhook only after the durable state transition', async () => {
  const ctx = createWebhookContext();
  const ingest = await ctx.txService.ingest({
    correlationId: 'corr-wh-01',
    idempotencyKey: 'idemp-wh-01',
    transactionType: 'SALES',
    payload: { invoiceNumber: 'INV-WH-01', amount: '10.00', currency: 'IDR' },
    organizationId: 'org-webhook',
  });

  // While the transaction is only durably accepted (not committed) no
  // confirmed webhook event may exist yet.
  if (ingest.transaction.lifecycleState !== 'OUTBOX_PENDING') {
    throw new Error(`Expected OUTBOX_PENDING before dispatch, got ${ingest.transaction.lifecycleState}`);
  }
  const premature = ctx.outboxRepo
    .getRecentEvents(50)
    .filter((e) => e.eventType === 'DELIVER_WEBHOOK' && (e.payload as any).status === 'confirmed');
  if (premature.length !== 0) {
    throw new Error('A confirmed webhook was enqueued before the commit transition was durably recorded');
  }

  // Drive the durable commit transition through the existing VERIFY_COMMIT path.
  ctx.outboxRepo.enqueueAtomic({
    transactionId: ingest.transaction.id,
    gatewayRequestId: ingest.gatewayRequestId,
    eventType: 'VERIFY_COMMIT',
    status: 'PENDING',
    payload: { fabricTransactionId: 'sim-fabric-wh-01' },
    attemptCount: 0,
    attempts: 0,
    maxAttempts: ctx.config.outboxMaxRetries,
    nextAttemptAt: ctx.now,
    lockedAt: null,
    lockedBy: null,
    lastErrorCode: null,
    lastError: null,
    processedAt: null,
    deduplicationKey: `verify:${ingest.transaction.id}`,
  });

  await ctx.worker.pollAndProcess();

  const tx = await ctx.txService.getById(ingest.gatewayRequestId);
  if (tx?.lifecycleState !== 'COMMITTED' || tx?.status !== 'confirmed') {
    throw new Error('Verified commit evidence did not advance the transaction to COMMITTED');
  }

  const confirmedWebhook = ctx.outboxRepo
    .getRecentEvents(50)
    .find((e) => e.eventType === 'DELIVER_WEBHOOK' && (e.payload as any).status === 'confirmed');
  if (!confirmedWebhook) {
    throw new Error('Confirmed webhook was not enqueued after the durable commit transition');
  }
  if ((confirmedWebhook.payload as any).gatewayRequestId !== ingest.gatewayRequestId) {
    throw new Error('Webhook event is not bound to the originating gateway request id');
  }
});

registerTest('TC-WEBHOOK-02', 'WebhookDispatcher', 'Webhook delivery succeeds and reports success (simulated HTTP 200)', async () => {
  const ctx = createWebhookContext();
  const { ingest, event } = await seedCommittedWithWebhook(ctx, 'confirmed', '02');

  let calledUrl = '';
  await withStubbedFetch(
    async (url) => {
      calledUrl = url;
      return { ok: true, status: 200, json: async () => ({ accepted: true }) };
    },
    async () => {
      await ctx.worker.pollAndProcess();
    }
  );

  if (!calledUrl.startsWith(ctx.config.switchingBaseUrl)) {
    throw new Error(`Webhook was delivered to an unexpected URL: ${calledUrl}`);
  }
  if (!calledUrl.endsWith(ctx.config.switchingWebhookEndpoint)) {
    throw new Error(`Webhook did not target the configured endpoint: ${calledUrl}`);
  }
  const evAfter = ctx.outboxRepo.findById(event.id);
  if (evAfter?.status !== 'COMPLETED') {
    throw new Error(`Expected COMPLETED after a successful simulated delivery, got ${evAfter?.status}`);
  }
  const metrics = ctx.webhookService.getDeliveryMetrics();
  if (metrics.successCount !== 1 || metrics.failureCount !== 0) {
    throw new Error(`Expected one successful delivery, got success=${metrics.successCount} failure=${metrics.failureCount}`);
  }
  const txAfter = await ctx.txService.getById(ingest.gatewayRequestId);
  if (txAfter?.lifecycleState !== 'COMMITTED') {
    throw new Error('Successful webhook delivery must not alter the committed ledger state');
  }
});

registerTest('TC-WEBHOOK-03', 'WebhookDispatcher', 'HTTP 5xx triggers a bounded retry (TRANSIENT)', async () => {
  const ctx = createWebhookContext();
  const { event } = await seedCommittedWithWebhook(ctx, 'confirmed', '03');

  await withStubbedFetch(
    async () => ({ ok: false, status: 503, json: async () => ({ error: 'unavailable' }) }),
    async () => {
      await ctx.worker.pollAndProcess();
    }
  );

  const evAfter = ctx.outboxRepo.findById(event.id);
  if (evAfter?.status !== 'RETRY_PENDING') {
    throw new Error(`Expected RETRY_PENDING after HTTP 503, got ${evAfter?.status}`);
  }
  if (evAfter?.lastErrorCode !== 'WEBHOOK_HTTP_503') {
    throw new Error(`Expected WEBHOOK_HTTP_503, got ${evAfter?.lastErrorCode}`);
  }
  if (ctx.webhookService.getDeliveryMetrics().retryableFailureCount !== 1) {
    throw new Error('HTTP 503 was not classified as a retryable (TRANSIENT) failure');
  }
});

registerTest('TC-WEBHOOK-04', 'WebhookDispatcher', 'Permanent HTTP 4xx follows the documented permanent-error policy', async () => {
  const ctx = createWebhookContext();
  const { event } = await seedCommittedWithWebhook(ctx, 'confirmed', '04');

  await withStubbedFetch(
    async () => ({ ok: false, status: 400, json: async () => ({ error: 'bad request' }) }),
    async () => {
      await ctx.worker.pollAndProcess();
    }
  );

  const evAfter = ctx.outboxRepo.findById(event.id);
  if (evAfter?.status !== 'DEAD_LETTER') {
    throw new Error(`Expected DEAD_LETTER for a permanent HTTP 400, got ${evAfter?.status}`);
  }
  if (evAfter?.lastErrorCode !== 'WEBHOOK_HTTP_400') {
    throw new Error(`Expected WEBHOOK_HTTP_400, got ${evAfter?.lastErrorCode}`);
  }
  if (ctx.webhookService.getDeliveryMetrics().permanentFailureCount !== 1) {
    throw new Error('HTTP 400 was not classified as a PERMANENT failure');
  }
});

registerTest('TC-WEBHOOK-05', 'WebhookDispatcher', 'A client timeout is classified safely as AMBIGUOUS and retried', async () => {
  const ctx = createWebhookContext();
  const { ingest, event } = await seedCommittedWithWebhook(ctx, 'confirmed', '05');

  await withStubbedFetch(
    async () => {
      const err: any = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    },
    async () => {
      await ctx.worker.pollAndProcess();
    }
  );

  const evAfter = ctx.outboxRepo.findById(event.id);
  if (evAfter?.status !== 'RETRY_PENDING') {
    throw new Error(`Expected RETRY_PENDING for an ambiguous timeout, got ${evAfter?.status}`);
  }
  if (evAfter?.lastErrorCode !== 'WEBHOOK_DELIVERY_TIMEOUT') {
    throw new Error(`Expected WEBHOOK_DELIVERY_TIMEOUT, got ${evAfter?.lastErrorCode}`);
  }
  if (ctx.webhookService.getDeliveryMetrics().ambiguousCount !== 1) {
    throw new Error('A client timeout was not classified as AMBIGUOUS');
  }
  const txAfter = await ctx.txService.getById(ingest.gatewayRequestId);
  if (txAfter?.lifecycleState !== 'COMMITTED') {
    throw new Error('An ambiguous webhook timeout must never alter the committed ledger state');
  }
});

registerTest('TC-WEBHOOK-06', 'WebhookDispatcher', 'Callback retry preserves the logical event identity and idempotency', async () => {
  const ctx = createWebhookContext();
  const { event } = await seedCommittedWithWebhook(ctx, 'confirmed', '06');
  const bodies: string[] = [];

  await withStubbedFetch(
    async (_url, init) => {
      bodies.push(init?.body || '');
      return { ok: false, status: 500, json: async () => ({}) };
    },
    async () => {
      await ctx.worker.pollAndProcess();
    }
  );
  let evAfter = ctx.outboxRepo.findById(event.id);
  if (evAfter?.status !== 'RETRY_PENDING') {
    throw new Error(`Expected RETRY_PENDING after the first failed attempt, got ${evAfter?.status}`);
  }

  // Advance the clock past the backoff and deliver again successfully.
  ctx.worker.nowFn = () => ctx.now + 120000;
  await withStubbedFetch(
    async (_url, init) => {
      bodies.push(init?.body || '');
      return { ok: true, status: 200, json: async () => ({}) };
    },
    async () => {
      await ctx.worker.pollAndProcess();
    }
  );
  evAfter = ctx.outboxRepo.findById(event.id);
  if (evAfter?.status !== 'COMPLETED') {
    throw new Error(`Expected COMPLETED after the retry succeeded, got ${evAfter?.status}`);
  }
  if (bodies.length !== 2) {
    throw new Error(`Expected exactly two delivery attempts, got ${bodies.length}`);
  }
  if (bodies[0] !== bodies[1]) {
    throw new Error('The webhook payload identity changed between delivery attempts');
  }
  if (evAfter?.attemptCount !== 2) {
    throw new Error(`Expected attemptCount 2 after the retry, got ${evAfter?.attemptCount}`);
  }
});

registerTest('TC-WEBHOOK-07', 'WebhookDispatcher', 'Duplicate initial webhook events are rejected by a durable deduplication constraint', async () => {
  const ctx = createWebhookContext();
  const { ingest } = await seedCommittedWithWebhook(ctx, 'confirmed', '07');

  let threw = false;
  try {
    ctx.outboxRepo.enqueueAtomic({
      transactionId: ingest.transaction.id,
      gatewayRequestId: ingest.gatewayRequestId,
      eventType: 'DELIVER_WEBHOOK',
      status: 'PENDING',
      payload: {
        gatewayRequestId: ingest.gatewayRequestId,
        correlationId: ingest.transaction.correlationId,
        status: 'confirmed',
        blockchainTxHash: 'sim-fabric-07',
        errorMessage: null,
      },
      attemptCount: 0,
      attempts: 0,
      maxAttempts: ctx.config.switchingWebhookMaxRetries,
      nextAttemptAt: ctx.now,
      lockedAt: null,
      lockedBy: null,
      lastErrorCode: null,
      lastError: null,
      processedAt: null,
      deduplicationKey: `webhook:confirmed:${ingest.transaction.id}`,
    });
  } catch {
    threw = true;
  }

  if (!threw) {
    throw new Error('A duplicate webhook event was accepted despite the deduplication key');
  }
  const count = ctx.outboxRepo
    .getRecentEvents(50)
    .filter((e) => e.eventType === 'DELIVER_WEBHOOK').length;
  if (count !== 1) {
    throw new Error(`Expected exactly one webhook event after the duplicate attempt, got ${count}`);
  }
});

registerTest('TC-WEBHOOK-08', 'WebhookDispatcher', 'A webhook failure never reverses a confirmed ledger commit', async () => {
  const ctx = createWebhookContext();
  const { ingest } = await seedCommittedWithWebhook(ctx, 'confirmed', '08');

  // Permanent 4xx → the webhook event is dead-lettered, but the ledger commit stands.
  await withStubbedFetch(
    async () => ({ ok: false, status: 422, json: async () => ({ error: 'unprocessable' }) }),
    async () => {
      await ctx.worker.pollAndProcess();
    }
  );

  const txAfter = await ctx.txService.getById(ingest.gatewayRequestId);
  if (txAfter?.lifecycleState !== 'COMMITTED' || txAfter?.status !== 'confirmed') {
    throw new Error('Webhook failure reversed the confirmed ledger commit');
  }
  if (txAfter?.blockNumber !== 1000) {
    throw new Error('Webhook failure altered the recorded block number');
  }
});

registerTest('TC-WEBHOOK-09', 'WebhookDispatcher', 'Stuck webhook events are safely recovered without touching ledger state', async () => {
  const ctx = createWebhookContext();
  const ingest = await ctx.txService.ingest({
    correlationId: 'corr-wh-09',
    idempotencyKey: 'idemp-wh-09',
    transactionType: 'SALES',
    payload: { invoiceNumber: 'INV-WH-09', amount: '9.00', currency: 'IDR' },
    organizationId: 'org-webhook',
  });
  await ctx.txService.markSubmitted(ingest.gatewayRequestId, 'sim-fabric-09');
  await ctx.txService.markCommitted(ingest.gatewayRequestId, 1000);

  const staleLock = ctx.now - (ctx.config.outboxStuckTimeoutMs + 20000);
  const event = ctx.outboxRepo.enqueueAtomic({
    transactionId: ingest.transaction.id,
    gatewayRequestId: ingest.gatewayRequestId,
    eventType: 'DELIVER_WEBHOOK',
    status: 'PROCESSING',
    payload: {
      gatewayRequestId: ingest.gatewayRequestId,
      correlationId: ingest.transaction.correlationId,
      status: 'confirmed',
      blockchainTxHash: 'sim-fabric-09',
      errorMessage: null,
    },
    attemptCount: 1,
    attempts: 1,
    maxAttempts: ctx.config.switchingWebhookMaxRetries,
    nextAttemptAt: staleLock,
    lockedAt: staleLock,
    lockedBy: 'worker-dead',
    lastErrorCode: null,
    lastError: null,
    processedAt: null,
    deduplicationKey: `webhook:confirmed:${ingest.transaction.id}`,
  });

  const recovered = await ctx.worker.recoverStuckEvents();
  if (recovered !== 1) {
    throw new Error(`Expected 1 recovered stuck event, got ${recovered}`);
  }
  const evAfter = ctx.outboxRepo.findById(event.id);
  if (evAfter?.status !== 'RETRY_PENDING') {
    throw new Error(`Stuck webhook event was not released for retry, got ${evAfter?.status}`);
  }
  const txAfter = await ctx.txService.getById(ingest.gatewayRequestId);
  if (txAfter?.lifecycleState !== 'COMMITTED' || txAfter?.blockNumber !== 1000) {
    throw new Error('Stuck webhook recovery altered the committed ledger state');
  }
  const actions = ctx.audit.getRecentLogs(50).map((l) => l.action);
  if (!actions.includes('STUCK_WEBHOOK_EVENT_RECOVERED')) {
    throw new Error('Stuck webhook recovery was not recorded in the audit trail');
  }
});

registerTest('TC-WEBHOOK-10', 'WebhookDispatcher', 'Graceful shutdown allows an in-flight delivery to complete', async () => {
  const ctx = createWebhookContext();
  const { event } = await seedCommittedWithWebhook(ctx, 'confirmed', '10');

  let release: (() => void) | null = null;
  const original = (globalThis as any).fetch;
  (globalThis as any).fetch = async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { ok: true, status: 200, json: async () => ({}) };
  };

  try {
    const pollPromise = ctx.worker.pollAndProcess();
    // Yield until the delivery is genuinely in flight (fetch invoked).
    for (let i = 0; i < 100 && release === null; i++) {
      await sleep(5);
    }
    if (release === null) {
      throw new Error('The in-flight webhook delivery never started');
    }
    const stopPromise = ctx.worker.stop(2000);
    (release as () => void)();
    await Promise.all([pollPromise, stopPromise]);
  } finally {
    (globalThis as any).fetch = original;
  }

  const evAfter = ctx.outboxRepo.findById(event.id);
  if (evAfter?.status !== 'COMPLETED') {
    throw new Error(`In-flight delivery did not complete during graceful shutdown (status=${evAfter?.status})`);
  }
  const afterStop = await ctx.worker.pollAndProcess();
  if (afterStop !== 0) {
    throw new Error('The worker claimed new events after shutdown began');
  }
});

registerTest('TC-WEBHOOK-11', 'WebhookDispatcher', 'Webhook aggregate metrics report queue state and delivery outcomes', async () => {
  const ctx = createWebhookContext();
  const pendingIngest = await ctx.txService.ingest({
    correlationId: 'corr-wh-11a',
    idempotencyKey: 'idemp-wh-11a',
    transactionType: 'SALES',
    payload: { invoiceNumber: 'INV-WH-11a', amount: '1.00', currency: 'IDR' },
    organizationId: 'org-webhook',
  });
  ctx.outboxRepo.enqueueAtomic({
    transactionId: pendingIngest.transaction.id,
    gatewayRequestId: pendingIngest.gatewayRequestId,
    eventType: 'DELIVER_WEBHOOK',
    status: 'PENDING',
    payload: { status: 'confirmed' },
    attemptCount: 0,
    attempts: 0,
    maxAttempts: 5,
    nextAttemptAt: ctx.now - 5000,
    lockedAt: null,
    lockedBy: null,
    lastErrorCode: null,
    lastError: null,
    processedAt: null,
    deduplicationKey: 'webhook:confirmed:wh-11a',
  });
  ctx.outboxRepo.enqueueAtomic({
    transactionId: 'tx-wh-11b',
    gatewayRequestId: 'gw-wh-11b',
    eventType: 'DELIVER_WEBHOOK',
    status: 'DEAD_LETTER',
    payload: { status: 'failed' },
    attemptCount: 5,
    attempts: 5,
    maxAttempts: 5,
    nextAttemptAt: ctx.now,
    lockedAt: null,
    lockedBy: null,
    lastErrorCode: 'WEBHOOK_HTTP_400',
    lastError: 'permanent failure',
    processedAt: null,
    deduplicationKey: 'webhook:failed:tx-wh-11b',
  });

  const metrics: any = await ctx.worker.getWebhookMetrics();
  if (metrics.pendingCount !== 1) {
    throw new Error(`Expected pendingCount 1, got ${metrics.pendingCount}`);
  }
  if (metrics.deadLetterCount !== 1) {
    throw new Error(`Expected deadLetterCount 1, got ${metrics.deadLetterCount}`);
  }
  if (!(metrics.oldestPendingAgeMs > 0)) {
    throw new Error('Expected a positive oldest pending webhook age');
  }
  if (!('lastSuccessAt' in metrics) || !('lastAttemptAt' in metrics)) {
    throw new Error('Webhook metrics must expose lastSuccessful/lastAttempt timestamps');
  }
  if (typeof metrics.config !== 'undefined') {
    throw new Error('Webhook metrics must not leak configuration objects');
  }
});

registerTest('TC-WEBHOOK-12', 'WebhookDispatcher', 'Secrets are redacted from webhook error text and log payloads', async () => {
  const secret = 'switching_super_secret_key_123';
  const raw = `Webhook connection failure: dial failed key=${secret}&token=abc123xyz`;
  const redacted = redactSecrets(raw);
  if (redacted.includes(secret)) {
    throw new Error('redactSecrets failed to remove a key-shaped secret');
  }
  if (!redacted.includes('[REDACTED]')) {
    throw new Error('redactSecrets did not mark the redacted region');
  }

  const sanitized: any = sanitizeForLog({
    authorization: `Bearer ${secret}`,
    apiKey: secret,
    note: raw,
    nested: { password: 'p@ssw0rd' },
  });
  const serialized = JSON.stringify(sanitized);
  if (serialized.includes(secret) || serialized.includes('p@ssw0rd')) {
    throw new Error('sanitizeForLog failed to redact nested sensitive values');
  }
  if (sanitized.authorization !== '[REDACTED]' || sanitized.apiKey !== '[REDACTED]') {
    throw new Error('Sensitive keys were not replaced with the redaction marker');
  }
});

registerTest('TC-WEBHOOK-13', 'WebhookDispatcher', 'A dead receiver (connection refused) is transient and retried within the configured policy', async () => {
  const ctx = createWebhookContext();
  const { ingest, event } = await seedCommittedWithWebhook(ctx, 'confirmed', '13');

  await withStubbedFetch(
    async () => {
      // undici surfaces a refused/unreachable TCP connection as `TypeError: fetch failed`.
      throw new TypeError('fetch failed');
    },
    async () => {
      await ctx.worker.pollAndProcess();
    }
  );

  const evAfter = ctx.outboxRepo.findById(event.id);
  if (evAfter?.status !== 'RETRY_PENDING') {
    throw new Error(`Expected RETRY_PENDING for a dead receiver, got ${evAfter?.status}`);
  }
  if (evAfter?.lastErrorCode !== 'WEBHOOK_CONNECTION_FAILURE') {
    throw new Error(`Expected WEBHOOK_CONNECTION_FAILURE, got ${evAfter?.lastErrorCode}`);
  }
  if (evAfter?.attemptCount !== 1) {
    throw new Error(`Expected attemptCount 1 after the first failed attempt, got ${evAfter?.attemptCount}`);
  }
  if (!(evAfter.nextAttemptAt > ctx.now)) {
    throw new Error('A retryable connection failure must schedule the next attempt in the future');
  }
  if (ctx.webhookService.getDeliveryMetrics().retryableFailureCount !== 1) {
    throw new Error('A connection failure was not classified as a retryable (TRANSIENT) failure');
  }
  // A dead webhook receiver must never change the ledger's committed state.
  const txAfter = await ctx.txService.getById(ingest.gatewayRequestId);
  if (txAfter?.lifecycleState !== 'COMMITTED' || txAfter?.status !== 'confirmed') {
    throw new Error('A dead webhook receiver altered the committed ledger state');
  }
});

registerTest('TC-WEBHOOK-14', 'WebhookDispatcher', 'Exhausted retries dead-letter the webhook event and the record is retained (never reset) for reconciliation', async () => {
  const ctx = createWebhookContext();
  const maxAttempts = ctx.config.switchingWebhookMaxRetries;
  const ingest = await ctx.txService.ingest({
    correlationId: 'corr-wh-14',
    idempotencyKey: 'idemp-wh-14',
    transactionType: 'SALES',
    payload: { invoiceNumber: 'INV-WH-14', amount: '14.00', currency: 'IDR' },
    organizationId: 'org-webhook',
  });
  await ctx.txService.markSubmitted(ingest.gatewayRequestId, 'sim-fabric-14');
  await ctx.txService.markCommitted(ingest.gatewayRequestId, 1000);

  // Event already one attempt short of the configured retry limit.
  const event = ctx.outboxRepo.enqueueAtomic({
    transactionId: ingest.transaction.id,
    gatewayRequestId: ingest.gatewayRequestId,
    eventType: 'DELIVER_WEBHOOK',
    status: 'PENDING',
    payload: {
      gatewayRequestId: ingest.gatewayRequestId,
      correlationId: ingest.transaction.correlationId,
      status: 'confirmed',
      blockchainTxHash: 'sim-fabric-14',
      errorMessage: null,
    },
    attemptCount: maxAttempts - 1,
    attempts: maxAttempts - 1,
    maxAttempts,
    nextAttemptAt: ctx.now,
    lockedAt: null,
    lockedBy: null,
    lastErrorCode: null,
    lastError: null,
    processedAt: null,
    deduplicationKey: `webhook:confirmed:${ingest.transaction.id}`,
  });

  await withStubbedFetch(
    async () => {
      throw new TypeError('fetch failed');
    },
    async () => {
      await ctx.worker.pollAndProcess();
    }
  );

  let evAfter = ctx.outboxRepo.findById(event.id);
  if (evAfter?.status !== 'DEAD_LETTER') {
    throw new Error(`Expected DEAD_LETTER once the configured retry policy is exhausted, got ${evAfter?.status}`);
  }
  if (evAfter?.attemptCount !== maxAttempts) {
    throw new Error(`Expected attemptCount ${maxAttempts} at exhaustion, got ${evAfter?.attemptCount}`);
  }
  if (!evAfter?.lastError?.includes('Exhausted')) {
    throw new Error(`Dead-letter must record the configured retry limit; got "${evAfter?.lastError}"`);
  }

  // Retention: a further poll must neither re-claim nor reset the dead-letter record.
  const claimedAfter = await ctx.worker.pollAndProcess();
  evAfter = ctx.outboxRepo.findById(event.id);
  if (claimedAfter !== 0) {
    throw new Error(`A dead-lettered event must not be re-claimed, but the worker claimed ${claimedAfter}`);
  }
  if (evAfter?.status !== 'DEAD_LETTER') {
    throw new Error(`The dead-letter record was reset to ${evAfter?.status}`);
  }
  if (evAfter?.lastErrorCode !== 'WEBHOOK_CONNECTION_FAILURE') {
    throw new Error('The dead-letter record lost its original error code');
  }

  // Identifiable + reconcilable: the failure is visible in the webhook queue metrics.
  const metrics: any = await ctx.worker.getWebhookMetrics();
  if (metrics.deadLetterCount !== 1) {
    throw new Error(`Expected deadLetterCount 1 for operator reconciliation, got ${metrics.deadLetterCount}`);
  }
  if (metrics.lastErrorCode !== 'WEBHOOK_CONNECTION_FAILURE') {
    throw new Error(`Metrics must expose the last dead-letter error code, got ${metrics.lastErrorCode}`);
  }

  // The ledger remains committed: webhook delivery is a side channel only.
  const txAfter = await ctx.txService.getById(ingest.gatewayRequestId);
  if (txAfter?.lifecycleState !== 'COMMITTED' || txAfter?.blockNumber !== 1000) {
    throw new Error('Dead-lettering a webhook event altered the committed ledger state');
  }
});

registerTest('TC-WEBHOOK-15', 'WebhookDispatcher', 'Redelivery of the same logical event is idempotent and never creates a duplicate transaction', async () => {
  const ctx = createWebhookContext();
  const { ingest, event } = await seedCommittedWithWebhook(ctx, 'confirmed', '15');

  // First delivery succeeds.
  await withStubbedFetch(
    async () => ({ ok: true, status: 200, json: async () => ({ accepted: true }) }),
    async () => {
      await ctx.worker.pollAndProcess();
    }
  );
  const evAfter = ctx.outboxRepo.findById(event.id);
  if (evAfter?.status !== 'COMPLETED') {
    throw new Error(`Expected COMPLETED after a successful delivery, got ${evAfter?.status}`);
  }

  // A re-enqueue of the same logical event (same (status, transactionId) dedup key)
  // must be refused: redelivery may not create a second outbox event.
  let duplicateRejected = false;
  try {
    ctx.outboxRepo.enqueueAtomic({
      transactionId: ingest.transaction.id,
      gatewayRequestId: ingest.gatewayRequestId,
      eventType: 'DELIVER_WEBHOOK',
      status: 'PENDING',
      payload: {
        gatewayRequestId: ingest.gatewayRequestId,
        correlationId: ingest.transaction.correlationId,
        status: 'confirmed',
        blockchainTxHash: 'sim-fabric-15',
        errorMessage: null,
      },
      attemptCount: 0,
      attempts: 0,
      maxAttempts: ctx.config.switchingWebhookMaxRetries,
      nextAttemptAt: ctx.now,
      lockedAt: null,
      lockedBy: null,
      lastErrorCode: null,
      lastError: null,
      processedAt: null,
      deduplicationKey: `webhook:confirmed:${ingest.transaction.id}`,
    });
  } catch {
    duplicateRejected = true;
  }
  if (!duplicateRejected) {
    throw new Error('Redelivery was allowed to create a duplicate webhook event');
  }

  const webhookEvents = ctx.outboxRepo
    .getRecentEvents(50)
    .filter((e) => e.eventType === 'DELIVER_WEBHOOK');
  if (webhookEvents.length !== 1) {
    throw new Error(`Expected exactly one webhook event after redelivery, got ${webhookEvents.length}`);
  }

  const transactions = await ctx.txService.getAll(100);
  const matching = transactions.filter((t) => t.gatewayRequestId === ingest.gatewayRequestId);
  if (matching.length !== 1) {
    throw new Error(`Redelivery produced ${matching.length} transactions for the same request; expected 1`);
  }
});

// =========================================================================
// SUITE 12: RECONCILIATION JOB (PROMPT 04)
// =========================================================================
// Adapter evidence is provided by in-process test doubles. No real Hyperledger
// Fabric network is contacted; results are SIMULATED and prove only that the
// reconciliation LOGIC refuses to fabricate commit evidence.

interface ReconContext {
  config: ReturnType<typeof loadConfig>;
  audit: AuditService;
  txService: TransactionsService;
  adapter: any;
  service: ReconciliationService;
}

function createReconContext(
  adapterOverrides: Record<string, unknown> = {},
  lock?: SingleProcessReconciliationLock
): ReconContext {
  const config = loadConfig();
  const audit = new AuditService();
  const txService = new TransactionsService(audit);
  const adapter: any = {
    mode: 'mock',
    initialize: async () => {},
    submitProposal: async () => ({
      accepted: true,
      fabricTransactionId: 'sim-proposal',
      status: 'PENDING',
      isSimulated: true,
    }),
    queryCommitStatus: async (id: string) => ({
      fabricTransactionId: id,
      status: 'PENDING',
      isSimulated: true,
    }),
    getTransactionProof: async () => null,
    healthCheck: async () => ({
      status: 'online',
      mode: 'mock',
      isSimulated: true,
      peerEndpoint: 'sim',
      channelName: 'sim',
      currentBlockHeight: 1,
      latencyMs: 0,
      details: 'simulated',
    }),
    ...adapterOverrides,
  };
  const service = lock
    ? new ReconciliationService(config, txService, adapter, audit, lock)
    : new ReconciliationService(config, txService, adapter, audit);
  return { config, audit, txService, adapter, service };
}

async function seedReconciliationRequired(ctx: ReconContext, suffix: string): Promise<any> {
  const ingest = await ctx.txService.ingest({
    correlationId: `corr-rc-${suffix}`,
    idempotencyKey: `idemp-rc-${suffix}`,
    transactionType: 'SALES',
    payload: { invoiceNumber: `INV-RC-${suffix}`, amount: '9.99', currency: 'IDR' },
    organizationId: 'org-recon',
  });
  await ctx.txService.markSubmitted(ingest.gatewayRequestId, `sim-fabric-rc-${suffix}`);
  await ctx.txService.markTimeout(ingest.gatewayRequestId, 'Commit timeout awaiting reconciliation');
  return ingest;
}

registerTest('TC-RECON-01', 'Reconciliation', 'Reconciliation confirms only with verified adapter commit evidence', async () => {
  const ctx = createReconContext({
    findTransactionByIdempotencyKey: async (gatewayRequestId: string) => ({
      fabricTransactionId: 'sim-fabric-rc-01',
      status: 'CONFIRMED',
      blockNumber: 8801,
      commitTimestamp: new Date().toISOString(),
      isSimulated: true,
    }),
  });
  const ingest = await seedReconciliationRequired(ctx, '01');

  const result = await ctx.service.runReconciliation();
  if (result.confirmed !== 1 || result.inconclusive !== 0 || result.failed !== 0) {
    throw new Error(`Expected exactly one confirmed, got confirmed=${result.confirmed} inconclusive=${result.inconclusive}`);
  }
  const tx = await ctx.txService.getById(ingest.gatewayRequestId);
  if (tx?.lifecycleState !== 'COMMITTED' || tx?.blockNumber !== 8801) {
    throw new Error('Verified evidence did not advance the transaction to COMMITTED with the block number');
  }
  const record = (await ctx.service.getRecords('CONFIRMED'))[0];
  if (!record || record.evidenceSource !== 'adapter_request_id_query') {
    throw new Error('Confirmed record did not cite the request-id evidence source');
  }
});

registerTest('TC-RECON-02', 'Reconciliation', 'A CONFIRMED status without a positive block number is never treated as committed', async () => {
  const ctx = createReconContext({
    findTransactionByIdempotencyKey: async () => ({
      fabricTransactionId: 'sim-fabric-rc-02',
      status: 'CONFIRMED',
      isSimulated: true,
    }),
  });
  const ingest = await seedReconciliationRequired(ctx, '02');

  const result = await ctx.service.runReconciliation();
  if (result.confirmed !== 0 || result.inconclusive !== 1) {
    throw new Error(`Expected an inconclusive outcome, got confirmed=${result.confirmed} inconclusive=${result.inconclusive}`);
  }
  const tx = await ctx.txService.getById(ingest.gatewayRequestId);
  if (tx?.lifecycleState === 'COMMITTED' || tx?.lifecycleState !== 'RECONCILIATION_REQUIRED') {
    throw new Error('A CONFIRMED status without a block number must not advance the transaction to COMMITTED');
  }
  const record = (await ctx.service.getRecords('INCONCLUSIVE'))[0];
  if (!record || record.ledgerStatus !== 'CONFIRMED') {
    throw new Error('Inconclusive record did not preserve the observed ledger status');
  }
});

registerTest('TC-RECON-03', 'Reconciliation', 'Reconciliation preserves RECONCILIATION_REQUIRED when no provider evidence exists', async () => {
  const ctx = createReconContext();
  const ingest = await ctx.txService.ingest({
    correlationId: 'corr-rc-03',
    idempotencyKey: 'idemp-rc-03',
    transactionType: 'SALES',
    payload: { invoiceNumber: 'INV-RC-03', amount: '3.00', currency: 'IDR' },
    organizationId: 'org-recon',
  });
  await ctx.txService.markTimeout(ingest.gatewayRequestId, 'Ambiguous timeout');

  const result = await ctx.service.runReconciliation();
  if (result.inconclusive !== 1 || result.confirmed !== 0 || result.failed !== 0) {
    throw new Error(`Expected exactly one inconclusive result, got ${JSON.stringify(result)}`);
  }
  const tx = await ctx.txService.getById(ingest.gatewayRequestId);
  if (tx?.lifecycleState !== 'RECONCILIATION_REQUIRED' || tx?.status !== 'timeout') {
    throw new Error('Inconclusive reconciliation must preserve RECONCILIATION_REQUIRED');
  }
  const record = (await ctx.service.getRecords('INCONCLUSIVE'))[0];
  if (!record || record.evidenceSource !== null) {
    throw new Error('Inconclusive record must state that no evidence source was available');
  }
});

registerTest('TC-RECON-04', 'Reconciliation', 'Restart recovery does not fabricate Fabric commit evidence', async () => {
  const ctx = createReconContext({
    findTransactionByIdempotencyKey: async () => null,
    queryCommitStatus: async () => {
      throw new Error('Commit status is only available from a same-process SubmittedTransaction');
    },
  });
  const ingest = await seedReconciliationRequired(ctx, '04');

  const result = await ctx.service.runReconciliation();
  if (result.confirmed !== 0 || result.inconclusive !== 1) {
    throw new Error(`Restart recovery must be inconclusive, got confirmed=${result.confirmed}`);
  }
  const tx = await ctx.txService.getById(ingest.gatewayRequestId);
  if (tx?.lifecycleState === 'COMMITTED' || tx?.blockNumber !== null) {
    throw new Error('Restart recovery fabricated commit evidence that the provider did not supply');
  }
  if (tx?.lifecycleState !== 'RECONCILIATION_REQUIRED') {
    throw new Error('Restart recovery must preserve RECONCILIATION_REQUIRED');
  }
});

registerTest('TC-RECON-05', 'Reconciliation', 'Concurrent reconciliation runs do not duplicate unsafe work', async () => {
  const config = loadConfig();
  const audit = new AuditService();
  const txService = new TransactionsService(audit);
  const sharedLock = new SingleProcessReconciliationLock();

  let callsA = 0;
  const adapterA: any = {
    mode: 'mock',
    initialize: async () => {},
    submitProposal: async () => ({ accepted: true, fabricTransactionId: 's', status: 'PENDING' }),
    queryCommitStatus: async (id: string) => ({ fabricTransactionId: id, status: 'PENDING' }),
    getTransactionProof: async () => null,
    healthCheck: async () => ({
      status: 'online',
      mode: 'mock',
      isSimulated: true,
      peerEndpoint: 'sim',
      channelName: 'sim',
      currentBlockHeight: 1,
      latencyMs: 0,
      details: 'simulated',
    }),
    findTransactionByIdempotencyKey: async () => {
      callsA++;
      await sleep(30);
      return null;
    },
  };
  const adapterB: any = {
    ...adapterA,
    findTransactionByIdempotencyKey: async () => {
      throw new Error('A skipped overlapping run must never query the provider');
    },
  };

  const svcA = new ReconciliationService(config, txService, adapterA, audit, sharedLock);
  const svcB = new ReconciliationService(config, txService, adapterB, audit, sharedLock);

  const ingest = await txService.ingest({
    correlationId: 'corr-rc-05',
    idempotencyKey: 'idemp-rc-05',
    transactionType: 'SALES',
    payload: { invoiceNumber: 'INV-RC-05', amount: '5.00', currency: 'IDR' },
    organizationId: 'org-recon',
  });
  await txService.markSubmitted(ingest.gatewayRequestId, 'sim-fabric-rc-05');
  await txService.markTimeout(ingest.gatewayRequestId, 'Commit timeout');

  const [ra, rb] = await Promise.all([svcA.runReconciliation(), svcB.runReconciliation()]);
  const skipped = [ra, rb].filter((r) => r.skipped).length;
  if (skipped !== 1) {
    throw new Error(`Expected exactly one skipped overlapping run, got ${skipped}`);
  }
  if (callsA !== 1) {
    throw new Error(`Expected a single provider query across both runs, got ${callsA}`);
  }
});

registerTest('TC-RECON-06', 'Reconciliation', 'Invalid reconciliation configuration fails fast', async () => {
  const saved = {
    RECONCILIATION_INTERVAL_MINUTES: process.env.RECONCILIATION_INTERVAL_MINUTES,
    RECONCILIATION_LOOKBACK_HOURS: process.env.RECONCILIATION_LOOKBACK_HOURS,
    RECONCILIATION_BATCH_SIZE: process.env.RECONCILIATION_BATCH_SIZE,
    RECONCILIATION_MAX_ATTEMPTS: process.env.RECONCILIATION_MAX_ATTEMPTS,
  };
  try {
    process.env.RECONCILIATION_INTERVAL_MINUTES = '-1';
    process.env.RECONCILIATION_LOOKBACK_HOURS = '0';
    process.env.RECONCILIATION_BATCH_SIZE = '0';
    process.env.RECONCILIATION_MAX_ATTEMPTS = '0';

    const validation = validateEnvironment();
    if (validation.isValid) {
      throw new Error('Invalid reconciliation configuration was accepted');
    }
    for (const name of [
      'RECONCILIATION_INTERVAL_MINUTES',
      'RECONCILIATION_LOOKBACK_HOURS',
      'RECONCILIATION_BATCH_SIZE',
      'RECONCILIATION_MAX_ATTEMPTS',
    ]) {
      if (!validation.errors.some((e) => e.includes(name))) {
        throw new Error(`Environment validation did not reject invalid ${name}`);
      }
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

registerTest('TC-RECON-07', 'Reconciliation', 'Reconciliation preserves the original gateway request id and idempotency key', async () => {
  const seenIds: string[] = [];
  const ctx = createReconContext({
    findTransactionByIdempotencyKey: async (gatewayRequestId: string) => {
      seenIds.push(gatewayRequestId);
      return {
        fabricTransactionId: 'sim-fabric-rc-07',
        status: 'CONFIRMED',
        blockNumber: 42,
        commitTimestamp: new Date().toISOString(),
      };
    },
  });
  const ingest = await seedReconciliationRequired(ctx, '07');

  await ctx.service.runReconciliation();

  if (seenIds.length !== 1 || seenIds[0] !== ingest.gatewayRequestId) {
    throw new Error('Reconciliation did not query the provider by the original gateway request id');
  }
  const tx = await ctx.txService.getById(ingest.gatewayRequestId);
  if (tx?.gatewayRequestId !== ingest.gatewayRequestId || tx?.idempotencyKey !== ingest.transaction.idempotencyKey) {
    throw new Error('Reconciliation changed the transaction identity');
  }
  if (tx?.lifecycleState !== 'COMMITTED') {
    throw new Error('Verified evidence did not advance the transaction to COMMITTED');
  }
});

registerTest('TC-RECON-08', 'Reconciliation', 'Reconciliation outcomes are auditable and sanitized (no secrets)', async () => {
  const ctx = createReconContext({
    findTransactionByIdempotencyKey: async () => {
      throw new Error('provider unavailable key=supersecretvalue');
    },
  });
  const ingest = await ctx.txService.ingest({
    correlationId: 'corr-rc-08',
    idempotencyKey: 'idemp-rc-08',
    transactionType: 'SALES',
    payload: { invoiceNumber: 'INV-RC-08', amount: '8.00', currency: 'IDR' },
    organizationId: 'org-recon',
  });
  await ctx.txService.markTimeout(ingest.gatewayRequestId, 'Ambiguous timeout');

  await ctx.service.runReconciliation();

  const record = (await ctx.service.getRecords())[0];
  if (!record || record.outcome !== 'INCONCLUSIVE') {
    throw new Error(`Expected an INCONCLUSIVE record, got ${record?.outcome}`);
  }
  if (record.sanitizedError === null) {
    throw new Error('Reconciliation record must include sanitized error information');
  }
  if (record.sanitizedError.includes('supersecretvalue')) {
    throw new Error('A secret leaked into the reconciliation record');
  }
  if (!record.sanitizedError.includes('[REDACTED]')) {
    throw new Error('Reconciliation error text was not redacted');
  }
  if (record.attemptNumber !== 1 || Number.isNaN(Date.parse(record.checkedAt))) {
    throw new Error('Reconciliation record is missing attempt/timestamp metadata');
  }
  const actions = ctx.audit.getRecentLogs(50).map((l) => l.action);
  if (!actions.includes('RECONCILIATION_INCONCLUSIVE')) {
    throw new Error('Reconciliation outcome was not recorded in the audit trail');
  }
});

registerTest('TC-RECON-09', 'Reconciliation', 'Reconciliation metrics expose run state, counts and configuration', async () => {
  const ctx = createReconContext({
    findTransactionByIdempotencyKey: async () => ({
      fabricTransactionId: 'sim-fabric-rc-09',
      status: 'CONFIRMED',
      blockNumber: 909,
      commitTimestamp: new Date().toISOString(),
    }),
  });
  await seedReconciliationRequired(ctx, '09');

  await ctx.service.runReconciliation();
  const metrics = await ctx.service.getMetrics();

  if (metrics.totalRuns !== 1 || metrics.totalConfirmed !== 1) {
    throw new Error(`Unexpected reconciliation counters: ${JSON.stringify(metrics)}`);
  }
  if (metrics.unresolvedCount !== 0) {
    throw new Error('A confirmed transaction must no longer be counted as unresolved');
  }
  if (metrics.config.batchSize !== ctx.config.reconciliationBatchSize) {
    throw new Error('Reconciliation metrics did not report the configured batch size');
  }
  if (metrics.scheduled !== false || metrics.currentRunActive !== false) {
    throw new Error('Reconciliation scheduler/run state was misreported');
  }
});

registerTest('TC-RECON-10', 'Reconciliation', 'The reconciliation scheduler starts and stops cleanly', async () => {
  const ctx = createReconContext();
  if (ctx.service.isScheduled()) {
    throw new Error('Reconciliation must not be scheduled before start() is called');
  }
  ctx.service.start();
  if (!ctx.service.isScheduled()) {
    throw new Error('Reconciliation was not scheduled after start()');
  }
  const metrics = await ctx.service.getMetrics();
  if (metrics.scheduled !== true) {
    throw new Error('Reconciliation metrics did not report the scheduled state');
  }
  ctx.service.stop();
  if (ctx.service.isScheduled()) {
    throw new Error('Reconciliation remained scheduled after stop()');
  }
});

registerTest('TC-RECON-11', 'Reconciliation', 'A payload hash mismatch is escalated and never treated as committed', async () => {
  const ctx = createReconContext({
    findTransactionByIdempotencyKey: async () => ({
      fabricTransactionId: 'sim-fabric-rc-11',
      status: 'CONFIRMED',
      blockNumber: 700,
      commitTimestamp: new Date().toISOString(),
    }),
    getTransactionProof: async (id: string) => ({
      fabricTransactionId: id,
      payloadHash: 'deadbeef'.repeat(8),
      blockNumber: 700,
      blockHash: 'sim-block-hash',
      commitTimestamp: new Date().toISOString(),
      mspId: 'Org1MSP',
      isSimulated: true,
    }),
  });
  const ingest = await seedReconciliationRequired(ctx, '11');

  await ctx.service.runReconciliation();

  const tx = await ctx.txService.getById(ingest.gatewayRequestId);
  if (tx?.lifecycleState === 'COMMITTED') {
    throw new Error('A mismatched ledger payload hash must not be treated as a confirmed commit');
  }
  const record = (await ctx.service.getRecords())[0];
  if (!record || record.outcome !== 'INCONCLUSIVE' || record.payloadHashMatched !== false) {
    throw new Error(`Expected an inconclusive escalated record, got ${JSON.stringify(record)}`);
  }
  if (!record.escalated) {
    throw new Error('A payload hash mismatch must be escalated for operator review');
  }
});

registerTest('TC-RECON-12', 'Reconciliation', 'A PENDING provider acknowledgement is never inferred as a commit', async () => {
  const ctx = createReconContext({
    findTransactionByIdempotencyKey: async () => ({
      fabricTransactionId: 'sim-fabric-rc-12',
      status: 'PENDING',
    }),
  });
  const ingest = await seedReconciliationRequired(ctx, '12');

  const result = await ctx.service.runReconciliation();
  if (result.confirmed !== 0) {
    throw new Error('A PENDING acknowledgement was incorrectly treated as confirmed');
  }
  const tx = await ctx.txService.getById(ingest.gatewayRequestId);
  if (tx?.lifecycleState !== 'RECONCILIATION_REQUIRED') {
    throw new Error('A PENDING acknowledgement must leave the transaction in RECONCILIATION_REQUIRED');
  }
});

// =========================================================================
// SUITE 16: INDEPENDENT FABRIC COMMIT VERIFIER (PROMPT 09.7)
// =========================================================================
// IMPORTANT — SIMULATED LEDGER FIXTURES ONLY.
//
// Every "block evidence source" below is an IN-PROCESS DOUBLE that fabricates a
// block-level ledger response. NO real Hyperledger Fabric network is contacted,
// NO chaincode is deployed, NO block is fetched and NO `qscc` invocation is
// made. These tests prove the VERIFICATION DECISION LOGIC only: that a commit
// is accepted exclusively on complete, independent, self-consistent block-level
// evidence, and that every weaker or contradictory form of evidence is refused.
//
// `isSimulated` on a verification RESULT is `false` by contract (the verifier is
// a provider-mode component that never simulates on its own); what is simulated
// here is the LEDGER DATA, which is why every test name says so. A green result
// in this suite is NOT evidence that Fabric live is working — see
// `TC-FABRIC-21`, which stays SKIPPED without a reachable network.

function simulatedBlockTransaction(
  overrides: Partial<DecodedBlockTransaction> = {}
): DecodedBlockTransaction {
  return {
    blockNumber: 4242,
    blockHash: 'f'.repeat(64),
    fabricTransactionId: 'sim-fabric-tx-0001',
    validationCode: 0,
    valid: true,
    payloadHash: 'a'.repeat(64),
    gatewayRequestId: 'gw-req-0001',
    idempotencyKey: 'idem-0001',
    transactionType: 'SALE',
    correlationId: 'corr-0001',
    chaincodeName: 'ubtl-ledger',
    ...overrides,
  };
}

function simulatedEvidenceSource(
  lookup:
    | BlockEvidenceLookup
    | ((fabricTransactionId: string) => Promise<BlockEvidenceLookup> | BlockEvidenceLookup),
  options: { sourceName?: string; isIndependent?: boolean } = {}
): BlockEvidenceSource {
  return {
    sourceName: options.sourceName ?? 'simulated-block-ledger-fixture',
    isIndependent: options.isIndependent ?? true,
    async lookupTransaction(fabricTransactionId: string): Promise<BlockEvidenceLookup> {
      return typeof lookup === 'function' ? await lookup(fabricTransactionId) : lookup;
    },
  };
}

registerTest('TC-VERIFY-01', 'CommitVerifier', '[SIMULATED LEDGER] Complete block-level evidence yields VERIFIED_COMMITTED', async () => {
  const txId = 'sim-fabric-tx-0001';
  const verifier = new IndependentCommitVerifier(
    simulatedEvidenceSource({
      kind: 'FOUND',
      transaction: simulatedBlockTransaction({ fabricTransactionId: txId }),
    })
  );
  const result = await verifier.verifyCommit({
    fabricTransactionId: txId,
    gatewayRequestId: 'gw-req-0001',
    expectedPayloadHash: 'a'.repeat(64),
  });

  if (result.verdict !== 'VERIFIED_COMMITTED' || result.verified !== true) {
    throw new Error(`Expected VERIFIED_COMMITTED, got ${result.verdict}`);
  }
  if (!result.evidence || result.evidence.blockNumber !== 4242 || result.evidence.blockHash !== 'f'.repeat(64)) {
    throw new Error('Verified evidence must carry the positive block number and the block hash');
  }
  if (result.evidence.validationCode !== 0 || result.evidence.valid !== true) {
    throw new Error('Verified evidence must record Fabric validation code 0 / valid=true');
  }
  if (result.checks.payloadHashMatched !== true) {
    throw new Error('A matching payload hash must be reported as matched when a comparison was requested');
  }
  const failedChecks = Object.entries(result.checks).filter(
    ([key, value]) => key !== 'payloadHashMatched' && value !== true
  );
  if (failedChecks.length > 0) {
    throw new Error(`Every mandatory check must pass, but these failed: ${failedChecks.map(([k]) => k).join(', ')}`);
  }
  if (result.mismatches.length !== 0) {
    throw new Error(`A verified commit must report no mismatches, got ${JSON.stringify(result.mismatches)}`);
  }
});

registerTest('TC-VERIFY-02', 'CommitVerifier', '[SIMULATED LEDGER] A transaction present in a block but not applied is VERIFIED_INVALID', async () => {
  const txId = 'sim-fabric-tx-invalid';
  const verifier = new IndependentCommitVerifier(
    simulatedEvidenceSource({
      kind: 'FOUND',
      transaction: simulatedBlockTransaction({
        fabricTransactionId: txId,
        validationCode: 4,
        valid: false,
      }),
    })
  );
  const result = await verifier.verifyCommit({ fabricTransactionId: txId });

  if (result.verdict !== 'VERIFIED_INVALID' || result.verified !== false) {
    throw new Error(`An unapplied transaction must be VERIFIED_INVALID, got ${result.verdict}`);
  }
  if (!result.mismatches.includes('validation_code_not_valid:4')) {
    throw new Error(`The validation failure must be reported as a mismatch, got ${JSON.stringify(result.mismatches)}`);
  }
  if (result.checks.validationCodeValid !== false) {
    throw new Error('validationCodeValid must be false for a non-zero Fabric validation code');
  }
});

registerTest('TC-VERIFY-03', 'CommitVerifier', '[SIMULATED LEDGER] A transaction with no ledger record is NOT_FOUND (retryable, not a failure)', async () => {
  const verifier = new IndependentCommitVerifier(simulatedEvidenceSource({ kind: 'NOT_FOUND' }));
  const result = await verifier.verifyCommit({ fabricTransactionId: 'sim-fabric-tx-absent' });

  if (result.verdict !== 'NOT_FOUND' || result.verified !== false) {
    throw new Error(`Expected NOT_FOUND, got ${result.verdict}`);
  }
  if (result.evidence !== null) {
    throw new Error('NOT_FOUND must not carry evidence; absence of a record is not a commit');
  }
  if (result.checks.transactionFound !== false) {
    throw new Error('transactionFound must be false when the ledger has no record');
  }
});

registerTest('TC-VERIFY-04', 'CommitVerifier', '[SIMULATED LEDGER] Missing evidence is EVIDENCE_UNAVAILABLE and provider mode fails closed', async () => {
  const unavailable = new IndependentCommitVerifier(
    simulatedEvidenceSource({
      kind: 'EVIDENCE_UNAVAILABLE',
      reason: 'simulated: no qscc access for this identity',
      errorCode: 'QSCC_ACCESS_DENIED',
    })
  );
  const result = await unavailable.verifyCommit({ fabricTransactionId: 'sim-fabric-tx-0001' });
  if (result.verdict !== 'EVIDENCE_UNAVAILABLE' || result.verified !== false) {
    throw new Error(`Expected EVIDENCE_UNAVAILABLE, got ${result.verdict}`);
  }
  if (result.errorCode !== 'QSCC_ACCESS_DENIED') {
    throw new Error(`The evidence error code must be preserved for audit, got ${result.errorCode}`);
  }

  // Provider mode without a configured block-level source must still expose a
  // verifier (never null) and must refuse every lookup — no silent success.
  const { adapter } = createFabricFixture();
  const providerVerifier = adapter.getCommitVerifier();
  if (!providerVerifier) {
    throw new Error('Provider mode must always expose an independent commit verifier (fail-closed)');
  }
  const providerResult = await providerVerifier.verifyCommit({ fabricTransactionId: 'sim-fabric-tx-0001' });
  if (providerResult.verdict !== 'EVIDENCE_UNAVAILABLE' || providerResult.verified !== false) {
    throw new Error(
      `A provider without a block-level source must fail closed, got ${providerResult.verdict}`
    );
  }

  // The explicitly simulated mock adapter offers no independent verification.
  if (new MockBlockchainAdapter().getCommitVerifier() !== null) {
    throw new Error('The mock adapter must not offer an independent commit verifier');
  }
});

registerTest('TC-VERIFY-05', 'CommitVerifier', '[SIMULATED LEDGER] A query that does not complete in time is TIMEOUT (ambiguous, never success)', async () => {
  const throwingSource = simulatedEvidenceSource(async () => {
    const err: any = new Error('deadline exceeded while waiting for the simulated qscc response');
    err.code = 4; // gRPC DEADLINE_EXCEEDED
    throw err;
  });
  const thrownResult = await new IndependentCommitVerifier(throwingSource).verifyCommit({
    fabricTransactionId: 'sim-fabric-tx-0001',
  });
  if (thrownResult.verdict !== 'TIMEOUT' || thrownResult.verified !== false) {
    throw new Error(`A deadline error must be TIMEOUT, got ${thrownResult.verdict}`);
  }

  const explicitTimeout = await new IndependentCommitVerifier(
    simulatedEvidenceSource({
      kind: 'TIMEOUT',
      reason: 'simulated qscc deadline',
      errorCode: 'QSCC_QUERY_TIMEOUT',
    })
  ).verifyCommit({ fabricTransactionId: 'sim-fabric-tx-0001' });
  if (explicitTimeout.verdict !== 'TIMEOUT' || explicitTimeout.verified !== false) {
    throw new Error(`An explicit TIMEOUT lookup must stay TIMEOUT, got ${explicitTimeout.verdict}`);
  }
});

registerTest('TC-VERIFY-06', 'CommitVerifier', '[SIMULATED LEDGER] A payload hash mismatch is never CONFIRMED and is flagged', async () => {
  const txId = 'sim-fabric-tx-mismatch';
  const verifier = new IndependentCommitVerifier(
    simulatedEvidenceSource({
      kind: 'FOUND',
      transaction: simulatedBlockTransaction({
        fabricTransactionId: txId,
        payloadHash: 'b'.repeat(64),
      }),
    })
  );
  const result = await verifier.verifyCommit({
    fabricTransactionId: txId,
    expectedPayloadHash: 'a'.repeat(64),
  });

  if (result.verdict !== 'INCONSISTENT_EVIDENCE' || result.verified !== false) {
    throw new Error(`A payload hash mismatch must be INCONSISTENT_EVIDENCE, got ${result.verdict}`);
  }
  if (!result.mismatches.includes('payload_hash_mismatch')) {
    throw new Error(`The mismatch must be auditable, got ${JSON.stringify(result.mismatches)}`);
  }
  if (result.checks.payloadHashCompared !== true || result.checks.payloadHashMatched !== false) {
    throw new Error('The payload comparison must be recorded as performed and failed');
  }
  if (result.errorCode !== 'PAYLOAD_HASH_MISMATCH') {
    throw new Error(`Expected PAYLOAD_HASH_MISMATCH, got ${result.errorCode}`);
  }
});

registerTest('TC-VERIFY-07', 'CommitVerifier', '[SIMULATED LEDGER] Contradictory block/transaction metadata is INCONSISTENT_EVIDENCE', async () => {
  // (a) The evidence belongs to a different Fabric transaction ID.
  const idMismatch = await new IndependentCommitVerifier(
    simulatedEvidenceSource({
      kind: 'FOUND',
      transaction: simulatedBlockTransaction({ fabricTransactionId: 'some-other-tx' }),
    })
  ).verifyCommit({ fabricTransactionId: 'sim-fabric-tx-0001' });
  if (idMismatch.verdict !== 'INCONSISTENT_EVIDENCE') {
    throw new Error(`A transaction-id mismatch must be INCONSISTENT_EVIDENCE, got ${idMismatch.verdict}`);
  }
  if (!idMismatch.mismatches.includes('transaction_id_does_not_match_evidence')) {
    throw new Error('The transaction-id mismatch must be auditable');
  }

  // (b) A non-positive block number (and therefore no real block) is incomplete evidence.
  const zeroBlock = await new IndependentCommitVerifier(
    simulatedEvidenceSource({
      kind: 'FOUND',
      transaction: simulatedBlockTransaction({
        fabricTransactionId: 'sim-fabric-tx-0001',
        blockNumber: 0,
      }),
    })
  ).verifyCommit({ fabricTransactionId: 'sim-fabric-tx-0001' });
  if (zeroBlock.verdict !== 'INCONSISTENT_EVIDENCE' || zeroBlock.verified !== false) {
    throw new Error(`A non-positive block number must never confirm a commit, got ${zeroBlock.verdict}`);
  }
  if (!zeroBlock.mismatches.includes('block_number_not_positive:0')) {
    throw new Error('The missing block number must be auditable');
  }

  // (c) A missing block hash leaves the block unidentifiable.
  const noHash = await new IndependentCommitVerifier(
    simulatedEvidenceSource({
      kind: 'FOUND',
      transaction: simulatedBlockTransaction({
        fabricTransactionId: 'sim-fabric-tx-0001',
        blockHash: '',
      }),
    })
  ).verifyCommit({ fabricTransactionId: 'sim-fabric-tx-0001' });
  if (noHash.verdict !== 'INCONSISTENT_EVIDENCE' || !noHash.mismatches.includes('block_hash_missing')) {
    throw new Error(`A missing block hash must be INCONSISTENT_EVIDENCE, got ${noHash.verdict}`);
  }
});

registerTest('TC-VERIFY-08', 'CommitVerifier', '[SIMULATED LEDGER] A chaincode record alone is never commit evidence', async () => {
  // A "chaincode state" source that claims a full, valid-looking record but
  // declares itself non-independent: this is exactly the `GetCommitProof` shape.
  const chaincodeClaimingSource = simulatedEvidenceSource(
    { kind: 'FOUND', transaction: simulatedBlockTransaction() },
    { sourceName: 'simulated-chaincode-getcommitproof', isIndependent: false }
  );
  const result = await new IndependentCommitVerifier(chaincodeClaimingSource).verifyCommit({
    fabricTransactionId: 'sim-fabric-tx-0001',
  });
  if (result.verdict !== 'EVIDENCE_UNAVAILABLE' || result.verified !== false) {
    throw new Error(`A non-independent source must never confirm a commit, got ${result.verdict}`);
  }
  if (result.errorCode !== 'SOURCE_NOT_INDEPENDENT') {
    throw new Error(`Expected SOURCE_NOT_INDEPENDENT, got ${result.errorCode}`);
  }

  // The shipped explicit stand-in for "the only record we have is the chaincode's".
  const standIn = await new IndependentCommitVerifier(
    createChaincodeStateEvidenceSource('simulated: chaincode state is not commit evidence')
  ).verifyCommit({ fabricTransactionId: 'sim-fabric-tx-0001' });
  if (standIn.verdict !== 'EVIDENCE_UNAVAILABLE' || standIn.verified !== false) {
    throw new Error(`The chaincode-state stand-in must never confirm, got ${standIn.verdict}`);
  }
  if (standIn.evidenceSource !== 'chaincode-state') {
    throw new Error('The refusal must name the non-independent source in the audit trail');
  }
});

registerTest('TC-VERIFY-09', 'CommitVerifier', '[SIMULATED LEDGER] Restart + reconciliation confirms only through the independent source', async () => {
  let verifierInstance: CommitVerifier = new IndependentCommitVerifier(
    simulatedEvidenceSource({ kind: 'NOT_FOUND' })
  );
  const ctx = createReconContext({ getCommitVerifier: () => verifierInstance });
  const ingest = await seedReconciliationRequired(ctx, 'ver09');
  const seeded = await ctx.txService.getById(ingest.gatewayRequestId);
  if (!seeded?.fabricTransactionId) {
    throw new Error('The seeded transaction must carry a Fabric transaction ID');
  }

  // "Restart": a fresh service instance with NO in-process commit handle,
  // looking the evidence up by Fabric transaction ID only.
  const restartedVerifier = new IndependentCommitVerifier(
    simulatedEvidenceSource({
      kind: 'FOUND',
      transaction: simulatedBlockTransaction({
        fabricTransactionId: seeded.fabricTransactionId,
        payloadHash: seeded.payloadHash,
        gatewayRequestId: seeded.gatewayRequestId,
      }),
    })
  );
  const restartedAdapter: any = { ...ctx.adapter, getCommitVerifier: () => restartedVerifier };
  const restartedService = new ReconciliationService(
    ctx.config,
    ctx.txService,
    restartedAdapter,
    ctx.audit
  );

  const result = await restartedService.runReconciliation();
  if (result.confirmed !== 1 || result.inconclusive !== 0 || result.failed !== 0) {
    throw new Error(
      `Expected exactly one confirmed after restart, got confirmed=${result.confirmed} inconclusive=${result.inconclusive} failed=${result.failed}`
    );
  }
  const tx = await ctx.txService.getById(ingest.gatewayRequestId);
  if (tx?.lifecycleState !== 'COMMITTED' || tx?.blockNumber !== 4242) {
    throw new Error('Verified block-level evidence must advance the transaction to COMMITTED');
  }
  const record = (await restartedService.getRecords('CONFIRMED'))[0];
  if (!record || record.verificationVerdict !== 'VERIFIED_COMMITTED') {
    throw new Error('The CONFIRMED record must cite the VERIFIED_COMMITTED verdict');
  }
  if (!record.blockHash || record.blockHash !== 'f'.repeat(64)) {
    throw new Error('The CONFIRMED record must preserve the block hash as separate evidence');
  }
});

registerTest('TC-VERIFY-10', 'CommitVerifier', '[SIMULATED LEDGER] Restart + unavailable evidence fails safe (no commit, no false failure)', async () => {
  const ctx = createReconContext({
    getCommitVerifier: () =>
      new IndependentCommitVerifier(
        simulatedEvidenceSource({
          kind: 'EVIDENCE_UNAVAILABLE',
          reason: 'simulated: qscc not permitted for this identity',
          errorCode: 'QSCC_ACCESS_DENIED',
        })
      ),
  });
  const ingest = await seedReconciliationRequired(ctx, 'ver10');

  const result = await ctx.service.runReconciliation();
  if (result.confirmed !== 0 || result.failed !== 0 || result.inconclusive !== 1) {
    throw new Error(
      `Unavailable evidence must be inconclusive only, got confirmed=${result.confirmed} failed=${result.failed} inconclusive=${result.inconclusive}`
    );
  }
  const tx = await ctx.txService.getById(ingest.gatewayRequestId);
  if (tx?.lifecycleState !== 'RECONCILIATION_REQUIRED') {
    throw new Error('Unavailable evidence must preserve RECONCILIATION_REQUIRED');
  }
  const record = (await ctx.service.getRecords('INCONCLUSIVE'))[0];
  if (!record || record.verificationVerdict !== 'EVIDENCE_UNAVAILABLE') {
    throw new Error('The inconclusive record must record the verification verdict for audit');
  }
});

registerTest('TC-VERIFY-11', 'CommitVerifier', '[SIMULATED LEDGER] Repeated reconciliation never submits a duplicate proposal', async () => {
  let submitCalls = 0;
  let verifierInstance: CommitVerifier = new IndependentCommitVerifier(
    simulatedEvidenceSource({ kind: 'NOT_FOUND' })
  );
  const ctx = createReconContext({
    getCommitVerifier: () => verifierInstance,
    submitProposal: async () => {
      submitCalls++;
      return { accepted: true, fabricTransactionId: 'sim-duplicate', status: 'PENDING', isSimulated: true };
    },
  });
  const ingest = await seedReconciliationRequired(ctx, 'ver11');
  const seeded = await ctx.txService.getById(ingest.gatewayRequestId);
  verifierInstance = new IndependentCommitVerifier(
    simulatedEvidenceSource({
      kind: 'FOUND',
      transaction: simulatedBlockTransaction({
        fabricTransactionId: seeded!.fabricTransactionId!,
        payloadHash: seeded!.payloadHash,
        gatewayRequestId: seeded!.gatewayRequestId,
      }),
    })
  );

  const first = await ctx.service.runReconciliation();
  const second = await ctx.service.runReconciliation();

  if (first.confirmed !== 1) {
    throw new Error(`The first run must confirm exactly one transaction, got ${first.confirmed}`);
  }
  if (second.confirmed !== 0 || second.eligibleCount !== 0) {
    throw new Error(
      `A second run must find nothing eligible, got confirmed=${second.confirmed} eligible=${second.eligibleCount}`
    );
  }
  if (submitCalls !== 0) {
    throw new Error('Reconciliation must never submit a blockchain proposal (idempotency preserved)');
  }
  const tx = await ctx.txService.getById(ingest.gatewayRequestId);
  if (tx?.lifecycleState !== 'COMMITTED' || tx?.blockNumber !== 4242) {
    throw new Error('The transaction must be committed exactly once with the verified block number');
  }
});

registerTest('TC-VERIFY-12', 'CommitVerifier', 'Transient/ambiguous verification outcomes are classified for retry, not permanent failure', async () => {
  const pendingErr: any = new Error('Block formation in progress (re-verifying)');
  pendingErr.code = 'BLOCK_FORMATION_PENDING';
  const pending = classifyError(pendingErr);
  if (pending.classification !== 'TRANSIENT') {
    throw new Error(`BLOCK_FORMATION_PENDING must be retryable, got ${pending.classification}`);
  }

  const evidenceErr: any = new Error('No block evidence available yet');
  evidenceErr.code = 'COMMIT_EVIDENCE_UNAVAILABLE';
  const evidence = classifyError(evidenceErr);
  if (evidence.classification !== 'TRANSIENT') {
    throw new Error(`COMMIT_EVIDENCE_UNAVAILABLE must be retryable, got ${evidence.classification}`);
  }

  const timeout = classifyError(new Error('COMMIT_TIMEOUT'));
  if (timeout.classification !== 'AMBIGUOUS') {
    throw new Error(`A commit timeout must be AMBIGUOUS, never a blind resubmit: ${timeout.classification}`);
  }
});

registerTest('TC-VERIFY-13', 'CommitVerifier', 'Illegal lifecycle transitions are refused (terminal FAILED is never reconciled to COMMITTED)', async () => {
  if (canTransition('FAILED', 'COMMITTED')) {
    throw new Error('The state machine must forbid FAILED -> COMMITTED');
  }
  if (!canTransition('RECONCILIATION_REQUIRED', 'COMMITTED')) {
    throw new Error('RECONCILIATION_REQUIRED -> COMMITTED is the one legal recovery path and must stay allowed');
  }

  const ctx = createReconContext({
    getCommitVerifier: () =>
      new IndependentCommitVerifier(
        simulatedEvidenceSource({ kind: 'FOUND', transaction: simulatedBlockTransaction() })
      ),
  });
  const ingest = await ctx.txService.ingest({
    correlationId: 'corr-ver13',
    idempotencyKey: 'idemp-ver13',
    transactionType: 'SALES',
    payload: { invoiceNumber: 'INV-VER-13', amount: '1.00', currency: 'IDR' },
    organizationId: 'org-recon',
  });
  await ctx.txService.markSubmitted(ingest.gatewayRequestId, 'sim-fabric-ver13');
  await ctx.txService.markFailed(ingest.gatewayRequestId, 'SIM_REJECTED', 'simulated definitive rejection');

  const result = await ctx.service.runReconciliation();
  const tx = await ctx.txService.getById(ingest.gatewayRequestId);
  if (tx?.lifecycleState !== 'FAILED') {
    throw new Error('A terminal FAILED transaction must never be advanced to COMMITTED by reconciliation');
  }
  if (result.confirmed !== 0 || result.eligibleCount !== 0) {
    throw new Error(
      `A terminal transaction is not eligible for reconciliation, got confirmed=${result.confirmed} eligible=${result.eligibleCount}`
    );
  }

  // Axiom 5 guard: a non-positive block number can never be recorded as a commit.
  let guardMessage = '';
  try {
    await ctx.txService.markCommitted(ingest.gatewayRequestId, 0);
  } catch (err: unknown) {
    guardMessage = err instanceof Error ? err.message : String(err);
  }
  if (!guardMessage.includes('Axiom 5')) {
    throw new Error(`markCommitted must refuse blockNumber <= 0 with the Axiom 5 guard, got '${guardMessage}'`);
  }
});

registerTest('TC-VERIFY-14', 'CommitVerifier', 'Every verification decision is auditable and auditing never alters a verdict', async () => {
  const decisions: CommitVerificationDecision[] = [];
  const source = simulatedEvidenceSource({
    kind: 'FOUND',
    transaction: simulatedBlockTransaction({ fabricTransactionId: 'sim-fabric-tx-0001' }),
  });
  const verifier = new IndependentCommitVerifier(source, {
    auditSink: { record: (decision) => decisions.push(decision) },
    now: () => '2026-10-25T00:00:00.000Z',
  });

  await verifier.verifyCommit({
    fabricTransactionId: 'sim-fabric-tx-0001',
    gatewayRequestId: 'gw-req-0001',
    idempotencyKey: 'idem-0001',
    expectedPayloadHash: 'a'.repeat(64),
  });
  // A second call whose evidence contradicts the expectation must ALSO be audited.
  await verifier.verifyCommit({ fabricTransactionId: 'sim-fabric-tx-other' });

  if (decisions.length !== 2) {
    throw new Error(`Every decision must be audited, expected 2 decisions, got ${decisions.length}`);
  }
  const [confirmed, inconsistent] = decisions;
  if (confirmed.verdict !== 'VERIFIED_COMMITTED' || confirmed.blockNumber !== 4242) {
    throw new Error('The confirmed decision must record its verdict, block number and block hash');
  }
  if (confirmed.blockHash !== 'f'.repeat(64) || confirmed.decidedAt !== '2026-10-25T00:00:00.000Z') {
    throw new Error('The audit entry must preserve the block hash and a stable timestamp');
  }
  if (inconsistent.verdict !== 'INCONSISTENT_EVIDENCE' || inconsistent.mismatches.length === 0) {
    throw new Error('A refused decision must also be audited with its mismatches');
  }
  const serialized = JSON.stringify(decisions);
  if (/(?:secret|key|token|password|authorization)=/i.test(serialized) || /Bearer\s/i.test(serialized)) {
    throw new Error('Audit entries must never embed credential-shaped values');
  }

  // An audit sink that throws must never change a verdict.
  const throwingVerifier = new IndependentCommitVerifier(source, {
    auditSink: {
      record() {
        throw new Error('simulated audit sink outage');
      },
    },
  });
  const stillVerified = await throwingVerifier.verifyCommit({
    fabricTransactionId: 'sim-fabric-tx-0001',
    expectedPayloadHash: 'a'.repeat(64),
  });
  if (stillVerified.verdict !== 'VERIFIED_COMMITTED' || stillVerified.verified !== true) {
    throw new Error('An audit failure must never alter a verification verdict');
  }
});

registerTest('TC-VERIFY-15', 'CommitVerifier', '[SIMULATED LEDGER] A transient verdict retries the outbox event instead of committing or failing', async () => {
  const config = loadConfig();
  const audit = new AuditService();
  const txService = new TransactionsService(audit);

  // A provider-style adapter: it DOES expose a block-level verifier, whose
  // simulated ledger simply has no record for this transaction yet (ordering /
  // commit latency). The adapter's own observation is never consulted.
  const adapter = new MockBlockchainAdapter(10, 0, 0);
  (adapter as any).getCommitVerifier = () =>
    new IndependentCommitVerifier(simulatedEvidenceSource({ kind: 'NOT_FOUND' }));

  const webhookService = new WebhookService(config, audit);
  const outboxRepo = new InMemoryOutboxRepository();
  const worker = new OutboxWorker(config, outboxRepo, txService, adapter, webhookService, audit);

  const ingestRes = await txService.ingest({
    correlationId: 'corr-ver15',
    idempotencyKey: 'idemp-ver15',
    transactionType: 'SALES',
    payload: { invoiceNumber: 'INV-VER-15', amount: '15.00', currency: 'IDR' },
    organizationId: 'org-test',
  });
  await txService.markSubmitted(ingestRes.gatewayRequestId, 'sim-fabric-ver15');

  const event = outboxRepo.enqueueAtomic({
    transactionId: ingestRes.transaction.id,
    gatewayRequestId: ingestRes.gatewayRequestId,
    eventType: 'VERIFY_COMMIT',
    status: 'PENDING',
    payload: { fabricTransactionId: 'sim-fabric-ver15' },
    attemptCount: 0,
    attempts: 0,
    maxAttempts: 5,
    nextAttemptAt: Date.now(),
    lockedAt: null,
    lockedBy: null,
    lastErrorCode: null,
    lastError: null,
    processedAt: null,
    deduplicationKey: `verify:${ingestRes.transaction.id}`,
  });

  const processed = await worker.pollAndProcess();
  if (processed !== 1) {
    throw new Error(`Expected 1 processed VERIFY_COMMIT event, got ${processed}`);
  }

  // Absence of evidence is not evidence of failure: the transaction must be
  // neither committed nor failed, and no webhook may have been emitted.
  const tx = await txService.getById(ingestRes.gatewayRequestId);
  if (!tx || tx.lifecycleState !== 'SUBMITTED') {
    throw new Error(
      `A NOT_FOUND verdict must leave the transaction in SUBMITTED, got ${tx?.lifecycleState}`
    );
  }

  const after = outboxRepo.findById(event.id);
  if (!after || after.status !== 'RETRY_PENDING') {
    throw new Error(`A transient verdict must schedule a retry, got status=${after?.status}`);
  }
  if (after.lastErrorCode !== 'BLOCK_FORMATION_PENDING') {
    throw new Error(
      `NOT_FOUND must be retried as BLOCK_FORMATION_PENDING, got ${after.lastErrorCode}`
    );
  }
  if (after.lockedBy !== null || after.lockedAt !== null) {
    throw new Error('A retried event must be released back to the pool, not left claimed');
  }
  if (!(after.nextAttemptAt > 0)) {
    throw new Error('A retried event must carry a future attempt time');
  }
});

// =========================================================================
// SUITE 17: SECURITY REDACTION HARDENING (PROMPT 09.8)
// =========================================================================
// Regression guard for the `M1_REDACT_OBJECT_KEYS=FAIL` finding. The previous
// literal key list silently missed header-style and mixed-case names
// (`xApiKey`, `x-api-key`, `X_API_KEY`, `tlsCert`, `clientCert`) because the
// compared key was lowercased and those entries never appeared verbatim in the
// list. A clean log scan is NOT proof that every sensitive field-name shape is
// sanitised, so these tests pin the matching rules directly AND pin the
// deliberate non-redaction of legitimate identifiers, so a future "fix" cannot
// silently over-redact the audit trail.

registerTest('TC-REDACT-01', 'SecurityRedaction', 'Object-key redaction covers header-style and mixed-case sensitive names', () => {
  const sanitized: any = sanitizeForLog({
    xApiKey: 'v-a',
    'x-api-key': 'v-b',
    X_API_KEY: 'v-c',
    tlsCert: 'v-d',
    clientCert: 'v-e',
    clientKey: 'v-f',
    privateKey: 'v-g',
    signingKey: 'v-h',
    authorization: 'v-i',
    auth: 'v-j',
    mnemonic: 'v-k',
    nested: { apiSecret: 'v-l', 'x-switching-signature': 'v-m' },
    list: [{ xApiKey: 'v-n' }],
  });

  const mustBeRedacted = [
    'xApiKey',
    'x-api-key',
    'X_API_KEY',
    'tlsCert',
    'clientCert',
    'clientKey',
    'privateKey',
    'signingKey',
    'authorization',
    'auth',
    'mnemonic',
  ];
  for (const key of mustBeRedacted) {
    if (sanitized[key] !== '[REDACTED]') {
      throw new Error(`Sensitive key '${key}' must be redacted, got '${String(sanitized[key])}'`);
    }
  }
  if (
    sanitized.nested.apiSecret !== '[REDACTED]' ||
    sanitized.nested['x-switching-signature'] !== '[REDACTED]'
  ) {
    throw new Error('Sensitive keys nested in an object must be redacted at depth');
  }
  if (sanitized.list[0].xApiKey !== '[REDACTED]') {
    throw new Error('Sensitive keys inside arrays must be redacted');
  }
});

registerTest('TC-REDACT-02', 'SecurityRedaction', 'Non-secret identifiers survive redaction (no over-redaction)', () => {
  const input = {
    idempotencyKey: 'idem-1',
    deduplicationKey: 'dedup-1',
    gatewayRequestId: 'gw-1',
    blockHash: 'a'.repeat(64),
    evidenceSource: 'qscc',
    verdict: 'VERIFIED_COMMITTED',
    author: 'alice',
    monkey: 'business-data',
    transactionType: 'SALE',
    correlationId: 'corr-1',
  };
  const sanitized: any = sanitizeForLog(input);
  for (const [key, value] of Object.entries(input)) {
    if (sanitized[key] !== value) {
      throw new Error(
        `Non-secret identifier '${key}' must NOT be redacted, got '${String(sanitized[key])}'`
      );
    }
  }
});

registerTest('TC-REDACT-03', 'SecurityRedaction', 'isSensitiveKeyName normalises case/separators without a bare "key" rule', () => {
  const sensitive = [
    'xApiKey',
    'x-api-key',
    'X_API_KEY',
    'API-KEY',
    'api_key',
    'tlsCert',
    'clientCert',
    'clientKey',
    'privateKey',
    'signingKey',
    'authorization',
    'auth',
    'Bearer',
    'x-switching-signature',
    'token',
  ];
  for (const key of sensitive) {
    if (!isSensitiveKeyName(key)) {
      throw new Error(`'${key}' must be treated as sensitive`);
    }
  }
  const safe = [
    'idempotencyKey',
    'deduplicationKey',
    'gatewayRequestId',
    'blockHash',
    'evidenceSource',
    'verdict',
    'author',
    'monkey',
    'transactionType',
    'correlationId',
  ];
  for (const key of safe) {
    if (isSensitiveKeyName(key)) {
      throw new Error(`'${key}' must NOT be treated as sensitive`);
    }
  }
  if (normalizeKeyForComparison('X_API_KEY') !== 'xapikey') {
    throw new Error('normalizeKeyForComparison must strip case and separators');
  }
  if (/[^a-z0-9]/.test(normalizeKeyForComparison('  x.Api-Key '))) {
    throw new Error('normalization must remove every non-alphanumeric character');
  }
});

registerTest('TC-REDACT-04', 'SecurityRedaction', 'redactSecrets scrubs header-style keys in free text (including camelCase)', () => {
  const samples = [
    'x-api-key: AAAABBBBCCCCDDDD',
    'X_API_KEY=AAAABBBBCCCCDDDD',
    'xApiKey: AAAABBBBCCCCDDDD',
    'x-switching-signature=AAAABBBBCCCCDDDD',
    'authorization: Bearer AAABBBCCCDDDEEEFFF',
  ];
  for (const sample of samples) {
    const out = redactSecrets(sample);
    if (!out.includes('[REDACTED]')) {
      throw new Error(`redactSecrets must emit [REDACTED] for '${sample}'`);
    }
    if (/AAAA|AAAB/.test(out)) {
      throw new Error(`redactSecrets leaked a credential value from '${sample}' -> '${out}'`);
    }
  }
});

// =========================================================================
// SUITE 18: REAL FABRIC BLOCK DECODER & QSCC TRANSPORT (PROMPT 09.8)
// =========================================================================
// SYNTHETIC WIRE FIXTURES ONLY. The blocks below are encoded by the local
// protobuf encoder in this file — they were NOT produced by a Hyperledger
// Fabric peer. These tests pin the decoder's wire-format handling, its
// fail-closed behaviour on contradictory/incomplete evidence, and the rule that
// an invalid or insufficiently evidenced transaction can NEVER become
// CONFIRMED. A green result here is NOT live-network evidence (see
// `TC-FABRIC-21`, which stays SKIPPED without a reachable network).

function pbVarint(value: number): Buffer {
  const bytes: number[] = [];
  let v = value >>> 0;
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

function pbTag(field: number, wireType: number): Buffer {
  return pbVarint((field << 3) | wireType);
}

function pbBytesField(field: number, payload: Buffer): Buffer {
  return Buffer.concat([pbTag(field, 2), pbVarint(payload.length), payload]);
}

function pbVarintField(field: number, value: number): Buffer {
  return Buffer.concat([pbTag(field, 0), pbVarint(value)]);
}

function pbChaincodeId(name: string): Buffer {
  return pbBytesField(2, Buffer.from(name, 'utf8')); // ChaincodeID.name = 2
}

function pbChaincodeInput(args: string[]): Buffer {
  return Buffer.concat(args.map((a) => pbBytesField(1, Buffer.from(a, 'utf8'))));
}

function pbChaincodeSpec(name: string, args: string[]): Buffer {
  return Buffer.concat([
    pbVarintField(1, 1), // ChaincodeSpec.type = 1
    pbBytesField(2, pbChaincodeId(name)), // ChaincodeSpec.chaincode_id = 2
    pbBytesField(3, pbChaincodeInput(args)), // ChaincodeSpec.input = 3
  ]);
}

function pbProposalPayload(name: string, args: string[]): Buffer {
  const invocationSpec = pbBytesField(1, pbChaincodeSpec(name, args)); // chaincode_spec = 1
  return pbBytesField(1, invocationSpec); // ChaincodeProposalPayload.input = 1
}

function pbTransactionAction(name: string, args: string[]): Buffer {
  const extension = pbBytesField(1, pbChaincodeId(name)); // ChaincodeHeaderExtension.chaincode_id = 1
  return Buffer.concat([
    pbBytesField(1, extension), // TransactionAction.header = 1
    pbBytesField(2, pbProposalPayload(name, args)), // TransactionAction.payload = 2
  ]);
}

function pbChannelHeader(txId: string): Buffer {
  return Buffer.concat([
    pbVarintField(1, 3), // type = ENDORSER_TRANSACTION
    pbVarintField(2, 1), // version
    pbBytesField(4, Buffer.from(txId, 'utf8')), // tx_id = 4
    pbBytesField(5, Buffer.from('ubtl-channel', 'utf8')), // channel_id = 5
  ]);
}

function pbEnvelope(txId: string, name: string, args: string[]): Buffer {
  const header = pbBytesField(1, pbChannelHeader(txId)); // Header.channel_header = 1
  const transaction = Buffer.concat([pbBytesField(1, pbTransactionAction(name, args))]); // Transaction.actions = 1
  const payload = Buffer.concat([
    pbBytesField(1, header), // Payload.header = 1
    pbBytesField(2, transaction), // Payload.data = 2
  ]);
  return pbBytesField(1, payload); // Envelope.payload = 1
}

function pbBlock(params: {
  blockNumber: number;
  envelopes: Buffer[];
  flags: number[];
  dataHashOverride?: Buffer;
  omitFilter?: boolean;
}): Buffer {
  const blockData = Buffer.concat(params.envelopes.map((e) => pbBytesField(1, e))); // BlockData.data = 1
  const dataHash = params.dataHashOverride ?? createHash('sha256').update(blockData).digest();
  const header = Buffer.concat([
    pbVarintField(1, params.blockNumber), // BlockHeader.number = 1
    pbBytesField(2, Buffer.alloc(32, 0x11)), // previous_hash = 2
    pbBytesField(3, dataHash), // data_hash = 3
  ]);
  const metadata = params.omitFilter
    ? Buffer.alloc(0)
    : pbBytesField(
        2, // BlockMetadata.metadata_index = 2
        Buffer.concat([
          pbVarintField(1, 2), // MetadataIndex.index = 2 (TRANSACTIONS_FILTER)
          pbBytesField(2, Buffer.from(params.flags)), // MetadataIndex.digest = 2
        ])
      );
  return Buffer.concat([
    pbBytesField(1, header), // Block.header = 1
    pbBytesField(2, blockData), // Block.data = 2
    pbBytesField(3, metadata), // Block.metadata = 3
  ]);
}

const FIXTURE_PAYLOAD_HASH = 'b'.repeat(64);
const FIXTURE_CHANNEL = 'ubtl-channel';

function fixtureSubmitArgs(payloadHash = FIXTURE_PAYLOAD_HASH): string[] {
  return [
    DEFAULT_SUBMIT_FUNCTION_NAME,
    payloadHash,
    'SALE',
    'corr-fix-1',
    '1700000000',
    'gw-req-fix-1',
    'idem-fix-1',
  ];
}

registerTest('TC-DECODE-01', 'FabricBlockDecoder', '[SYNTHETIC WIRE FIXTURE] A well-formed Fabric block decodes to full transaction evidence', () => {
  const decoder = createFabricProtobufBlockDecoder();
  const txId = 'sim-fabric-block-tx-1';
  const raw = pbBlock({
    blockNumber: 4242,
    envelopes: [pbEnvelope(txId, 'ubtl-ledger', fixtureSubmitArgs())],
    flags: [0],
  });

  const outcome = decoder.decode(raw, txId);
  if (outcome.kind !== 'DECODED') {
    throw new Error(
      `Expected DECODED, got ${outcome.kind} (${outcome.kind === 'UNAVAILABLE' ? outcome.errorCode : ''})`
    );
  }
  const tx = outcome.transaction;
  if (tx.blockNumber !== 4242 || !/^[0-9a-f]{64}$/.test(tx.blockHash)) {
    throw new Error(`Decoded block must carry block number 4242 and a SHA-256 block hash, got ${tx.blockNumber} / ${tx.blockHash}`);
  }
  if (tx.fabricTransactionId !== txId || tx.validationCode !== 0 || tx.valid !== true) {
    throw new Error('Decoded transaction must carry the matched tx id and validation code 0');
  }
  if (tx.payloadHash !== FIXTURE_PAYLOAD_HASH) {
    throw new Error(`Decoded payload hash must come from the chaincode args, got ${tx.payloadHash}`);
  }
  if (
    tx.gatewayRequestId !== 'gw-req-fix-1' ||
    tx.idempotencyKey !== 'idem-fix-1' ||
    tx.correlationId !== 'corr-fix-1' ||
    tx.transactionType !== 'SALE' ||
    tx.chaincodeName !== 'ubtl-ledger'
  ) {
    throw new Error('Decoded integrity metadata must match the SubmitTransactionProposal arguments');
  }
});

registerTest('TC-DECODE-02', 'FabricBlockDecoder', '[SYNTHETIC WIRE FIXTURE] A header/data hash contradiction fails closed', () => {
  const decoder = createFabricProtobufBlockDecoder();
  const txId = 'sim-fabric-block-tx-2';
  const raw = pbBlock({
    blockNumber: 10,
    envelopes: [pbEnvelope(txId, 'ubtl-ledger', fixtureSubmitArgs())],
    flags: [0],
    dataHashOverride: Buffer.alloc(32, 0x22),
  });
  const outcome = decoder.decode(raw, txId);
  if (outcome.kind !== 'UNAVAILABLE' || outcome.errorCode !== 'BLOCK_DATA_HASH_MISMATCH') {
    throw new Error(`Expected BLOCK_DATA_HASH_MISMATCH, got ${outcome.kind}`);
  }
});

registerTest('TC-DECODE-03', 'FabricBlockDecoder', '[SYNTHETIC WIRE FIXTURE] A validation-flag/envelope count mismatch fails closed', () => {
  const decoder = createFabricProtobufBlockDecoder();
  const raw = pbBlock({
    blockNumber: 11,
    envelopes: [
      pbEnvelope('sim-fabric-block-tx-3a', 'ubtl-ledger', fixtureSubmitArgs()),
      pbEnvelope('sim-fabric-block-tx-3b', 'ubtl-ledger', fixtureSubmitArgs()),
    ],
    flags: [0],
  });
  const outcome = decoder.decode(raw, 'sim-fabric-block-tx-3a');
  if (outcome.kind !== 'UNAVAILABLE' || outcome.errorCode !== 'TRANSACTIONS_FILTER_LENGTH_MISMATCH') {
    throw new Error(`Expected TRANSACTIONS_FILTER_LENGTH_MISMATCH, got ${outcome.kind}`);
  }
});

registerTest('TC-DECODE-04', 'FabricBlockDecoder', '[SYNTHETIC WIRE FIXTURE] A missing TRANSACTIONS_FILTER fails closed', () => {
  const decoder = createFabricProtobufBlockDecoder();
  const txId = 'sim-fabric-block-tx-4';
  const raw = pbBlock({
    blockNumber: 12,
    envelopes: [pbEnvelope(txId, 'ubtl-ledger', fixtureSubmitArgs())],
    flags: [],
    omitFilter: true,
  });
  const outcome = decoder.decode(raw, txId);
  if (outcome.kind !== 'UNAVAILABLE' || outcome.errorCode !== 'TRANSACTIONS_FILTER_MISSING') {
    throw new Error(`Expected TRANSACTIONS_FILTER_MISSING, got ${outcome.kind}`);
  }
});

registerTest('TC-DECODE-05', 'FabricBlockDecoder', '[SYNTHETIC WIRE FIXTURE] A transaction absent from the block is not fabricated', () => {
  const decoder = createFabricProtobufBlockDecoder();
  const raw = pbBlock({
    blockNumber: 13,
    envelopes: [pbEnvelope('sim-fabric-block-tx-5-other', 'ubtl-ledger', fixtureSubmitArgs())],
    flags: [0],
  });
  const outcome = decoder.decode(raw, 'sim-fabric-block-tx-5-wanted');
  if (outcome.kind !== 'UNAVAILABLE' || outcome.errorCode !== 'TRANSACTION_NOT_IN_BLOCK') {
    throw new Error(`Expected TRANSACTION_NOT_IN_BLOCK, got ${outcome.kind}`);
  }
});

registerTest('TC-DECODE-06', 'FabricBlockDecoder', 'Empty and malformed block bytes fail closed without throwing', () => {
  const decoder = createFabricProtobufBlockDecoder();
  const empty = decoder.decode(Buffer.alloc(0), 'sim-fabric-tx-6');
  if (empty.kind !== 'UNAVAILABLE' || empty.errorCode !== 'BLOCK_EMPTY') {
    throw new Error(`Expected BLOCK_EMPTY, got ${empty.kind}`);
  }
  // Field 3, length-delimited, declared length 5 but only 1 byte present.
  const malformed = decoder.decode(Buffer.from([0x1a, 0x05, 0x01]), 'sim-fabric-tx-6');
  if (malformed.kind !== 'UNAVAILABLE' || malformed.errorCode !== 'BLOCK_DECODE_FAILED') {
    throw new Error(`Expected BLOCK_DECODE_FAILED, got ${malformed.kind} (${malformed.kind === 'UNAVAILABLE' ? malformed.errorCode : ''})`);
  }
});

registerTest('TC-DECODE-07', 'CommitVerifier', '[SYNTHETIC WIRE FIXTURE] The qscc transport + real decoder yield VERIFIED_COMMITTED', async () => {
  const txId = 'sim-fabric-block-tx-7';
  const raw = pbBlock({
    blockNumber: 4242,
    envelopes: [pbEnvelope(txId, 'ubtl-ledger', fixtureSubmitArgs())],
    flags: [0],
  });
  const calls: string[][] = [];
  const source = createQsccBlockEvidenceSource({
    channelName: FIXTURE_CHANNEL,
    evaluator: {
      async evaluate(chaincodeName: string, fn: string, ...args: string[]): Promise<Uint8Array> {
        calls.push([chaincodeName, fn, ...args]);
        return raw;
      },
    },
  });

  const result = await new IndependentCommitVerifier(source).verifyCommit({
    fabricTransactionId: txId,
    gatewayRequestId: 'gw-req-fix-1',
    expectedPayloadHash: FIXTURE_PAYLOAD_HASH,
  });

  if (result.verdict !== 'VERIFIED_COMMITTED' || result.verified !== true) {
    throw new Error(`Expected VERIFIED_COMMITTED, got ${result.verdict}`);
  }
  if (result.evidence?.blockNumber !== 4242 || result.evidenceSource !== 'qscc') {
    throw new Error('Verified evidence must carry the block number and name the qscc source');
  }
  const [chaincodeName, fn, channel, txArg] = calls[0] ?? [];
  if (chaincodeName !== 'qscc' || fn !== 'GetBlockByTxID' || channel !== FIXTURE_CHANNEL || txArg !== txId) {
    throw new Error(`qscc must be called as GetBlockByTxID(channel, txId), got ${JSON.stringify(calls[0])}`);
  }
});

registerTest('TC-DECODE-08', 'CommitVerifier', '[SYNTHETIC WIRE FIXTURE] A ledger-invalid transaction can never become CONFIRMED', async () => {
  const txId = 'sim-fabric-block-tx-8';
  const raw = pbBlock({
    blockNumber: 4243,
    envelopes: [pbEnvelope(txId, 'ubtl-ledger', fixtureSubmitArgs())],
    flags: [11], // MVCC_READ_CONFLICT
  });
  const source = createQsccBlockEvidenceSource({
    channelName: FIXTURE_CHANNEL,
    evaluator: { async evaluate() { return raw; } },
  });
  const result = await new IndependentCommitVerifier(source).verifyCommit({
    fabricTransactionId: txId,
    expectedPayloadHash: FIXTURE_PAYLOAD_HASH,
  });
  if (result.verified !== false || result.verdict !== 'VERIFIED_INVALID') {
    throw new Error(`An invalid transaction must yield VERIFIED_INVALID, got ${result.verdict}`);
  }
  if (result.errorCode !== 'LEDGER_COMMIT_VALIDATION_FAILURE' || result.evidence?.validationCode !== 11) {
    throw new Error('The refusal must cite the ledger validation failure and its code');
  }
});

registerTest('TC-DECODE-09', 'CommitVerifier', '[SYNTHETIC WIRE FIXTURE] Incomplete block evidence cannot become CONFIRMED', async () => {
  const txId = 'sim-fabric-block-tx-9';
  const raw = pbBlock({
    blockNumber: 4244,
    envelopes: [pbEnvelope(txId, 'ubtl-ledger', fixtureSubmitArgs())],
    flags: [0],
    dataHashOverride: Buffer.alloc(32, 0x33), // header/data contradiction
  });
  const source = createQsccBlockEvidenceSource({
    channelName: FIXTURE_CHANNEL,
    evaluator: { async evaluate() { return raw; } },
  });
  const result = await new IndependentCommitVerifier(source).verifyCommit({
    fabricTransactionId: txId,
    expectedPayloadHash: FIXTURE_PAYLOAD_HASH,
  });
  if (result.verified !== false || result.verdict !== 'EVIDENCE_UNAVAILABLE') {
    throw new Error(`Unusable block evidence must yield EVIDENCE_UNAVAILABLE, got ${result.verdict}`);
  }
  if (result.errorCode !== 'BLOCK_DATA_HASH_MISMATCH') {
    throw new Error(`The refusal must surface the decoder's reason, got ${result.errorCode}`);
  }
});

registerTest('TC-DECODE-10', 'CommitVerifier', '[SYNTHETIC WIRE FIXTURE] A qscc miss stays retryable and never commits', async () => {
  const source = createQsccBlockEvidenceSource({
    channelName: FIXTURE_CHANNEL,
    evaluator: { async evaluate() { return Buffer.alloc(0); } },
  });
  const result = await new IndependentCommitVerifier(source).verifyCommit({
    fabricTransactionId: 'sim-fabric-block-tx-10',
  });
  if (result.verdict !== 'NOT_FOUND' || result.verified !== false) {
    throw new Error(`A qscc miss must be NOT_FOUND (retryable), got ${result.verdict}`);
  }
});

registerTest('TC-DECODE-11', 'CommitVerifier', '[SYNTHETIC WIRE FIXTURE] A payload-hash mismatch cannot become CONFIRMED', async () => {
  const txId = 'sim-fabric-block-tx-11';
  const raw = pbBlock({
    blockNumber: 4245,
    envelopes: [pbEnvelope(txId, 'ubtl-ledger', fixtureSubmitArgs())],
    flags: [0],
  });
  const source = createQsccBlockEvidenceSource({
    channelName: FIXTURE_CHANNEL,
    evaluator: { async evaluate() { return raw; } },
  });
  const result = await new IndependentCommitVerifier(source).verifyCommit({
    fabricTransactionId: txId,
    expectedPayloadHash: 'c'.repeat(64),
  });
  if (result.verdict !== 'INCONSISTENT_EVIDENCE' || result.verified !== false) {
    throw new Error(`A payload-hash mismatch must yield INCONSISTENT_EVIDENCE, got ${result.verdict}`);
  }
  if (result.errorCode !== 'PAYLOAD_HASH_MISMATCH') {
    throw new Error(`Expected PAYLOAD_HASH_MISMATCH, got ${result.errorCode}`);
  }
});

registerTest('TC-DECODE-12', 'CommitVerifier', '[SYNTHETIC WIRE FIXTURE] A non-submit invocation never yields a fabricated payload hash', async () => {
  const txId = 'sim-fabric-block-tx-12';
  const raw = pbBlock({
    blockNumber: 4246,
    envelopes: [pbEnvelope(txId, 'ubtl-ledger', ['QueryTransactionByRequestId', txId])],
    flags: [0],
  });
  const source = createQsccBlockEvidenceSource({
    channelName: FIXTURE_CHANNEL,
    evaluator: { async evaluate() { return raw; } },
  });
  const result = await new IndependentCommitVerifier(source).verifyCommit({
    fabricTransactionId: txId,
    expectedPayloadHash: FIXTURE_PAYLOAD_HASH,
  });
  if (result.verified !== false || result.verdict !== 'EVIDENCE_UNAVAILABLE') {
    throw new Error(`A query invocation must not be read as submit evidence, got ${result.verdict}`);
  }
  if (result.errorCode !== 'PAYLOAD_HASH_UNREADABLE') {
    throw new Error(`Expected PAYLOAD_HASH_UNREADABLE, got ${result.errorCode}`);
  }
});

// =========================================================================
// SUITE 13: OPERATIONAL OBSERVABILITY (PROMPT 04)
// =========================================================================

registerTest('TC-OBS-01', 'Observability', 'Health endpoint reports webhook and reconciliation aggregates without secrets', async () => {
  const config = loadConfig();
  const audit = new AuditService();
  const txService = new TransactionsService(audit);
  const adapter = new MockBlockchainAdapter();
  const webhookService = new WebhookService(config, audit);
  const outboxRepo = new InMemoryOutboxRepository();
  const outboxService = new OutboxService(config, txService, adapter, webhookService, audit, outboxRepo);
  const reconciliationService = new ReconciliationService(config, txService, adapter, audit);
  const auth = new AuthService(config);

  const controller = new GatewayCompatController(auth, txService, outboxService, adapter, {
    webhookMetrics: () => outboxService.getWebhookMetrics(),
    reconciliationMetrics: async () =>
      (await reconciliationService.getMetrics()) as unknown as Record<string, unknown>,
  });

  let body: any = null;
  const res: any = { status: () => res, json: (b: any) => { body = b; } };
  await controller.getHealth({} as any, res);

  if (!body.webhook || body.webhook.pendingCount === undefined) {
    throw new Error('Health response is missing webhook aggregate metrics');
  }
  if (!body.reconciliation || typeof body.reconciliation.totalRuns !== 'number') {
    throw new Error('Health response is missing reconciliation aggregate metrics');
  }
  if (!body.reconciliation.config || body.reconciliation.config.batchSize === undefined) {
    throw new Error('Health response is missing reconciliation configuration');
  }
  const serialized = JSON.stringify(body);
  if (serialized.includes(config.switchingWebhookApiKey)) {
    throw new Error('Health response leaked the Switching webhook API key');
  }
  if (/privatekey|clientkey|clientcert/i.test(serialized)) {
    throw new Error('Health response leaked certificate or private key material');
  }
});

registerTest('TC-OBS-02', 'Observability', 'Health endpoint omits optional aggregates when no providers are injected', async () => {
  const config = loadConfig();
  const audit = new AuditService();
  const txService = new TransactionsService(audit);
  const adapter = new MockBlockchainAdapter();
  const webhookService = new WebhookService(config, audit);
  const outboxRepo = new InMemoryOutboxRepository();
  const outboxService = new OutboxService(config, txService, adapter, webhookService, audit, outboxRepo);
  const auth = new AuthService(config);

  const controller = new GatewayCompatController(auth, txService, outboxService, adapter);
  let body: any = null;
  const res: any = { status: () => res, json: (b: any) => { body = b; } };
  await controller.getHealth({} as any, res);

  if (body.webhook !== undefined || body.reconciliation !== undefined) {
    throw new Error('Health endpoint must omit optional sections when providers are not injected');
  }
  if (body.outbox === undefined || body.worker === undefined) {
    throw new Error('Core health sections must remain intact');
  }
});

registerTest('TC-REGRESS-03', 'Regression', 'All Prompt 00–04 suites remain registered and green', async () => {
  const suiteNames = new Set(testInventory.map((t) => t.suite));
  const expected = [
    'Canonicalization',
    'Hashing',
    'Ingestion',
    'Lifecycle',
    'MockSemantics',
    'Authentication',
    'Persistence',
    'Regression',
    'OutboxWorker',
    'FabricAdapter',
    'WebhookDispatcher',
    'Reconciliation',
    'Observability',
  ];
  for (const s of expected) {
    if (!suiteNames.has(s)) {
      throw new Error(`Missing expected test suite: '${s}'`);
    }
  }
});

// =========================================================================
// SUITE 14: CROSS-APPLICATION INTEGRATION — UBTL <-> SWITCHING (PROMPT 05)
// =========================================================================
// IMPORTANT: every test below uses IN-PROCESS TEST DOUBLES. The "Switching"
// side is a local double that re-implements Switching's documented receive
// contract (HMAC-SHA256 over `${timestamp}.${rawBody}` with its `x-switching-*`
// / `x-gateway-*` header convention, `{ received, applied }` responses, and
// `(gatewayRequestId, status)` deduplication). NO real Switching instance and
// NO real HTTP endpoint were contacted. These are SIMULATED integration tests
// and must never be described as live cross-application verification.

import {
  buildSignedPayload,
  computeHmacSha256Hex,
  verifyInboundSignature,
} from '../src/modules/auth/hmac-signature.ts';
import { MockBlockchainAdapter as E2EMockAdapter } from '../src/modules/blockchain-adapter/mock-adapter.ts';

interface E2EContext {
  config: ReturnType<typeof loadConfig>;
  audit: AuditService;
  txService: TransactionsService;
  adapter: MockBlockchainAdapter;
  webhookService: WebhookService;
  outboxRepo: InMemoryOutboxRepository;
  outboxService: OutboxService;
  auth: AuthService;
  controller: GatewayCompatController;
}

function createE2EContext(configOverrides: Record<string, unknown> = {}): E2EContext {
  // Hermetic security baseline. These simulated integration tests must NOT
  // inherit the operator's live-integration `.env` posture, which enables
  // inbound signature enforcement (SWITCHING_OUTBOUND_SIGNATURE_REQUIRED=true)
  // for the real deployment. Tests that exercise signing declare their own
  // secret/enforcement explicitly through `configOverrides`.
  const config = {
    ...loadConfig(),
    switchingOutboundSigningSecret: '',
    switchingOutboundSignatureRequired: false,
    ...configOverrides,
  };
  const audit = new AuditService();
  const txService = new TransactionsService(audit);
  const adapter = new E2EMockAdapter();
  const webhookService = new WebhookService(config, audit);
  const outboxRepo = new InMemoryOutboxRepository();
  const outboxService = new OutboxService(config, txService, adapter, webhookService, audit, outboxRepo);
  const auth = new AuthService(config);
  const controller = new GatewayCompatController(auth, txService, outboxService, adapter);
  return { config, audit, txService, adapter, webhookService, outboxRepo, outboxService, auth, controller };
}

/** Captures the minimal `status().json()` surface the controller uses. */
function captureResponse() {
  const state: { status: number; body: any } = { status: 0, body: null };
  const res: any = {
    status(code: number) {
      state.status = code;
      return res;
    },
    json(b: any) {
      state.body = b;
      return res;
    },
  };
  return { state, res };
}

interface SubmitRequestOptions {
  apiKey?: string | null;
  correlationId: string;
  idempotencyKey: string;
  transactionType?: string;
  payload?: Record<string, unknown>;
  /** When set, the request is signed the way Switching signs it. */
  signingSecret?: string;
  /** Explicit timestamp override (for replay-window tests). */
  timestamp?: string;
  /** Corrupt the signature hex after computing it. */
  tamperSignature?: boolean;
  /** Send a body that differs from the signed bytes. */
  tamperBody?: boolean;
}

/**
 * Builds a request double shaped exactly like one Switching's
 * `HttpGatewayClient` would send (same headers, same body field names).
 */
function makeSubmitRequest(opts: SubmitRequestOptions) {
  const body = {
    correlationId: opts.correlationId,
    idempotencyKey: opts.idempotencyKey,
    transactionType: opts.transactionType ?? 'SALES',
    payload: opts.payload ?? { invoiceNumber: `INV-${opts.correlationId}`, amount: '42.50', currency: 'IDR' },
  };
  const rawBody = JSON.stringify(body);

  const headers: Record<string, string> = {};
  if (opts.apiKey !== null) headers['x-api-key'] = opts.apiKey ?? 'ubtl_dev_key_secret_switch_2026';

  if (opts.signingSecret) {
    const ts = opts.timestamp ?? String(Date.now());
    let signature = computeHmacSha256Hex(opts.signingSecret, buildSignedPayload(ts, rawBody));
    if (opts.tamperSignature) signature = signature.replace(/.$/, (c) => (c === '0' ? '1' : '0'));
    headers['x-switching-timestamp'] = ts;
    headers['x-switching-signature'] = signature;
  }

  const sentBody = opts.tamperBody
    ? { ...body, payload: { ...body.payload, amount: '999999.00' } }
    : body;
  // A body modified after signing means the RECEIVED bytes differ from the
  // bytes that were signed. Model that faithfully: the signature still covers
  // the original bytes, but the raw body the receiver sees is the modified one.
  const sentRawBody = opts.tamperBody ? JSON.stringify(sentBody) : rawBody;

  return { req: { headers, body: sentBody, rawBody: sentRawBody } as any, rawBody: sentRawBody, body };
}

/** Case-insensitive header read — HTTP header names are not case-sensitive. */
function readHeader(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (k.toLowerCase() === target) return v;
  }
  return undefined;
}

/**
 * Test double for the Switching receiver. Models Switching's documented
 * behaviour: verify the UBTL signature over the exact received bytes, then
 * deduplicate business application by `(gatewayRequestId, status)` so a
 * repeated callback never produces a second business transition.
 */
class SimulatedSwitchingReceiver {
  public readonly appliedTransitions: Array<{ gatewayRequestId: string; status: string }> = [];
  public signatureVerifications = 0;
  public signatureRejections = 0;
  public outOfOrderRejections = 0;
  private readonly processed = new Set<string>();
  private readonly ledger = new Map<string, string>();

  /** Verifies an inbound UBTL callback exactly as the real guard does. */
  receive(dto: {
    gatewayRequestId: string;
    correlationId?: string;
    status: string;
    blockchainTxHash?: string | null;
    errorMessage?: string | null;
  }, headers: Record<string, string>, rawBody: string): { received: boolean; applied: boolean; httpStatus: number } {
    const result = verifyInboundSignature({
      secret: this.secret,
      timestamp: headers['x-gateway-timestamp'],
      rawBody,
      signature: headers['x-gateway-signature'],
      toleranceMs: this.toleranceMs,
    });

    if (this.signatureRequired && !result.valid) {
      this.signatureRejections++;
      return { received: false, applied: false, httpStatus: 401 };
    }
    if (result.valid) this.signatureVerifications++;

    const key = `${dto.gatewayRequestId}:${dto.status}`;
    if (this.processed.has(key)) {
      // Duplicate callback: acknowledge receipt but do NOT re-apply.
      return { received: true, applied: false, httpStatus: 200 };
    }

    // Terminal states are immutable, and a lower-precedence status must not
    // overwrite a higher one (out-of-order protection).
    const rank: Record<string, number> = { submitted: 0, pending: 1, timeout: 2, failed: 3, confirmed: 4 };
    const current = this.ledger.get(dto.gatewayRequestId);
    if (current !== undefined && rank[dto.status] <= rank[current]) {
      this.processed.add(key);
      this.outOfOrderRejections++;
      return { received: true, applied: false, httpStatus: 200 };
    }

    this.processed.add(key);
    this.ledger.set(dto.gatewayRequestId, dto.status);
    this.appliedTransitions.push({ gatewayRequestId: dto.gatewayRequestId, status: dto.status });
    return { received: true, applied: true, httpStatus: 200 };
  }

  /** Transaction status as the simulated Switching would report it. */
  statusOf(gatewayRequestId: string): string | undefined {
    return this.ledger.get(gatewayRequestId);
  }

  constructor(
    private readonly secret = '',
    private readonly toleranceMs = 300000,
    private readonly signatureRequired = false
  ) {}
}

registerTest('TC-E2E-01', 'CrossAppIntegration', 'Successful submission and status propagation to Switching (simulated)', async () => {
  const ctx = createE2EContext();
  const { req } = makeSubmitRequest({ correlationId: 'corr-e2e-01', idempotencyKey: 'idemp-e2e-01' });

  const { state, res } = captureResponse();
  await ctx.controller.submitTransaction(req, res);

  if (state.status !== 202) {
    throw new Error(`Expected HTTP 202 acceptance, got ${state.status}`);
  }
  if (!state.body.gatewayRequestId || state.body.status !== 'pending') {
    throw new Error(`Expected gatewayRequestId + status 'pending', got ${JSON.stringify(state.body)}`);
  }
  // No secret configured in this context -> honestly reported as unverified.
  if (state.body.signatureVerified !== false) {
    throw new Error('Response must report signatureVerified=false when no signing secret is configured');
  }

  // Propagate the confirmed status the way the outbox webhook worker would.
  await ctx.txService.markSubmitted(state.body.gatewayRequestId, 'sim-fabric-e2e-01');
  await ctx.txService.markCommitted(state.body.gatewayRequestId, 5501);
  const tx = await ctx.txService.getById(state.body.gatewayRequestId);

  const receiver = new SimulatedSwitchingReceiver();
  const dto = {
    gatewayRequestId: tx!.gatewayRequestId,
    correlationId: tx!.correlationId,
    status: 'confirmed',
    blockchainTxHash: tx!.fabricTransactionId,
    errorMessage: null,
  };
  const outcome = receiver.receive(dto, {}, JSON.stringify(dto));

  if (!outcome.applied) throw new Error('Simulated Switching did not apply the confirmed status');
  if (tx!.correlationId !== 'corr-e2e-01') throw new Error('Correlation id was not propagated end-to-end');
  if (tx!.blockchainTxHash !== 'sim-fabric-e2e-01') {
    throw new Error('Switching would receive the Fabric transaction id, not the payload hash');
  }
});

registerTest('TC-E2E-02', 'CrossAppIntegration', 'Idempotent duplicate submissions produce one transaction and the same gatewayRequestId', async () => {
  const ctx = createE2EContext();
  const first = makeSubmitRequest({ correlationId: 'corr-e2e-02', idempotencyKey: 'idemp-e2e-02' });

  const a = captureResponse();
  await ctx.controller.submitTransaction(first.req, a.res);
  const b = captureResponse();
  await ctx.controller.submitTransaction(first.req, b.res);

  if (a.state.status !== 202 || b.state.status !== 202) {
    throw new Error(`Both submissions must be accepted, got ${a.state.status}/${b.state.status}`);
  }
  if (a.state.body.gatewayRequestId !== b.state.body.gatewayRequestId) {
    throw new Error('A duplicate idempotent submission returned a different gatewayRequestId');
  }
  const all = await ctx.txService.getAll(100);
  const forCorrelation = all.filter((t) => t.correlationId === 'corr-e2e-02');
  if (forCorrelation.length !== 1) {
    throw new Error(`Expected exactly 1 transaction, found ${forCorrelation.length}`);
  }
});

registerTest('TC-E2E-03', 'CrossAppIntegration', 'Conflicting idempotency key (same key, different payload) is rejected with HTTP 409', async () => {
  const ctx = createE2EContext();
  const first = makeSubmitRequest({ correlationId: 'corr-e2e-03', idempotencyKey: 'idemp-e2e-03' });
  const conflict = makeSubmitRequest({
    correlationId: 'corr-e2e-03',
    idempotencyKey: 'idemp-e2e-03',
    payload: { invoiceNumber: 'INV-E2E-03', amount: '1.00', currency: 'IDR' },
  });

  const a = captureResponse();
  await ctx.controller.submitTransaction(first.req, a.res);
  const b = captureResponse();
  await ctx.controller.submitTransaction(conflict.req, b.res);

  if (b.state.status !== 409) {
    throw new Error(`Expected HTTP 409 for an idempotency conflict, got ${b.state.status}`);
  }
  if (b.state.body.errorCode !== 'IDEMPOTENCY_CONFLICT') {
    throw new Error(`Expected errorCode IDEMPOTENCY_CONFLICT, got '${b.state.body.errorCode}'`);
  }
});

registerTest('TC-E2E-04', 'CrossAppIntegration', 'Authentication failures are rejected with HTTP 401', async () => {
  const ctx = createE2EContext();

  const missing = makeSubmitRequest({ apiKey: null, correlationId: 'corr-e2e-04a', idempotencyKey: 'idemp-e2e-04a' });
  const a = captureResponse();
  await ctx.controller.submitTransaction(missing.req, a.res);
  if (a.state.status !== 401 || a.state.body.errorCode !== 'UNAUTHORIZED') {
    throw new Error(`Missing key must yield 401 UNAUTHORIZED, got ${a.state.status} ${a.state.body?.errorCode}`);
  }

  const wrong = makeSubmitRequest({ apiKey: 'not-the-right-key', correlationId: 'corr-e2e-04b', idempotencyKey: 'idemp-e2e-04b' });
  const b = captureResponse();
  await ctx.controller.submitTransaction(wrong.req, b.res);
  if (b.state.status !== 401) {
    throw new Error(`Wrong key must yield 401, got ${b.state.status}`);
  }

  const noneCreated = (await ctx.txService.getAll(100)).length;
  if (noneCreated !== 0) {
    throw new Error('An unauthenticated request must never persist a transaction');
  }
});

registerTest('TC-E2E-05', 'CrossAppIntegration', 'A valid Switching HMAC signature is accepted and reported as verified', async () => {
  const secret = 'shared-outbound-secret-e2e-05';
  const ctx = createE2EContext({ switchingOutboundSigningSecret: secret });
  const { req } = makeSubmitRequest({
    correlationId: 'corr-e2e-05',
    idempotencyKey: 'idemp-e2e-05',
    signingSecret: secret,
  });

  const { state, res } = captureResponse();
  await ctx.controller.submitTransaction(req, res);

  if (state.status !== 202) throw new Error(`Expected 202, got ${state.status}`);
  if (state.body.signatureVerified !== true) {
    throw new Error('A correctly signed request must be reported as signatureVerified=true');
  }
});

registerTest('TC-E2E-06', 'CrossAppIntegration', 'A tampered body or signature is rejected with HTTP 401 when enforcement is on', async () => {
  const secret = 'shared-outbound-secret-e2e-06';
  const ctx = createE2EContext({
    switchingOutboundSigningSecret: secret,
    switchingOutboundSignatureRequired: true,
  });

  // (a) signature corrupted
  const tamperedSig = makeSubmitRequest({
    correlationId: 'corr-e2e-06a',
    idempotencyKey: 'idemp-e2e-06a',
    signingSecret: secret,
    tamperSignature: true,
  });
  const a = captureResponse();
  await ctx.controller.submitTransaction(tamperedSig.req, a.res);
  if (a.state.status !== 401 || a.state.body.errorCode !== 'INVALID_SIGNATURE') {
    throw new Error(`Tampered signature must yield 401 INVALID_SIGNATURE, got ${a.state.status} ${a.state.body?.errorCode}`);
  }

  // (b) valid signature, but the body was modified in transit
  const tamperedBody = makeSubmitRequest({
    correlationId: 'corr-e2e-06b',
    idempotencyKey: 'idemp-e2e-06b',
    signingSecret: secret,
    tamperBody: true,
  });
  const b = captureResponse();
  await ctx.controller.submitTransaction(tamperedBody.req, b.res);
  if (b.state.status !== 401) {
    throw new Error(`A body modified after signing must yield 401, got ${b.state.status}`);
  }

  if ((await ctx.txService.getAll(100)).length !== 0) {
    throw new Error('A request that fails signature verification must never persist a transaction');
  }
});

registerTest('TC-E2E-07', 'CrossAppIntegration', 'A stale signature timestamp outside the tolerance window is rejected (replay protection)', async () => {
  const secret = 'shared-outbound-secret-e2e-07';
  const ctx = createE2EContext({
    switchingOutboundSigningSecret: secret,
    switchingOutboundSignatureRequired: true,
    signatureToleranceMs: 60000,
  });
  const { req } = makeSubmitRequest({
    correlationId: 'corr-e2e-07',
    idempotencyKey: 'idemp-e2e-07',
    signingSecret: secret,
    // Correctly signed, but 10 minutes old -> outside a 60s window.
    timestamp: String(Date.now() - 10 * 60 * 1000),
  });

  const { state, res } = captureResponse();
  await ctx.controller.submitTransaction(req, res);
  if (state.status !== 401) {
    throw new Error(`A replayed (stale) signed request must be rejected, got ${state.status}`);
  }
});

registerTest('TC-E2E-08', 'CrossAppIntegration', 'A configured-but-not-enforced secret accepts the request while reporting it as unverified', async () => {
  const secret = 'shared-outbound-secret-e2e-08';
  const ctx = createE2EContext({
    switchingOutboundSigningSecret: secret,
    switchingOutboundSignatureRequired: false,
  });
  // Deliberately unsigned: the graceful-rollout window must accept it...
  const { req } = makeSubmitRequest({ correlationId: 'corr-e2e-08', idempotencyKey: 'idemp-e2e-08' });

  const { state, res } = captureResponse();
  await ctx.controller.submitTransaction(req, res);

  if (state.status !== 202) {
    throw new Error(`Graceful-rollout mode must accept an unsigned request, got ${state.status}`);
  }
  // ...but it must NOT claim the request was cryptographically verified.
  if (state.body.signatureVerified !== false) {
    throw new Error('An unsigned request must never be reported as signatureVerified=true');
  }
});

registerTest('TC-E2E-09', 'CrossAppIntegration', 'UBTL outbound webhook signature verifies against Switching guard semantics (simulated)', async () => {
  const secret = 'shared-webhook-secret-e2e-09';
  const ctx = createE2EContext({ switchingWebhookSigningSecret: secret });
  const payload = {
    gatewayRequestId: 'gw-e2e-09',
    correlationId: 'corr-e2e-09',
    status: 'confirmed' as const,
    blockchainTxHash: 'sim-fabric-e2e-09',
    errorMessage: null,
  };

  let captured: { headers: Record<string, string>; body: string } | null = null;
  await withStubbedFetch(
    async (_url, init) => {
      captured = { headers: init?.headers ?? {}, body: init?.body ?? '' };
      return { ok: true, status: 200, json: async () => ({ received: true, applied: true }) };
    },
    async () => {
      const result = await ctx.webhookService.deliverWebhook(payload);
      if (!result.success) throw new Error('Stubbed webhook delivery did not succeed');
    }
  );

  if (!captured) throw new Error('No webhook request was captured');
  const sig = readHeader(captured['headers'], 'x-gateway-signature');
  const ts = readHeader(captured['headers'], 'x-gateway-timestamp');
  if (!sig || !ts) {
    throw new Error('Signed delivery must carry x-gateway-signature and x-gateway-timestamp headers');
  }

  // Verify exactly the way Switching's guard does, over the bytes it received.
  const verified = verifyInboundSignature({
    secret,
    timestamp: ts,
    rawBody: captured['body'],
    signature: sig,
    toleranceMs: 300000,
  });
  if (!verified.valid) {
    throw new Error(`Switching's guard would reject UBTL's signature: ${verified.reason}`);
  }

  // The signed body must carry the logical event identity unchanged.
  const parsed = JSON.parse(captured['body']);
  if (parsed.gatewayRequestId !== payload.gatewayRequestId || parsed.status !== payload.status) {
    throw new Error('Signed webhook body does not carry the original logical event identity');
  }
});

registerTest('TC-E2E-10', 'CrossAppIntegration', 'No signature headers are sent when no webhook signing secret is configured', async () => {
  const ctx = createE2EContext({ switchingWebhookSigningSecret: '' });
  let capturedHeaders: Record<string, string> = {};
  await withStubbedFetch(
    async (_url, init) => {
      capturedHeaders = init?.headers ?? {};
      return { ok: true, status: 200, json: async () => ({ received: true, applied: true }) };
    },
    async () => {
      await ctx.webhookService.deliverWebhook({
        gatewayRequestId: 'gw-e2e-10',
        correlationId: 'corr-e2e-10',
        status: 'pending',
        blockchainTxHash: null,
        errorMessage: null,
      });
    }
  );

  if (readHeader(capturedHeaders, 'x-gateway-signature') || readHeader(capturedHeaders, 'x-gateway-timestamp')) {
    throw new Error('Unsigned mode must not emit signature headers');
  }
  if (!readHeader(capturedHeaders, 'x-api-key')) {
    throw new Error('The shared API key header must still be present');
  }
});

registerTest('TC-E2E-11', 'CrossAppIntegration', 'Duplicate callback delivery is handled safely by the receiver (no duplicate business transition)', async () => {
  const receiver = new SimulatedSwitchingReceiver();
  const dto = {
    gatewayRequestId: 'gw-e2e-11',
    correlationId: 'corr-e2e-11',
    status: 'confirmed',
    blockchainTxHash: 'sim-fabric-e2e-11',
    errorMessage: null,
  };
  const body = JSON.stringify(dto);

  const first = receiver.receive(dto, {}, body);
  const second = receiver.receive(dto, {}, body);

  if (!first.applied) throw new Error('The first callback must be applied');
  if (second.applied) throw new Error('A duplicate callback must not be re-applied');
  if (!second.received) throw new Error('A duplicate callback must still be acknowledged (at-least-once sender)');
  if (receiver.appliedTransitions.length !== 1) {
    throw new Error(`Expected exactly 1 business transition, got ${receiver.appliedTransitions.length}`);
  }
});

registerTest('TC-E2E-12', 'CrossAppIntegration', 'Out-of-order and repeated callbacks do not regress Switching status', async () => {
  const receiver = new SimulatedSwitchingReceiver();

  const confirmed = { gatewayRequestId: 'gw-e2e-12', correlationId: 'corr-e2e-12', status: 'confirmed', blockchainTxHash: 'h', errorMessage: null };
  const submitted = { ...confirmed, status: 'submitted' };

  const c = receiver.receive(confirmed, {}, JSON.stringify(confirmed));
  if (!c.applied) throw new Error('The confirmed callback must be applied');

  // A late-arriving, lower-precedence duplicate must be ignored, not applied.
  const late = receiver.receive(submitted, {}, JSON.stringify(submitted));
  if (late.applied) throw new Error('A stale out-of-order callback must not be applied');
  if (receiver.statusOf('gw-e2e-12') !== 'confirmed') {
    throw new Error('An out-of-order callback regressed the receiver status');
  }
  if (receiver.outOfOrderRejections !== 1) {
    throw new Error('The out-of-order callback was not recorded as rejected');
  }
});

registerTest('TC-E2E-13', 'CrossAppIntegration', 'Webhook timeout is ambiguous and retry preserves the logical event identity', async () => {
  const ctx = createE2EContext();
  const payload = {
    gatewayRequestId: 'gw-e2e-13',
    correlationId: 'corr-e2e-13',
    status: 'confirmed' as const,
    blockchainTxHash: 'sim-fabric-e2e-13',
    errorMessage: null,
  };

  const seen: Array<{ headers: Record<string, string>; body: string }> = [];
  await withStubbedFetch(
    async (_url, init) => {
      seen.push({ headers: init?.headers ?? {}, body: init?.body ?? '' });
      if (seen.length === 1) {
        const err: any = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        throw err;
      }
      return { ok: true, status: 200, json: async () => ({ received: true, applied: true }) };
    },
    async () => {
      const firstTry = await ctx.webhookService.deliverWebhook(payload, 1);
      if (firstTry.success) throw new Error('A timed-out attempt must not be reported as a success');
      if (firstTry.classification !== 'AMBIGUOUS') {
        throw new Error(`A client timeout must classify as AMBIGUOUS, got '${firstTry.classification}'`);
      }
      const retry = await ctx.webhookService.deliverWebhook(payload, 2);
      if (!retry.success) throw new Error('The retry against the healthy receiver must succeed');
    }
  );

  if (seen.length !== 2) throw new Error(`Expected 2 delivery attempts, saw ${seen.length}`);
  if (seen[0].body !== seen[1].body) {
    throw new Error('The retry body changed — logical event identity was not preserved');
  }
  const first = ctx.webhookService.getRecentDeliveries()[1];
  const second = ctx.webhookService.getRecentDeliveries()[0];
  if (first.payload.gatewayRequestId !== second.payload.gatewayRequestId) {
    throw new Error('The retry changed the gatewayRequestId');
  }
  if (ctx.webhookService.getDeliveryMetrics().ambiguousCount !== 1) {
    throw new Error('The ambiguous timeout was not counted honestly');
  }
});

registerTest('TC-E2E-14', 'CrossAppIntegration', 'Failure recovery never fabricates a confirmation without provider evidence', async () => {
  const audit = new AuditService();
  const txService = new TransactionsService(audit);
  let evidenceAvailable = false;

  const adapter: any = {
    mode: 'mock',
    initialize: async () => {},
    submitProposal: async () => ({ accepted: true, fabricTransactionId: 'sim', status: 'PENDING', isSimulated: true }),
    queryCommitStatus: async () => ({ status: 'PENDING', fabricTransactionId: null, blockNumber: null, isSimulated: true }),
    findTransactionByIdempotencyKey: async () =>
      evidenceAvailable
        ? { fabricTransactionId: 'sim-fabric-e2e-14', status: 'CONFIRMED', blockNumber: 6601, commitTimestamp: new Date().toISOString(), isSimulated: true }
        : null,
    getTransactionProof: async () => null,
    healthCheck: async () => ({ status: 'online', mode: 'mock', isSimulated: true, peerEndpoint: 'sim', channelName: 'sim', currentBlockHeight: 1, latencyMs: 0, details: 'simulated' }),
  };

  const service = new ReconciliationService(loadConfig(), txService, adapter, audit);
  const ingest = await txService.ingest({
    correlationId: 'corr-e2e-14',
    idempotencyKey: 'idemp-e2e-14',
    transactionType: 'SALES',
    payload: { invoiceNumber: 'INV-E2E-14', amount: '7.00', currency: 'IDR' },
    organizationId: 'org-e2e',
  });
  await txService.markSubmitted(ingest.gatewayRequestId, 'sim-fabric-e2e-14');
  await txService.markTimeout(ingest.gatewayRequestId, 'Ambiguous provider timeout');

  // No evidence yet -> must stay unresolved, never a false success.
  const noEvidence = await service.runReconciliation();
  if (noEvidence.confirmed !== 0) {
    throw new Error('Reconciliation confirmed without provider evidence');
  }
  let tx = await txService.getById(ingest.gatewayRequestId);
  if (tx?.lifecycleState !== 'RECONCILIATION_REQUIRED') {
    throw new Error(`Expected RECONCILIATION_REQUIRED preserved, got ${tx?.lifecycleState}`);
  }

  // Evidence arrives -> now it may be confirmed.
  evidenceAvailable = true;
  const withEvidence = await service.runReconciliation();
  if (withEvidence.confirmed !== 1) {
    throw new Error('Reconciliation did not confirm after real evidence arrived');
  }
  tx = await txService.getById(ingest.gatewayRequestId);
  if (tx?.lifecycleState !== 'COMMITTED' || tx?.blockNumber !== 6601) {
    throw new Error('Evidence did not advance the transaction to COMMITTED');
  }
});

registerTest('TC-E2E-15', 'CrossAppIntegration', 'The payload SHA-256 hash is never confused with the Fabric transaction id', async () => {
  const ctx = createE2EContext();
  const { req, body } = makeSubmitRequest({ correlationId: 'corr-e2e-15', idempotencyKey: 'idemp-e2e-15' });

  const a = captureResponse();
  await ctx.controller.submitTransaction(req, a.res);
  const gatewayRequestId = a.state.body.gatewayRequestId;

  await ctx.txService.markSubmitted(gatewayRequestId, 'sim-fabric-e2e-15');
  await ctx.txService.markCommitted(gatewayRequestId, 7701);

  // The status projection Switching consumes.
  const b = captureResponse();
  await ctx.controller.getTransactionStatus({ headers: { 'x-api-key': 'ubtl_dev_key_secret_switch_2026' }, params: { gatewayRequestId } } as any, b.res);

  const payloadHash = b.state.body.payloadHash;
  if (!payloadHash || !/^[0-9a-f]{64}$/.test(payloadHash)) {
    throw new Error('payloadHash is not a SHA-256 hex digest');
  }
  if (b.state.body.fabricTransactionId === payloadHash) {
    throw new Error('fabricTransactionId must never equal the payload hash');
  }
  if (b.state.body.blockchainTxHash === payloadHash) {
    throw new Error('blockchainTxHash must never be the payload hash');
  }
  if (b.state.body.blockchainTxHash !== 'sim-fabric-e2e-15') {
    throw new Error(`Expected blockchainTxHash to be the provider transaction id, got '${b.state.body.blockchainTxHash}'`);
  }
  // The webhook carries the provider id, never the payload hash.
  if (b.state.body.fabricTransactionId !== 'sim-fabric-e2e-15') {
    throw new Error('fabricTransactionId is not the provider transaction id');
  }
  if (JSON.stringify(body).includes(payloadHash)) {
    throw new Error('The outbound request echoed the payload hash (server-side derivation expected)');
  }
});

registerTest('TC-E2E-16', 'CrossAppIntegration', 'Enabling signature enforcement without a shared secret fails fast at startup', () => {
  const savedRequired = process.env.SWITCHING_OUTBOUND_SIGNATURE_REQUIRED;
  const savedSecret = process.env.SWITCHING_OUTBOUND_SIGNING_SECRET;
  const savedTolerance = process.env.SIGNATURE_TOLERANCE_MS;

  process.env.SWITCHING_OUTBOUND_SIGNATURE_REQUIRED = 'true';
  delete process.env.SWITCHING_OUTBOUND_SIGNING_SECRET;

  try {
    const result = validateEnvironment();
    if (result.isValid) {
      throw new Error('Enforcement without a secret must be rejected, not silently accepted');
    }
    if (!result.errors.some((e) => e.includes('SIGNATURE_FAIL_FAST'))) {
      throw new Error('The failure was not reported as a signature misconfiguration');
    }
  } finally {
    if (savedRequired === undefined) delete process.env.SWITCHING_OUTBOUND_SIGNATURE_REQUIRED;
    else process.env.SWITCHING_OUTBOUND_SIGNATURE_REQUIRED = savedRequired;
    if (savedSecret !== undefined) process.env.SWITCHING_OUTBOUND_SIGNING_SECRET = savedSecret;
    if (savedTolerance === undefined) delete process.env.SIGNATURE_TOLERANCE_MS;
    else process.env.SIGNATURE_TOLERANCE_MS = savedTolerance;
  }

  // And a bad tolerance value must also be rejected.
  process.env.SIGNATURE_TOLERANCE_MS = '-5';
  try {
    const bad = validateEnvironment();
    if (bad.isValid) throw new Error('A negative SIGNATURE_TOLERANCE_MS must be rejected');
  } finally {
    if (savedTolerance === undefined) delete process.env.SIGNATURE_TOLERANCE_MS;
    else process.env.SIGNATURE_TOLERANCE_MS = savedTolerance;
  }
});

registerTest('TC-REGRESS-04', 'Regression', 'All Prompt 00–05 suites remain registered and green', async () => {
  const suiteNames = new Set(testInventory.map((t) => t.suite));
  const expected = [
    'Canonicalization',
    'Hashing',
    'Ingestion',
    'Lifecycle',
    'MockSemantics',
    'Authentication',
    'Persistence',
    'Regression',
    'OutboxWorker',
    'FabricAdapter',
    'WebhookDispatcher',
    'Reconciliation',
    'Observability',
    'CrossAppIntegration',
  ];
  for (const s of expected) {
    if (!suiteNames.has(s)) {
      throw new Error(`Missing expected test suite: '${s}'`);
    }
  }
});

// =========================================================================
// SUITE 15: DEFECT REGRESSION (PROMPT 09 — D-1 PORT CONFIG, D-2 TIMING-SAFE KEY COMPARISON, H-1 NON-UUID BOUNDARY)
// =========================================================================

registerTest('TC-REGRESS-01', 'Defect Regression', 'D-1: PORT environment variable is honored (default 3000, custom value applied, invalid value rejected)', async () => {
  const original = process.env.PORT;
  try {
    delete process.env.PORT;
    if (loadConfig().port !== 3000) {
      throw new Error('Port must default to 3000 when PORT is unset');
    }

    process.env.PORT = '4123';
    const configured = loadConfig().port;
    if (configured !== 4123) {
      throw new Error(`loadConfig() ignored PORT: expected 4123, received ${configured}`);
    }

    process.env.PORT = 'not-a-port';
    let rejected = false;
    try {
      loadConfig();
    } catch (err) {
      rejected = (err instanceof Error ? err.message : String(err)).includes('Invalid PORT');
    }
    if (!rejected) {
      throw new Error('An invalid PORT must fail validation instead of being silently coerced to NaN');
    }
  } finally {
    if (original === undefined) {
      delete process.env.PORT;
    } else {
      process.env.PORT = original;
    }
  }
});

registerTest('TC-REGRESS-02', 'Defect Regression', 'D-2: API key comparison is constant-time and accepts only exact matches (including differing lengths)', async () => {
  const config = loadConfig();
  const auth = new AuthService(config);

  if (!auth.validateSwitchingApiKey(config.ubtlApiKey)) {
    throw new Error('Exact switching API key must be accepted');
  }

  // A naive timingSafeEqual would throw on a length mismatch; the shipped
  // implementation must instead return a plain rejection.
  const lookalikes = [
    config.ubtlApiKey.slice(0, -1),
    `${config.ubtlApiKey}x`,
    `${config.ubtlApiKey.slice(0, -1)}X`,
    'wrong_key',
    '',
  ];
  for (const candidate of lookalikes) {
    if (auth.validateSwitchingApiKey(candidate) !== null) {
      throw new Error(`Lookalike credential was accepted: "${candidate}"`);
    }
  }

  if (!auth.validateAdminApiKey(config.ubtlAdminApiKey)) {
    throw new Error('Exact admin API key must be accepted');
  }
  if (auth.validateAdminApiKey(config.ubtlApiKey) !== null) {
    throw new Error('Switching API key must not authenticate as the admin key');
  }
});

/**
 * Test double standing in for the PostgreSQL repository: a UUID-typed column
 * rejects any non-UUID value with Prisma's P2023, raised from inside the driver.
 * Using it here proves the API boundary — not the persistence layer — is what
 * keeps the process alive.
 */
class NonUuidRejectingRepository extends InMemoryTransactionRepository {
  public findCalls: string[] = [];
  async findByGatewayRequestId(gatewayRequestId: string): Promise<any> {
    this.findCalls.push(gatewayRequestId);
    if (
      !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
        gatewayRequestId
      )
    ) {
      const err: any = new Error(
        `Inconsistent column data: Error creating UUID, invalid character found at 1`
      );
      err.code = 'P2023';
      throw err;
    }
    return super.findByGatewayRequestId(gatewayRequestId);
  }
}

registerTest('TC-REGRESS-05', 'Defect Regression', 'H-1: every endpoint accepting a gatewayRequestId rejects non-UUID ids without an unhandled rejection', async () => {
  const config = loadConfig();
  const audit = new AuditService();
  const repo = new NonUuidRejectingRepository();
  const txService = new TransactionsService(audit, undefined, undefined, repo);
  const adapter = new MockBlockchainAdapter();
  const webhookService = new WebhookService(config, audit);
  const outboxService = new OutboxService(config, txService, adapter, webhookService, audit);
  const controller = new GatewayCompatController(
    new AuthService(config),
    txService,
    outboxService,
    adapter
  );

  const invoke = async (fn: (req: any, res: any) => Promise<void>, req: any) => {
    let statusCode = 0;
    let body: any = null;
    const res: any = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(payload: any) {
        body = payload;
      },
    };
    await fn(req, res);
    return { statusCode, body };
  };

  // The legacy peer identifier from the reported defect: a prefixed UUID.
  const legacyIds = [`gw-corr-${randomUUID()}`, 'gw-1', 'not-a-uuid', '123'];

  for (const legacyId of legacyIds) {
    const status = await invoke(controller.getTransactionStatus.bind(controller), {
      headers: { 'x-api-key': config.ubtlApiKey },
      params: { gatewayRequestId: legacyId },
    });
    if (status.statusCode !== 400 || status.body?.errorCode !== 'INVALID_GATEWAY_REQUEST_ID') {
      throw new Error(
        `GET must reject non-UUID '${legacyId}' with HTTP 400 INVALID_GATEWAY_REQUEST_ID, got ${status.statusCode} ${status.body?.errorCode}`
      );
    }

    const verify = await invoke(controller.verifyTransaction.bind(controller), {
      headers: { 'x-api-key': config.ubtlApiKey },
      body: { gatewayRequestId: legacyId },
    });
    if (verify.statusCode !== 400 || verify.body?.errorCode !== 'INVALID_GATEWAY_REQUEST_ID') {
      throw new Error(
        `POST /v1/transactions/verify must reject non-UUID '${legacyId}' with HTTP 400 INVALID_GATEWAY_REQUEST_ID, got ${verify.statusCode} ${verify.body?.errorCode}`
      );
    }
  }

  // The guard must short-circuit BEFORE persistence: a malformed id must never
  // reach the UUID-typed column that raises P2023.
  const leaked = repo.findCalls.filter((id) => !/^[0-9a-fA-F-]{36}$/.test(id));
  if (leaked.length > 0) {
    throw new Error(
      `Non-UUID identifiers reached the persistence layer and would raise P2023 as an unhandled rejection: ${leaked.join(', ')}`
    );
  }

  // A well-formed but unknown UUID must still traverse the normal 404 path.
  const unknownUuid = randomUUID();
  const unknown = await invoke(controller.getTransactionStatus.bind(controller), {
    headers: { 'x-api-key': config.ubtlApiKey },
    params: { gatewayRequestId: unknownUuid },
  });
  if (unknown.statusCode !== 404 || unknown.body?.errorCode !== 'TRANSACTION_NOT_FOUND') {
    throw new Error(
      `A valid unknown UUID must produce HTTP 404 TRANSACTION_NOT_FOUND, got ${unknown.statusCode} ${unknown.body?.errorCode}`
    );
  }
  if (!repo.findCalls.includes(unknownUuid)) {
    throw new Error('A valid UUID must reach the durable lookup path');
  }

  // A persistence failure on the verify path must surface as HTTP 500, not as an
  // unhandled rejection that terminates the process.
  class ThrowingLookupRepository extends InMemoryTransactionRepository {
    async findByGatewayRequestId(): Promise<any> {
      throw new Error('durable database unavailable');
    }
  }
  const failingTxService = new TransactionsService(audit, undefined, undefined, new ThrowingLookupRepository());
  const failingController = new GatewayCompatController(
    new AuthService(config),
    failingTxService,
    outboxService,
    adapter
  );
  const failing = await invoke(failingController.verifyTransaction.bind(failingController), {
    headers: { 'x-api-key': config.ubtlApiKey },
    body: { gatewayRequestId: randomUUID() },
  });
  if (failing.statusCode !== 500 || failing.body?.errorCode !== 'LOOKUP_FAILED') {
    throw new Error(
      `A persistence failure on the verify path must yield HTTP 500, got ${failing.statusCode} ${failing.body?.errorCode}`
    );
  }
});

// =========================================================================
// TEST RUNNER EXECUTION
// =========================================================================
async function executeTestRunner() {
  const suiteCount = new Set(testInventory.map((t) => t.suite)).size;
  console.log('================================================================================');
  console.log(' UBTL TEST SUITE — PROMPTS 00–05, 09.7 (CANONICALIZATION, OUTBOX, WORKER, FABRIC ADAPTER, WEBHOOKS, RECONCILIATION, CROSS-APP INTEGRATION, INDEPENDENT COMMIT VERIFIER)');
  console.log('================================================================================');
  console.log(`Discovered: ${testInventory.length} formal test cases across ${suiteCount} suites.\n`);

  let passedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  const failures: { id: string; name: string; error: string }[] = [];

  let currentSuite = '';

  for (const test of testInventory) {
    if (test.suite !== currentSuite) {
      currentSuite = test.suite;
      console.log(`\n--- ${currentSuite} Suite ---`);
    }

    try {
      const outcome = await test.run();
      if (outcome === 'SKIP') {
        console.log(`  [SKIP] [${test.id}] ${test.name} (infrastructure unavailable / opt-in not enabled)`);
        skippedCount++;
        continue;
      }
      console.log(`  [PASS] [${test.id}] ${test.name}`);
      passedCount++;
    } catch (err: any) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`  [FAIL] [${test.id}] ${test.name} -> ${errorMsg}`);
      failedCount++;
      failures.push({ id: test.id, name: test.name, error: errorMsg });
    }
  }

  console.log('\n================================================================================');
  console.log(` TEST SUMMARY:`);
  console.log(` Discovered: ${testInventory.length}`);
  console.log(` Executed:   ${passedCount + failedCount}`);
  console.log(` Passed:     ${passedCount}`);
  console.log(` Failed:     ${failedCount}`);
  console.log(` Skipped:    ${skippedCount}`);
  console.log(` Suites:     ${suiteCount}`);
  console.log('================================================================================\n');

  if (failedCount > 0) {
    console.error(`FAILURE DETAILS (${failedCount}):`);
    for (const f of failures) {
      console.error(`- [${f.id}] ${f.name}: ${f.error}`);
    }
    process.exit(1);
  }
}

executeTestRunner().catch((e) => {
  console.error('Test runner fatal error:', e);
  process.exit(1);
});
