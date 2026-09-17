# @ensc/sdk

Official client SDK for the ENSC API: typed end to end, server-side, with automatic request encryption, Ed25519 request signing and sealed-response verification.

## Install

```sh
npm install @ensc/sdk
# the web3 helper (optional) also needs viem:
npm install @ensc/sdk viem
```

Requires Node 20.19+ or 22.12+ (or any modern runtime with `fetch` and Web Crypto: Workers, Deno, Bun).

## Server-side only

The SDK is built for backend use. Every credential it holds is a **secret** and must never reach a browser bundle. `EnscClient` refuses to construct in a browser context. Do not ship it to end users.

## Credentials: three secrets and three identifiers

The dashboard issues all six values together when you generate keys (Sandbox once your business profile is complete; Live after business verification is approved). Pass them to the constructor; the SDK does the rest.

| Value | Secret? | Purpose |
| --- | --- | --- |
| `apiKey` | **yes** | `Authorization: Bearer`. Identifies the merchant, carries env + scopes. `ensc_live_sk_…` or `ensc_test_sk_…`. |
| `encryptionKey` | **yes** | 32-byte AES-256-GCM key, base64url. Encrypts every request body before it leaves your server (ENSC-ENC-V1). |
| `encryptionKeyId` | no | The `enc_…` id of that key. Travels inside the envelope so the API knows which key to decrypt with. |
| `signingPrivateKey` | **yes** | Ed25519 seed, base64url. Signs every write (ENSC-V1) and is the key every sealed response is opened with (ENSC-RESP-V1). |
| `signingKeyId` | no | The id of the registered public key. Sent as `X-ENSC-Key-Id` on every request. |
| `merchantId` | no | `mrc_…`. Bound into every signature and every encrypted envelope. |

What happens on the wire, for every call:

1. **Writes** are serialized to JSON, encrypted with `encryptionKey` into an envelope bound to the method, path, merchant and key id, then the envelope bytes are signed with `signingPrivateKey`. The API refuses plaintext merchant writes; there is no downgrade.
2. **Every successful response** arrives sealed to your signing key (HPKE, RFC 9180: X25519 + HKDF-SHA256 + ChaCha20-Poly1305) and signed by ENSC. The SDK verifies ENSC's signature against the published key set, checks the timestamp window, and only then opens the body. A response that is not sealed, not signed, or sealed to another key is rejected.
3. **Errors** are never sealed, so a 4xx/5xx is always readable and maps to a typed `EnscError`.

ENSC's response-signing public keys are fetched once per `EnscClient` from `GET /v1/.well-known/ensc-public-keys.json` and cached. To remove that dependency (locked-down egress), pin them with `enscPublicKeys: { [kid]: publicKey }`.

## Quick start

```ts
import { EnscClient } from '@ensc/sdk';

const ensc = new EnscClient({
  apiKey: process.env.ENSC_API_KEY!,
  merchantId: process.env.ENSC_MERCHANT_ID!,
  encryptionKey: process.env.ENSC_ENCRYPTION_KEY!,
  encryptionKeyId: process.env.ENSC_ENCRYPTION_KEY_ID!,
  signingPrivateKey: process.env.ENSC_SIGNING_PRIVATE_KEY!,
  signingKeyId: process.env.ENSC_SIGNING_KEY_ID!,
});

// Read: the response is sealed to your key and opened for you
const balance = await ensc.balance.get({
  account: '0x…',
  chain: 'celo',
  asset: 'ENSC',
});

// Write: encrypted and signed automatically. Pay 100 USDC in, receive ENSC.
const conversion = await ensc.conversions.create({
  type: 'crypto-issue',
  chain: 'celo',
  wallet: '0x…', // the wallet that will sign; the voucher binds to it
  pair: 'USDC',
  amount: '100',
});
```

### First-time setup: generate keys in the dashboard

Credentials are issued by the dashboard, not the SDK. Go to https://app.prosperavest.com, pick **Sandbox** or **Live**, and open the **Credentials** tab:

1. Click **Generate keys**. For Live, you must first add at least one IP address or CIDR to the allowlist; live keys are refused without one.
2. The dashboard creates the API key, the encryption key and an Ed25519 signing keypair, registers the public halves with ENSC, and shows the **secrets exactly once**.
3. Copy all six values immediately. ENSC keeps a hash of your API key, the public half of your signing key, and your encryption key wrapped under its own key (it needs it to decrypt your requests). None of them can be shown again.
4. Wire them into your backend's environment:

```sh
ENSC_API_KEY=ensc_live_sk_…
ENSC_MERCHANT_ID=mrc_…
ENSC_ENCRYPTION_KEY=…base64url, 43 chars…
ENSC_ENCRYPTION_KEY_ID=enc_…
ENSC_SIGNING_KEY_ID=sig_…
ENSC_SIGNING_PRIVATE_KEY=…base64url, 43 chars…
```

The SDK cannot issue, rotate or revoke credentials: those paths are gated server-side to the dashboard (`ENSC_DASHBOARD_ONLY`). What the SDK can do is inventory them: `ensc.apiKeys.list()`, `ensc.signingKeys.list()`, `ensc.encryptionKeys.list()`.

### Rotation

Rotate any of the three keys from the dashboard. The previous key keeps working for **24 hours** after rotation so you can roll the new value through your deployment without downtime; revocation is immediate. `signingKeys.list()` shows `expiresAt` on a rotated key.

### IP allowlist

Live API keys only work from the IP addresses on their allowlist (up to 32 IPv4/IPv6 addresses or CIDRs, managed in the dashboard). A request from elsewhere gets `ENSC_IP_NOT_ALLOWED`. Sandbox keys are not restricted.

## Conversions

A conversion is one operation on the ENSC converter. Four types:

| Type | You put in | You get out | `amount` means |
| --- | --- | --- | --- |
| `crypto-issue` | a pair token (`USDC`, `USDT`, `CELO`) | ENSC | pair token amount |
| `crypto-redeem` | ENSC | a pair token | ENSC amount |
| `fiat-issue` | a Naira bank transfer | ENSC | NGN (2 dp), ENSC one to one |
| `fiat-redeem` | ENSC | a Naira bank payout | ENSC (2 dp), NGN one to one |

ENSC never holds a wallet key and never broadcasts. `create` returns a signed **voucher** with the calldata your wallet must sign: an optional `approvalTransaction` (ERC-20 approve to the converter) and then `transaction` (the converter call). After broadcasting, report the hash back; the API verifies the receipt and completes the conversion or starts the Naira payout.

```ts
const c = await ensc.conversions.create({
  type: 'crypto-issue', chain: 'celo', wallet, pair: 'USDC', amount: '100',
});
// c.status === 'voucher_issued'; c.voucher.transaction is { from, to, data, value: '0', chainId }

// Option A: the optional helper (needs `viem`) sends the approval, then the converter call
import { executeVoucher } from '@ensc/sdk/web3';
const { transaction } = await executeVoucher(c.voucher!, walletPrivateKey, { rpcUrl });
await ensc.conversions.events.confirmed(c.reference, transaction.txHash);

// Option B: sign with your own infrastructure, then report
await ensc.conversions.events.submitted(c.reference, txHash);   // broadcast
await ensc.conversions.events.confirmed(c.reference, txHash);   // mined
```

The second argument of `executeVoucher` and `signAndBroadcast` is the **signer**: a raw wallet private key, or any viem account (`privateKeyToAccount`, `mnemonicToAccount`, `toAccount` around an HSM, KMS or custody signer, or the JSON-RPC account of a wallet a user connected). It is a **separate** secret from the ENSC credentials, never touches the ENSC API and is never stored by the SDK; pass it per call and never put it in `EnscClient` config. The wallet must be the `wallet` named on the conversion; the helper refuses a signer for another address, and an RPC endpoint on another chain. A browser wallet (wallet-connect style) signs the same `{ from, to, data, value, chainId }` calldata directly; nothing about ENSC requires exporting a private key.

### Unsigned transactions

Every piece of calldata ENSC returns has the same shape: `{ from, to, data, value: '0', chainId }`. `from` is the wallet that must sign it, `to` is the token (approval) or the converter (the call), `value` is always `'0'` (ENSC never asks for native value), and `chainId` names the chain. Gas, fees and nonce are yours to fill.

`signAndBroadcast` estimates gas first, without fee fields, and sends with that estimate plus 30 percent (`gasMarginPercent`), or with the limit you pass as `gas`. Do not skip the limit when signing with your own infrastructure: without one, some nodes estimate at the block gas limit and charge that much gas up front during the simulation. On Celo the native balance is also the CELO ERC-20 balance, so a converter call that pulls CELO then sees an almost empty wallet and reverts with `transfer value exceeded balance of sender` unless the wallet holds several CELO more than the amount.

If the estimate fails, nothing is broadcast and the node's reason is in the `ENSC_UPSTREAM_FAILED` message. Report the conversion failed (`events.failed`) so it does not linger.

A `fiat-redeem` needs `payout: { bankCode, accountNumber, accountName }`; resolve the account first with `ensc.accounts.resolve(...)` so the name matches the bank record (the API refuses a mismatch), and list banks with `ensc.banks.list()`. Once the burn is verified on chain the payout is initiated for you; `payout.succeeded` arrives by webhook.

A `fiat-issue` needs `payer: { email, name?, phone? }` and returns `paymentInstructions` (a bank account to transfer the Naira to) instead of a voucher. When the transfer is confirmed the voucher is issued; fetch it with `get` or force it with `voucher(reference)`.

A conversion can come back with `status: 'screening_hold'` (HTTP 202) while transaction screening reviews it; poll `screening(reference)` or listen for `conversion.voucher_issued`, then call `voucher(reference)`. Vouchers expire after about ten minutes; `voucher(reference)` issues a fresh one (crypto legs are re-quoted).

`quote({ type, chain, pair, amount })` prices a crypto leg without creating anything. `transfer.create` builds a plain ENSC transfer in the same `{ from, to, data, value, chainId }` shape.

If `create` is cut off between the insert and the voucher (a timeout, a signer or bank-rail error), the conversion stays `created` with `lastError` set. Re-posting the same `reference` finishes it (HTTP 200) instead of returning the stuck row; `voucher(reference)` does the same.

### Amounts and decimals

Amounts you send are decimal strings in the asset's own units: `'0.1'` CELO, `'100'` USDC, `'1000.00'` NGN. Fiat amounts take at most 2 decimals; a crypto amount may not have more decimals than the asset (`ENSC_VALIDATION_FAILED` otherwise).

Amounts the API returns are base-unit integer strings (`amountIn`, `amountOut`, `balance`, the voucher fields) with a decimal twin already divided by the asset's decimals (`amountInFormatted`, `amountOutFormatted`, `formatted`). Decimals: ENSC 18, CELO 18, USDC and USDT 6; NGN legs are stored as ENSC units (18) with the Naira principal in `fiatAmountNgn` (2 dp). Do arithmetic on the base units with `BigInt`, never on the formatted strings and never with floating point.

## Webhooks

ENSC tells your backend what happened by POSTing signed events to an https URL you own. This is how every conversion and payout outcome reaches you without polling.

**How it works**

1. **Register an endpoint**: a public https URL on your backend, in the dashboard (Sandbox or Live, Webhooks tab) or with `ensc.webhookEndpoints.create({ env, url, eventTypes })`. `eventTypes: ['*']` subscribes to everything. The URL must be https with a public hostname; `localhost`, IP addresses and single-label hosts are refused. Sandbox and Live endpoints are separate.
2. **Receive deliveries**: `POST` with a JSON body `{ id, type, apiVersion, created, data }`. `data` is the same object the read API returns for that resource (a conversion, or a payout summary). Headers: `X-ENSC-Signature` (`ed25519=<base64url>`), `X-ENSC-Timestamp`, `X-ENSC-Webhook-Id`, `X-ENSC-Key-Id`, `X-ENSC-Event-Type`, `X-ENSC-Event-Id`, `X-ENSC-API-Version`.
3. **Verify before parsing**: the signature is Ed25519 over `ENSC-WH-V1\n<webhookId>\n<timestamp>\n<sha256 of the raw body>`, made with ENSC's key named by `X-ENSC-Key-Id` and published at `/v1/.well-known/ensc-public-keys.json` (`use: webhooks`). `EnscClient.fetchPublicKeys()` loads them as `{ [kid]: publicKey }`; pass that map to the verifier and a key rotation needs no redeploy. There is no shared secret to store or rotate. Deliveries older than five minutes are refused by the verifier.
4. **Answer 2xx fast, then do the work**: ENSC waits 15 seconds. Queue the event and return `200`; do bank calls, order fulfilment and chain lookups afterwards.
5. **Expect retries and duplicates**: delivery is at least once. A non-2xx answer or a timeout is retried after 1 min, 5 min, 15 min, 1 h, 2 h, 4 h and 8 h (8 attempts in total over about 15 hours), then marked `gave_up`. The same event `id` is reused on every attempt: de-duplicate on it before applying side effects.
6. **Do not rely on order**: successive events for one conversion can arrive out of order. Act on the `status` the event carries, and before releasing goods or money read the conversion back with `ensc.conversions.get(reference)`.

```ts
import { EnscClient } from '@ensc/sdk';

const enscKeys = await EnscClient.fetchPublicKeys(); // { [kid]: publicKey }; cache it, refetch on an unknown kid

// In your webhook route (Express, Next.js route handler, a worker, ...):
const event = EnscClient.constructEvent({
  body: rawRequestBody,       // string or bytes, exactly as received, before any JSON parsing
  headers: request.headers,   // Headers instance or a plain record (Node's req.headers works)
  publicKey: enscKeys,        // the verifier picks the key named by X-ENSC-Key-Id
});
if (await alreadyHandled(event.id)) return new Response(null, { status: 200 });
await queue.push(event);        // process after answering
return new Response(null, { status: 200 });
```

`constructEvent` throws `EnscError('ENSC_INVALID_SIGNATURE')` on failure. For non-throwing checks use `EnscClient.verifyWebhookSignature(...)`, which returns `{ valid, reason? }`.

**Event types**: `conversion.created`, `conversion.screening_hold`, `conversion.awaiting_payment`, `conversion.payment_confirmed`, `conversion.voucher_issued`, `conversion.onchain_confirmed`, `conversion.settled`, `conversion.succeeded`, `conversion.failed`, `conversion.requires_manual_review`, `payout.initiated`, `payout.succeeded`, `payout.failed`. Credit your customer on `conversion.succeeded` (or `payout.succeeded` for a fiat-redeem), never earlier.

**Testing your receiver**: deploy it to the public URL you will register (the same hosting your backend uses), register that URL in Sandbox, then queue signed test deliveries: `ensc.webhookEndpoints.sendTest(id, { eventType: 'payout.succeeded' })` queues one event of that type, with the fields a real one carries, in that endpoint's environment; every active endpoint there that subscribes to the type receives it, and the response says whether the endpoint you named is among them (`willDeliverToTargetEndpoint`). `ensc.testEvents.emit({ eventType })` does the same for the whole Sandbox stream. A Live endpoint accepts only `synthetic.test_event`, so a real event type can never be forged into a Live receiver. `ensc.events.get(eventId)` shows each delivery attempt with your endpoint's HTTP answer, and `ensc.events.list()` is the log. Nothing in ENSC needs a tunnel or a request inspector; those only stand in for a deployed URL during local development.

**Scopes**: a secret key manages webhooks and reads the event log. A restricted key needs `webhooks:read` to list and read, `webhooks:manage` to create, change, test or delete endpoints.

## Error handling

Every failure, including network errors, throws a single `EnscError` type with the same `code` taxonomy the API uses.

```ts
import { EnscError, isEnscError, isEnscErrorCode } from '@ensc/sdk';

try {
  await ensc.conversions.create({ … });
} catch (err) {
  if (isEnscErrorCode(err, 'ENSC_RESERVE_INSUFFICIENT')) {
    // err.details.maxAmountIn is the largest ENSC amount redeemable right now
  } else if (isEnscError(err)) {
    console.error(err.code, err.status, err.message, err.details);
  }
}
```

Codes the SDK itself raises on the response path: `ENSC_INVALID_SIGNATURE` (response not signed by a known ENSC key, or outside the timestamp window) and `ENSC_DECRYPTION_FAILED` (sealed body could not be opened with your signing key, usually a mismatched `signingKeyId`/`signingPrivateKey` pair).

Transient failures (network errors, timeouts, 500, 502, 503 and 504) are retried automatically (`maxRetries`, default 2); 4xx and 429 are never retried. Every write carries a stable idempotency key across those retries, and the API honours it on every write route, so a transparently retried POST cannot double-execute. Every `EnscError` carries `status` (the HTTP status received), `requestId` (from `X-ENSC-Request-Id`, quote it to support) and, where the API sent them, `details`.

## Chains

`chain` is a string at the API boundary. The SDK exports a `ChainSlug` union and `KNOWN_CHAINS` for autocomplete, but any string is accepted; an unknown or disabled chain comes back as `ENSC_INVALID_CHAIN`. Conversions run on `CONVERTER_CHAINS.live` (`celo`) with a live key and `CONVERTER_CHAINS.test` (`celo-sepolia`) with a test key; a key never reaches the other environment's chain. The API is multichain by registry: a chain is added by configuration, with no change to your integration beyond naming the new slug, and a new converter chain is announced in the changelog.

## API surface

| Area | Resource | Methods |
| --- | --- | --- |
| Conversions | `conversions` | `create`, `get`, `list`, `quote`, `screening`, `voucher`, `payout` |
| Conversions | `conversions.events` | `submitted`, `confirmed`, `failed` |
| Banking | `banks` | `list` |
| Banking | `accounts` | `resolve` |
| Transfers | `transfer` | `create` |
| Reads | `balance` | `get` |
| Reads | `events` | `list`, `get` |
| Sandbox | `testEvents` | `list`, `emit` |
| Management | `apiKeys` `signingKeys` `encryptionKeys` `origins` | `list` |
| Management | `webhookEndpoints` | `create`, `list`, `get`, `update`, `remove`, `sendTest` |

## Verifying this package

`@ensc/sdk` is staged only by GitHub Actions, from `sdk-v*` release tags, using npm trusted publishing (OIDC), and goes live only when a maintainer approves the staged version with 2FA. There is no long-lived npm token. Every published version is registry-signed; run `npm audit signatures` after installing to verify it. A legitimate release has exactly four runtime dependencies (`@noble/ciphers`, `@noble/curves`, `@noble/hashes`, and `zod` for the exported API types), an optional `viem` peer, and **no install scripts**; anything else is a red flag. From 0.4.0 every version also carries a provenance attestation linking it to the commit and workflow run in `github.com/prosperavest/ensc-sdk`; npm shows it on the version page, and `npm audit signatures` checks it.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
