/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface OrganizationRecord {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  createdAt: string;
}

export class OrganizationsService {
  private organizations = new Map<string, OrganizationRecord>([
    [
      'org-switching-primary-001',
      {
        id: 'org-switching-primary-001',
        code: 'SWITCHING_SYSTEM',
        name: 'Digital Switching System Primary Node',
        isActive: true,
        createdAt: new Date().toISOString(),
      },
    ],
  ]);

  getOrganizationById(id: string): OrganizationRecord | null {
    return this.organizations.get(id) || null;
  }

  getOrganizationByCode(code: string): OrganizationRecord | null {
    for (const org of this.organizations.values()) {
      if (org.code === code) return org;
    }
    return null;
  }
}
