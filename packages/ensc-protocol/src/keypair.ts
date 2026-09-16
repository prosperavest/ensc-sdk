/**
 * Ed25519 keypair handling for ENSC signing.
 *
 * Why @noble/curves over tweetnacl / Node crypto / Web Crypto:
 *   - tweetnacl: unmaintained, no TypeScript, awkward seed handling
 *   - Node crypto: not available in Workers / Deno / Bun-compatible code without polyfills
 *   - Web Crypto: Ed25519 support landed in browsers and Workers but not in Node <20 reliably
 *   - @noble/curves: audited, zero deps, works in every JS runtime, ~10kb
 *
 * Encoding choices:
 *   - Raw 32-byte private key (seed) - what Ed25519 actually requires
 *   - Raw 32-byte public key
 *   - We expose base64url-encoded strings for storage / transport (URL-safe, no padding)
 *
 * We do NOT use PEM/PKCS#8. That was a 2010s convention from openssl-land; for new
 * APIs in 2026, raw base64url is what every modern protocol uses (JWK, COSE, etc.).
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { randomBytes } from '@noble/hashes/utils.js';

export interface Ed25519Keypair {
  /** Raw 32-byte private key seed, base64url-encoded (no padding) */
  privateKey: string;
  /** Raw 32-byte public key, base64url-encoded (no padding) */
  publicKey: string;
}

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

export function toBase64Url(bytes: Uint8Array): string {
  // Convert to standard base64 then strip padding and translate alphabet
  let binary = '';
  // biome-ignore lint/style/noNonNullAssertion: bytes[i] indexed inside for-loop bounded by bytes.length
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  const b64 = btoa(binary);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s: string): Uint8Array {
  // Pad back to a multiple of 4, translate alphabet, decode
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function generateKeypair(): Ed25519Keypair {
  const privateKey = randomBytes(32);
  const publicKey = ed25519.getPublicKey(privateKey);
  return {
    privateKey: toBase64Url(privateKey),
    publicKey: toBase64Url(publicKey),
  };
}

/** Derive public key from private key (rare - but useful when only the private side was stored). */
export function publicKeyFromPrivate(privateKeyB64Url: string): string {
  const sk = fromBase64Url(privateKeyB64Url);
  if (sk.length !== 32) throw new Error('Invalid Ed25519 private key length');
  return toBase64Url(ed25519.getPublicKey(sk));
}

export { DECODER, ENCODER };
