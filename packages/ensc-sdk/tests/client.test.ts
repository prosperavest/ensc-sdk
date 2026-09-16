import { describe, expect, it } from 'vitest';
import { EnscClient, EnscError } from '../src/index.js';
import { configFor, merchantFixture, ok, testServer } from './_server.js';

describe('EnscClient construction', () => {
  it('throws when a credential is missing', () => {
    const fx = merchantFixture();
    const { apiKey: _a, ...noApiKey } = configFor(fx);
    expect(() => new EnscClient(noApiKey as never)).toThrow(EnscError);
    const { encryptionKey: _e, ...noEnc } = configFor(fx);
    expect(() => new EnscClient(noEnc as never)).toThrow(/encryptionKey/);
    const { signingPrivateKey: _s, ...noSig } = configFor(fx);
    expect(() => new EnscClient(noSig as never)).toThrow(/signingPrivateKey/);
  });

  it('constructs with the six credentials and exposes every resource', () => {
    const client = new EnscClient(configFor(merchantFixture()));
    expect(client).toBeInstanceOf(EnscClient);
    for (const r of [
      'apiKeys',
      'signingKeys',
      'encryptionKeys',
      'origins',
      'webhookEndpoints',
      'events',
      'balance',
      'banks',
      'conversions',
      'accounts',
      'transfer',
    ]) {
      expect((client as unknown as Record<string, unknown>)[r]).toBeDefined();
    }
  });

  it('does not expose secrets as enumerable properties', () => {
    const fx = merchantFixture();
    const client = new EnscClient(configFor(fx));
    const dump = JSON.stringify(client);
    expect(dump).not.toContain(fx.apiKey);
    expect(dump).not.toContain(fx.encryptionKeyB64);
    expect(dump).not.toContain(fx.signingPrivateKey);
  });
});

describe('HttpClient transport', () => {
  it('sends Bearer auth, pinned API version and key id on a read', async () => {
    const srv = testServer(ok({ account: '0xabc', balance: '0', formatted: '0', decimals: 18 }));
    const res = await srv.client.balance.get({ account: '0xabc', chain: 'celo', asset: 'ENSC' });

    expect(res).toMatchObject({ account: '0xabc' });
    expect(srv.calls).toHaveLength(1);
    const headers = srv.calls[0]?.headers ?? {};
    expect(headers.authorization).toBe(`Bearer ${srv.fx.apiKey}`);
    expect(headers['x-ensc-api-version']).toBe('2026-09-15');
    expect(headers['x-ensc-key-id']).toBe(srv.fx.signingKeyId);
    expect(headers['x-ensc-signature']).toBeUndefined();
  });

  it('puts query params on the URL', async () => {
    const srv = testServer(ok({}));
    await srv.client.balance.get({ account: '0xABC', chain: 'base', asset: 'USDC' });
    const url = srv.calls[0]?.url ?? '';
    expect(url).toContain('/v1/balance');
    expect(url).toContain('account=0xABC');
    expect(url).toContain('chain=base');
    expect(url).toContain('asset=USDC');
  });

  it('encrypts write bodies: the wire body is an envelope, the server sees the plaintext', async () => {
    const srv = testServer(ok({ unsignedTransaction: {} }));
    await srv.client.transfer.create({
      from: `0x${'3'.repeat(40)}`,
      recipient: `0x${'1'.repeat(40)}`,
      amount: '100',
      chain: 'base',
    });
    const call = srv.calls[0];
    const wire = JSON.parse(call?.wireBody ?? '{}');
    expect(Object.keys(wire).sort()).toEqual(['ciphertext', 'encKeyId', 'iv', 'tag', 'v']);
    expect(wire.v).toBe(1);
    expect(wire.encKeyId).toBe(srv.fx.encryptionKeyId);
    expect(call?.wireBody).not.toContain('100');
    expect(JSON.parse(call?.plaintext ?? '{}')).toEqual({
      from: `0x${'3'.repeat(40)}`,
      recipient: `0x${'1'.repeat(40)}`,
      amount: '100',
      chain: 'base',
      asset: 'ENSC',
    });
    expect(call?.headers['content-type']).toBe('application/json');
  });

  it('sends an encrypted empty object for bodiless writes', async () => {
    const srv = testServer(ok({ id: 'whe_1', queued: true }));
    await srv.client.webhookEndpoints.sendTest('whe_1');
    const call = srv.calls[0];
    expect(call?.path).toBe('/v1/webhook-endpoints/whe_1/test');
    expect(call?.wireBody).toBeDefined();
    expect(call?.plaintext).toBe('{}');
    expect(call?.signatureOk).toBe(true);
  });

  it('maps an ENSC error body to a typed EnscError', async () => {
    const srv = testServer(() => ({
      status: 400,
      body: { error: { code: 'ENSC_INVALID_CHAIN', message: 'bad chain' } },
    }));
    await expect(
      srv.client.balance.get({ account: '0xabc', chain: 'nope', asset: 'ENSC' }),
    ).rejects.toMatchObject({ code: 'ENSC_INVALID_CHAIN', status: 400 });
  });

  it('does NOT retry a 4xx', async () => {
    const srv = testServer(
      () => ({ status: 404, body: { error: { code: 'ENSC_NOT_FOUND', message: 'gone' } } }),
      { config: { maxRetries: 2 } },
    );
    await expect(srv.client.events.get('evt_x')).rejects.toMatchObject({ code: 'ENSC_NOT_FOUND' });
    expect(srv.calls).toHaveLength(1);
  });

  it('retries a 5xx up to maxRetries then throws', async () => {
    const srv = testServer(
      () => ({ status: 503, body: { error: { code: 'ENSC_DB_UNAVAILABLE', message: 'down' } } }),
      { config: { maxRetries: 2 } },
    );
    await expect(srv.client.events.get('evt_x')).rejects.toMatchObject({
      code: 'ENSC_DB_UNAVAILABLE',
    });
    expect(srv.calls).toHaveLength(3);
  });

  it('recovers when a retry succeeds', async () => {
    let n = 0;
    const srv = testServer(
      () =>
        n++ === 0
          ? { status: 502, body: { error: { code: 'ENSC_UPSTREAM_FAILED', message: 'blip' } } }
          : { status: 200, body: { id: 'evt_1', eventType: 'x' } },
      { config: { maxRetries: 2 } },
    );
    const res = await srv.client.events.get('evt_1');
    expect(res).toMatchObject({ id: 'evt_1' });
    expect(srv.calls).toHaveLength(2);
  });

  it('returns undefined for a 204', async () => {
    const srv = testServer(() => ({ status: 204 }));
    const res = await srv.client.webhookEndpoints.remove('whe_x');
    expect(res).toBeUndefined();
  });

  it('maps a non-ENSC gateway error by status', async () => {
    const srv = testServer(() => ({ status: 429, body: 'slow down', unsealed: true }), {
      config: { maxRetries: 0 },
    });
    await expect(srv.client.events.get('evt_x')).rejects.toMatchObject({
      code: 'ENSC_RATE_LIMITED',
    });
  });
});
