import { describe, expect, it } from 'vitest';
import {
  buildCanonicalString,
  canonicalQuery,
  generateKeypair,
  publicKeyFromPrivate,
  signRequest,
  verifyRequest,
} from '../src/index.js';

describe('canonical', () => {
  it('sorts query keys alphabetically', () => {
    expect(canonicalQuery({ b: '2', a: '1', c: '3' })).toBe('a=1&b=2&c=3');
  });

  it('sorts repeated values within a key', () => {
    expect(canonicalQuery('x=2&x=1&x=3')).toBe('x=1&x=2&x=3');
  });

  it('returns empty string for undefined', () => {
    expect(canonicalQuery(undefined)).toBe('');
  });

  it('is deterministic for the same inputs', () => {
    const req = {
      method: 'POST',
      path: '/mint',
      query: undefined,
      body: '{"amount":100}',
      timestamp: 1700000000,
      nonce: 'abc',
      merchantId: 'mrc_1',
    };
    expect(buildCanonicalString(req)).toBe(buildCanonicalString(req));
  });

  it('produces different output if method changes', () => {
    const base = {
      path: '/x',
      query: undefined,
      body: '',
      timestamp: 1,
      nonce: 'n',
      merchantId: 'm',
    };
    expect(buildCanonicalString({ ...base, method: 'GET' })).not.toBe(
      buildCanonicalString({ ...base, method: 'POST' }),
    );
  });
});

describe('keypair', () => {
  it('generates valid base64url keypair', () => {
    const kp = generateKeypair();
    expect(kp.privateKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(kp.publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('derives the same public key from a private key', () => {
    const kp = generateKeypair();
    expect(publicKeyFromPrivate(kp.privateKey)).toBe(kp.publicKey);
  });
});

describe('sign / verify roundtrip', () => {
  it('verifies a signature it produced', () => {
    const kp = generateKeypair();
    const req = {
      method: 'POST',
      path: '/mint',
      query: undefined,
      body: '{"recipient":"0xabc","amount":"1000000000000000000"}',
      timestamp: Math.floor(Date.now() / 1000),
      nonce: 'nonce-xyz',
      merchantId: 'mrc_1',
      idempotencyKey: 'idem-1',
      privateKey: kp.privateKey,
      keyId: 'kp_1',
    };

    const { headers } = signRequest(req);
    const result = verifyRequest({
      ...req,
      publicKey: kp.publicKey,
      signatureHeader: headers['X-ENSC-Signature'],
    });
    expect(result.ok).toBe(true);
  });

  it('rejects tampered body', () => {
    const kp = generateKeypair();
    const ts = Math.floor(Date.now() / 1000);
    const { headers } = signRequest({
      method: 'POST',
      path: '/mint',
      query: undefined,
      body: '{"amount":100}',
      timestamp: ts,
      nonce: 'n',
      merchantId: 'm',
      privateKey: kp.privateKey,
      keyId: 'kp_1',
    });
    const result = verifyRequest({
      method: 'POST',
      path: '/mint',
      query: undefined,
      body: '{"amount":1000000}', // tampered
      timestamp: ts,
      nonce: 'n',
      merchantId: 'm',
      publicKey: kp.publicKey,
      signatureHeader: headers['X-ENSC-Signature'],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('INVALID_SIGNATURE');
  });

  it('rejects stale timestamps', () => {
    const kp = generateKeypair();
    const oldTs = Math.floor(Date.now() / 1000) - 3600;
    const { headers } = signRequest({
      method: 'GET',
      path: '/x',
      query: undefined,
      body: '',
      timestamp: oldTs,
      nonce: 'n',
      merchantId: 'm',
      privateKey: kp.privateKey,
      keyId: 'kp_1',
    });
    const result = verifyRequest({
      method: 'GET',
      path: '/x',
      query: undefined,
      body: '',
      timestamp: oldTs,
      nonce: 'n',
      merchantId: 'm',
      publicKey: kp.publicKey,
      signatureHeader: headers['X-ENSC-Signature'],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('TIMESTAMP_OUT_OF_WINDOW');
  });
});
