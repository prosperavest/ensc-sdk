/**
 * The fake ENSC API used by the SDK tests: `@ensc/sdk-core/testing`'s host
 * (decrypts ENSC-ENC-V1 envelopes, verifies ENSC-V1 signatures, serves the
 * public-key document, seals + signs every 2xx) bound to the ENSC product and
 * wired to an `EnscClient`.
 */

import {
  base64UrlToBytes,
  merchantFixture as coreMerchantFixture,
  fakeHost,
  type Handler,
  type MerchantFixture,
  ok,
  type PublicKeysOptions,
  type RecordedCall,
  type Reply,
  SERVER_KID,
  SERVER_PUBLIC_KEY,
  SERVER_SIGNING_SEED,
} from '@ensc/sdk-core/testing';
import { ENSC_PRODUCT } from '../src/config.js';
import { EnscClient, type EnscClientConfig } from '../src/index.js';

export type { Handler, MerchantFixture, PublicKeysOptions, RecordedCall, Reply };
export { base64UrlToBytes, ok };

/** ENSC's own response-signing key for the test server. */
export const ENSC_SIGNING_SEED = SERVER_SIGNING_SEED;
export const ENSC_KID = SERVER_KID;
export const ENSC_PUBLIC_KEY = SERVER_PUBLIC_KEY;

export function merchantFixture(): MerchantFixture {
  return coreMerchantFixture('ensc_test_sk_');
}

export function configFor(
  fx: MerchantFixture,
  extra: Partial<EnscClientConfig> = {},
): EnscClientConfig {
  return {
    apiKey: fx.apiKey,
    merchantId: fx.merchantId,
    encryptionKey: fx.encryptionKeyB64,
    encryptionKeyId: fx.encryptionKeyId,
    signingPrivateKey: fx.signingPrivateKey,
    signingKeyId: fx.signingKeyId,
    baseUrl: 'https://api.test',
    ...extra,
  };
}

export interface TestServer {
  fetch: typeof fetch;
  calls: RecordedCall[];
  /** Number of times the well-known document was requested. */
  readonly publicKeyFetches: number;
  client: EnscClient;
  fx: MerchantFixture;
}

/**
 * Build a fake API + a client wired to it. `handler` decides the reply for
 * every non-well-known request.
 */
export function testServer(
  handler: Handler,
  opts: {
    config?: Partial<EnscClientConfig>;
    publicKeys?: PublicKeysOptions;
    fx?: MerchantFixture;
  } = {},
): TestServer {
  const fx = opts.fx ?? merchantFixture();
  const host = fakeHost(ENSC_PRODUCT, handler, {
    fx,
    ...(opts.publicKeys ? { publicKeys: opts.publicKeys } : {}),
  });
  const client = new EnscClient(configFor(fx, { fetch: host.fetch, ...opts.config }));
  return {
    fetch: host.fetch,
    calls: host.calls,
    get publicKeyFetches() {
      return host.publicKeyFetches;
    },
    client,
    fx,
  };
}
