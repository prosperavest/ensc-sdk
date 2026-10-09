/**
 * Client configuration, shared by every SDK.
 *
 * Secrets enter an SDK exactly here, through the constructor. The core never
 * reads `process.env`; wiring environment variables is the consumer's job.
 * Resolved secrets are held in a closure inside the client and are never
 * logged, serialized, or exposed as enumerable properties.
 *
 * Three secrets and three identifiers are issued together by the dashboard
 * when a merchant generates keys for a product:
 *
 *   apiKey             identifies the merchant (Bearer token)
 *   encryptionKey      AES-256-GCM key that encrypts every request body
 *   signingPrivateKey  Ed25519 key that signs every write and is the recipient
 *                      key every sealed response is opened with
 *
 * plus the ids (`merchantId`, `encryptionKeyId`, `signingKeyId`) the API uses
 * to look the key material up. All are required: the hosts refuse plaintext
 * merchant writes and seal every successful response.
 */

import { base64UrlToBytes, ENCRYPTION_KEY_BYTES, EnscError } from '@ensc/protocol';
import type { SdkProduct } from './product.js';

/** Default per-request timeout. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Default number of automatic retries for transient failures. */
export const DEFAULT_MAX_RETRIES = 2;

/**
 * Default tolerance between the `X-ENSC-Timestamp` on a sealed response and the
 * local clock. A response outside this window is rejected as a replay.
 */
export const DEFAULT_RESPONSE_MAX_SKEW_SECONDS = 300;

const ENC_KEY_ID_RE = /^enc_[0-9A-Z]{26}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/**
 * What an answer said about the retirement of the API version that served it
 * (the `Deprecation` and `Sunset` response headers). The two headers are read
 * from the HTTP response as sent; they inform, and nothing in the SDK acts on
 * them.
 */
export interface DeprecationNotice {
  /** The API version that served the request (`X-ENSC-API-Version` of the answer). */
  apiVersion: string;
  /** When the version is, or was, deprecated: still served, no longer recommended. */
  deprecatedAt?: Date;
  /** When the version stops being served. Upgrade before this time. */
  sunsetAt?: Date;
  /** The request id of the answer that carried the notice, when it had one. */
  requestId?: string;
}

/**
 * The fields every product's client config shares. Each SDK's public config
 * type is this plus its own name for the pinned server keys
 * (`enscPublicKeys`, `vaultsPublicKeys`), mapped to `serverPublicKeys` here.
 */
export interface ClientConfigBase {
  /**
   * Merchant API key (secret), `sk` or `rk` kind. Sent as
   * `Authorization: Bearer`. Identifies the merchant and carries env + scopes.
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
   * issued by the dashboard. Signs every mutating request (ENSC-V2) and is
   * the key every sealed response (ENSC-RESP-V2) is opened with.
   */
  signingPrivateKey: string;

  /**
   * The id the dashboard returned when it registered the signing key. Sent as
   * `X-ENSC-Key-Id` on every request so the API knows which public key to
   * verify writes against and to seal responses to. Not a secret.
   */
  signingKeyId: string;

  /** API base URL. Defaults to the product's production host. */
  baseUrl?: string;

  /** `X-ENSC-API-Version` header value. Defaults to the version this SDK release pins. */
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
   * tests or for pinning a polyfill.
   */
  fetch?: typeof fetch;

  /**
   * Called when an answer says the API version this client pins is scheduled
   * for retirement: the answer carries a `Deprecation` header, a `Sunset`
   * header, or both. Use it to log or alert, so the SDK is upgraded before
   * the version stops being served. Called at most once per request, for
   * successful and failed answers alike; an exception it throws is ignored and
   * never fails the request. No version is scheduled for retirement today, so
   * it is not called today.
   */
  onDeprecation?: (notice: DeprecationNotice) => void;

  /**
   * Escape hatch to allow construction in a browser context. An SDK refuses to
   * run in a browser by default because every credential it holds is a secret
   * that must never reach client-side bundles. Only set this if you have a
   * non-browser `window` global (extremely rare), never to ship an SDK to end
   * users.
   */
  dangerouslyAllowBrowser?: boolean;
}

/** The core's input: the shared fields plus the server keys under one name. */
export interface ClientConfigInput extends ClientConfigBase {
  /**
   * The product's Ed25519 public keys, keyed by key id, used to verify the
   * signature on every sealed response. When omitted the SDK fetches the
   * product's well-known document from `baseUrl` once per client and caches
   * it. Pin them to remove that network dependency in locked-down deployments.
   */
  serverPublicKeys?: Record<string, string>;
}

/** Fully-resolved, validated configuration. Secrets live only on this object. */
export interface ResolvedClientConfig {
  apiKey: string;
  merchantId: string;
  /** Decoded 32-byte AES-256-GCM key. */
  encryptionKey: Uint8Array;
  encryptionKeyId: string;
  /** base64url Ed25519 seed, as `@ensc/protocol` expects it. */
  signingPrivateKey: string;
  signingKeyId: string;
  serverPublicKeys?: Record<string, string>;
  baseUrl: string;
  apiVersion: string;
  timeoutMs: number;
  maxRetries: number;
  responseMaxSkewSeconds: number;
  fetch: typeof fetch;
  onDeprecation?: (notice: DeprecationNotice) => void;
}

function isBrowserLike(): boolean {
  // `window` + `document` together is the reliable browser signal. Server
  // runtimes do not define both.
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
 * Why a base URL is not acceptable, or null when it is: an absolute https
 * URL, or http for localhost only. One rule for the client and for the
 * public key loader.
 */
export function baseUrlProblem(baseUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return 'must be an absolute URL';
  }
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    return 'must use https (http is allowed for localhost only)';
  }
  return null;
}

/**
 * Validate raw config for a product and fill defaults. Throws
 * `EnscError('ENSC_VALIDATION_FAILED')` with a clear message for anything
 * missing or malformed, failing here, at construction, rather than on the
 * first request.
 */
export function resolveClientConfig(
  product: SdkProduct,
  config: ClientConfigInput,
): ResolvedClientConfig {
  if (!config || typeof config !== 'object') {
    fail(`${product.clientName} requires a config object`);
  }

  if (!config.dangerouslyAllowBrowser && isBrowserLike()) {
    fail(
      `${product.clientName} must not run in a browser: the API key, encryption key and signing key are ` +
        'secrets and would be exposed in a client-side bundle. Use the SDK only from server-side code.',
    );
  }

  const apiKey = requireString(config.apiKey, 'apiKey');
  if (product.apiKeyPattern && !product.apiKeyPattern.test(apiKey)) {
    fail(
      `config.apiKey is not a ${product.name} API key${product.apiKeyHint ? ` (${product.apiKeyHint})` : ''}`,
    );
  }
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

  const field = product.publicKeysConfigField;
  let serverPublicKeys: Record<string, string> | undefined;
  if (config.serverPublicKeys !== undefined) {
    if (
      config.serverPublicKeys === null ||
      typeof config.serverPublicKeys !== 'object' ||
      Array.isArray(config.serverPublicKeys)
    ) {
      fail(`config.${field} must be a record of key id to base64url public key`);
    }
    const entries = Object.entries(config.serverPublicKeys);
    if (entries.length === 0) fail(`config.${field} must not be empty`);
    serverPublicKeys = {};
    for (const [kid, pk] of entries) {
      if (!kid.trim()) fail(`config.${field} contains an empty key id`);
      if (typeof pk !== 'string') fail(`config.${field}[${kid}] must be a string`);
      decodeKey(pk, `${field}[${kid}]`, 32);
      serverPublicKeys[kid] = pk;
    }
  }

  const fetchImpl = config.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    fail(
      'No fetch implementation found. Use Node 20.19+ or 22.12+, or another runtime with fetch, ' +
        'or pass config.fetch explicitly.',
    );
  }

  const baseUrl = (config.baseUrl ?? product.defaultBaseUrl).replace(/\/+$/, '');
  {
    const problem = baseUrlProblem(baseUrl);
    if (problem) fail(`config.baseUrl ${problem}`);
  }
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
  if (config.onDeprecation !== undefined && typeof config.onDeprecation !== 'function') {
    fail('config.onDeprecation must be a function');
  }

  return {
    apiKey,
    merchantId,
    encryptionKey,
    encryptionKeyId,
    signingPrivateKey,
    signingKeyId,
    ...(serverPublicKeys ? { serverPublicKeys } : {}),
    baseUrl,
    apiVersion: config.apiVersion ?? product.defaultApiVersion,
    timeoutMs,
    maxRetries,
    responseMaxSkewSeconds,
    fetch: fetchImpl,
    ...(config.onDeprecation ? { onDeprecation: config.onDeprecation } : {}),
  };
}
