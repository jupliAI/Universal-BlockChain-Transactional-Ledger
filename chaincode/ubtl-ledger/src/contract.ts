/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * =============================================================================
 * UBTL LEDGER CHAINCODE — CONTRACT LOGIC (framework-neutral)
 * =============================================================================
 *
 * Implements the three functions the UBTL Fabric adapter invokes:
 *
 *   1. SubmitTransactionProposal   (invoke, must be idempotent)
 *   2. QueryTransactionByRequestId (read-only)
 *   3. GetCommitProof              (read-only)
 *
 * Positional arguments of `SubmitTransactionProposal` are fixed by the adapter
 * (`src/modules/blockchain-adapter/fabric-adapter.ts` -> buildLedgerArguments):
 *
 *   [ payloadHash, transactionType, correlationId, timestamp,
 *     gatewayRequestId, idempotencyKey ]
 *
 * COMMIT-DISCIPLINE NOTE:
 *   The return value of `SubmitTransactionProposal` is NOT commit evidence. A
 *   chaincode cannot observe the block that will contain its own transaction, so
 *   this contract never reports a block number, block hash or commit status.
 *   `GetCommitProof` proves RECORD EXISTENCE only and says so explicitly.
 */

import {
  BLOCK_EVIDENCE_UNAVAILABLE,
  COMMIT_PROOF_SOURCE,
  LedgerContext,
  STATE_KEY_PREFIX,
  UBTL_LEDGER_SCHEMA_VERSION,
  UbtlCommitProof,
  UbtlLedgerError,
  UbtlLedgerErrorCode,
  UbtlTransactionRecord,
  decodeUtf8,
  encodeUtf8,
  fabricTxIndexKey,
  recordKey,
  requestIndexKey,
} from './types.ts';

const PAYLOAD_HASH_PATTERN = /^[0-9a-f]{64}$/;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const MAX_TRANSACTION_TYPE_LENGTH = 64;
const SUPPORTED_SCHEMA_VERSIONS = new Set<number>([UBTL_LEDGER_SCHEMA_VERSION]);

export interface UbtlLedgerContractOptions {
  /**
   * MSP IDs allowed to invoke the write function. When omitted, no MSP
   * restriction is enforced by the chaincode itself and the network's
   * endorsement policy is the sole authorization boundary. Documented, not
   * silently defaulted.
   */
  allowedSubmitMspIds?: readonly string[];
  /** MSP IDs allowed to invoke the two read-only functions. Omitted = unrestricted. */
  allowedQueryMspIds?: readonly string[];
}

export class UbtlLedgerContract {
  private readonly allowedSubmitMspIds?: readonly string[];
  private readonly allowedQueryMspIds?: readonly string[];

  constructor(options: UbtlLedgerContractOptions = {}) {
    this.allowedSubmitMspIds = options.allowedSubmitMspIds;
    this.allowedQueryMspIds = options.allowedQueryMspIds;
  }

  /**
   * Idempotent submission of transaction integrity metadata.
   *
   * - Same idempotency key + identical payload hash  -> returns the existing
   *   record unchanged. No second logical record is created.
   * - Same idempotency key + different payload hash  -> IDEMPOTENCY_CONFLICT.
   * - Gateway request id already bound to another key -> IDEMPOTENCY_CONFLICT.
   */
  async submitTransactionProposal(
    ctx: LedgerContext,
    payloadHash: string,
    transactionType: string,
    correlationId: string,
    timestamp: string,
    gatewayRequestId: string,
    idempotencyKey: string
  ): Promise<Uint8Array> {
    this.assertMsp(ctx, this.allowedSubmitMspIds, 'SubmitTransactionProposal');

    const idem = this.validateIdempotencyKey(idempotencyKey, gatewayRequestId);
    const hash = this.validatePayloadHash(payloadHash);
    const type = this.validateTransactionType(transactionType);
    const correlation = this.validateNonEmpty(correlationId, 'correlationId', 128);
    const clientTs = this.validateTimestamp(timestamp);
    const requestId = this.validateNonEmpty(gatewayRequestId, 'gatewayRequestId', 128);

    // 1. Primary record already present for this idempotency key.
    const existing = await this.readRecord(ctx, idem);
    if (existing) {
      this.assertSupportedSchema(existing);
      if (existing.payloadHash === hash) {
        // Idempotent replay: return the original record. This is the exact path
        // used when a submit response was ambiguous and reconciliation retries.
        return encodeUtf8(JSON.stringify(existing));
      }
      throw new UbtlLedgerError(
        UbtlLedgerErrorCode.IDEMPOTENCY_CONFLICT,
        `idempotencyKey is already bound to a different payloadHash; refusing to create a conflicting record.`
      );
    }

    // 2. Gateway request id must not already be bound to a different key.
    const boundKey = await this.readIndex(ctx, requestIndexKey(requestId));
    if (boundKey !== null && boundKey !== idem) {
      throw new UbtlLedgerError(
        UbtlLedgerErrorCode.IDEMPOTENCY_CONFLICT,
        'gatewayRequestId is already bound to a different idempotencyKey.'
      );
    }

    const record: UbtlTransactionRecord = {
      schemaVersion: UBTL_LEDGER_SCHEMA_VERSION,
      idempotencyKey: idem,
      gatewayRequestId: requestId,
      payloadHash: hash,
      transactionType: type,
      correlationId: correlation,
      clientTimestamp: clientTs,
      fabricTransactionId: ctx.getTransactionId(),
      submittingMspId: ctx.getMspId(),
      ledgerWriteTimestamp: ctx.getTimestampIso(),
    };

    await ctx.putState(recordKey(idem), encodeUtf8(JSON.stringify(record)));
    await ctx.putState(requestIndexKey(requestId), encodeUtf8(idem));
    await ctx.putState(fabricTxIndexKey(record.fabricTransactionId), encodeUtf8(idem));

    return encodeUtf8(JSON.stringify(record));
  }

  /**
   * Read-only lookup by the durable UBTL anchor. Returns an EMPTY payload for a
   * miss (the agreed miss representation used by the adapter's
   * `parseLedgerRecord`, which treats an empty response as `null`).
   */
  async queryTransactionByRequestId(
    ctx: LedgerContext,
    gatewayRequestId: string
  ): Promise<Uint8Array> {
    this.assertMsp(ctx, this.allowedQueryMspIds, 'QueryTransactionByRequestId');
    const requestId = this.validateNonEmpty(gatewayRequestId, 'gatewayRequestId', 128);

    const idem = await this.readIndex(ctx, requestIndexKey(requestId));
    if (idem === null) {
      return encodeUtf8('');
    }

    const record = await this.readRecord(ctx, idem);
    if (!record) {
      throw new UbtlLedgerError(
        UbtlLedgerErrorCode.INCONSISTENT_RECORD,
        'Request index resolved to an idempotency key with no primary record.'
      );
    }
    if (record.gatewayRequestId !== requestId) {
      throw new UbtlLedgerError(
        UbtlLedgerErrorCode.INCONSISTENT_RECORD,
        'Primary record does not match the gatewayRequestId that indexed it.'
      );
    }

    this.assertSupportedSchema(record);
    return encodeUtf8(JSON.stringify(record));
  }

  /**
   * Read-only commit proof. Reports RECORD EXISTENCE and explicitly states that
   * block-level evidence is NOT available from chaincode state. It never
   * fabricates a block number, block hash or commit timestamp.
   */
  async getCommitProof(ctx: LedgerContext, fabricTransactionId: string): Promise<Uint8Array> {
    this.assertMsp(ctx, this.allowedQueryMspIds, 'GetCommitProof');
    const txId = this.validateNonEmpty(fabricTransactionId, 'fabricTransactionId', 256);

    const idem = await this.readIndex(ctx, fabricTxIndexKey(txId));
    if (idem === null) {
      return encodeUtf8('');
    }

    const record = await this.readRecord(ctx, idem);
    if (!record) {
      throw new UbtlLedgerError(
        UbtlLedgerErrorCode.INCONSISTENT_RECORD,
        'Fabric transaction index resolved to an idempotency key with no primary record.'
      );
    }

    this.assertSupportedSchema(record);

    const proof: UbtlCommitProof = {
      schemaVersion: record.schemaVersion,
      gatewayRequestId: record.gatewayRequestId,
      idempotencyKey: record.idempotencyKey,
      fabricTransactionId: record.fabricTransactionId,
      payloadHash: record.payloadHash,
      transactionType: record.transactionType,
      correlationId: record.correlationId,
      submittingMspId: record.submittingMspId,
      ledgerWriteTimestamp: record.ledgerWriteTimestamp,
      proofSource: COMMIT_PROOF_SOURCE,
      blockEvidence: BLOCK_EVIDENCE_UNAVAILABLE,
      blockNumber: null,
      blockHash: null,
      commitTimestamp: null,
    };

    return encodeUtf8(JSON.stringify(proof));
  }

  // -------------------------------------------------------------------------
  // Validation helpers
  // -------------------------------------------------------------------------

  private assertMsp(
    ctx: LedgerContext,
    allowed: readonly string[] | undefined,
    fn: string
  ): void {
    if (!allowed) return;
    const mspId = ctx.getMspId();
    if (!allowed.includes(mspId)) {
      throw new UbtlLedgerError(
        UbtlLedgerErrorCode.UNAUTHORIZED_MSP,
        `MSP '${mspId}' is not permitted to invoke ${fn}.`
      );
    }
  }

  private validatePayloadHash(value: string): string {
    if (typeof value !== 'string' || !PAYLOAD_HASH_PATTERN.test(value)) {
      throw new UbtlLedgerError(
        UbtlLedgerErrorCode.INVALID_ARGUMENT,
        'payloadHash must be a 64-character lowercase hexadecimal SHA-256 digest.'
      );
    }
    return value;
  }

  private validateIdempotencyKey(value: string, fallback: string): string {
    const effective = value === undefined || value === null || value === '' ? fallback : value;
    if (typeof effective !== 'string' || effective.trim() === '') {
      throw new UbtlLedgerError(
        UbtlLedgerErrorCode.INVALID_ARGUMENT,
        'idempotencyKey must be a non-empty string (or gatewayRequestId when omitted).'
      );
    }
    if (effective.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new UbtlLedgerError(
        UbtlLedgerErrorCode.INVALID_ARGUMENT,
        `idempotencyKey exceeds ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`
      );
    }
    return effective;
  }

  private validateTransactionType(value: string): string {
    const type = this.validateNonEmpty(value, 'transactionType', MAX_TRANSACTION_TYPE_LENGTH);
    if (!/^[A-Za-z0-9_.:-]+$/.test(type)) {
      throw new UbtlLedgerError(
        UbtlLedgerErrorCode.INVALID_ARGUMENT,
        'transactionType contains unsupported characters.'
      );
    }
    return type;
  }

  private validateTimestamp(value: string): string {
    const raw = this.validateNonEmpty(value, 'timestamp', 64);
    const parsed = Date.parse(raw);
    if (Number.isNaN(parsed)) {
      throw new UbtlLedgerError(
        UbtlLedgerErrorCode.INVALID_ARGUMENT,
        'timestamp must be an ISO-8601 parseable instant.'
      );
    }
    return raw;
  }

  private validateNonEmpty(value: string, name: string, maxLength: number): string {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new UbtlLedgerError(
        UbtlLedgerErrorCode.INVALID_ARGUMENT,
        `${name} must be a non-empty string.`
      );
    }
    if (value.length > maxLength) {
      throw new UbtlLedgerError(
        UbtlLedgerErrorCode.INVALID_ARGUMENT,
        `${name} exceeds ${maxLength} characters.`
      );
    }
    return value;
  }

  private assertSupportedSchema(record: UbtlTransactionRecord): void {
    if (!SUPPORTED_SCHEMA_VERSIONS.has(record.schemaVersion)) {
      throw new UbtlLedgerError(
        UbtlLedgerErrorCode.INCONSISTENT_RECORD,
        `Unsupported on-ledger schemaVersion ${record.schemaVersion}.`
      );
    }
    if (
      typeof record.payloadHash !== 'string' ||
      !PAYLOAD_HASH_PATTERN.test(record.payloadHash)
    ) {
      throw new UbtlLedgerError(
        UbtlLedgerErrorCode.INCONSISTENT_RECORD,
        'On-ledger record contains a malformed payloadHash.'
      );
    }
  }

  // -------------------------------------------------------------------------
  // State helpers
  // -------------------------------------------------------------------------

  private async readIndex(ctx: LedgerContext, key: string): Promise<string | null> {
    const raw = await ctx.getState(key);
    if (!raw || raw.length === 0) return null;
    const value = decodeUtf8(raw);
    return value === '' ? null : value;
  }

  private async readRecord(
    ctx: LedgerContext,
    idempotencyKey: string
  ): Promise<UbtlTransactionRecord | null> {
    const raw = await ctx.getState(recordKey(idempotencyKey));
    if (!raw || raw.length === 0) return null;
    const text = decodeUtf8(raw);
    if (text === '') return null;
    try {
      const parsed = JSON.parse(text) as UbtlTransactionRecord;
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch {
      throw new UbtlLedgerError(
        UbtlLedgerErrorCode.INCONSISTENT_RECORD,
        `On-ledger record under ${STATE_KEY_PREFIX.RECORD} is not valid JSON.`
      );
    }
  }
}
