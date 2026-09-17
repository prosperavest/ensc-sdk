/**
 * Request signing - a thin wrapper over `@ensc/protocol`.
 *
 * The SDK does not reimplement the signing scheme. `@ensc/protocol` is the single
 * source of truth: the same package the API uses to *verify* requests builds the
 * canonical string and Ed25519 signature here. If the scheme ever changes, both
 * sides move together and cannot drift out of compatibility.
 *
 * This module only adds the per-request ephemerals - a fresh timestamp and a
 * unique nonce - and produces the headers the transport attaches.
 */

import { signRequest, toBase64Url } from '@ensc/protocol';
import { randomBytes } from '@noble/hashes/utils.js';

/** A unique, opaque, URL-safe nonce. New value for every signed request. */
export function generateNonce(): string {
  return toBase64Url(randomBytes(18));
}

/**
 * A fresh idempotency key. Conforms to the API's idempotency key schema
 * (`^[A-Za-z0-9_-]{8,64}$`). Auto-generated for every mutating request unless the
 * caller supplies their own, so a transparently retried POST is safe server-side.
 */
export function generateIdempotencyKey(): string {
  return `idm_${toBase64Url(randomBytes(18))}`;
}

export interface SignMutationInput {
  method: string;
  /** Request path, e.g. `/v1/conversions`. Must match what the server sees. */
  path: string;
  /** Canonicalized query input - string, record, or undefined. */
  query: string | Record<string, string> | undefined;
  /** Exact request body that will be sent on the wire (the JSON string). */
  body: string | Uint8Array | undefined;
  merchantId: string;
  /** base64url-encoded Ed25519 private key seed. */
  privateKey: string;
  /** Registered signing key id - sent as `X-ENSC-Key-Id`. */
  keyId: string;
  /** Idempotency key - included in the signature and sent as a header. */
  idempotencyKey: string;
}

/** Headers a signed request must carry. */
export type SignatureHeaders = Record<string, string>;

/**
 * Sign a mutating request. Returns the `X-ENSC-*` headers (timestamp, nonce,
 * key id, signature, idempotency key) to merge into the outgoing request.
 */
export function signMutation(input: SignMutationInput): SignatureHeaders {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = generateNonce();

  const { headers } = signRequest({
    method: input.method,
    path: input.path,
    query: input.query,
    body: input.body,
    timestamp,
    nonce,
    merchantId: input.merchantId,
    idempotencyKey: input.idempotencyKey,
    privateKey: input.privateKey,
    keyId: input.keyId,
  });

  // `signRequest` returns a precisely-typed header object; widen it to a plain
  // record for the transport, dropping any undefined entries.
  const out: SignatureHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}
