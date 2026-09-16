import { ed25519 } from '@noble/curves/ed25519.js';
import { buildCanonicalString, type CanonicalRequest } from './canonical.js';
import { ENCODER, fromBase64Url } from './keypair.js';

export type VerifyError =
  | 'BAD_SIGNATURE_FORMAT'
  | 'BAD_PUBLIC_KEY'
  | 'TIMESTAMP_OUT_OF_WINDOW'
  | 'INVALID_SIGNATURE';

export interface VerifyInput extends CanonicalRequest {
  /** base64url-encoded 32-byte public key */
  publicKey: string;
  /** `ed25519={base64url}` */
  signatureHeader: string;
  /** Maximum allowed clock skew in seconds. Default 300 (5 min). */
  maxSkewSeconds?: number;
  /** Current time, seconds since epoch. Override only for testing. */
  now?: number;
}

export interface VerifyResult {
  ok: boolean;
  error?: VerifyError;
}

const SIG_PREFIX = 'ed25519=';

export function verifyRequest(input: VerifyInput): VerifyResult {
  // 1. Parse signature header
  if (!input.signatureHeader.startsWith(SIG_PREFIX)) {
    return { ok: false, error: 'BAD_SIGNATURE_FORMAT' };
  }
  let sig: Uint8Array;
  try {
    sig = fromBase64Url(input.signatureHeader.slice(SIG_PREFIX.length));
  } catch {
    return { ok: false, error: 'BAD_SIGNATURE_FORMAT' };
  }
  if (sig.length !== 64) return { ok: false, error: 'BAD_SIGNATURE_FORMAT' };

  // 2. Check timestamp window
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const skew = Math.abs(now - input.timestamp);
  const maxSkew = input.maxSkewSeconds ?? 300;
  if (skew > maxSkew) return { ok: false, error: 'TIMESTAMP_OUT_OF_WINDOW' };

  // 3. Parse public key
  let pk: Uint8Array;
  try {
    pk = fromBase64Url(input.publicKey);
  } catch {
    return { ok: false, error: 'BAD_PUBLIC_KEY' };
  }
  if (pk.length !== 32) return { ok: false, error: 'BAD_PUBLIC_KEY' };

  // 4. Reconstruct canonical and verify
  const canonical = buildCanonicalString(input);
  let valid: boolean;
  try {
    valid = ed25519.verify(sig, ENCODER.encode(canonical), pk);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, error: 'INVALID_SIGNATURE' };

  return { ok: true };
}
