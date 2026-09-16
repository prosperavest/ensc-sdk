/**
 * Client configuration.
 *
 * Secrets enter the SDK exactly here, through the constructor. The SDK never
 * reads `process.env` itself; wiring environment variables is the consumer's job.
 * Resolved secrets are held in a closure inside the client and are never logged,
 * serialized, or exposed as enumerable properties.
 *
 * Four credentials are issued together by the dashboard when a merchant
 * generates keys:
 *
 *   apiKey             identifies the merchant (Bearer token)
 *   encryptionKey      AES-256-GCM key that encrypts every request body
 *   signingPrivateKey  Ed25519 key that signs every write and is the recipient
 *                      key every sealed response is opened with
 *
 * plus the two ids (`encryptionKeyId`, `signingKeyId`) the API uses to look the
 * key material up. All are required: since API version 2026-09-15 the API
 * refuses plaintext merchant writes and seals every successful response.
 */

import {
  base64UrlToBytes,
  CURRENT_API_VERSION,
  ENCRYPTION_KEY_BYTES,
  EnscError,
} from '@ensc/protocol';

/** Default ENSC API base URL. Override for staging / local. */
export const DEFAULT_BASE_URL = 'https://api.ensc.prosperavest.com';

/**
 * Default `X-ENSC-API-Version` sent on every request. Pinning the version means
 * a future API change cannot silently alter behavior under a deployed integration.
 * Bump this deliberately, with a changelog entry, when adopting a newer contract.
 *
 * 2026-09-15 introduced mandatory request encryption (ENSC-ENC-V1) and sealed,
 * signed responses (ENSC-RESP-V1).
 */
export const DEFAULT_API_VERSION: string = CURRENT_API_VERSION;

/** Default per-request timeout. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Default number of automatic retries for transient failures. */
export const DEFAULT_MAX_RETRIES = 2;

/**
 * Default tolerance between the `X-ENSC-Timestamp` on a sealed response and the
 * local clock. A response outside this window is rejected as a replay.
 */
export const DEFAULT_RESPONSE_MAX_SKEW_SECONDS = 300;

/** Path of the public-key document the SDK verifies sealed responses against. */
export const PUBLIC_KEYS_PATH = '/v1/.well-known/ensc-public-keys.json';

const ENC_KEY_ID_RE = /^enc_[0-9A-Z]{26}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export interface EnscClientConfig {
  /**
   * Merchant API key (secret): `ensc_live_sk_…`, `ensc_test_sk_…`, or an
   * `rk` restricted key. Sent as `Authorization: Bearer`. Identifies the
   * merchant and carries env + scopes.
   */
  apiKey: string;

  /**
   * Merchant ID (`mrc_…`). Not a secret; it is part of the canonical string
   * every signed request is built from and of the AAD every encrypted body is
   * bound to.
   */
  merchantId: string;

  /**
   * Request encryption key (secret): base64url-encoded 32-byte AES-256-GCM
   * key issued by the dashboard. Every request body is encrypted with it
   * before it is signed and sent (ENSC-ENC-V1).
   */
  encryptionKey: string;

  /** The `enc_…` id the dashboard returned with the encryption key. Not a secret. */
  encryptionKeyId: string;

  /**
   * Ed25519 signing private key (secret): base64url-encoded 32-byte seed
   * issued by the dashboard. Signs every mutating request (ENSC-V1) and is
   * the key every sealed response (ENSC-RESP-V1) is opened with.
   */
  signingPrivateKey: string;

  /**
   * The id the dashboard returned when it registered the signing key. Sent as
   * `X-ENSC-Key-Id` on every request so the API knows which public key to
   * verify writes against and to seal responses to. Not a secret.
   */
  signingKeyId: string;

  /**
   * ENSC's Ed25519 public keys, keyed by key id, used to verify the signature
   * on every sealed response. When omitted the SDK fetches
   * {@link PUBLIC_KEYS_PATH} from `baseUrl` once per process and caches it.
   * Pin them here to remove that network dependency in locked-down deployments.
   */
  enscPublicKeys?: Record<string, string>;

  /** API base URL. Defaults to {@link DEFAULT_BASE_URL}. */
  baseUrl?: string;

  /** `X-ENSC-API-Version` header value. Defaults to {@link DEFAULT_API_VERSION}. */
  apiVersion?: string;

  /** Per-request timeout in milliseconds. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;

  /**
   * Automatic retries for transient failures (network errors and 5xx only,
   * never 4xx). Defaults to {@link DEFAULT_MAX_RETRIES}. Set `0` to disable.
   */
  maxRetries?: number;

  /**
   * Maximum accepted age, in seconds, of a sealed response's timestamp.
   * Defaults to {@link DEFAULT_RESPONSE_MAX_SKEW_SECONDS}.
   */
  responseMaxSkewSeconds?: number;

  /**
   * Custom `fetch` implementation. Defaults to the runtime global. Useful for
   * tests, proxies, or pinning a polyfill.
   */
  fetch?: typeof fetch;

  /**
   * Escape hatch to allow construction in a browser context. The SDK refuses to
   * run in a browser by default because every credential it holds is a secret
   * that must never reach client-side bundles. Only set this if you have a
   * non-browser `window` global (extremely rare), never to ship the SDK to end
   * users.
   */
  dangerouslyAllowBrowser?: boolean;
}

/** Fully-resolved, validated configuration. Secrets live only on this object. */
export interface ResolvedConfig {
  apiKey: string;
  merchantId: string;
  /** Decoded 32-byte AES-256-GCM key. */
  encryptionKey: Uint8Array;
  encryptionKeyId: string;
  /** base64url Ed25519 seed, as `@ensc/protocol` expects it. */
  signingPrivateKey: string;
  signingKeyId: string;
  enscPublicKeys?: Record<string, string>;
  baseUrl: string;
  apiVersion: string;
  timeoutMs: number;
  maxRetries: number;
  responseMaxSkewSeconds: number;
  fetch: typeof fetch;
}

function isBrowserLike(): boolean {
  // `window` + `document` together is the reliable browser signal. Workers,
  // Deno, Node and Bun do not define both.
  return (
    typeof window !== 'undefined' &&
    typeof (globalThis as { document?: unknown }).document !== 'undefined'
  );
}

function fail(message: string): never {
  throw new EnscError('ENSC_VALIDATION_FAILED', message);
}

function requireString(value: unknown, name: string): string {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) fail(`config.${name} is required`);
  return s;
}

function decodeKey(value: string, name: string, expectedBytes: number): Uint8Array {
  if (!BASE64URL_RE.test(value)) fail(`config.${name} must be base64url (no padding)`);
  let bytes: Uint8Array;
  try {
    bytes = base64UrlToBytes(value);
  } catch {
    return fail(`config.${name} is not valid base64url`);
  }
  if (bytes.length !== expectedBytes) {
    fail(`config.${name} must decode to ${expectedBytes} bytes`);
  }
  return bytes;
}

/**
 * Validate raw config and fill defaults. Throws `EnscError('ENSC_VALIDATION_FAILED')`
 * with a clear message for anything missing or malformed, failing here, at
 * construction, rather than on the first request.
 */
export function resolveConfig(config: EnscClientConfig): ResolvedConfig {
  if (!config || typeof config !== 'object') {
    fail('EnscClient requires a config object');
  }

  if (!config.dangerouslyAllowBrowser && isBrowserLike()) {
    fail(
      'EnscClient must not run in a browser: the API key, encryption key and signing key are ' +
        'secrets and would be exposed in a client-side bundle. Use the SDK only from server-side code.',
    );
  }

  const apiKey = requireString(config.apiKey, 'apiKey');
  const merchantId = requireString(config.merchantId, 'merchantId');

  const encryptionKeyText = requireString(config.encryptionKey, 'encryptionKey');
  const encryptionKey = decodeKey(encryptionKeyText, 'encryptionKey', ENCRYPTION_KEY_BYTES);
  const encryptionKeyId = requireString(config.encryptionKeyId, 'encryptionKeyId');
  if (!ENC_KEY_ID_RE.test(encryptionKeyId)) {
    fail('config.encryptionKeyId must be the enc_… id issued with the encryption key');
  }

  const signingPrivateKey = requireString(config.signingPrivateKey, 'signingPrivateKey');
  decodeKey(signingPrivateKey, 'signingPrivateKey', 32);
  const signingKeyId = requireString(config.signingKeyId, 'signingKeyId');

  let enscPublicKeys: Record<string, string> | undefined;
  if (config.enscPublicKeys !== undefined) {
    if (
      config.enscPublicKeys === null ||
      typeof config.enscPublicKeys !== 'object' ||
      Array.isArray(config.enscPublicKeys)
    ) {
      fail('config.enscPublicKeys must be a record of key id to base64url public key');
    }
    const entries = Object.entries(config.enscPublicKeys);
    if (entries.length === 0) fail('config.enscPublicKeys must not be empty');
    enscPublicKeys = {};
    for (const [kid, pk] of entries) {
      if (!kid.trim()) fail('config.enscPublicKeys contains an empty key id');
      if (typeof pk !== 'string') fail(`config.enscPublicKeys[${kid}] must be a string`);
      decodeKey(pk, `enscPublicKeys[${kid}]`, 32);
      enscPublicKeys[kid] = pk;
    }
  }

  const fetchImpl = config.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    fail(
      'No fetch implementation found. Use Node 20.19+ or 22.12+, a Worker/Deno/Bun runtime, ' +
        'or pass config.fetch explicitly.',
    );
  }

  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const responseMaxSkewSeconds = config.responseMaxSkewSeconds ?? DEFAULT_RESPONSE_MAX_SKEW_SECONDS;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    fail('config.timeoutMs must be a positive number');
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    fail('config.maxRetries must be a non-negative integer');
  }
  if (!Number.isFinite(responseMaxSkewSeconds) || responseMaxSkewSeconds <= 0) {
    fail('config.responseMaxSkewSeconds must be a positive number');
  }

  return {
    apiKey,
    merchantId,
    encryptionKey,
    encryptionKeyId,
    signingPrivateKey,
    signingKeyId,
    ...(enscPublicKeys ? { enscPublicKeys } : {}),
    baseUrl,
    apiVersion: config.apiVersion ?? DEFAULT_API_VERSION,
    timeoutMs,
    maxRetries,
    responseMaxSkewSeconds,
    fetch: fetchImpl,
  };
}
