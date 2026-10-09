/**
 * A sealed response is accepted only as the answer to the request that was
 * sent (ENSC-RESP-V2).
 *
 * The transport sends a fresh response nonce with every attempt of every
 * request, reads included, and signs it on a write (ENSC-V2). It then accepts
 * a 2xx only if the host signed and sealed it for that nonce, for the method,
 * path and query that were sent, and for this client's own merchant id and
 * signing key id. A response the host made for another request or for another
 * merchant, a response replayed from an earlier one, and a response in the
 * version that names no request (ENSC-RESP-V1) are all refused, and none of
 * them is a reason to send a write again.
 */

import type { ResponseBinding } from '@ensc/protocol';
import { describe, expect, it } from 'vitest';
import {
  type ClientConfigInput,
  generateResponseNonce,
  HttpClient,
  resolveClientConfig,
  type SdkProduct,
} from '../src/index.js';
import {
  type FakeHost,
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
const NONCE = 'x-ensc-response-nonce';
const NONCE_FORM = /^[A-Za-z0-9_-]{43}$/;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * A client on a fake host. `between` stands between the two: it is handed
 * each request to the API (never the key document) and the host's own fetch,
 * and returns the response the client receives.
 */
function harness(
  handler: Handler,
  opts: {
    between?: (input: string, init: RequestInit | undefined, host: Fetch) => Promise<Response>;
    config?: Partial<ClientConfigInput>;
  } = {},
): { http: HttpClient; host: FakeHost } {
  const host = fakeHost(PRODUCT, handler, { fx });
  const hostFetch = host.fetch as unknown as Fetch;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!opts.between || new URL(url).pathname === PRODUCT.publicKeysPath) {
      return hostFetch(url, init);
    }
    return opts.between(url, init, hostFetch);
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
      serverPublicKeys: { [SERVER_KID]: SERVER_PUBLIC_KEY },
      fetch: fetchImpl,
      ...opts.config,
    }),
  );
  return { http, host };
}

const read = { method: 'GET' as const, path: '/v1/things', query: { limit: 2 } };
const write = { method: 'POST' as const, path: '/v1/payouts', body: { amount: '100' } };

/** A copy of a response that can be handed over more than once. */
async function keep(res: Response): Promise<() => Response> {
  const body = await res.text();
  const headers = [...res.headers.entries()];
  return () => new Response(body, { status: res.status, headers });
}

describe('every request asks for an answer bound to it', () => {
  it('a read carries a response nonce of 32 random bytes, a new one each time', async () => {
    const h = harness(ok({ ok: true }));
    await h.http.request(read);
    await h.http.request(read);
    const [a, b] = h.host.calls.map((c) => c.headers[NONCE]);
    expect(a).toMatch(NONCE_FORM);
    expect(b).toMatch(NONCE_FORM);
    expect(a).not.toBe(b);
    // A read is still not signed: the nonce is all it adds.
    expect(h.host.calls[0]?.headers['x-ensc-signature']).toBeUndefined();
  });

  it('a write carries one too, covered by its signature (ENSC-V2)', async () => {
    const h = harness(ok({ id: 'p_1' }));
    await expect(h.http.request(write)).resolves.toEqual({ id: 'p_1' });
    const call = h.host.calls[0];
    expect(call?.headers[NONCE]).toMatch(NONCE_FORM);
    // The host verified the signature with the nonce as a signed line.
    expect(call?.signatureOk).toBe(true);
  });

  it('each attempt of a retried write has its own nonce; the idempotency key stays', async () => {
    let n = 0;
    const h = harness(
      () =>
        n++ === 0
          ? { status: 503, body: { error: { code: 'ENSC_INTERNAL', message: 'down' } } }
          : { status: 200, body: { id: 'p_1' } },
      { config: { maxRetries: 1 } },
    );
    await expect(h.http.request(write)).resolves.toEqual({ id: 'p_1' });
    const [a, b] = h.host.calls;
    expect(a?.headers[NONCE]).toMatch(NONCE_FORM);
    expect(b?.headers[NONCE]).toMatch(NONCE_FORM);
    expect(a?.headers[NONCE]).not.toBe(b?.headers[NONCE]);
    expect(a?.headers['x-ensc-idempotency-key']).toBe(b?.headers['x-ensc-idempotency-key']);
    expect(a?.signatureOk && b?.signatureOk).toBe(true);
  });

  it('generateResponseNonce never repeats', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateResponseNonce()));
    expect(seen.size).toBe(500);
    for (const value of seen) expect(value).toMatch(NONCE_FORM);
  });
});

describe('the answer to the request that was sent is accepted', () => {
  it('a read and a write open, and what came over the wire was ENSC-RESP-V2', async () => {
    const bodies: string[] = [];
    const h = harness(ok({ id: 'x_1' }), {
      between: async (input, init, host) => {
        const res = await host(input, init);
        bodies.push(await res.clone().text());
        return res;
      },
    });
    await expect(h.http.request(read)).resolves.toEqual({ id: 'x_1' });
    await expect(h.http.request(write)).resolves.toEqual({ id: 'x_1' });
    expect(bodies.map((b) => (JSON.parse(b) as { v: number }).v)).toEqual([2, 2]);
  });
});

describe('an answer in the version that names no request is refused (no downgrade)', () => {
  it('a read answered in ENSC-RESP-V1: refused, and the error says why', async () => {
    const h = harness(() => ({ status: 200, body: { ok: true }, v1: true }));
    await expect(h.http.request(read)).rejects.toMatchObject({
      code: 'ENSC_INVALID_SIGNATURE',
      message: /ENSC-RESP-V1.*not bound to the request.*ENSC-RESP-V2/,
      details: { reason: 'response_not_bound', responseStatus: 200 },
      requestId: expect.stringMatching(/^req_/),
    });
  });

  it('a write answered in ENSC-RESP-V1: refused, not sent again, and it names its idempotency key', async () => {
    const h = harness(() => ({ status: 201, body: { id: 'p_1' }, v1: true }), {
      config: { maxRetries: 2 },
    });
    const err = await h.http.request(write).then(
      () => undefined,
      (e: unknown) => e as { code: string; details?: Record<string, unknown> },
    );
    expect(err).toMatchObject({
      code: 'ENSC_INVALID_SIGNATURE',
      details: { reason: 'response_not_bound', responseStatus: 201 },
    });
    expect(err?.details?.idempotencyKey).toBe(h.host.calls[0]?.headers['x-ensc-idempotency-key']);
    expect(h.host.calls).toHaveLength(1);
  });

  it('the header taken off a read on the way: the V1 answer the host then gives is refused', async () => {
    const h = harness(ok({ ok: true }), {
      between: (input, init, host) => {
        const headers = new Headers(init?.headers);
        headers.delete(NONCE);
        return host(input, { ...init, headers });
      },
    });
    await expect(h.http.request(read)).rejects.toMatchObject({
      code: 'ENSC_INVALID_SIGNATURE',
      details: { reason: 'response_not_bound' },
    });
    // The host did see a request without the header.
    expect(h.host.calls[0]?.headers[NONCE]).toBeUndefined();
  });

  it('a plaintext 2xx is refused as before', async () => {
    const h = harness(() => ({ status: 200, body: { ok: true }, unsealed: true }));
    await expect(h.http.request(read)).rejects.toMatchObject({
      code: 'ENSC_INVALID_SIGNATURE',
      message: /missing X-ENSC/,
    });
  });
});

describe('an answer the host made for another request is refused', () => {
  const other = generateResponseNonce();
  const cases: Array<[string, Partial<ResponseBinding>]> = [
    ['another nonce', { responseNonce: other }],
    ['another method', { method: 'POST' }],
    ['another path', { path: '/v1/other-things' }],
    ['another query', { query: { limit: '3' } }],
    ['no query', { query: undefined }],
    ['a repeated key the request did not have', { query: 'limit=2&limit=3' }],
    ['another merchant', { merchantId: 'mrc_01SOMEONEELSE0000000000000' }],
    ['another signing key id', { recipientKeyId: 'sig_01SOMEONEELSE' }],
  ];

  it.each(cases)('bound to %s: the signature does not verify', async (_name, boundTo) => {
    const h = harness(() => ({ status: 200, body: { ok: true }, boundTo }));
    await expect(h.http.request(read)).rejects.toMatchObject({
      code: 'ENSC_INVALID_SIGNATURE',
      message: 'Response signature did not verify',
    });
  });

  it('the answer to an earlier request, played back for a later one, is refused', async () => {
    let first: (() => Response) | undefined;
    const h = harness(ok({ balance: '100' }), {
      between: async (input, init, host) => {
        if (first) return first();
        first = await keep(await host(input, init));
        return first();
      },
    });
    // The first request gets its own answer.
    await expect(h.http.request(read)).resolves.toEqual({ balance: '100' });
    // The same request again gets that answer back: genuine, fresh, and not its own.
    await expect(h.http.request(read)).rejects.toMatchObject({
      code: 'ENSC_INVALID_SIGNATURE',
      message: 'Response signature did not verify',
    });
    expect(h.host.calls).toHaveLength(1);
  });

  it('the answer to a read cannot stand in for the answer to a write, even with its nonce', async () => {
    // Someone who sees the write repeats its nonce on a read of their own and
    // hands the client the answer to that read.
    const h = harness(ok({ id: 'p_1' }), {
      between: (input, init, host) => {
        const headers = new Headers({ [NONCE]: new Headers(init?.headers).get(NONCE) ?? '' });
        return host(input, { method: 'GET', headers });
      },
    });
    await expect(h.http.request(write)).rejects.toMatchObject({
      code: 'ENSC_INVALID_SIGNATURE',
      message: 'Response signature did not verify',
      details: { responseStatus: 200 },
    });
    // The host answered a read, bound to the very nonce the write carried.
    expect(h.host.calls[0]?.method).toBe('GET');
  });

  it('an answer to another attempt of the same write is refused, and the write is not repeated', async () => {
    let kept: (() => Response) | undefined;
    const h = harness(ok({ id: 'p_1' }), {
      between: async (input, init, host) => {
        const res = await host(input, init);
        if (!kept) {
          // The first attempt is carried out and its answer is lost on the way.
          kept = await keep(res);
          throw new TypeError('connection reset');
        }
        // The second attempt is carried out too; the lost answer arrives instead of its own.
        return kept();
      },
      config: { maxRetries: 1 },
    });
    await expect(h.http.request(write)).rejects.toMatchObject({
      code: 'ENSC_INVALID_SIGNATURE',
      message: 'Response signature did not verify',
      details: { responseStatus: 200, idempotencyKey: expect.stringMatching(/^idm_/) },
    });
    // Two attempts under one idempotency key, and no third.
    expect(h.host.calls).toHaveLength(2);
    expect(h.host.calls[0]?.headers['x-ensc-idempotency-key']).toBe(
      h.host.calls[1]?.headers['x-ensc-idempotency-key'],
    );
  });
});

describe('an answer the host made for another merchant is refused', () => {
  it('the same read, nonce and all, answered to another merchant that holds the same key', async () => {
    // Another merchant stands between this client and the host, repeats the
    // read under its own API key and hands back the answer to that. The
    // answer is genuine, fresh, for the same method, path, query and nonce,
    // and sealed to a key this client can open: only the merchant id and the
    // key id in what was signed and sealed say it is not ours.
    const h = harness(() => ({
      status: 200,
      body: { balance: 'theirs' },
      boundTo: { merchantId: 'mrc_01SOMEONEELSE0000000000000', recipientKeyId: 'sig_01THEIRKEY' },
    }));
    await expect(h.http.request(read)).rejects.toMatchObject({
      code: 'ENSC_INVALID_SIGNATURE',
      message: 'Response signature did not verify',
      details: { responseStatus: 200 },
    });
  });

  it('the merchant id and key id come from the configuration, not from the response', async () => {
    // A client configured as another merchant does not accept what the host
    // answers to this one.
    const h = harness(ok({ ok: true }), {
      config: { merchantId: 'mrc_01NOTTHISMERCHANT00000000' },
    });
    await expect(h.http.request(read)).rejects.toMatchObject({
      code: 'ENSC_INVALID_SIGNATURE',
      message: 'Response signature did not verify',
    });
  });

  it('a merchant id or key id that is not one line of text is an error of the configuration', async () => {
    const h = harness(ok({ ok: true }), { config: { signingKeyId: 'sig_a\nsig_b' } });
    await expect(h.http.request(read)).rejects.toMatchObject({
      code: 'ENSC_VALIDATION_FAILED',
      message: /config\.merchantId and config\.signingKeyId/,
    });
  });
});

describe('a host that does not serve ENSC-RESP-V2', () => {
  // Such a host does not know the header: it answers every read in
  // ENSC-RESP-V1 and verifies every write as ENSC-V1.
  const older = (handler: Handler) =>
    harness(handler, {
      between: (input, init, host) => {
        const headers = new Headers(init?.headers);
        headers.delete(NONCE);
        return host(input, { ...init, headers });
      },
    });

  it('a read fails closed: its answer is refused, never accepted unbound', async () => {
    const h = older(ok({ ok: true }));
    await expect(h.http.request(read)).rejects.toMatchObject({
      code: 'ENSC_INVALID_SIGNATURE',
      message: /the host does not serve it/,
      details: { reason: 'response_not_bound' },
    });
  });

  it('a write is refused by that host before anything is carried out', async () => {
    let carriedOut = 0;
    // The ENSC-V2 signature does not verify as ENSC-V1, and such a host
    // answers a signature that does not verify with 401.
    const h = older((call) => {
      if (!call.signatureOk) {
        return {
          status: 401,
          body: {
            error: { code: 'ENSC_INVALID_SIGNATURE', message: 'Signature verification failed' },
          },
        };
      }
      carriedOut++;
      return { status: 200, body: { id: 'p_1' } };
    });
    await expect(h.http.request(write)).rejects.toMatchObject({
      code: 'ENSC_INVALID_SIGNATURE',
      status: 401,
      message: 'Signature verification failed',
    });
    expect(carriedOut).toBe(0);
    expect(h.host.calls).toHaveLength(1);
  });
});

describe('an answer that was never sealed is treated as before', () => {
  it("an error answer is the host's own error, read without a signature", async () => {
    const h = harness(() => ({
      status: 409,
      body: { error: { code: 'ENSC_INVALID_STATE', message: 'no', details: { why: 'x' } } },
    }));
    const err = await h.http.request(read).then(
      () => undefined,
      (e: unknown) => e as { code: string; status?: number; details?: Record<string, unknown> },
    );
    expect(err).toMatchObject({ code: 'ENSC_INVALID_STATE', status: 409 });
    expect(err?.details).toEqual({ why: 'x' });
  });

  it('an empty 2xx is refused as before', async () => {
    const h = harness(() => ({ status: 204 }));
    await expect(h.http.request(read)).rejects.toMatchObject({
      code: 'ENSC_INVALID_SIGNATURE',
      details: { reason: 'empty_body' },
    });
  });
});
