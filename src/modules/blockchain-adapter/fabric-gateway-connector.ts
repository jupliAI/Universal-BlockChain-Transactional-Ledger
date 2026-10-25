/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * =============================================================================
 * REAL HYPERLEDGER FABRIC GATEWAY CONNECTOR (SDK Boundary)
 * =============================================================================
 *
 * This is the ONLY module in UBTL that imports `@hyperledger/fabric-gateway`
 * and `@grpc/grpc-js`. It implements the {@link FabricGatewayConnector} port so
 * that the adapter, the outbox worker and the domain remain structurally
 * decoupled from the SDK (Axiom 1 — Provider Neutrality).
 *
 * Verified against the shipped declarations of the installed packages:
 *   - `@hyperledger/fabric-gateway` v1.13.0
 *       connect(options: ConnectOptions): Gateway        (dist/gateway.d.ts)
 *       signers.newPrivateKeySigner(key: KeyObject): Signer
 *                                                        (dist/identity/signers.d.ts)
 *   - `@grpc/grpc-js`
 *       new Client(address, credentials, options?)       (build/src/client.d.ts)
 *       credentials.createSsl(rootCerts?, key?, chain?, verifyOptions?)
 *                                                        (build/src/channel-credentials.d.ts)
 *
 * The SDK is loaded lazily via dynamic `import()` so that:
 *   - Mock mode never requires the Fabric SDK to be resolvable at runtime.
 *   - A missing/incompatible SDK produces an explicit, non-secret error instead
 *     of a silent degradation to mock mode.
 */

import { createPrivateKey } from 'node:crypto';
import {
  FabricConnectOptions,
  FabricGatewayConnector,
  FabricGatewayHandle,
  FabricGrpcClientOptions,
} from './fabric-sdk.port.ts';

export class FabricGatewayConnectorError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'FabricGatewayConnectorError';
    this.code = code;
  }
}

export class RealFabricGatewayConnector implements FabricGatewayConnector {
  private sdk: typeof import('@hyperledger/fabric-gateway') | null = null;
  private grpc: typeof import('@grpc/grpc-js') | null = null;

  async loadSdk(): Promise<void> {
    if (this.sdk && this.grpc) return;

    try {
      this.sdk = await import('@hyperledger/fabric-gateway');
    } catch {
      throw new FabricGatewayConnectorError(
        'FABRIC_SDK_UNAVAILABLE',
        '[FABRIC_GATEWAY_SDK_UNAVAILABLE] The @hyperledger/fabric-gateway client package could not be loaded. Install the declared dependency before enabling provider mode.'
      );
    }

    try {
      this.grpc = await import('@grpc/grpc-js');
    } catch {
      throw new FabricGatewayConnectorError(
        'FABRIC_SDK_UNAVAILABLE',
        '[FABRIC_GATEWAY_SDK_UNAVAILABLE] The @grpc/grpc-js transport package could not be loaded. Install the declared dependency before enabling provider mode.'
      );
    }
  }

  createGrpcClient(
    address: string,
    tlsRootCert: Buffer,
    options: FabricGrpcClientOptions
  ): unknown {
    const grpc = this.requireGrpc();
    const credentials = grpc.credentials.createSsl(tlsRootCert);
    return new grpc.Client(address, credentials, options);
  }

  newSigner(privateKeyPem: Buffer): unknown {
    const sdk = this.requireSdk();
    const key = createPrivateKey(privateKeyPem);
    return sdk.signers.newPrivateKeySigner(key);
  }

  connect(options: FabricConnectOptions): FabricGatewayHandle {
    const sdk = this.requireSdk();
    // The structural port mirrors the SDK's ConnectOptions; the cast only
    // bridges the intentionally-abstract `unknown` members (client/signer/hash).
    return sdk.connect(options as unknown as Parameters<typeof sdk.connect>[0]) as FabricGatewayHandle;
  }

  closeGrpcClient(client: unknown): void {
    if (client && typeof (client as { close?: unknown }).close === 'function') {
      (client as { close: () => void }).close();
    }
  }

  private requireSdk(): typeof import('@hyperledger/fabric-gateway') {
    if (!this.sdk) {
      throw new FabricGatewayConnectorError(
        'FABRIC_SDK_NOT_LOADED',
        '[FABRIC_GATEWAY_SDK_UNAVAILABLE] Fabric SDK was used before loadSdk() completed.'
      );
    }
    return this.sdk;
  }

  private requireGrpc(): typeof import('@grpc/grpc-js') {
    if (!this.grpc) {
      throw new FabricGatewayConnectorError(
        'FABRIC_SDK_NOT_LOADED',
        '[FABRIC_GATEWAY_SDK_UNAVAILABLE] gRPC transport was used before loadSdk() completed.'
      );
    }
    return this.grpc;
  }
}
