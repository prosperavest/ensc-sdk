/**
 * Strict base64url (RFC 4648 section 5, no padding) helpers.
 *
 * These are used for every binary value that crosses the wire in the
 * encryption layer (IVs, ciphertexts, tags, public keys). They are strict on
 * purpose: decoding rejects any character outside the base64url alphabet and
 * any padding, so a malformed value fails before it reaches a cipher.
 */

const B64URL_RE = /^[A-Za-z0-9_-]*$/;

export function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] ?? 0);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decode strict base64url. Throws on invalid characters, padding, or a length
 * that cannot be a valid encoding (length mod 4 === 1).
 */
export function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
  if (!B64URL_RE.test(s) || s.length % 4 === 1) {
    throw new Error('Invalid base64url input');
  }
  const pad = (4 - (s.length % 4)) % 4;
  const b64 = (s + '='.repeat(pad)).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function utf8ToBytes(s: string): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder().encode(s);
  const buf = new ArrayBuffer(enc.length);
  const out = new Uint8Array(buf);
  out.set(enc);
  return out;
}

export function bytesToUtf8(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(new ArrayBuffer(len));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Constant-time byte equality. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
