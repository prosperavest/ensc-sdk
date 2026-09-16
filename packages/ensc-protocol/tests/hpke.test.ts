/**
 * HPKE (RFC 9180) conformance and ENSC-RESP-V1 behaviour.
 *
 * The vectors below are RFC 9180 Appendix A.2.1 (DHKEM(X25519, HKDF-SHA256),
 * HKDF-SHA256, ChaCha20Poly1305, mode_base). Passing them proves the labeled
 * KDF, KEM, key schedule and AEAD framing match the standard byte for byte.
 */

import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { base64UrlToBytes, bytesToBase64Url } from '../src/encoding.js';
import {
  deriveKeyPair,
  ed25519PrivateKeyToX25519,
  ed25519PublicKeyToX25519,
  HpkeError,
  hpkeOpen,
  hpkeSeal,
  openResponse,
  parseSealedEnvelope,
  sealResponse,
} from '../src/hpke.js';

const V = {
  info: '4f6465206f6e2061204772656369616e2055726e',
  ikmE: '909a9b35d3dc4713a5e72a4da274b55d3d3821a37e5d099e74a647db583a904b',
  pkEm: '1afa08d3dec047a643885163f1180476fa7ddb54c6a8029ea33f95796bf2ac4a',
  skEm: 'f4ec9b33b792c372c1d2c2063507b684ef925b8c75a42dbcbf57d63ccd381600',
  ikmR: '1ac01f181fdf9f352797655161c58b75c656a6cc2716dcb66372da835542e1df',
  pkRm: '4310ee97d88cc1f088a5576c77ab0cf5c3ac797f3d95139c6c84b5429c59662a',
  skRm: '8057991eef8f1f1af18f4a9491d16a1ce333f695d4db8e38da75975c4478e0fb',
  pt: '4265617574792069732074727574682c20747275746820626561757479',
  aad0: '436f756e742d30',
  ct0: '1c5250d8034ec2b784ba2cfd69dbdb8af406cfe3ff938e131f0def8c8b60b4db21993c62ce81883d2dd1b51a28',
};

describe('RFC 9180 A.2.1 (X25519, HKDF-SHA256, ChaCha20Poly1305, base)', () => {
  it('DeriveKeyPair reproduces the ephemeral and recipient keys', () => {
    const e = deriveKeyPair(hexToBytes(V.ikmE));
    expect(bytesToHex(e.privateKey)).toBe(V.skEm);
    expect(bytesToHex(e.publicKey)).toBe(V.pkEm);
    const r = deriveKeyPair(hexToBytes(V.ikmR));
    expect(bytesToHex(r.privateKey)).toBe(V.skRm);
    expect(bytesToHex(r.publicKey)).toBe(V.pkRm);
  });

  it('seal reproduces enc and the first ciphertext', () => {
    const ephemeral = deriveKeyPair(hexToBytes(V.ikmE));
    const out = hpkeSeal({
      recipientPublicKey: hexToBytes(V.pkRm),
      info: hexToBytes(V.info),
      aad: hexToBytes(V.aad0),
      plaintext: hexToBytes(V.pt),
      ephemeral,
    });
    expect(bytesToHex(out.enc)).toBe(V.pkEm);
    expect(bytesToHex(out.ciphertext)).toBe(V.ct0);
  });

  it('open recovers the plaintext from the RFC ciphertext', () => {
    const pt = hpkeOpen({
      recipientPrivateKey: hexToBytes(V.skRm),
      enc: hexToBytes(V.pkEm),
      info: hexToBytes(V.info),
      aad: hexToBytes(V.aad0),
      ciphertext: hexToBytes(V.ct0),
    });
    expect(bytesToHex(pt)).toBe(V.pt);
  });

  it('open fails on wrong aad, wrong info, tampered ciphertext, wrong key', () => {
    const base = {
      recipientPrivateKey: hexToBytes(V.skRm),
      enc: hexToBytes(V.pkEm),
      info: hexToBytes(V.info),
      aad: hexToBytes(V.aad0),
      ciphertext: hexToBytes(V.ct0),
    };
    expect(() => hpkeOpen({ ...base, aad: hexToBytes('436f756e742d31') })).toThrow(HpkeError);
    expect(() => hpkeOpen({ ...base, info: hexToBytes('00') })).toThrow(HpkeError);
    const tampered = hexToBytes(V.ct0);
    tampered[5] = (tampered[5] ?? 0) ^ 0x01;
    expect(() => hpkeOpen({ ...base, ciphertext: tampered })).toThrow(HpkeError);
    expect(() => hpkeOpen({ ...base, recipientPrivateKey: hexToBytes(V.skEm) })).toThrow(HpkeError);
  });
});

describe('Ed25519 to X25519 conversion', () => {
  it('public and private conversions agree (DH public key matches)', () => {
    const seed = randomBytes(32);
    const edPk = ed25519.getPublicKey(seed);
    const xPk = ed25519PublicKeyToX25519(edPk);
    const xSk = ed25519PrivateKeyToX25519(seed);
    expect(bytesToHex(x25519.getPublicKey(xSk))).toBe(bytesToHex(xPk));
  });

  it('rejects wrong key lengths', () => {
    expect(() => ed25519PublicKeyToX25519(new Uint8Array(31))).toThrow(HpkeError);
    expect(() => ed25519PrivateKeyToX25519(new Uint8Array(33))).toThrow(HpkeError);
  });
});

describe('ENSC-RESP-V1 sealResponse / openResponse', () => {
  const seed = randomBytes(32);
  const skB64 = bytesToBase64Url(seed);
  const pkB64 = bytesToBase64Url(ed25519.getPublicKey(seed));

  it('round-trips a JSON body', () => {
    const body = JSON.stringify({ balance: '1000000000000000000', asset: 'ensc' });
    const sealed = sealResponse({ recipientEd25519PublicKey: pkB64, requestId: 'req_1', body });
    expect(sealed.v).toBe(1);
    expect(base64UrlToBytes(sealed.enc).length).toBe(32);
    expect(parseSealedEnvelope(sealed)).toEqual(sealed);
    const opened = openResponse({
      recipientEd25519PrivateKey: skB64,
      requestId: 'req_1',
      envelope: sealed,
    });
    expect(JSON.parse(opened)).toEqual({ balance: '1000000000000000000', asset: 'ensc' });
  });

  it('is bound to the requestId', () => {
    const sealed = sealResponse({
      recipientEd25519PublicKey: pkB64,
      requestId: 'req_A',
      body: '{}',
    });
    expect(() =>
      openResponse({ recipientEd25519PrivateKey: skB64, requestId: 'req_B', envelope: sealed }),
    ).toThrow(HpkeError);
  });

  it('cannot be opened by another merchant key', () => {
    const sealed = sealResponse({
      recipientEd25519PublicKey: pkB64,
      requestId: 'req_1',
      body: '{}',
    });
    const other = bytesToBase64Url(randomBytes(32));
    expect(() =>
      openResponse({ recipientEd25519PrivateKey: other, requestId: 'req_1', envelope: sealed }),
    ).toThrow(HpkeError);
  });

  it('uses a fresh ephemeral key per seal', () => {
    const a = sealResponse({ recipientEd25519PublicKey: pkB64, requestId: 'req_1', body: '{}' });
    const b = sealResponse({ recipientEd25519PublicKey: pkB64, requestId: 'req_1', body: '{}' });
    expect(a.enc).not.toBe(b.enc);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('parseSealedEnvelope rejects malformed shapes', () => {
    expect(parseSealedEnvelope(null)).toBeNull();
    expect(parseSealedEnvelope({ v: 2, enc: 'a'.repeat(43), ciphertext: 'b' })).toBeNull();
    expect(parseSealedEnvelope({ v: 1, enc: 'short', ciphertext: 'b' })).toBeNull();
    expect(
      parseSealedEnvelope({ v: 1, enc: 'a'.repeat(43), ciphertext: 'b', extra: 1 }),
    ).toBeNull();
  });
});
