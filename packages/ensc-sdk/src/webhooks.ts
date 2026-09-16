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

const WEBHOOK_CANONICAL_VERSION = 'ENSC-WH-V1';
const DEFAULT_TOLERANCE_SECONDS = 300;

/** Headers as received - a `Headers` instance or a plain (case-insensitive) record. */
export type WebhookHeaders = Headers | Record<string, string | undefined>;

export interface VerifyWebhookOptions {
  /** The raw request body, exactly as received (string or bytes). */
  body: string | Uint8Array;
  /** The inbound request headers. */
  headers: WebhookHeaders;
  /**
   * ENSC's webhook signing public key (base64url). Obtain it out-of-band from
   * ENSC; the `X-ENSC-Key-Id` header tells you which key signed a given delivery.
   */
  publicKey: string;
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
    | 'signature_mismatch';
}

/** The verified webhook event envelope ENSC delivers. */
export interface WebhookEvent<T = unknown> {
  id: string;
  type: string;
  apiVersion: string;
  /** Unix seconds the event was created. */
  created: number;
  data: T;
}

function getHeader(headers: WebhookHeaders, name: string): string | undefined {
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  // Plain record - do a case-insensitive lookup.
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v ?? undefined;
  }
  return undefined;
}

function bodyToString(body: string | Uint8Array): string {
  return typeof body === 'string' ? body : new TextDecoder().decode(body);
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

  const timestamp = Number.parseInt(timestampHeader, 10);
  if (!Number.isFinite(timestamp)) {
    return { valid: false, reason: 'missing_timestamp' };
  }

  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (tolerance > 0) {
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > tolerance) {
      return { valid: false, reason: 'timestamp_out_of_tolerance' };
    }
  }

  const bodyStr = bodyToString(opts.body);
  const bodyHash = sha256Hex(bodyStr);
  const canonical = `${WEBHOOK_CANONICAL_VERSION}\n${webhookId}\n${timestamp}\n${bodyHash}`;

  let ok: boolean;
  try {
    ok = ed25519.verify(
      fromBase64Url(sigB64),
      new TextEncoder().encode(canonical),
      fromBase64Url(opts.publicKey),
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

  return parsed as WebhookEvent<T>;
}
