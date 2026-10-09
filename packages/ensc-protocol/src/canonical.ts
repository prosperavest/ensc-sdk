/**
 * Canonical string construction for ENSC request signing.
 *
 * The canonical string is what gets signed and what the server reconstructs to verify.
 * It MUST be byte-for-byte identical on both sides. Any divergence (different line
 * endings, query-string ordering, body whitespace) breaks verification.
 *
 * Versioned with a prefix so the protocol can evolve without breaking old clients.
 *
 * Wire format (joined by \n):
 *
 *   ENSC-V1
 *   {METHOD}
 *   {PATH}
 *   {sha256(canonical_query_string)}
 *   {sha256(body_bytes)}
 *   {timestamp}
 *   {nonce}
 *   {merchant_id}
 *   {idempotency_key_or_empty}
 *
 * ENSC-V2 is the same string with the version line `ENSC-V2` and one more
 * line, the response nonce:
 *
 *   ENSC-V2
 *   ... the eight lines above ...
 *   {response_nonce}
 *
 * A request is ENSC-V2 exactly when it carries `X-ENSC-Response-Nonce`, the
 * value the client asks the response to be bound to (ENSC-RESP-V2, see
 * response.ts). The value is signed so that a write is never carried out for
 * a value the client did not send: its answer could not be accepted. A second
 * version, not one more line of ENSC-V1: a verifier that knows only ENSC-V1
 * rebuilds the ENSC-V1 string, so the same label must keep meaning the same
 * bytes. A request without the header is ENSC-V1, byte for byte as before.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export const CANONICAL_VERSION = 'ENSC-V1' as const;
export const CANONICAL_VERSION_V2 = 'ENSC-V2' as const;

/** The request header that carries the response nonce and asks for ENSC-RESP-V2. */
export const RESPONSE_NONCE_HEADER = 'X-ENSC-Response-Nonce' as const;

/** Random bytes in a response nonce. */
export const RESPONSE_NONCE_BYTES = 32;

/** A response nonce on the wire: 32 bytes as unpadded base64url, 43 characters. */
const RESPONSE_NONCE_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Whether `value` has the form of a response nonce. The form is fixed so that
 * the value is one line of a signed string and nothing else; how it was
 * chosen is the client's side of the protocol (fresh random bytes for every
 * request).
 */
export function isResponseNonce(value: unknown): value is string {
  return typeof value === 'string' && RESPONSE_NONCE_RE.test(value);
}

export interface CanonicalRequest {
  method: string;
  path: string;
  query: string | URLSearchParams | Record<string, string> | undefined;
  body: string | Uint8Array | undefined;
  timestamp: number;
  nonce: string;
  merchantId: string;
  idempotencyKey?: string;
  /**
   * The `X-ENSC-Response-Nonce` the request carries. Present: the string is
   * ENSC-V2 and ends with it. Absent: the string is ENSC-V1.
   */
  responseNonce?: string;
}

/**
 * Canonicalize a query string: sort keys alphabetically, URL-encode consistently.
 * Returns the empty string if no query.
 */
export function canonicalQuery(
  query: string | URLSearchParams | Record<string, string> | undefined,
): string {
  if (!query) return '';

  let params: URLSearchParams;
  if (typeof query === 'string') {
    params = new URLSearchParams(query);
  } else if (query instanceof URLSearchParams) {
    params = new URLSearchParams(query);
  } else {
    params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) params.set(k, v);
  }

  // URLSearchParams.keys() yields one entry PER value, not one per unique key -
  // for input "x=2&x=1&x=3" it returns ["x","x","x"]. Dedupe so we don't emit
  // each value's list once per duplicate key.
  const keys = [...new Set(params.keys())].sort();
  const out = new URLSearchParams();
  for (const k of keys) {
    const values = params.getAll(k).sort();
    for (const v of values) out.append(k, v);
  }
  return out.toString();
}

function toBytes(s: string | Uint8Array | undefined): Uint8Array {
  if (s === undefined) return new Uint8Array(0);
  if (s instanceof Uint8Array) return s;
  return new TextEncoder().encode(s);
}

export function sha256Hex(input: string | Uint8Array): string {
  return bytesToHex(sha256(toBytes(input)));
}

/**
 * Build the canonical string. This is what both the signer and the verifier must produce.
 *
 * The body is hashed as-is; whatever bytes the client signs MUST be the exact bytes
 * the server reads from the request body. No JSON re-canonicalization - the wire
 * bytes are the source of truth.
 *
 * With a `responseNonce` the string is ENSC-V2; a value that does not have the
 * form of one is refused here, so no other text ever becomes a signed line.
 */
export function buildCanonicalString(req: CanonicalRequest): string {
  const method = req.method.toUpperCase();
  const path = req.path;
  const queryHash = sha256Hex(canonicalQuery(req.query));
  const bodyHash = sha256Hex(req.body ?? '');

  const lines = [
    method,
    path,
    queryHash,
    bodyHash,
    String(req.timestamp),
    req.nonce,
    req.merchantId,
    req.idempotencyKey ?? '',
  ];
  if (req.responseNonce === undefined) return [CANONICAL_VERSION, ...lines].join('\n');
  if (!isResponseNonce(req.responseNonce)) throw new Error('Invalid response nonce');
  return [CANONICAL_VERSION_V2, ...lines, req.responseNonce].join('\n');
}
