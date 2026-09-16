import { describe, expect, it } from 'vitest';
import {
  DEFAULT_API_VERSION,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RESPONSE_MAX_SKEW_SECONDS,
  DEFAULT_TIMEOUT_MS,
  resolveConfig,
} from '../src/config.js';
import { configFor, ENSC_KID, ENSC_PUBLIC_KEY, merchantFixture } from './_server.js';

const fx = merchantFixture();
const full = configFor(fx);
// `configFor` sets a test baseUrl; the defaults test wants the real default.
const { baseUrl: _ignored, ...minimal } = full;

describe('resolveConfig, defaults', () => {
  it('fills every default when only the six credentials are given', () => {
    const c = resolveConfig(minimal);
    expect(c.apiKey).toBe(fx.apiKey);
    expect(c.merchantId).toBe(fx.merchantId);
    expect(c.encryptionKey).toEqual(fx.encryptionKey);
    expect(c.encryptionKeyId).toBe(fx.encryptionKeyId);
    expect(c.signingPrivateKey).toBe(fx.signingPrivateKey);
    expect(c.signingKeyId).toBe(fx.signingKeyId);
    expect(c.enscPublicKeys).toBeUndefined();
    expect(c.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(c.apiVersion).toBe(DEFAULT_API_VERSION);
    expect(c.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(c.maxRetries).toBe(DEFAULT_MAX_RETRIES);
    expect(c.responseMaxSkewSeconds).toBe(DEFAULT_RESPONSE_MAX_SKEW_SECONDS);
    expect(typeof c.fetch).toBe('function');
  });

  it('pins the 2026-09-15 API version (encrypted requests, sealed responses)', () => {
    expect(DEFAULT_API_VERSION).toBe('2026-09-15');
  });

  it('strips a trailing slash from baseUrl', () => {
    const c = resolveConfig({ ...minimal, baseUrl: 'https://example.com/v1/' });
    expect(c.baseUrl).toBe('https://example.com/v1');
  });

  it('trims whitespace from apiKey and merchantId', () => {
    const c = resolveConfig({ ...minimal, apiKey: `  ${fx.apiKey}  `, merchantId: '  mrc_x  ' });
    expect(c.apiKey).toBe(fx.apiKey);
    expect(c.merchantId).toBe('mrc_x');
  });

  it('uses a custom fetch when provided', () => {
    const customFetch = (() => {}) as unknown as typeof fetch;
    const c = resolveConfig({ ...minimal, fetch: customFetch });
    expect(c.fetch).toBe(customFetch);
  });

  it('keeps pinned ENSC public keys', () => {
    const c = resolveConfig({ ...minimal, enscPublicKeys: { [ENSC_KID]: ENSC_PUBLIC_KEY } });
    expect(c.enscPublicKeys).toEqual({ [ENSC_KID]: ENSC_PUBLIC_KEY });
  });
});

describe('resolveConfig, credentials', () => {
  it.each([
    'apiKey',
    'merchantId',
    'encryptionKey',
    'encryptionKeyId',
    'signingPrivateKey',
    'signingKeyId',
  ] as const)('throws when %s is missing', (field) => {
    const cfg = { ...minimal } as Record<string, unknown>;
    delete cfg[field];
    expect(() => resolveConfig(cfg as never)).toThrow(new RegExp(`${field} is required`));
  });

  it('rejects an encryption key that is not 32 bytes', () => {
    expect(() => resolveConfig({ ...minimal, encryptionKey: 'AAAA' })).toThrow(/32 bytes/);
  });

  it('rejects an encryption key that is not base64url', () => {
    expect(() => resolveConfig({ ...minimal, encryptionKey: `${'A'.repeat(42)}=` })).toThrow(
      /base64url/,
    );
  });

  it('rejects a malformed encryption key id', () => {
    expect(() => resolveConfig({ ...minimal, encryptionKeyId: 'enc_lowercase' })).toThrow(
      /encryptionKeyId/,
    );
  });

  it('rejects a signing key that is not a 32-byte seed', () => {
    expect(() => resolveConfig({ ...minimal, signingPrivateKey: 'c2hvcnQ' })).toThrow(/32 bytes/);
  });

  it('rejects malformed pinned public keys', () => {
    expect(() => resolveConfig({ ...minimal, enscPublicKeys: {} })).toThrow(/enscPublicKeys/);
    expect(() => resolveConfig({ ...minimal, enscPublicKeys: { k: 'nope' } })).toThrow(
      /enscPublicKeys\[k\]/,
    );
  });
});

describe('resolveConfig, validation', () => {
  it('throws on a missing config object', () => {
    expect(() => resolveConfig(undefined as never)).toThrow(/config object/);
  });

  it('throws on a non-positive timeoutMs', () => {
    expect(() => resolveConfig({ ...minimal, timeoutMs: 0 })).toThrow(/timeoutMs/);
    expect(() => resolveConfig({ ...minimal, timeoutMs: -5 })).toThrow(/timeoutMs/);
  });

  it('throws on a negative or non-integer maxRetries', () => {
    expect(() => resolveConfig({ ...minimal, maxRetries: -1 })).toThrow(/maxRetries/);
    expect(() => resolveConfig({ ...minimal, maxRetries: 1.5 })).toThrow(/maxRetries/);
  });

  it('throws on a non-positive responseMaxSkewSeconds', () => {
    expect(() => resolveConfig({ ...minimal, responseMaxSkewSeconds: 0 })).toThrow(/Skew/);
  });

  it('accepts maxRetries of 0 (retries disabled)', () => {
    expect(resolveConfig({ ...minimal, maxRetries: 0 }).maxRetries).toBe(0);
  });

  it('every validation failure is an EnscError with ENSC_VALIDATION_FAILED', () => {
    try {
      resolveConfig({ ...minimal, apiKey: '' });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('ENSC_VALIDATION_FAILED');
    }
  });
});
