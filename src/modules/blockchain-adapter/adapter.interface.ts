/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { CommitVerifier } from './commit-verification.types.ts';

export interface BlockchainSubmissionInput {
  gatewayRequestId: string;
  correlationId: string;
  transactionType: string;
  payloadHash: string;
  timestamp: string;
  /**
   * The Switching-supplied idempotency key for this transaction, when known.
   * Used as an on-ledger reconciliation anchor so that an ambiguous submission
   * can be resolved without blindly resubmitting. Carries no business data.
   */
  idempotencyKey?: string;
}

export interface BlockchainSubmissionResult {
  accepted: boolean;
  fabricTransactionId: string;
  status: 'PENDING' | 'FAILED';
  isSimulated?: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export interface CommitStatusResult {
  fabricTransactionId: string;
  status: 'CONFIRMED' | 'PENDING' | 'FAILED' | 'TIMEOUT';
  blockNumber?: bigint | number;
  commitTimestamp?: string;
  validationCode?: number; // 0 = VALID
  isSimulated?: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export interface LedgerProof {
  fabricTransactionId: string;
  payloadHash: string;
  blockNumber: bigint | number;
  blockHash: string;
  commitTimestamp: string;
  mspId: string;
  isSimulated?: boolean;
}

export interface AdapterHealth {
  status: 'online' | 'degraded' | 'offline';
  mode: 'mock' | 'provider';
  isSimulated: boolean;
  peerEndpoint: string;
  channelName: string;
  currentBlockHeight: number;
  latencyMs: number;
  details: string;
}

export interface BlockchainAdapter {
  readonly mode: 'mock' | 'provider';
  initialize(): Promise<void>;
  submitProposal(input: BlockchainSubmissionInput): Promise<BlockchainSubmissionResult>;
  queryCommitStatus(fabricTransactionId: string): Promise<CommitStatusResult>;
  getTransactionProof(fabricTransactionId: string): Promise<LedgerProof | null>;
  healthCheck(): Promise<AdapterHealth>;
  findTransactionByIdempotencyKey?(gatewayRequestId: string): Promise<CommitStatusResult | null>;
  /**
   * Optional INDEPENDENT commit verifier (Prompt 09.7).
   *
   * When this is present and returns a verifier, the orchestration layers (the
   * outbox VERIFY_COMMIT handler and the reconciliation job) MUST require a
   * `VERIFIED_COMMITTED` verdict before any business transition to COMMITTED.
   * A commit status observed through `queryCommitStatus` — including a
   * chaincode-supplied block number — is then treated as a hint, never as
   * commit evidence.
   *
   * Provider mode always exposes a verifier. It fails CLOSED: when no
   * block-level evidence source (qscc / explorer / offline block decode) is
   * configured, every verification reports `EVIDENCE_UNAVAILABLE` and can never
   * yield CONFIRMED. There is no silent fallback to a simulated ledger.
   *
   * Returning `null` (or omitting the method) means the adapter cannot offer
   * independent verification — this is the case for the explicitly simulated
   * mock adapter and for in-process test doubles — and callers keep the
   * documented adapter-observation path.
   */
  getCommitVerifier?(): CommitVerifier | null;
}
