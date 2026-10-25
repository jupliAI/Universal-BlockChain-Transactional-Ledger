/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { UbtlConfig } from '../../config/environment.ts';
import { BlockchainAdapter } from './adapter.interface.ts';
import { FabricAdapterDependencies, FabricGatewayAdapter } from './fabric-adapter.ts';
import { MockBlockchainAdapter } from './mock-adapter.ts';

export class BlockchainAdapterFactory {
  /**
   * Selects the active ledger adapter. The `dependencies` argument is only used
   * by tests to inject an SDK test double / credential stub; production code
   * always uses the real Fabric Gateway connector.
   */
  static create(config: UbtlConfig, dependencies?: FabricAdapterDependencies): BlockchainAdapter {
    if (config.blockchainAdapterMode === 'provider') {
      return new FabricGatewayAdapter(
        {
          peerEndpoint: config.fabricGatewayPeerEndpoint,
          tlsCertPath: config.fabricGatewayTlsCertPath,
          clientCertPath: config.fabricGatewayClientCertPath,
          clientKeyPath: config.fabricGatewayClientKeyPath,
          mspId: config.fabricGatewayMspId,
          channelName: config.fabricGatewayChannelName,
          chaincodeName: config.fabricGatewayChaincodeName,
          commitTimeoutSeconds: config.fabricGatewayCommitTimeoutSeconds,
          discoveryAsLocalhost: config.fabricGatewayDiscoveryAsLocalhost,
        },
        dependencies
      );
    }

    // Default to Mock adapter for local neutrality
    return new MockBlockchainAdapter(
      config.mockFabricCommitDelayMs,
      config.mockFabricFailureRate,
      config.mockFabricTimeoutRate
    );
  }
}
