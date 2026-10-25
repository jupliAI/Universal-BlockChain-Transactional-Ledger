/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import {
  AdapterHealth,
  BlockchainAdapter,
  BlockchainSubmissionInput,
  BlockchainSubmissionResult,
  CommitStatusResult,
  LedgerProof,
} from './adapter.interface.ts';
import {
  BlockEvidenceSource,
  createUnavailableEvidenceSource,
} from './block-evidence.source.ts';
import {
  CommitVerificationAuditSink,
  CommitVerifier,
} from './commit-verification.types.ts';
import {
  FabricCredentialSource,
  FileSystemFabricCredentialSource,
} from './fabric-credentials.ts';
import { RealFabricGatewayConnector } from './fabric-gateway-connector.ts';
import { IndependentCommitVerifier } from './independent-commit-verifier.ts';
import {
  FabricCommitHandle,
  FabricCommitStatus,
  FabricContractHandle,
  FabricGatewayConnector,
  FabricGatewayHandle,
  FabricProposalHandle,
  FabricTransactionHandle,
} from './fabric-sdk.port.ts';

/**
 * =============================================================================
 * HYPERLEDGER FABRIC GATEWAY ADAPTER (provider mode)
 * =============================================================================
 *
 * Implements the BlockchainAdapter port on top of the official
 * `@hyperledger/fabric-gateway` client protocol. No SDK types cross this module
 * boundary — everything upstream depends on `adapter.interface.ts` only.
 *
 * COMMIT DISCIPLINE (Axiom 5):
 *   submitProposal() returns PENDING as soon as the endorsed transaction has
 *   been accepted by the orderer. It NEVER reports a commit. A transaction may
 *   only be treated as committed when the Gateway returns a Status whose
 *   `successful` flag is true AND whose block number is > 0. A status with
 *   `successful === false` is definitive evidence of an unsuccessful commit.
 *   A deadline expiry is reported as TIMEOUT (ambiguous) — never as FAILED and
 *   never as CONFIRMED.
 *
 * RECONCILIATION STRATEGY (documented, not a native Fabric capability):
 *   The Fabric Gateway client protocol does not expose a
 *   "query commit status by transaction ID" RPC. `Commit.getStatus()` is only
 *   obtainable from the `SubmittedTransaction` handle returned by `submit()` in
 *   the SAME process. UBTL therefore:
 *     1. Keeps a process-local cache of commit handles for the fast path, and
 *     2. Falls back to an explicitly UBTL-defined chaincode query
 *        (default `GetCommitProof` / `QueryTransactionByRequestId`) using the
 *        durable metadata stored on the UBTL transaction row (payload hash,
 *        gateway request ID, idempotency key, Fabric transaction ID).
 *   The fallback relies on read-your-write semantics against Fabric world
 *   state; it requires a DEPLOYED UBTL chaincode implementing those functions.
 *   This is NOT claimed to be a native Fabric Gateway capability.
 */

export interface FabricChaincodeFunctions {
  submitTransactionProposal: string;
  queryTransactionByRequestId: string;
  getCommitProof: string;
}

/**
 * Chaincode interface required by the adapter. The names are configurable so a
 * provider can map them onto their deployed chaincode, but the shape (a submit
 * function plus two read-only query functions) is fixed by this contract.
 */
export const DEFAULT_FABRIC_CHAINCODE_FUNCTIONS: FabricChaincodeFunctions = {
  submitTransactionProposal: 'SubmitTransactionProposal',
  queryTransactionByRequestId: 'QueryTransactionByRequestId',
  getCommitProof: 'GetCommitProof',
};

export interface FabricGatewayOptions {
  peerEndpoint?: string;
  tlsCertPath?: string;
  clientCertPath?: string;
  clientKeyPath?: string;
  mspId?: string;
  channelName?: string;
  chaincodeName?: string;
  commitTimeoutSeconds?: number;
  discoveryAsLocalhost?: boolean;
  chaincodeFunctions?: Partial<FabricChaincodeFunctions>;
}

export interface FabricAdapterDependencies {
  connector?: FabricGatewayConnector;
  credentialSource?: FabricCredentialSource;
  now?: () => number;
  /**
   * The BLOCK-LEVEL ledger source used for independent commit verification
   * (Prompt 09.7). Supply a qscc / explorer / offline-decode implementation when
   * the target network grants the privileges it needs.
   *
   * When omitted, provider mode stays fail-closed: the injected verifier
   * reports `EVIDENCE_UNAVAILABLE` for every lookup, so a transaction can never
   * be reported as CONFIRMED. There is deliberately NO fallback to chaincode
   * state or to the mock adapter.
   */
  blockEvidenceSource?: BlockEvidenceSource;
  /** Optional audit sink for every commit-verification decision. */
  commitVerificationAuditSink?: CommitVerificationAuditSink;
}

/** Shape of the JSON record returned by the UBTL chaincode query functions. */
interface LedgerRecordView {
  fabricTransactionId?: string;
  payloadHash?: string;
  blockNumber?: number | string;
  blockHash?: string;
  commitTimestamp?: string;
  mspId?: string;
  transactionType?: string;
  correlationId?: string;
  gatewayRequestId?: string;
}

interface ProviderErrorClassification {
  classification: 'TRANSIENT' | 'PERMANENT' | 'AMBIGUOUS';
  code: string;
  message: string;
}

// gRPC status codes (see https://grpc.io/docs/guides/status-codes/).
const GRPC_DEADLINE_EXCEEDED = 4;
const GRPC_INVALID_ARGUMENT = 3;
const GRPC_FAILED_PRECONDITION = 9;
const GRPC_PERMISSION_DENIED = 7;
const GRPC_UNAUTHENTICATED = 16;

export class FabricGatewayAdapter implements BlockchainAdapter {
  readonly mode = 'provider' as const;

  private readonly options: FabricGatewayOptions;
  private readonly connector: FabricGatewayConnector;
  private readonly credentialSource: FabricCredentialSource;
  private readonly nowFn: () => number;
  private readonly chaincode: FabricChaincodeFunctions;

  private gateway: FabricGatewayHandle | null = null;
  private grpcClient: unknown = null;
  private contract: FabricContractHandle | null = null;
  private isInitialized = false;

  /**
   * Process-local cache of commit handles. Only populated for transactions this
   * process submitted; discarded once a terminal status is observed. It is not
   * durable — after a restart the read-only chaincode fallback is used.
   */
  private readonly commitHandles = new Map<string, FabricCommitHandle>();

  /**
   * INDEPENDENT commit verifier (Prompt 09.7). Always present in provider mode,
   * and always fail-closed: without a configured block-level evidence source
   * every lookup reports `EVIDENCE_UNAVAILABLE`, which can never become
   * CONFIRMED. A chaincode record is never accepted as commit evidence.
   */
  private readonly commitVerifier: CommitVerifier;
  /** True only when the caller supplied a real block-level evidence source. */
  private readonly hasIndependentBlockEvidenceSource: boolean;

  constructor(options: FabricGatewayOptions, dependencies: FabricAdapterDependencies = {}) {
    this.options = options;
    this.connector = dependencies.connector ?? new RealFabricGatewayConnector();
    this.credentialSource =
      dependencies.credentialSource ??
      new FileSystemFabricCredentialSource({
        tlsCertPath: options.tlsCertPath,
        clientCertPath: options.clientCertPath,
        clientKeyPath: options.clientKeyPath,
      });
    this.nowFn = dependencies.now ?? (() => Date.now());
    this.chaincode = { ...DEFAULT_FABRIC_CHAINCODE_FUNCTIONS, ...(options.chaincodeFunctions ?? {}) };

    this.hasIndependentBlockEvidenceSource = dependencies.blockEvidenceSource !== undefined;
    this.commitVerifier = new IndependentCommitVerifier(
      dependencies.blockEvidenceSource ??
        createUnavailableEvidenceSource(
          'provider-block-evidence',
          'No independent block-level evidence source (qscc / block explorer / offline block decode) is configured for this deployment. ' +
            'A committed transaction cannot be independently verified, so no transaction may be reported as CONFIRMED until one is supplied.',
          'EVIDENCE_SOURCE_UNAVAILABLE'
        ),
      dependencies.commitVerificationAuditSink
        ? { auditSink: dependencies.commitVerificationAuditSink }
        : {}
    );
  }

  /**
   * Fail-fast initialization. Any missing parameter, unreadable credential,
   * unavailable SDK or failed connection aborts with an explicit error. There is
   * NO fallback to mock mode: silently simulating a ledger in provider mode
   * would be worse than refusing to start.
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    this.assertProviderConfiguration();

    const material = this.credentialSource.load();

    try {
      await this.connector.loadSdk();
    } catch (err) {
      throw this.wrapInitError('FABRIC_GATEWAY_SDK_UNAVAILABLE', err);
    }

    try {
      const endpoint = this.options.peerEndpoint as string;
      const grpcClient = this.connector.createGrpcClient(
        endpoint,
        material.tlsRootCert,
        this.buildGrpcClientOptions(endpoint)
      );
      this.grpcClient = grpcClient;

      const signer = this.connector.newSigner(material.clientPrivateKey);
      const deadlineSupplier = () => ({ deadline: this.nowFn() + this.commitTimeoutMs() });

      const gateway = this.connector.connect({
        client: grpcClient,
        identity: {
          mspId: this.options.mspId as string,
          credentials: material.clientCertificate,
        },
        signer,
        tlsClientCertificateHash: createHash('sha256').update(material.clientCertificate).digest(),
        endorseOptions: deadlineSupplier,
        evaluateOptions: deadlineSupplier,
        submitOptions: deadlineSupplier,
        commitStatusOptions: deadlineSupplier,
      });

      this.gateway = gateway;
      const network = gateway.getNetwork(this.options.channelName as string);
      this.contract = network.getContract(this.options.chaincodeName as string);
      this.isInitialized = true;
    } catch (err) {
      // Release the transport if the gateway could not be established.
      this.safeCloseTransport();
      this.gateway = null;
      this.contract = null;
      throw this.wrapInitError('FABRIC_GATEWAY_INIT_FAILED', err);
    }
  }

  /**
   * Submit a transaction proposal and, if endorsed, submit it to the orderer.
   * Returns PENDING — this is durable acceptance by the orderer, NOT a commit.
   */
  async submitProposal(input: BlockchainSubmissionInput): Promise<BlockchainSubmissionResult> {
    await this.ensureInitialized();
    const contract = this.requireContract();

    let providerTransactionId = '';
    try {
      const proposal: FabricProposalHandle = contract.newProposal(
        this.chaincode.submitTransactionProposal,
        { arguments: this.buildLedgerArguments(input) }
      );
      // The provider transaction ID is assigned by the client before endorsement
      // and is distinct from the UBTL gatewayRequestId / idempotency key.
      providerTransactionId = proposal.getTransactionId();

      const transaction: FabricTransactionHandle = await proposal.endorse();
      const submitted = await transaction.submit();

      const fabricTransactionId = submitted.getTransactionId() || providerTransactionId;
      this.commitHandles.set(fabricTransactionId, submitted);

      return {
        accepted: true,
        fabricTransactionId,
        status: 'PENDING',
      };
    } catch (err) {
      const classified = this.classifyProviderError(err);

      if (classified.classification === 'PERMANENT') {
        // Definitive rejection: retrying the same proposal cannot succeed.
        return {
          accepted: false,
          fabricTransactionId: providerTransactionId,
          status: 'FAILED',
          errorCode: classified.code,
          errorMessage: classified.message,
        };
      }

      // TRANSIENT / AMBIGUOUS: surface as a throw so the outbox worker applies
      // the matching retry/reconciliation policy.
      const error = new Error(classified.message);
      (error as { code?: string }).code = classified.code;
      throw error;
    }
  }

  /**
   * Resolve the commit outcome of a previously submitted transaction.
   * Never reports CONFIRMED without a successful status and blockNumber > 0.
   */
  async queryCommitStatus(fabricTransactionId: string): Promise<CommitStatusResult> {
    await this.ensureInitialized();

    const handle = this.commitHandles.get(fabricTransactionId);
    if (handle) {
      try {
        const status = await handle.getStatus({ deadline: this.nowFn() + this.commitTimeoutMs() });
        return this.mapCommitStatus(status);
      } catch (err) {
        const classified = this.classifyProviderError(err);
        if (classified.classification === 'AMBIGUOUS') {
          return {
            fabricTransactionId,
            status: 'TIMEOUT',
            errorCode: classified.code,
            errorMessage: classified.message,
          };
        }
        const error = new Error(classified.message);
        (error as { code?: string }).code = classified.code;
        throw error;
      }
    }

    // No in-process commit handle (e.g. after a restart): use the documented
    // chaincode-query reconciliation strategy. Absence of evidence is reported
    // as PENDING, never silently as CONFIRMED or FAILED.
    const record = await this.queryLedgerRecord(fabricTransactionId);
    if (record && this.blockNumberOf(record) > 0) {
      return {
        fabricTransactionId,
        status: 'CONFIRMED',
        blockNumber: record.blockNumber as bigint | number,
        commitTimestamp: record.commitTimestamp,
        validationCode: 0,
      };
    }

    return {
      fabricTransactionId,
      status: 'PENDING',
      errorCode: 'COMMIT_EVIDENCE_UNAVAILABLE',
      errorMessage:
        'Commit status requires either the in-process commit handle or a deployed UBTL chaincode query interface; neither was available.',
    };
  }

  /**
   * Retrieve an independent verification proof for a committed transaction.
   * Returns null when no committed ledger record can be read — never fabricates
   * a proof.
   */
  async getTransactionProof(fabricTransactionId: string): Promise<LedgerProof | null> {
    await this.ensureInitialized();

    const record = await this.queryLedgerRecord(fabricTransactionId);
    if (!record) return null;

    const blockNumber = this.blockNumberOf(record);
    if (blockNumber <= 0 || !record.payloadHash || !record.blockHash) {
      return null;
    }

    return {
      fabricTransactionId: record.fabricTransactionId || fabricTransactionId,
      payloadHash: record.payloadHash,
      blockNumber: record.blockNumber as bigint | number,
      blockHash: record.blockHash,
      commitTimestamp: record.commitTimestamp ?? '',
      mspId: record.mspId || this.options.mspId || '',
    };
  }

  /**
   * Reconciliation lookup by UBTL gateway request ID. Uses the chaincode query
   * interface keyed on the durable UBTL anchor. Returns null when no committed
   * record can be found.
   */
  async findTransactionByIdempotencyKey(
    gatewayRequestId: string
  ): Promise<CommitStatusResult | null> {
    await this.ensureInitialized();

    const record = await this.queryLedgerRecordByRequestId(gatewayRequestId);
    if (!record || this.blockNumberOf(record) <= 0) {
      return null;
    }

    return {
      fabricTransactionId: record.fabricTransactionId ?? '',
      status: 'CONFIRMED',
      blockNumber: record.blockNumber as bigint | number,
      commitTimestamp: record.commitTimestamp,
      validationCode: 0,
    };
  }

  /**
   * Exposes the INDEPENDENT commit verifier. Provider mode always returns a
   * verifier (never null): a caller must be able to require block-level proof,
   * and a missing evidence source must surface as `EVIDENCE_UNAVAILABLE` rather
   * than as an unverified success.
   *
   * The verifier queries the ledger by Fabric transaction ID, so it works after
   * a restart: it depends on no in-process handle and no chaincode record.
   */
  getCommitVerifier(): CommitVerifier {
    return this.commitVerifier;
  }

  /**
   * Operator-facing health. Reports connectivity as UNVERIFIED (degraded) after
   * a successful client initialization, because the Fabric Gateway client
   * connects lazily and this probe performs no live round-trip. No block height
   * or latency is fabricated.
   */
  async healthCheck(): Promise<AdapterHealth> {
    const evidenceNote = this.hasIndependentBlockEvidenceSource
      ? 'An independent block-level evidence source is configured for commit verification.'
      : 'No independent block-level evidence source is configured: commit verification is fail-closed and no transaction can be reported as CONFIRMED.';
    return {
      status: this.isInitialized ? 'degraded' : 'offline',
      mode: 'provider',
      isSimulated: false,
      peerEndpoint: this.options.peerEndpoint || 'not-configured',
      channelName: this.options.channelName || 'not-configured',
      currentBlockHeight: 0,
      latencyMs: 0,
      details: this.isInitialized
        ? `Fabric Gateway client initialized. Connectivity and ledger queries require a deployed UBTL chaincode; this probe performs no live round-trip. ${evidenceNote}`
        : 'Fabric Gateway client is not initialized (provider mode).',
    };
  }

  /** Release gateway and transport resources. Safe to call multiple times. */
  close(): void {
    try {
      this.gateway?.close();
    } catch {
      // Gateway close is best-effort.
    }
    this.gateway = null;
    this.contract = null;
    this.isInitialized = false;
    this.commitHandles.clear();
    this.safeCloseTransport();
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private async ensureInitialized(): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }
  }

  private requireContract(): FabricContractHandle {
    if (!this.contract) {
      throw new Error(
        '[FABRIC_GATEWAY_INIT_FAILED] Fabric contract handle is unavailable; initialize() did not complete successfully.'
      );
    }
    return this.contract;
  }

  private assertProviderConfiguration(): void {
    const missing: string[] = [];
    if (!this.options.peerEndpoint) missing.push('peerEndpoint');
    if (!this.options.tlsCertPath) missing.push('tlsCertPath');
    if (!this.options.clientCertPath) missing.push('clientCertPath');
    if (!this.options.clientKeyPath) missing.push('clientKeyPath');
    if (!this.options.mspId) missing.push('mspId');
    if (!this.options.channelName) missing.push('channelName');
    if (!this.options.chaincodeName) missing.push('chaincodeName');

    if (missing.length > 0) {
      throw new Error(
        `[FABRIC_GATEWAY_PROVIDER_FAIL_FAST] Cannot initialize Fabric Gateway adapter. Missing mandatory provider parameters: ${missing.join(', ')}`
      );
    }
  }

  /**
   * `FABRIC_GATEWAY_DISCOVERY_AS_LOCALHOST` is a LOCAL DEVELOPMENT convenience.
   * The Fabric Gateway client protocol performs peer/orderer discovery
   * server-side; the SDK exposes no client-side discovery switch. This flag is
   * therefore mapped onto gRPC channel options that pin the TLS target name to
   * the configured peer host, which lets a local network whose certificates do
   * not carry a matching SAN be reached. It is NOT Fabric Gateway discovery.
   */
  private buildGrpcClientOptions(endpoint: string) {
    if (!this.options.discoveryAsLocalhost) return {};
    const host = endpoint.split(':')[0];
    return {
      'grpc.ssl_target_name_override': host,
      'grpc.default_authority': host,
    };
  }

  private commitTimeoutMs(): number {
    const seconds = this.options.commitTimeoutSeconds ?? 60;
    return seconds * 1000;
  }

  /**
   * Ledger arguments. Only integrity metadata is placed on-chain: the
   * authoritative payload hash plus opaque correlation identifiers. Full
   * payloads and business documents remain off-chain.
   *
   *   [ payloadHash, transactionType, correlationId, timestamp,
   *     gatewayRequestId, idempotencyKey ]
   */
  private buildLedgerArguments(input: BlockchainSubmissionInput): string[] {
    return [
      input.payloadHash,
      input.transactionType,
      input.correlationId,
      input.timestamp,
      input.gatewayRequestId,
      input.idempotencyKey ?? input.gatewayRequestId,
    ];
  }

  private mapCommitStatus(status: FabricCommitStatus): CommitStatusResult {
    const blockNumber = status.blockNumber;
    const successful = status.successful === true && Number(blockNumber) > 0;

    if (!successful) {
      this.commitHandles.delete(status.transactionId);
      return {
        fabricTransactionId: status.transactionId,
        status: 'FAILED',
        validationCode: Number(status.code),
        errorCode: 'LEDGER_COMMIT_VALIDATION_FAILURE',
        errorMessage: `Transaction committed with unsuccessful Fabric validation code ${status.code}.`,
      };
    }

    this.commitHandles.delete(status.transactionId);
    return {
      fabricTransactionId: status.transactionId,
      status: 'CONFIRMED',
      blockNumber,
      validationCode: Number(status.code),
    };
  }

  private async queryLedgerRecord(fabricTransactionId: string): Promise<LedgerRecordView | null> {
    try {
      const contract = this.requireContract();
      const result = await contract.evaluateTransaction(
        this.chaincode.getCommitProof,
        fabricTransactionId
      );
      return this.parseLedgerRecord(result);
    } catch {
      // Unavailable chaincode, not-found, or peer error: report "unknown"
      // rather than inventing a ledger state.
      return null;
    }
  }

  private async queryLedgerRecordByRequestId(
    gatewayRequestId: string
  ): Promise<LedgerRecordView | null> {
    try {
      const contract = this.requireContract();
      const result = await contract.evaluateTransaction(
        this.chaincode.queryTransactionByRequestId,
        gatewayRequestId
      );
      return this.parseLedgerRecord(result);
    } catch {
      return null;
    }
  }

  private parseLedgerRecord(result: Uint8Array | undefined): LedgerRecordView | null {
    if (!result || result.length === 0) return null;
    try {
      const text = Buffer.from(result).toString('utf8').trim();
      if (text === '' || text === 'null') return null;
      const parsed = JSON.parse(text) as LedgerRecordView;
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private blockNumberOf(record: LedgerRecordView): number {
    const raw = record.blockNumber;
    if (typeof raw === 'bigint') return Number(raw);
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'string') {
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  }

  /**
   * Maps a provider/SDK error onto the UBTL error taxonomy. The returned `code`
   * and `message` are chosen so that the outbox worker's `classifyError` derives
   * the same classification if the error is re-thrown.
   */
  private classifyProviderError(err: unknown): ProviderErrorClassification {
    const anyErr = err as { code?: unknown; message?: unknown; details?: unknown };
    const grpcCode = typeof anyErr?.code === 'number' ? anyErr.code : undefined;

    const detailText = Array.isArray(anyErr?.details)
      ? (anyErr.details as Array<{ message?: unknown }>)
          .map((detail) => String(detail?.message ?? ''))
          .join(' ')
      : '';

    const rawMessage =
      anyErr?.message !== undefined && anyErr?.message !== null
        ? String(anyErr.message)
        : String(err);
    const combined = `${rawMessage} ${detailText}`;
    const upper = combined.toUpperCase();
    const sanitized = sanitizeProviderMessage(combined);

    // AMBIGUOUS: the outcome is unknown. Do not report FAILED or CONFIRMED.
    if (
      grpcCode === GRPC_DEADLINE_EXCEEDED ||
      upper.includes('DEADLINE_EXCEEDED') ||
      upper.includes('DEADLINE EXCEEDED') ||
      upper.includes('TIMEOUT') ||
      upper.includes('AMBIGUOUS')
    ) {
      return {
        classification: 'AMBIGUOUS',
        code: 'COMMIT_TIMEOUT',
        message: `Fabric provider deadline exceeded; the transaction outcome is ambiguous (reconciliation required). ${sanitized}`,
      };
    }

    // PERMANENT: definitive rejection that retrying cannot resolve.
    if (
      upper.includes('ENDORSEMENT_POLICY_FAILURE') ||
      upper.includes('ENDORSEMENT POLICY') ||
      upper.includes('INVALID_ARGUMENT') ||
      grpcCode === GRPC_INVALID_ARGUMENT ||
      grpcCode === GRPC_FAILED_PRECONDITION ||
      grpcCode === GRPC_PERMISSION_DENIED ||
      grpcCode === GRPC_UNAUTHENTICATED
    ) {
      return {
        classification: 'PERMANENT',
        code: 'ENDORSEMENT_POLICY_FAILURE',
        message: `Fabric proposal rejected permanently by the provider. ${sanitized}`,
      };
    }

    // TRANSIENT: safe to retry (the chaincode submit function must be idempotent
    // on the idempotency key so a retry cannot double-record a ledger event).
    return {
      classification: 'TRANSIENT',
      code: 'FABRIC_PROVIDER_TRANSIENT_ERROR',
      message: `Fabric provider transient error. ${sanitized}`,
    };
  }

  private wrapInitError(code: string, err: unknown): Error {
    const raw = err instanceof Error ? err.message : String(err);
    return new Error(`[FABRIC_GATEWAY_INIT_FAILED] ${sanitizeProviderMessage(raw)} (${code})`);
  }

  private safeCloseTransport(): void {
    if (this.grpcClient) {
      try {
        this.connector.closeGrpcClient(this.grpcClient);
      } catch {
        // Best-effort release.
      }
      this.grpcClient = null;
    }
  }
}

/**
 * Removes anything that could be a secret from provider error text before it is
 * logged or persisted. Private keys and certificates are never part of SDK
 * error messages, but tokens/passwords could be, and message length is capped.
 */
function sanitizeProviderMessage(message: string): string {
  return message
    .replace(/((?:key|secret|token|password|auth|authorization)=)['"]?[^&'"\s]+['"]?/gi, '$1[REDACTED]')
    .replace(/(?:Bearer\s+)[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .slice(0, 300);
}
