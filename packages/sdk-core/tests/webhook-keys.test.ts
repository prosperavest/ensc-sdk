/**
 * The webhook key cache.
 *
 * The key id of a delivery is the sender's text. A receiver that loads the
 * key document whenever it meets a key id it does not know makes one request
 * to the host for every request anyone posts to it, and once the host limits
 * that, genuine deliveries fail too. The cache keeps the document and loads it
 * again for an unknown key id at most once per interval, whatever arrives.
 */

import { bytesToBase64Url, sha256Hex, utf8ToBytes } from '@ensc/protocol';
import { ed25519 } from '@noble/curves/ed25519.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  constructEvent,
  createWebhookKeyCache,
  type SdkProduct,
  WEBHOOK_KEY_REFRESH_INTERVAL_MS,
} from '../src/index.js';

const PRODUCT: SdkProduct = {
  name: 'Acme',
  clientName: 'AcmeClient',
  defaultBaseUrl: 'https://api.acme.test',
  defaultApiVersion: '2030-01-01',
  publicKeysPath: '/v1/.well-known/acme-public-keys.json',
  publicKeysConfigField: 'acmePublicKeys',
};

const SEED_1 = randomBytes(32);
const SEED_2 = randomBytes(32);
const KEY_1 = bytesToBase64Url(ed25519.getPublicKey(SEED_1));
const KEY_2 = bytesToBase64Url(ed25519.getPublicKey(SEED_2));

/** A host that serves the key document; `state` decides what each request gets. */
function host(state: { keys: Record<string, string>; fail?: boolean; delayMs?: number }) {
  const calls = { n: 0, uses: [] as string[] };
  const fetchImpl = (async () => {
    calls.n++;
    if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
    if (state.fail) throw new TypeError('connection reset');
    return new Response(
      JSON.stringify({
        keys: Object.entries(state.keys).map(([kid, publicKey]) => ({
          kid,
          alg: 'Ed25519',
          publicKey,
          use: ['webhooks'],
        })),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** Move the clock the cache reads, without touching timers. */
function clock(start = 1_800_000_000_000) {
  let now = start;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  return {
    advance(ms: number) {
      now += ms;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the webhook key cache', () => {
  it('loads the key document on first use and keeps it', async () => {
    const state = { keys: { kid_1: KEY_1 } };
    const { fetchImpl, calls } = host(state);
    const cache = createWebhookKeyCache(PRODUCT, { fetch: fetchImpl });
    expect(calls.n).toBe(0);
    await expect(cache.get('kid_1')).resolves.toEqual({ kid_1: KEY_1 });
    await expect(cache.get('kid_1')).resolves.toEqual({ kid_1: KEY_1 });
    await expect(cache.get()).resolves.toEqual({ kid_1: KEY_1 });
    await expect(cache.get(null)).resolves.toEqual({ kid_1: KEY_1 });
    expect(calls.n).toBe(1);
  });

  it('an unknown key id costs at most one reload per interval, however many arrive', async () => {
    const time = clock();
    const state = { keys: { kid_1: KEY_1 } };
    const { fetchImpl, calls } = host(state);
    const cache = createWebhookKeyCache(PRODUCT, { fetch: fetchImpl });
    await cache.get('kid_1');
    expect(calls.n).toBe(1);

    // Still inside the interval of the first load: nothing is asked of the host.
    for (let i = 0; i < 50; i++) {
      await expect(cache.get(`forged_${i}`)).resolves.toEqual({ kid_1: KEY_1 });
    }
    expect(calls.n).toBe(1);

    // Past the interval: one reload, then none again until the next interval.
    time.advance(WEBHOOK_KEY_REFRESH_INTERVAL_MS);
    for (let i = 0; i < 50; i++) await cache.get(`forged_again_${i}`);
    expect(calls.n).toBe(2);
    time.advance(WEBHOOK_KEY_REFRESH_INTERVAL_MS - 1);
    await cache.get('forged_last');
    expect(calls.n).toBe(2);
  });

  it('a rotated key reaches the receiver with one reload and no redeploy', async () => {
    const time = clock();
    const state: { keys: Record<string, string> } = { keys: { kid_1: KEY_1 } };
    const { fetchImpl, calls } = host(state);
    const cache = createWebhookKeyCache(PRODUCT, { fetch: fetchImpl });
    await cache.get('kid_1');
    state.keys = { kid_1: KEY_1, kid_2: KEY_2 };
    time.advance(WEBHOOK_KEY_REFRESH_INTERVAL_MS);
    await expect(cache.get('kid_2')).resolves.toEqual({ kid_1: KEY_1, kid_2: KEY_2 });
    expect(calls.n).toBe(2);
    // Known now: no further load.
    await cache.get('kid_2');
    expect(calls.n).toBe(2);
  });

  it('reads the key id from the delivery headers, a Headers instance or a plain record', async () => {
    const time = clock();
    const state = { keys: { kid_1: KEY_1 } };
    const { fetchImpl, calls } = host(state);
    const cache = createWebhookKeyCache(PRODUCT, { fetch: fetchImpl, minRefreshIntervalMs: 1000 });
    await cache.get(new Headers({ 'X-ENSC-Key-Id': 'kid_1' }));
    await cache.get({ 'x-ensc-key-id': 'kid_1' });
    expect(calls.n).toBe(1);
    time.advance(1000);
    await cache.get({ 'x-ensc-key-id': 'kid_unknown' });
    expect(calls.n).toBe(2);
    // A name every object has is not a key the cache holds.
    time.advance(1000);
    await cache.get(new Headers({ 'X-ENSC-Key-Id': 'constructor' }));
    expect(calls.n).toBe(3);
  });

  it('a reload that fails keeps the keys already held', async () => {
    const time = clock();
    const state: { keys: Record<string, string>; fail?: boolean } = { keys: { kid_1: KEY_1 } };
    const { fetchImpl, calls } = host(state);
    const cache = createWebhookKeyCache(PRODUCT, { fetch: fetchImpl });
    await cache.get('kid_1');
    state.fail = true;
    time.advance(WEBHOOK_KEY_REFRESH_INTERVAL_MS);
    await expect(cache.get('kid_2')).resolves.toEqual({ kid_1: KEY_1 });
    expect(calls.n).toBe(2);
    // The failed reload spent the interval too.
    await cache.get('kid_2');
    expect(calls.n).toBe(2);
  });

  it('with no document loaded it throws, and tries again at most once per interval', async () => {
    const time = clock();
    const state: { keys: Record<string, string>; fail?: boolean } = {
      keys: { kid_1: KEY_1 },
      fail: true,
    };
    const { fetchImpl, calls } = host(state);
    const cache = createWebhookKeyCache(PRODUCT, { fetch: fetchImpl });
    await expect(cache.get('kid_1')).rejects.toMatchObject({ code: 'ENSC_UPSTREAM_FAILED' });
    await expect(cache.get('kid_1')).rejects.toMatchObject({ code: 'ENSC_UPSTREAM_FAILED' });
    expect(calls.n).toBe(1);
    state.fail = false;
    time.advance(WEBHOOK_KEY_REFRESH_INTERVAL_MS);
    await expect(cache.get('kid_1')).resolves.toEqual({ kid_1: KEY_1 });
    expect(calls.n).toBe(2);
  });

  it('deliveries that arrive together share one load', async () => {
    const state = { keys: { kid_1: KEY_1 }, delayMs: 20 };
    const { fetchImpl, calls } = host(state);
    const cache = createWebhookKeyCache(PRODUCT, { fetch: fetchImpl });
    const all = await Promise.all(Array.from({ length: 20 }, () => cache.get('kid_1')));
    expect(all.every((k) => k.kid_1 === KEY_1)).toBe(true);
    expect(calls.n).toBe(1);
  });

  it('refuses an interval that is not a number of zero or more', () => {
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY, '60' as unknown as number]) {
      expect(() => createWebhookKeyCache(PRODUCT, { minRefreshIntervalMs: bad })).toThrow(
        /minRefreshIntervalMs/,
      );
    }
  });

  it('a forged key id is refused by the verifier without loading the document again', async () => {
    const time = clock();
    const state = { keys: { kid_1: KEY_1 } };
    const { fetchImpl, calls } = host(state);
    const cache = createWebhookKeyCache(PRODUCT, { fetch: fetchImpl });

    const timestamp = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      id: 'ev_01TEST',
      type: 'conversion.succeeded',
      apiVersion: '2026-09-15',
      merchantId: 'mrc_01MINE',
      env: 'live',
      created: timestamp,
      data: {},
    });
    const signed = (kid: string, seed: Uint8Array) => {
      const canonical = `ENSC-WH-V1\nwhk_1\n${timestamp}\n${sha256Hex(utf8ToBytes(body))}`;
      return {
        'x-ensc-signature': `ed25519=${bytesToBase64Url(ed25519.sign(utf8ToBytes(canonical), seed))}`,
        'x-ensc-timestamp': String(timestamp),
        'x-ensc-webhook-id': 'whk_1',
        'x-ensc-key-id': kid,
      };
    };

    // A genuine delivery verifies with the cached keys.
    const genuine = signed('kid_1', SEED_1);
    const event = constructEvent({
      body,
      headers: genuine,
      publicKey: await cache.get(genuine),
      merchantId: 'mrc_01MINE',
      env: 'live',
    });
    expect(event.id).toBe('ev_01TEST');
    expect(calls.n).toBe(1);

    // Forged key ids: each is refused, and none of them reaches the host.
    for (let i = 0; i < 25; i++) {
      const forged = signed(`forged_${i}`, SEED_2);
      const keys = await cache.get(forged);
      expect(() =>
        constructEvent({
          body,
          headers: forged,
          publicKey: keys,
          merchantId: 'mrc_01MINE',
          env: 'live',
        }),
      ).toThrow(/unknown_key_id/);
    }
    expect(calls.n).toBe(1);
    time.advance(WEBHOOK_KEY_REFRESH_INTERVAL_MS);
    await cache.get(signed('forged_later', SEED_2));
    expect(calls.n).toBe(2);
  });
});
