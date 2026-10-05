/**
 * Inbound webhook verification, shared by every SDK.
 *
 * Every product signs its webhook deliveries with Ed25519. A receiver verifies
 * the signature before trusting the payload. This module implements *only* the
 * verification side of the delivery scheme; the canonical string format is
 * fixed by the platform:
 *
 *   ENSC-WH-V1\n{webhookId}\n{timestamp}\n{sha256Hex(body)}
 *
 * signed over the raw request body bytes. The matching headers are:
 *
 *   X-ENSC-Signature     ed25519={base64url}
 *   X-ENSC-Timestamp     unix seconds
 *   X-ENSC-Webhook-Id    per-delivery id
 *   X-ENSC-Key-Id        which webhook key signed it
 *   X-ENSC-Event-Type / X-ENSC-Event-Id / X-ENSC-API-Version
 *
 * You must pass the EXACT raw body string you received; re-serializing parsed
 * JSON will change the bytes and fail verification.
 *
 * The signed body names the merchant and the environment the event belongs
 * to (`merchantId`, `env`) and marks a test delivery (`synthetic: true`). Pass
 * your own `merchantId` and `env` to the verifier: a delivery that was signed
 * for another merchant, or for the other environment, is then refused even
 * though its signature is genuine.
 */

import { base64UrlToBytes, EnscError, fromBase64Url, sha256Hex } from '@ensc/protocol';
import { ed25519 } from '@noble/curves/ed25519.js';
import { baseUrlProblem } from './config.js';
import type { SdkProduct } from './product.js';

const WEBHOOK_CANONICAL_VERSION = 'ENSC-WH-V1';
const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * Headers as received: a `Headers` instance or a plain record. Node's
 * `IncomingHttpHeaders` shape (lower-case names, string or string[] values)
 * is accepted as is.
 */
export type WebhookHeaders = Headers | Record<string, string | string[] | undefined>;

export interface VerifyWebhookOptions {
  /** The raw request body, exactly as received (string or bytes). */
  body: string | Uint8Array;
  /** The inbound request headers. */
  headers: WebhookHeaders;
  /**
   * The product's webhook signing public key(s), base64url, from its
   * well-known document (entries whose `use` includes `webhooks`). Pass the
   * whole document's keys as `{ [kid]: publicKey }` and the verifier picks the
   * one named by `X-ENSC-Key-Id`, so a key rotation needs no redeploy; a
   * single string is accepted too. The SDK's `fetchPublicKeys` loads the map.
   */
  publicKey: string | Record<string, string>;
  /**
   * Max allowed clock skew between the delivery timestamp and now, in seconds.
   * Defaults to 300. Set `0` to disable the timestamp check. Any other value
   * that is not a finite number of zero or more (NaN, a negative number, a
   * string) is refused, never read as "off".
   */
  toleranceSeconds?: number;
  /**
   * Your merchant id (`mrc_...`). When given, the delivery must have been
   * signed for this merchant: one whose signed body names another merchant,
   * or none, is refused.
   */
  merchantId?: string;
  /**
   * The environment this receiver serves. When given, the delivery must have
   * been signed for it: a `test` delivery is refused by a `live` receiver and
   * the reverse, and so is one whose signed body names no environment.
   */
  env?: 'test' | 'live';
}

export interface WebhookVerificationResult {
  valid: boolean;
  /** When `valid` is false, a short machine-stable reason. */
  reason?:
    | 'missing_signature'
    | 'missing_timestamp'
    | 'missing_webhook_id'
    | 'bad_signature_format'
    | 'timestamp_out_of_tolerance'
    | 'invalid_tolerance'
    | 'unknown_key_id'
    | 'signature_mismatch'
    | 'merchant_mismatch'
    | 'env_mismatch';
}

/** The verified webhook event envelope a product delivers. */
export interface WebhookEvent<T = unknown> {
  id: string;
  type: string;
  apiVersion: string;
  /** The ProsperaVest product that emitted the event (`ensc`, `vaults`). Absent from deliveries before 2026-09-19. */
  product?: string;
  /** The merchant the event belongs to. Absent from deliveries before 2026-10-04. */
  merchantId?: string;
  /** The environment the event belongs to. Absent from deliveries before 2026-10-04. */
  env?: 'test' | 'live';
  /**
   * True on a delivery produced by a test request (a test delivery, a
   * synthetic Sandbox event): nothing happened behind it, so never act on it
   * as on a real event. Absent on real events.
   */
  synthetic?: boolean;
  /** Unix seconds of this delivery attempt (a retry carries a fresh value). */
  created: number;
  data: T;
}

function getHeader(headers: WebhookHeaders, name: string): string | undefined {
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  // Plain record: do a case-insensitive lookup; a repeated header is refused.
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) {
      if (Array.isArray(v)) return v.length === 1 ? v[0] : undefined;
      return v ?? undefined;
    }
  }
  return undefined;
}

function bodyToString(body: string | Uint8Array): string {
  return typeof body === 'string' ? body : new TextDecoder().decode(body);
}

function keyFor(
  publicKey: string | Record<string, string>,
  kid: string | undefined,
): string | undefined {
  if (typeof publicKey === 'string') return publicKey;
  if (!kid) return undefined;
  return Object.hasOwn(publicKey, kid) ? publicKey[kid] : undefined;
}

/**
 * Verify a webhook delivery's signature. Never throws; returns a result object.
 * Use {@link constructEvent} when you'd rather verify and parse in one step.
 */
export function verifyWebhookSignature(opts: VerifyWebhookOptions): WebhookVerificationResult {
  const signatureHeader = getHeader(opts.headers, 'X-ENSC-Signature');
  const timestampHeader = getHeader(opts.headers, 'X-ENSC-Timestamp');
  const webhookId = getHeader(opts.headers, 'X-ENSC-Webhook-Id');

  if (!signatureHeader) return { valid: false, reason: 'missing_signature' };
  if (!timestampHeader) return { valid: false, reason: 'missing_timestamp' };
  if (!webhookId) return { valid: false, reason: 'missing_webhook_id' };

  // Signature header format: `ed25519={base64url}`.
  const match = /^ed25519=(.+)$/.exec(signatureHeader.trim());
  if (!match?.[1]) return { valid: false, reason: 'bad_signature_format' };
  const sigB64 = match[1];

  // The timestamp is signed as the exact string ENSC sent: digits only.
  const timestampStr = timestampHeader.trim();
  if (!/^\d{1,12}$/.test(timestampStr)) {
    return { valid: false, reason: 'missing_timestamp' };
  }
  const timestamp = Number(timestampStr);

  // Only an explicit 0 turns the check off. A value that is not a number of
  // zero or more (NaN from an unset variable, a negative number) is refused:
  // read as "off" it would accept a captured delivery for ever.
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance < 0) {
    return { valid: false, reason: 'invalid_tolerance' };
  }
  if (tolerance > 0) {
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > tolerance) {
      return { valid: false, reason: 'timestamp_out_of_tolerance' };
    }
  }

  const publicKey = keyFor(opts.publicKey, getHeader(opts.headers, 'X-ENSC-Key-Id'));
  if (!publicKey) return { valid: false, reason: 'unknown_key_id' };

  // Hash the bytes as received; decoding and re-encoding could change them.
  const bodyHash = sha256Hex(
    typeof opts.body === 'string' ? new TextEncoder().encode(opts.body) : opts.body,
  );
  const canonical = `${WEBHOOK_CANONICAL_VERSION}\n${webhookId}\n${timestampStr}\n${bodyHash}`;

  let ok: boolean;
  try {
    ok = ed25519.verify(
      fromBase64Url(sigB64),
      new TextEncoder().encode(canonical),
      fromBase64Url(publicKey),
    );
  } catch {
    return { valid: false, reason: 'bad_signature_format' };
  }

  if (!ok) return { valid: false, reason: 'signature_mismatch' };

  // The signature is genuine. Whose event it is comes from the signed body.
  if (opts.merchantId !== undefined || opts.env !== undefined) {
    const signedFor = readSignedFor(opts.body);
    if (opts.merchantId !== undefined && signedFor.merchantId !== opts.merchantId) {
      return { valid: false, reason: 'merchant_mismatch' };
    }
    if (opts.env !== undefined && signedFor.env !== opts.env) {
      return { valid: false, reason: 'env_mismatch' };
    }
  }
  return { valid: true };
}

/** The merchant and environment a body names, each undefined when it names none. */
function readSignedFor(body: string | Uint8Array): { merchantId?: string; env?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyToString(body));
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null) return {};
  const e = parsed as Record<string, unknown>;
  return {
    ...(typeof e.merchantId === 'string' && e.merchantId ? { merchantId: e.merchantId } : {}),
    ...(typeof e.env === 'string' && e.env ? { env: e.env } : {}),
  };
}

/**
 * Verify a webhook delivery and return the parsed event. Throws
 * `EnscError('ENSC_INVALID_SIGNATURE')` if verification fails, so a handler
 * that reaches the return value can trust the payload.
 */
export function constructEvent<T = unknown>(opts: VerifyWebhookOptions): WebhookEvent<T> {
  const result = verifyWebhookSignature(opts);
  if (!result.valid) {
    throw new EnscError(
      'ENSC_INVALID_SIGNATURE',
      `Webhook signature verification failed: ${result.reason}`,
      { reason: result.reason },
    );
  }

  const bodyStr = bodyToString(opts.body);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyStr);
  } catch {
    throw new EnscError('ENSC_VALIDATION_FAILED', 'Webhook body is not valid JSON');
  }
  if (!isWebhookEvent(parsed)) {
    throw new EnscError('ENSC_VALIDATION_FAILED', 'Webhook body is not an ENSC event envelope');
  }

  return parsed as WebhookEvent<T>;
}

function isWebhookEvent(x: unknown): x is WebhookEvent {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    typeof e.type === 'string' &&
    typeof e.apiVersion === 'string' &&
    typeof e.created === 'number' &&
    'data' in e &&
    (e.merchantId === undefined || typeof e.merchantId === 'string') &&
    (e.env === undefined || e.env === 'test' || e.env === 'live') &&
    (e.synthetic === undefined || typeof e.synthetic === 'boolean')
  );
}

export interface FetchPublicKeysOptions {
  /** API base URL. Defaults to the product's production host. */
  baseUrl?: string;
  /**
   * Which keys to return: the ones the host signs webhook deliveries with
   * (`webhooks`, the default) or the ones it signs sealed responses with
   * (`responses`, for pinning in the client config).
   */
  use?: 'webhooks' | 'responses';
  /** Custom fetch, for tests or a runtime without a global one. */
  fetch?: typeof fetch;
  /** Request timeout in milliseconds. Default 10000. */
  timeoutMs?: number;
}

/**
 * Load a product's current signing keys as `{ [kid]: publicKey }` from its
 * well-known document, the webhook keys by default. Every call is one request
 * to the host: do not call it per delivery. A webhook receiver uses
 * {@link createWebhookKeyCache}, which keeps the document and bounds how
 * often an unknown key id may load it again.
 */
export async function fetchPublicKeys(
  product: SdkProduct,
  options: FetchPublicKeysOptions = {},
): Promise<Record<string, string>> {
  const base = (options.baseUrl ?? product.defaultBaseUrl).replace(/\/+$/, '');
  // The keys decide which deliveries verify: they are loaded over https only
  // (http for localhost), the rule the client applies to its base URL.
  const problem = baseUrlProblem(base);
  if (problem) throw new EnscError('ENSC_VALIDATION_FAILED', `baseUrl ${problem}`);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const name = product.name;
  const use = options.use ?? 'webhooks';
  let res: Response;
  try {
    res = await fetchImpl(`${base}${product.publicKeysPath}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      // A redirect is never followed: the answer must come from the host asked.
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch (err) {
    throw new EnscError(
      'ENSC_UPSTREAM_FAILED',
      `Could not fetch ${name} public keys: ${(err as Error).message}`,
    );
  }
  if (!res.ok) {
    throw new EnscError(
      'ENSC_UPSTREAM_FAILED',
      `Could not fetch ${name} public keys: HTTP ${res.status}`,
    );
  }
  const doc = (await res.json().catch(() => undefined)) as
    | { keys?: Array<{ kid?: unknown; alg?: unknown; publicKey?: unknown; use?: unknown }> }
    | undefined;
  if (!doc || !Array.isArray(doc.keys)) {
    throw new EnscError('ENSC_UPSTREAM_FAILED', `${name} public key document is malformed`);
  }
  const keys: Record<string, string> = {};
  for (const k of doc.keys) {
    if (
      typeof k.kid === 'string' &&
      k.alg === 'Ed25519' &&
      typeof k.publicKey === 'string' &&
      Array.isArray(k.use) &&
      k.use.includes(use) &&
      isEd25519PublicKey(k.publicKey)
    ) {
      keys[k.kid] = k.publicKey;
    }
  }
  if (Object.keys(keys).length === 0) {
    throw new EnscError(
      'ENSC_UPSTREAM_FAILED',
      `${name} public key document has no ${use === 'webhooks' ? 'webhook' : 'response-signing'} key`,
    );
  }
  return keys;
}

/** True for the base64url of exactly 32 bytes, the size of an Ed25519 public key. */
function isEd25519PublicKey(value: string): boolean {
  try {
    return base64UrlToBytes(value).length === 32;
  } catch {
    return false;
  }
}

/**
 * The shortest time between two loads of the key document by one
 * {@link WebhookKeyCache}, in milliseconds. The key id of a delivery is the
 * sender's text, so a receiver that loaded the document for every key id it
 * does not know would make one request to the host for every request anyone
 * posts to it. One load a minute is far more than a key rotation needs (a new
 * key is published before it signs) and far less than the host's limit on the
 * document.
 */
export const WEBHOOK_KEY_REFRESH_INTERVAL_MS = 60_000;

export interface WebhookKeyCacheOptions extends FetchPublicKeysOptions {
  /**
   * The shortest time between two loads of the key document, in milliseconds.
   * Default {@link WEBHOOK_KEY_REFRESH_INTERVAL_MS}. A value that is not a
   * finite number of zero or more is refused.
   */
  minRefreshIntervalMs?: number;
}

/** A product's webhook keys, kept between deliveries. */
export interface WebhookKeyCache {
  /**
   * The keys to pass to the verifier as `publicKey`. The document is loaded on
   * first use and kept. Pass the delivery's `X-ENSC-Key-Id` (or its headers):
   * when the cached keys do not hold that id the document is loaded again, at
   * most once per interval however many deliveries name unknown ids; within
   * the interval the cached keys are returned as they are and the verifier
   * refuses the delivery (`unknown_key_id`). A reload that fails keeps the
   * keys already held. Throws `ENSC_UPSTREAM_FAILED` only while no document
   * has been loaded at all; that failure, too, is retried at most once per
   * interval.
   */
  get(keyId?: string | null | WebhookHeaders): Promise<Record<string, string>>;
}

/**
 * Keep a product's webhook signing keys between deliveries. One per process:
 *
 *   const keys = createWebhookKeyCache(product);
 *   // in the handler, inside the try that answers 401:
 *   const event = constructEvent({ body, headers, publicKey: await keys.get(headers), merchantId, env });
 */
export function createWebhookKeyCache(
  product: SdkProduct,
  options: WebhookKeyCacheOptions = {},
): WebhookKeyCache {
  const { minRefreshIntervalMs, ...fetchOptions } = options;
  const interval = minRefreshIntervalMs ?? WEBHOOK_KEY_REFRESH_INTERVAL_MS;
  if (typeof interval !== 'number' || !Number.isFinite(interval) || interval < 0) {
    throw new EnscError(
      'ENSC_VALIDATION_FAILED',
      'minRefreshIntervalMs must be a number of zero or more',
    );
  }
  let keys: Record<string, string> | undefined;
  let lastLoadAt: number | undefined;
  let lastError: EnscError | undefined;
  let pending: Promise<void> | undefined;

  const load = (): Promise<void> => {
    if (!pending) {
      // Stamped when the load starts: a load that fails still spends the interval.
      lastLoadAt = Date.now();
      pending = fetchPublicKeys(product, { ...fetchOptions, use: fetchOptions.use ?? 'webhooks' })
        .then(
          (loaded) => {
            keys = loaded;
            lastError = undefined;
          },
          (err: unknown) => {
            lastError =
              err instanceof EnscError
                ? err
                : new EnscError(
                    'ENSC_UPSTREAM_FAILED',
                    `Could not fetch ${product.name} public keys`,
                  );
          },
        )
        .finally(() => {
          pending = undefined;
        });
    }
    return pending;
  };
  const mayLoad = (): boolean =>
    pending !== undefined || lastLoadAt === undefined || Date.now() - lastLoadAt >= interval;

  return {
    async get(keyId) {
      const kid =
        typeof keyId === 'string' || keyId === null || keyId === undefined
          ? (keyId ?? undefined)
          : getHeader(keyId, 'X-ENSC-Key-Id');
      const known = (held: Record<string, string>): boolean =>
        kid === undefined || Object.hasOwn(held, kid);
      if ((keys === undefined || !known(keys)) && mayLoad()) await load();
      if (keys === undefined) {
        throw (
          lastError ??
          new EnscError('ENSC_UPSTREAM_FAILED', `Could not fetch ${product.name} public keys`)
        );
      }
      return keys;
    },
  };
}
