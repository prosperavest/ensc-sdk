# Changelog

All notable changes to `@ensc/sdk`. This project follows
[Semantic Versioning](https://semver.org/).

## 0.6.0

Requires API date version `2026-09-15`, on an API that answers in
ENSC-RESP-V2. The ENSC API does from 5 October 2026.

### Changed

- A sealed response is now checked against the request it answers. The SDK
  sends a fresh random value with every call, reads included, in the request
  header `X-ENSC-Response-Nonce`, and accepts a successful response only if
  ENSC signed and sealed it for that value, for the method, path and query of
  the call, and for your own `merchantId` and `signingKeyId` (response version
  ENSC-RESP-V2). A response ENSC made for another request or for another
  account, or one played back from an earlier call, is refused with
  `ENSC_INVALID_SIGNATURE`. Until now the SDK checked that a response was
  signed by ENSC and recent, not which request it answered. `merchantId` and
  `signingKeyId` must therefore be your own on reads too; a write already
  needed them.
- A response in the earlier version (ENSC-RESP-V1), which names no request, is
  no longer accepted: `ENSC_INVALID_SIGNATURE` with `details.reason`
  `response_not_bound`. There is no option that accepts one.
- A write is signed as ENSC-V2: the ENSC-V1 string under the version line
  `ENSC-V2`, with the response nonce as one more line, so your signature
  covers the value. An API that does not verify ENSC-V2 refuses such a write
  with `ENSC_INVALID_SIGNATURE` (401) and carries nothing out.
- A retried call sends a new value with each attempt; the idempotency key
  stays the same, as before.
- Every failed write carries `details.idempotencyKey`, a refusal (4xx)
  included. Until now a 4xx did not. An error response is not signed, so the
  SDK no longer takes a 4xx as proof that nothing was carried out: repeat a
  write with the key the error names, never under a new one. To tell a refusal
  from an open outcome, look at the status (`isClientError`), not at whether
  the key is there.
- Documentation of `conversions.events.failed`: the API refuses `failed`
  while the voucher of the conversion can still be executed
  (`409 ENSC_INVALID_STATE`, `details.reason` `voucher_live`, with
  `details.retryAfterSeconds`) and after a voucher was executed
  (`details.reason` `voucher_used`: report `onchain_confirmed` with the
  transaction hash). No change to the method itself.

Nothing changes in how you call the SDK, in the credentials or in webhook
verification. Error responses are not sealed, as before; the one change to
them is the added `details.idempotencyKey` on a refused write. SDK 0.5.0 and earlier keep working unchanged: a request
without the header is answered in ENSC-RESP-V1, as before. The wire formats
and test vectors are in `docs/encrypting-decrypting-request.md` and
`packages/ensc-protocol/tests/response.test.ts`.

## 0.5.0

Requires API date version `2026-09-15`.

### Added

- `merchantId` and `env` on `constructEvent` and `verifyWebhookSignature`. The
  signed body of a delivery names the merchant and the environment it belongs
  to; with the two options a delivery signed for another merchant, or for the
  other environment, is refused (`merchant_mismatch`, `env_mismatch`). Pass
  both in every receiver. The verified event exposes `merchantId`, `env` and
  `synthetic` (`true` on a test delivery; ignore it in Live).
- `EnscClient.webhookKeyCache()` (also exported as
  `createEnscWebhookKeyCache`): keeps ENSC's webhook keys between deliveries.
  `get(headers)` loads the key document on first use and again for an unknown
  key id, at most once per interval (`minRefreshIntervalMs`, default
  `WEBHOOK_KEY_REFRESH_INTERVAL_MS`, one minute). Use it in place of calling
  `fetchPublicKeys` from a webhook handler.
- `onDeprecation` client option and the `DeprecationNotice` type: called, at
  most once per request, when an answer carries the `Deprecation` or `Sunset`
  response header of an API version scheduled for retirement.
- `plume` and `plume-testnet` in `KNOWN_CHAINS`.
- Error details on a failed write whose outcome is open:
  `details.idempotencyKey` (the key that was sent; repeat with it),
  `details.responseStatus` (the 2xx status when the request was carried out
  but its answer could not be verified or opened) and `details.requestSent`
  (`false` when nothing was sent).

### Changed

- `ethereum` and `sepolia` are removed from `KNOWN_CHAINS`, `MAINNET_CHAINS`,
  `TESTNET_CHAINS` and the `ChainSlug` type: the API does not serve them
  (`ENSC_INVALID_CHAIN`). `KNOWN_CHAINS` is now every chain the API can
  serve; a chain that a deployment has not enabled still answers
  `ENSC_INVALID_CHAIN`. Request methods accept any string, as before.
- A write loads ENSC's public keys before it is sent (once per client; not at
  all when they are pinned with `enscPublicKeys`), and a key fetch that fails
  is tried up to three times. A write that succeeded is no longer reported as
  failed because the keys could not be loaded afterwards.
- A redirect is never followed, by the client or by `fetchPublicKeys`; a 3xx
  answer is `ENSC_UPSTREAM_FAILED` and is not retried.
- `toleranceSeconds` that is not a finite number of zero or more is refused
  (`invalid_tolerance`); only an explicit `0` turns the timestamp check off.
- `fetchPublicKeys` requires an https base URL (http for `localhost` only) and
  keeps only keys of 32 bytes.
- The web3 helper's error messages never contain the RPC URL.
- The credential and origin lists hold the environment of the key that asks;
  a restricted key needs `api-keys:read` for them.
- `webhookEndpoints.create` and `webhookEndpoints.update`: the URL is checked
  when it is saved. It must be https, on the default port, with a public host
  name and no credentials; a port other than the default, a host name ending
  in a dot, an IP address, a single-label or private name and a host under
  `prosperavest.com` are refused with `ENSC_VALIDATION_FAILED` (400);
  `details.fields` names the field (`url`).
- A request the API's schema refuses (`ENSC_VALIDATION_FAILED`, 400) is
  answered with the refused fields only: `details.fields` holds each field
  once as `{ path, message: "invalid value" }`, at most 25. It no longer
  carries the schema's message or code for a field, so do not read a reason
  from `message`; check the value against the reference for that field. No
  SDK code changed: the SDK passes `details` through as it is.
- `conversions.events.failed` is refused for a `fiat-issue` whose payment has
  been received: `ENSC_INVALID_STATE` (409) with `details.reason`
  `payment_received`. Call `voucher(reference)` for a new voucher instead. A
  `fiat-issue` that failed and is paid afterwards moves to
  `requires_manual_review`, and `conversion.requires_manual_review` is sent.
- Allowed origins (`origins.list`): an entry is an exact origin in the form a
  browser sends it (lowercase host, no path, no default port), a wildcard
  whose star is the whole first label with at least two labels after it
  (`https://*.example.com`), or a pattern of one fixed shape; anything else is
  refused when it is saved in the dashboard.
- A reported transaction hash can be replaced until a receipt is verified.
  `ENSC_SETTLEMENT_VERIFICATION_FAILED` with `details.voucherReissuable`
  `true` means the reported transaction is dead: call `voucher(reference)`.
- Voucher failures are reported as `ENSC_VOUCHER_UNAVAILABLE` (503, safe to
  retry) and `ENSC_VOUCHER_REFUSED` (422, with `details.reason`).
  `EnscErrorCode` lists both.
- `IssuedVoucher` is `{ voucher, signature, domain, expiresAt, approvalToken,
  approvalTransaction, transaction }`.
- A conversion's `screening.status` is one of `APPROVED`, `IN_REVIEW`,
  `DECLINED`, `AWAITING_USER` and `SKIPPED`. `SKIPPED` means the conversion
  was not screened and was let through; it is not an approval.
- `webhookEndpoints.sendTest` answers `deliveredVia: "background"`.
- The API refuses an `X-ENSC-API-Version` it does not serve with
  `400 ENSC_UNSUPPORTED_API_VERSION`; the SDK sends a supported one.
- A list's `nextCursor` is valid for 24 hours, on the list and filters that
  issued it.
- Integer query values are plain decimal digits, and amounts are plain
  decimal strings within the asset's range (`ASSET_AMOUNT_LIMITS`).

## 0.4.1

Requires API date version `2026-09-15`.

### Added

- `Signer`: `signAndBroadcast` and `executeVoucher` accept a raw private key
  or any viem account (local, custody or KMS through `toAccount`, or the
  JSON-RPC account of a connected wallet).
- `EnscClient.fetchPublicKeys()` (also exported as `fetchEnscPublicKeys`):
  loads ENSC's webhook keys as `{ [kid]: publicKey }`.
  `verifyWebhookSignature` and `constructEvent` accept that map and pick the
  key named by `X-ENSC-Key-Id`.
- `testEvents`: `list()` and `emit({ eventType, overrides })`.
- `ListByEnvParams`: `apiKeys`, `signingKeys`, `encryptionKeys` and `origins`
  `list()` accept an `env` filter.
- `UnsignedTransaction.from`: every piece of calldata names the wallet that
  must sign it.
- `BroadcastOptions.gas` and `BroadcastOptions.gasMarginPercent`.
- `arbitrum`, `bsc`, `mode` and their testnets in `KNOWN_CHAINS`.

### Changed

- `signAndBroadcast` estimates gas and sends with an explicit limit (the
  estimate plus 30 percent, or the `gas` you pass). A failed simulation
  raises `ENSC_UPSTREAM_FAILED` and broadcasts nothing; a reverted converter
  call raises it with `details.txHash`.
- The web3 helper refuses a signer that is not the `from` of the
  transaction, an RPC endpoint on another chain, and a voucher whose `wallet`
  is not its transaction's sender.
- Every `EnscError` carries `status` and `requestId`.
- An empty 2xx body is refused (`ENSC_INVALID_SIGNATURE`).
- `config.baseUrl` must be https (http for `localhost` only).
- Types carry every field the API returns: `EventDelivery`, `EventDetail`,
  `EventSummary`, `WebhookEndpoint`, `CreateWebhookEndpointResponse` and
  `SendTestEventResponse`. `GetBalanceParams` requires `asset` or
  `contractAddress`.
- CommonJS consumers get matching `.d.cts` declarations.

## 0.4.0

Breaking. Requires API date version `2026-09-15`. Conversions replace the
earlier mint and redeem resources.

### Added

- `conversions`: `create`, `get`, `list`, `quote`, `screening`, `voucher`,
  `payout`, and `conversions.events.{submitted, confirmed, failed}`. Four
  types (`crypto-issue`, `crypto-redeem`, `fiat-issue`, `fiat-redeem`);
  `create` returns a signed voucher with the calldata the merchant wallet
  signs, or bank transfer `paymentInstructions` for a `fiat-issue`.
- `banks.list()` and `accounts.resolve()`.
- `CONVERTER_CHAINS`, `ASSETS`, `PAIRS`, `Asset` and `Pair`; `celo` and
  `celo-sepolia` in `KNOWN_CHAINS`.
- `@ensc/sdk/web3`: `executeVoucher` sends the approval, then the converter
  call, and returns both hashes. `signAndBroadcast` takes
  `{ to, data, value, chainId }`, fills gas, fees and nonce from the RPC and
  returns `{ txHash, status?, blockNumber? }`.
- Conversion types: `Conversion`, `ConversionStatus`, `IssuedVoucher`,
  `PaymentInstructions`, `QuoteResponse` and the create parameter unions.

### Changed

- License: Apache-2.0 (see `LICENSE` and `NOTICE`). Earlier versions remain
  under MIT.
- `balance.get` accepts `asset: 'ENSC' | 'USDC' | 'USDT' | 'CELO'`.
- `transfer.create` sends `asset: 'ENSC'` and returns
  `{ unsignedTransaction: { to, data, value: '0', chainId }, chain, amount }`.
- Unsigned transactions carry no gas, fee or nonce fields; the wallet that
  signs fills them.
- Dependencies: `zod` 4, and `@noble/curves`, `@noble/hashes` and
  `@noble/ciphers` 2. Requires Node 20.19+ or 22.12+.

### Removed

- The `mint`, `redeem`, `approve`, `withdraw`, `verifyPayout`,
  `virtualAccounts` and `mintLimit` resources and their parameter types.
- `signTransaction` from `@ensc/sdk/web3`.
- The chain slugs and asset of a network that is no longer served.

## 0.3.0

Breaking. Requires API date version `2026-09-15`.

- Every write body is encrypted (ENSC-ENC-V1) and every successful response
  is sealed to the merchant's signing key and signed by ENSC (ENSC-RESP-V1).
  The SDK verifies and opens each response before returning it.
- The constructor requires `encryptionKey`, `encryptionKeyId`,
  `signingPrivateKey` and `signingKeyId` beside `apiKey` and `merchantId`.
- ENSC's public keys are fetched from
  `GET /v1/.well-known/ensc-public-keys.json` once per process, or pinned
  with `enscPublicKeys`.
- `X-ENSC-Key-Id` is sent on reads as well as writes.
- `encryptionKeys.list()`.
- Credentials are issued, rotated and revoked in the dashboard; the SDK
  methods that wrote them are removed.

## 0.2.0 and earlier

These releases target API contracts that no longer exist. Use 0.4.0 or
later.
