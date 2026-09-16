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

ENSC's response-signing public keys are fetched once per process from `GET /v1/.well-known/ensc-public-keys.json` and cached. To remove that dependency (locked-down egress), pin them with `enscPublicKeys: { [kid]: publicKey }`.

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

Credentials are issued by the dashboard, not the SDK. Go to https://app.prosperavest.com, pick **Sandbox** or **Live**, and open **API keys**:

1. Click **Generate keys**. For Live, you must first add at least one IP address or CIDR to the allowlist; live keys are refused without one.
2. The dashboard creates the API key, the encryption key and an Ed25519 signing keypair, registers the public halves with ENSC, and shows the **secrets exactly once**.
3. Copy all six values immediately. Neither the dashboard nor ENSC retains the secrets.
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
// c.status === 'voucher_issued'; c.voucher.transaction is { to, data, value: '0', chainId }

// Option A: the optional helper (needs `viem`) sends the approval, then the converter call
import { executeVoucher } from '@ensc/sdk/web3';
const { transaction } = await executeVoucher(c.voucher!, walletPrivateKey, { rpcUrl });
await ensc.conversions.events.confirmed(c.reference, transaction.txHash);

// Option B: sign with your own infrastructure, then report
await ensc.conversions.events.submitted(c.reference, txHash);   // broadcast
await ensc.conversions.events.confirmed(c.reference, txHash);   // mined
```

`walletPrivateKey` is your on-chain EOA key, a **separate** secret from the ENSC credentials. It never touches the ENSC API and is never stored by the SDK; pass it per call. Do not put it in `EnscClient` config. The wallet must be the `wallet` named on the conversion.

A `fiat-redeem` needs `payout: { bankCode, accountNumber, accountName }`; resolve the account first with `ensc.accounts.resolve(...)` so the name matches the bank record (the API refuses a mismatch), and list banks with `ensc.banks.list()`. Once the burn is verified on chain the payout is initiated for you; `payout.succeeded` arrives by webhook.

A `fiat-issue` needs `payer: { email, name?, phone? }` and returns `paymentInstructions` (a bank account to transfer the Naira to) instead of a voucher. When the transfer is confirmed the voucher is issued; fetch it with `get` or force it with `voucher(reference)`.

A conversion can come back with `status: 'screening_hold'` (HTTP 202) while transaction screening reviews it; poll `screening(reference)` or listen for `conversion.voucher_issued`, then call `voucher(reference)`. Vouchers expire after about ten minutes; `voucher(reference)` issues a fresh one (crypto legs are re-quoted).

`quote({ type, chain, pair, amount })` prices a crypto leg without creating anything. `transfer.create` builds a plain ENSC transfer in the same `{ to, data, value, chainId }` shape.

## Verifying webhooks

ENSC signs every webhook delivery with Ed25519. Verify before trusting the payload; pass the **exact raw body** you received:

```ts
import { EnscClient } from '@ensc/sdk';

// In your webhook route:
const event = EnscClient.constructEvent({
  body: rawRequestBody,       // string or bytes, exactly as received
  headers: request.headers,   // Headers instance or a plain record
  publicKey: ENSC_WEBHOOK_PUBLIC_KEY, // from /v1/.well-known/ensc-public-keys.json
});
// reaching here means the signature is valid
```

`constructEvent` throws `EnscError('ENSC_INVALID_SIGNATURE')` on failure. For non-throwing checks use `EnscClient.verifyWebhookSignature(...)`, which returns `{ valid, reason? }`.

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

Transient failures (network errors, 5xx) are retried automatically (`maxRetries`, default 2); 4xx is never retried. Mutating requests carry a stable idempotency key across retries, so a transparently retried POST cannot double-execute.

## Chains

`chain` is a string at the API boundary. The SDK exports a `ChainSlug` union and `KNOWN_CHAINS` for autocomplete, but any string is accepted; an unknown or disabled chain comes back as `ENSC_INVALID_CHAIN`. Conversions run on `CONVERTER_CHAINS.live` (`celo`) with a live key and `CONVERTER_CHAINS.test` (`celo-sepolia`) with a test key; a key never reaches the other environment's chain.

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
| Management | `apiKeys` `signingKeys` `encryptionKeys` `origins` | `list` |
| Management | `webhookEndpoints` | `create`, `list`, `get`, `update`, `remove`, `sendTest` |

## Verifying this package

`@ensc/sdk` is staged only by GitHub Actions, from `sdk-v*` release tags, using npm trusted publishing (OIDC), and goes live only when a maintainer approves the staged version with 2FA. There is no long-lived npm token. Every published version is registry-signed; run `npm audit signatures` after installing to verify it. A legitimate release has exactly four runtime dependencies (`@noble/ciphers`, `@noble/curves`, `@noble/hashes`, and `zod` for the exported API types), an optional `viem` peer, and **no install scripts**; anything else is a red flag. From 0.4.0 every version also carries a provenance attestation linking it to the commit and workflow run in `github.com/prosperavest/ensc-sdk`; npm shows it on the version page, and `npm audit signatures` checks it.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
