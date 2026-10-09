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
X-ENSC-Response-Nonce: <32 random bytes as base64url, exactly 43 characters, fresh for every request>
```

The signature is Ed25519, with your signing private key, over the UTF-8 bytes of this string (lines joined with a single `\n`):

```
ENSC-V2
{METHOD}                                  upper-case
{PATH}                                    e.g. /v1/conversions, no query string
{sha256_hex(canonical query)}             see "The canonical query" below; the hash of the empty string if there is no query
{sha256_hex(body bytes)}                  the encrypted envelope exactly as sent; the hash of the empty string if no body
{timestamp}
{nonce}
{merchantId}
{idempotencyKey}                          empty string if none
{responseNonce}                           the X-ENSC-Response-Nonce you send
```

`X-ENSC-Response-Nonce` asks ENSC to sign and seal its response for this one request (ENSC-RESP-V2, see [Encrypting requests and decrypting responses](./encrypting-decrypting-request.md#response-decryption-ensc-resp-v2)). Signing the value means a write is carried out only with the value you chose.

A write **without** `X-ENSC-Response-Nonce` is signed as ENSC-V1: the same string with `ENSC-V1` as its first line and without the last line. That is what `@ensc/sdk` 0.5.0 and earlier send. It is still accepted, and its response is ENSC-RESP-V1, which is not tied to the request. Use ENSC-V2 in a new integration.

Rules ENSC enforces:

- The timestamp must be within 300 seconds of ENSC's clock (`ENSC_TIMESTAMP_OUT_OF_WINDOW`).
- A nonce is accepted once (`ENSC_NONCE_REUSED`). Retries must re-sign with a fresh timestamp and nonce, and send a fresh response nonce.
- The key id must be one of your signing keys (`ENSC_MISSING_PUBLIC_KEY` if it is not), and that key must be active or rotated less than 24 hours ago (`ENSC_INVALID_SIGNATURE` otherwise).
- The version follows the header. With `X-ENSC-Response-Nonce` the signature must be over the ENSC-V2 string with exactly that value; without it, over the ENSC-V1 string. A write whose header was added, taken away or changed after it was signed does not verify (`ENSC_INVALID_SIGNATURE`) and is not carried out.
- A response nonce that is not 43 base64url characters is refused (`400 ENSC_VALIDATION_FAILED`), on reads and writes alike.
- Reads (`GET`) are not signed. Send `X-ENSC-Response-Nonce` on reads too: the response is then signed and sealed for that read.

A test vector for the ENSC-V2 string. The merchant signing seed is the bytes `00` to `1f` (`AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8`, public key `A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg`); the request is a `POST /v1/conversions` with no query, whose body is the 126 bytes `{"v":1,"encKeyId":"enc_01HZXVECTOR000000000000000","iv":"AAAAAAAAAAAAAAAA","ciphertext":"AAAA","tag":"AAAAAAAAAAAAAAAAAAAAAA"}`:

```
ENSC-V2
POST
/v1/conversions
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
766b4f825d129359eba52a066f27ac01a88b117f04897501822de85369da2aac
1790000000
bm9uY2UtdmVjdG9yLTAwMDAwMDAx
mrc_01HZXVECTOR000000000000000
idm_vector_0001
YGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn8

X-ENSC-Signature
ed25519=0cZeWnpqBaZuyiXaxN3bAcp5Y_hbr3Jj1nbsbLASAFxJ0B_gq1cVWs4erfPUOQGYkuusGKdRnPUkOLwUnqrVCQ
```

The same request without the response nonce is the first nine lines with `ENSC-V1` in place of `ENSC-V2`.

### The canonical query

Both signed strings hash the query of the request in one canonical form. In JavaScript it is `new URLSearchParams(query)`, sorted, then `toString()`. Without it:

1. Take the query string as sent, without the `?`, and split it on `&`. Skip empty pieces. In each piece the text before the first `=` is the name and the rest is the value; a piece without `=` has an empty value.
2. Decode each name and each value as `application/x-www-form-urlencoded`: `+` is a space, `%XX` is one byte, and the bytes are read as UTF-8. A `%` that is not followed by two hex digits stays as it is.
3. Sort the pairs by decoded name, then by decoded value, comparing UTF-16 code units (for ASCII text that is byte order).
4. Write each pair as `name=value` and join the pairs with `&`. Encode each name and value as `application/x-www-form-urlencoded`: a space becomes `+`; the characters `A-Z a-z 0-9 * - . _` stay as they are; every other byte of the UTF-8 text becomes `%XX` in upper-case hex.

No query gives the empty string. **A key that appears more than once** keeps every one of its values under ENSC-V2 and ENSC-RESP-V2: each pair is part of what is signed. Under ENSC-V1 the API reads only the first value of a repeated key, so sign an ENSC-V1 request over one value per key.

| Query string as sent | Canonical query | SHA-256 of the canonical query |
|---|---|---|
| (none) | (empty string) | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `status=succeeded&limit=2` | `limit=2&status=succeeded` | `4d7ef8f5ed84d000ea0f019c83126d42775a0c02cca4dbff6a5f1626a4e98551` |
| `q=a%20b%3Ac&limit=2` (the value is `a b:c`) | `limit=2&q=a+b%3Ac` | `80905aac7dee9d5ffc921c53271169736e4ba4a748a6ee161b4d981a61f7db57` |
| `q=a+b:c&limit=2` (the same value, spelled another way) | `limit=2&q=a+b%3Ac` | `80905aac7dee9d5ffc921c53271169736e4ba4a748a6ee161b4d981a61f7db57` |
| `tag=b&tag=a&tag=b` | `tag=a&tag=b&tag=b` | `20129cea9195cf6223ff40601d1316c144d844e2fbdcbfa8254eacb3045e4747` |
| `name=%C3%A9~&flag` | `flag=&name=%C3%A9%7E` | `1bcc76a18334a64104c9815e7eedca665a46d80ed600ab10585661fe73f94b78` |
| `b=1&=x&a=%2f` | `=x&a=%2F&b=1` | `1e1a939bfa2eb3adb6170caffc6c5fb8a582f7c81dbc55dfd3bc8aa14b18d52a` |

## Idempotency

Send `X-ENSC-Idempotency-Key` (or its alias `Idempotency-Key`) on every write. Repeating a request with the same key and the same body returns the original response, with the header `X-ENSC-Idempotent-Replay: true`; the same key with a different body is refused (`409 ENSC_IDEMPOTENCY_CONFLICT`). Keys are scoped to your account and environment, and a final answer is remembered for 24 hours. The SDK generates one per logical call and keeps it constant across its automatic retries.

Only a final answer is remembered: a success, or a refusal that will not change (`400`, `403`, `404`, `422`).

- **An answer that tells you to retry is not remembered.** A `409`, a `429`, any answer with a `Retry-After` header, and any error whose `details` carry `retriable: true` or `retryAfterSeconds` describe the state of things at that moment, not the outcome of your request. Send the request again with the same key and it runs again. A `5xx` is not remembered either.
- **A request that is still running holds its key.** A second request with the same key while the first is in progress is refused with `409 ENSC_IDEMPOTENCY_CONFLICT`. If the first request never finished, its key is free again after 300 seconds, and the next request with that key runs.
- **A secret that is shown once is repeated only to the credential that asked for it.** When the answer to a request carries such a secret (a newly issued credential), a retry with the same key and the same bearer credential receives the same answer. A retry with another credential is refused with `409 ENSC_IDEMPOTENCY_CONFLICT` and `details.reason` `secret_not_repeated`: the request did complete, and its secret is not shown again.

When the SDK reports a failed write, whatever the status, the error carries the key it sent in `details.idempotencyKey`: repeat the call with that key and it cannot execute twice. That includes a refusal (4xx) since 0.6.0: an error response is not signed, so the SDK does not take one as proof that nothing was carried out. `details.responseStatus` is the 2xx status when ENSC did carry the request out but its answer could not be verified or opened, and `details.requestSent` is `false` when nothing was sent because ENSC's public keys could not be loaded first.

## Rate limits

Requests are rate-limited per API key (default 600 per minute; a different limit can be set when the key is generated). Exceeding it returns `429 ENSC_RATE_LIMITED`; the SDK does not retry 429.

## Errors

Every error is JSON:

```json
{ "error": { "code": "ENSC_…", "message": "…", "requestId": "req_…", "details": { } } }
```

Quote the `requestId` (also in the `X-ENSC-Request-Id` header) when contacting support. Authentication and authorization codes: `ENSC_MISSING_API_KEY` (401), `ENSC_INVALID_API_KEY` (401), `ENSC_IP_NOT_ALLOWED` (403), `ENSC_INSUFFICIENT_SCOPE` (403), `ENSC_FORBIDDEN` (403), `ENSC_MISSING_SIGNATURE` (401), `ENSC_MISSING_PUBLIC_KEY` (401), `ENSC_INVALID_SIGNATURE` (401), `ENSC_TIMESTAMP_OUT_OF_WINDOW` (401), `ENSC_NONCE_REUSED` (401), `ENSC_DASHBOARD_ONLY` (403), `ENSC_TEST_LIVE_MISMATCH` (400), `ENSC_UNSUPPORTED_API_VERSION` (400), `ENSC_IDEMPOTENCY_CONFLICT` (409).
