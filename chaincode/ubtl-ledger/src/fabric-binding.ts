/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * =============================================================================
 * FABRIC RUNTIME BINDING
 * =============================================================================
 *
 * Maps a Fabric `ChaincodeStub` onto the framework-neutral {@link LedgerContext}
 * port consumed by {@link UbtlLedgerContract}. This is the ONLY file that knows
 * about Fabric's stub shape, and it does so STRUCTURALLY — it imports no
 * `fabric-shim` / `fabric-contract-api` types, so the whole chaincode remains
 * testable without a peer or a chaincode runtime.
 *
 * The exported factory `createFabricContractClass()` is intentionally NOT
 * invoked anywhere in this repository: no chaincode deployment is authorised.
 * It exists so the deployment binding is explicit and reviewable. Its caller
 * must supply the real framework module (see `CHAINCODE_CONTRACT.md` §8).
 */

import { FabricStubLike, LedgerContext } from './types.ts';

/**
 * Convert a Fabric/Protobuf `Timestamp` into an ISO-8601 UTC string.
 * `seconds` may be a plain number or a Long-like `{ low, high }` object
 * depending on the runtime; both are handled without trusting either blindly.
 */
export function timestampToIso(ts: {
  seconds: number | { low: number; high: number; unsigned?: boolean };
  nanos: number;
}): string {
  let seconds: number;
  if (typeof ts.seconds === 'number') {
    seconds = ts.seconds;
  } else {
    // Long-like: low is the least-significant 32 bits. On-ledger timestamps are
    // far below 2^31 seconds, so `low` is the correct and sufficient value here.
    seconds = ts.seconds.low >>> 0;
  }
  const millis = seconds * 1000 + Math.floor((ts.nanos ?? 0) / 1_000_000);
  return new Date(millis).toISOString();
}

/**
 * Adapt a Fabric stub to the chaincode's ledger port.
 *
 * NOTE: Fabric's `getState` returns an empty `Uint8Array` for a missing key;
 * the port normalises that to `null` so absence is unambiguous.
 */
export function createLedgerContextFromStub(stub: FabricStubLike): LedgerContext {
  return {
    async getState(key: string): Promise<Uint8Array | null> {
      const value = await stub.getState(key);
      if (!value || value.length === 0) return null;
      return value;
    },
    async putState(key: string, value: Uint8Array): Promise<void> {
      await stub.putState(key, value);
    },
    getTransactionId(): string {
      return stub.getTxId();
    },
    getMspId(): string {
      return stub.getMspId();
    },
    getTimestampIso(): string {
      return timestampToIso(stub.getTxTimestamp());
    },
  };
}
