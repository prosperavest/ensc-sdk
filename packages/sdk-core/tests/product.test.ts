/**
 * The core is one implementation parameterised by a product descriptor. These
 * tests use a synthetic product to show that everything product-specific
 * (host, version pin, public-keys path, key pattern, names in messages) comes
 * from the descriptor and nothing else.
 */

import { describe, expect, it } from 'vitest';
import {
  type ClientConfigInput,
  fetchPublicKeys,
  HttpClient,
  resolveClientConfig,
  type SdkProduct,
} from '../src/index.js';
import {
  fakeHost,
  merchantFixture,
  ok,
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
  apiKeyPattern: /^acme_(test|live)_(sk|rk)_[A-Za-z0-9_-]+$/,
  apiKeyHint: 'expected acme_test_sk_…',
};

const fx = merchantFixture('acme_test_sk_');

function input(extra: Partial<ClientConfigInput> = {}): ClientConfigInput {
  return {
    apiKey: fx.apiKey,
    merchantId: fx.merchantId,
    encryptionKey: fx.encryptionKeyB64,
    encryptionKeyId: fx.encryptionKeyId,
    signingPrivateKey: fx.signingPrivateKey,
    signingKeyId: fx.signingKeyId,
    ...extra,
  };
}

describe('resolveClientConfig takes its defaults and names from the product', () => {
  it('fills the product host and version pin', () => {
    const c = resolveClientConfig(PRODUCT, input());
    expect(c.baseUrl).toBe('https://api.acme.test');
    expect(c.apiVersion).toBe('2030-01-01');
    expect(c.serverPublicKeys).toBeUndefined();
  });

  it('enforces the product key pattern when one is given, and not otherwise', () => {
    const foreign = merchantFixture('other_test_sk_').apiKey;
    expect(() => resolveClientConfig(PRODUCT, input({ apiKey: foreign }))).toThrow(
      /config.apiKey is not a Acme API key \(expected acme_test_sk_…\)/,
    );
    const { apiKeyPattern: _p, apiKeyHint: _h, ...unpatterned } = PRODUCT;
    expect(resolveClientConfig(unpatterned, input({ apiKey: foreign })).apiKey).toBe(foreign);
  });

  it('names the client and the pinned-keys field in its messages', () => {
    expect(() => resolveClientConfig(PRODUCT, undefined as never)).toThrow(
      /AcmeClient requires a config object/,
    );
    expect(() => resolveClientConfig(PRODUCT, input({ serverPublicKeys: {} }))).toThrow(
      /config.acmePublicKeys must not be empty/,
    );
    expect(() => resolveClientConfig(PRODUCT, input({ serverPublicKeys: { k: 'short' } }))).toThrow(
      /acmePublicKeys\[k\]/,
    );
  });

  it('keeps the shared validation of the six credentials', () => {
    expect(() => resolveClientConfig(PRODUCT, input({ encryptionKey: 'AAAA' }))).toThrow(
      /encryptionKey must decode to 32 bytes/,
    );
    expect(() => resolveClientConfig(PRODUCT, input({ encryptionKeyId: 'enc_lower' }))).toThrow(
      /encryptionKeyId/,
    );
    expect(() => resolveClientConfig(PRODUCT, input({ baseUrl: 'http://api.acme.test' }))).toThrow(
      /https/,
    );
    expect(resolveClientConfig(PRODUCT, input({ baseUrl: 'http://localhost:8787/' })).baseUrl).toBe(
      'http://localhost:8787',
    );
  });
});

describe('HttpClient follows the product', () => {
  it('sends the version pin and fetches the product public-keys path', async () => {
    const host = fakeHost(PRODUCT, ok({ hello: 'world' }), { fx });
    const http = new HttpClient(
      PRODUCT,
      resolveClientConfig(PRODUCT, input({ fetch: host.fetch })),
    );
    const res = await http.request<{ hello: string }>({ method: 'GET', path: '/v1/anything' });
    expect(res).toEqual({ hello: 'world' });
    expect(host.publicKeyFetches).toBe(1);
    expect(host.calls[0]?.headers['x-ensc-api-version']).toBe('2030-01-01');
    expect(host.calls[0]?.headers.authorization).toBe(`Bearer ${fx.apiKey}`);
  });

  it('names the product when a response key is unknown', async () => {
    const host = fakeHost(PRODUCT, () => ({ status: 200, body: {}, kid: 'nope' }), { fx });
    const http = new HttpClient(
      PRODUCT,
      resolveClientConfig(PRODUCT, input({ fetch: host.fetch })),
    );
    await expect(http.request({ method: 'GET', path: '/v1/x' })).rejects.toMatchObject({
      code: 'ENSC_INVALID_SIGNATURE',
      message: /unknown Acme key "nope"/,
    });
    expect(host.publicKeyFetches).toBe(2);
  });

  it('names the pinned-keys field when pinned keys lack the key', async () => {
    const host = fakeHost(PRODUCT, () => ({ status: 200, body: {}, kid: 'nope' }), { fx });
    const http = new HttpClient(
      PRODUCT,
      resolveClientConfig(
        PRODUCT,
        input({ fetch: host.fetch, serverPublicKeys: { [SERVER_KID]: SERVER_PUBLIC_KEY } }),
      ),
    );
    await expect(http.request({ method: 'GET', path: '/v1/x' })).rejects.toMatchObject({
      message: /not in config.acmePublicKeys/,
    });
    expect(host.publicKeyFetches).toBe(0);
  });

  it('encrypts and signs a write, reusing one idempotency key across a retry', async () => {
    let n = 0;
    const host = fakeHost(
      PRODUCT,
      () =>
        n++ === 0
          ? { status: 503, body: { error: { code: 'ENSC_DB_UNAVAILABLE', message: 'x' } } }
          : { status: 200, body: { done: true } },
      { fx },
    );
    const http = new HttpClient(
      PRODUCT,
      resolveClientConfig(PRODUCT, input({ fetch: host.fetch })),
    );
    const res = await http.request({ method: 'POST', path: '/v1/things', body: { amount: '100' } });
    expect(res).toEqual({ done: true });
    expect(host.calls).toHaveLength(2);
    for (const call of host.calls) {
      expect(call.signatureOk).toBe(true);
      expect(call.plaintext).toBe('{"amount":"100"}');
      expect(call.wireBody).not.toContain('100');
    }
    expect(host.calls[0]?.headers['x-ensc-idempotency-key']).toBe(
      host.calls[1]?.headers['x-ensc-idempotency-key'],
    );
    expect(host.calls[0]?.headers['x-ensc-nonce']).not.toBe(host.calls[1]?.headers['x-ensc-nonce']);
  });
});

describe('fetchPublicKeys follows the product and the requested use', () => {
  it('reads the product path and returns the webhook keys by default', async () => {
    const host = fakeHost(PRODUCT, ok({}), { fx });
    const keys = await fetchPublicKeys(PRODUCT, { baseUrl: 'https://x.test', fetch: host.fetch });
    expect(keys).toEqual({ [SERVER_KID]: SERVER_PUBLIC_KEY });
    expect(host.publicKeyFetches).toBe(1);
  });

  it('filters by use and names the product in failures', async () => {
    const host = fakeHost(PRODUCT, ok({}), {
      fx,
      publicKeys: { keys: [{ kid: 'r1', publicKey: SERVER_PUBLIC_KEY, use: ['responses'] }] },
    });
    await expect(
      fetchPublicKeys(PRODUCT, { baseUrl: 'https://x.test', fetch: host.fetch }),
    ).rejects.toMatchObject({ message: /Acme public key document has no webhook key/ });
    await expect(
      fetchPublicKeys(PRODUCT, { baseUrl: 'https://x.test', fetch: host.fetch, use: 'responses' }),
    ).resolves.toEqual({ r1: SERVER_PUBLIC_KEY });
    const down = fakeHost(PRODUCT, ok({}), { fx, publicKeys: { status: 500 } });
    await expect(
      fetchPublicKeys(PRODUCT, { baseUrl: 'https://x.test', fetch: down.fetch }),
    ).rejects.toMatchObject({
      code: 'ENSC_UPSTREAM_FAILED',
      message: /Acme public keys: HTTP 500/,
    });
  });
});
