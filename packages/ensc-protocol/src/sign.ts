import { ed25519 } from '@noble/curves/ed25519.js';
import { buildCanonicalString, type CanonicalRequest } from './canonical.js';
import { ENCODER, fromBase64Url, toBase64Url } from './keypair.js';

export interface SigningInput extends CanonicalRequest {
  privateKey: string; // base64url-encoded 32-byte seed
  keyId: string; // identifies which keypair was used (for rotation)
}

export interface SignedRequest {
  /** Headers to attach to the HTTP request */
  headers: {
    'X-ENSC-Timestamp': string;
    'X-ENSC-Nonce': string;
    'X-ENSC-Key-Id': string;
    'X-ENSC-Signature': string;
    'X-ENSC-Idempotency-Key'?: string;
  };
  /** The canonical string that was signed (for debugging) */
  canonical: string;
}

/**
 * Sign a request. Returns the headers the client must send.
 *
 * The signature is `ed25519={base64url(sig)}`. The prefix lets us add new signature
 * schemes (e.g. `dilithium=` for PQC) without ambiguity in the future.
 */
export function signRequest(input: SigningInput): SignedRequest {
  const canonical = buildCanonicalString(input);
  const sk = fromBase64Url(input.privateKey);
  if (sk.length !== 32) throw new Error('Invalid Ed25519 private key length');

  const sig = ed25519.sign(ENCODER.encode(canonical), sk);
  const sigB64 = toBase64Url(sig);

  const headers: SignedRequest['headers'] = {
    'X-ENSC-Timestamp': String(input.timestamp),
    'X-ENSC-Nonce': input.nonce,
    'X-ENSC-Key-Id': input.keyId,
    'X-ENSC-Signature': `ed25519=${sigB64}`,
  };
  if (input.idempotencyKey) headers['X-ENSC-Idempotency-Key'] = input.idempotencyKey;

  return { headers, canonical };
}
