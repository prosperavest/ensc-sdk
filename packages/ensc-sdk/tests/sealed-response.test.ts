import { generateKeypair } from '@ensc/protocol';
import { randomBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { ENSC_KID, ENSC_PUBLIC_KEY, ok, testServer } from './_server.js';

const read = (srv: ReturnType<typeof testServer>) => srv.client.events.get('evt_1');
const payload = { id: 'evt_1', eventType: 'conversion.succeeded', secret: 'only-for-us' };

describe('sealed responses (ENSC-RESP-V1)', () => {
  it('verifies the signature, opens the envelope and returns the plaintext object', async () => {
    const srv = testServer(ok(payload));
    await expect(read(srv)).resolves.toEqual(payload);
  });

  it('fetches the public-key document once and reuses it across requests', async () => {
    const srv = testServer(ok(payload));
    await Promise.all([read(srv), read(srv), read(srv)]);
    await read(srv);
    expect(srv.publicKeyFetches).toBe(1);
    // The well-known fetch is not counted as an API call.
    expect(srv.calls).toHaveLength(4);
  });

  it('never fetches the document when keys are pinned in config', async () => {
    const srv = testServer(ok(payload), {
      config: { enscPublicKeys: { [ENSC_KID]: ENSC_PUBLIC_KEY } },
    });
    await read(srv);
    expect(srv.publicKeyFetches).toBe(0);
  });

  it('rejects a response signed with an unknown key after exactly one refetch', async () => {
    const srv = testServer(() => ({ status: 200, body: payload, kid: 'ensc_unknown' }));
    await expect(read(srv)).rejects.toMatchObject({ code: 'ENSC_INVALID_SIGNATURE' });
    expect(srv.publicKeyFetches).toBe(2);
  });

  it('rejects an unknown key without refetching when keys are pinned', async () => {
    const srv = testServer(() => ({ status: 200, body: payload, kid: 'ensc_unknown' }), {
      config: { enscPublicKeys: { [ENSC_KID]: ENSC_PUBLIC_KEY } },
    });
    await expect(read(srv)).rejects.toMatchObject({ code: 'ENSC_INVALID_SIGNATURE' });
    expect(srv.publicKeyFetches).toBe(0);
  });

  it('picks up a rotated ENSC key: a new kid resolves after refetch', async () => {
    const other = randomBytes(32);
    const { ed25519 } = await import('@noble/curves/ed25519.js');
    const { bytesToBase64Url } = await import('@ensc/protocol');
    const otherPk = bytesToBase64Url(ed25519.getPublicKey(other));
    const srv = testServer(
      () => ({ status: 200, body: payload, kid: 'ensc_kid_2', signWith: other }),
      {
        publicKeys: {
          keys: [
            { kid: ENSC_KID, publicKey: ENSC_PUBLIC_KEY },
            { kid: 'ensc_kid_2', publicKey: otherPk },
          ],
        },
      },
    );
    await expect(read(srv)).resolves.toEqual(payload);
  });

  it('rejects a body whose signature does not verify', async () => {
    const srv = testServer(() => ({ status: 200, body: payload, signWith: randomBytes(32) }));
    await expect(read(srv)).rejects.toMatchObject({
      code: 'ENSC_INVALID_SIGNATURE',
      message: /did not verify/,
    });
  });

  it('rejects a stale timestamp', async () => {
    const srv = testServer(() => ({
      status: 200,
      body: payload,
      timestamp: Math.floor(Date.now() / 1000) - 3600,
    }));
    await expect(read(srv)).rejects.toMatchObject({
      code: 'ENSC_INVALID_SIGNATURE',
      message: /window/,
    });
  });

  it('honors a custom responseMaxSkewSeconds', async () => {
    const srv = testServer(
      () => ({ status: 200, body: payload, timestamp: Math.floor(Date.now() / 1000) - 30 }),
      { config: { responseMaxSkewSeconds: 10 } },
    );
    await expect(read(srv)).rejects.toMatchObject({ code: 'ENSC_INVALID_SIGNATURE' });
  });

  it('refuses a plaintext 2xx (no downgrade)', async () => {
    const srv = testServer(() => ({ status: 200, body: payload, unsealed: true }));
    await expect(read(srv)).rejects.toMatchObject({
      code: 'ENSC_INVALID_SIGNATURE',
      message: /missing X-ENSC/,
    });
  });

  it('fails to open a body sealed to a different key', async () => {
    const stranger = generateKeypair();
    const srv = testServer(() => ({ status: 200, body: payload, sealTo: stranger.publicKey }));
    await expect(read(srv)).rejects.toMatchObject({ code: 'ENSC_DECRYPTION_FAILED' });
  });

  it('surfaces a failing public-key fetch as ENSC_UPSTREAM_FAILED', async () => {
    const srv = testServer(ok(payload), { publicKeys: { status: 503 } });
    await expect(read(srv)).rejects.toMatchObject({ code: 'ENSC_UPSTREAM_FAILED' });
  });

  it('ignores keys not marked for responses', async () => {
    const srv = testServer(ok(payload), {
      publicKeys: { keys: [{ kid: ENSC_KID, publicKey: ENSC_PUBLIC_KEY, use: ['webhooks'] }] },
    });
    await expect(read(srv)).rejects.toMatchObject({ code: 'ENSC_UPSTREAM_FAILED' });
  });

  it('leaves error responses unsealed and readable', async () => {
    const srv = testServer(() => ({
      status: 403,
      body: { error: { code: 'ENSC_DASHBOARD_ONLY', message: 'nope' } },
    }));
    await expect(read(srv)).rejects.toMatchObject({ code: 'ENSC_DASHBOARD_ONLY', status: 403 });
  });
});
