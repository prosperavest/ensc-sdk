# Changelog

All notable changes to `@ensc/sdk` are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## 0.4.1

Requires API date version `2026-09-15` (unchanged).

### Fixed

- **`@ensc/sdk/web3`**: `signAndBroadcast` estimates gas first (without fee
  fields) and sends with an explicit limit (estimate plus 30 percent, or the
  `gas` you pass). Without a limit some nodes estimate at the block gas limit
  and charge that gas up front during the simulation; on Celo that empties
  the CELO balance the converter then pulls from, and a `crypto-issue` with
  `pair: 'CELO'` failed with `transfer value exceeded balance of sender` from
  any wallet holding less than a few CELO. A failed simulation now raises
  `ENSC_UPSTREAM_FAILED` with the node's reason and broadcasts nothing.
- **`@ensc/sdk/web3`**: the helper refuses a wallet key that is not the
  `from` of the transaction, an RPC endpoint on another chain, and a voucher
  whose `wallet` is not its transaction's signer.
- **`EventDelivery`** now carries every field the API returns: `endpointId`,
  `responseStatus`, `deliveredAt`, `nextAttemptAt`, `responseSnippet`; the
  `status` union is documented. `EventDetail` gains `apiVersion` and
  `dispatchedAt`.
- **`webhookEndpoints.sendTest`** is typed (`SendTestEventResponse`), and its
  doc comment no longer mentions a per-endpoint secret; deliveries are signed
  with ENSC's published Ed25519 key.
- README: the sentence about what ENSC retains was wrong; corrected. New
  sections on unsigned transactions, amounts and decimals, and a complete
  webhooks guide.

- Every `EnscError` now carries `status` (the HTTP status received, so a
  code added by the API later still classifies correctly) and `requestId`
  (from the error body or `X-ENSC-Request-Id`).
- An empty 2xx body is refused as `ENSC_INVALID_SIGNATURE` (`reason:
  'empty_body'`): no route this client calls answers without a sealed
  envelope, so a stripped body is treated like an unsigned one.
- A polyfilled `fetch` that reports the timeout as `AbortError` is now
  recognised as a timeout; a body that cannot be read is retried like a
  network error.
- Webhook verification: the timestamp is signed as the exact header string
  (digits only), a byte body is hashed as received, a repeated header in a
  Node `IncomingHttpHeaders` record is refused instead of thrown on, and a
  verified body that is not an event envelope is refused by `constructEvent`.
- `config.baseUrl` must be https (http is allowed for `localhost` only).
- Type drift: `WebhookEndpoint` and `CreateWebhookEndpointResponse` gain
  `apiVersion`; `EventSummary` gains `apiVersion` and `dispatchedAt` and its
  `status` is the documented `EventOutboxStatus` (`created`, `in_flight`,
  `dispatched`, `abandoned`); `SendTestEventResponse` gains `deliveredVia`;
  `GetBalanceParams` requires `asset` or `contractAddress`.
- CommonJS consumers get matching `.d.cts` declarations (`exports` now names
  `types` per condition).

### Added

- **`Signer`**: `signAndBroadcast` and `executeVoucher` accept a raw private
  key or any viem account (local, custody or KMS via `toAccount`, or the
  JSON-RPC account of a connected wallet). A reverted converter call now
  throws `ENSC_UPSTREAM_FAILED` with the hash instead of returning a result
  to report as confirmed; receipt errors are wrapped the same way.
- **`EnscClient.fetchPublicKeys()`** (also exported as
  `fetchEnscPublicKeys`): loads ENSC's webhook keys as `{ [kid]: publicKey }`.
  `verifyWebhookSignature` and `constructEvent` accept that map and pick the
  key named by `X-ENSC-Key-Id`, so a key rotation needs no redeploy.
- `arbitrum`, `bsc`, `mode` and their testnets `arbitrum-sepolia`, `bsc-testnet`, `mode-sepolia` in `KNOWN_CHAINS` (token-only chains in the registry).
- `ListByEnvParams`: `apiKeys`, `signingKeys`, `encryptionKeys` and `origins`
  `list()` accept an `env` filter, as the API does.
- **`testEvents`** resource: `list()` (`GET /v1/test-data/events`, the
  catalogue with a sample payload per type) and `emit({ eventType, overrides })`
  (`POST /v1/test-data/events`, Sandbox only).
- `UnsignedTransaction.from`: every piece of calldata now names the wallet
  that must sign it (API change of 17 September 2026).
- `BroadcastOptions.gas` and `BroadcastOptions.gasMarginPercent`.

## 0.4.0

Breaking: the API moved from the direct mint / DEX redeem model to the ENSC
converter. Requires API 0.3.0 (date version `2026-09-15`). 0.3.x clients call
routes that no longer exist and receive `ENSC_NOT_FOUND`.

### Added

- **`conversions`**: `create`, `get`, `list`, `quote`, `screening`, `voucher`,
  `payout`, and `conversions.events.{submitted, confirmed, failed}`. Four
  conversion types (`crypto-issue`, `crypto-redeem`, `fiat-issue`,
  `fiat-redeem`); `create` returns a signed voucher with the calldata the
  merchant wallet signs (`approvalTransaction`, `transaction`), or bank-transfer
  `paymentInstructions` for a fiat-issue.
- **`banks.list()`** and **`accounts.resolve()`** (bank directory and account
  name enquiry for the key's environment).
- `CONVERTER_CHAINS`, `ASSETS`, `PAIRS`, `Asset`, `Pair` exports; `celo` and
  `celo-sepolia` in `KNOWN_CHAINS`.
- `@ensc/sdk/web3`: `executeVoucher(issuedVoucher, walletPrivateKey, { rpcUrl })`
  sends the approval then the converter call and returns both hashes;
  `signAndBroadcast` now takes `{ to, data, value, chainId }`, fills gas, fees
  and nonce from the RPC, and returns `{ txHash, status?, blockNumber? }`
  (`waitForReceipt: false` returns as soon as the hash is known).
- Conversion types re-exported: `Conversion`, `ConversionStatus`,
  `IssuedVoucher`, `PaymentInstructions`, `QuoteResponse`, and the create
  parameter unions.

### Changed

- License changed from MIT to Apache-2.0 (see `LICENSE` and `NOTICE`).
  Earlier versions remain under MIT.
- `balance.get` accepts `asset: 'ENSC' | 'USDC' | 'USDT' | 'CELO'`.
- `transfer.create` sends `asset: 'ENSC'` and returns
  `{ unsignedTransaction: { to, data, value: '0', chainId }, chain, amount }`.
- Unsigned transactions no longer carry `gasLimit`, fees or `nonce`; the
  merchant's signer fills them.
- Dependencies: `zod` 4 (was 3), `@noble/curves`, `@noble/hashes` and
  `@noble/ciphers` 2 (were 1). The `api` schema types are zod 4 types; code
  that combines them with its own zod 3 schemas has to move to zod 4 as well.
- The code the SDK bundles now comes from two packages published as source in
  the public SDK repository: `@ensc/protocol` (signing, request envelope,
  sealed responses, errors) and `@ensc/api-schemas` (API types). The public
  exports of `@ensc/sdk` are unchanged. The build puts code shared by
  `@ensc/sdk` and `@ensc/sdk/web3` in one chunk in both module formats.
- Requires Node 20.19+ or 22.12+ (was 20+). The `@noble` 2 packages are ESM
  only; the CommonJS build loads them through `require()` of ES modules, which
  Node supports from those versions (Node 21 does not).

### Removed

- `mint`, `redeem`, `approve`, `withdraw`, `verifyPayout`, `virtualAccounts`,
  `mintLimit` resources and their parameter types.
- `signTransaction` from `@ensc/sdk/web3` (offline signing needs gas and nonce,
  which the API no longer supplies).
- The `lisk` and `lisk-sepolia` chain slugs and the `LSK` asset.

## 0.3.0

Breaking: mandatory request encryption, sealed responses, and removal of the
IMTO and credential-writing surfaces. Requires API version `2026-09-15`
(the new default `X-ENSC-API-Version`). 0.2.x clients stop working against
that API version: plaintext merchant writes are refused with
`ENSC_ENCRYPTION_REQUIRED`, and 0.2.x cannot open sealed responses.

### Added

- **Request encryption (ENSC-ENC-V1).** Every write body is encrypted with
  the merchant's AES-256-GCM `encryptionKey` into a
  `{ v, encKeyId, iv, ciphertext, tag }` envelope whose AAD binds it to the
  method, path, merchant id and key id. The envelope bytes are then signed
  (encrypt-then-sign). Nothing changes in resource method signatures.
- **Sealed responses (ENSC-RESP-V1).** Every successful response is sealed
  to the merchant's signing key with HPKE (RFC 9180 base mode: X25519,
  HKDF-SHA256, ChaCha20-Poly1305) and signed by ENSC. The SDK verifies the
  `X-ENSC-Signature` against ENSC's published Ed25519 keys, checks the
  `X-ENSC-Timestamp` window (`responseMaxSkewSeconds`, default 300), then
  opens the body. Unsigned, badly signed, stale or foreign-key responses are
  rejected (`ENSC_INVALID_SIGNATURE` / `ENSC_DECRYPTION_FAILED`). Errors
  are never sealed and behave as before.
- **Public key discovery.** ENSC's keys are fetched once per process from
  `GET /v1/.well-known/ensc-public-keys.json` and cached; an unknown key id
  triggers a single refetch (ENSC rotation). Pin them with the new
  `enscPublicKeys` config option to avoid the fetch.
- `X-ENSC-Key-Id` is now sent on reads as well as writes, so the API knows
  which registered key to seal the response to.
- `ensc.encryptionKeys.list()`.
- `signingKeys.list()` entries now carry `name` and `expiresAt` (unix
  seconds, set on a rotated key during its 24-hour overlap).
- Exports: `DEFAULT_RESPONSE_MAX_SKEW_SECONDS`, `PUBLIC_KEYS_PATH`,
  `ApproveAsset`.

### Changed

- **Constructor.** `encryptionKey`, `encryptionKeyId`, `signingPrivateKey`
  and `signingKeyId` are now required alongside `apiKey` and `merchantId`.
  Key material is validated at construction (base64url, 32 bytes, `enc_`
  id shape).
- `DEFAULT_API_VERSION` is `2026-09-15`.
- `approve.create()`: `asset` is now an optional uppercase enum
  (`'ENSC' | 'USDC' | 'USDT' | 'LSK'`, default `'ENSC'`) and `spender` is
  optional (omit it to approve the DEX Redeem contract). 0.2.x sent
  `asset: 'ensc'`, which the API rejected.
- `VirtualAccountResponse` now matches what the API returns:
  `{ status: 201, message, data }`.
- `VerifyPayoutResponse`: the field carrying the payout provider's raw status is renamed `providerStatus` (it was previously named after the provider).
- `engines.node` is `>=20` (Web Crypto AES-GCM is used for the request
  envelope).
- Runtime dependencies: `@noble/ciphers` added (ChaCha20-Poly1305), `zod`
  added for the exported `api` types. The published type declarations no
  longer reference unpublished `@ensc/*` workspace packages.

### Removed

- **`ensc.imto`** and all of its sub-resources (`identity`, `fx`, `vaults`,
  `holdings`, `enscx`), together with their exported parameter types
  (`ImtoIdentityGetParams`, `ReferenceRateParams`, `QuotePreviewParams`,
  `VaultListParams`, `VaultGetParams`, `HoldingsSummaryParams`,
  `PositionsListParams`, `PositionGetParams`, `EnscxSummaryParams`,
  `EnscxLedgerListParams`, `EnscxLedgerGetParams`). The matching API routes
  under `/v1/imto/*` no longer exist. The IMTO error codes and `imto:*`
  scopes are gone from the `EnscErrorCode` and scope taxonomies.
- **Credential writes** that the API only ever answered with 403
  `ENSC_DASHBOARD_ONLY`: `apiKeys.create()`, `apiKeys.rotate()`,
  `apiKeys.revoke()`, `signingKeys.revoke()`, `origins.create()`,
  `origins.remove()`. Their exported types `RotateApiKeyResponse`,
  `RevokeApiKeyResponse`, `RevokeSigningKeyResponse` and
  `RemoveOriginResponse` are gone. Manage credentials from the dashboard.
- `ENSC_MISSING_SIGNATURE` is no longer raised by the SDK: a signing key is
  always configured.

### Migration

1. Generate keys again from the dashboard (Sandbox, then Live). You receive
   an API key, an encryption key + id, and a signing key + id. For Live,
   add your egress IPs to the allowlist first.
2. Pass all six values to `EnscClient`; the rest of your code is unchanged.
3. If you call `approve.create()` with `asset`, use the uppercase symbol.
4. If you read the provider-named status field from `verifyPayout`, read
   `providerStatus` instead.
5. Delete any code that called the removed credential methods.

## 0.2.0

Breaking - credential-issuance surface removed from the SDK.

### Removed

- **`ensc.signingKeys.register()`** - was always a dashboard-only operation
  on the server side. The API gates `POST /v1/signing-keys` mutations to
  the dashboard's signed-in sessions (returning `ENSC_DASHBOARD_ONLY` for
  anything else), so this method could never succeed from an SDK consumer
  context. Generate signing keys from the dashboard's Signing Keys tab
  instead; see the README "First-time setup" section.
- **`ensc.signingKeys.generate()`** - same reason as `register()` (it was a
  convenience wrapper around it).
- The exported type `GeneratedSigningKey` is gone with the methods.

### Kept

- **`ensc.signingKeys.list()`** - read your registered signing keys.
- **`ensc.signingKeys.revoke(id)`** - revoke a signing key. Signed with
  another active key; for revoking your last key, use the dashboard.
- **`EnscClient.generateKeypair()`** - still exposed as a utility, but its
  docstring now states that registration is dashboard-only, so this is
  for advanced offline use (verifying key format, etc.), not for the
  normal issuance flow.

### Migration

If you used `ensc.signingKeys.generate()` or `register()`: replace those
calls with a one-time issuance from the dashboard. Receive the private
key + id once, persist as `ENSC_SIGNING_PRIVATE_KEY` and
`ENSC_SIGNING_KEY_ID`, pass to `EnscClient` config. No further changes to
your mint/redeem/transfer code.

## 0.1.2

Patch release.

### Fixed

- **`signingKeys.register()` and `signingKeys.generate()` now actually work
  without an existing signing key**, matching the bootstrap pattern documented
  in the README. Previously the HTTP client treated every `POST` as a signed
  mutation and refused with `ENSC_MISSING_SIGNATURE` before reaching the
  network - making it impossible to register the *first* signing key from
  the SDK. The `register()` call now passes `signed: false` so the bootstrap
  POST is authenticated via the merchant API key alone. The API accepted
  this all along; only the SDK's pre-flight check was wrong.

## 0.1.1

First CI-published release. No functional or API changes from 0.1.0.

### Changed

- **Publishing pipeline.** 0.1.0 was a one-time manual bootstrap publish
  required to register an npm trusted publisher - npm needs the package to
  exist on the registry before a trusted publisher can be attached. From 0.1.1
  onward, every release is published by GitHub Actions via npm trusted
  publishing (OIDC), gated on a `sdk-v*` tag and the `npm-publish` GitHub
  Environment, with no stored npm token. See `docs/sdk-publishing.md`.

## 0.1.0

Initial release.

### Added

- `EnscClient` - the entry point. One instance per merchant; resources hang off
  it as properties.
- Automatic Ed25519 request signing for all mutating endpoints, via
  the shared signing code (the same code the API verifies with - the scheme
  cannot drift between client and server).
- **Web3 resources** - `mint`, `redeem`, `transfer`, `approve`, `withdraw`,
  `virtualAccounts`. `mint` / `redeem` / `transfer` / `approve` return an
  **unsigned transaction**; ENSC never custody-signs or broadcasts.
- **Read resources** - `balance`, `mintLimit`, `verifyPayout` (with a
  `verifyWithdraw` alias), `events`.
- **Management resources** - `apiKeys`, `signingKeys` (including a `generate()`
  convenience that creates a keypair locally and registers the public half),
  `origins`, `webhookEndpoints`.
- Optional `@ensc/sdk/web3` entry point - `signTransaction` and
  `signAndBroadcast` helpers. `viem` is a peer/optional dependency, imported
  lazily; core consumers never load it.
- Webhook verification - `EnscClient.verifyWebhookSignature` (non-throwing) and
  `EnscClient.constructEvent` (throwing), implementing the `ENSC-WH-V1` Ed25519
  delivery scheme.
- Single `EnscError` type for every failure, including network errors, with the
  API's full `code` taxonomy and `isEnscError` / `isEnscErrorCode` /
  `isClientError` / `isServerError` guards.
- Automatic retries for transient failures (network errors, 5xx) with a stable
  idempotency key across retries; 4xx is never retried.
- Pinned `X-ENSC-API-Version` header so API changes can't silently alter
  behavior under a deployed integration.
- Hard browser guard - the SDK refuses to construct in a browser context
  because the API key and signing key are secrets.
- Dual ESM + CJS builds with full type declarations.
- **Self-contained package** - the internal protocol code is bundled into the
  build output (`tsup` `noExternal`); the API schema import is type-only and
  erased at build time. The only runtime `dependencies` are
  `@noble/curves` and `@noble/hashes`. `npm install @ensc/sdk` pulls nothing
  else (`viem` only if the `@ensc/sdk/web3` helper is used). The internal ENSC
  packages do not need to be published to npm.

### Auth model

Two secrets and one identifier: `apiKey` (secret) + `signingPrivateKey` (secret)
+ `signingKeyId` (not secret), plus `merchantId` (not secret). This replaces the
previous SDK's three-secret model - the `ENCRYPTION_KEY` is gone, as the API
does not encrypt request payloads.

### Notes

- `KNOWN_CHAINS` / `ChainSlug` are an autocomplete convenience; any `string` is
  accepted for `chain`. A drift test keeps `KNOWN_CHAINS` in sync with the
  platform's chain registry, outside the SDK's runtime bundle.
- The `redeem` endpoint's asset values are uppercase (`ENSC` / `USDC` / `USDT` /
  `LSK`) while other endpoints use lowercase - the SDK mirrors the API's types
  faithfully rather than papering over the inconsistency.
