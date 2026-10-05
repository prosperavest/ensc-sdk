/**
 * Webhook verification.
 *
 *   - The signed body names the merchant and the environment an event belongs
 *     to and marks a test delivery. A receiver that passes its own merchant id
 *     and environment refuses a delivery signed for anyone else, which is what
 *     stops a genuine Sandbox delivery of one merchant from being replayed to
 *     another merchant's Live receiver.
 *   - `toleranceSeconds` that is not a number of zero or more is refused, not
 *     read as "no replay window".
 *   - The public key loader refuses a plain http host, drops a key that is not
 *     32 bytes and never follows a redirect.
 */

import { bytesToBase64Url, sha256Hex, utf8ToBytes } from '@ensc/protocol';
import { ed25519 } from '@noble/curves/ed25519.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import {
  constructEvent,
  fetchPublicKeys,
  type SdkProduct,
  type VerifyWebhookOptions,
  verifyWebhookSignature,
} from '../src/index.js';

const SEED = randomBytes(32);
const KID = 'wh_test_kid_1';
const PUBLIC_KEY = bytesToBase64Url(ed25519.getPublicKey(SEED));

const PRODUCT: SdkProduct = {
  name: 'Acme',
  clientName: 'AcmeClient',
  defaultBaseUrl: 'https://api.acme.test',
  defaultApiVersion: '2030-01-01',
  publicKeysPath: '/v1/.well-known/acme-public-keys.json',
  publicKeysConfigField: 'acmePublicKeys',
};

/** A delivery as the platform sends it: the body and its signed headers. */
function delivery(
  envelope: Record<string, unknown>,
  timestamp: number = Math.floor(Date.now() / 1000),
): Pick<VerifyWebhookOptions, 'body' | 'headers' | 'publicKey'> {
  const body = JSON.stringify(envelope);
  const webhookId = 'whk_01TEST';
  const canonical = `ENSC-WH-V1\n${webhookId}\n${timestamp}\n${sha256Hex(utf8ToBytes(body))}`;
  const sig = ed25519.sign(utf8ToBytes(canonical), SEED);
  return {
    body,
    headers: {
      'x-ensc-signature': `ed25519=${bytesToBase64Url(sig)}`,
      'x-ensc-timestamp': String(timestamp),
      'x-ensc-webhook-id': webhookId,
      'x-ensc-key-id': KID,
    },
    publicKey: { [KID]: PUBLIC_KEY },
  };
}

const base = {
  id: 'ev_01TEST',
  type: 'conversion.succeeded',
  apiVersion: '2026-09-15',
  product: 'ensc',
  created: 1_700_000_000,
  data: { reference: 'ref-1', status: 'succeeded' },
};
const VICTIM = 'mrc_01VICTIM000000000000000000';
const ATTACKER = 'mrc_01ATTACKER0000000000000000';

describe('the signed body says whose event it is', () => {
  it('exposes merchantId, env and synthetic on the verified event', () => {
    const real = constructEvent(delivery({ ...base, merchantId: VICTIM, env: 'live' }));
    expect(real.merchantId).toBe(VICTIM);
    expect(real.env).toBe('live');
    expect(real.synthetic).toBeUndefined();

    const test = constructEvent(
      delivery({ ...base, merchantId: VICTIM, env: 'test', synthetic: true }),
    );
    expect(test.env).toBe('test');
    expect(test.synthetic).toBe(true);
  });

  it('accepts a delivery signed for this merchant and environment', () => {
    const d = delivery({ ...base, merchantId: VICTIM, env: 'live' });
    expect(verifyWebhookSignature({ ...d, merchantId: VICTIM, env: 'live' })).toEqual({
      valid: true,
    });
    expect(constructEvent({ ...d, merchantId: VICTIM, env: 'live' }).id).toBe('ev_01TEST');
  });

  it("refuses another merchant's genuine Sandbox delivery replayed to a Live receiver", () => {
    // What a Sandbox account can mint: a platform-signed event of a real type
    // with a payload of its choosing. The signature is genuine.
    const forged = delivery({
      ...base,
      merchantId: ATTACKER,
      env: 'test',
      synthetic: true,
      data: { reference: "the victim's reference", status: 'succeeded' },
    });
    expect(verifyWebhookSignature(forged)).toEqual({ valid: true });
    expect(verifyWebhookSignature({ ...forged, merchantId: VICTIM, env: 'live' })).toEqual({
      valid: false,
      reason: 'merchant_mismatch',
    });
    // The victim's own Sandbox event does not pass for a Live one either.
    const ownTest = delivery({ ...base, merchantId: VICTIM, env: 'test', synthetic: true });
    expect(verifyWebhookSignature({ ...ownTest, merchantId: VICTIM, env: 'live' })).toEqual({
      valid: false,
      reason: 'env_mismatch',
    });
    expect(() => constructEvent({ ...forged, merchantId: VICTIM, env: 'live' })).toThrow(
      expect.objectContaining({
        code: 'ENSC_INVALID_SIGNATURE',
        details: { reason: 'merchant_mismatch' },
      }),
    );
  });

  it('refuses a body that names no merchant or environment once one is expected', () => {
    const legacy = delivery(base);
    // Without expectations the signature alone decides, as before.
    expect(verifyWebhookSignature(legacy)).toEqual({ valid: true });
    expect(constructEvent(legacy).merchantId).toBeUndefined();
    expect(verifyWebhookSignature({ ...legacy, merchantId: VICTIM })).toEqual({
      valid: false,
      reason: 'merchant_mismatch',
    });
    expect(verifyWebhookSignature({ ...legacy, env: 'live' })).toEqual({
      valid: false,
      reason: 'env_mismatch',
    });
    // An empty expectation is not "no expectation".
    const d = delivery({ ...base, merchantId: VICTIM, env: 'live' });
    expect(verifyWebhookSignature({ ...d, merchantId: '' })).toEqual({
      valid: false,
      reason: 'merchant_mismatch',
    });
    expect(verifyWebhookSignature({ ...d, env: '' as 'live' })).toEqual({
      valid: false,
      reason: 'env_mismatch',
    });
  });

  it('checks the signature before the merchant: a tampered body is a signature failure', () => {
    const d = delivery({ ...base, merchantId: ATTACKER, env: 'live' });
    const tampered = { ...d, body: String(d.body).replace(ATTACKER, VICTIM) };
    expect(verifyWebhookSignature({ ...tampered, merchantId: VICTIM, env: 'live' })).toEqual({
      valid: false,
      reason: 'signature_mismatch',
    });
  });

  it('refuses an envelope whose merchantId, env or synthetic has the wrong type', () => {
    for (const bad of [{ merchantId: 7 }, { env: 'prod' }, { synthetic: 'yes' }]) {
      expect(() => constructEvent(delivery({ ...base, ...bad }))).toThrow(
        expect.objectContaining({ code: 'ENSC_VALIDATION_FAILED' }),
      );
    }
  });
});

describe('toleranceSeconds', () => {
  const old = Math.floor(Date.now() / 1000) - 3600;
  const captured = () => delivery({ ...base, merchantId: VICTIM, env: 'live' }, old);

  it('a value that is not a number of zero or more is refused, never read as off', () => {
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY, '300' as unknown as number]) {
      expect(verifyWebhookSignature({ ...captured(), toleranceSeconds: bad })).toEqual({
        valid: false,
        reason: 'invalid_tolerance',
      });
      // A fresh delivery is refused too: the option itself is wrong.
      const fresh = delivery({ ...base, merchantId: VICTIM, env: 'live' });
      expect(verifyWebhookSignature({ ...fresh, toleranceSeconds: bad }).valid).toBe(false);
    }
    expect(() => constructEvent({ ...captured(), toleranceSeconds: Number(undefined) })).toThrow(
      expect.objectContaining({ details: { reason: 'invalid_tolerance' } }),
    );
  });

  it('only an explicit 0 turns the window off; the default is 300 seconds', () => {
    expect(verifyWebhookSignature({ ...captured(), toleranceSeconds: 0 })).toEqual({ valid: true });
    expect(verifyWebhookSignature(captured())).toEqual({
      valid: false,
      reason: 'timestamp_out_of_tolerance',
    });
    expect(verifyWebhookSignature({ ...captured(), toleranceSeconds: 7200 })).toEqual({
      valid: true,
    });
  });
});

describe('fetchPublicKeys', () => {
  const doc = (keys: unknown[]) =>
    new Response(JSON.stringify({ keys }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  const key = (kid: string, publicKey: string) => ({
    kid,
    alg: 'Ed25519',
    publicKey,
    use: ['webhooks'],
  });

  it('refuses a plain http host before any request is made', async () => {
    let called = 0;
    const fetchImpl = (async () => {
      called++;
      return doc([key(KID, PUBLIC_KEY)]);
    }) as unknown as typeof fetch;
    for (const baseUrl of ['http://api.acme.test', 'ftp://api.acme.test', 'not a url']) {
      await expect(fetchPublicKeys(PRODUCT, { baseUrl, fetch: fetchImpl })).rejects.toMatchObject({
        code: 'ENSC_VALIDATION_FAILED',
        message: /baseUrl must/,
      });
    }
    expect(called).toBe(0);
    // http stays allowed for localhost, as in the client config.
    await expect(
      fetchPublicKeys(PRODUCT, { baseUrl: 'http://localhost:8787', fetch: fetchImpl }),
    ).resolves.toEqual({ [KID]: PUBLIC_KEY });
    expect(called).toBe(1);
  });

  it('keeps only keys of 32 bytes', async () => {
    const short = bytesToBase64Url(randomBytes(16));
    const mixed = (async () =>
      doc([
        key('short', short),
        key('junk', '***'),
        key(KID, PUBLIC_KEY),
      ])) as unknown as typeof fetch;
    await expect(fetchPublicKeys(PRODUCT, { fetch: mixed })).resolves.toEqual({
      [KID]: PUBLIC_KEY,
    });
    const none = (async () => doc([key('short', short)])) as unknown as typeof fetch;
    await expect(fetchPublicKeys(PRODUCT, { fetch: none })).rejects.toMatchObject({
      code: 'ENSC_UPSTREAM_FAILED',
      message: /no webhook key/,
    });
  });

  it('never follows a redirect', async () => {
    let seen: RequestInit | undefined;
    const redirecting = (async (_url: string, init?: RequestInit) => {
      seen = init;
      return new Response(null, { status: 307, headers: { Location: 'http://elsewhere.test/' } });
    }) as unknown as typeof fetch;
    await expect(fetchPublicKeys(PRODUCT, { fetch: redirecting })).rejects.toMatchObject({
      code: 'ENSC_UPSTREAM_FAILED',
      message: /HTTP 307/,
    });
    expect(seen?.redirect).toBe('manual');
  });
});
