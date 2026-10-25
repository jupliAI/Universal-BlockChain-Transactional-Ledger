/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface AuditLogEntry {
  id: string;
  actorType: 'SWITCHING' | 'SYSTEM' | 'OPERATOR';
  actorId?: string;
  action: string;
  correlationId?: string;
  resourceType: string;
  resourceId?: string;
  endpoint?: string;
  httpStatus?: number;
  ipAddress?: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

/**
 * Optional durable sink for the audit trail (e.g. the PostgreSQL `audit_logs`
 * table). Writes are best-effort and MUST NOT break the business path: an audit
 * failure is logged loudly and the in-process copy is retained, but the
 * ingestion/lifecycle operation is never failed because of it.
 */
export interface AuditLogSink {
  append(entry: AuditLogEntry): Promise<void>;
}

export class AuditService {
  private logs: AuditLogEntry[] = [];

  constructor(private readonly durableSink?: AuditLogSink) {}

  record(entry: Omit<AuditLogEntry, 'id' | 'timestamp'>): AuditLogEntry {
    const log: AuditLogEntry = {
      ...entry,
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
    };
    this.logs.unshift(log);
    // Keep in-memory buffer bounded to last 2000 entries
    if (this.logs.length > 2000) {
      this.logs.pop();
    }

    if (this.durableSink) {
      // Fire-and-forget persistence so the synchronous audit API used across the
      // codebase is preserved. Only the error NAME is surfaced: error messages
      // can embed query parameters and must never be written to logs.
      void this.durableSink.append(log).catch((err: unknown) => {
        console.warn(
          `[UBTL] Durable audit write failed (${err instanceof Error ? err.name : typeof err}); the entry remains in the in-process buffer only.`
        );
      });
    }

    return log;
  }

  /** True when audit entries are also written to a durable store. */
  isDurable(): boolean {
    return this.durableSink !== undefined;
  }

  getRecentLogs(limit = 50): AuditLogEntry[] {
    return this.logs.slice(0, limit);
  }

  getLogsByCorrelationId(correlationId: string): AuditLogEntry[] {
    return this.logs.filter((l) => l.correlationId === correlationId);
  }
}
