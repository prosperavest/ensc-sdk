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
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export const CANONICAL_VERSION = 'ENSC-V1' as const;

export interface CanonicalRequest {
  method: string;
  path: string;
  query: string | URLSearchParams | Record<string, string> | undefined;
  body: string | Uint8Array | undefined;
  timestamp: number;
  nonce: string;
  merchantId: string;
  idempotencyKey?: string;
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
 */
export function buildCanonicalString(req: CanonicalRequest): string {
  const method = req.method.toUpperCase();
  const path = req.path;
  const queryHash = sha256Hex(canonicalQuery(req.query));
  const bodyHash = sha256Hex(req.body ?? '');

  return [
    CANONICAL_VERSION,
    method,
    path,
    queryHash,
    bodyHash,
    String(req.timestamp),
    req.nonce,
    req.merchantId,
    req.idempotencyKey ?? '',
  ].join('\n');
}
