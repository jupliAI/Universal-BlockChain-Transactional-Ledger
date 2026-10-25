/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Granular internal lifecycle pipeline states
 */
export type InternalLifecycleState =
  | 'RECEIVED'
  | 'VALIDATED'
  | 'HASHED'
  | 'PERSISTED'
  | 'OUTBOX_PENDING'
  | 'SUBMITTED'
  | 'AWAITING_COMMIT'
  | 'COMMITTED'
  | 'VERIFIED'
  | 'REJECTED'
  | 'RETRY_PENDING'
  | 'FAILED'
  | 'RECONCILIATION_REQUIRED';

/**
 * Public Switching contract statuses:
 * - pending: Durably accepted into gateway (OUTBOX_PENDING) or awaiting block consensus
 * - submitted: Dispatched to blockchain network proposal pipeline
 * - confirmed: Committed to blockchain block
 * - failed: Validation rejection or chaincode execution failure
 * - timeout: Consensus commit timeout requiring reconciliation
 */
export type ExternalSwitchingStatus =
  | 'submitted'
  | 'pending'
  | 'confirmed'
  | 'failed'
  | 'timeout';

/**
 * Consistent mapping between granular internal pipeline state and external Switching contract status
 * Durable acceptance (OUTBOX_PENDING) is strictly distinct from actual blockchain submission (SUBMITTED).
 */
export function mapInternalToExternalStatus(state: InternalLifecycleState): ExternalSwitchingStatus {
  switch (state) {
    case 'RECEIVED':
    case 'VALIDATED':
    case 'HASHED':
    case 'PERSISTED':
    case 'OUTBOX_PENDING':
    case 'AWAITING_COMMIT':
    case 'RETRY_PENDING':
      return 'pending';

    case 'SUBMITTED':
      return 'submitted';

    case 'COMMITTED':
    case 'VERIFIED':
      return 'confirmed';

    case 'REJECTED':
    case 'FAILED':
      return 'failed';

    case 'RECONCILIATION_REQUIRED':
      return 'timeout';

    default:
      return 'pending';
  }
}

/**
 * Legal state transition rules
 */
export const ALLOWED_TRANSITIONS: Record<InternalLifecycleState, InternalLifecycleState[]> = {
  RECEIVED: ['VALIDATED', 'REJECTED'],
  VALIDATED: ['HASHED', 'REJECTED'],
  HASHED: ['PERSISTED', 'REJECTED'],
  PERSISTED: ['OUTBOX_PENDING', 'FAILED'],
  OUTBOX_PENDING: ['SUBMITTED', 'RETRY_PENDING', 'FAILED'],
  SUBMITTED: ['AWAITING_COMMIT', 'COMMITTED', 'RETRY_PENDING', 'FAILED', 'RECONCILIATION_REQUIRED'],
  AWAITING_COMMIT: ['COMMITTED', 'RETRY_PENDING', 'FAILED', 'RECONCILIATION_REQUIRED'],
  RETRY_PENDING: ['SUBMITTED', 'FAILED', 'RECONCILIATION_REQUIRED'],
  COMMITTED: ['VERIFIED', 'RECONCILIATION_REQUIRED'],
  VERIFIED: ['RECONCILIATION_REQUIRED'],
  REJECTED: [],
  FAILED: ['RECONCILIATION_REQUIRED'],
  // Reconciliation recovery: verified commit evidence advances a stuck
  // transaction to COMMITTED (then optionally VERIFIED); definitive provider
  // rejection advances it to FAILED. Inconclusive outcomes stay here.
  RECONCILIATION_REQUIRED: ['COMMITTED', 'VERIFIED', 'FAILED'],
};

export function canTransition(from: InternalLifecycleState, to: InternalLifecycleState): boolean {
  const allowed = ALLOWED_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}
