/**
 * ENSC-ENC-V1: the encrypted request envelope.
 *
 * Every mutating request from a merchant key carries its JSON body encrypted
 * with AES-256-GCM under the merchant's request-encryption key. The wire shape:
 *
 *   {
 *     "v": 1,
 *     "encKeyId": "enc_01HXY...",   // which merchant encryption key was used
 *     "iv": "<base64url, 12 bytes>",
 *     "ciphertext": "<base64url>",
 *     "tag": "<base64url, 16 bytes>"
 *   }
 *
 * The GCM additional authenticated data (AAD) binds the ciphertext to the
 * request it was made for:
 *
 *   ENSC-ENC-V1 \n METHOD \n path \n merchantId \n encKeyId
 *
 * so a captured envelope cannot be replayed against another endpoint, another
 * merchant, or after a key rotation. The Ed25519 request signature is computed
 * over the envelope bytes (encrypt-then-sign); replay protection (timestamp
 * plus nonce) stays in the signature layer.
 *
 * Primitives: Web Crypto AES-GCM (edge workers, Node 20.19+, Bun, Deno).
 * No cipher code lives in this file; it only frames the standard AEAD.
 */

import { base64UrlToBytes, bytesToBase64Url, utf8ToBytes } from './encoding.js';

export const ENVELOPE_VERSION = 1 as const;
export const ENVELOPE_AAD_VERSION = 'ENSC-ENC-V1' as const;

export const ENVELOPE_IV_BYTES = 12;
export const ENVELOPE_TAG_BYTES = 16;
export const ENCRYPTION_KEY_BYTES = 32;

/** Upper bound on the plaintext we will decrypt (matches the API body limit). */
export const ENVELOPE_MAX_CIPHERTEXT_BYTES = 1_048_576;

export interface EncryptedEnvelope {
  v: typeof ENVELOPE_VERSION;
  encKeyId: string;
  iv: string;
  ciphertext: string;
  tag: string;
}

export type EnvelopeErrorCode = 'MALFORMED' | 'BAD_KEY' | 'DECRYPT_FAILED' | 'TOO_LARGE';

export class EnvelopeError extends Error {
  readonly code: EnvelopeErrorCode;
  constructor(code: EnvelopeErrorCode, message: string) {
    super(message);
    this.name = 'EnvelopeError';
    this.code = code;
  }
}

export interface RequestAadInput {
  method: string;
  path: string;
  merchantId: string;
  encKeyId: string;
}

/** Build the AAD bytes for a request envelope. Method is upper-cased. */
export function buildRequestAad(input: RequestAadInput): Uint8Array<ArrayBuffer> {
  return utf8ToBytes(
    [
      ENVELOPE_AAD_VERSION,
      input.method.toUpperCase(),
      input.path,
      input.merchantId,
      input.encKeyId,
    ].join('\n'),
  );
}

const ENC_KEY_ID_RE = /^enc_[0-9A-Z]{26}$/;

/**
 * Structural check for an envelope. Returns null if the value is not an
 * envelope. Field lengths are checked here so a malformed value never reaches
 * the cipher.
 */
export function parseEnvelope(value: unknown): EncryptedEnvelope | null {
  if (typeof value !== 'object' || value === null) return null;
  const o = value as Record<string, unknown>;
  if (o.v !== ENVELOPE_VERSION) return null;
  if (typeof o.encKeyId !== 'string' || !ENC_KEY_ID_RE.test(o.encKeyId)) return null;
  if (typeof o.iv !== 'string' || typeof o.ciphertext !== 'string' || typeof o.tag !== 'string') {
    return null;
  }
  // 12 bytes -> 16 chars, 16 bytes -> 22 chars in unpadded base64url.
  if (o.iv.length !== 16 || o.tag.length !== 22) return null;
  if (o.ciphertext.length === 0) return null;
  const keys = Object.keys(o);
  if (keys.length !== 5) return null;
  return {
    v: ENVELOPE_VERSION,
    encKeyId: o.encKeyId,
    iv: o.iv,
    ciphertext: o.ciphertext,
    tag: o.tag,
  };
}

/** 32 random bytes for a new merchant request-encryption key. */
export function generateEncryptionKey(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(new ArrayBuffer(ENCRYPTION_KEY_BYTES)));
}

async function importAesKey(raw: Uint8Array, usage: KeyUsage[]): Promise<CryptoKey> {
  if (raw.length !== ENCRYPTION_KEY_BYTES) {
    throw new EnvelopeError('BAD_KEY', `Encryption key must be ${ENCRYPTION_KEY_BYTES} bytes`);
  }
  const copy = new Uint8Array(new ArrayBuffer(raw.length));
  copy.set(raw);
  return crypto.subtle.importKey('raw', copy, { name: 'AES-GCM' }, false, usage);
}

export interface EncryptEnvelopeInput {
  /** Raw 32-byte merchant encryption key. */
  key: Uint8Array;
  encKeyId: string;
  plaintext: Uint8Array | string;
  aad: Uint8Array;
  /** Test hook only. Production callers must leave this unset. */
  iv?: Uint8Array;
}

export async function encryptEnvelope(input: EncryptEnvelopeInput): Promise<EncryptedEnvelope> {
  if (!ENC_KEY_ID_RE.test(input.encKeyId)) {
    throw new EnvelopeError('MALFORMED', 'encKeyId is not a valid key id');
  }
  const key = await importAesKey(input.key, ['encrypt']);
  const iv = input.iv ?? crypto.getRandomValues(new Uint8Array(new ArrayBuffer(ENVELOPE_IV_BYTES)));
  if (iv.length !== ENVELOPE_IV_BYTES) {
    throw new EnvelopeError('MALFORMED', `IV must be ${ENVELOPE_IV_BYTES} bytes`);
  }
  const pt = typeof input.plaintext === 'string' ? utf8ToBytes(input.plaintext) : input.plaintext;
  const ptCopy = new Uint8Array(new ArrayBuffer(pt.length));
  ptCopy.set(pt);
  const aadCopy = new Uint8Array(new ArrayBuffer(input.aad.length));
  aadCopy.set(input.aad);
  const ivCopy = new Uint8Array(new ArrayBuffer(iv.length));
  ivCopy.set(iv);

  const out = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: ivCopy, additionalData: aadCopy, tagLength: ENVELOPE_TAG_BYTES * 8 },
      key,
      ptCopy,
    ),
  );
  const ct = out.slice(0, out.length - ENVELOPE_TAG_BYTES);
  const tag = out.slice(out.length - ENVELOPE_TAG_BYTES);
  return {
    v: ENVELOPE_VERSION,
    encKeyId: input.encKeyId,
    iv: bytesToBase64Url(ivCopy),
    ciphertext: bytesToBase64Url(ct),
    tag: bytesToBase64Url(tag),
  };
}

export interface DecryptEnvelopeInput {
  key: Uint8Array;
  envelope: EncryptedEnvelope;
  aad: Uint8Array;
}

/**
 * Decrypt and authenticate an envelope. Throws EnvelopeError:
 *   MALFORMED       a field is not valid base64url or has the wrong length
 *   TOO_LARGE       ciphertext exceeds ENVELOPE_MAX_CIPHERTEXT_BYTES
 *   BAD_KEY         key is not 32 bytes
 *   DECRYPT_FAILED  tag check failed (wrong key, tampered data, or AAD mismatch)
 */
export async function decryptEnvelope(
  input: DecryptEnvelopeInput,
): Promise<Uint8Array<ArrayBuffer>> {
  let iv: Uint8Array<ArrayBuffer>;
  let ct: Uint8Array<ArrayBuffer>;
  let tag: Uint8Array<ArrayBuffer>;
  try {
    iv = base64UrlToBytes(input.envelope.iv);
    ct = base64UrlToBytes(input.envelope.ciphertext);
    tag = base64UrlToBytes(input.envelope.tag);
  } catch {
    throw new EnvelopeError('MALFORMED', 'Envelope fields are not valid base64url');
  }
  if (iv.length !== ENVELOPE_IV_BYTES || tag.length !== ENVELOPE_TAG_BYTES) {
    throw new EnvelopeError('MALFORMED', 'Envelope iv or tag has the wrong length');
  }
  if (ct.length > ENVELOPE_MAX_CIPHERTEXT_BYTES) {
    throw new EnvelopeError('TOO_LARGE', 'Envelope ciphertext exceeds the size limit');
  }
  const key = await importAesKey(input.key, ['decrypt']);
  const joined = new Uint8Array(new ArrayBuffer(ct.length + tag.length));
  joined.set(ct, 0);
  joined.set(tag, ct.length);
  const aadCopy = new Uint8Array(new ArrayBuffer(input.aad.length));
  aadCopy.set(input.aad);
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: aadCopy, tagLength: ENVELOPE_TAG_BYTES * 8 },
      key,
      joined,
    );
    return new Uint8Array(pt);
  } catch {
    throw new EnvelopeError('DECRYPT_FAILED', 'Envelope authentication failed');
  }
}
