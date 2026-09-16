import { describe, expect, it } from 'vitest';
import { base64UrlToBytes, bytesEqual, bytesToBase64Url, concatBytes } from '../src/encoding.js';

describe('base64url', () => {
  it('round-trips all byte values', () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    const s = bytesToBase64Url(bytes);
    expect(s).not.toMatch(/[+/=]/);
    expect(Array.from(base64UrlToBytes(s))).toEqual(Array.from(bytes));
  });
  it('rejects padding, standard alphabet, and impossible lengths', () => {
    expect(() => base64UrlToBytes('AA==')).toThrow();
    expect(() => base64UrlToBytes('A+B/')).toThrow();
    expect(() => base64UrlToBytes('A')).toThrow();
  });
});

describe('bytes helpers', () => {
  it('concat and constant-time equality', () => {
    const c = concatBytes(new Uint8Array([1, 2]), new Uint8Array([3]));
    expect(Array.from(c)).toEqual([1, 2, 3]);
    expect(bytesEqual(c, new Uint8Array([1, 2, 3]))).toBe(true);
    expect(bytesEqual(c, new Uint8Array([1, 2, 4]))).toBe(false);
    expect(bytesEqual(c, new Uint8Array([1, 2]))).toBe(false);
  });
});
