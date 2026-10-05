/**
 * Payload protection: request encryption (ENSC-ENC-V1) and sealed-response
 * verification + opening (ENSC-RESP-V1). Shared by every SDK; the product
 * decides only which well-known document the signing keys come from.
 *
 * No SDK implements any cryptography of its own. The primitives live
 * in `@ensc/protocol`, the same module the API uses to decrypt requests and seal
 * responses, so both sides cannot drift: AES-256-GCM via Web Crypto for the
 * request envelope, HPKE (RFC 9180 base mode, X25519 + HKDF-SHA256 +
 * ChaCha20-Poly1305) for the response envelope, and Ed25519 for signatures.
 *
 * Order of operations on the wire:
 *
 *   request:   plaintext JSON  -> encrypt (AAD binds method, path, merchant,
 *              key id) -> envelope JSON -> sign envelope bytes -> send
 *   response:  verify ENSC's Ed25519 signature over the sealed body -> check
 *              the timestamp window -> open with the merchant signing key ->
 *              plaintext JSON
 *
 * A response is never trusted before its signature verifies, and the decrypted
 * plaintext is bound to the request id the response carries through the HPKE
 * info.
 */

import {
  base64UrlToBytes,
  buildRequestAad,
  EnscError,
  encryptEnvelope,
  HpkeError,
  openResponse,
  parseSealedEnvelope,
  sha256Hex,
  utf8ToBytes,
} from '@ensc/protocol';
import { ed25519 } from '@noble/curves/ed25519.js';
import type { ResolvedClientConfig } from './config.js';
import type { SdkProduct } from './product.js';

export const RESPONSE_SIGNATURE_VERSION = 'ENSC-RESP-V1' as const;

/**
 * How many times the public key document is asked for before the load fails:
 * the first try and two more, 200 ms then 400 ms apart. The document is a
 * small public GET, so asking again is always safe, and a load that fails
 * leaves an answer that cannot be verified; the request that answer belongs
 * to is never sent again because of it.
 */
export const KEY_FETCH_ATTEMPTS = 3;
const KEY_FETCH_BACKOFF_MS = 200;

/** Headers a sealed response carries. */
export const RESPONSE_HEADERS = {
  signature: 'X-ENSC-Signature',
  keyId: 'X-ENSC-Key-Id',
  timestamp: 'X-ENSC-Timestamp',
  requestId: 'X-ENSC-Request-Id',
} as const;

export interface EncryptRequestInput {
  method: string;
  /** Path as the server sees it, without query string, e.g. `/v1/conversions`. */
  path: string;
  /** Serialized JSON body. */
  plaintext: string;
}

/**
 * Encrypt a request body into an ENSC-ENC-V1 envelope and return the exact
 * JSON string to put on the wire. The caller signs this string.
 */
export async function encryptRequestBody(
  cfg: ResolvedClientConfig,
  input: EncryptRequestInput,
): Promise<string> {
  const aad = buildRequestAad({
    method: input.method,
    path: input.path,
    merchantId: cfg.merchantId,
    encKeyId: cfg.encryptionKeyId,
  });
  const envelope = await encryptEnvelope({
    key: cfg.encryptionKey,
    encKeyId: cfg.encryptionKeyId,
    plaintext: input.plaintext,
    aad,
  });
  return JSON.stringify(envelope);
}

/** The exact string the host signs for a sealed response. */
export function buildResponseCanonical(requestId: string, timestamp: string, body: string): string {
  return `${RESPONSE_SIGNATURE_VERSION}\n${requestId}\n${timestamp}\n${sha256Hex(body)}`;
}

interface PublicKeysDocument {
  keys: Array<{ kid: string; alg: string; publicKey: string; use: string[] }>;
}

function isPublicKeysDocument(value: unknown): value is PublicKeysDocument {
  if (!value || typeof value !== 'object') return false;
  const keys = (value as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) return false;
  return keys.every(
    (k) =>
      k &&
      typeof k === 'object' &&
      typeof (k as { kid?: unknown }).kid === 'string' &&
      typeof (k as { publicKey?: unknown }).publicKey === 'string' &&
      Array.isArray((k as { use?: unknown }).use),
  );
}

/**
 * Resolves the host's response-signing public keys. Uses the pinned
 * `serverPublicKeys` when given; otherwise fetches the product's well-known
 * document once and caches it for the life of the client. An unknown key id
 * triggers exactly one refetch (the host rotating its key) before the
 * response is rejected. A fetch that fails is tried again up to
 * {@link KEY_FETCH_ATTEMPTS} times in all.
 */
export class PublicKeyResolver {
  readonly #product: SdkProduct;
  readonly #cfg: ResolvedClientConfig;
  #keys: Map<string, Uint8Array> | undefined;
  #pending: Promise<Map<string, Uint8Array>> | undefined;

  constructor(product: SdkProduct, cfg: ResolvedClientConfig) {
    this.#product = product;
    this.#cfg = cfg;
    if (cfg.serverPublicKeys) {
      this.#keys = new Map(
        Object.entries(cfg.serverPublicKeys).map(([kid, pk]) => [kid, base64UrlToBytes(pk)]),
      );
    }
  }

  /** Look a key up, fetching or refetching the well-known document as needed. */
  async resolve(kid: string): Promise<Uint8Array> {
    const name = this.#product.name;
    if (this.#cfg.serverPublicKeys) {
      const pinned = this.#keys?.get(kid);
      if (pinned) return pinned;
      throw new EnscError(
        'ENSC_INVALID_SIGNATURE',
        `Response was signed with unknown ${name} key "${kid}" (not in config.${this.#product.publicKeysConfigField})`,
      );
    }
    const cached = (this.#keys ?? (await this.#load())).get(kid);
    if (cached) return cached;
    const refreshed = (await this.#load()).get(kid);
    if (refreshed) return refreshed;
    throw new EnscError(
      'ENSC_INVALID_SIGNATURE',
      `Response was signed with unknown ${name} key "${kid}"`,
    );
  }

  /**
   * Make sure the keys are in hand before a write is sent, so that verifying
   * its answer needs no further network call: when they are neither pinned
   * nor loaded yet, load them now. A failure here happens before anything was
   * sent.
   */
  async preload(): Promise<void> {
    if (this.#cfg.serverPublicKeys || this.#keys) return;
    await this.#load();
  }

  #load(): Promise<Map<string, Uint8Array>> {
    if (!this.#pending) {
      this.#pending = this.#fetchWithRetry().finally(() => {
        this.#pending = undefined;
      });
    }
    return this.#pending;
  }

  async #fetchWithRetry(): Promise<Map<string, Uint8Array>> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.#fetch();
      } catch (err) {
        if (attempt >= KEY_FETCH_ATTEMPTS) throw err;
        await new Promise((r) => setTimeout(r, KEY_FETCH_BACKOFF_MS * 2 ** (attempt - 1)));
      }
    }
  }

  async #fetch(): Promise<Map<string, Uint8Array>> {
    const cfg = this.#cfg;
    const name = this.#product.name;
    let res: Response;
    try {
      res = await cfg.fetch(`${cfg.baseUrl}${this.#product.publicKeysPath}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        // A redirect is never followed: the keys come from the host asked.
        redirect: 'manual',
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch (err) {
      throw new EnscError(
        'ENSC_UPSTREAM_FAILED',
        `Could not fetch ${name} public keys: ${(err as Error).message}`,
      );
    }
    if (!res.ok) {
      throw new EnscError(
        'ENSC_UPSTREAM_FAILED',
        `Could not fetch ${name} public keys: HTTP ${res.status}`,
      );
    }
    let doc: unknown;
    try {
      doc = await res.json();
    } catch {
      doc = undefined;
    }
    if (!isPublicKeysDocument(doc)) {
      throw new EnscError('ENSC_UPSTREAM_FAILED', `${name} public key document is malformed`);
    }
    const map = new Map<string, Uint8Array>();
    for (const k of doc.keys) {
      if (k.alg !== 'Ed25519' || !k.use.includes('responses')) continue;
      let bytes: Uint8Array;
      try {
        bytes = base64UrlToBytes(k.publicKey);
      } catch {
        continue;
      }
      if (bytes.length === 32) map.set(k.kid, bytes);
    }
    if (map.size === 0) {
      throw new EnscError(
        'ENSC_UPSTREAM_FAILED',
        `${name} public key document contains no response-signing key`,
      );
    }
    this.#keys = map;
    return map;
  }
}

export interface OpenSealedInput {
  /** Raw response body text. */
  body: string;
  headers: Headers;
}

/**
 * Verify a sealed response and return its plaintext. Throws
 * `ENSC_INVALID_SIGNATURE` when the signature, key id or timestamp is
 * unacceptable and `ENSC_DECRYPTION_FAILED` when the envelope cannot be opened.
 */
export async function openSealedResponse(
  cfg: ResolvedClientConfig,
  keys: PublicKeyResolver,
  input: OpenSealedInput,
): Promise<string> {
  const signature = input.headers.get(RESPONSE_HEADERS.signature);
  const kid = input.headers.get(RESPONSE_HEADERS.keyId);
  const timestamp = input.headers.get(RESPONSE_HEADERS.timestamp);
  const requestId = input.headers.get(RESPONSE_HEADERS.requestId);

  if (!signature || !kid || !timestamp || !requestId) {
    throw new EnscError(
      'ENSC_INVALID_SIGNATURE',
      'Response is not a signed ENSC-RESP-V1 envelope (missing X-ENSC-* headers). ' +
        'This SDK requires API version 2026-09-15 or later.',
    );
  }

  if (!/^\d{1,12}$/.test(timestamp)) {
    throw new EnscError('ENSC_INVALID_SIGNATURE', 'Response timestamp is malformed');
  }
  const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (skew > cfg.responseMaxSkewSeconds) {
    throw new EnscError(
      'ENSC_INVALID_SIGNATURE',
      `Response timestamp is outside the accepted window (${skew}s skew)`,
    );
  }

  const match = /^ed25519=([A-Za-z0-9_-]{86})$/.exec(signature);
  if (!match?.[1]) {
    throw new EnscError('ENSC_INVALID_SIGNATURE', 'Response signature is malformed');
  }

  const publicKey = await keys.resolve(kid);
  let verified = false;
  try {
    verified = ed25519.verify(
      base64UrlToBytes(match[1]),
      utf8ToBytes(buildResponseCanonical(requestId, timestamp, input.body)),
      publicKey,
    );
  } catch {
    verified = false;
  }
  if (!verified) {
    throw new EnscError('ENSC_INVALID_SIGNATURE', 'Response signature did not verify');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.body);
  } catch {
    parsed = undefined;
  }
  const envelope = parseSealedEnvelope(parsed);
  if (!envelope) {
    throw new EnscError('ENSC_DECRYPTION_FAILED', 'Response body is not a sealed envelope');
  }

  try {
    return openResponse({
      recipientEd25519PrivateKey: cfg.signingPrivateKey,
      requestId,
      envelope,
    });
  } catch (err) {
    const reason = err instanceof HpkeError ? err.code : 'OPEN_FAILED';
    throw new EnscError(
      'ENSC_DECRYPTION_FAILED',
      'Sealed response could not be opened with the configured signing key',
      { reason },
    );
  }
}
