/**
 * ENSC-ENC-V1 request envelope (AES-256-GCM with request-bound AAD).
 */

import { describe, expect, it } from 'vitest';
import { base64UrlToBytes, bytesToBase64Url } from '../src/encoding.js';
import {
  buildRequestAad,
  decryptEnvelope,
  ENVELOPE_MAX_CIPHERTEXT_BYTES,
  EnvelopeError,
  encryptEnvelope,
  generateEncryptionKey,
  parseEnvelope,
} from '../src/envelope.js';

const KEY_ID = 'enc_01HXY0000000000000000000AB';
const aad = buildRequestAad({
  method: 'post',
  path: '/v1/mint',
  merchantId: 'mrc_1',
  encKeyId: KEY_ID,
});

describe('encryptEnvelope / decryptEnvelope', () => {
  it('round-trips and produces the documented wire shape', async () => {
    const key = generateEncryptionKey();
    const env = await encryptEnvelope({ key, encKeyId: KEY_ID, plaintext: '{"a":1}', aad });
    expect(env.v).toBe(1);
    expect(env.encKeyId).toBe(KEY_ID);
    expect(base64UrlToBytes(env.iv).length).toBe(12);
    expect(base64UrlToBytes(env.tag).length).toBe(16);
    expect(parseEnvelope(env)).toEqual(env);
    const pt = await decryptEnvelope({ key, envelope: env, aad });
    expect(new TextDecoder().decode(pt)).toBe('{"a":1}');
  });

  it('AAD uppercases the method and is newline-joined', () => {
    expect(new TextDecoder().decode(aad)).toBe(`ENSC-ENC-V1\nPOST\n/v1/mint\nmrc_1\n${KEY_ID}`);
  });

  it('fails when AAD differs (other path, other merchant, other key id)', async () => {
    const key = generateEncryptionKey();
    const env = await encryptEnvelope({ key, encKeyId: KEY_ID, plaintext: '{}', aad });
    for (const other of [
      { method: 'POST', path: '/v1/transfer', merchantId: 'mrc_1', encKeyId: KEY_ID },
      { method: 'POST', path: '/v1/mint', merchantId: 'mrc_2', encKeyId: KEY_ID },
      {
        method: 'POST',
        path: '/v1/mint',
        merchantId: 'mrc_1',
        encKeyId: 'enc_01HXY0000000000000000000ZZ',
      },
    ]) {
      await expect(
        decryptEnvelope({ key, envelope: env, aad: buildRequestAad(other) }),
      ).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
    }
  });

  it('fails on a tampered tag or ciphertext', async () => {
    const key = generateEncryptionKey();
    const env = await encryptEnvelope({ key, encKeyId: KEY_ID, plaintext: '{"amount":"1"}', aad });
    const ct = base64UrlToBytes(env.ciphertext);
    ct[0] = (ct[0] ?? 0) ^ 0x01;
    await expect(
      decryptEnvelope({ key, envelope: { ...env, ciphertext: bytesToBase64Url(ct) }, aad }),
    ).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
    const tag = base64UrlToBytes(env.tag);
    tag[15] = (tag[15] ?? 0) ^ 0x80;
    await expect(
      decryptEnvelope({ key, envelope: { ...env, tag: bytesToBase64Url(tag) }, aad }),
    ).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
  });

  it('fails with the wrong key', async () => {
    const env = await encryptEnvelope({
      key: generateEncryptionKey(),
      encKeyId: KEY_ID,
      plaintext: '{}',
      aad,
    });
    await expect(
      decryptEnvelope({ key: generateEncryptionKey(), envelope: env, aad }),
    ).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
  });

  it('rejects keys that are not 32 bytes', async () => {
    await expect(
      encryptEnvelope({ key: new Uint8Array(16), encKeyId: KEY_ID, plaintext: '{}', aad }),
    ).rejects.toBeInstanceOf(EnvelopeError);
  });

  it('rejects malformed base64url and wrong lengths', async () => {
    const key = generateEncryptionKey();
    const env = await encryptEnvelope({ key, encKeyId: KEY_ID, plaintext: '{}', aad });
    await expect(
      decryptEnvelope({ key, envelope: { ...env, iv: '!!!!!!!!!!!!!!!!' }, aad }),
    ).rejects.toMatchObject({ code: 'MALFORMED' });
    await expect(
      decryptEnvelope({ key, envelope: { ...env, ciphertext: 'a' }, aad }),
    ).rejects.toMatchObject({ code: 'MALFORMED' });
  });

  it('rejects oversized ciphertext before touching the cipher', async () => {
    const key = generateEncryptionKey();
    const env = await encryptEnvelope({ key, encKeyId: KEY_ID, plaintext: '{}', aad });
    const big = bytesToBase64Url(new Uint8Array(ENVELOPE_MAX_CIPHERTEXT_BYTES + 1));
    await expect(
      decryptEnvelope({ key, envelope: { ...env, ciphertext: big }, aad }),
    ).rejects.toMatchObject({ code: 'TOO_LARGE' });
  });

  it('uses a fresh IV per call', async () => {
    const key = generateEncryptionKey();
    const a = await encryptEnvelope({ key, encKeyId: KEY_ID, plaintext: '{}', aad });
    const b = await encryptEnvelope({ key, encKeyId: KEY_ID, plaintext: '{}', aad });
    expect(a.iv).not.toBe(b.iv);
  });
});

describe('parseEnvelope', () => {
  it('rejects non-envelopes and extra fields', () => {
    expect(parseEnvelope(null)).toBeNull();
    expect(parseEnvelope({ recipient: '0xabc', amount: '1' })).toBeNull();
    expect(
      parseEnvelope({
        v: 1,
        encKeyId: KEY_ID,
        iv: 'a'.repeat(16),
        ciphertext: 'x',
        tag: 'b'.repeat(22),
        z: 1,
      }),
    ).toBeNull();
    expect(
      parseEnvelope({
        v: 1,
        encKeyId: 'enc_bad',
        iv: 'a'.repeat(16),
        ciphertext: 'x',
        tag: 'b'.repeat(22),
      }),
    ).toBeNull();
    expect(
      parseEnvelope({
        v: 1,
        encKeyId: KEY_ID,
        iv: 'a'.repeat(15),
        ciphertext: 'x',
        tag: 'b'.repeat(22),
      }),
    ).toBeNull();
  });
});
