import { signRequest } from '@ensc/protocol';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { constructEvent, EnscClient, verifyWebhookSignature } from '../src/index.js';

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

// Sanity check that the SDK's request signing import surface is intact.
describe('signing import surface', () => {
  it('signRequest is reachable for advanced callers', () => {
    expect(typeof signRequest).toBe('function');
  });
});
