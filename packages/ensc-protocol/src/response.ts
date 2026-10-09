/**
 * ENSC-RESP-V2: a sealed response bound to the request it answers.
 *
 * ENSC-RESP-V1 (hpke.ts) proves that a response was sealed and signed by the
 * host and that it is recent. Everything it names was chosen by the host (the
 * request id, the timestamp), so it does not prove which request the response
 * answers. ENSC-RESP-V2 adds that proof. The client sends a fresh random value
 * with every request, `X-ENSC-Response-Nonce`; a host that sees the header
 * answers in V2 and puts six lines into both the string it signs and the HPKE
 * info the body is sealed under: the method, path and query of the request,
 * the value, the merchant the request was served for and the id of the
 * signing key the body is sealed to.
 *
 *   signed string   ENSC-RESP-V2 \n requestId \n timestamp \n METHOD \n path \n
 *                   sha256(canonical query) \n responseNonce \n merchantId \n
 *                   recipientKeyId \n sha256(body)
 *   HPKE info       ENSC-RESP-V2 \n requestId \n METHOD \n path \n
 *                   sha256(canonical query) \n responseNonce \n merchantId \n
 *                   recipientKeyId
 *   body            { "v": 2, "enc": "<base64url, 32 bytes>", "ciphertext": "<base64url>" }
 *
 * The client rebuilds both from what it sent and from its own configuration,
 * never from what the response says, so a response made for another request,
 * or for another merchant, neither verifies nor opens.
 *
 * Why the method, path and query are there as well as the value: a read is
 * not signed, so the value alone would tie a response to whoever repeats the
 * value on a request of their own. With the request named, the only response
 * that carries a client's value is one made for the request that client sent.
 * On a write the value is also a line of the request signature (ENSC-V2,
 * canonical.ts), which covers the body.
 *
 * Why the merchant and the key id are there: the request alone does not say
 * who asked. Another merchant can repeat a read word for word, nonce included,
 * under its own API key, and the host would sign the answer to that. The key
 * the body is sealed to does not tell the two apart either: a public key is
 * not exclusive to one merchant, and more than one registered text can stand
 * for the same X25519 recipient. With the merchant id and the key id signed
 * and in the info, an answer served for anyone else fails both checks. The
 * key id is the registered signing key's own id (`sig_...`), the one the
 * client sends as `X-ENSC-Key-Id` and holds in its configuration.
 *
 * The suite, the recipient key and the envelope fields are those of
 * ENSC-RESP-V1; the info and the version number are what differ. A request
 * without the header is answered in ENSC-RESP-V1, unchanged.
 */

import { canonicalQuery, isResponseNonce, sha256Hex } from './canonical.js';
import { base64UrlToBytes, bytesToBase64Url, bytesToUtf8, utf8ToBytes } from './encoding.js';
import {
  ed25519PrivateKeyToX25519,
  ed25519PublicKeyToX25519,
  HpkeError,
  hpkeOpen,
  hpkeSeal,
  type X25519KeyPair,
} from './hpke.js';

/** The label of the signed string and of the HPKE info. */
export const RESPONSE_VERSION_V2 = 'ENSC-RESP-V2' as const;
/** `v` of a sealed body that opens under the ENSC-RESP-V2 info. */
export const SEALED_VERSION_V2 = 2 as const;

const EMPTY = new Uint8Array(0);

export interface SealedEnvelopeV2 {
  v: typeof SEALED_VERSION_V2;
  enc: string;
  ciphertext: string;
}

/**
 * The request a response is bound to, as both sides know it: the host from
 * the request it received, the client from the request it sent.
 */
export interface RequestBinding {
  /** Upper-cased here, as in the request signature. */
  method: string;
  /** Request path without query string, e.g. `/v1/conversions`. */
  path: string;
  /** Canonicalized like the query of a signed request (`canonicalQuery`). */
  query: string | URLSearchParams | Record<string, string> | undefined;
  /** The `X-ENSC-Response-Nonce` of the request. */
  responseNonce: string;
}

/**
 * Everything a response is bound to: the request, and who it is answered to.
 * The host knows the last two once the request is authenticated and the
 * recipient key is chosen; the client has both in its configuration.
 */
export interface ResponseBinding extends RequestBinding {
  /** The merchant the request was served for (`mrc_...`). */
  merchantId: string;
  /** The id of the registered signing key the body is sealed to (`sig_...`). */
  recipientKeyId: string;
}

/** A line of the binding is one line: text with a line break is refused. */
function line(value: string, what: string): string {
  if (typeof value !== 'string' || value.length === 0 || /[\r\n]/.test(value)) {
    throw new Error(`Invalid ${what}`);
  }
  return value;
}

/** The six lines both strings share. One builder, so they cannot differ. */
function bindingLines(binding: ResponseBinding): string[] {
  if (!isResponseNonce(binding.responseNonce)) throw new Error('Invalid response nonce');
  return [
    line(binding.method, 'method').toUpperCase(),
    line(binding.path, 'path'),
    sha256Hex(canonicalQuery(binding.query)),
    binding.responseNonce,
    line(binding.merchantId, 'merchant id'),
    line(binding.recipientKeyId, 'recipient key id'),
  ];
}

export interface ResponseCanonicalV2Input {
  requestId: string;
  /** Unix seconds, as the `X-ENSC-Timestamp` response header spells them. */
  timestamp: number | string;
  binding: ResponseBinding;
  /** The sealed body exactly as it is on the wire. */
  body: string;
}

/** The exact string the host signs for an ENSC-RESP-V2 response. */
export function buildResponseCanonicalV2(input: ResponseCanonicalV2Input): string {
  return [
    RESPONSE_VERSION_V2,
    input.requestId,
    String(input.timestamp),
    ...bindingLines(input.binding),
    sha256Hex(input.body),
  ].join('\n');
}

/** The HPKE info an ENSC-RESP-V2 body is sealed and opened under. */
export function buildResponseInfoV2(
  requestId: string,
  binding: ResponseBinding,
): Uint8Array<ArrayBuffer> {
  return utf8ToBytes([RESPONSE_VERSION_V2, requestId, ...bindingLines(binding)].join('\n'));
}

/** The info, or HpkeError('MALFORMED') when a line of the binding is not usable. */
function infoOrMalformed(requestId: string, binding: ResponseBinding): Uint8Array<ArrayBuffer> {
  try {
    return buildResponseInfoV2(requestId, binding);
  } catch {
    throw new HpkeError('MALFORMED', 'Response binding is malformed');
  }
}

export interface SealResponseV2Input {
  /** Merchant's Ed25519 public key (base64url, 32 bytes) as registered with the API. */
  recipientEd25519PublicKey: string;
  requestId: string;
  binding: ResponseBinding;
  /** JSON string of the plaintext response body. */
  body: string;
  /** Test hook only: deterministic ephemeral key. Production callers leave this unset. */
  ephemeral?: X25519KeyPair;
}

export function sealResponseV2(input: SealResponseV2Input): SealedEnvelopeV2 {
  const info = infoOrMalformed(input.requestId, input.binding);
  let edPk: Uint8Array;
  try {
    edPk = base64UrlToBytes(input.recipientEd25519PublicKey);
  } catch {
    throw new HpkeError('BAD_KEY', 'Recipient public key is not valid base64url');
  }
  const pkR = ed25519PublicKeyToX25519(edPk);
  const { enc, ciphertext } = hpkeSeal({
    recipientPublicKey: pkR,
    info,
    aad: EMPTY,
    plaintext: utf8ToBytes(input.body),
    ...(input.ephemeral ? { ephemeral: input.ephemeral } : {}),
  });
  return {
    v: SEALED_VERSION_V2,
    enc: bytesToBase64Url(enc),
    ciphertext: bytesToBase64Url(ciphertext),
  };
}

/** Structural check for an ENSC-RESP-V2 sealed body. An ENSC-RESP-V1 body is not one. */
export function parseSealedEnvelopeV2(value: unknown): SealedEnvelopeV2 | null {
  if (typeof value !== 'object' || value === null) return null;
  const o = value as Record<string, unknown>;
  if (o.v !== SEALED_VERSION_V2) return null;
  if (typeof o.enc !== 'string' || o.enc.length !== 43) return null;
  if (typeof o.ciphertext !== 'string' || o.ciphertext.length === 0) return null;
  if (Object.keys(o).length !== 3) return null;
  return { v: SEALED_VERSION_V2, enc: o.enc, ciphertext: o.ciphertext };
}

export interface OpenResponseV2Input {
  /** Merchant's Ed25519 private key seed (base64url, 32 bytes). */
  recipientEd25519PrivateKey: string;
  requestId: string;
  /** The request that was sent: never anything read from the response. */
  binding: ResponseBinding;
  envelope: SealedEnvelopeV2;
}

/**
 * Open an ENSC-RESP-V2 body and return the plaintext JSON string. Throws
 * HpkeError('OPEN_FAILED') when the body was sealed for another request, for
 * another merchant or recipient key, or was altered.
 */
export function openResponseV2(input: OpenResponseV2Input): string {
  const info = infoOrMalformed(input.requestId, input.binding);
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
    info,
    aad: EMPTY,
    ciphertext: ct,
  });
  return bytesToUtf8(pt);
}
