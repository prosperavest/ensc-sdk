/**
 * Low-level HTTP transport.
 *
 * Responsibilities:
 *   - Build the URL and headers (Bearer auth, pinned API version, key id)
 *   - Serialize the body to JSON ONCE, encrypt it into an ENSC-ENC-V1 envelope
 *     bound to the method, path, merchant and key id, and sign the exact
 *     envelope bytes that go on the wire (encrypt-then-sign)
 *   - Auto-generate a stable idempotency key per logical request, reused across
 *     retries so a transparently retried POST cannot double-execute
 *   - Verify ENSC's signature on every successful response, then open the
 *     sealed ENSC-RESP-V1 body with the merchant signing key
 *   - Retry transient failures (network errors + 5xx) with backoff; never 4xx
 *   - Map every failure to a single `EnscError` type
 *
 * Resource modules sit on top of this and never deal with fetch directly.
 */

import { EnscError, isEnscErrorResponse } from '@ensc/protocol';
import type { ResolvedConfig } from './config.js';
import { encryptRequestBody, openSealedResponse, PublicKeyResolver } from './crypto.js';
import { generateIdempotencyKey, signMutation } from './signing.js';

/** Query value types accepted by resource methods. `undefined` entries are dropped. */
export type QueryValue = string | number | boolean | undefined;
export type QueryParams = Record<string, QueryValue>;

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Path including the `/v1` prefix, e.g. `/v1/conversions`. */
  path: string;
  query?: QueryParams;
  /** JSON-serializable request body. */
  body?: unknown;
  /**
   * Whether this request must be encrypted and Ed25519-signed. Defaults to
   * `true` for mutating methods and `false` for reads.
   */
  signed?: boolean;
  /** Caller-supplied idempotency key. Auto-generated when omitted. */
  idempotencyKey?: string;
}

/** Shared cursor-pagination input for every `list()` method. */
export interface ListParams {
  /** Page size, 1 to 200. The API defaults to 50. */
  limit?: number;
  /** Opaque cursor from a previous response's `pagination.nextCursor`. */
  cursor?: string;
}

/** Pagination plus an environment filter, for the credential and origin lists. */
export interface ListByEnvParams extends ListParams {
  /** Restrict to one environment; the default is both. */
  env?: 'test' | 'live';
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);

/** Normalize a query object to a string-valued record, dropping `undefined`. */
function normalizeQuery(query: QueryParams | undefined): Record<string, string> | undefined {
  if (!query) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) out[k] = String(v);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function buildQueryString(query: Record<string, string> | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams(query);
  const s = params.toString();
  return s ? `?${s}` : '';
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class HttpClient {
  readonly #config: ResolvedConfig;
  readonly #keys: PublicKeyResolver;

  constructor(config: ResolvedConfig) {
    this.#config = config;
    this.#keys = new PublicKeyResolver(config);
  }

  /** Execute a request and return the parsed JSON body typed as `T`. */
  async request<T>(opts: RequestOptions): Promise<T> {
    const cfg = this.#config;
    const isMutation = opts.signed ?? MUTATING_METHODS.has(opts.method);

    const query = normalizeQuery(opts.query);
    const url = `${cfg.baseUrl}${opts.path}${buildQueryString(query)}`;

    // Serialize the body exactly once. On a write the JSON is encrypted into an
    // ENSC-ENC-V1 envelope whose AAD binds it to this method, path, merchant
    // and encryption key, and the envelope string is what gets signed AND sent.
    // It is built once per logical request and reused across retries; only the
    // signature (timestamp, nonce) is refreshed per attempt.
    let bodyText: string | undefined;
    if (opts.body !== undefined) {
      const plaintext = JSON.stringify(opts.body);
      bodyText = isMutation
        ? await encryptRequestBody(cfg, { method: opts.method, path: opts.path, plaintext })
        : plaintext;
    } else if (isMutation) {
      // A write always carries a JSON document: the API refuses an empty
      // envelope, so a bodiless write sends an encrypted `{}`.
      bodyText = await encryptRequestBody(cfg, {
        method: opts.method,
        path: opts.path,
        plaintext: '{}',
      });
    }

    // One idempotency key per logical request, reused across every retry.
    const idempotencyKey = isMutation
      ? (opts.idempotencyKey ?? generateIdempotencyKey())
      : undefined;

    const baseHeaders: Record<string, string> = {
      Authorization: `Bearer ${cfg.apiKey}`,
      Accept: 'application/json',
      'X-ENSC-API-Version': cfg.apiVersion,
      // Always sent: on writes it names the verification key, on reads it names
      // the recipient key the API seals the response to.
      'X-ENSC-Key-Id': cfg.signingKeyId,
    };
    if (bodyText !== undefined) baseHeaders['Content-Type'] = 'application/json';

    let lastError: EnscError | undefined;

    for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
      // Re-sign on every attempt: timestamp and nonce must be fresh (an old
      // nonce is already burned, an old timestamp may be outside the skew
      // window). The idempotency key stays constant so the server still dedupes.
      const headers: Record<string, string> = { ...baseHeaders };
      if (isMutation && idempotencyKey) {
        Object.assign(
          headers,
          signMutation({
            method: opts.method,
            path: opts.path,
            query,
            body: bodyText,
            merchantId: cfg.merchantId,
            privateKey: cfg.signingPrivateKey,
            keyId: cfg.signingKeyId,
            idempotencyKey,
          }),
        );
      }

      let response: Response;
      try {
        response = await cfg.fetch(url, {
          method: opts.method,
          headers,
          ...(bodyText !== undefined ? { body: bodyText } : {}),
          signal: AbortSignal.timeout(cfg.timeoutMs),
        });
      } catch (err) {
        // Network-level failure - no HTTP response was produced. A polyfilled
        // fetch reports the timeout signal as AbortError.
        const isTimeout =
          err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
        lastError = new EnscError(
          'ENSC_UPSTREAM_FAILED',
          isTimeout
            ? `Request to ${opts.path} timed out after ${cfg.timeoutMs}ms`
            : `Network error calling ${opts.path}: ${(err as Error).message}`,
        );
        if (attempt < cfg.maxRetries) {
          await sleep(retryDelayMs(attempt));
          continue;
        }
        throw lastError;
      }

      const requestId = response.headers.get('X-ENSC-Request-Id') ?? undefined;
      let raw: string;
      try {
        raw = await response.text();
      } catch (err) {
        lastError = new EnscError(
          'ENSC_UPSTREAM_FAILED',
          `Response body from ${opts.path} could not be read: ${(err as Error).message}`,
          undefined,
          { requestId },
        );
        if (attempt < cfg.maxRetries) {
          await sleep(retryDelayMs(attempt));
          continue;
        }
        throw lastError;
      }

      if (response.ok) {
        // Every successful body is sealed to our signing key and signed by
        // ENSC. Nothing is parsed before the signature verifies, and no route
        // this client calls answers an empty 2xx, so an empty body is refused
        // like any other unsigned answer.
        if (response.status === 204 || raw.length === 0) {
          throw new EnscError(
            'ENSC_INVALID_SIGNATURE',
            `Response from ${opts.path} has no sealed body`,
            { reason: 'empty_body', status: response.status },
            { requestId },
          );
        }
        const plaintext = await openSealedResponse(cfg, this.#keys, {
          body: raw,
          headers: response.headers,
        });
        return parseJson(plaintext, opts.path) as T;
      }

      let parsed: unknown;
      try {
        parsed = raw.length > 0 ? JSON.parse(raw) : undefined;
      } catch {
        parsed = undefined;
      }

      // Error response - prefer the API's structured ENSC error body.
      const enscError = toEnscError(response.status, parsed, requestId);
      lastError = enscError;

      // Retry only transient server-side failures.
      if (RETRYABLE_STATUS.has(response.status) && attempt < cfg.maxRetries) {
        await sleep(retryDelayMs(attempt));
        continue;
      }
      throw enscError;
    }

    // Unreachable in practice - the loop either returns or throws - but satisfies
    // the type checker and covers a maxRetries/logic edge case.
    throw lastError ?? new EnscError('ENSC_INTERNAL', `Request to ${opts.path} failed`);
  }
}

function parseJson(text: string, path: string): unknown {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new EnscError('ENSC_UPSTREAM_FAILED', `Response from ${path} is not valid JSON`);
  }
}

/** Exponential backoff with a small fixed base: 200ms, 400ms, 800ms, … */
function retryDelayMs(attempt: number): number {
  return 200 * 2 ** attempt;
}

/** Map an HTTP error response to an `EnscError`, keeping the real status and request id. */
function toEnscError(status: number, body: unknown, headerRequestId?: string): EnscError {
  if (isEnscErrorResponse(body)) {
    const requestId = body.error.requestId ?? headerRequestId;
    return new EnscError(body.error.code, body.error.message, body.error.details, {
      status,
      requestId,
    });
  }
  // The API always returns the ENSC error shape; reaching here means an
  // unexpected upstream (proxy, gateway). Map by status as best we can.
  const extra = { status, requestId: headerRequestId };
  if (status === 429) return new EnscError('ENSC_RATE_LIMITED', 'Rate limited', undefined, extra);
  if (status === 404) return new EnscError('ENSC_NOT_FOUND', 'Not found', undefined, extra);
  if (status === 401 || status === 403) {
    return new EnscError(
      'ENSC_FORBIDDEN',
      `Request refused upstream with HTTP ${status}`,
      undefined,
      extra,
    );
  }
  if (status >= 500) {
    return new EnscError(
      'ENSC_UPSTREAM_FAILED',
      `Upstream returned HTTP ${status}`,
      undefined,
      extra,
    );
  }
  return new EnscError(
    'ENSC_UPSTREAM_FAILED',
    `Unexpected HTTP ${status} response`,
    undefined,
    extra,
  );
}
