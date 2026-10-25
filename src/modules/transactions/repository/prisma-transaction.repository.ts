/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { InitialOutboxEventSpec, TransactionRecord } from '../transactions.service.ts';
import {
  InitialStatusHistorySpec,
  StorageMetadata,
  TransactionRepository,
} from './transaction.repository.ts';

export class PrismaTransactionRepository implements TransactionRepository {
  readonly storageMetadata: StorageMetadata = {
    storageType: 'postgresql',
    isDurable: true,
    productionReady: true,
    details: 'PostgreSQL 16 relational database with Prisma ORM transactional outbox and unique constraints',
  };

  constructor(private readonly prismaClient: any) {}

  async createAtomic(
    transaction: TransactionRecord,
    initialStatusHistory?: InitialStatusHistorySpec,
    outboxEvent?: InitialOutboxEventSpec
  ): Promise<void> {
    if (!this.prismaClient) {
      throw new Error('PrismaClient is not initialized. Connect PostgreSQL and verify DATABASE_URL.');
    }

    // Atomic ACID transaction across transactions, status history, and outbox_events.
    // A single $transaction guarantees that an accepted transaction can never be
    // persisted without its initial dispatch event (and vice versa).
    await this.prismaClient.$transaction(async (tx: any) => {
      // 1. Persist transaction
      await tx.transaction.create({
        data: {
          id: transaction.id,
          gatewayRequestId: transaction.gatewayRequestId,
          organizationId: transaction.organizationId,
          correlationId: transaction.correlationId,
          idempotencyKey: transaction.idempotencyKey,
          transactionType: transaction.transactionType,
          schemaVersion: transaction.schemaVersion,
          status: transaction.status.toUpperCase(),
          lifecycleState: transaction.lifecycleState,
          payloadHash: transaction.payloadHash,
          hashAlgorithm: transaction.hashAlgorithm,
          hashVersion: transaction.hashVersion,
          canonicalizationSpec: transaction.canonicalizationSpec,
          rawPayload: transaction.rawPayload,
          canonicalPayload: transaction.canonicalPayload,
          attemptCount: transaction.attemptCount,
          submittedAt: new Date(transaction.submittedAt),
        },
      });

      // 2. Persist initial status history
      if (initialStatusHistory) {
        await tx.transactionStatusHistory.create({
          data: {
            transactionId: transaction.id,
            toStatus: initialStatusHistory.toStatus || transaction.status.toUpperCase(),
            reason: initialStatusHistory.reason || 'TRANSACTION_ACCEPTED',
            details: initialStatusHistory.details || {},
          },
        });
      }

      // 3. Persist initial outbox event (identical unit of work)
      if (outboxEvent) {
        await tx.outboxEvent.create({
          data: {
            transactionId: transaction.id,
            eventType: outboxEvent.eventType || 'DISPATCH_LEDGER',
            status: 'PENDING',
            // gatewayRequestId has no dedicated column; it is carried inside the
            // JSONB payload so the worker can resolve the owning transaction.
            payload: { ...(outboxEvent.payload || {}), gatewayRequestId: transaction.gatewayRequestId },
            deduplicationKey: outboxEvent.deduplicationKey || `dispatch:${transaction.id}`,
            attemptCount: 0,
            attempts: 0,
            maxAttempts: outboxEvent.maxAttempts || 5,
          },
        });
      }
    });
  }

  async findByGatewayRequestId(gatewayRequestId: string): Promise<TransactionRecord | null> {
    if (!this.prismaClient) return null;
    const row = await this.prismaClient.transaction.findUnique({
      where: { gatewayRequestId },
    });
    if (!row) return null;
    return this.mapRowToRecord(row);
  }

  async findByIdempotencyKey(organizationId: string, idempotencyKey: string): Promise<TransactionRecord | null> {
    if (!this.prismaClient) return null;
    const row = await this.prismaClient.transaction.findUnique({
      where: {
        organizationId_idempotencyKey: {
          organizationId,
          idempotencyKey,
        },
      },
    });
    if (!row) return null;
    return this.mapRowToRecord(row);
  }

  async update(transaction: TransactionRecord): Promise<void> {
    if (!this.prismaClient) return;

    const nextStatus = transaction.status.toUpperCase();

    // The transaction row update and its lifecycle-history append are one unit
    // of work: a durable transition can never be recorded without the matching
    // history row (or vice versa). The previous status is read inside the same
    // transaction so the append happens only on a real transition.
    await this.prismaClient.$transaction(async (tx: any) => {
      const previous = await tx.transaction.findUnique({
        where: { gatewayRequestId: transaction.gatewayRequestId },
        select: { status: true, lifecycleState: true },
      });

      await tx.transaction.update({
        where: { gatewayRequestId: transaction.gatewayRequestId },
        data: {
          status: nextStatus,
          lifecycleState: transaction.lifecycleState,
          fabricTransactionId: transaction.fabricTransactionId,
          blockNumber: transaction.blockNumber ? BigInt(transaction.blockNumber) : null,
          blockchainTxHash: transaction.blockchainTxHash,
          attemptCount: transaction.attemptCount,
          errorCode: transaction.errorCode,
          errorMessage: transaction.errorMessage,
          confirmedAt: transaction.confirmedAt ? new Date(transaction.confirmedAt) : null,
          failedAt: transaction.failedAt ? new Date(transaction.failedAt) : null,
        },
      });

      const statusChanged = previous !== null && previous.status !== nextStatus;
      const lifecycleChanged =
        previous !== null && previous.lifecycleState !== transaction.lifecycleState;

      if (statusChanged || lifecycleChanged) {
        await tx.transactionStatusHistory.create({
          data: {
            transactionId: transaction.id,
            fromStatus: previous.status,
            toStatus: nextStatus,
            reason: `LIFECYCLE_${transaction.lifecycleState}`,
            details: {
              lifecycleState: transaction.lifecycleState,
              errorCode: transaction.errorCode ?? null,
            },
          },
        });
      }
    });
  }

  async getAll(limit = 100): Promise<TransactionRecord[]> {
    if (!this.prismaClient) return [];
    const rows = await this.prismaClient.transaction.findMany({
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r: any) => this.mapRowToRecord(r));
  }

  private mapRowToRecord(row: any): TransactionRecord {
    return {
      id: row.id,
      gatewayRequestId: row.gatewayRequestId,
      organizationId: row.organizationId,
      correlationId: row.correlationId,
      idempotencyKey: row.idempotencyKey,
      transactionType: row.transactionType,
      schemaVersion: row.schemaVersion,
      status: row.status.toLowerCase(),
      lifecycleState: row.lifecycleState,
      payloadHash: row.payloadHash,
      hashAlgorithm: row.hashAlgorithm,
      hashVersion: row.hashVersion,
      canonicalizationSpec: row.canonicalizationSpec,
      fabricTransactionId: row.fabricTransactionId,
      blockNumber: row.blockNumber ? Number(row.blockNumber) : null,
      blockchainTxHash: row.blockchainTxHash,
      rawPayload: row.rawPayload,
      canonicalPayload: row.canonicalPayload,
      attemptCount: row.attemptCount,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      submittedAt: row.submittedAt ? new Date(row.submittedAt).toISOString() : new Date().toISOString(),
      confirmedAt: row.confirmedAt ? new Date(row.confirmedAt).toISOString() : null,
      failedAt: row.failedAt ? new Date(row.failedAt).toISOString() : null,
      createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : new Date().toISOString(),
      updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : new Date().toISOString(),
    };
  }
}
