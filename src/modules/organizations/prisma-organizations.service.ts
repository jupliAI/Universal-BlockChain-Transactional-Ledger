/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'crypto';

/**
 * Durable organization resolution for the PostgreSQL persistence path.
 *
 * The runtime identifies tenants with a LOGICAL organization id
 * (e.g. 'org-switching-primary-001' from AuthService), but
 * `transactions.organizationId` is a UUID column with a foreign key to
 * `organizations.id`. Writing the logical identifier straight through would make
 * PostgreSQL reject every ingestion with an invalid-UUID error (22P02) that
 * surfaces to Switching as a generic HTTP 500.
 *
 * The composition root therefore resolves the logical identifier to the durable
 * organization row ONCE at startup and hands the resulting UUID to AuthService,
 * keeping the idempotency scope `(organizationId, idempotencyKey)` meaningful.
 */
export class PostgresOrganizationsService {
  constructor(private readonly prismaClient: any) {}

  /** Returns the durable UUID for an organization code, creating the row if absent. */
  async ensureOrganization(params: { code: string; name: string }): Promise<string> {
    if (!this.prismaClient) {
      throw new Error('PrismaClient is not initialized. Connect PostgreSQL and verify DATABASE_URL.');
    }

    const row = await this.prismaClient.organization.upsert({
      where: { code: params.code },
      update: {},
      create: {
        code: params.code,
        name: params.name,
        // The runtime authenticates with configured API keys, not with this
        // column. A deterministic digest is stored so the NOT NULL column never
        // holds a raw secret (or a placeholder that pretends to be one).
        apiKeyHash: createHash('sha256').update(`ubtl-org:${params.code}`).digest('hex'),
      },
      select: { id: true },
    });

    return row.id;
  }
}
