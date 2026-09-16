/**
 * The ENSC wire protocol, as clients and services both speak it.
 *
 * Client-safe by construction: this package is published as source with the
 * SDK, so it must never contain server-only code, credentials, endpoints
 * beyond the public API, or contract data.
 */

export {
  buildCanonicalString,
  CANONICAL_VERSION,
  type CanonicalRequest,
  canonicalQuery,
  sha256Hex,
} from './canonical.js';
export * from './encoding.js';
export * from './envelope.js';
export * from './errors.js';
export * from './hpke.js';
export {
  type Ed25519Keypair,
  fromBase64Url,
  generateKeypair,
  publicKeyFromPrivate,
  toBase64Url,
} from './keypair.js';
export { type SignedRequest, type SigningInput, signRequest } from './sign.js';
export { type VerifyError, type VerifyInput, type VerifyResult, verifyRequest } from './verify.js';
export * from './version.js';
