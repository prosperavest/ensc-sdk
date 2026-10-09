/**
 * Low-level HTTP transport, shared by every SDK.
 *
 * Responsibilities:
 *   - Build the URL and headers (Bearer auth, pinned API version, key id)
 *   - Serialize the body to JSON ONCE, encrypt it into an ENSC-ENC-V1 envelope
 *     bound to the method, path, merchant and key id, and sign the exact
 *     envelope bytes that go on the wire (encrypt-then-sign)
 *   - Auto-generate a stable idempotency key per logical request, reused across
 *     retries so a transparently retried POST cannot double-execute
 *   - Send a fresh response nonce with every attempt of every request, reads
 *     included, so the host answers in ENSC-RESP-V2
 *   - Verify the host's signature on every successful response against the
 *     request that was sent, then open the sealed ENSC-RESP-V2 body with the
 *     merchant signing key: a response made for another request is refused
 *   - Have the host's public keys in hand before a write is sent, so that a
 *     write that succeeded is never reported as failed for want of a key
 *   - Retry transient failures (network errors + 5xx) with backoff; never 4xx,
 *     and never a request the host answered with success
 *   - Never follow a redirect: the signed request goes to the configured host
 *   - Map every failure to a single `EnscError` type; a failed write carries
 *     its idempotency key (`details.idempotencyKey`) and the request id on
 *     every status, a refusal (4xx) included, so the caller can repeat it
 *     safely with the same key or look it up
 *   - Hand the `Deprecation` and `Sunset` headers of an answer to the
 *     integrator's `onDeprecation` callback, so a version scheduled for
 *     retirement is noticed before it stops being served
 *
 * Resource modules sit on top of this and never deal with fetch directly.
 */

import { EnscError, isEnscErrorResponse, RESPONSE_NONCE_HEADER } from '@ensc/protocol';
import type { DeprecationNotice, ResolvedClientConfig } from './config.js';
import { encryptRequestBody, openSealedResponse, PublicKeyResolver } from './crypto.js';
import type { SdkProduct } from './product.js';
import { generateIdempotencyKey, generateResponseNonce, signMutation } from './signing.js';

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

/** Pagination plus an environment filter, for the lists that take one. */
export interface ListByEnvParams extends ListParams {
  /**
   * The environment to list. A list made with an API key holds what belongs
   * to the key's own environment, whatever this names; the field is kept for
   * compatibility and changes nothing with a key.
   */
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
  readonly #config: ResolvedClientConfig;
  readonly #keys: PublicKeyResolver;

  constructor(product: SdkProduct, config: ResolvedClientConfig) {
    this.#config = config;
    this.#keys = new PublicKeyResolver(product, config);
  }

  /** Execute a request and return the parsed JSON body typed as `T`. */
  async request<T>(opts: RequestOptions): Promise<T> {
    const cfg = this.#config;
    const isMutation = opts.signed ?? MUTATING_METHODS.has(opts.method);

    const query = normalizeQuery(opts.query);
    const url = `${cfg.baseUrl}${opts.path}${buildQueryString(query)}`;

    // The keys that verify the answer are loaded before a write goes out. If
    // they cannot be loaded, nothing was sent and the error says so; loading
    // them only after the write would turn a write that succeeded into an
    // error the caller cannot tell from a failure.
    if (isMutation) {
      try {
        await this.#keys.preload();
      } catch (err) {
        if (!(err instanceof EnscError)) throw err;
        throw copyError(err, `${err.message}. The request was not sent.`, {
          ...err.details,
          requestSent: false,
        });
      }
    }

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

    // A retirement notice is handed over once per request, whatever the
    // number of attempts.
    let noticeGiven = false;
    const notice = (response: Response, requestId: string | undefined): void => {
      if (noticeGiven || !cfg.onDeprecation) return;
      const found = readDeprecationNotice(response.headers, cfg.apiVersion, requestId);
      if (!found) return;
      noticeGiven = true;
      try {
        // A callback that returns a promise must not leave a rejection unhandled.
        const returned: unknown = cfg.onDeprecation(found);
        if (returned instanceof Promise) returned.catch(() => undefined);
      } catch {
        // The integrator's callback never decides the outcome of a request.
      }
    };

    let lastError: EnscError | undefined;
    // What a failed write hands the caller: the key that makes a repeat safe
    // and the request id, when the host gave one.
    const forCaller = (err: EnscError, requestId?: string): EnscError =>
      idempotencyKey === undefined && (requestId === undefined || err.requestId !== undefined)
        ? err
        : copyError(
            err,
            err.message,
            idempotencyKey === undefined ? err.details : { ...err.details, idempotencyKey },
            err.requestId ?? requestId,
          );

    for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
      // Re-sign on every attempt: timestamp and nonce must be fresh (an old
      // nonce is already burned, an old timestamp may be outside the skew
      // window). The idempotency key stays constant so the server still dedupes.
      //
      // The response nonce is new on every attempt too, and goes out on reads
      // as well as writes: the answer to this attempt must carry this value,
      // so an answer made for any other request, an earlier attempt of this
      // one included, is refused. On a write it is also signed (ENSC-V2).
      const responseNonce = generateResponseNonce();
      const headers: Record<string, string> = {
        ...baseHeaders,
        [RESPONSE_NONCE_HEADER]: responseNonce,
      };
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
            responseNonce,
          }),
        );
      }

      let response: Response;
      try {
        response = await cfg.fetch(url, {
          method: opts.method,
          headers,
          ...(bodyText !== undefined ? { body: bodyText } : {}),
          // A redirect is never followed: the signed request, its idempotency
          // key and the bearer key go to the configured host and nowhere else.
          redirect: 'manual',
          signal: AbortSignal.timeout(cfg.timeoutMs),
        });
      } catch (err) {
        // Network-level failure: no HTTP response was produced. A polyfilled
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
        throw forCaller(lastError);
      }

      const requestId = response.headers.get('X-ENSC-Request-Id') ?? undefined;
      notice(response, requestId);
      if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
        throw forCaller(
          new EnscError(
            'ENSC_UPSTREAM_FAILED',
            `Request to ${opts.path} was answered with a redirect, which is not followed`,
            { status: response.status },
            { status: response.status >= 300 ? response.status : undefined, requestId },
          ),
          requestId,
        );
      }
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
        throw forCaller(lastError, requestId);
      }

      if (response.ok) {
        // Every successful body is sealed to our signing key and signed by
        // the host, over the request this attempt sent. Nothing is parsed
        // before the signature verifies, and no route this client calls
        // answers an empty 2xx, so an empty body is refused like any other
        // unsigned answer.
        //
        // The host answered with success: the request was carried out. An
        // answer that cannot be verified or opened is never a reason to send
        // the request again, so nothing below is retried here, and the error
        // names the idempotency key and the request id of what was done.
        try {
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
            request: { method: opts.method, path: opts.path, query, responseNonce },
          });
          return parseJson(plaintext, opts.path) as T;
        } catch (err) {
          if (!(err instanceof EnscError)) throw err;
          throw forCaller(
            copyError(err, err.message, { ...err.details, responseStatus: response.status }),
            requestId,
          );
        }
      }

      let parsed: unknown;
      try {
        parsed = raw.length > 0 ? JSON.parse(raw) : undefined;
      } catch {
        parsed = undefined;
      }

      // Error response: prefer the API's structured ENSC error body.
      const enscError = toEnscError(response.status, parsed, requestId);
      lastError = enscError;

      // Retry only transient server-side failures.
      if (RETRYABLE_STATUS.has(response.status) && attempt < cfg.maxRetries) {
        await sleep(retryDelayMs(attempt));
        continue;
      }
      // Whatever the status, a failed write names its idempotency key. An
      // error answer is not signed: a 4xx normally is the host's refusal, but
      // nothing proves that this one came from the host, so the caller is
      // always handed the key that makes a repeat safe.
      throw forCaller(enscError, requestId);
    }

    // Unreachable in practice (the loop either returns or throws) but satisfies
    // the type checker and covers a maxRetries/logic edge case.
    throw lastError ?? new EnscError('ENSC_INTERNAL', `Request to ${opts.path} failed`);
  }
}

/** The same error (code, status, stack) with another message, details or request id. */
function copyError(
  err: EnscError,
  message: string,
  details: Record<string, unknown> | undefined,
  requestId: string | undefined = err.requestId,
): EnscError {
  const copy = new EnscError(err.code, message, details, { status: err.status, requestId });
  if (err.stack !== undefined) copy.stack = err.stack;
  return copy;
}

/**
 * The retirement notice an answer carries, or undefined when it carries none.
 * `Deprecation` is `@<unix seconds>` (RFC 9745) and `Sunset` an HTTP date
 * (RFC 8594); a value in another form is left out.
 */
function readDeprecationNotice(
  headers: Headers,
  pinnedVersion: string,
  requestId: string | undefined,
): DeprecationNotice | undefined {
  const deprecation = /^@(\d{1,12})$/.exec(headers.get('Deprecation')?.trim() ?? '');
  const deprecatedAt = deprecation?.[1] ? new Date(Number(deprecation[1]) * 1000) : undefined;
  const sunsetMs = Date.parse(headers.get('Sunset') ?? '');
  const sunsetAt = Number.isNaN(sunsetMs) ? undefined : new Date(sunsetMs);
  if (!deprecatedAt && !sunsetAt) return undefined;
  return {
    apiVersion: headers.get('X-ENSC-API-Version')?.trim() || pinnedVersion,
    ...(deprecatedAt ? { deprecatedAt } : {}),
    ...(sunsetAt ? { sunsetAt } : {}),
    ...(requestId ? { requestId } : {}),
  };
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
  // The API always returns the ENSC error shape; reaching here means the
  // answer came from something in front of it. Map by status as best we can.
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
