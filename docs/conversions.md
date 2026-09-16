# Conversions

A conversion moves value between ENSC, a pair token and Nigerian Naira through the ENSC converter contract. ENSC quotes, screens and authorises the operation; your own wallet signs and broadcasts the transaction; you tell ENSC the hash; ENSC verifies it on chain and, for a redemption to Naira, pays the bank account out. `@ensc/sdk` 0.4.x exposes all of this under `ensc.conversions`.

## The four types

| Type | You send | You receive | `amount` means |
|---|---|---|---|
| `crypto-issue` | a pair token (`USDC`, `USDT` or `CELO`) | ENSC | pair token, e.g. `"100"` USDC |
| `crypto-redeem` | ENSC | a pair token | ENSC, e.g. `"150000"` |
| `fiat-issue` | a Naira bank transfer | ENSC | NGN, at most 2 decimals; ENSC is issued one to one |
| `fiat-redeem` | ENSC | a Naira bank payout | ENSC, at most 2 decimals; NGN is paid out one to one |

Amounts are decimal strings in major units. Crypto legs are priced by the converter's on-chain oracle at the moment the voucher is issued; `GET /v1/conversions/quote` (`ensc.conversions.quote()`) gives you the same figure in advance, plus `redeemCapacityIn`, the most ENSC that can currently be redeemed into that pair, and `validForSeconds`, how long a voucher issued now would hold. Fiat legs have no rate. There is a minimum payout of NGN 100 on `fiat-redeem`.

Conversions run on the converter chain of your environment: `celo-sepolia` with a Sandbox key, `celo` with a Live key. See [Environments](./environments.md).

## The flow

1. **Create.** `POST /v1/conversions` with the type, chain, the wallet that will sign, the amount and the type-specific fields. You may pass your own `reference` (`op:<type>:<hex>`, 8 to 64 hex characters or dashes after the type, so a UUID fits); otherwise ENSC mints one. Re-posting a reference you already used returns the existing conversion unchanged (200), so a retried create can never double-issue.
2. **Sign.** The response carries `voucher`: the signed authorisation, an optional `approvalTransaction` (an ERC-20 `approve` to the converter, needed when the converter must pull a token from your wallet) and `transaction` (the converter call). Both are `{ to, data, value: "0", chainId }`; your signer fills gas, fees and nonce. Send the approval first when it is present, wait for it, then send the transaction. The voucher is bound to the wallet you named and expires at `voucher.expiresAt` (about ten minutes); a transaction sent by another wallet or after the deadline reverts.
3. **Report.** Tell ENSC what happened: `ensc.conversions.events.submitted(reference, txHash)` once broadcast (optional but recommended), `ensc.conversions.events.confirmed(reference, txHash)` once mined, or `ensc.conversions.events.failed(reference, error)` if your wallet could not send it. On `confirmed`, ENSC fetches the receipt and verifies that it succeeded, that ENSC moved to or from your wallet, and that the converter emitted the event for exactly this conversion. Crypto legs and `fiat-issue` then reach `succeeded`; a `fiat-redeem` moves on to the payout.

```ts
import { EnscClient } from '@ensc/sdk';
import { executeVoucher } from '@ensc/sdk/web3';

const c = await ensc.conversions.create({
  type: 'crypto-issue',
  chain: 'celo',
  wallet,                 // the wallet whose key you hold
  pair: 'USDC',
  amount: '100',
});

// Sign with your own key. executeVoucher sends the approval (if any), then the converter call.
const { transaction } = await executeVoucher(c.voucher!, walletPrivateKey, { rpcUrl });
const settled = await ensc.conversions.events.confirmed(c.reference, transaction.txHash);
// settled.status === 'succeeded'
```

`executeVoucher` and `signAndBroadcast` are conveniences; any EVM signer works with the calldata. Whatever you use, the wallet key never goes to ENSC.

### Type-specific fields

- `crypto-issue`, `crypto-redeem`: `pair` (`USDC`, `USDT`, `CELO`). The pair must be listed on the converter of the chain you name.
- `fiat-issue`: `payer` with `email` (required) and optional `name` and `phone`; the payment rail needs a contact for the collection.
- `fiat-redeem`: `payout` with `bankCode`, `accountNumber` (10 digits) and `accountName`. Resolve the account first with `POST /v1/accounts/resolve` (`ensc.accounts.resolve({ bankCode, accountNumber })`) and pass back the name it returns; the create refuses a name that does not match the bank record (`ENSC_ACCOUNT_RESOLUTION_FAILED`). Bank codes come from `GET /v1/banks` (`ensc.banks.list()`).
- Any type: `counterparty` (`type` `individual` or `company`, `name`, `wallet`) for transaction screening, and `metadata` (up to 16 string keys, key up to 40 and value up to 200 characters) echoed back on the conversion and in webhooks.

## Paying in Naira (`fiat-issue`)

A `fiat-issue` has no voucher at first. The create returns `status: "awaiting_payment"` and `paymentInstructions`:

```json
{
  "method": "bank_transfer",
  "bankName": "…",
  "accountNumber": "…",
  "transferAmount": "10050.00",
  "currency": "NGN",
  "expiresAt": "2026-09-15T12:30:00.000Z",
  "note": "…",
  "providerReference": "…"
}
```

Show these to the payer. `transferAmount` is the principal plus the rail's collection fee. Only a bank transfer is accepted; there are no cards or USSD. When the transfer is confirmed the conversion moves to `payment_confirmed`, ENSC issues the voucher and the conversion reaches `voucher_issued`; you receive `conversion.payment_confirmed` and `conversion.voucher_issued`, and `GET /v1/conversions/{reference}` now carries `voucher`. Sign and report it as in step 2 and 3 above. A transfer that arrives short of the principal parks the conversion in `requires_manual_review`.

## Being paid in Naira (`fiat-redeem`)

The voucher for a `fiat-redeem` commits to the payout account you gave: the converter records a hash of the bank, account number and name when your wallet burns the ENSC. After `confirmed`, ENSC checks that the recorded hash matches the account it stored and initiates the payout to that account and no other. The conversion moves `payout_pending` → `payout_in_progress` → `payout_confirmed` → `succeeded`, and you receive `payout.initiated` and `payout.succeeded`.

The conversion's `payout` object shows `bankCode`, `accountLast4`, `status` (`pending`, `initiated`, `in_progress`, `successful`, `failed`, `requires_manual_review`) and `providerTransferId`. A transient failure at the rail is retried with backoff for up to five attempts; a payout that still fails, or a definitive refusal, parks the conversion in `requires_manual_review` and sends `payout.failed`. Your ENSC has already been burned at that point, so a person at ENSC resolves the case; contact support with the reference. `POST /v1/conversions/{reference}/payout` (`ensc.conversions.payout(reference)`) nudges a payout that is `payout_pending` ahead of the next scheduled retry; it does nothing once a payout is in progress.

## Transaction screening holds

Conversions may be screened before a voucher is issued. Most are approved immediately. When one needs review the create answers `202` with `status: "screening_hold"` and `screening.status` of `IN_REVIEW` or `AWAITING_USER`; you receive `conversion.screening_hold`. Poll `GET /v1/conversions/screening?reference=…` (`ensc.conversions.screening(reference)`) or `get`, or wait for the webhook: an approval moves the conversion on automatically (`conversion.voucher_issued`, or `conversion.awaiting_payment` for a `fiat-issue`), and a decline fails it (`conversion.failed`). Asking for the voucher while the hold stands returns `409 ENSC_KYT_HOLD` with `retryAfterSeconds`. A conversion declined at create time is stored as `failed` and the create answers `403 ENSC_KYT_DECLINED` with the reference in `details`.

## Vouchers that expire

A voucher not used before `expiresAt` is simply dead; the transaction would revert. Ask for a new one with `POST /v1/conversions/{reference}/voucher` (`ensc.conversions.voucher(reference)`). Crypto legs are re-quoted at the current rate (so `amountOut` may change); fiat legs keep their amounts. Nothing can be re-issued once a transaction hash has been recorded for the conversion.

## Statuses

```
crypto-issue / crypto-redeem:
  created -> [screening_hold] -> voucher_issued -> onchain_submitted -> onchain_confirmed -> succeeded
fiat-issue:
  created -> [screening_hold] -> awaiting_payment -> payment_confirmed -> voucher_issued
          -> onchain_submitted -> onchain_confirmed -> succeeded
fiat-redeem:
  created -> [screening_hold] -> voucher_issued -> onchain_submitted -> onchain_confirmed
          -> payout_pending -> payout_in_progress -> payout_confirmed -> succeeded
```

A conversion only moves forward. `failed` and `requires_manual_review` can be reached from any status; `failed` is terminal for you, `requires_manual_review` is resolved by ENSC. Reporting the same event twice is harmless. `stages` on the conversion lists every status it passed through with a timestamp.

## The conversion object

`GET /v1/conversions/{reference}` and every write return the same shape:

| Field | Meaning |
|---|---|
| `id`, `reference`, `type`, `status`, `env`, `chain`, `chainId`, `wallet` | Identity |
| `tokenIn`, `tokenOut` | Symbols, `NGN` for the fiat side |
| `amountIn`, `amountOut` | Base units as decimal strings (18 decimals for ENSC and NGN legs, the token's decimals for pair tokens); `amountInFormatted`, `amountOutFormatted` for display |
| `fiatAmountNgn` | The NGN principal of a fiat leg, 2 decimals, or `null` |
| `screening.status` | `APPROVED`, `IN_REVIEW`, `DECLINED`, `AWAITING_USER` or `SKIPPED` |
| `voucher` | `voucher` (the signed fields), `signature`, `signer`, `domain`, `expiresAt`, `approvalToken`, `approvalTransaction`, `transaction`; `null` until issued |
| `paymentInstructions` | `fiat-issue` only, see above |
| `payout` | `fiat-redeem` only, see above; never the full account number |
| `txHash`, `onchainVerifiedAt` | Set once you report the transaction and ENSC verifies it |
| `stages`, `metadata`, `lastError`, `createdAt`, `updatedAt` | History and your own data |

`GET /v1/conversions?status=&type=&limit=&cursor=` lists your conversions newest first.

## Webhook events

Register an endpoint from the dashboard or with `ensc.webhookEndpoints.create()`. Every delivery is `{ id, type, apiVersion, created, data }`, signed as described in [Security](./security.md). `data` is the conversion summary (`id`, `reference`, `type`, `status`, `chain`, `wallet`, `tokenIn`, `tokenOut`, `amountIn`, `amountOut`, `fiatAmountNgn`, `txHash`, `lastError`, `updatedAt`) for `conversion.*` events and the payout summary (`conversionId`, `reference`, `payoutId`, `status`, `amountNgn`, `bankCode`, `accountLast4`, `providerTransferId`, `lastError`) for `payout.*` events.

| Event | When |
|---|---|
| `conversion.created` | The row exists (before screening) |
| `conversion.screening_hold` | Held for transaction screening |
| `conversion.awaiting_payment` | `fiat-issue`: payment instructions are ready |
| `conversion.payment_confirmed` | `fiat-issue`: the bank transfer arrived and was verified |
| `conversion.voucher_issued` | A voucher is available (also after a hold is lifted or a re-issue) |
| `conversion.onchain_confirmed` | ENSC verified your transaction receipt |
| `conversion.settled` | ENSC's chain indexer independently saw the ENSC movement for your transaction; `data` adds `chainId`, `movement` (`mint`, `burn` or `transfer`), `amount`, `from`, `to` and `blockNumber` |
| `conversion.succeeded` | Done |
| `conversion.failed` | Declined by screening, reported failed by you, or the bank transfer failed |
| `conversion.requires_manual_review` | Something needs a person at ENSC: a short payment, a payout that could not be completed, a destination mismatch |
| `payout.initiated` | `fiat-redeem`: the payout was handed to the bank rail |
| `payout.succeeded` | `fiat-redeem`: the bank confirmed it |
| `payout.failed` | `fiat-redeem`: the payout failed; the conversion is in manual review |

In Sandbox, `POST /v1/test-data/events` emits any of these with a synthetic payload so you can exercise your receiver end to end.

## Error codes

Beyond the authentication and validation codes in [Authorization](./authorization.md):

| Code | Status | Meaning |
|---|---|---|
| `ENSC_INVALID_CHAIN` | 400 | Unknown chain, or not available to your environment |
| `ENSC_CONVERTER_UNAVAILABLE` | 400 | The chain has no converter; conversions run on `celo` / `celo-sepolia` |
| `ENSC_INVALID_ASSET` | 400 | The pair is not listed on that chain |
| `ENSC_INVALID_REFERENCE` | 400 | `reference` is not `op:<type>:<hex>` for this type |
| `ENSC_REFERENCE_CONFLICT` | 409 | Another account already used this reference |
| `ENSC_AMOUNT_TOO_SMALL` | 400 | Zero, or below the NGN 100 payout minimum |
| `ENSC_RATE_STALE` | 409 | The oracle rate is too old to price the leg; retry later |
| `ENSC_RATE_DRIFT` | 409 | The converter's rate for a stablecoin pair is out of line with the market reference; retry later |
| `ENSC_RESERVE_INSUFFICIENT` | 409 | `crypto-redeem`: the reserve cannot pay this much right now; `details.maxAmountIn` is the largest redeemable ENSC amount in base units |
| `ENSC_RESERVE_UNAVAILABLE`, `ENSC_QUOTE_FAILED` | 503, 502 | The chain could not be read; retry |
| `ENSC_SIGNER_UNAVAILABLE`, `ENSC_SIGNER_REFUSED` | 503, 422 | The voucher could not be issued; retry, or contact support if it persists |
| `ENSC_KYT_HOLD` | 409 | On a screening hold; `retryAfterSeconds` in `details` |
| `ENSC_KYT_DECLINED` | 403 | Declined by transaction screening; the conversion is `failed` |
| `ENSC_SCREENING_UNAVAILABLE` | 503 | Screening could not be performed; retry |
| `ENSC_ACCOUNT_RESOLUTION_FAILED` | 422 | The account could not be resolved, or `accountName` does not match the bank record |
| `ENSC_PAYOUT_DETAILS_REQUIRED` | 400 | `fiat-redeem` without usable payout details |
| `ENSC_PAYMENT_NOT_CONFIRMED` | 409 | Voucher requested for a `fiat-issue` whose transfer has not been confirmed |
| `ENSC_INVALID_STATE` | 409 | The action does not fit the conversion's status (for example a voucher after the transaction was sent) |
| `ENSC_TX_ALREADY_USED` | 409 | That transaction hash already settled another conversion |
| `ENSC_SETTLEMENT_VERIFICATION_FAILED` | 409 | The receipt does not prove this conversion; when `details.retriable` is `true` the transaction is simply not mined yet |
| `ENSC_PAYOUT_REF_MISMATCH` | 409 | The payout account recorded on chain differs from the one stored; no payout is made |
| `ENSC_PAYOUT_NOT_READY` | 409 | `payout` called on a conversion that is not `payout_pending` |
| `ENSC_PROVIDER_NOT_CONFIGURED`, `ENSC_PROVIDER_ERROR`, `ENSC_PROVIDER_RATE_LIMITED` | 503, 502, 429 | The bank rail could not be reached or refused; retry later |
