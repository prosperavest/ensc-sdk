/**
 * In-memory stand-in for a ProsperaVest API host, for SDK tests.
 *
 * It behaves like a real host on the wire: decrypts ENSC-ENC-V1 envelopes
 * with the merchant's encryption key (checking the AAD), verifies the request
 * signature over the envelope bytes (ENSC-V2 when the request carries a
 * response nonce, ENSC-V1 when it does not), serves the product's public-key
 * document, and seals + signs every 2xx JSON response exactly as the API
 * does: ENSC-RESP-V2, bound to the request, when the request carries a
 * response nonce, and ENSC-RESP-V1 when it does not. An SDK's tests wrap it
 * with their own client and then assert on what the SDK sent and on what it
 * returned to the caller.
 *
 * Test-only: this entry is never bundled into a published SDK.
 */

import {
  base64UrlToBytes,
  buildRequestAad,
  buildResponseCanonicalV2,
  bytesToBase64Url,
  decryptEnvelope,
  generateKeypair,
  isResponseNonce,
  parseEnvelope,
  type ResponseBinding,
  sealResponse,
  sealResponseV2,
  sha256Hex,
  utf8ToBytes,
  verifyRequest,
} from '@ensc/protocol';
import { ed25519 } from '@noble/curves/ed25519.js';
import { randomBytes } from '@noble/hashes/utils.js';
import type { SdkProduct } from '../product.js';

const ENC_KEY_ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function randomEncKeyId(): string {
  const bytes = randomBytes(26);
  let out = 'enc_';
  for (const b of bytes) out += ENC_KEY_ID_ALPHABET[b % 32];
  return out;
}

/** The host's own response-signing key for the fake server. */
export const SERVER_SIGNING_SEED = randomBytes(32);
export const SERVER_KID = 'host_test_kid_1';
export const SERVER_PUBLIC_KEY = bytesToBase64Url(ed25519.getPublicKey(SERVER_SIGNING_SEED));

export interface MerchantFixture {
  apiKey: string;
  merchantId: string;
  encryptionKey: Uint8Array;
  encryptionKeyB64: string;
  encryptionKeyId: string;
  signingPrivateKey: string;
  signingPublicKey: string;
  signingKeyId: string;
}

/**
 * A merchant with the six credentials the dashboard issues. `apiKeyPrefix`
 * is the product's test secret-key prefix (`ensc_test_sk_`, `vlt_test_sk_`).
 */
export function merchantFixture(apiKeyPrefix: string): MerchantFixture {
  const encryptionKey = randomBytes(32);
  const kp = generateKeypair();
  return {
    apiKey: `${apiKeyPrefix}${bytesToBase64Url(randomBytes(24))}`,
    merchantId: 'mrc_01TESTMERCHANT00000000000',
    encryptionKey,
    encryptionKeyB64: bytesToBase64Url(encryptionKey),
    encryptionKeyId: randomEncKeyId(),
    signingPrivateKey: kp.privateKey,
    signingPublicKey: kp.publicKey,
    signingKeyId: 'sig_01TESTKEY',
  };
}

export interface RecordedCall {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  /** Exact wire body (envelope JSON on writes). */
  wireBody: string | undefined;
  /** Decrypted plaintext on writes, or the plain body on reads. */
  plaintext: string | undefined;
  /** Result of ENSC-V1 verification on writes. */
  signatureOk: boolean | undefined;
}

export interface Reply {
  status: number;
  body?: unknown;
  /** Return the body unsealed even on 2xx (to test the SDK's refusal). */
  unsealed?: boolean;
  /** Seal to this public key instead of the merchant's (wrong recipient). */
  sealTo?: string;
  /** Sign with this seed instead of the host's (bad signature). */
  signWith?: Uint8Array;
  /** Override the timestamp header (seconds). */
  timestamp?: number;
  /** Override the key id header. */
  kid?: string;
  /**
   * Answer in ENSC-RESP-V1 although the request asked for ENSC-RESP-V2: what a
   * host that predates V2 does, and what a downgrade looks like.
   */
  v1?: boolean;
  /**
   * Bind the ENSC-RESP-V2 answer to this instead of the request received: an
   * answer made for another request (another nonce, method, path or query) or
   * for another merchant or recipient key.
   */
  boundTo?: Partial<ResponseBinding>;
}

export type Handler = (call: RecordedCall) => Reply | Promise<Reply>;

export interface PublicKeysOptions {
  /** Keys served by the well-known document. Defaults to the host's test key. */
  keys?: Array<{ kid: string; publicKey: string; use?: string[]; alg?: string }>;
  status?: number;
}

export interface FakeHost {
  fetch: typeof fetch;
  calls: RecordedCall[];
  /** Number of times the well-known document was requested. */
  readonly publicKeyFetches: number;
  fx: MerchantFixture;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function headersToRecord(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const h = init?.headers;
  if (!h) return out;
  if (h instanceof Headers) {
    h.forEach((v, k) => {
      out[k.toLowerCase()] = v;
    });
    return out;
  }
  if (Array.isArray(h)) {
    for (const [k, v] of h) out[k.toLowerCase()] = v;
    return out;
  }
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

let requestCounter = 0;

/**
 * Build a fake host for `product`. `handler` decides the reply for every
 * request other than the well-known document. Pass the returned `fetch` to
 * the SDK client under test.
 */
export function fakeHost(
  product: SdkProduct,
  handler: Handler,
  opts: { publicKeys?: PublicKeysOptions; fx: MerchantFixture },
): FakeHost {
  const fx = opts.fx;
  const state = { publicKeyFetches: 0 };
  const calls: RecordedCall[] = [];

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const u = new URL(url);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (u.pathname === product.publicKeysPath) {
      state.publicKeyFetches++;
      const status = opts.publicKeys?.status ?? 200;
      const keys = opts.publicKeys?.keys ?? [{ kid: SERVER_KID, publicKey: SERVER_PUBLIC_KEY }];
      const body = {
        keys: keys.map((k) => ({
          kid: k.kid,
          alg: k.alg ?? 'Ed25519',
          publicKey: k.publicKey,
          use: k.use ?? ['webhooks', 'responses'],
        })),
      };
      return new Response(status === 200 ? JSON.stringify(body) : '{"error":"x"}', {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const headers = headersToRecord(init);
    const wireBody = typeof init?.body === 'string' ? init.body : undefined;
    let plaintext = wireBody;
    let signatureOk: boolean | undefined;

    const query: Record<string, string> = {};
    u.searchParams.forEach((v, k) => {
      query[k] = v;
    });
    // What an ENSC-RESP-V2 answer is bound to: the request as received (every
    // pair of its query string), the merchant and the recipient signing key.
    const responseNonce = headers['x-ensc-response-nonce'];
    const asked: ResponseBinding | undefined = isResponseNonce(responseNonce)
      ? {
          method,
          path: u.pathname,
          query: u.searchParams,
          responseNonce,
          merchantId: fx.merchantId,
          recipientKeyId: fx.signingKeyId,
        }
      : undefined;

    if (MUTATING.has(method)) {
      // Verify the request signature over the exact wire bytes: ENSC-V2 (every
      // pair of the query string) when the request carries a response nonce,
      // ENSC-V1 when it does not.
      const verify = verifyRequest({
        method,
        path: u.pathname,
        query:
          responseNonce !== undefined
            ? u.searchParams
            : Object.keys(query).length
              ? query
              : undefined,
        body: wireBody,
        timestamp: Number(headers['x-ensc-timestamp']),
        nonce: headers['x-ensc-nonce'] ?? '',
        merchantId: fx.merchantId,
        ...(headers['x-ensc-idempotency-key']
          ? { idempotencyKey: headers['x-ensc-idempotency-key'] }
          : {}),
        ...(responseNonce !== undefined ? { responseNonce } : {}),
        publicKey: fx.signingPublicKey,
        signatureHeader: headers['x-ensc-signature'] ?? '',
      });
      signatureOk = verify.ok;

      // Decrypt the envelope with the merchant's key and the request AAD.
      const envelope = wireBody ? parseEnvelope(JSON.parse(wireBody)) : null;
      if (!envelope) {
        plaintext = undefined;
      } else {
        const aad = buildRequestAad({
          method,
          path: u.pathname,
          merchantId: fx.merchantId,
          encKeyId: envelope.encKeyId,
        });
        const bytes = await decryptEnvelope({ key: fx.encryptionKey, envelope, aad });
        plaintext = new TextDecoder().decode(bytes);
      }
    }

    const call: RecordedCall = {
      method,
      url,
      path: u.pathname,
      headers,
      wireBody,
      plaintext,
      signatureOk,
    };
    calls.push(call);

    const reply = await handler(call);
    const status = reply.status;
    if (status === 204 || status === 205 || status === 304) {
      return new Response(null, { status });
    }
    const bodyText = reply.body === undefined ? '' : JSON.stringify(reply.body);
    if (status < 200 || status >= 300 || reply.unsealed || bodyText === '') {
      return new Response(bodyText, {
        status,
        headers: bodyText ? { 'Content-Type': 'application/json' } : {},
      });
    }

    const requestId = `req_${++requestCounter}`;
    const recipient = reply.sealTo ?? fx.signingPublicKey;
    const binding = asked && !reply.v1 ? { ...asked, ...reply.boundTo } : undefined;
    const sealed = binding
      ? sealResponseV2({
          recipientEd25519PublicKey: recipient,
          requestId,
          binding,
          body: bodyText,
        })
      : sealResponse({ recipientEd25519PublicKey: recipient, requestId, body: bodyText });
    const sealedText = JSON.stringify(sealed);
    const timestamp = String(reply.timestamp ?? Math.floor(Date.now() / 1000));
    const canonical = binding
      ? buildResponseCanonicalV2({ requestId, timestamp, binding, body: sealedText })
      : `ENSC-RESP-V1\n${requestId}\n${timestamp}\n${sha256Hex(sealedText)}`;
    const sig = ed25519.sign(utf8ToBytes(canonical), reply.signWith ?? SERVER_SIGNING_SEED);
    return new Response(sealedText, {
      status,
      headers: {
        'Content-Type': 'application/json',
        'X-ENSC-Signature': `ed25519=${bytesToBase64Url(sig)}`,
        'X-ENSC-Key-Id': reply.kid ?? SERVER_KID,
        'X-ENSC-Timestamp': timestamp,
        'X-ENSC-Request-Id': requestId,
        'Cache-Control': 'no-store',
      },
    });
  };

  return {
    fetch: fetchImpl as unknown as typeof fetch,
    calls,
    get publicKeyFetches() {
      return state.publicKeyFetches;
    },
    fx,
  };
}

/** A handler that answers every request with `body`. */
export const ok =
  (body: unknown, status = 200): Handler =>
  () => ({ status, body });

export { base64UrlToBytes };
