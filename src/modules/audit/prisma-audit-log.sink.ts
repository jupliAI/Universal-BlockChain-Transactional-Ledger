/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'crypto';
import { sanitizeForLog } from '../security/redaction.ts';
import { AuditLogEntry, AuditLogSink } from './audit.service.ts';

/**
 * Durable audit trail sink backed by the `audit_logs` table.
 *
 * Two deliberate rules:
 *  - `id` is regenerated as a UUID. `audit_logs.id` is a UUID column while the
 *    in-process entry id is a process-local handle; reusing it would make every
 *    durable write fail.
 *  - `metadata` is passed through `sanitizeForLog()` before persisting so that a
 *    secret embedded in a metadata value can never reach the durable store.
 */
export class PrismaAuditLogSink implements AuditLogSink {
  constructor(private readonly prismaClient: any) {}

  async append(entry: AuditLogEntry): Promise<void> {
    if (!this.prismaClient) {
      throw new Error('PrismaClient is not initialized. Connect PostgreSQL and verify DATABASE_URL.');
    }

    await this.prismaClient.auditLog.create({
      data: {
        id: randomUUID(),
        actorType: entry.actorType.slice(0, 32),
        actorId: entry.actorId ? entry.actorId.slice(0, 128) : null,
        action: entry.action.slice(0, 64),
        correlationId: entry.correlationId ? entry.correlationId.slice(0, 128) : null,
        resourceType: entry.resourceType.slice(0, 64),
        resourceId: entry.resourceId ? entry.resourceId.slice(0, 128) : null,
        endpoint: entry.endpoint ? entry.endpoint.slice(0, 255) : null,
        httpStatus: entry.httpStatus ?? null,
        ipAddress: entry.ipAddress ? entry.ipAddress.slice(0, 64) : null,
        metadata: entry.metadata ? (sanitizeForLog(entry.metadata) as any) : null,
        timestamp: new Date(entry.timestamp),
      },
    });
  }
}
