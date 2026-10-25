/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * =============================================================================
 * FABRIC GATEWAY SDK PORT (Internal Boundary)
 * =============================================================================
 *
 * This file declares the *minimal* subset of the official
 * `@hyperledger/fabric-gateway` (v1.x) client API that UBTL actually consumes.
 *
 * Rationale (Axiom 1 — Provider Neutrality):
 * The rest of the application MUST NOT depend on `@hyperledger/fabric-gateway`
 * types. Only `fabric-gateway-connector.ts` imports the real SDK; everything
 * else (this adapter, the outbox worker, the domain) depends only on these
 * structurally-declared interfaces. That keeps the domain testable with a
 * plain test double and prevents SDK types leaking across module boundaries.
 *
 * Every member below is modelled directly on the verified public declarations
 * shipped in `node_modules/@hyperledger/fabric-gateway/dist/*.d.ts`:
 *   - gateway.d.ts        -> connect(), Gateway, ConnectOptions
 *   - network.d.ts        -> Network.getContract()
 *   - contract.d.ts       -> Contract.newProposal() / evaluateTransaction()
 *   - proposal.d.ts       -> Proposal.getTransactionId() / endorse()
 *   - transaction.d.ts    -> Transaction.getTransactionId() / submit()
 *   - commit.d.ts         -> Commit.getStatus()
 *   - status.d.ts         -> Status { blockNumber: bigint; code; successful; transactionId }
 *   - identity/*.d.ts     -> Identity { mspId; credentials } / signers.newPrivateKeySigner()
 */

/** A client identity (X.509 certificate + MSP assignment). Mirrors SDK `Identity`. */
export interface FabricIdentity {
  mspId: string;
  credentials: Uint8Array;
}

/** Commit status of a ledger transaction. Mirrors SDK `Status`. */
export interface FabricCommitStatus {
  /** Block number in which the transaction committed. */
  blockNumber: bigint;
  /** Fabric TxValidationCode (0 === VALID). */
  code: number;
  /** `true` when the transaction committed successfully. */
  successful: boolean;
  /** Fabric transaction ID. */
  transactionId: string;
}

/** Mirrors SDK `Commit`: allows waiting for the commit status of a submitted transaction. */
export interface FabricCommitHandle {
  getTransactionId(): string;
  getStatus(options?: unknown): Promise<FabricCommitStatus>;
}

/** Mirrors SDK `SubmittedTransaction`: a Commit that also exposes the endorsement result. */
export interface FabricSubmittedTransaction extends FabricCommitHandle {
  getResult(): Uint8Array;
}

/** Mirrors SDK `Transaction` (endorsed, ready to be submitted to the orderer). */
export interface FabricTransactionHandle {
  getTransactionId(): string;
  submit(options?: unknown): Promise<FabricSubmittedTransaction>;
}

/** Mirrors SDK `Proposal`. */
export interface FabricProposalHandle {
  getTransactionId(): string;
  endorse(options?: unknown): Promise<FabricTransactionHandle>;
}

/** Options accepted by `newProposal()` / `submitAsync()`. Mirrors SDK `ProposalOptions`. */
export interface FabricProposalOptions {
  arguments?: Array<string | Uint8Array>;
}

/** Mirrors SDK `Contract` (only the members UBTL uses). */
export interface FabricContractHandle {
  getChaincodeName(): string;
  evaluateTransaction(name: string, ...args: Array<string | Uint8Array>): Promise<Uint8Array>;
  newProposal(name: string, options?: FabricProposalOptions): FabricProposalHandle;
}

/** Mirrors SDK `Network`. */
export interface FabricNetworkHandle {
  getName(): string;
  getContract(chaincodeName: string, contractName?: string): FabricContractHandle;
}

/** Mirrors SDK `Gateway`. */
export interface FabricGatewayHandle {
  getNetwork(channelName: string): FabricNetworkHandle;
  close(): void;
}

/** Options passed to the SDK `connect()` function. Mirrors SDK `ConnectOptions` (subset). */
export interface FabricConnectOptions {
  client: unknown;
  identity: FabricIdentity;
  signer: unknown;
  hash?: unknown;
  /**
   * SHA-256 digest of the TLS client certificate. Required by the SDK only when
   * mutual TLS is used for the gRPC connection to the gateway peer.
   */
  tlsClientCertificateHash?: Uint8Array;
  endorseOptions?: () => { deadline: number };
  evaluateOptions?: () => { deadline: number };
  submitOptions?: () => { deadline: number };
  commitStatusOptions?: () => { deadline: number };
}

/** gRPC channel options used when constructing the client. */
export interface FabricGrpcClientOptions {
  'grpc.ssl_target_name_override'?: string;
  'grpc.default_authority'?: string;
}

/**
 * Injectable connector that wraps the real Hyperledger Fabric Gateway SDK.
 *
 * Production uses {@link RealFabricGatewayConnector} (the only module that
 * imports the SDK). Tests inject a deterministic test double, so no Fabric
 * network or SDK is required to exercise adapter behaviour.
 */
export interface FabricGatewayConnector {
  /**
   * Resolve the SDK modules. MUST reject with a clear, non-secret message when
   * the SDK is unavailable or incompatible. Never silently degrade.
   */
  loadSdk(): Promise<void>;

  /** Create a TLS gRPC channel to the gateway peer. */
  createGrpcClient(
    address: string,
    tlsRootCert: Buffer,
    options: FabricGrpcClientOptions
  ): unknown;

  /** Build a signing implementation from a PEM-encoded private key. */
  newSigner(privateKeyPem: Buffer): unknown;

  /** Establish a gateway connection for the given identity. */
  connect(options: FabricConnectOptions): FabricGatewayHandle;

  /** Release the underlying gRPC channel. */
  closeGrpcClient(client: unknown): void;
}
