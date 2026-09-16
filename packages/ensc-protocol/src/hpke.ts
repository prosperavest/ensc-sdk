/**
 * ENSC-RESP-V1: sealed responses, built on HPKE (RFC 9180) base mode.
 *
 * Suite: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20-Poly1305
 *        kem_id 0x0020, kdf_id 0x0001, aead_id 0x0003
 *
 * The API seals the JSON body of every successful merchant-key response to
 * the merchant's public key. Only the merchant's private key can open it; the
 * server holds no key that can. The merchant's registered Ed25519 signing key
 * doubles as the recipient key through the standard Edwards-to-Montgomery
 * conversion (the same map libsodium exposes as
 * crypto_sign_ed25519_pk_to_curve25519), so a merchant keeps one keypair.
 *
 * This file composes the RFC 9180 construction from audited primitives in
 * @noble/curves, @noble/hashes and @noble/ciphers. It contains no cipher code.
 * It is verified against the RFC 9180 Appendix A.2 test vectors in
 * tests/hpke.test.ts.
 *
 * Wire shape of a sealed response body:
 *
 *   { "v": 1, "enc": "<base64url, 32 bytes>", "ciphertext": "<base64url>" }
 *
 * info = "ENSC-RESP-V1\n{requestId}" binds the ciphertext to one request.
 */

import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { expand, extract } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToUtf8,
  concatBytes,
  utf8ToBytes,
} from './encoding.js';

export const HPKE_KEM_ID = 0x0020;
export const HPKE_KDF_ID = 0x0001;
export const HPKE_AEAD_ID = 0x0003;

const N_SECRET = 32;
const N_SK = 32;
const N_PK = 32;
const N_K = 32;
const N_N = 12;
const N_T = 16;
const MODE_BASE = 0x00;

const HPKE_V1 = utf8ToBytes('HPKE-v1');
const EMPTY = new Uint8Array(0);

export const SEALED_VERSION = 1 as const;
export const SEALED_INFO_VERSION = 'ENSC-RESP-V1' as const;

export interface SealedEnvelope {
  v: typeof SEALED_VERSION;
  enc: string;
  ciphertext: string;
}

export type HpkeErrorCode = 'BAD_KEY' | 'MALFORMED' | 'OPEN_FAILED';

export class HpkeError extends Error {
  readonly code: HpkeErrorCode;
  constructor(code: HpkeErrorCode, message: string) {
    super(message);
    this.name = 'HpkeError';
    this.code = code;
  }
}

function i2osp2(n: number): Uint8Array {
  return new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
}

const KEM_SUITE_ID = concatBytes(utf8ToBytes('KEM'), i2osp2(HPKE_KEM_ID));
const HPKE_SUITE_ID = concatBytes(
  utf8ToBytes('HPKE'),
  i2osp2(HPKE_KEM_ID),
  i2osp2(HPKE_KDF_ID),
  i2osp2(HPKE_AEAD_ID),
);

function labeledExtract(
  suiteId: Uint8Array,
  salt: Uint8Array,
  label: string,
  ikm: Uint8Array,
): Uint8Array {
  const labeledIkm = concatBytes(HPKE_V1, suiteId, utf8ToBytes(label), ikm);
  return extract(sha256, labeledIkm, salt);
}

function labeledExpand(
  suiteId: Uint8Array,
  prk: Uint8Array,
  label: string,
  info: Uint8Array,
  length: number,
): Uint8Array {
  const labeledInfo = concatBytes(i2osp2(length), HPKE_V1, suiteId, utf8ToBytes(label), info);
  return expand(sha256, prk, labeledInfo, length);
}

export interface X25519KeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

/** RFC 9180 section 7.1.3 DeriveKeyPair for DHKEM(X25519). */
export function deriveKeyPair(ikm: Uint8Array): X25519KeyPair {
  const dkpPrk = labeledExtract(KEM_SUITE_ID, EMPTY, 'dkp_prk', ikm);
  const sk = labeledExpand(KEM_SUITE_ID, dkpPrk, 'sk', EMPTY, N_SK);
  return { privateKey: sk, publicKey: x25519.getPublicKey(sk) };
}

export function generateX25519KeyPair(): X25519KeyPair {
  return deriveKeyPair(randomBytes(32));
}

function assertLen(b: Uint8Array, n: number, what: string): void {
  if (b.length !== n) throw new HpkeError('BAD_KEY', `${what} must be ${n} bytes`);
}

function dh(sk: Uint8Array, pk: Uint8Array): Uint8Array {
  const out = x25519.getSharedSecret(sk, pk);
  let acc = 0;
  for (const byte of out) acc |= byte;
  if (acc === 0) throw new HpkeError('BAD_KEY', 'X25519 shared secret is all zero');
  return out;
}

function extractAndExpand(dhOut: Uint8Array, kemContext: Uint8Array): Uint8Array {
  const eaePrk = labeledExtract(KEM_SUITE_ID, EMPTY, 'eae_prk', dhOut);
  return labeledExpand(KEM_SUITE_ID, eaePrk, 'shared_secret', kemContext, N_SECRET);
}

function encap(
  pkR: Uint8Array,
  ephemeral: X25519KeyPair,
): { sharedSecret: Uint8Array; enc: Uint8Array } {
  const dhOut = dh(ephemeral.privateKey, pkR);
  const enc = ephemeral.publicKey;
  const kemContext = concatBytes(enc, pkR);
  return { sharedSecret: extractAndExpand(dhOut, kemContext), enc };
}

function decap(enc: Uint8Array, skR: Uint8Array): Uint8Array {
  const pkR = x25519.getPublicKey(skR);
  const dhOut = dh(skR, enc);
  const kemContext = concatBytes(enc, pkR);
  return extractAndExpand(dhOut, kemContext);
}

interface KeyScheduleOut {
  key: Uint8Array;
  baseNonce: Uint8Array;
}

/** RFC 9180 section 5.1 KeySchedule, mode_base, no PSK. */
function keySchedule(sharedSecret: Uint8Array, info: Uint8Array): KeyScheduleOut {
  const pskIdHash = labeledExtract(HPKE_SUITE_ID, EMPTY, 'psk_id_hash', EMPTY);
  const infoHash = labeledExtract(HPKE_SUITE_ID, EMPTY, 'info_hash', info);
  const keyScheduleContext = concatBytes(new Uint8Array([MODE_BASE]), pskIdHash, infoHash);
  const secret = labeledExtract(HPKE_SUITE_ID, sharedSecret, 'secret', EMPTY);
  const key = labeledExpand(HPKE_SUITE_ID, secret, 'key', keyScheduleContext, N_K);
  const baseNonce = labeledExpand(HPKE_SUITE_ID, secret, 'base_nonce', keyScheduleContext, N_N);
  return { key, baseNonce };
}

export interface SealInput {
  /** Recipient X25519 public key, 32 bytes. */
  recipientPublicKey: Uint8Array;
  info: Uint8Array;
  aad: Uint8Array;
  plaintext: Uint8Array;
  /** Test hook only: deterministic ephemeral key. Production callers leave this unset. */
  ephemeral?: X25519KeyPair;
}

export interface SealOutput {
  enc: Uint8Array;
  ciphertext: Uint8Array;
}

/** Single-shot HPKE seal (sequence number 0). */
export function hpkeSeal(input: SealInput): SealOutput {
  assertLen(input.recipientPublicKey, N_PK, 'recipient public key');
  const ephemeral = input.ephemeral ?? generateX25519KeyPair();
  const { sharedSecret, enc } = encap(input.recipientPublicKey, ephemeral);
  const { key, baseNonce } = keySchedule(sharedSecret, input.info);
  const ciphertext = chacha20poly1305(key, baseNonce, input.aad).encrypt(input.plaintext);
  return { enc, ciphertext };
}

export interface OpenInput {
  /** Recipient X25519 private key, 32 bytes. */
  recipientPrivateKey: Uint8Array;
  enc: Uint8Array;
  info: Uint8Array;
  aad: Uint8Array;
  ciphertext: Uint8Array;
}

/** Single-shot HPKE open. Throws HpkeError('OPEN_FAILED') on any authentication failure. */
export function hpkeOpen(input: OpenInput): Uint8Array {
  assertLen(input.recipientPrivateKey, N_SK, 'recipient private key');
  if (input.enc.length !== N_PK) throw new HpkeError('MALFORMED', 'enc must be 32 bytes');
  if (input.ciphertext.length < N_T) throw new HpkeError('MALFORMED', 'ciphertext too short');
  let sharedSecret: Uint8Array;
  try {
    sharedSecret = decap(input.enc, input.recipientPrivateKey);
  } catch {
    throw new HpkeError('OPEN_FAILED', 'HPKE decapsulation failed');
  }
  const { key, baseNonce } = keySchedule(sharedSecret, input.info);
  try {
    return chacha20poly1305(key, baseNonce, input.aad).decrypt(input.ciphertext);
  } catch {
    throw new HpkeError('OPEN_FAILED', 'HPKE authentication failed');
  }
}

// ─── Ed25519 key reuse ────────────────────────────────────────────────────

/** Convert a 32-byte Ed25519 public key to its X25519 (Montgomery) form. */
export function ed25519PublicKeyToX25519(edPublicKey: Uint8Array): Uint8Array {
  assertLen(edPublicKey, 32, 'Ed25519 public key');
  try {
    return ed25519.utils.toMontgomery(edPublicKey);
  } catch {
    throw new HpkeError('BAD_KEY', 'Ed25519 public key is not a valid curve point');
  }
}

/** Convert a 32-byte Ed25519 private seed to an X25519 private scalar. */
export function ed25519PrivateKeyToX25519(edSeed: Uint8Array): Uint8Array {
  assertLen(edSeed, 32, 'Ed25519 private key');
  return ed25519.utils.toMontgomerySecret(edSeed);
}

// ─── ENSC-RESP-V1 convenience layer ───────────────────────────────────────

export function buildResponseInfo(requestId: string): Uint8Array<ArrayBuffer> {
  return utf8ToBytes(`${SEALED_INFO_VERSION}\n${requestId}`);
}

export interface SealResponseInput {
  /** Merchant's Ed25519 public key (base64url, 32 bytes) as registered with the API. */
  recipientEd25519PublicKey: string;
  requestId: string;
  /** JSON string of the plaintext response body. */
  body: string;
  ephemeral?: X25519KeyPair;
}

export function sealResponse(input: SealResponseInput): SealedEnvelope {
  let edPk: Uint8Array;
  try {
    edPk = base64UrlToBytes(input.recipientEd25519PublicKey);
  } catch {
    throw new HpkeError('BAD_KEY', 'Recipient public key is not valid base64url');
  }
  const pkR = ed25519PublicKeyToX25519(edPk);
  const { enc, ciphertext } = hpkeSeal({
    recipientPublicKey: pkR,
    info: buildResponseInfo(input.requestId),
    aad: EMPTY,
    plaintext: utf8ToBytes(input.body),
    ...(input.ephemeral ? { ephemeral: input.ephemeral } : {}),
  });
  return {
    v: SEALED_VERSION,
    enc: bytesToBase64Url(enc),
    ciphertext: bytesToBase64Url(ciphertext),
  };
}

export interface OpenResponseInput {
  /** Merchant's Ed25519 private key seed (base64url, 32 bytes). */
  recipientEd25519PrivateKey: string;
  requestId: string;
  envelope: SealedEnvelope;
}

/** Structural check for a sealed response body. */
export function parseSealedEnvelope(value: unknown): SealedEnvelope | null {
  if (typeof value !== 'object' || value === null) return null;
  const o = value as Record<string, unknown>;
  if (o.v !== SEALED_VERSION) return null;
  if (typeof o.enc !== 'string' || o.enc.length !== 43) return null;
  if (typeof o.ciphertext !== 'string' || o.ciphertext.length === 0) return null;
  if (Object.keys(o).length !== 3) return null;
  return { v: SEALED_VERSION, enc: o.enc, ciphertext: o.ciphertext };
}

/** Open a sealed response and return the plaintext JSON string. */
export function openResponse(input: OpenResponseInput): string {
  let seed: Uint8Array;
  let enc: Uint8Array;
  let ct: Uint8Array;
  try {
    seed = base64UrlToBytes(input.recipientEd25519PrivateKey);
  } catch {
    throw new HpkeError('BAD_KEY', 'Recipient private key is not valid base64url');
  }
  try {
    enc = base64UrlToBytes(input.envelope.enc);
    ct = base64UrlToBytes(input.envelope.ciphertext);
  } catch {
    throw new HpkeError('MALFORMED', 'Sealed envelope fields are not valid base64url');
  }
  const skR = ed25519PrivateKeyToX25519(seed);
  const pt = hpkeOpen({
    recipientPrivateKey: skR,
    enc,
    info: buildResponseInfo(input.requestId),
    aad: EMPTY,
    ciphertext: ct,
  });
  return bytesToUtf8(pt);
}
