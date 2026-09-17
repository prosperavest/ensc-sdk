/**
 * Inbound webhook verification.
 *
 * ENSC signs every webhook delivery with Ed25519. A receiver verifies the
 * signature before trusting the payload. This module reimplements *only* the
 * verification side of the delivery scheme - the canonical string format is
 * fixed by the platform:
 *
 *   ENSC-WH-V1\n{webhookId}\n{timestamp}\n{sha256Hex(body)}
 *
 * signed over the raw request body bytes. The matching headers are:
 *
 *   X-ENSC-Signature     ed25519={base64url}
 *   X-ENSC-Timestamp     unix seconds
 *   X-ENSC-Webhook-Id    per-delivery id
 *   X-ENSC-Key-Id        which ENSC webhook key signed it
 *   X-ENSC-Event-Type / X-ENSC-Event-Id / X-ENSC-API-Version
 *
 * You must pass the EXACT raw body string you received - re-serializing parsed
 * JSON will change the bytes and fail verification.
 */

import { EnscError, fromBase64Url, sha256Hex } from '@ensc/protocol';
import { ed25519 } from '@noble/curves/ed25519.js';
import { DEFAULT_BASE_URL, PUBLIC_KEYS_PATH } from './config.js';

const WEBHOOK_CANONICAL_VERSION = 'ENSC-WH-V1';
const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * Headers as received - a `Headers` instance or a plain record. Node's
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
   * ENSC's webhook signing public key(s), base64url, from
   * `GET /v1/.well-known/ensc-public-keys.json` (entries whose `use` includes
   * `webhooks`). Pass the whole document's keys as `{ [kid]: publicKey }` and
   * the verifier picks the one named by `X-ENSC-Key-Id`, so a key rotation
   * needs no redeploy; a single string is accepted too. `fetchEnscPublicKeys`
   * loads the map for you.
   */
  publicKey: string | Record<string, string>;
  /**
   * Max allowed clock skew between the delivery timestamp and now, in seconds.
   * Defaults to 300. Set `0` to disable the timestamp check.
   */
  toleranceSeconds?: number;
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
    | 'unknown_key_id'
    | 'signature_mismatch';
}

/** The verified webhook event envelope ENSC delivers. */
export interface WebhookEvent<T = unknown> {
  id: string;
  type: string;
  apiVersion: string;
  /** Unix seconds of this delivery attempt (a retry carries a fresh value). */
  created: number;
  data: T;
}

function getHeader(headers: WebhookHeaders, name: string): string | undefined {
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  // Plain record - do a case-insensitive lookup; a repeated header is refused.
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
 * Verify a webhook delivery's signature. Never throws - returns a result object.
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

  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
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

  return ok ? { valid: true } : { valid: false, reason: 'signature_mismatch' };
}

/**
 * Verify a webhook delivery and return the parsed event. Throws
 * `EnscError('ENSC_INVALID_SIGNATURE')` if verification fails - so a handler
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
    'data' in e
  );
}

export interface FetchPublicKeysOptions {
  /** ENSC API base URL. Defaults to the production API. */
  baseUrl?: string;
  /** Custom fetch, for tests or proxies. */
  fetch?: typeof fetch;
  /** Request timeout in milliseconds. Default 10000. */
  timeoutMs?: number;
}

/**
 * Load ENSC's current webhook signing keys as `{ [kid]: publicKey }` from
 * `GET /v1/.well-known/ensc-public-keys.json`. Cache the result; refetch when
 * a delivery names a key id you do not have.
 */
export async function fetchEnscPublicKeys(
  options: FetchPublicKeysOptions = {},
): Promise<Record<string, string>> {
  const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? globalThis.fetch;
  let res: Response;
  try {
    res = await fetchImpl(`${base}${PUBLIC_KEYS_PATH}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch (err) {
    throw new EnscError(
      'ENSC_UPSTREAM_FAILED',
      `Could not fetch ENSC public keys: ${(err as Error).message}`,
    );
  }
  if (!res.ok) {
    throw new EnscError(
      'ENSC_UPSTREAM_FAILED',
      `Could not fetch ENSC public keys: HTTP ${res.status}`,
    );
  }
  const doc = (await res.json().catch(() => undefined)) as
    | { keys?: Array<{ kid?: unknown; alg?: unknown; publicKey?: unknown; use?: unknown }> }
    | undefined;
  if (!doc || !Array.isArray(doc.keys)) {
    throw new EnscError('ENSC_UPSTREAM_FAILED', 'ENSC public key document is malformed');
  }
  const keys: Record<string, string> = {};
  for (const k of doc.keys) {
    if (
      typeof k.kid === 'string' &&
      k.alg === 'Ed25519' &&
      typeof k.publicKey === 'string' &&
      Array.isArray(k.use) &&
      k.use.includes('webhooks')
    ) {
      keys[k.kid] = k.publicKey;
    }
  }
  if (Object.keys(keys).length === 0) {
    throw new EnscError('ENSC_UPSTREAM_FAILED', 'ENSC public key document has no webhook key');
  }
  return keys;
}
