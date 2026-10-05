import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import {
  constructEvent,
  createEnscWebhookKeyCache,
  EnscClient,
  verifyWebhookSignature,
} from '../src/index.js';

const keypair = EnscClient.generateKeypair();

/** Produce a correctly-signed webhook delivery (headers + raw body). */
function makeDelivery(payload: unknown, opts: { timestamp?: number } = {}) {
  const webhookId = 'whk_01TESTWEBHOOK';
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    id: 'evt_01TEST',
    type: 'payment_intent.succeeded',
    apiVersion: '2026-05-01',
    created: timestamp,
    data: payload,
  });
  const bodyHash = bytesToHex(sha256(new TextEncoder().encode(body)));
  const canonical = `ENSC-WH-V1\n${webhookId}\n${timestamp}\n${bodyHash}`;
  const sig = ed25519.sign(new TextEncoder().encode(canonical), fromB64Url(keypair.privateKey));
  const headers: Record<string, string> = {
    'X-ENSC-Signature': `ed25519=${toB64Url(sig)}`,
    'X-ENSC-Timestamp': String(timestamp),
    'X-ENSC-Webhook-Id': webhookId,
    'X-ENSC-Event-Type': 'payment_intent.succeeded',
    'X-ENSC-Event-Id': 'evt_01TEST',
    'X-ENSC-API-Version': '2026-05-01',
    'X-ENSC-Key-Id': 'whk_key_1',
  };
  return { headers, body };
}

// Minimal base64url helpers for the test (mirror @ensc/protocol's encoding).
function toB64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64Url(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

describe('verifyWebhookSignature', () => {
  it('accepts a correctly-signed delivery', () => {
    const { headers, body } = makeDelivery({ amount: '100' });
    const result = verifyWebhookSignature({ body, headers, publicKey: keypair.publicKey });
    expect(result.valid).toBe(true);
  });

  it('rejects a tampered body', () => {
    const { headers, body } = makeDelivery({ amount: '100' });
    const tampered = body.replace('100', '999999');
    const result = verifyWebhookSignature({
      body: tampered,
      headers,
      publicKey: keypair.publicKey,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('signature_mismatch');
  });

  it('rejects a delivery signed by a different key', () => {
    const { headers, body } = makeDelivery({ amount: '100' });
    const otherKey = EnscClient.generateKeypair().publicKey;
    const result = verifyWebhookSignature({ body, headers, publicKey: otherKey });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('signature_mismatch');
  });

  it('reports missing headers', () => {
    const { body } = makeDelivery({ amount: '1' });
    const result = verifyWebhookSignature({ body, headers: {}, publicKey: keypair.publicKey });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('missing_signature');
  });

  it('rejects a stale timestamp outside tolerance', () => {
    const old = Math.floor(Date.now() / 1000) - 10_000;
    const { headers, body } = makeDelivery({ amount: '1' }, { timestamp: old });
    const result = verifyWebhookSignature({ body, headers, publicKey: keypair.publicKey });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('timestamp_out_of_tolerance');
  });

  it('accepts a stale timestamp when tolerance is disabled', () => {
    const old = Math.floor(Date.now() / 1000) - 10_000;
    const { headers, body } = makeDelivery({ amount: '1' }, { timestamp: old });
    const result = verifyWebhookSignature({
      body,
      headers,
      publicKey: keypair.publicKey,
      toleranceSeconds: 0,
    });
    expect(result.valid).toBe(true);
  });

  it('works with a Headers instance', () => {
    const { headers, body } = makeDelivery({ amount: '7' });
    const result = verifyWebhookSignature({
      body,
      headers: new Headers(headers),
      publicKey: keypair.publicKey,
    });
    expect(result.valid).toBe(true);
  });
});

describe('constructEvent', () => {
  it('returns the parsed event for a valid delivery', () => {
    const { headers, body } = makeDelivery({ amount: '42' });
    const event = constructEvent<{ amount: string }>({
      body,
      headers,
      publicKey: keypair.publicKey,
    });
    expect(event.type).toBe('payment_intent.succeeded');
    expect(event.data.amount).toBe('42');
  });

  it('throws EnscError on a bad signature', () => {
    const { headers, body } = makeDelivery({ amount: '1' });
    expect(() =>
      constructEvent({ body: `${body} `, headers, publicKey: keypair.publicKey }),
    ).toThrow(/signature verification failed/);
  });
});

describe('key ids, bytes and Node-style headers', () => {
  it('picks the key named by X-ENSC-Key-Id from a key map and refuses an unknown id', () => {
    const { headers, body } = makeDelivery({ amount: '1' });
    const keys = { whk_key_1: keypair.publicKey, other: keypair.publicKey };
    expect(verifyWebhookSignature({ body, headers, publicKey: keys }).valid).toBe(true);
    const rotated = { ...headers, 'X-ENSC-Key-Id': 'whk_key_9' };
    expect(verifyWebhookSignature({ body, headers: rotated, publicKey: keys })).toEqual({
      valid: false,
      reason: 'unknown_key_id',
    });
  });

  it('hashes a byte body as received and accepts lower-case Node headers', () => {
    const { headers, body } = makeDelivery({ amount: '1' });
    const nodeHeaders: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(headers)) nodeHeaders[k.toLowerCase()] = v;
    const bytes = new TextEncoder().encode(body);
    expect(
      verifyWebhookSignature({ body: bytes, headers: nodeHeaders, publicKey: keypair.publicKey })
        .valid,
    ).toBe(true);
    // A repeated signature header is refused rather than thrown on.
    nodeHeaders['x-ensc-signature'] = [headers['X-ENSC-Signature'] ?? '', 'ed25519=zz'];
    expect(
      verifyWebhookSignature({ body: bytes, headers: nodeHeaders, publicKey: keypair.publicKey }),
    ).toEqual({
      valid: false,
      reason: 'missing_signature',
    });
  });

  it('signs the timestamp as the exact header string', () => {
    const { headers, body } = makeDelivery({ amount: '1' });
    const padded = { ...headers, 'X-ENSC-Timestamp': `${headers['X-ENSC-Timestamp']}abc` };
    expect(verifyWebhookSignature({ body, headers: padded, publicKey: keypair.publicKey })).toEqual(
      {
        valid: false,
        reason: 'missing_timestamp',
      },
    );
  });

  it('constructEvent refuses a verified body that is not an event envelope', () => {
    const webhookId = 'whk_01TESTWEBHOOK';
    const timestamp = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ hello: 'world' });
    const bodyHash = bytesToHex(sha256(new TextEncoder().encode(body)));
    const canonical = `ENSC-WH-V1\n${webhookId}\n${timestamp}\n${bodyHash}`;
    const sig = ed25519.sign(new TextEncoder().encode(canonical), fromB64Url(keypair.privateKey));
    const headers = {
      'X-ENSC-Signature': `ed25519=${toB64Url(sig)}`,
      'X-ENSC-Timestamp': String(timestamp),
      'X-ENSC-Webhook-Id': webhookId,
    };
    expect(() => constructEvent({ body, headers, publicKey: keypair.publicKey })).toThrow(
      /not an ENSC event envelope/,
    );
  });

  it('fetchEnscPublicKeys returns the webhook keys by id', async () => {
    const doc = {
      keys: [
        { kid: 'k1', alg: 'Ed25519', publicKey: keypair.publicKey, use: ['webhooks', 'responses'] },
        { kid: 'k2', alg: 'Ed25519', publicKey: keypair.publicKey, use: ['responses'] },
      ],
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(doc), { status: 200 })) as unknown as typeof fetch;
    const keys = await EnscClient.fetchPublicKeys({ fetch: fetchImpl });
    expect(keys).toEqual({ k1: keypair.publicKey });
  });

  it('EnscClient.constructEvent passes merchantId and env through: a delivery signed for another merchant or environment is refused', async () => {
    const MINE = 'mrc_01MINE00000000000000000000';
    const OTHER = 'mrc_01OTHER0000000000000000000';
    const KID = 'ensc_test_kid_1';
    /** A delivery as ENSC signs it today: the body names the merchant and the environment. */
    const deliver = (envelope: Record<string, unknown>) => {
      const webhookId = 'whk_01TESTWEBHOOK';
      const timestamp = Math.floor(Date.now() / 1000);
      const body = JSON.stringify({
        id: 'ev_01TEST',
        type: 'conversion.succeeded',
        apiVersion: '2026-09-15',
        product: 'ensc',
        ...envelope,
        created: timestamp,
        data: { reference: 'op:crypto-issue:0a1b2c3d', status: 'succeeded' },
      });
      const bodyHash = bytesToHex(sha256(new TextEncoder().encode(body)));
      const canonical = `ENSC-WH-V1\n${webhookId}\n${timestamp}\n${bodyHash}`;
      const sig = ed25519.sign(new TextEncoder().encode(canonical), fromB64Url(keypair.privateKey));
      return {
        body,
        headers: {
          'X-ENSC-Signature': `ed25519=${toB64Url(sig)}`,
          'X-ENSC-Timestamp': String(timestamp),
          'X-ENSC-Webhook-Id': webhookId,
          'X-ENSC-Key-Id': KID,
        },
      };
    };

    // The keys come from the SDK's own cache, bound to the ENSC key document.
    let asked = 0;
    const fetchImpl = (async (url: string) => {
      asked++;
      expect(url).toBe('https://api.ensc.prosperavest.com/v1/.well-known/ensc-public-keys.json');
      return new Response(
        JSON.stringify({
          keys: [{ kid: KID, alg: 'Ed25519', publicKey: keypair.publicKey, use: ['webhooks'] }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const cache = EnscClient.webhookKeyCache({ fetch: fetchImpl });

    const mine = deliver({ merchantId: MINE, env: 'live' });
    const event = EnscClient.constructEvent({
      ...mine,
      publicKey: await cache.get(mine.headers),
      merchantId: MINE,
      env: 'live',
    });
    expect(event).toMatchObject({ id: 'ev_01TEST', merchantId: MINE, env: 'live' });
    expect(event.synthetic).toBeUndefined();

    // Genuine signatures, but not this receiver's events.
    const publicKey = await cache.get(mine.headers);
    const refused = (envelope: Record<string, unknown>, reason: string) => {
      const d = deliver(envelope);
      expect(
        EnscClient.verifyWebhookSignature({ ...d, publicKey, merchantId: MINE, env: 'live' }),
      ).toEqual({ valid: false, reason });
      expect(() =>
        EnscClient.constructEvent({ ...d, publicKey, merchantId: MINE, env: 'live' }),
      ).toThrow(new RegExp(reason));
      // Without the two options the same delivery verifies: they are what refuses it.
      expect(EnscClient.verifyWebhookSignature({ ...d, publicKey }).valid).toBe(true);
    };
    refused({ merchantId: OTHER, env: 'live' }, 'merchant_mismatch');
    refused({ merchantId: MINE, env: 'test', synthetic: true }, 'env_mismatch');
    refused({}, 'merchant_mismatch');

    // A test delivery in its own environment verifies and says what it is.
    const test = deliver({ merchantId: MINE, env: 'test', synthetic: true });
    expect(
      EnscClient.constructEvent({ ...test, publicKey, merchantId: MINE, env: 'test' }).synthetic,
    ).toBe(true);

    // One load of the key document for all of the above.
    expect(asked).toBe(1);
    expect(createEnscWebhookKeyCache).toBeTypeOf('function');
  });
});
