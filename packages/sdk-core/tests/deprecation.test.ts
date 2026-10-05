/**
 * Retirement notices.
 *
 * An API version scheduled for retirement answers with `Deprecation`
 * (`@<unix seconds>`) and `Sunset` (an HTTP date). The transport hands them to
 * the integrator's `onDeprecation` callback, once per request, so the pinned
 * version is noticed before it stops being served. The callback informs: it
 * never changes the outcome of the request.
 */

import { describe, expect, it } from 'vitest';
import {
  type ClientConfigInput,
  type DeprecationNotice,
  HttpClient,
  resolveClientConfig,
  type SdkProduct,
} from '../src/index.js';
import {
  fakeHost,
  type Handler,
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
};

const fx = merchantFixture('acme_test_sk_');

const DEPRECATED_AT = 1_800_000_000;
const SUNSET_AT = 1_815_552_000;
const SCHEDULED = {
  'X-ENSC-API-Version': '2030-01-01',
  Deprecation: `@${DEPRECATED_AT}`,
  Sunset: new Date(SUNSET_AT * 1000).toUTCString(),
};

/** A client whose host adds `extra` headers to every answer. */
function client(
  handler: Handler,
  extra: Record<string, string>,
  config: Partial<ClientConfigInput>,
): HttpClient {
  const host = fakeHost(PRODUCT, handler, { fx });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await host.fetch(input as string, init);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(extra)) headers.set(k, v);
    return new Response(res.body, { status: res.status, headers });
  }) as unknown as typeof fetch;
  return new HttpClient(
    PRODUCT,
    resolveClientConfig(PRODUCT, {
      apiKey: fx.apiKey,
      merchantId: fx.merchantId,
      encryptionKey: fx.encryptionKeyB64,
      encryptionKeyId: fx.encryptionKeyId,
      signingPrivateKey: fx.signingPrivateKey,
      signingKeyId: fx.signingKeyId,
      serverPublicKeys: { [SERVER_KID]: SERVER_PUBLIC_KEY },
      fetch: fetchImpl,
      ...config,
    }),
  );
}

const read = { method: 'GET' as const, path: '/v1/things' };

describe('Deprecation and Sunset reach the integrator', () => {
  it('hands both times, the version and the request id to onDeprecation', async () => {
    const seen: DeprecationNotice[] = [];
    const http = client(ok({ id: 't_1' }), SCHEDULED, { onDeprecation: (n) => seen.push(n) });
    await expect(http.request(read)).resolves.toEqual({ id: 't_1' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.apiVersion).toBe('2030-01-01');
    expect(seen[0]?.deprecatedAt?.getTime()).toBe(DEPRECATED_AT * 1000);
    expect(seen[0]?.sunsetAt?.getTime()).toBe(SUNSET_AT * 1000);
    expect(seen[0]?.requestId).toMatch(/^req_/);
  });

  it('is not called when the answer carries neither header', async () => {
    const seen: DeprecationNotice[] = [];
    const http = client(
      ok({ id: 't_1' }),
      { 'X-ENSC-API-Version': '2030-01-01' },
      {
        onDeprecation: (n) => seen.push(n),
      },
    );
    await http.request(read);
    expect(seen).toEqual([]);
  });

  it('one header alone is a notice; a value in another form is left out', async () => {
    const seen: DeprecationNotice[] = [];
    const sunsetOnly = client(
      ok({}),
      { Sunset: SCHEDULED.Sunset, Deprecation: 'true' },
      {
        onDeprecation: (n) => seen.push(n),
      },
    );
    await sunsetOnly.request(read);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.deprecatedAt).toBeUndefined();
    expect(seen[0]?.sunsetAt?.getTime()).toBe(SUNSET_AT * 1000);
    // The answer named no version: the notice names the version the client pins.
    expect(seen[0]?.apiVersion).toBe('2030-01-01');

    const junk = client(
      ok({}),
      { Sunset: 'soon', Deprecation: '@abc' },
      {
        onDeprecation: (n) => seen.push(n),
      },
    );
    await junk.request(read);
    expect(seen).toHaveLength(1);
  });

  it('is called for an error answer too, and once per request whatever the retries', async () => {
    const seen: DeprecationNotice[] = [];
    const refused = client(
      () => ({ status: 400, body: { error: { code: 'ENSC_VALIDATION_FAILED', message: 'no' } } }),
      SCHEDULED,
      { onDeprecation: (n) => seen.push(n) },
    );
    await expect(refused.request(read)).rejects.toMatchObject({ code: 'ENSC_VALIDATION_FAILED' });
    expect(seen).toHaveLength(1);

    let attempts = 0;
    const flaky = client(
      () => (++attempts < 3 ? { status: 503, body: {} } : { status: 200, body: { id: 't_1' } }),
      SCHEDULED,
      { onDeprecation: (n) => seen.push(n), maxRetries: 2 },
    );
    await expect(flaky.request(read)).resolves.toEqual({ id: 't_1' });
    expect(attempts).toBe(3);
    expect(seen).toHaveLength(2);
  });

  it('a callback that throws, or rejects, never fails the request', async () => {
    const throwing = client(ok({ id: 't_1' }), SCHEDULED, {
      onDeprecation: () => {
        throw new Error('logger down');
      },
    });
    await expect(throwing.request(read)).resolves.toEqual({ id: 't_1' });
    const rejecting = client(ok({ id: 't_1' }), SCHEDULED, {
      onDeprecation: (async () => {
        throw new Error('logger down');
      }) as unknown as (n: DeprecationNotice) => void,
    });
    await expect(rejecting.request(read)).resolves.toEqual({ id: 't_1' });
  });

  it('refuses a callback that is not a function at construction', () => {
    expect(() =>
      client(ok({}), {}, { onDeprecation: 'log' as unknown as (n: DeprecationNotice) => void }),
    ).toThrow(/config\.onDeprecation must be a function/);
  });
});
