/**
 * Payload protection: request encryption (ENSC-ENC-V1) and sealed-response
 * verification + opening (ENSC-RESP-V1).
 *
 * The SDK does not implement any cryptography of its own. The primitives live
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
 * plaintext is bound to this request through the request id in the HPKE info.
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
import { PUBLIC_KEYS_PATH, type ResolvedConfig } from './config.js';

export const RESPONSE_SIGNATURE_VERSION = 'ENSC-RESP-V1' as const;

/** Headers a sealed response carries. */
export const RESPONSE_HEADERS = {
  signature: 'X-ENSC-Signature',
  keyId: 'X-ENSC-Key-Id',
  timestamp: 'X-ENSC-Timestamp',
  requestId: 'X-ENSC-Request-Id',
} as const;

export interface EncryptRequestInput {
  method: string;
  /** Path as the server sees it, without query string, e.g. `/v1/mint`. */
  path: string;
  /** Serialized JSON body. */
  plaintext: string;
}

/**
 * Encrypt a request body into an ENSC-ENC-V1 envelope and return the exact
 * JSON string to put on the wire. The caller signs this string.
 */
export async function encryptRequestBody(
  cfg: ResolvedConfig,
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

/** The exact string ENSC signs for a sealed response. */
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
 * Resolves ENSC's response-signing public keys. Uses the pinned
 * `config.enscPublicKeys` when given; otherwise fetches the well-known
 * document once and caches it for the life of the client. An unknown key id
 * triggers exactly one refetch (ENSC rotating its key) before the response is
 * rejected.
 */
export class PublicKeyResolver {
  readonly #cfg: ResolvedConfig;
  #keys: Map<string, Uint8Array> | undefined;
  #pending: Promise<Map<string, Uint8Array>> | undefined;

  constructor(cfg: ResolvedConfig) {
    this.#cfg = cfg;
    if (cfg.enscPublicKeys) {
      this.#keys = new Map(
        Object.entries(cfg.enscPublicKeys).map(([kid, pk]) => [kid, base64UrlToBytes(pk)]),
      );
    }
  }

  /** Look a key up, fetching or refetching the well-known document as needed. */
  async resolve(kid: string): Promise<Uint8Array> {
    if (this.#cfg.enscPublicKeys) {
      const pinned = this.#keys?.get(kid);
      if (pinned) return pinned;
      throw new EnscError(
        'ENSC_INVALID_SIGNATURE',
        `Response was signed with unknown ENSC key "${kid}" (not in config.enscPublicKeys)`,
      );
    }
    const cached = (this.#keys ?? (await this.#load())).get(kid);
    if (cached) return cached;
    const refreshed = (await this.#load()).get(kid);
    if (refreshed) return refreshed;
    throw new EnscError(
      'ENSC_INVALID_SIGNATURE',
      `Response was signed with unknown ENSC key "${kid}"`,
    );
  }

  #load(): Promise<Map<string, Uint8Array>> {
    if (!this.#pending) {
      this.#pending = this.#fetch().finally(() => {
        this.#pending = undefined;
      });
    }
    return this.#pending;
  }

  async #fetch(): Promise<Map<string, Uint8Array>> {
    const cfg = this.#cfg;
    let res: Response;
    try {
      res = await cfg.fetch(`${cfg.baseUrl}${PUBLIC_KEYS_PATH}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch (err) {
      throw new EnscError(
        'ENSC_UPSTREAM_FAILED',
        `Could not fetch ENSC public keys: ${(err as Error).message}`,
      );
    }
    if (!res.ok) {
      throw new EnscError(
        'ENSC_UPSTREAM_FAILED',
        `Could not fetch ENSC public keys: HTTP ${res.status}`,
      );
    }
    let doc: unknown;
    try {
      doc = await res.json();
    } catch {
      doc = undefined;
    }
    if (!isPublicKeysDocument(doc)) {
      throw new EnscError('ENSC_UPSTREAM_FAILED', 'ENSC public key document is malformed');
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
        'ENSC public key document contains no response-signing key',
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
  cfg: ResolvedConfig,
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
