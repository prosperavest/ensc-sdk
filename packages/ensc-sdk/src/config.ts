/**
 * ENSC client configuration.
 *
 * The validation, defaults and secret handling live in `@ensc/sdk-core`
 * (shared with the other ProsperaVest SDKs); this module is the ENSC product:
 * its host, its version pin, its public-key document and the name of the
 * pinned-keys field.
 *
 * Secrets enter the SDK exactly here, through the constructor. The SDK never
 * reads `process.env` itself; wiring environment variables is the consumer's
 * job. Resolved secrets are held in a closure inside the client and are never
 * logged, serialized, or exposed as enumerable properties.
 */

import { CURRENT_API_VERSION } from '@ensc/protocol';
import {
  type ClientConfigBase,
  type ResolvedClientConfig,
  resolveClientConfig,
  type SdkProduct,
} from '@ensc/sdk-core';

export {
  DEFAULT_MAX_RETRIES,
  DEFAULT_RESPONSE_MAX_SKEW_SECONDS,
  DEFAULT_TIMEOUT_MS,
} from '@ensc/sdk-core';

/** Default ENSC API base URL. Override for staging / local. */
export const DEFAULT_BASE_URL = 'https://api.ensc.prosperavest.com';

/**
 * Default `X-ENSC-API-Version` sent on every request. Pinning the version means
 * a future API change cannot silently alter behavior under a deployed integration.
 * Bump this deliberately, with a changelog entry, when adopting a newer contract.
 *
 * 2026-09-15 introduced mandatory request encryption (ENSC-ENC-V1) and sealed,
 * signed responses (ENSC-RESP-V1).
 */
export const DEFAULT_API_VERSION: string = CURRENT_API_VERSION;

/** Path of the public-key document the SDK verifies sealed responses against. */
export const PUBLIC_KEYS_PATH = '/v1/.well-known/ensc-public-keys.json';

/** The ENSC product as the shared client core sees it. */
export const ENSC_PRODUCT: SdkProduct = {
  name: 'ENSC',
  clientName: 'EnscClient',
  defaultBaseUrl: DEFAULT_BASE_URL,
  defaultApiVersion: DEFAULT_API_VERSION,
  publicKeysPath: PUBLIC_KEYS_PATH,
  publicKeysConfigField: 'enscPublicKeys',
};

export interface EnscClientConfig extends ClientConfigBase {
  /**
   * Merchant API key (secret): `ensc_live_sk_…`, `ensc_test_sk_…`, or an
   * `rk` restricted key. Sent as `Authorization: Bearer`. Identifies the
   * merchant and carries env + scopes.
   */
  apiKey: string;

  /**
   * ENSC's Ed25519 public keys, keyed by key id, used to verify the signature
   * on every sealed response. When omitted the SDK fetches
   * {@link PUBLIC_KEYS_PATH} from `baseUrl` once per client and caches it.
   * Pin them here to remove that network dependency in locked-down deployments.
   */
  enscPublicKeys?: Record<string, string>;

  /** API base URL. Defaults to {@link DEFAULT_BASE_URL}. */
  baseUrl?: string;

  /** `X-ENSC-API-Version` header value. Defaults to {@link DEFAULT_API_VERSION}. */
  apiVersion?: string;
}

/** Fully-resolved, validated configuration. Secrets live only on this object. */
export type ResolvedConfig = ResolvedClientConfig;

/**
 * Validate raw config and fill defaults. Throws `EnscError('ENSC_VALIDATION_FAILED')`
 * with a clear message for anything missing or malformed, failing here, at
 * construction, rather than on the first request.
 */
export function resolveConfig(config: EnscClientConfig): ResolvedConfig {
  if (!config || typeof config !== 'object') {
    return resolveClientConfig(ENSC_PRODUCT, config);
  }
  const { enscPublicKeys, ...rest } = config;
  return resolveClientConfig(ENSC_PRODUCT, {
    ...rest,
    ...(enscPublicKeys !== undefined ? { serverPublicKeys: enscPublicKeys } : {}),
  });
}
