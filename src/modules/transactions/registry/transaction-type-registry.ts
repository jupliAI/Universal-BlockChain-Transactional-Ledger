/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
}

export interface TransactionTypeDefinition {
  type: string;
  aliases: string[];
  description: string;
  version: string;
  validate: (payload: Record<string, unknown>) => ValidationResult;
}

export class TransactionTypeRegistry {
  private definitions = new Map<string, TransactionTypeDefinition>();
  private aliasMap = new Map<string, string>();

  constructor() {
    this.registerDefaults();
  }

  register(def: TransactionTypeDefinition): void {
    const canonicalKey = def.type.toUpperCase();
    this.definitions.set(canonicalKey, def);
    this.aliasMap.set(canonicalKey, canonicalKey);

    for (const alias of def.aliases) {
      this.aliasMap.set(alias.toUpperCase(), canonicalKey);
    }
  }

  isSupported(type: string): boolean {
    if (!type || typeof type !== 'string') return false;
    return this.aliasMap.has(type.toUpperCase());
  }

  getCanonicalType(type: string): string | null {
    if (!type || typeof type !== 'string') return null;
    return this.aliasMap.get(type.toUpperCase()) || null;
  }

  getDefinition(type: string): TransactionTypeDefinition | null {
    const canonicalKey = this.getCanonicalType(type);
    if (!canonicalKey) return null;
    return this.definitions.get(canonicalKey) || null;
  }

  validate(type: string, payload: unknown): ValidationResult {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { isValid: false, errors: ['Payload must be a non-null JSON object'] };
    }

    const canonicalKey = this.getCanonicalType(type);
    if (!canonicalKey) {
      return {
        isValid: false,
        errors: [`Unsupported transaction type: '${type}'. Supported types: ${this.getSupportedTypes().join(', ')}`],
      };
    }

    const def = this.definitions.get(canonicalKey);
    if (!def) {
      return { isValid: false, errors: [`Definition not found for type: '${type}'`] };
    }

    return def.validate(payload as Record<string, unknown>);
  }

  getSupportedTypes(): string[] {
    return Array.from(this.definitions.keys());
  }

  private registerDefaults(): void {
    const checkString = (p: Record<string, unknown>, key: string, errors: string[]) => {
      if (typeof p[key] !== 'string' || (p[key] as string).trim() === '') {
        errors.push(`Field '${key}' must be a non-empty string`);
      }
    };

    const checkDecimal = (p: Record<string, unknown>, key: string, errors: string[]) => {
      if (typeof p[key] !== 'string' || !/^\d+(\.\d{2,})?$/.test(p[key] as string)) {
        errors.push(`Field '${key}' must be a valid decimal string (e.g. "150000.00")`);
      }
    };

    const checkIsoDate = (p: Record<string, unknown>, key: string, errors: string[]) => {
      if (typeof p[key] !== 'string' || isNaN(Date.parse(p[key] as string))) {
        errors.push(`Field '${key}' must be a valid ISO-8601 date-time string`);
      }
    };

    // 1. SALE / SALES
    this.register({
      type: 'SALE',
      aliases: ['SALES'],
      description: 'Retail and wholesale commercial sale transactions',
      version: '1.0',
      validate: (p) => {
        const errors: string[] = [];
        if (!p.orderId && !p.invoiceNumber) {
          errors.push("Field 'orderId' or 'invoiceNumber' must be provided as a non-empty string");
        }
        checkDecimal(p, 'amount', errors);
        checkString(p, 'currency', errors);
        return { isValid: errors.length === 0, errors };
      },
    });

    // 2. PURCHASE
    this.register({
      type: 'PURCHASE',
      aliases: ['PURCHASES'],
      description: 'Procurement and inventory purchasing event',
      version: '1.0',
      validate: (p) => {
        const errors: string[] = [];
        checkString(p, 'purchaseOrderNumber', errors);
        checkString(p, 'supplierId', errors);
        checkDecimal(p, 'totalAmount', errors);
        checkString(p, 'currency', errors);
        return { isValid: errors.length === 0, errors };
      },
    });

    // 3. SAVINGS
    this.register({
      type: 'SAVINGS',
      aliases: ['SAVING_DEPOSIT'],
      description: 'Deposit or savings account ledger event',
      version: '1.0',
      validate: (p) => {
        const errors: string[] = [];
        checkString(p, 'accountNumber', errors);
        checkString(p, 'accountHolderId', errors);
        checkDecimal(p, 'amount', errors);
        checkString(p, 'currency', errors);
        checkString(p, 'operationType', errors); // DEPOSIT, WITHDRAWAL
        return { isValid: errors.length === 0, errors };
      },
    });

    // 4. LOAN / LOANS
    this.register({
      type: 'LOAN',
      aliases: ['LOANS'],
      description: 'Loan disbursement, servicing, or amortization event',
      version: '1.0',
      validate: (p) => {
        const errors: string[] = [];
        checkString(p, 'loanId', errors);
        checkString(p, 'borrowerId', errors);
        checkString(p, 'lenderId', errors);
        checkDecimal(p, 'principalAmount', errors);
        checkString(p, 'currency', errors);
        return { isValid: errors.length === 0, errors };
      },
    });

    // 5. LAND_CERTIFICATE_EVENT / LAND_DOCUMENTS
    this.register({
      type: 'LAND_CERTIFICATE_EVENT',
      aliases: ['LAND_DOCUMENTS', 'LAND_CERTIFICATE'],
      description: 'Land parcel deed, transfer, or rights registration event',
      version: '1.0',
      validate: (p) => {
        const errors: string[] = [];
        checkString(p, 'parcelId', errors);
        checkString(p, 'certificateType', errors);
        checkString(p, 'certificateNumber', errors);
        checkDecimal(p, 'landAreaSqm', errors);
        return { isValid: errors.length === 0, errors };
      },
    });

    // 6. TAX_PAYMENT / TAX_PAYMENTS
    this.register({
      type: 'TAX_PAYMENT',
      aliases: ['TAX_PAYMENTS', 'TAX'],
      description: 'National and municipal tax remittance',
      version: '1.0',
      validate: (p) => {
        const errors: string[] = [];
        checkString(p, 'billingCode', errors);
        checkString(p, 'taxpayerId', errors);
        checkDecimal(p, 'amount', errors);
        checkString(p, 'currency', errors);
        return { isValid: errors.length === 0, errors };
      },
    });

    // 7. GOLD_PURCHASE / GOLD_PURCHASES
    this.register({
      type: 'GOLD_PURCHASE',
      aliases: ['GOLD_PURCHASES', 'GOLD'],
      description: 'Physical vaulted gold purchase or custody transfer',
      version: '1.0',
      validate: (p) => {
        const errors: string[] = [];
        checkString(p, 'certificateNumber', errors);
        checkString(p, 'buyerId', errors);
        checkDecimal(p, 'weightGrams', errors);
        checkDecimal(p, 'totalPrice', errors);
        checkString(p, 'currency', errors);
        return { isValid: errors.length === 0, errors };
      },
    });

    // 8. WAQF
    this.register({
      type: 'WAQF',
      aliases: ['CASH_WAQF', 'WAQF_ASSET'],
      description: 'Islamic endowment deed and asset commitment',
      version: '1.0',
      validate: (p) => {
        const errors: string[] = [];
        checkString(p, 'waqfCertificateId', errors);
        checkString(p, 'waqfType', errors);
        checkDecimal(p, 'assetValue', errors);
        checkString(p, 'currency', errors);
        checkString(p, 'allocationPurpose', errors);
        return { isValid: errors.length === 0, errors };
      },
    });

    // 9. DONATION / DONATIONS
    this.register({
      type: 'DONATION',
      aliases: ['DONATIONS', 'CHARITY'],
      description: 'Charitable contribution or social program donation',
      version: '1.0',
      validate: (p) => {
        const errors: string[] = [];
        checkString(p, 'campaignId', errors);
        checkDecimal(p, 'amount', errors);
        checkString(p, 'currency', errors);
        return { isValid: errors.length === 0, errors };
      },
    });

    // 10. CUSTOM_EVENT
    this.register({
      type: 'CUSTOM_EVENT',
      aliases: ['CUSTOM', 'GENERIC_EVENT'],
      description: 'Custom domain event requiring payload hash immutability',
      version: '1.0',
      validate: (p) => {
        const errors: string[] = [];
        checkString(p, 'eventName', errors);
        if (p.timestamp !== undefined) {
          checkIsoDate(p, 'timestamp', errors);
        }
        return { isValid: errors.length === 0, errors };
      },
    });
  }
}
