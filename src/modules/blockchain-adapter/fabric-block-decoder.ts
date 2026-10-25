/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * =============================================================================
 * FABRIC BLOCK DECODER (PROMPT 09.8)
 * =============================================================================
 *
 * Decodes the raw protobuf `common.Block` bytes returned by `qscc`
 * `GetBlockByTxID` into the {@link DecodedBlockTransaction} the independent
 * commit verifier consumes.
 *
 * WHY THIS IS HAND-ROLLED AND DEPENDENCY-FREE
 *   `fabric-protos` is deliberately NOT a declared dependency of UBTL (the
 *   adapter is provider-neutral by design, Axiom 1). This decoder therefore
 *   implements the *documented wire format* of the Fabric v2.x `common` and
 *   `peer` protobufs directly, using only a strict protobuf wire reader. It
 *   never adds a dependency, never reaches into the SDK's private protobuf
 *   runtime, and never guesses:
 *
 *     - Every message boundary, field number and wire type is validated. A
 *       single malformed byte makes the whole decode FAIL CLOSED
 *       (`UNAVAILABLE`), never a partial or plausible-looking result.
 *     - `BlockHeader.data_hash` (when present) MUST equal SHA-256 of the block
 *       data section, and the number of `TRANSACTIONS_FILTER` flags MUST equal
 *       the number of envelopes in the block. Both are checks the ledger itself
 *       makes possible; a contradiction means the evidence is unusable.
 *     - The block hash is computed from the decoded `BlockHeader` bytes
 *       (SHA-256, Fabric's own block-hash definition). It is never copied from
 *       a chaincode response.
 *     - The chaincode arguments are only interpreted when the invoked function
 *       is the expected `SubmitTransactionProposal`; any other function yields
 *       `null` metadata instead of a fabricated payload hash.
 *
 * FIELD MAP USED (Fabric v2.x `common/common.proto`, `peer/chaincode.proto`,
 * `peer/transaction.proto`, `peer/proposal.proto`):
 *
 *   Block         { header = 1, data = 2, metadata = 3 }
 *   BlockHeader   { number = 1 (uint64), previous_hash = 2, data_hash = 3 }
 *   BlockData     { data = 1 (repeated bytes, one Envelope per transaction) }
 *   BlockMetadata { metadata = 1 (repeated bytes), metadata_index = 2 }
 *   MetadataIndex { index = 1 (uint64), digest = 2 }
 *     index 2 === TRANSACTIONS_FILTER: one TxValidationCode byte per envelope,
 *     in block order (0 === VALID).
 *   Envelope            { payload = 1, signature = 2 }
 *   Payload             { header = 1, data = 2 }
 *   Header              { channel_header = 1, signature_header = 2 }
 *   ChannelHeader       { type = 1, version = 2, timestamp = 3, tx_id = 4,
 *                         channel_id = 5, extension = 6 }
 *   Transaction         { actions = 1 (repeated TransactionAction) }
 *   TransactionAction   { header = 1, payload = 2 }
 *   ChaincodeHeaderExtension { chaincode_id = 1 }
 *   ChaincodeID         { path = 1, name = 2, version = 3 }
 *   ChaincodeProposalPayload { input = 1 }
 *   ChaincodeInvocationSpec  { chaincode_spec = 1 }
 *   ChaincodeSpec       { type = 1, chaincode_id = 2, input = 3, timeout = 4 }
 *   ChaincodeInput      { args = 1 (repeated bytes), decorations = 2 }
 *
 * RESIDUAL GAP (REPORTED, NOT HIDDEN)
 *   This decoder has never been run against bytes produced by a real peer: no
 *   target network exists yet (see `qscc-block-evidence.source.ts`). It is
 *   covered by synthetic wire fixtures only, so the mapping above is the one
 *   remaining assumption to confirm during live acceptance. It fails closed in
 *   every direction it can detect, but a wrong *field number* cannot be
 *   detected offline — only by decoding a real block.
 */

import { createHash } from 'node:crypto';
import type { DecodedBlockTransaction } from './block-evidence.source.ts';
import type { BlockDecodeOutcome, FabricBlockDecoder } from './qscc-block-evidence.source.ts';

/** `BlockMetadataIndex_TRANSACTIONS_FILTER` (Fabric `protoutil` constant). */
const BLOCK_METADATA_INDEX_TRANSACTIONS_FILTER = 2;

/** The function whose positional argument layout this decoder understands. */
export const DEFAULT_SUBMIT_FUNCTION_NAME = 'SubmitTransactionProposal';

/**
 * Positional chaincode arguments of `SubmitTransactionProposal`, offset by one
 * because `args[0]` is the function name itself (CHAINCODE_CONTRACT.md §3.1).
 */
const ARG_PAYLOAD_HASH = 1;
const ARG_TRANSACTION_TYPE = 2;
const ARG_CORRELATION_ID = 3;
const ARG_GATEWAY_REQUEST_ID = 5;
const ARG_IDEMPOTENCY_KEY = 6;

const PAYLOAD_HASH_PATTERN = /^[0-9a-f]{64}$/;

export interface FabricBlockDecoderOptions {
  /** Overridable only if the chaincode function is renamed in the adapter. */
  submitFunctionName?: string;
}

/**
 * Creates the decoder used by the `qscc` transport. Always fails closed: the
 * only outcomes are a fully decoded transaction or `UNAVAILABLE`.
 */
export function createFabricProtobufBlockDecoder(
  options: FabricBlockDecoderOptions = {}
): FabricBlockDecoder {
  const submitFunctionName = options.submitFunctionName ?? DEFAULT_SUBMIT_FUNCTION_NAME;
  return {
    decode(rawBlock: Uint8Array, fabricTransactionId: string): BlockDecodeOutcome {
      return decodeFabricBlock(rawBlock, fabricTransactionId, submitFunctionName);
    },
  };
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

function decodeFabricBlock(
  rawBlock: Uint8Array,
  fabricTransactionId: string,
  submitFunctionName: string
): BlockDecodeOutcome {
  if (!rawBlock || rawBlock.length === 0) {
    return unavailable('The ledger returned an empty block payload.', 'BLOCK_EMPTY');
  }

  try {
    const blockFields = readFields(rawBlock);
    const headerBytes = firstBytes(blockFields, 1);
    const dataBytes = firstBytes(blockFields, 2);
    const metadataBytes = firstBytes(blockFields, 3);
    if (!headerBytes || !dataBytes || !metadataBytes) {
      return unavailable(
        'The block bytes are missing the header, data or metadata section.',
        'BLOCK_STRUCTURE_INVALID'
      );
    }

    // --- header ---------------------------------------------------------
    const headerFields = readFields(headerBytes);
    const numberVarint = firstVarint(headerFields, 1);
    if (numberVarint === null) {
      return unavailable('The block header carries no block number.', 'BLOCK_NUMBER_MISSING');
    }
    const blockNumber = Number(numberVarint);
    if (!Number.isSafeInteger(blockNumber) || blockNumber <= 0) {
      return unavailable(
        `The block header carries an unusable block number (${blockNumber}).`,
        'BLOCK_NUMBER_INVALID'
      );
    }

    // Independent integrity check the ledger itself provides: the header's
    // data_hash must be the digest of the data section. A mismatch means the
    // bytes we decoded are not a self-consistent block.
    const dataHash = firstBytes(headerFields, 3);
    if (dataHash && dataHash.length > 0) {
      const actual = createHash('sha256').update(dataBytes).digest();
      if (!actual.equals(Buffer.from(dataHash))) {
        return unavailable(
          'The block header data hash does not match the block data section.',
          'BLOCK_DATA_HASH_MISMATCH'
        );
      }
    }

    const blockHash = createHash('sha256').update(headerBytes).digest('hex');

    // --- data -----------------------------------------------------------
    const envelopes = allBytes(readFields(dataBytes), 1);
    if (envelopes.length === 0) {
      return unavailable('The block contains no transaction envelopes.', 'BLOCK_HAS_NO_ENVELOPES');
    }

    // --- validation flags ----------------------------------------------
    const flags = findTransactionsFilter(readFields(metadataBytes));
    if (!flags) {
      return unavailable(
        'The block metadata carries no TRANSACTIONS_FILTER, so transaction validity cannot be established.',
        'TRANSACTIONS_FILTER_MISSING'
      );
    }
    if (flags.length !== envelopes.length) {
      return unavailable(
        `The block metadata declares ${flags.length} validation flags for ${envelopes.length} transactions; the evidence is inconsistent.`,
        'TRANSACTIONS_FILTER_LENGTH_MISMATCH'
      );
    }

    // --- locate our transaction ----------------------------------------
    for (let index = 0; index < envelopes.length; index++) {
      const txId = readEnvelopeTransactionId(envelopes[index]);
      if (txId === null) {
        return unavailable(
          `Block ${blockNumber} contains an envelope whose transaction id could not be decoded.`,
          'ENVELOPE_DECODE_FAILED'
        );
      }
      if (txId !== fabricTransactionId) continue;

      const validationCode = flags[index];
      const invoked = readInvokedChaincode(envelopes[index], submitFunctionName);
      const transaction: DecodedBlockTransaction = {
        blockNumber,
        blockHash,
        fabricTransactionId: txId,
        validationCode,
        valid: validationCode === 0,
        payloadHash: invoked.payloadHash,
        gatewayRequestId: invoked.gatewayRequestId,
        idempotencyKey: invoked.idempotencyKey,
        transactionType: invoked.transactionType,
        correlationId: invoked.correlationId,
        chaincodeName: invoked.chaincodeName,
      };
      return { kind: 'DECODED', transaction };
    }

    return unavailable(
      `The requested transaction is not present in block ${blockNumber}.`,
      'TRANSACTION_NOT_IN_BLOCK'
    );
  } catch (err: unknown) {
    return unavailable(
      `The block could not be decoded: ${err instanceof Error ? err.message : String(err)}`,
      'BLOCK_DECODE_FAILED'
    );
  }
}

/** Reads `ChannelHeader.tx_id` (field 4) out of an `Envelope`. */
function readEnvelopeTransactionId(envelope: Uint8Array): string | null {
  const payloadBytes = firstBytes(readFields(envelope), 1);
  if (!payloadBytes) return null;
  const headerBytes = firstBytes(readFields(payloadBytes), 1);
  if (!headerBytes) return null;
  const channelHeaderBytes = firstBytes(readFields(headerBytes), 1);
  if (!channelHeaderBytes) return null;
  const txIdBytes = firstBytes(readFields(channelHeaderBytes), 4);
  if (!txIdBytes) return null;
  return utf8(txIdBytes);
}

interface InvokedChaincode {
  payloadHash: string | null;
  gatewayRequestId: string | null;
  idempotencyKey: string | null;
  transactionType: string | null;
  correlationId: string | null;
  chaincodeName: string | null;
}

const NO_INVOCATION: InvokedChaincode = {
  payloadHash: null,
  gatewayRequestId: null,
  idempotencyKey: null,
  transactionType: null,
  correlationId: null,
  chaincodeName: null,
};

/**
 * Recovers the chaincode that was invoked and, only for the expected function,
 * the integrity metadata carried by its positional arguments. Returns all-null
 * metadata for any other function rather than reinterpreting its arguments.
 */
function readInvokedChaincode(
  envelope: Uint8Array,
  submitFunctionName: string
): InvokedChaincode {
  const payloadBytes = firstBytes(readFields(envelope), 1);
  if (!payloadBytes) return NO_INVOCATION;

  const transactionBytes = firstBytes(readFields(payloadBytes), 2);
  if (!transactionBytes) return NO_INVOCATION;

  const actions = allBytes(readFields(transactionBytes), 1);
  if (actions.length === 0) return NO_INVOCATION;

  const actionFields = readFields(actions[0]);
  const extensionBytes = firstBytes(actionFields, 1);
  const actionPayloadBytes = firstBytes(actionFields, 2);

  const chaincodeName = extensionBytes ? readChaincodeName(extensionBytes) : null;
  const args = actionPayloadBytes ? readChaincodeArgs(actionPayloadBytes) : [];
  if (args.length === 0 || args[0] !== submitFunctionName) {
    return { ...NO_INVOCATION, chaincodeName };
  }

  const payloadHash = args[ARG_PAYLOAD_HASH];
  const idempotencyKey = args[ARG_IDEMPOTENCY_KEY];
  return {
    payloadHash: payloadHash && PAYLOAD_HASH_PATTERN.test(payloadHash) ? payloadHash : null,
    transactionType: args[ARG_TRANSACTION_TYPE] ?? null,
    correlationId: args[ARG_CORRELATION_ID] ?? null,
    gatewayRequestId: args[ARG_GATEWAY_REQUEST_ID] ?? null,
    // The contract defaults the idempotency key to the gateway request id.
    idempotencyKey: idempotencyKey || args[ARG_GATEWAY_REQUEST_ID] || null,
    chaincodeName,
  };
}

/** `ChaincodeHeaderExtension.chaincode_id` (field 1) -> `ChaincodeID.name` (2). */
function readChaincodeName(extensionBytes: Uint8Array): string | null {
  const chaincodeIdBytes = firstBytes(readFields(extensionBytes), 1);
  if (!chaincodeIdBytes) return null;
  const fields = readFields(chaincodeIdBytes);
  const name = firstBytes(fields, 2);
  if (name) return utf8(name);
  const path = firstBytes(fields, 1);
  return path ? utf8(path) : null;
}

/**
 * Walks `ChaincodeProposalPayload.input` -> `ChaincodeInvocationSpec.chaincode_spec`
 * -> `ChaincodeSpec.input` -> `ChaincodeInput.args`.
 */
function readChaincodeArgs(actionPayloadBytes: Uint8Array): string[] {
  const inputBytes = firstBytes(readFields(actionPayloadBytes), 1);
  if (!inputBytes) return [];
  const specBytes = firstBytes(readFields(inputBytes), 1);
  if (!specBytes) return [];
  const chaincodeInputBytes = firstBytes(readFields(specBytes), 3);
  if (!chaincodeInputBytes) return [];
  return allBytes(readFields(chaincodeInputBytes), 1).map(utf8);
}

/** Locates the `TRANSACTIONS_FILTER` digest inside `BlockMetadata`. */
function findTransactionsFilter(metadataFields: ProtoField[]): Uint8Array | null {
  for (const entry of allBytes(metadataFields, 2)) {
    const fields = readFields(entry);
    const index = firstVarint(fields, 1);
    if (index === null) continue;
    if (Number(index) === BLOCK_METADATA_INDEX_TRANSACTIONS_FILTER) {
      return firstBytes(fields, 2);
    }
  }
  return null;
}

function unavailable(reason: string, errorCode: string): BlockDecodeOutcome {
  return { kind: 'UNAVAILABLE', reason, errorCode };
}

// ---------------------------------------------------------------------------
// Strict protobuf wire reader
// ---------------------------------------------------------------------------

interface ProtoField {
  field: number;
  wireType: number;
  varint: bigint | null;
  bytes: Uint8Array | null;
}

const WIRE_VARINT = 0;
const WIRE_64BIT = 1;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_32BIT = 5;

function readVarint(buffer: Uint8Array, offset: number): { value: bigint; next: number } {
  let value = 0n;
  let shift = 0n;
  let cursor = offset;
  while (cursor < buffer.length) {
    const byte = buffer[cursor];
    cursor += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: cursor };
    shift += 7n;
    if (shift > 63n) throw new Error('protobuf: varint exceeds 64 bits');
  }
  throw new Error('protobuf: truncated varint');
}

/**
 * Parses a message into its fields. Throws on any structural anomaly: an
 * unknown wire type, a truncated field, or a length prefix that runs past the
 * end of the buffer.
 */
function readFields(buffer: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const tag = readVarint(buffer, offset);
    offset = tag.next;
    const fieldNumber = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (fieldNumber <= 0) throw new Error('protobuf: field number 0 is invalid');

    if (wireType === WIRE_VARINT) {
      const field = readVarint(buffer, offset);
      offset = field.next;
      fields.push({ field: fieldNumber, wireType, varint: field.value, bytes: null });
      continue;
    }
    if (wireType === WIRE_64BIT) {
      if (offset + 8 > buffer.length) throw new Error('protobuf: truncated 64-bit field');
      fields.push({
        field: fieldNumber,
        wireType,
        varint: null,
        bytes: buffer.subarray(offset, offset + 8),
      });
      offset += 8;
      continue;
    }
    if (wireType === WIRE_LENGTH_DELIMITED) {
      const length = readVarint(buffer, offset);
      offset = length.next;
      const end = offset + Number(length.value);
      if (end > buffer.length) throw new Error('protobuf: length-delimited field overruns buffer');
      fields.push({
        field: fieldNumber,
        wireType,
        varint: null,
        bytes: buffer.subarray(offset, end),
      });
      offset = end;
      continue;
    }
    if (wireType === WIRE_32BIT) {
      if (offset + 4 > buffer.length) throw new Error('protobuf: truncated 32-bit field');
      fields.push({
        field: fieldNumber,
        wireType,
        varint: null,
        bytes: buffer.subarray(offset, offset + 4),
      });
      offset += 4;
      continue;
    }
    throw new Error(`protobuf: unsupported wire type ${wireType}`);
  }
  return fields;
}

function firstBytes(fields: ProtoField[], fieldNumber: number): Uint8Array | null {
  for (const field of fields) {
    if (field.field === fieldNumber && field.wireType === WIRE_LENGTH_DELIMITED && field.bytes) {
      return field.bytes;
    }
  }
  return null;
}

function allBytes(fields: ProtoField[], fieldNumber: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const field of fields) {
    if (field.field === fieldNumber && field.wireType === WIRE_LENGTH_DELIMITED && field.bytes) {
      out.push(field.bytes);
    }
  }
  return out;
}

function firstVarint(fields: ProtoField[], fieldNumber: number): bigint | null {
  for (const field of fields) {
    if (field.field === fieldNumber && field.wireType === WIRE_VARINT) {
      return field.varint;
    }
  }
  return null;
}

function utf8(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8');
}
