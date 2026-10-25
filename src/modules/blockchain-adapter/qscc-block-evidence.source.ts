/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * =============================================================================
 * QSCC BLOCK-EVIDENCE SOURCE (TRANSPORT — STATUS: BLOCKED)
 * =============================================================================
 *
 * Implements {@link BlockEvidenceSource} on top of Hyperledger Fabric's system
 * chaincode `qscc`, using the read-only `GetBlockByTxID` function:
 *
 *     evaluate(qsccChaincodeName, 'GetBlockByTxID', channelName, transactionId)
 *         -> raw protobuf `common.Block` bytes
 *
 * WHY THE TRANSPORT IS MARKED BLOCKED
 *   1. NO TARGET NETWORK. No peer endpoint, channel or MSP has been supplied, so
 *      no qscc call can be executed or validated here.
 *   2. BLOCK DECODER — RESOLVED (PROMPT 09.8). Turning raw `common.Block` bytes
 *      into a block number, header hash and transaction validation code is now
 *      implemented without `fabric-protos` by
 *      {@link createFabricProtobufBlockDecoder} (see `fabric-block-decoder.ts`):
 *      a strict, dependency-free protobuf wire decoder that fails closed on any
 *      structural anomaly. The decoder is still an INJECTED port
 *      ({@link FabricBlockDecoder}); {@link createUnsupportedBlockDecoder}
 *      remains available as the explicit `UNAVAILABLE` placeholder for callers
 *      that must not decode. The REMAINING, UNRESOLVABLE-OFFLINE risk is that
 *      the field-number map has never been exercised against peer-produced
 *      bytes (no network exists), so it is covered by synthetic fixtures only.
 *   3. UNKNOWN ACL. Peer-side qscc access (`qscc` is a system chaincode and is
 *      commonly restricted by policy) has not been granted or verified.
 *
 * Blocker (1) alone still prevents a live call: no peer endpoint, channel,
 * identity or deployed chaincode exists, so {@link createQsccBlockEvidenceSource}
 * is never constructed by the running server (fail-closed — see `server.ts`).
 * The class and the concrete decoder exist so the wiring, argument order,
 * decode logic and error taxonomy are reviewable and testable with doubles.
 *
 * REQUIRED NETWORK PRIVILEGES (owner: network administrator)
 *   - The UBTL client identity's MSP must be allowed to invoke `qscc`
 *     `GetBlockByTxID` on the target channel.
 *   - `DISCOVERY`/peer ACLs must permit the corresponding read path.
 *   - If qscc is denied, an equivalent block-level source (block explorer API or
 *     operator `peer channel fetch` + offline decode) must be supplied instead.
 *     There is NO fallback to chaincode state.
 */

import {
  BlockEvidenceLookup,
  BlockEvidenceSource,
  DecodedBlockTransaction,
} from './block-evidence.source.ts';
import { createFabricProtobufBlockDecoder } from './fabric-block-decoder.ts';
import { redactSecrets } from '../security/redaction.ts';

/**
 * Minimal read-only evaluation function. Structurally compatible with
 * `FabricContractHandle.evaluateTransaction` bound to the qscc contract.
 */
export interface FabricReadOnlyEvaluator {
  evaluate(chaincodeName: string, fn: string, ...args: string[]): Promise<Uint8Array>;
}

/** Outcome of decoding raw block bytes. Never fabricates a transaction entry. */
export type BlockDecodeOutcome =
  | { kind: 'DECODED'; transaction: DecodedBlockTransaction }
  | { kind: 'UNAVAILABLE'; reason: string; errorCode: string };

/**
 * Decodes raw protobuf `common.Block` bytes. Implementations MUST derive the
 * block hash from the block header bytes they decoded — never from a chaincode
 * response — and MUST return `UNAVAILABLE` rather than guessing.
 */
export interface FabricBlockDecoder {
  decode(rawBlock: Uint8Array, fabricTransactionId: string): BlockDecodeOutcome;
}

/**
 * The default decoder. It decodes NOTHING and says so: shipping a real decoder
 * requires `fabric-protos` (or an equivalent reviewed implementation) plus a
 * target network to validate against.
 */
export function createUnsupportedBlockDecoder(reason: string): FabricBlockDecoder {
  return {
    decode(): BlockDecodeOutcome {
      return { kind: 'UNAVAILABLE', reason, errorCode: 'BLOCK_DECODER_UNAVAILABLE' };
    },
  };
}

export interface QsccBlockEvidenceSourceOptions {
  evaluator: FabricReadOnlyEvaluator;
  decoder: FabricBlockDecoder;
  channelName: string;
  /** System chaincode name; `qscc` unless the network renamed it. */
  qsccChaincodeName?: string;
  sourceName?: string;
}

// gRPC status codes (https://grpc.io/docs/guides/status-codes/).
const GRPC_DEADLINE_EXCEEDED = 4;
const GRPC_NOT_FOUND = 5;
const GRPC_PERMISSION_DENIED = 7;
const GRPC_UNIMPLEMENTED = 12;
const GRPC_UNAUTHENTICATED = 16;

export class QsccBlockEvidenceSource implements BlockEvidenceSource {
  readonly isIndependent = true;
  readonly sourceName: string;

  private readonly evaluator: FabricReadOnlyEvaluator;
  private readonly decoder: FabricBlockDecoder;
  private readonly channelName: string;
  private readonly qsccChaincodeName: string;

  constructor(options: QsccBlockEvidenceSourceOptions) {
    if (!options?.evaluator || typeof options.evaluator.evaluate !== 'function') {
      throw new Error(
        '[QSCC_EVIDENCE_FAIL_FAST] QsccBlockEvidenceSource requires a read-only evaluator.'
      );
    }
    if (!options.decoder || typeof options.decoder.decode !== 'function') {
      throw new Error(
        '[QSCC_EVIDENCE_FAIL_FAST] QsccBlockEvidenceSource requires a FabricBlockDecoder; a missing decoder must never be replaced by a fabricated decode.'
      );
    }
    if (!options.channelName || options.channelName.trim() === '') {
      throw new Error('[QSCC_EVIDENCE_FAIL_FAST] A non-empty channel name is required.');
    }
    this.evaluator = options.evaluator;
    this.decoder = options.decoder;
    this.channelName = options.channelName;
    this.qsccChaincodeName = options.qsccChaincodeName ?? 'qscc';
    this.sourceName = options.sourceName ?? 'qscc';
  }

  async lookupTransaction(fabricTransactionId: string): Promise<BlockEvidenceLookup> {
    let rawBlock: Uint8Array;
    try {
      rawBlock = await this.evaluator.evaluate(
        this.qsccChaincodeName,
        'GetBlockByTxID',
        this.channelName,
        fabricTransactionId
      );
    } catch (err: unknown) {
      return this.classifyQueryError(err);
    }

    if (!rawBlock || rawBlock.length === 0) {
      // A well-formed qscc miss: the peer has no block containing this
      // transaction yet (ordering/commit latency). Retryable, never a failure.
      return { kind: 'NOT_FOUND' };
    }

    const decoded = this.decoder.decode(rawBlock, fabricTransactionId);
    if (decoded.kind === 'UNAVAILABLE') {
      return {
        kind: 'EVIDENCE_UNAVAILABLE',
        reason: decoded.reason,
        errorCode: decoded.errorCode,
      };
    }
    return { kind: 'FOUND', transaction: decoded.transaction };
  }

  private classifyQueryError(err: unknown): BlockEvidenceLookup {
    const anyErr = err as { code?: unknown; message?: unknown } | null;
    const grpcCode = typeof anyErr?.code === 'number' ? anyErr.code : undefined;
    const message = this.sanitize(err);
    const upper = message.toUpperCase();

    if (grpcCode === GRPC_NOT_FOUND || upper.includes('NOT_FOUND') || upper.includes('NOT FOUND')) {
      return { kind: 'NOT_FOUND' };
    }

    if (
      grpcCode === GRPC_DEADLINE_EXCEEDED ||
      upper.includes('DEADLINE_EXCEEDED') ||
      upper.includes('DEADLINE EXCEEDED') ||
      upper.includes('TIMEOUT')
    ) {
      return {
        kind: 'TIMEOUT',
        reason: `qscc GetBlockByTxID did not complete in time: ${message}`,
        errorCode: 'QSCC_QUERY_TIMEOUT',
      };
    }

    if (grpcCode === GRPC_PERMISSION_DENIED || grpcCode === GRPC_UNAUTHENTICATED) {
      return {
        kind: 'EVIDENCE_UNAVAILABLE',
        reason: `qscc access was denied for this identity (peer ACL). ${message}`,
        errorCode: 'QSCC_ACCESS_DENIED',
      };
    }

    if (grpcCode === GRPC_UNIMPLEMENTED || upper.includes('UNIMPLEMENTED')) {
      return {
        kind: 'EVIDENCE_UNAVAILABLE',
        reason: `The peer does not expose qscc GetBlockByTxID on this channel. ${message}`,
        errorCode: 'QSCC_UNSUPPORTED',
      };
    }

    return {
      kind: 'EVIDENCE_UNAVAILABLE',
      reason: `qscc GetBlockByTxID failed: ${message}`,
      errorCode: 'QSCC_QUERY_FAILED',
    };
  }

  /**
   * Error text can echo headers or query parameters supplied by the caller, so
   * it is scrubbed with the SAME single-source-of-truth redactor used by the
   * webhook and audit layers rather than a local, weaker regex.
   */
  private sanitize(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    return redactSecrets(raw).slice(0, 300);
  }
}

export interface QsccBlockEvidenceSourceFactoryOptions
  extends Omit<QsccBlockEvidenceSourceOptions, 'decoder'> {
  /** Overrides the default concrete decoder (e.g. an equivalent reviewed one). */
  decoder?: FabricBlockDecoder;
}

/**
 * Builds the `qscc` transport with the CONCRETE, dependency-free Fabric block
 * decoder (PROMPT 09.8) as the default. The transport still requires a
 * reachable network, a granted qscc ACL and a deployed chaincode to be USABLE;
 * this factory only removes the "no decoder" blocker, it does not enable live
 * integration by itself.
 */
export function createQsccBlockEvidenceSource(
  options: QsccBlockEvidenceSourceFactoryOptions
): QsccBlockEvidenceSource {
  return new QsccBlockEvidenceSource({
    ...options,
    decoder: options.decoder ?? createFabricProtobufBlockDecoder(),
  });
}
