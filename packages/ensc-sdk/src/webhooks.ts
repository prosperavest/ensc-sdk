/**
 * Inbound webhook verification for ENSC deliveries.
 *
 * The verifier is the shared one in `@ensc/sdk-core` (ENSC-WH-V1 over the
 * raw body, `X-ENSC-*` headers); this module binds the key loader to the
 * ENSC host.
 */

import {
  createWebhookKeyCache,
  type FetchPublicKeysOptions,
  fetchPublicKeys,
  type WebhookKeyCache,
  type WebhookKeyCacheOptions,
} from '@ensc/sdk-core';
import { ENSC_PRODUCT } from './config.js';

export {
  constructEvent,
  type FetchPublicKeysOptions,
  type VerifyWebhookOptions,
  verifyWebhookSignature,
  WEBHOOK_KEY_REFRESH_INTERVAL_MS,
  type WebhookEvent,
  type WebhookHeaders,
  type WebhookKeyCache,
  type WebhookKeyCacheOptions,
  type WebhookVerificationResult,
} from '@ensc/sdk-core';

/**
 * Load ENSC's current webhook signing keys as `{ [kid]: publicKey }` from
 * `GET /v1/.well-known/ensc-public-keys.json`. Every call is one request: do
 * not call it per delivery. A receiver uses {@link createEnscWebhookKeyCache}.
 */
export function fetchEnscPublicKeys(
  options: FetchPublicKeysOptions = {},
): Promise<Record<string, string>> {
  return fetchPublicKeys(ENSC_PRODUCT, options);
}

/**
 * Keep ENSC's webhook signing keys between deliveries. Create one per
 * process; `await cache.get(headers)` returns the keys to pass to
 * `constructEvent` as `publicKey`. The key document is loaded on first use,
 * and again when a delivery names a key id that is not cached, at most once
 * per interval (a minute by default) however many deliveries name unknown
 * ids: a key rotation needs no redeploy, and requests with invented key ids
 * cannot make your server load the document over and over.
 */
export function createEnscWebhookKeyCache(options: WebhookKeyCacheOptions = {}): WebhookKeyCache {
  return createWebhookKeyCache(ENSC_PRODUCT, options);
}
