/**
 * The transport and the host's public keys.
 *
 * A write that the host carried out must never be reported as a plain failure
 * because the keys that verify its answer could not be fetched afterwards:
 * the caller would repeat it under a new idempotency key. So the keys are
 * loaded before the first write goes out, a key fetch that fails is tried
 * again (the request never is), and a failed write carries its idempotency
 * key and request id. No fetch of the transport follows a redirect.
 */

import { describe, expect, it } from 'vitest';
import {
  type ClientConfigInput,
  HttpClient,
  KEY_FETCH_ATTEMPTS,
  resolveClientConfig,
  type SdkProduct,
} from '../src/index.js';
import {
  type FakeHost,
  fakeHost,
  type Handler,
  merchantFixture,
  ok,
  type PublicKeysOptions,
  SERVER_KID,
  SERVER_PUBLIC_KEY,
} from '../src/testing/index.js';

const PRODUCT: SdkProduct = {
  name: 'Acme',
  clientName: 'AcmeClient',
  defaultBaseUrl: 'https://api.acme.test',
  defaultApiVersion: '2030-01-01',
  publicKeysPath: '/v1/.well-known/acme-public-keys.json',
  publicKeysConfigField: 'acmePublicKeys',
};

const fx = merchantFixture('acme_test_sk_');

interface Harness {
  http: HttpClient;
  host: FakeHost;
  /** Every URL path asked of the network, in order. */
  asked: string[];
  /** The init of every fetch, in order. */
  inits: Array<RequestInit | undefined>;
}

/**
 * A client on a fake host. `keyFetch(n)` decides the nth request for the key
 * document (1 is the first): 'fail' makes it a network failure.
 */
function harness(
  handler: Handler,
  opts: {
    publicKeys?: PublicKeysOptions;
    keyFetch?: (n: number) => 'ok' | 'fail';
    config?: Partial<ClientConfigInput>;
  } = {},
): Harness {
  const host = fakeHost(PRODUCT, handler, {
    fx,
    ...(opts.publicKeys ? { publicKeys: opts.publicKeys } : {}),
  });
  const asked: string[] = [];
  const inits: Array<RequestInit | undefined> = [];
  let keyFetches = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
    asked.push(path);
    inits.push(init);
    if (path === PRODUCT.publicKeysPath && opts.keyFetch?.(++keyFetches) === 'fail') {
      throw new TypeError('connection reset');
    }
    return host.fetch(input as string, init);
  }) as unknown as typeof fetch;
  const http = new HttpClient(
    PRODUCT,
    resolveClientConfig(PRODUCT, {
      apiKey: fx.apiKey,
      merchantId: fx.merchantId,
      encryptionKey: fx.encryptionKeyB64,
      encryptionKeyId: fx.encryptionKeyId,
      signingPrivateKey: fx.signingPrivateKey,
      signingKeyId: fx.signingKeyId,
      fetch: fetchImpl,
      ...opts.config,
    }),
  );
  return { http, host, asked, inits };
}

const write = { method: 'POST' as const, path: '/v1/payouts', body: { amount: '100' } };

describe('the keys are in hand before a write is sent', () => {
  it('loads the key document first, then sends the write, once each', async () => {
    const h = harness(ok({ id: 'p_1' }));
    await expect(h.http.request(write)).resolves.toEqual({ id: 'p_1' });
    expect(h.asked).toEqual([PRODUCT.publicKeysPath, '/v1/payouts']);
    // A second write reuses the keys.
    await h.http.request(write);
    expect(h.asked).toEqual([PRODUCT.publicKeysPath, '/v1/payouts', '/v1/payouts']);
  });

  it('pinned keys need no fetch at all', async () => {
    const h = harness(ok({ id: 'p_1' }), {
      config: { serverPublicKeys: { [SERVER_KID]: SERVER_PUBLIC_KEY } },
    });
    await h.http.request(write);
    expect(h.asked).toEqual(['/v1/payouts']);
  });

  it('when the keys cannot be loaded the write is not sent, and the error says so', async () => {
    const h = harness(ok({ id: 'p_1' }), { publicKeys: { status: 429 } });
    await expect(h.http.request(write)).rejects.toMatchObject({
      code: 'ENSC_UPSTREAM_FAILED',
      message: /Could not fetch Acme public keys: HTTP 429\. The request was not sent\./,
      details: { requestSent: false },
    });
    // Nothing reached the write route: no payout exists to duplicate.
    expect(h.host.calls).toHaveLength(0);
    expect(h.asked).toEqual(Array(KEY_FETCH_ATTEMPTS).fill(PRODUCT.publicKeysPath));
  });

  it('a read still loads the keys only when its answer arrives', async () => {
    const h = harness(ok({ ok: true }));
    await h.http.request({ method: 'GET', path: '/v1/things' });
    expect(h.asked).toEqual(['/v1/things', PRODUCT.publicKeysPath]);
  });
});

describe('a key fetch that fails after the host answered', () => {
  // The host signs with a key the client did not have when it loaded the
  // document (a rotation), so the answer of a write needs a second fetch.
  const rotated = (): PublicKeysOptions => ({
    keys: [{ kid: 'before_rotation', publicKey: SERVER_PUBLIC_KEY }],
  });

  it('is tried again, and the write is sent exactly once', async () => {
    const publicKeys = rotated();
    const h = harness(ok({ id: 'p_1' }), {
      publicKeys,
      keyFetch: (n) => {
        if (n === 1) return 'ok';
        // From now on the document has the new key; the first refetch is lost.
        publicKeys.keys = [{ kid: SERVER_KID, publicKey: SERVER_PUBLIC_KEY }];
        return n === 2 ? 'fail' : 'ok';
      },
    });
    await expect(h.http.request(write)).resolves.toEqual({ id: 'p_1' });
    expect(h.host.calls).toHaveLength(1);
    expect(h.asked).toEqual([
      PRODUCT.publicKeysPath,
      '/v1/payouts',
      PRODUCT.publicKeysPath,
      PRODUCT.publicKeysPath,
    ]);
  });

  it('that keeps failing gives an error with the idempotency key and the request id, without resending', async () => {
    const h = harness(ok({ id: 'p_1' }), {
      publicKeys: rotated(),
      keyFetch: (n) => (n === 1 ? 'ok' : 'fail'),
    });
    const err = await h.http.request(write).then(
      () => undefined,
      (e: unknown) => e as { code: string; requestId?: string; details?: Record<string, unknown> },
    );
    expect(err).toMatchObject({ code: 'ENSC_UPSTREAM_FAILED' });
    // The write went out once and is not repeated by the SDK.
    expect(h.host.calls).toHaveLength(1);
    const sent = h.host.calls[0]?.headers['x-ensc-idempotency-key'];
    expect(sent).toMatch(/^idm_/);
    expect(err?.details).toMatchObject({ idempotencyKey: sent, responseStatus: 200 });
    expect(err?.requestId).toMatch(/^req_/);
    expect(h.asked.filter((p) => p === PRODUCT.publicKeysPath)).toHaveLength(
      1 + KEY_FETCH_ATTEMPTS,
    );
  });

  it('an answer that does not verify names the idempotency key of the write too', async () => {
    const h = harness(() => ({ status: 200, body: { id: 'p_1' }, timestamp: 1 }));
    const caller = 'caller-key-0001';
    await expect(h.http.request({ ...write, idempotencyKey: caller })).rejects.toMatchObject({
      code: 'ENSC_INVALID_SIGNATURE',
      details: { idempotencyKey: caller, responseStatus: 200 },
      requestId: expect.stringMatching(/^req_/),
    });
    expect(h.host.calls).toHaveLength(1);
  });
});

describe('what a failed write hands the caller', () => {
  it('a network failure carries the idempotency key every attempt used', async () => {
    const keys: string[] = [];
    const h = harness(ok({}), { config: { maxRetries: 1 } });
    const failing = new HttpClient(
      PRODUCT,
      resolveClientConfig(PRODUCT, {
        apiKey: fx.apiKey,
        merchantId: fx.merchantId,
        encryptionKey: fx.encryptionKeyB64,
        encryptionKeyId: fx.encryptionKeyId,
        signingPrivateKey: fx.signingPrivateKey,
        signingKeyId: fx.signingKeyId,
        maxRetries: 1,
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input instanceof Request ? input.url : input);
          if (new URL(url).pathname === PRODUCT.publicKeysPath) return h.host.fetch(url, init);
          keys.push(new Headers(init?.headers).get('X-ENSC-Idempotency-Key') ?? '');
          throw new TypeError('socket hang up');
        }) as unknown as typeof fetch,
      }),
    );
    await expect(failing.request(write)).rejects.toMatchObject({
      code: 'ENSC_UPSTREAM_FAILED',
      details: { idempotencyKey: expect.stringMatching(/^idm_/) },
    });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("a refusal (4xx) is the host's own error, unchanged", async () => {
    const h = harness(() => ({
      status: 409,
      body: { error: { code: 'ENSC_INVALID_STATE', message: 'no', details: { why: 'x' } } },
    }));
    const err = await h.http.request(write).then(
      () => undefined,
      (e: unknown) => e as { details?: Record<string, unknown> },
    );
    expect(err?.details).toEqual({ why: 'x' });
  });
});

describe('redirects', () => {
  it('are never followed: every fetch says so and a 3xx answer is an error', async () => {
    let calls = 0;
    const inits: Array<RequestInit | undefined> = [];
    const http = new HttpClient(
      PRODUCT,
      resolveClientConfig(PRODUCT, {
        apiKey: fx.apiKey,
        merchantId: fx.merchantId,
        encryptionKey: fx.encryptionKeyB64,
        encryptionKeyId: fx.encryptionKeyId,
        signingPrivateKey: fx.signingPrivateKey,
        signingKeyId: fx.signingKeyId,
        serverPublicKeys: { [SERVER_KID]: SERVER_PUBLIC_KEY },
        fetch: (async (_input: string, init?: RequestInit) => {
          calls++;
          inits.push(init);
          return new Response(null, {
            status: 307,
            headers: { Location: 'http://elsewhere.test/v1/payouts' },
          });
        }) as unknown as typeof fetch,
      }),
    );
    await expect(http.request(write)).rejects.toMatchObject({
      code: 'ENSC_UPSTREAM_FAILED',
      status: 307,
      message: /redirect, which is not followed/,
      details: { idempotencyKey: expect.stringMatching(/^idm_/) },
    });
    // One request, not retried and not re-sent to the Location.
    expect(calls).toBe(1);
    expect(inits[0]?.redirect).toBe('manual');
  });

  it('the key document fetch does not follow one either', async () => {
    const h = harness(ok({ ok: true }));
    await h.http.request({ method: 'GET', path: '/v1/things' });
    const keyFetch = h.inits[h.asked.indexOf(PRODUCT.publicKeysPath)];
    expect(keyFetch?.redirect).toBe('manual');
    expect(h.inits[0]?.redirect).toBe('manual');
  });
});
