/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * =============================================================================
 * UBTL LEDGER CHAINCODE — LOCAL CONTRACT TESTS
 * =============================================================================
 *
 * Runs with Node's built-in test runner against an in-memory fake stub: no
 * Fabric peer, no Docker, no credentials. Covers the ten cases required by the
 * chaincode acceptance list.
 *
 *   node --import tsx --test chaincode/ubtl-ledger/test/contract.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { UbtlLedgerContract } from '../src/contract.ts';
import { createLedgerContextFromStub, timestampToIso } from '../src/fabric-binding.ts';
import {
  FabricStubLike,
  STATE_KEY_PREFIX,
  UbtlCommitProof,
  UbtlLedgerError,
  UbtlLedgerErrorCode,
  decodeUtf8,
  encodeUtf8,
  recordKey,
} from '../src/types.ts';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const REQ_1 = '11111111-1111-4111-8111-111111111111';
const REQ_2 = '22222222-2222-4222-8222-222222222222';
const TS = '2026-10-25T12:00:00.000Z';

class FakeStub implements FabricStubLike {
  readonly state = new Map<string, Uint8Array>();
  constructor(
    private readonly mspId: string = 'UBTLMSP',
    private readonly txId: string = 'fabric-tx-0001'
  ) {}

  async getState(key: string): Promise<Uint8Array> {
    return this.state.get(key) ?? new Uint8Array(0);
  }

  async putState(key: string, value: Uint8Array): Promise<void> {
    this.state.set(key, value);
  }

  getTxId(): string {
    return this.txId;
  }

  getMspId(): string {
    return this.mspId;
  }

  getTxTimestamp(): { seconds: number; nanos: number } {
    return { seconds: 1792935123, nanos: 0 };
  }

  keysWithPrefix(prefix: string): string[] {
    return [...this.state.keys()].filter((k) => k.startsWith(prefix));
  }

  readJson(key: string): unknown {
    const raw = this.state.get(key);
    return raw ? JSON.parse(decodeUtf8(raw)) : undefined;
  }
}

function makeContract(): { contract: UbtlLedgerContract; stub: FakeStub } {
  return { contract: new UbtlLedgerContract(), stub: new FakeStub() };
}

async function submit(
  contract: UbtlLedgerContract,
  stub: FakeStub,
  overrides: Partial<Record<'hash' | 'req' | 'idem' | 'type' | 'corr' | 'ts', string>> = {}
): Promise<Uint8Array> {
  const ctx = createLedgerContextFromStub(stub);
  return contract.submitTransactionProposal(
    ctx,
    overrides.hash ?? HASH_A,
    overrides.type ?? 'PURCHASE_ORDER',
    overrides.corr ?? 'corr-1',
    overrides.ts ?? TS,
    overrides.req ?? REQ_1,
    overrides.idem ?? 'idem-1'
  );
}

// ---------------------------------------------------------------------------
// 1. First submission produces exactly one logical record.
// ---------------------------------------------------------------------------
test('01 — first submit creates exactly one logical record with adapter-supplied anchors', async () => {
  const { contract, stub } = makeContract();
  const result = await submit(contract, stub);

  const record = JSON.parse(decodeUtf8(result));
  assert.equal(record.payloadHash, HASH_A);
  assert.equal(record.gatewayRequestId, REQ_1);
  assert.equal(record.idempotencyKey, 'idem-1');
  assert.equal(record.fabricTransactionId, 'fabric-tx-0001');
  assert.equal(record.submittingMspId, 'UBTLMSP');
  assert.equal(record.ledgerWriteTimestamp, timestampToIso(stub.getTxTimestamp()));
  assert.equal(record.schemaVersion, 1);

  assert.equal(stub.keysWithPrefix(STATE_KEY_PREFIX.RECORD).length, 1);
  assert.equal(stub.keysWithPrefix(STATE_KEY_PREFIX.REQUEST_INDEX).length, 1);
  assert.equal(stub.keysWithPrefix(STATE_KEY_PREFIX.FABRIC_TX_INDEX).length, 1);

  // No business payload and no block-level evidence may be persisted.
  assert.equal('payload' in record, false);
  assert.equal('blockNumber' in record, false);
  assert.equal('blockHash' in record, false);
});

// ---------------------------------------------------------------------------
// 2. Replay with identical key + hash does not duplicate the record.
// ---------------------------------------------------------------------------
test('02 — replay with same idempotency key and same payloadHash does not duplicate', async () => {
  const { contract, stub } = makeContract();
  const first = await submit(contract, stub);
  const second = await submit(contract, stub);

  assert.equal(decodeUtf8(first), decodeUtf8(second));
  assert.equal(stub.keysWithPrefix(STATE_KEY_PREFIX.RECORD).length, 1);
  assert.equal(stub.state.size, 3);
});

// ---------------------------------------------------------------------------
// 3. Same key, different hash -> permanent IDEMPOTENCY_CONFLICT.
// ---------------------------------------------------------------------------
test('03 — same idempotency key with a different payloadHash is IDEMPOTENCY_CONFLICT', async () => {
  const { contract, stub } = makeContract();
  await submit(contract, stub);

  await assert.rejects(
    () => submit(contract, stub, { hash: HASH_B }),
    (err: unknown) =>
      err instanceof UbtlLedgerError && err.code === UbtlLedgerErrorCode.IDEMPOTENCY_CONFLICT
  );

  // The conflicting write must not have altered the stored record.
  const stored = stub.readJson(recordKey('idem-1')) as { payloadHash: string };
  assert.equal(stored.payloadHash, HASH_A);
  assert.equal(stub.keysWithPrefix(STATE_KEY_PREFIX.RECORD).length, 1);
});

// ---------------------------------------------------------------------------
// 4. Unknown request id -> agreed miss representation (empty payload).
// ---------------------------------------------------------------------------
test('04 — lookup of an unknown gatewayRequestId returns the agreed empty miss', async () => {
  const { contract, stub } = makeContract();
  const ctx = createLedgerContextFromStub(stub);

  const miss = await contract.queryTransactionByRequestId(ctx, REQ_2);
  assert.equal(miss.length, 0);

  await submit(contract, stub);
  const hit = await contract.queryTransactionByRequestId(ctx, REQ_1);
  assert.equal((JSON.parse(decodeUtf8(hit)) as { payloadHash: string }).payloadHash, HASH_A);
  assert.equal(stub.keysWithPrefix(STATE_KEY_PREFIX.RECORD).length, 1);
});

// ---------------------------------------------------------------------------
// 5. Invalid input is rejected explicitly.
// ---------------------------------------------------------------------------
test('05 — invalid input is rejected with INVALID_ARGUMENT', async () => {
  const { contract, stub } = makeContract();

  const badInputs: Array<Partial<Record<'hash' | 'req' | 'idem' | 'ts', string>>> = [
    { hash: 'not-a-hash' },
    { hash: HASH_A.toUpperCase() },
    { hash: HASH_A.slice(0, 63) },
    { ts: 'not-a-timestamp' },
    { req: '' },
    { idem: 'x'.repeat(129) },
  ];

  for (const bad of badInputs) {
    await assert.rejects(
      () => submit(contract, stub, bad),
      (err: unknown) =>
        err instanceof UbtlLedgerError && err.code === UbtlLedgerErrorCode.INVALID_ARGUMENT,
      `expected INVALID_ARGUMENT for ${JSON.stringify(bad).slice(0, 60)}`
    );
  }

  // A rejected submission must leave no partial ledger state behind.
  assert.equal(stub.state.size, 0);
});

// ---------------------------------------------------------------------------
// 6. A payloadHash mismatch can never surface as a confirmed commit.
// ---------------------------------------------------------------------------
test('06 — a payloadHash mismatch is never reported as a confirmed commit', async () => {
  const { contract, stub } = makeContract();
  const ctx = createLedgerContextFromStub(stub);
  await submit(contract, stub);

  // Building a proof never invents a status; mismatching input is refused.
  await assert.rejects(
    () => submit(contract, stub, { hash: HASH_B, req: REQ_1, idem: 'idem-1' }),
    (err: unknown) => err instanceof UbtlLedgerError
  );

  const proofRaw = await contract.getCommitProof(ctx, 'fabric-tx-0001');
  const proof = JSON.parse(decodeUtf8(proofRaw)) as UbtlCommitProof;
  assert.equal('status' in proof, false);
  assert.equal(proof.blockNumber, null);
  assert.equal(proof.payloadHash, HASH_A);
});

// ---------------------------------------------------------------------------
// 7. Proof carries no block evidence before an independently verified commit.
// ---------------------------------------------------------------------------
test('07 — GetCommitProof never fabricates block evidence', async () => {
  const { contract, stub } = makeContract();
  const ctx = createLedgerContextFromStub(stub);
  await submit(contract, stub);

  const proof = JSON.parse(decodeUtf8(await contract.getCommitProof(ctx, 'fabric-tx-0001'))) as UbtlCommitProof;

  assert.equal(proof.proofSource, 'CHAINCODE_STATE');
  assert.equal(proof.blockEvidence, 'UNAVAILABLE_FROM_CHAINCODE');
  assert.equal(proof.blockNumber, null);
  assert.equal(proof.blockHash, null);
  assert.equal(proof.commitTimestamp, null);

  // Unknown transaction id -> miss, not a fabricated proof.
  const miss = await contract.getCommitProof(ctx, 'unknown-fabric-tx');
  assert.equal(miss.length, 0);
});

// ---------------------------------------------------------------------------
// 8. MSP policy is enforced on invoke and on query.
// ---------------------------------------------------------------------------
test('08 — MSP authorization is enforced for submit and for queries', async () => {
  const stub = new FakeStub('ROGUEMSP', 'fabric-tx-0002');
  const ctx = createLedgerContextFromStub(stub);
  const contract = new UbtlLedgerContract({
    allowedSubmitMspIds: ['UBTLMSP'],
    allowedQueryMspIds: ['UBTLMSP', 'AUDITMSP'],
  });

  await assert.rejects(
    () =>
      contract.submitTransactionProposal(
        ctx,
        HASH_A,
        'PURCHASE_ORDER',
        'corr-1',
        TS,
        REQ_1,
        'idem-1'
      ),
    (err: unknown) =>
      err instanceof UbtlLedgerError && err.code === UbtlLedgerErrorCode.UNAUTHORIZED_MSP
  );

  await assert.rejects(
    () => contract.queryTransactionByRequestId(ctx, REQ_1),
    (err: unknown) =>
      err instanceof UbtlLedgerError && err.code === UbtlLedgerErrorCode.UNAUTHORIZED_MSP
  );

  assert.equal(stub.state.size, 0);

  // A permitted MSP is accepted.
  const allowed = new UbtlLedgerContract({ allowedSubmitMspIds: ['UBTLMSP'] });
  const allowedStub = new FakeStub('UBTLMSP', 'fabric-tx-0003');
  await allowed.submitTransactionProposal(
    createLedgerContextFromStub(allowedStub),
    HASH_A,
    'PURCHASE_ORDER',
    'corr-1',
    TS,
    REQ_1,
    'idem-1'
  );
  assert.equal(allowedStub.state.size, 3);
});

// ---------------------------------------------------------------------------
// 9. Schema version is enforced and forward-incompatible records are surfaced.
// ---------------------------------------------------------------------------
test('09 — unsupported schemaVersion is reported as an inconsistent record', async () => {
  const { contract, stub } = makeContract();
  const ctx = createLedgerContextFromStub(stub);
  await submit(contract, stub);

  // Simulate a record written by a future, incompatible contract version.
  const tampered = { ...(stub.readJson(recordKey('idem-1')) as object), schemaVersion: 999 };
  await stub.putState(recordKey('idem-1'), encodeUtf8(JSON.stringify(tampered)));

  await assert.rejects(
    () => contract.queryTransactionByRequestId(ctx, REQ_1),
    (err: unknown) =>
      err instanceof UbtlLedgerError && err.code === UbtlLedgerErrorCode.INCONSISTENT_RECORD
  );

  // A malformed payloadHash in an existing record is likewise surfaced.
  const { contract: c2, stub: s2 } = makeContract();
  await submit(c2, s2);
  const badHash = { ...(s2.readJson(recordKey('idem-1')) as object), payloadHash: 'zz' };
  await s2.putState(recordKey('idem-1'), encodeUtf8(JSON.stringify(badHash)));

  await assert.rejects(
    () => c2.queryTransactionByRequestId(createLedgerContextFromStub(s2), REQ_1),
    (err: unknown) =>
      err instanceof UbtlLedgerError && err.code === UbtlLedgerErrorCode.INCONSISTENT_RECORD
  );
});

// ---------------------------------------------------------------------------
// 10. Reconciliation after an ambiguous submit is safe.
// ---------------------------------------------------------------------------
test('10 — reconciliation after an ambiguous submit never duplicates or corrupts state', async () => {
  const { contract, stub } = makeContract();
  const original = await submit(contract, stub);

  // The adapter retries with the SAME gatewayRequestId and idempotencyKey, as
  // required by the outbox contract, but Fabric assigns a NEW transaction id.
  const retryStub = new FakeStub('UBTLMSP', 'fabric-tx-0002');
  const retry = await submit(contract, retryStub, { req: REQ_1, idem: 'idem-1' });

  // Same logical record content for the business anchors.
  const a = JSON.parse(decodeUtf8(original));
  const b = JSON.parse(decodeUtf8(retry));
  assert.equal(a.payloadHash, b.payloadHash);
  assert.equal(a.gatewayRequestId, b.gatewayRequestId);
  assert.equal(a.idempotencyKey, b.idempotencyKey);

  // Lookup by request id resolves to exactly one logical record.
  const lookup = JSON.parse(
    decodeUtf8(await contract.queryTransactionByRequestId(createLedgerContextFromStub(stub), REQ_1))
  );
  assert.equal(lookup.payloadHash, HASH_A);

  // Reusing the gatewayRequestId under a DIFFERENT idempotency key is refused.
  await assert.rejects(
    () => submit(contract, stub, { req: REQ_1, idem: 'idem-other' }),
    (err: unknown) =>
      err instanceof UbtlLedgerError && err.code === UbtlLedgerErrorCode.IDEMPOTENCY_CONFLICT
  );
  assert.equal(stub.keysWithPrefix(STATE_KEY_PREFIX.RECORD).length, 1);
});
