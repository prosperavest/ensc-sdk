import { describe, expect, it } from 'vitest';
import { testServer } from './_server.js';

/** Capture every request a client makes, always replying 200 `{}` (sealed). */
function recordingClient() {
  const calls: Array<{ method: string; url: string; body: string | undefined }> = [];
  const srv = testServer((call) => {
    calls.push({ method: call.method, url: call.url, body: call.plaintext });
    return { status: 200, body: {} };
  });
  return { client: srv.client, calls };
}

describe('resource routing, reads', () => {
  it('balance.get → GET /v1/balance', async () => {
    const { client, calls } = recordingClient();
    await client.balance.get({ account: '0xabc', chain: 'celo', asset: 'ENSC' });
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toContain('/v1/balance');
  });

  it('banks.list → GET /v1/banks', async () => {
    const { client, calls } = recordingClient();
    await client.banks.list();
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toContain('/v1/banks');
  });

  it('conversions.quote / screening / get / list → GET routes with query', async () => {
    const { client, calls } = recordingClient();
    await client.conversions.quote({
      type: 'crypto-issue',
      chain: 'celo',
      pair: 'USDC',
      amount: '10',
    });
    await client.conversions.screening('op:crypto-issue:abcdef01');
    await client.conversions.get('op:crypto-issue:abcdef01');
    await client.conversions.list({ limit: 5, status: 'succeeded', type: 'fiat-redeem' });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET', 'GET', 'GET']);
    expect(calls[0]?.url).toContain('/v1/conversions/quote?');
    expect(calls[0]?.url).toContain('pair=USDC');
    expect(calls[1]?.url).toContain(
      '/v1/conversions/screening?reference=op%3Acrypto-issue%3Aabcdef01',
    );
    expect(calls[2]?.url).toContain('/v1/conversions/op%3Acrypto-issue%3Aabcdef01');
    expect(calls[3]?.url).toContain('/v1/conversions?');
    expect(calls[3]?.url).toContain('status=succeeded');
    expect(calls[3]?.url).toContain('type=fiat-redeem');
  });

  it('events.list → GET /v1/events, events.get → GET /v1/events/:id', async () => {
    const { client, calls } = recordingClient();
    await client.events.list({ limit: 10, type: 'conversion.succeeded' });
    await client.events.get('evt_42');
    expect(calls[0]?.url).toMatch(/\/v1\/events\?/);
    expect(calls[0]?.url).toContain('limit=10');
    expect(calls[1]?.url).toContain('/v1/events/evt_42');
  });
});

describe('resource routing, conversions and transfers', () => {
  it('conversions.create → POST /v1/conversions with the typed body', async () => {
    const { client, calls } = recordingClient();
    await client.conversions.create({
      type: 'crypto-issue',
      chain: 'celo',
      wallet: '0x1111111111111111111111111111111111111111',
      pair: 'USDC',
      amount: '100',
      metadata: { orderId: 'A-1' },
    });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toContain('/v1/conversions');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      type: 'crypto-issue',
      chain: 'celo',
      wallet: '0x1111111111111111111111111111111111111111',
      pair: 'USDC',
      amount: '100',
      metadata: { orderId: 'A-1' },
    });
  });

  it('conversions.create (fiat-redeem) carries the payout destination and drops idempotencyKey from the body', async () => {
    const { client, calls } = recordingClient();
    await client.conversions.create({
      type: 'fiat-redeem',
      chain: 'celo',
      wallet: '0x1111111111111111111111111111111111111111',
      amount: '2500.50',
      payout: { bankCode: '044', accountNumber: '0690000031', accountName: 'Ada Lovelace' },
      idempotencyKey: 'k-1',
    });
    const body = JSON.parse(calls[0]?.body ?? '{}');
    expect(body.payout).toEqual({
      bankCode: '044',
      accountNumber: '0690000031',
      accountName: 'Ada Lovelace',
    });
    expect(body.idempotencyKey).toBeUndefined();
  });

  it('conversions.events.* → POST /v1/conversions/:reference/events', async () => {
    const { client, calls } = recordingClient();
    const tx = `0x${'a'.repeat(64)}`;
    await client.conversions.events.submitted('op:fiat-redeem:abcdef01', tx);
    await client.conversions.events.confirmed('op:fiat-redeem:abcdef01', tx);
    await client.conversions.events.failed('op:fiat-redeem:abcdef01', 'user rejected');
    expect(calls.every((c) => c.method === 'POST')).toBe(true);
    expect(calls[0]?.url).toContain('/v1/conversions/op%3Afiat-redeem%3Aabcdef01/events');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ event: 'onchain_submitted', txHash: tx });
    expect(JSON.parse(calls[1]?.body ?? '{}')).toEqual({ event: 'onchain_confirmed', txHash: tx });
    expect(JSON.parse(calls[2]?.body ?? '{}')).toEqual({ event: 'failed', error: 'user rejected' });
  });

  it('conversions.voucher / payout → POST with an empty object body', async () => {
    const { client, calls } = recordingClient();
    await client.conversions.voucher('op:fiat-issue:abcdef01');
    await client.conversions.payout('op:fiat-redeem:abcdef01');
    expect(calls[0]?.url).toContain('/v1/conversions/op%3Afiat-issue%3Aabcdef01/voucher');
    expect(calls[1]?.url).toContain('/v1/conversions/op%3Afiat-redeem%3Aabcdef01/payout');
    expect(JSON.parse(calls[0]?.body ?? 'null')).toEqual({});
  });

  it('accounts.resolve → POST /v1/accounts/resolve', async () => {
    const { client, calls } = recordingClient();
    await client.accounts.resolve({ bankCode: '044', accountNumber: '0690000031' });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toContain('/v1/accounts/resolve');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      bankCode: '044',
      accountNumber: '0690000031',
    });
  });

  it('transfer.create → POST /v1/transfer with asset ENSC injected', async () => {
    const { client, calls } = recordingClient();
    await client.transfer.create({
      from: '0x1111111111111111111111111111111111111111',
      recipient: `0x${'2'.repeat(40)}`,
      amount: '5',
      chain: 'celo',
    });
    expect(calls[0]?.url).toContain('/v1/transfer');
    expect(JSON.parse(calls[0]?.body ?? '{}').asset).toBe('ENSC');
  });
});

describe('resource routing, management', () => {
  it('apiKeys.list issues a GET against /v1/api-keys', async () => {
    const { client, calls } = recordingClient();
    await client.apiKeys.list({ limit: 5 });
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toContain('/v1/api-keys?');
    expect(calls[0]?.url).toContain('limit=5');
  });

  it('signingKeys.list issues a GET against /v1/signing-keys', async () => {
    const { client, calls } = recordingClient();
    await client.signingKeys.list({ limit: 25 });
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toContain('/v1/signing-keys');
    expect(calls[0]?.url).toContain('limit=25');
  });

  it('encryptionKeys.list issues a GET against /v1/encryption-keys', async () => {
    const { client, calls } = recordingClient();
    await client.encryptionKeys.list();
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toContain('/v1/encryption-keys');
  });

  it('origins.list + webhookEndpoints route correctly', async () => {
    const { client, calls } = recordingClient();
    await client.origins.list();
    await client.webhookEndpoints.create({
      env: 'test',
      url: 'https://example.com/hook',
      eventTypes: ['conversion.succeeded'],
    });
    await client.webhookEndpoints.sendTest('whe_1');
    expect(calls[0]).toMatchObject({ method: 'GET' });
    expect(calls[0]?.url).toContain('/v1/origins');
    expect(calls[1]).toMatchObject({ method: 'POST' });
    expect(calls[1]?.url).toContain('/v1/webhook-endpoints');
    expect(calls[2]?.url).toContain('/v1/webhook-endpoints/whe_1/test');
  });

  it('exposes no credential-issuance methods (dashboard-only on the API)', () => {
    const { client } = recordingClient();
    const has = (o: object, k: string) =>
      k in o || typeof (o as Record<string, unknown>)[k] === 'function';
    for (const k of ['create', 'rotate', 'revoke', 'updateIpAllowlist']) {
      expect(has(client.apiKeys, k)).toBe(false);
      expect(has(client.encryptionKeys, k)).toBe(false);
    }
    for (const k of ['register', 'generate', 'rotate', 'revoke']) {
      expect(has(client.signingKeys, k)).toBe(false);
    }
    for (const k of ['create', 'remove']) {
      expect(has(client.origins, k)).toBe(false);
    }
  });
});
