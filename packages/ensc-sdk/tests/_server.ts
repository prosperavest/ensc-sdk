/**
 * In-memory stand-in for the ENSC API used by the SDK tests.
 *
 * It behaves like the real Worker on the wire: decrypts ENSC-ENC-V1 envelopes
 * with the merchant's encryption key (checking the AAD), verifies the ENSC-V1
 * signature over the envelope bytes, serves the public-key document, and seals
 * + signs every 2xx JSON response exactly as `responseSeal` does. Tests then
 * assert on what the SDK sent and on what it returned to the caller.
 */

import {
  base64UrlToBytes,
  buildRequestAad,
  bytesToBase64Url,
  decryptEnvelope,
  generateKeypair,
  parseEnvelope,
  sealResponse,
  sha256Hex,
  utf8ToBytes,
  verifyRequest,
} from '@ensc/protocol';
import { ed25519 } from '@noble/curves/ed25519.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { vi } from 'vitest';
import { EnscClient, type EnscClientConfig } from '../src/index.js';

const ENC_KEY_ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function randomEncKeyId(): string {
  const bytes = randomBytes(26);
  let out = 'enc_';
  for (const b of bytes) out += ENC_KEY_ID_ALPHABET[b % 32];
  return out;
}

/** ENSC's own response-signing key for the test server. */
export const ENSC_SIGNING_SEED = randomBytes(32);
export const ENSC_KID = 'ensc_test_kid_1';
export const ENSC_PUBLIC_KEY = bytesToBase64Url(ed25519.getPublicKey(ENSC_SIGNING_SEED));

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

export function merchantFixture(): MerchantFixture {
  const encryptionKey = randomBytes(32);
  const kp = generateKeypair();
  return {
    apiKey: `ensc_test_sk_${bytesToBase64Url(randomBytes(24))}`,
    merchantId: 'mrc_01TESTMERCHANT00000000000',
    encryptionKey,
    encryptionKeyB64: bytesToBase64Url(encryptionKey),
    encryptionKeyId: randomEncKeyId(),
    signingPrivateKey: kp.privateKey,
    signingPublicKey: kp.publicKey,
    signingKeyId: 'sig_01TESTKEY',
  };
}

export function configFor(
  fx: MerchantFixture,
  extra: Partial<EnscClientConfig> = {},
): EnscClientConfig {
  return {
    apiKey: fx.apiKey,
    merchantId: fx.merchantId,
    encryptionKey: fx.encryptionKeyB64,
    encryptionKeyId: fx.encryptionKeyId,
    signingPrivateKey: fx.signingPrivateKey,
    signingKeyId: fx.signingKeyId,
    baseUrl: 'https://api.test',
    ...extra,
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
  /** Sign with this seed instead of ENSC's (bad signature). */
  signWith?: Uint8Array;
  /** Override the timestamp header (seconds). */
  timestamp?: number;
  /** Override the key id header. */
  kid?: string;
}

export type Handler = (call: RecordedCall) => Reply | Promise<Reply>;

export interface PublicKeysOptions {
  /** Keys served by the well-known document. Defaults to ENSC's test key. */
  keys?: Array<{ kid: string; publicKey: string; use?: string[]; alg?: string }>;
  status?: number;
}

export interface TestServer {
  fetch: typeof fetch;
  calls: RecordedCall[];
  /** Number of times the well-known document was requested. */
  publicKeyFetches: number;
  client: EnscClient;
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
 * Build a fake API + a client wired to it. `handler` decides the reply for
 * every non-well-known request.
 */
export function testServer(
  handler: Handler,
  opts: {
    config?: Partial<EnscClientConfig>;
    publicKeys?: PublicKeysOptions;
    fx?: MerchantFixture;
  } = {},
): TestServer {
  const fx = opts.fx ?? merchantFixture();
  const state = { publicKeyFetches: 0 };
  const calls: RecordedCall[] = [];

  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const u = new URL(url);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (u.pathname === '/v1/.well-known/ensc-public-keys.json') {
      state.publicKeyFetches++;
      const status = opts.publicKeys?.status ?? 200;
      const keys = opts.publicKeys?.keys ?? [{ kid: ENSC_KID, publicKey: ENSC_PUBLIC_KEY }];
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

    if (MUTATING.has(method)) {
      // Verify the ENSC-V1 signature over the exact wire bytes.
      const query: Record<string, string> = {};
      u.searchParams.forEach((v, k) => {
        query[k] = v;
      });
      const verify = verifyRequest({
        method,
        path: u.pathname,
        query: Object.keys(query).length ? query : undefined,
        body: wireBody,
        timestamp: Number(headers['x-ensc-timestamp']),
        nonce: headers['x-ensc-nonce'] ?? '',
        merchantId: fx.merchantId,
        ...(headers['x-ensc-idempotency-key']
          ? { idempotencyKey: headers['x-ensc-idempotency-key'] }
          : {}),
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
    const sealed = sealResponse({
      recipientEd25519PublicKey: reply.sealTo ?? fx.signingPublicKey,
      requestId,
      body: bodyText,
    });
    const sealedText = JSON.stringify(sealed);
    const timestamp = String(reply.timestamp ?? Math.floor(Date.now() / 1000));
    const canonical = `ENSC-RESP-V1\n${requestId}\n${timestamp}\n${sha256Hex(sealedText)}`;
    const sig = ed25519.sign(utf8ToBytes(canonical), reply.signWith ?? ENSC_SIGNING_SEED);
    return new Response(sealedText, {
      status,
      headers: {
        'Content-Type': 'application/json',
        'X-ENSC-Signature': `ed25519=${bytesToBase64Url(sig)}`,
        'X-ENSC-Key-Id': reply.kid ?? ENSC_KID,
        'X-ENSC-Timestamp': timestamp,
        'X-ENSC-Request-Id': requestId,
        'Cache-Control': 'no-store',
      },
    });
  });

  const client = new EnscClient(
    configFor(fx, { fetch: fetchImpl as unknown as typeof fetch, ...opts.config }),
  );
  return {
    fetch: fetchImpl as unknown as typeof fetch,
    calls,
    get publicKeyFetches() {
      return state.publicKeyFetches;
    },
    client,
    fx,
  };
}

/** A handler that answers every request with `body`. */
export const ok =
  (body: unknown, status = 200): Handler =>
  () => ({ status, body });

export { base64UrlToBytes };
