/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * =============================================================================
 * FABRIC CREDENTIAL HANDLING (Provider Mode)
 * =============================================================================
 *
 * Loads and validates the X.509 material required to open a Fabric Gateway
 * connection:
 *   - The peer's TLS root CA certificate (FABRIC_GATEWAY_TLS_CERT_PATH)
 *   - UBTL's client enrollment certificate (FABRIC_GATEWAY_CLIENT_CERT_PATH)
 *   - UBTL's client private key              (FABRIC_GATEWAY_CLIENT_KEY_PATH)
 *
 * SECURITY: the contents of these files are NEVER logged, echoed or embedded in
 * error messages. Only the environment variable NAME and (for diagnostics) the
 * configured path are surfaced, never the PEM body. This module deliberately
 * has no dependency on the Fabric SDK so that it can be exercised by unit tests
 * without real credentials or a Fabric network.
 */

import { existsSync, readFileSync } from 'node:fs';

export interface FabricCredentialMaterial {
  /** Peer/cluster TLS root CA (PEM). Trust anchor for the gRPC TLS channel. */
  tlsRootCert: Buffer;
  /** UBTL client X.509 enrollment certificate (PEM). Sent as the gateway identity. */
  clientCertificate: Buffer;
  /** UBTL client private key (PEM). Used locally to sign gateway messages. */
  clientPrivateKey: Buffer;
}

export interface FabricCredentialPaths {
  tlsCertPath?: string;
  clientCertPath?: string;
  clientKeyPath?: string;
}

export interface FabricCredentialSource {
  /** Resolve credential material or throw a non-secret FabricCredentialError. */
  load(): FabricCredentialMaterial;
}

export class FabricCredentialError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'FabricCredentialError';
    this.code = code;
  }
}

const PEM_CERTIFICATE_MARKER = '-----BEGIN CERTIFICATE-----';
const PEM_PRIVATE_KEY_MARKER = 'PRIVATE KEY';

export class FileSystemFabricCredentialSource implements FabricCredentialSource {
  constructor(private readonly paths: FabricCredentialPaths) {}

  load(): FabricCredentialMaterial {
    return {
      tlsRootCert: this.readPem(this.paths.tlsCertPath, 'FABRIC_GATEWAY_TLS_CERT_PATH', 'CERTIFICATE'),
      clientCertificate: this.readPem(
        this.paths.clientCertPath,
        'FABRIC_GATEWAY_CLIENT_CERT_PATH',
        'CERTIFICATE'
      ),
      clientPrivateKey: this.readPem(
        this.paths.clientKeyPath,
        'FABRIC_GATEWAY_CLIENT_KEY_PATH',
        'PRIVATE_KEY'
      ),
    };
  }

  private readPem(
    path: string | undefined,
    envName: string,
    kind: 'CERTIFICATE' | 'PRIVATE_KEY'
  ): Buffer {
    if (!path || path.trim() === '') {
      throw new FabricCredentialError(
        'FABRIC_CREDENTIAL_MISSING',
        `[FABRIC_GATEWAY_CREDENTIAL_FAIL_FAST] Missing mandatory credential setting ${envName}.`
      );
    }

    if (!existsSync(path)) {
      throw new FabricCredentialError(
        'FABRIC_CREDENTIAL_FILE_NOT_FOUND',
        `[FABRIC_GATEWAY_CREDENTIAL_FAIL_FAST] Credential file configured by ${envName} was not found on the filesystem.`
      );
    }

    let content: Buffer;
    try {
      content = readFileSync(path);
    } catch {
      // Never surface the underlying error: it can contain a filesystem path
      // and, for permission errors, other host details.
      throw new FabricCredentialError(
        'FABRIC_CREDENTIAL_UNREADABLE',
        `[FABRIC_GATEWAY_CREDENTIAL_FAIL_FAST] Credential file configured by ${envName} could not be read.`
      );
    }

    const text = content.toString('utf8');
    const isPem =
      kind === 'CERTIFICATE'
        ? text.includes(PEM_CERTIFICATE_MARKER)
        : text.includes(PEM_PRIVATE_KEY_MARKER);

    if (!isPem) {
      throw new FabricCredentialError(
        'FABRIC_CREDENTIAL_MALFORMED',
        `[FABRIC_GATEWAY_CREDENTIAL_FAIL_FAST] Credential configured by ${envName} is not a PEM-encoded ${
          kind === 'CERTIFICATE' ? 'certificate' : 'private key'
        }.`
      );
    }

    return content;
  }
}
