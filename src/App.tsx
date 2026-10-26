/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import {
  ShieldCheck,
  Blocks,
  Activity,
  FileCode2,
  RefreshCw,
  Send,
  Database,
  CheckCircle2,
  Clock,
  AlertTriangle,
  Lock,
  ArrowRight,
  Server,
  Layers,
  Copy,
  ExternalLink,
  ChevronRight,
  Search,
  BookOpen,
  Hash,
  ArrowUpDown,
} from 'lucide-react';

interface HealthData {
  status: string;
  version: string;
  adapterMode: 'mock' | 'provider';
  blockchainAdapter: {
    status: string;
    mode: string;
    peerEndpoint: string;
    channelName: string;
    currentBlockHeight: number;
    latencyMs: number;
    details: string;
  };
  worker?: {
    workerId: string;
    running: boolean;
    isShuttingDown: boolean;
    lastPollTime: string | null;
    activeProcessingCount: number;
  };
  outbox: {
    totalEvents?: number;
    pendingCount: number;
    processingCount?: number;
    inProgressCount: number;
    retryPendingCount?: number;
    completedCount: number;
    failedCount: number;
    deadLetterCount: number;
    oldestPendingAgeMs?: number;
    lastErrorCode?: string | null;
  };
}

interface TransactionItem {
  id: string;
  gatewayRequestId: string;
  correlationId: string;
  idempotencyKey: string;
  transactionType: string;
  status: 'submitted' | 'pending' | 'confirmed' | 'failed' | 'timeout';
  lifecycleState?: string;
  payloadHash: string;
  fabricTransactionId: string | null;
  blockNumber: number | null;
  blockchainTxHash: string | null;
  rawPayload: Record<string, unknown>;
  canonicalPayload: string;
  submittedAt: string;
  confirmedAt: string | null;
  errorMessage: string | null;
}

const TEMPLATES: Record<string, Record<string, unknown>> = {
  SALE: {
    invoiceNumber: 'INV-2026-9912',
    orderId: 'ORD-2026-9912',
    buyerId: 'BUYER-JKT-1029',
    sellerId: 'MERCHANT-GOLD-88',
    amount: '1500000.00',
    currency: 'IDR',
  },
  PURCHASE: {
    purchaseOrderNumber: 'PO-2026-7781',
    supplierId: 'SUPPLIER-METAL-01',
    totalAmount: '4500000.00',
    currency: 'IDR',
  },
  SAVINGS: {
    accountNumber: 'ACC-88192019',
    accountHolderId: 'CUST-ID-1002',
    amount: '1000000.00',
    currency: 'IDR',
    operationType: 'DEPOSIT',
  },
  LOAN: {
    loanId: 'LN-2026-781',
    borrowerId: 'BORROWER-SME-991',
    lenderId: 'BANK-SYARIAH-01',
    principalAmount: '50000000.00',
    currency: 'IDR',
  },
  LAND_CERTIFICATE_EVENT: {
    parcelId: 'NIB-31.71.05.001.01234',
    certificateType: 'SHM',
    certificateNumber: 'SHM-04512-PASAR-MINGGU',
    landAreaSqm: '450.00',
  },
  TAX_PAYMENT: {
    billingCode: 'TAX-BILL-88391203',
    taxpayerId: 'NPWP-092831923019000',
    amount: '3450000.00',
    currency: 'IDR',
  },
  GOLD_PURCHASE: {
    certificateNumber: 'ANTAM-AU-2026-9921',
    buyerId: 'CUST-GOLD-441',
    weightGrams: '10.0000',
    totalPrice: '14500000.00',
    currency: 'IDR',
  },
  WAQF: {
    waqfCertificateId: 'WQ-CASH-2026-0041',
    waqfType: 'CASH_WAQF',
    assetValue: '10000000.00',
    currency: 'IDR',
    allocationPurpose: 'Pembangunan Rumah Sakit Wakaf',
  },
  DONATION: {
    campaignId: 'CMP-EDUCATION-2026',
    amount: '250000.00',
    currency: 'IDR',
  },
  CUSTOM_EVENT: {
    eventName: 'AUDIT_MILESTONE_ATTESTATION',
    referenceId: 'REF-2026-X99',
    timestamp: '2026-10-23T18:30:00.000Z',
  },
};

const DOC_FILES = [
  { id: 'PROJECT_CONSTITUTION.md', title: 'Project Constitution', desc: 'Core axioms, security invariants, provider neutrality' },
  { id: 'docs/PRD.md', title: 'Product Requirements', desc: 'Stakeholders, FRs, NFRs, and sub-200ms SLAs' },
  { id: 'docs/architecture.md', title: 'System Architecture', desc: 'Component topology, modules, and C4 data flows' },
  { id: 'docs/data-model.md', title: 'PostgreSQL & Prisma', desc: 'Data model, entity diagrams, and index optimization' },
  { id: 'docs/api-contract.md', title: 'OpenAPI Specification', desc: 'Switching gateway endpoints & webhook signatures' },
  { id: 'docs/switching-integration.md', title: 'Switching Integration', desc: 'Upstream contract analysis & unresolved items' },
  { id: 'docs/hash-specification.md', title: 'Canonical Hashing', desc: 'RFC 8785 JCS, Unicode NFC, and versioned schemas' },
  { id: 'docs/state-machine.md', title: 'State Machine', desc: 'Finite automaton, Axiom 5 confirmation discipline' },
  { id: 'docs/security.md', title: 'Security Architecture', desc: 'STRIDE threat modeling, off-chain privacy, mTLS' },
  { id: 'docs/provider-requirements.md', title: 'Provider Requirements', desc: 'Hyperledger Fabric network specifications' },
  { id: 'docs/testing-strategy.md', title: 'Testing Strategy', desc: 'Pyramid, contract tests, golden hash vectors' },
  { id: 'docs/deployment.md', title: 'Deployment Guide', desc: 'Docker Compose, Kubernetes, and PgBouncer runbook' },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<'gateway' | 'transactions' | 'outbox' | 'docs' | 'verify'>('gateway');
  const [health, setHealth] = useState<HealthData | null>(null);
  const [transactions, setTransactions] = useState<TransactionItem[]>([]);
  const [selectedTx, setSelectedTx] = useState<TransactionItem | null>(null);

  // Form State
  const [txType, setTxType] = useState<string>('SALE');
  const [correlationId, setCorrelationId] = useState<string>(`switch-corr-${Date.now().toString().slice(-6)}`);
  const [idempotencyKey, setIdempotencyKey] = useState<string>(`idemp-${Date.now().toString().slice(-6)}`);
  const [payloadText, setPayloadText] = useState<string>(JSON.stringify(TEMPLATES.SALE, null, 2));
  const [apiKey, setApiKey] = useState<string>('ubtl_dev_key_secret_switch_2026');
  const [adminApiKey, setAdminApiKey] = useState<string>('');
  const [adminError, setAdminError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [submitResponse, setSubmitResponse] = useState<any>(null);

  // Ledger table view state. `q` and `transactionType` are applied SERVER-side
  // (the admin endpoint narrows in the database); sorting is applied locally to
  // the returned page.
  const [txSearch, setTxSearch] = useState<string>('');
  const [txQuery, setTxQuery] = useState<string>('');
  const [txTypeFilter, setTxTypeFilter] = useState<string>('');
  const [txSort, setTxSort] = useState<{ key: 'type' | 'submittedAt'; dir: 'asc' | 'desc' }>({
    key: 'submittedAt',
    dir: 'desc',
  });

  const visibleTransactions = useMemo(
    () =>
      [...transactions].sort((a, b) => {
        const cmp =
          txSort.key === 'type'
            ? a.transactionType.localeCompare(b.transactionType)
            : new Date(a.submittedAt).getTime() - new Date(b.submittedAt).getTime();
        return txSort.dir === 'asc' ? cmp : -cmp;
      }),
    [transactions, txSort]
  );

  const toggleTxSort = (key: 'type' | 'submittedAt') => {
    setTxSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }
    );
  };

  const sortCaret = (key: 'type' | 'submittedAt') =>
    txSort.key === key ? (txSort.dir === 'asc' ? '▲' : '▼') : '';

  // Verification State
  const [verifyGatewayId, setVerifyGatewayId] = useState<string>('');
  const [verifyResult, setVerifyResult] = useState<any>(null);

  // Selected Doc
  const [selectedDoc, setSelectedDoc] = useState<string>('PROJECT_CONSTITUTION.md');

  // Load Health and Transactions
  const fetchHealthAndData = async () => {
    try {
      const hRes = await fetch('/v1/health');
      if (hRes.ok) {
        const hData = await hRes.json();
        setHealth(hData);
      }

      if (adminApiKey.trim() === '') {
        setTransactions([]);
        setAdminError('Enter the UBTL_ADMIN_API_KEY below to load the ledger.');
      } else {
        const params = new URLSearchParams({ limit: '25' });
        if (txQuery) params.set('q', txQuery);
        if (txTypeFilter) params.set('transactionType', txTypeFilter);

        const txRes = await fetch(`/v1/admin/transactions?${params.toString()}`, {
          headers: { 'X-Api-Key': adminApiKey },
        });
        if (txRes.ok) {
          const txData = await txRes.json();
          setTransactions(txData.transactions || []);
          setAdminError(null);
        } else {
          const body = await txRes.json().catch(() => null);
          const status = `HTTP ${txRes.status}${body?.errorCode ? ` ${body.errorCode}` : ''}`;
          setTransactions([]);
          setAdminError(
            txRes.status === 401
              ? `${status} — this endpoint requires UBTL_ADMIN_API_KEY, not the Switching ingestion key.`
              : `${status} — ${body?.message || 'the ledger query failed; check the backend logs.'}`
          );
        }
      }
    } catch (e) {
      console.error('Error fetching data:', e);
    }
  };

  // Debounced so that typing a query does not spend one admin request per
  // keystroke — the ledger is re-fetched by the polling effect below.
  useEffect(() => {
    const timer = setTimeout(() => setTxQuery(txSearch.trim()), 400);
    return () => clearTimeout(timer);
  }, [txSearch]);

  useEffect(() => {
    fetchHealthAndData();
    const interval = setInterval(fetchHealthAndData, 3000);
    return () => clearInterval(interval);
  }, [apiKey, adminApiKey, txQuery, txTypeFilter]);

  const handleTemplateChange = (type: string) => {
    setTxType(type);
    // A different transaction type is a different logical transaction: reusing
    // the previous idempotency key would be rejected by the backend with
    // IDEMPOTENCY_CONFLICT (same key, different payload/type).
    setIdempotencyKey(`idemp-${Date.now().toString().slice(-6)}`);
    if (TEMPLATES[type]) {
      setPayloadText(JSON.stringify(TEMPLATES[type], null, 2));
    }
  };

  const handleSubmitTransaction = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setSubmitResponse(null);

    try {
      let parsedPayload: any;
      try {
        parsedPayload = JSON.parse(payloadText);
      } catch (err) {
        alert('Invalid JSON in payload editor');
        setIsSubmitting(false);
        return;
      }

      const res = await fetch('/v1/transactions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': apiKey,
          'X-Correlation-Id': correlationId,
        },
        body: JSON.stringify({
          correlationId,
          idempotencyKey,
          transactionType: txType,
          payload: parsedPayload,
        }),
      });

      const data = await res.json();
      setSubmitResponse({
        status: res.status,
        statusText: res.statusText,
        data,
      });

      if (res.status === 202 && data.gatewayRequestId) {
        setVerifyGatewayId(data.gatewayRequestId);
        fetchHealthAndData();
      }
    } catch (err: any) {
      setSubmitResponse({
        status: 500,
        statusText: 'Network Error',
        data: { error: err.message },
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleVerify = async () => {
    if (!verifyGatewayId) return;
    try {
      const res = await fetch('/v1/transactions/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': apiKey,
        },
        body: JSON.stringify({ gatewayRequestId: verifyGatewayId }),
      });
      const data = await res.json();
      setVerifyResult(data);
    } catch (err: any) {
      setVerifyResult({ error: err.message });
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'confirmed':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-50/80 text-emerald-600 border border-emerald-200/60">
            <CheckCircle2 className="w-3.5 h-3.5" /> CONFIRMED
          </span>
        );
      case 'pending':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-50/80 text-amber-600 border border-amber-200/60">
            <Clock className="w-3.5 h-3.5 animate-pulse" /> PENDING
          </span>
        );
      case 'submitted':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-50/80 text-blue-600 border border-blue-200/60">
            <RefreshCw className="w-3.5 h-3.5 animate-spin" /> SUBMITTED (202)
          </span>
        );
      case 'failed':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-50/80 text-rose-600 border border-rose-200/60">
            <AlertTriangle className="w-3.5 h-3.5" /> FAILED
          </span>
        );
      case 'timeout':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-purple-50/80 text-purple-600 border border-purple-200/60">
            <Clock className="w-3.5 h-3.5" /> TIMEOUT
          </span>
        );
      default:
        return <span className="text-xs text-slate-500">{status}</span>;
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 text-slate-800 flex flex-col font-sans antialiased selection:bg-indigo-500 selection:text-slate-900">
      {/* Top Header */}
      <header className="border-b border-slate-200/80 bg-white/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-600 via-blue-600 to-cyan-500 p-0.5 shadow-lg shadow-indigo-500/20">
              <div className="w-full h-full bg-white rounded-[10px] flex items-center justify-center">
                <Blocks className="w-5 h-5 text-indigo-600" />
              </div>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="font-bold text-lg tracking-tight text-slate-900">UBTL</h1>
                <span className="text-xs px-2 py-0.5 rounded bg-slate-100 border border-slate-300 text-slate-700 font-mono">
                  v1.0.0
                </span>
                <span className="text-xs px-2 py-0.5 rounded bg-emerald-50 border border-emerald-200 text-emerald-600 font-mono flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                  {health?.adapterMode ? health.adapterMode.toUpperCase() + ' MODE' : 'MOCK MODE'}
                </span>
              </div>
              <p className="text-xs text-slate-500 truncate max-w-md">
                Universal Blockchain Transaction Ledger • Provider-Neutral Gateway
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="hidden md:flex items-center gap-6 text-xs text-slate-500 font-mono">
              <div className="flex items-center gap-1.5">
                <Server className="w-3.5 h-3.5 text-slate-400" />
                <span>Port: 3000</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Database className="w-3.5 h-3.5 text-indigo-600" />
                <span>Block: #{health?.blockchainAdapter?.currentBlockHeight || 14200}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Activity className="w-3.5 h-3.5 text-emerald-600" />
                <span>Outbox: {health?.outbox?.pendingCount || 0} queued</span>
              </div>
            </div>

            <button
              onClick={fetchHealthAndData}
              className="p-2 rounded-lg bg-slate-100/80 hover:bg-slate-200/80 text-slate-700 transition-colors border border-slate-300/50"
              title="Refresh State"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex space-x-1 overflow-x-auto border-t border-slate-200/40">
          {[
            { id: 'gateway', label: 'Gateway Ingestion (Switching)', icon: Send },
            { id: 'transactions', label: `Transactions Ledger (${transactions.length})`, icon: Layers },
            { id: 'verify', label: 'Cryptographic Proof Verifier', icon: ShieldCheck },
            { id: 'outbox', label: 'Outbox & Webhooks', icon: Activity },
            { id: 'docs', label: 'Architecture & Specifications', icon: BookOpen },
          ].map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`flex items-center gap-2 py-3 px-4 text-xs font-medium border-b-2 transition-all whitespace-nowrap ${
                  isActive
                    ? 'border-indigo-500 text-indigo-700 bg-indigo-50'
                    : 'border-transparent text-slate-500 hover:text-slate-800 hover:bg-slate-100'
                }`}
              >
                <Icon className={`w-4 h-4 ${isActive ? 'text-indigo-600' : 'text-slate-400'}`} />
                {tab.label}
              </button>
            );
          })}
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8">
        {/* TAB 1: GATEWAY INGESTION */}
        {activeTab === 'gateway' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Left: Input Console */}
            <div className="lg:col-span-7 space-y-6">
              <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xl">
                <div className="flex items-center justify-between mb-4 pb-3 border-b border-slate-200">
                  <div>
                    <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                      <Send className="w-4 h-4 text-indigo-600" />
                      Switching Gateway API — Ingestion Client
                    </h2>
                    <p className="text-xs text-slate-500">
                      Implements <code className="text-indigo-700">POST /v1/transactions</code> with HTTP 202 acknowledgment
                    </p>
                  </div>
                  <span className="text-xs font-mono bg-slate-100 px-2 py-1 rounded text-slate-700">
                    202 Accepted
                  </span>
                </div>

                <form onSubmit={handleSubmitTransaction} className="space-y-4">
                  {/* Category Template Selectors */}
                  <div>
                    <label className="block text-xs font-medium text-slate-500 mb-1.5">
                      Transaction Schema Type (7 Versioned Business Types)
                    </label>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                      {Object.keys(TEMPLATES).map((type) => (
                        <button
                          key={type}
                          type="button"
                          onClick={() => handleTemplateChange(type)}
                          className={`text-xs px-2.5 py-1.5 rounded-lg border font-mono transition-all text-left ${
                            txType === type
                              ? 'bg-indigo-50 border-indigo-500 text-indigo-700'
                              : 'bg-slate-50 border-slate-200 text-slate-500 hover:border-slate-300'
                          }`}
                        >
                          {type}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">
                        Correlation ID (<code className="text-slate-400">correlationId</code>)
                      </label>
                      <input
                        type="text"
                        value={correlationId}
                        onChange={(e) => setCorrelationId(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-xs font-mono text-slate-800 focus:outline-none focus:border-indigo-500"
                        required
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">
                        Idempotency Key (<code className="text-slate-400">idempotencyKey</code>)
                      </label>
                      <input
                        type="text"
                        value={idempotencyKey}
                        onChange={(e) => setIdempotencyKey(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-xs font-mono text-slate-800 focus:outline-none focus:border-indigo-500"
                        required
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-500 mb-1">
                      Authentication Header (<code className="text-slate-400">X-Api-Key</code>)
                    </label>
                    <div className="flex items-center gap-2">
                      <div className="relative flex-1">
                        <Lock className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-400" />
                        <input
                          type="password"
                          value={apiKey}
                          onChange={(e) => setApiKey(e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg pl-9 pr-3 py-1.5 text-xs font-mono text-slate-800 focus:outline-none focus:border-indigo-500"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => setApiKey('ubtl_dev_key_secret_switch_2026')}
                        className="text-xs px-2 py-1.5 rounded bg-slate-100 hover:bg-slate-200 text-slate-700"
                      >
                        Reset Key
                      </button>
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="block text-xs font-medium text-slate-500">
                        Transaction Payload JSON (Off-Chain Canonical Source)
                      </label>
                      <span className="text-[10px] text-slate-400">RFC 8785 Canonical Serialization on submit</span>
                    </div>
                    <textarea
                      rows={8}
                      value={payloadText}
                      onChange={(e) => setPayloadText(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs font-mono text-slate-800 focus:outline-none focus:border-indigo-500 leading-relaxed resize-none"
                    />
                  </div>

                  <div className="flex items-center justify-between pt-2">
                    <button
                      type="button"
                      onClick={() => {
                        setCorrelationId(`switch-corr-${Date.now().toString().slice(-6)}`);
                        setIdempotencyKey(`idemp-${Date.now().toString().slice(-6)}`);
                      }}
                      className="text-xs text-slate-500 hover:text-slate-800 flex items-center gap-1.5"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      Regenerate Nonce / Keys
                    </button>

                    <button
                      type="submit"
                      disabled={isSubmitting}
                      className="inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-800 text-white font-medium text-xs transition-colors shadow-lg shadow-indigo-600/30"
                    >
                      {isSubmitting ? (
                        <>
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                          Ingesting...
                        </>
                      ) : (
                        <>
                          <Send className="w-3.5 h-3.5" />
                          Dispatch to Ingestion API
                        </>
                      )}
                    </button>
                  </div>
                </form>
              </div>
            </div>

            {/* Right: Response & Gateway Contract Details */}
            <div className="lg:col-span-5 space-y-6">
              {/* Response Panel */}
              <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xl">
                <div className="flex items-center justify-between mb-3 pb-3 border-b border-slate-200">
                  <h3 className="text-xs font-semibold text-slate-900 uppercase tracking-wider">
                    API Response Body
                  </h3>
                  {submitResponse && (
                    <span
                      className={`text-xs font-mono px-2 py-0.5 rounded ${
                        submitResponse.status === 202
                          ? 'bg-emerald-50 text-emerald-600 border border-emerald-200'
                          : 'bg-rose-50 text-rose-600 border border-rose-200'
                      }`}
                    >
                      HTTP {submitResponse.status} {submitResponse.statusText}
                    </span>
                  )}
                </div>

                {submitResponse ? (
                  <div className="space-y-3 font-mono text-xs">
                    <pre className="p-3 bg-slate-50 rounded-lg border border-slate-200/80 text-emerald-600 overflow-x-auto text-[11px] leading-relaxed">
                      {JSON.stringify(submitResponse.data, null, 2)}
                    </pre>
                    {submitResponse.data.gatewayRequestId && (
                      <div className="p-3 rounded-lg bg-indigo-50 border border-indigo-200 text-xs space-y-1.5">
                        <div className="text-indigo-700 font-semibold flex items-center gap-1.5">
                          <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                          Transaction Accepted (HTTP 202)
                        </div>
                        <p className="text-slate-500 text-[11px]">
                          Transactional Outbox has recorded the payload and will dispatch proposal to Fabric ledger.
                        </p>
                        <div className="pt-1 flex items-center gap-2">
                          <button
                            onClick={() => {
                              setActiveTab('transactions');
                            }}
                            className="text-xs text-indigo-600 hover:underline flex items-center gap-1"
                          >
                            Track in Ledger <ArrowRight className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="p-8 text-center text-slate-400 text-xs">
                    <Send className="w-8 h-8 mx-auto mb-2 opacity-30" />
                    Submit a transaction to inspect the Switching Gateway contract response
                  </div>
                )}
              </div>

              {/* Architectural Principles Card */}
              <div className="bg-slate-50 border border-slate-200/80 rounded-xl p-5 text-xs space-y-3">
                <div className="font-semibold text-slate-700 flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-emerald-600" />
                  UBTL Ingestion Axioms
                </div>
                <ul className="space-y-2 text-slate-500 list-disc list-inside">
                  <li>
                    <strong className="text-slate-700">Fast Ingestion (&lt;200ms)</strong>: Returns HTTP 202 without blocking on consensus.
                  </li>
                  <li>
                    <strong className="text-slate-700">Idempotency Guarantee</strong>: Compound constraint on <code className="text-slate-700">orgId + idempotencyKey</code> prevents duplicates.
                  </li>
                  <li>
                    <strong className="text-slate-700">Off-Chain Privacy</strong>: Raw payloads stay off-chain; only SHA-256 canonical hash is anchored on the ledger.
                  </li>
                  <li>
                    <strong className="text-slate-700">Axiom 5 Discipline</strong>: Status remains <code className="text-slate-700">submitted</code> or <code className="text-slate-700">pending</code> until block commit is cryptographically verified.
                  </li>
                </ul>
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: TRANSACTIONS LEDGER */}
        {activeTab === 'transactions' && (
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                  <Layers className="w-4 h-4 text-indigo-600" />
                  Universal Ledger Records ({transactions.length})
                </h2>
                <p className="text-xs text-slate-500">
                  {txQuery || txTypeFilter
                    ? `Server-side filter${txTypeFilter ? ` · transactionType=${txTypeFilter}` : ''}${
                        txQuery ? ` · q="${txQuery}"` : ''
                      } · newest 25 matches`
                    : 'Transactions ingested via Gateway API with atomic outbox dispatch and blockchain proofs'}
                </p>
              </div>

              <div className="flex items-center gap-2">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={txSearch}
                    onChange={(e) => setTxSearch(e.target.value)}
                    placeholder="Search correlation, idempotency key, hash, full UUID..."
                    className="w-72 bg-white border border-slate-200 rounded-lg pl-8 pr-3 py-1.5 text-xs font-mono text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <select
                  value={txTypeFilter}
                  onChange={(e) => setTxTypeFilter(e.target.value)}
                  title="Filter by transaction type (applied server-side)"
                  className="bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-mono text-slate-800 focus:outline-none focus:border-indigo-500"
                >
                  <option value="">All types</option>
                  {Object.keys(TEMPLATES).map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
                <button
                  onClick={fetchHealthAndData}
                  className="px-3 py-1.5 rounded-lg bg-slate-50 hover:bg-slate-100 border border-slate-200 text-xs text-slate-700 flex items-center gap-1.5 font-mono"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Poll Ledger
                </button>
              </div>
            </div>

            {adminError ? (
              <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50/30 border border-amber-200/40 text-amber-700 text-xs">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{adminError}</span>
              </div>
            ) : null}

            <div className="flex flex-col sm:flex-row sm:items-center gap-2 p-3 rounded-lg bg-white/80 border border-slate-200">
              <label className="text-xs text-slate-500 shrink-0 flex items-center gap-2">
                <Lock className="w-3.5 h-3.5 text-slate-400" />
                Admin API Key (<code className="text-slate-400">UBTL_ADMIN_API_KEY</code>)
              </label>
              <input
                type="password"
                value={adminApiKey}
                onChange={(e) => setAdminApiKey(e.target.value)}
                placeholder="Paste the admin key here — kept in memory only, never bundled"
                className="flex-1 bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-xs font-mono text-slate-800 focus:outline-none focus:border-indigo-500"
              />
            </div>

            {/* Table */}
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-xl">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs font-mono">
                  <thead className="bg-slate-100 text-slate-500 border-b border-slate-200 uppercase text-[10px] tracking-wider">
                    <tr>
                      <th className="py-3 px-4">Gateway Request ID</th>
                      <th className="py-3 px-4">
                        <button
                          onClick={() => toggleTxSort('type')}
                          title="Sort by transaction type"
                          className={`flex items-center gap-1.5 uppercase tracking-wider hover:text-slate-800 ${
                            txSort.key === 'type' ? 'text-indigo-700' : ''
                          }`}
                        >
                          <ArrowUpDown className="w-3 h-3" />
                          Type {sortCaret('type')}
                        </button>
                      </th>
                      <th className="py-3 px-4">Status</th>
                      <th className="py-3 px-4">Block Height</th>
                      <th className="py-3 px-4">Payload Hash (SHA-256)</th>
                      <th className="py-3 px-4">
                        <button
                          onClick={() => toggleTxSort('submittedAt')}
                          title="Sort by submission time"
                          className={`flex items-center gap-1.5 uppercase tracking-wider hover:text-slate-800 ${
                            txSort.key === 'submittedAt' ? 'text-indigo-700' : ''
                          }`}
                        >
                          <ArrowUpDown className="w-3 h-3" />
                          Submitted {sortCaret('submittedAt')}
                        </button>
                      </th>
                      <th className="py-3 px-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 text-slate-700">
                    {transactions.length === 0 && (txQuery || txTypeFilter) ? (
                      <tr>
                        <td colSpan={7} className="py-12 text-center text-slate-400 font-sans">
                          No transactions match this filter. The search runs server-side across the whole ledger:
                          correlation id, idempotency key and payload hash match as substrings, while the request id
                          must be a complete UUID.
                        </td>
                      </tr>
                    ) : transactions.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="py-12 text-center text-slate-400 font-sans">
                          No transactions recorded yet. Use the Gateway Ingestion tab to submit your first proposal.
                        </td>
                      </tr>
                    ) : (
                      visibleTransactions.map((tx) => (
                        <tr key={tx.gatewayRequestId} className="hover:bg-slate-100 transition-colors">
                          <td className="py-3 px-4 text-indigo-700 font-bold">
                            {tx.gatewayRequestId.slice(0, 8)}...
                            <span className="text-slate-400 font-normal">
                              {tx.gatewayRequestId.slice(-4)}
                            </span>
                          </td>
                          <td className="py-3 px-4">
                            <span className="px-2 py-0.5 rounded bg-slate-100 border border-slate-300/60 text-slate-700">
                              {tx.transactionType}
                            </span>
                          </td>
                          <td className="py-3 px-4">{getStatusBadge(tx.status)}</td>
                          <td className="py-3 px-4">
                            {tx.blockNumber ? (
                              <span className="text-emerald-600 font-bold">#{tx.blockNumber}</span>
                            ) : (
                              <span className="text-slate-400">-</span>
                            )}
                          </td>
                          <td className="py-3 px-4 text-slate-500">
                            {tx.payloadHash.slice(0, 10)}...{tx.payloadHash.slice(-8)}
                          </td>
                          <td className="py-3 px-4 text-slate-400 text-[11px]">
                            {new Date(tx.submittedAt).toLocaleTimeString()}
                          </td>
                          <td className="py-3 px-4 text-right">
                            <button
                              onClick={() => setSelectedTx(tx)}
                              className="px-2.5 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs transition-colors"
                            >
                              Inspect
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Transaction Detail Modal / Card */}
            {selectedTx && (
              <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4">
                <div className="bg-white border border-slate-200 rounded-xl max-w-3xl w-full max-h-[85vh] flex flex-col shadow-2xl">
                  <div className="p-5 border-b border-slate-200 flex items-center justify-between">
                    <div>
                      <h3 className="font-bold text-sm text-slate-900 flex items-center gap-2">
                        <Blocks className="w-4 h-4 text-indigo-600" />
                        Transaction Inspection • {selectedTx.gatewayRequestId}
                      </h3>
                      <p className="text-xs text-slate-500 font-mono">
                        Correlation: {selectedTx.correlationId} | Type: {selectedTx.transactionType}
                      </p>
                    </div>
                    <button
                      onClick={() => setSelectedTx(null)}
                      className="text-slate-500 hover:text-slate-900 p-1"
                    >
                      ✕
                    </button>
                  </div>

                  <div className="p-5 overflow-y-auto space-y-4 text-xs font-mono">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                        <span className="text-slate-400 block text-[10px]">Lifecycle Status</span>
                        <div className="mt-1">{getStatusBadge(selectedTx.status)}</div>
                      </div>
                      <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                        <span className="text-slate-400 block text-[10px]">Fabric Block Height</span>
                        <span className="text-emerald-600 font-bold text-sm mt-1 block">
                          {selectedTx.blockNumber ? `#${selectedTx.blockNumber}` : 'Pending Block Commit'}
                        </span>
                      </div>
                    </div>

                    <div className="p-3 bg-slate-50 rounded-lg border border-slate-200 space-y-2">
                      <div className="text-slate-500 font-semibold text-[11px]">
                        Cryptographic Proof & Identifiers
                      </div>
                      <div>
                        <span className="text-slate-400 text-[10px] block">Payload Hash (SHA-256 of RFC 8785 Canonical JSON)</span>
                        <span className="text-emerald-600 break-all select-all">{selectedTx.payloadHash}</span>
                      </div>
                      <div>
                        <span className="text-slate-400 text-[10px] block">Fabric Transaction ID (Proposal Digest)</span>
                        <span className="text-indigo-700 break-all select-all">
                          {selectedTx.fabricTransactionId || 'Awaiting peer proposal assignment...'}
                        </span>
                      </div>
                      <div>
                        <span className="text-slate-400 text-[10px] block">Legacy Compatibility Field (blockchainTxHash)</span>
                        <span className="text-slate-500 break-all">
                          {selectedTx.blockchainTxHash || 'null'}
                        </span>
                      </div>
                    </div>

                    <div>
                      <span className="text-slate-500 font-semibold text-[11px] block mb-1">
                        Off-Chain Canonical String (JCS)
                      </span>
                      <pre className="p-3 bg-slate-50 rounded-lg border border-slate-200 text-slate-700 text-[10px] overflow-x-auto whitespace-pre-wrap break-all">
                        {selectedTx.canonicalPayload}
                      </pre>
                    </div>

                    <div>
                      <span className="text-slate-500 font-semibold text-[11px] block mb-1">
                        Raw Off-Chain Payload
                      </span>
                      <pre className="p-3 bg-slate-50 rounded-lg border border-slate-200 text-slate-500 text-[10px] overflow-x-auto">
                        {JSON.stringify(selectedTx.rawPayload, null, 2)}
                      </pre>
                    </div>
                  </div>

                  <div className="p-4 border-t border-slate-200 flex justify-end gap-2">
                    <button
                      onClick={() => {
                        setVerifyGatewayId(selectedTx.gatewayRequestId);
                        setActiveTab('verify');
                        setSelectedTx(null);
                      }}
                      className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium"
                    >
                      Verify Proof in Tool
                    </button>
                    <button
                      onClick={() => setSelectedTx(null)}
                      className="px-4 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs"
                    >
                      Close
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* TAB 3: CRYPTOGRAPHIC PROOF VERIFIER */}
        {activeTab === 'verify' && (
          <div className="max-w-3xl mx-auto space-y-6">
            <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-xl space-y-5">
              <div>
                <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-emerald-600" />
                  Independent Cryptographic Proof Verifier
                </h2>
                <p className="text-xs text-slate-500 mt-1">
                  Recomputes the RFC 8785 canonical SHA-256 hash from off-chain source records and cross-verifies against the immutable on-chain block commit proof.
                </p>
              </div>

              <div className="space-y-3">
                <label className="block text-xs font-medium text-slate-700">
                  Target Gateway Request ID
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={verifyGatewayId}
                    onChange={(e) => setVerifyGatewayId(e.target.value)}
                    placeholder="e.g. a3b8e8f2-91e2-4f74-8b54-1b48b9415662"
                    className="flex-1 bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs font-mono text-slate-800 focus:outline-none focus:border-indigo-500"
                  />
                  <button
                    onClick={handleVerify}
                    className="px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium font-mono flex items-center gap-1.5 shadow-lg shadow-emerald-600/20"
                  >
                    <CheckCircle2 className="w-4 h-4" /> Verify Proof
                  </button>
                </div>
              </div>

              {verifyResult && (
                <div className="mt-4 p-4 rounded-xl bg-white border border-slate-200 space-y-3 font-mono text-xs">
                  <div className="flex items-center justify-between pb-3 border-b border-slate-200">
                    <span className="font-semibold text-slate-700">Verification Outcome</span>
                    {verifyResult.verified ? (
                      <span className="px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-200 text-xs font-bold flex items-center gap-1">
                        <CheckCircle2 className="w-3.5 h-3.5" /> CRYPTOGRAPHICALLY VALID
                      </span>
                    ) : (
                      <span className="px-2.5 py-0.5 rounded-full bg-rose-50 text-rose-600 border border-rose-200 text-xs font-bold flex items-center gap-1">
                        <AlertTriangle className="w-3.5 h-3.5" /> TAMPER OR MISMATCH DETECTED
                      </span>
                    )}
                  </div>

                  <div className="space-y-2 text-[11px]">
                    <div>
                      <span className="text-slate-400 block">Recomputed SHA-256 Digest (JCS RFC 8785)</span>
                      <span className="text-emerald-600 break-all">{verifyResult.computedHash}</span>
                    </div>
                    <div>
                      <span className="text-slate-400 block">Stored Database Payload Hash</span>
                      <span className="text-slate-700 break-all">{verifyResult.storedPayloadHash}</span>
                    </div>
                    <div>
                      <span className="text-slate-400 block">Ledger Commit In Block</span>
                      <span className="text-indigo-600">
                        {verifyResult.ledgerCommitVerified
                          ? `Verified in Block #${verifyResult.blockNumber} (TxId: ${verifyResult.fabricTransactionId?.slice(0, 16)}...)`
                          : verifyResult.isSimulated
                          ? `Simulated in Mock Mode (Block #${verifyResult.blockNumber}, TxId: ${verifyResult.fabricTransactionId})`
                          : 'Not yet finalized into block height'}
                      </span>
                    </div>
                    {verifyResult.simulationNotice && (
                      <div className="p-2.5 rounded bg-amber-50/40 border border-amber-200/40 text-amber-700 text-[10px] leading-relaxed">
                        <span className="font-semibold text-amber-700">Simulation Guard:</span> {verifyResult.simulationNotice}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 4: OUTBOX & WEBHOOKS */}
        {activeTab === 'outbox' && (
          <div className="space-y-6">
            <div>
              <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                <Activity className="w-4 h-4 text-indigo-600" />
                Transactional Outbox & Webhook Delivery Engine
              </h2>
              <p className="text-xs text-slate-500">
                Guaranteed at-least-once asynchronous delivery to Switching webhook: <code className="text-indigo-700">POST {`{SWITCHING_BASE_URL}`}/api/v1/webhooks/gateway</code>
              </p>
            </div>

            {/* Outbox Metrics Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              {[
                { label: 'Pending in Queue', val: health?.outbox?.pendingCount || 0, color: 'text-amber-600' },
                { label: 'In Progress (Active)', val: health?.outbox?.inProgressCount || 0, color: 'text-blue-600' },
                { label: 'Completed (Dispatched)', val: health?.outbox?.completedCount || 0, color: 'text-emerald-600' },
                { label: 'Retrying Failures', val: health?.outbox?.failedCount || 0, color: 'text-rose-600' },
                { label: 'Dead Letter Queue', val: health?.outbox?.deadLetterCount || 0, color: 'text-purple-600' },
              ].map((m, i) => (
                <div key={i} className="p-4 rounded-xl bg-white border border-slate-200 shadow">
                  <span className="text-[11px] text-slate-500 block">{m.label}</span>
                  <span className={`text-2xl font-bold font-mono mt-1 block ${m.color}`}>{m.val}</span>
                </div>
              ))}
            </div>

            {/* Outbox Architecture Explanation */}
            <div className="bg-white/80 border border-slate-200 rounded-xl p-5 text-xs text-slate-700 space-y-3 font-mono">
              <div className="font-semibold text-slate-900 flex items-center gap-2">
                <Database className="w-4 h-4 text-indigo-600" />
                PostgreSQL Transactional Outbox Pattern Workflow
              </div>
              <div className="p-3 bg-white rounded-lg text-slate-500 text-[11px] leading-relaxed">
                1. <strong>Atomic Ingestion</strong>: Transaction record and <code className="text-indigo-700">DISPATCH_LEDGER</code> outbox event inserted in one ACID transaction.<br />
                2. <strong>Lock-Free Polling</strong>: Horizontal workers claim jobs via <code className="text-indigo-700">SELECT ... FOR UPDATE SKIP LOCKED</code>.<br />
                3. <strong>Ledger Verification</strong>: Submits proposal, tracks <code className="text-indigo-700">fabricTransactionId</code>, and verifies block inclusion.<br />
                4. <strong>Switching Webhook</strong>: Sends callback with <code className="text-indigo-700">submitted|pending|confirmed|failed|timeout</code> to Switching receiver.
              </div>
            </div>
          </div>
        )}

        {/* TAB 5: DOCUMENTATION EXPLORER */}
        {activeTab === 'docs' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-4 space-y-2">
              <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
                Foundation Documentation (12 Specs)
              </h2>
              {DOC_FILES.map((doc) => (
                <button
                  key={doc.id}
                  onClick={() => setSelectedDoc(doc.id)}
                  className={`w-full text-left p-3 rounded-xl border transition-all ${
                    selectedDoc === doc.id
                      ? 'bg-indigo-50 border-indigo-500 text-indigo-700 shadow-lg shadow-indigo-600/10'
                      : 'bg-white/80 border-slate-200/80 text-slate-500 hover:text-slate-800 hover:border-slate-300'
                  }`}
                >
                  <div className="font-semibold text-xs flex items-center justify-between">
                    <span>{doc.title}</span>
                    <ChevronRight className="w-3.5 h-3.5 opacity-60" />
                  </div>
                  <div className="text-[11px] text-slate-400 mt-1 truncate">{doc.desc}</div>
                  <div className="text-[10px] text-indigo-600 font-mono mt-1">{doc.id}</div>
                </button>
              ))}
            </div>

            <div className="lg:col-span-8 bg-white border border-slate-200 rounded-xl p-6 shadow-xl flex flex-col min-h-[500px]">
              <div className="flex items-center justify-between pb-4 mb-4 border-b border-slate-200">
                <div>
                  <h3 className="font-bold text-sm text-slate-900 flex items-center gap-2">
                    <FileCode2 className="w-4 h-4 text-indigo-600" />
                    {selectedDoc}
                  </h3>
                  <span className="text-[11px] text-slate-400 font-mono">
                    Provider-Neutral Architectural Specification
                  </span>
                </div>
                <span className="text-xs font-mono bg-slate-100 px-2.5 py-1 rounded text-slate-700">
                  Markdown Spec
                </span>
              </div>

              <div className="flex-1 bg-slate-50 p-4 rounded-xl border border-slate-200/80 overflow-y-auto text-xs text-slate-700 font-mono leading-relaxed max-h-[600px]">
                <p className="text-slate-400 mb-4 italic">
                  # Document source path: /{selectedDoc}
                </p>
                <p className="text-slate-500">
                  {DOC_FILES.find((d) => d.id === selectedDoc)?.desc}.
                </p>
                <div className="mt-4 p-3 rounded bg-white border border-slate-200 text-[11px] text-slate-700 space-y-2">
                  <div className="text-indigo-700 font-semibold">Key Architectural Guardrails in this Specification:</div>
                  <ul className="list-disc list-inside space-y-1 text-slate-500">
                    <li>Zero silent assumptions: all draft ambiguities documented as DECISION REQUIRED items.</li>
                    <li>External Switching repository (switching-revisi) left completely untouched.</li>
                    <li>RFC 8785 JSON Canonicalization Scheme enforces deterministic SHA-256 hashes.</li>
                    <li>Axiom 5 confirmation discipline: never confirm on submission, only after verified block commit.</li>
                    <li>Dual-mode provider neutrality: local mock engine for testing, gRPC Fabric Gateway in production.</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-200/80 bg-slate-50 py-4 mt-auto">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-slate-400 font-mono">
          <div className="flex items-center gap-2">
            <span>UBTL Universal Blockchain Transaction Ledger</span>
            <span>•</span>
            <span>Provider-Neutral Foundation</span>
          </div>
          <div>Strict Switching Gateway API Compatibility (RFC 8785 JCS + Hyperledger Fabric)</div>
        </div>
      </footer>
    </div>
  );
}
