# Authorization

Every request carries your API key. Every write also carries an Ed25519 signature. `@ensc/sdk` adds both automatically.

## API key

```
Authorization: Bearer ensc_live_sk_…
X-ENSC-API-Version: 2026-09-15
X-ENSC-Key-Id: sig_…
```

- The key's prefix encodes the environment (`ensc_test_` / `ensc_live_`) and type (`sk` secret, `rk` restricted, `pk` publishable). A test key cannot touch live resources and vice versa (`ENSC_TEST_LIVE_MISMATCH`).
- `X-ENSC-API-Version` pins the contract you were built against. The current version is `2026-09-15`.
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

The keys the dashboard generates carry all four by default. A secret key also manages webhook endpoints and reads the event log without a dedicated scope. A restricted key needs `webhooks:read` to list endpoints and read events, and `webhooks:manage` to create, change, test or delete endpoints; `api-keys:read` and `api-keys:manage` are reserved and not yet required by any route.

Publishable keys can hold only `balances:read`. Issuing, rotating and revoking any key, and editing IP allowlists or CORS origins, are dashboard actions and are refused from API keys (`403 ENSC_DASHBOARD_ONLY`).

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

Send `X-ENSC-Idempotency-Key` (or its alias `Idempotency-Key`) on every write. Repeating a request with the same key and the same body returns the original response; the same key with a different body is refused (`409 ENSC_IDEMPOTENCY_CONFLICT`). Keys are scoped to your account and remembered for 24 hours. The SDK generates one per logical call and keeps it constant across its automatic retries.

## Rate limits

Requests are rate-limited per API key (default 600 per minute; a different limit can be set when the key is generated). Exceeding it returns `429 ENSC_RATE_LIMITED`; the SDK does not retry 429.

## Errors

Every error is JSON:

```json
{ "error": { "code": "ENSC_…", "message": "…", "requestId": "req_…", "details": { } } }
```

Quote the `requestId` (also in the `X-ENSC-Request-Id` header) when contacting support. Authentication and authorization codes: `ENSC_MISSING_API_KEY` (401), `ENSC_INVALID_API_KEY` (401), `ENSC_IP_NOT_ALLOWED` (403), `ENSC_INSUFFICIENT_SCOPE` (403), `ENSC_MISSING_SIGNATURE` (401), `ENSC_MISSING_PUBLIC_KEY` (401), `ENSC_INVALID_SIGNATURE` (401), `ENSC_TIMESTAMP_OUT_OF_WINDOW` (401), `ENSC_NONCE_REUSED` (401), `ENSC_DASHBOARD_ONLY` (403), `ENSC_TEST_LIVE_MISMATCH` (400).
