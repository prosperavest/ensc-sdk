# Authorization

Every request carries your API key. Every write also carries an Ed25519 signature. `@ensc/sdk` adds both automatically.

## API key

```
Authorization: Bearer ensc_live_sk_…
X-ENSC-API-Version: 2026-09-15
X-ENSC-Key-Id: sig_…
```

- The key's prefix encodes the environment (`ensc_test_` / `ensc_live_`) and type (`sk` secret, `rk` restricted, `pk` publishable). A test key cannot touch live resources and vice versa (`ENSC_TEST_LIVE_MISMATCH`).
- `X-ENSC-API-Version` pins the contract you were built against. The current version is `2026-09-15`. See [API versions](#api-versions).
- `X-ENSC-Key-Id` names your signing key. On writes it is the key ENSC verifies your signature with; on reads it is the key ENSC seals the response to. Send it on every request.
- Live keys are accepted only from allowlisted IPs (`ENSC_IP_NOT_ALLOWED` otherwise). See [IP allowlist](./ip-allowlist.md).

## Permissions (scopes)

Each key carries a fixed list of scopes, chosen when it is generated. An endpoint refuses a key without the scope it needs (`403 ENSC_INSUFFICIENT_SCOPE`).

| Scope | Grants |
|---|---|
| `conversions:create` | `POST /v1/conversions`, `POST /v1/conversions/{reference}/events`, `POST /v1/conversions/{reference}/voucher`, `POST /v1/conversions/{reference}/payout`, `POST /v1/accounts/resolve` |
| `conversions:read` | `GET /v1/conversions`, `GET /v1/conversions/{reference}`, `GET /v1/conversions/quote`, `GET /v1/conversions/screening`, `GET /v1/banks` |
| `transfer:create` | `POST /v1/transfer` |
| `balances:read` | `GET /v1/balance` |

The keys the dashboard generates carry all four by default. A secret key also manages webhook endpoints, reads the event log and lists credentials without a dedicated scope. A restricted key needs `webhooks:read` to list endpoints and read events, `webhooks:manage` to create, change, test or delete endpoints, and `api-keys:read` to list API keys, signing keys, encryption keys and allowed origins (`403 ENSC_INSUFFICIENT_SCOPE` without it). `api-keys:manage` is reserved and not yet required by any route.

Every list made with a key holds what belongs to the key's own environment: a Sandbox key lists Sandbox credentials, origins, webhook endpoints and events, a Live key the Live ones, whatever `env` the request names. The dashboard shows both.

Publishable keys can hold only `balances:read`. Issuing, rotating and revoking any key, and editing IP allowlists or CORS origins, are dashboard actions and are refused from API keys (`403 ENSC_DASHBOARD_ONLY`).

A live key is refused with `403 ENSC_FORBIDDEN` while the account is not active or live access is not enabled for it.

## Allowed origins

A publishable key is used from a browser, and a browser call is answered only for an origin you have allowed for that environment (the list is edited in the dashboard; `ensc.origins.list()` reads it). An entry takes one of three forms:

| Form | Example | Matches |
|---|---|---|
| An exact origin | `https://app.example.com`, `https://app.example.com:8443` | That origin and no other. It is written the way a browser sends it: lowercase host, no path, no trailing slash, and no port when the port is the scheme's default (`https://app.example.com:443` is refused). At most 300 characters. |
| A wildcard | `https://*.example.com`, `https://*.example.com:8443` | Exactly one host label in place of the star (`https://shop.example.com`, not `https://a.b.example.com` and not `https://example.com`). The star is the whole first label, and at least two lowercase labels follow it: `https://*.com`, `https://shop.*.example.com` and `https://shop-*.example.com` are refused. The default port is refused here too. |
| A pattern | `regex:^https://[a-z0-9-]+\.example\.com$`, `regex:^https://app\.[a-z0-9]+\.example\.com:8443$` | Origins the pattern matches in full |

A pattern has one shape only, so that matching it can never be slow and it can never allow more than you meant:

- an optional `^`, then `https://` or `http://`, then at least two host labels joined by `\.`, then an optional port, then an optional `$`;
- a label is literal, written in lowercase letters, digits and hyphens, or it is the wildcard label, written exactly `[a-z0-9-]+`, `[a-z0-9]+` or `[a-z]+`;
- at most one wildcard label, and never one of the last two labels, so the registered domain is always literal (`regex:^https://[a-z]+\.com$` is refused);
- a port, when there is one, is a number from 1 to 65535 that is not the scheme's default;
- at most 200 characters.

Nothing else is accepted in a pattern: no group, no alternation, no other repetition (`.*`), no other character class, no uppercase letter. Prefer an exact origin or a wildcard; use a pattern only when neither fits.

An entry that is not in one of the three forms is refused when it is saved (`400 ENSC_VALIDATION_FAILED`). An `Origin` header longer than 300 characters is never matched. A change to the list can take up to a minute to apply.

## API versions

`X-ENSC-API-Version` names the date version a request is made against. A version the API does not serve is refused with `400 ENSC_UNSUPPORTED_API_VERSION` (`details.supported` lists the versions served); a request without the header is served as the current version.

- **The minimum version of a key.** An API key can carry a minimum version. A request made with such a key that names an older version is refused with `400 ENSC_UNSUPPORTED_API_VERSION`, and `details.minimum` is the key's minimum. A request that names no version is not refused, and a key without a minimum refuses nothing. One version is served today, so nothing is refused for this reason today.
- **Retirement.** A version that is scheduled for retirement says so on every answer it serves with two response headers: `Deprecation: @<unix seconds>` (when it is, or was, deprecated) and `Sunset: <HTTP date>` (when it stops being served). No version is scheduled today, so no answer carries either header today. With the SDK, pass `onDeprecation` to the client to be called when an answer carries them.

## Request signature (writes)

Every `POST`, `PUT`, `PATCH` and `DELETE` must carry:

```
X-ENSC-Timestamp: <unix seconds>
X-ENSC-Nonce: <unique per request; the SDK uses 18 random bytes, base64url>
X-ENSC-Key-Id: sig_…
X-ENSC-Signature: ed25519=<base64url of the 64-byte signature>
X-ENSC-Idempotency-Key: <8 to 64 URL-safe characters>
```

The signature is Ed25519, with your signing private key, over the UTF-8 bytes of this string (lines joined with a single `\n`):

```
ENSC-V1
{METHOD}                                  upper-case
{PATH}                                    e.g. /v1/conversions, no query string
{sha256_hex(canonical query)}             query pairs sorted by key, URL-encoded, joined with &; the hash of the empty string if none
{sha256_hex(body bytes)}                  the encrypted envelope exactly as sent; the hash of the empty string if no body
{timestamp}
{nonce}
{merchantId}
{idempotencyKey}                          empty string if none
```

Rules ENSC enforces:

- The timestamp must be within 300 seconds of ENSC's clock (`ENSC_TIMESTAMP_OUT_OF_WINDOW`).
- A nonce is accepted once (`ENSC_NONCE_REUSED`). Retries must re-sign with a fresh timestamp and nonce.
- The key id must be one of your signing keys (`ENSC_MISSING_PUBLIC_KEY` if it is not), and that key must be active or rotated less than 24 hours ago (`ENSC_INVALID_SIGNATURE` otherwise).
- Reads (`GET`) are not signed.

## Idempotency

Send `X-ENSC-Idempotency-Key` (or its alias `Idempotency-Key`) on every write. Repeating a request with the same key and the same body returns the original response, with the header `X-ENSC-Idempotent-Replay: true`; the same key with a different body is refused (`409 ENSC_IDEMPOTENCY_CONFLICT`). Keys are scoped to your account and environment, and a final answer is remembered for 24 hours. The SDK generates one per logical call and keeps it constant across its automatic retries.

Only a final answer is remembered: a success, or a refusal that will not change (`400`, `403`, `404`, `422`).

- **An answer that tells you to retry is not remembered.** A `409`, a `429`, any answer with a `Retry-After` header, and any error whose `details` carry `retriable: true` or `retryAfterSeconds` describe the state of things at that moment, not the outcome of your request. Send the request again with the same key and it runs again. A `5xx` is not remembered either.
- **A request that is still running holds its key.** A second request with the same key while the first is in progress is refused with `409 ENSC_IDEMPOTENCY_CONFLICT`. If the first request never finished, its key is free again after 300 seconds, and the next request with that key runs.
- **A secret that is shown once is repeated only to the credential that asked for it.** When the answer to a request carries such a secret (a newly issued credential), a retry with the same key and the same bearer credential receives the same answer. A retry with another credential is refused with `409 ENSC_IDEMPOTENCY_CONFLICT` and `details.reason` `secret_not_repeated`: the request did complete, and its secret is not shown again.

When the SDK reports a failed write whose outcome is open (a network failure, a timeout, a 5xx, a redirect, or an answer that could not be verified), the error carries the key it sent in `details.idempotencyKey`: repeat the call with that key and it cannot execute twice. `details.responseStatus` is the 2xx status when ENSC did carry the request out but its answer could not be verified or opened, and `details.requestSent` is `false` when nothing was sent because ENSC's public keys could not be loaded first.

## Rate limits

Requests are rate-limited per API key (default 600 per minute; a different limit can be set when the key is generated). Exceeding it returns `429 ENSC_RATE_LIMITED`; the SDK does not retry 429.

## Errors

Every error is JSON:

```json
{ "error": { "code": "ENSC_…", "message": "…", "requestId": "req_…", "details": { } } }
```

Quote the `requestId` (also in the `X-ENSC-Request-Id` header) when contacting support. Authentication and authorization codes: `ENSC_MISSING_API_KEY` (401), `ENSC_INVALID_API_KEY` (401), `ENSC_IP_NOT_ALLOWED` (403), `ENSC_INSUFFICIENT_SCOPE` (403), `ENSC_FORBIDDEN` (403), `ENSC_MISSING_SIGNATURE` (401), `ENSC_MISSING_PUBLIC_KEY` (401), `ENSC_INVALID_SIGNATURE` (401), `ENSC_TIMESTAMP_OUT_OF_WINDOW` (401), `ENSC_NONCE_REUSED` (401), `ENSC_DASHBOARD_ONLY` (403), `ENSC_TEST_LIVE_MISMATCH` (400), `ENSC_UNSUPPORTED_API_VERSION` (400), `ENSC_IDEMPOTENCY_CONFLICT` (409).
