/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes } from 'crypto';
import {
  AdapterHealth,
  BlockchainAdapter,
  BlockchainSubmissionInput,
  BlockchainSubmissionResult,
  CommitStatusResult,
  LedgerProof,
} from './adapter.interface.ts';
import { CommitVerifier } from './commit-verification.types.ts';

interface MockLedgerEntry {
  input: BlockchainSubmissionInput;
  fabricTransactionId: string;
  blockNumber: number;
  blockHash: string;
  status: 'PENDING' | 'CONFIRMED' | 'FAILED';
  submittedAt: number;
  commitAt: number;
}

export class MockBlockchainAdapter implements BlockchainAdapter {
  readonly mode = 'mock' as const;

  private currentBlockHeight = 14200;
  private ledgerStore = new Map<string, MockLedgerEntry>();
  private gatewayRequestIndex = new Map<string, string>();
  private isInitialized = false;

  constructor(
    private commitDelayMs: number = 1200,
    private failureRate: number = 0.0,
    private timeoutRate: number = 0.0
  ) {}

  async initialize(): Promise<void> {
    this.isInitialized = true;
  }

  async submitProposal(input: BlockchainSubmissionInput): Promise<BlockchainSubmissionResult> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    // Chaos test failure simulation
    if (this.failureRate > 0 && Math.random() < this.failureRate) {
      return {
        accepted: false,
        fabricTransactionId: '',
        status: 'FAILED',
        isSimulated: true,
        errorCode: 'ENDORSEMENT_POLICY_FAILURE',
        errorMessage: 'Mock peer simulated endorsement quorum verification failure',
      };
    }

    // Generate clearly prefixed simulated Fabric Tx ID to avoid confusion with production Fabric IDs
    const nonce = randomBytes(12).toString('hex');
    const digest = createHash('sha256')
      .update(`${input.gatewayRequestId}:${input.payloadHash}:${nonce}`)
      .digest('hex');
    const fabricTransactionId = `simulated-fabric-tx-${digest.slice(0, 32)}`;

    const now = Date.now();
    const willTimeout = this.timeoutRate > 0 && Math.random() < this.timeoutRate;
    const commitDelay = willTimeout ? 99999999 : this.commitDelayMs;

    this.currentBlockHeight += 1;
    const blockNumber = this.currentBlockHeight;
    const blockHash = `simulated-block-hash-${createHash('sha256')
      .update(`block:${blockNumber}:${fabricTransactionId}`)
      .digest('hex')
      .slice(0, 32)}`;

    const entry: MockLedgerEntry = {
      input,
      fabricTransactionId,
      blockNumber,
      blockHash,
      status: 'PENDING',
      submittedAt: now,
      commitAt: now + commitDelay,
    };

    this.ledgerStore.set(fabricTransactionId, entry);
    this.gatewayRequestIndex.set(input.gatewayRequestId, fabricTransactionId);

    return {
      accepted: true,
      fabricTransactionId,
      status: 'PENDING',
      isSimulated: true,
    };
  }

  async findTransactionByIdempotencyKey(gatewayRequestId: string): Promise<CommitStatusResult | null> {
    const fabricTxId = this.gatewayRequestIndex.get(gatewayRequestId);
    if (!fabricTxId) {
      return null;
    }
    return this.queryCommitStatus(fabricTxId);
  }

  async queryCommitStatus(fabricTransactionId: string): Promise<CommitStatusResult> {
    const entry = this.ledgerStore.get(fabricTransactionId);
    if (!entry) {
      return {
        fabricTransactionId,
        status: 'FAILED',
        isSimulated: true,
        errorCode: 'TRANSACTION_NOT_FOUND',
        errorMessage: `Simulated proposal ${fabricTransactionId} not found in mock ledger store`,
      };
    }

    const now = Date.now();

    // Check if simulated commit delay has elapsed
    if (now >= entry.commitAt) {
      entry.status = 'CONFIRMED';
      return {
        fabricTransactionId,
        status: 'CONFIRMED',
        blockNumber: entry.blockNumber,
        commitTimestamp: new Date(entry.commitAt).toISOString(),
        validationCode: 0,
        isSimulated: true,
      };
    }

    return {
      fabricTransactionId,
      status: 'PENDING',
      isSimulated: true,
    };
  }

  async getTransactionProof(fabricTransactionId: string): Promise<LedgerProof | null> {
    const entry = this.ledgerStore.get(fabricTransactionId);
    if (!entry) {
      return null;
    }

    const now = Date.now();
    if (now >= entry.commitAt) {
      entry.status = 'CONFIRMED';
    }

    if (entry.status !== 'CONFIRMED') {
      return null;
    }

    return {
      fabricTransactionId: entry.fabricTransactionId,
      payloadHash: entry.input.payloadHash,
      blockNumber: entry.blockNumber,
      blockHash: entry.blockHash,
      commitTimestamp: new Date(entry.commitAt).toISOString(),
      mspId: 'SimulatedMockMSP',
      isSimulated: true,
    };
  }

  async healthCheck(): Promise<AdapterHealth> {
    return {
      status: 'online',
      mode: 'mock',
      isSimulated: true,
      peerEndpoint: 'local://mock-peer0.org1.ubtl.internal:7051',
      channelName: 'ubtl-channel-mock',
      currentBlockHeight: this.currentBlockHeight,
      latencyMs: 1,
      details: 'Mock Fabric Adapter running in local memory simulator (SIMULATED LEDGER)',
    };
  }

  /**
   * The mock holds no block-level ledger source: its "commit" is an explicitly
   * simulated in-memory event (`isSimulated: true`). It therefore CANNOT offer
   * independent commit verification and says so by returning null, so callers
   * keep the documented simulation path and never mistake a simulated
   * observation for verified ledger evidence.
   */
  getCommitVerifier(): CommitVerifier | null {
    return null;
  }
}
