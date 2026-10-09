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

1. **Create.** `POST /v1/conversions` with the type, chain, the wallet that will sign, the amount and the type-specific fields. You may pass your own `reference` (`op:<type>:<hex>`, 8 to 64 hex characters or dashes after the type, so a UUID fits); otherwise ENSC mints one. Re-posting a reference you already used returns the existing conversion (200), so a retried create can never double-issue. If the first attempt was cut off between the insert and the voucher (a timeout or a temporary error on our side), the conversion is `created` with `lastError` set, and re-posting the reference finishes it.
2. **Sign.** The response carries `voucher`: the signed authorisation, an optional `approvalTransaction` (an ERC-20 `approve` to the converter, needed when the converter must pull a token from your wallet) and `transaction` (the converter call). Both are `{ from, to, data, value: "0", chainId }`: `from` is the wallet that must sign, `to` the token or the converter, `value` always `"0"`. Your signer fills gas, fees and nonce; estimate gas with an explicit limit (see [Signing the calldata](#signing-the-calldata)). Send the approval first when it is present, wait for it, then send the transaction. The voucher is bound to the wallet you named and expires at `voucher.expiresAt` (about ten minutes); a transaction sent by another wallet or after the deadline reverts.
3. **Report.** Tell ENSC what happened: `ensc.conversions.events.submitted(reference, txHash)` once broadcast (optional but recommended), `ensc.conversions.events.confirmed(reference, txHash)` once mined, or `ensc.conversions.events.failed(reference, error)` if your wallet did not send it. `failed` closes the conversion for good, so it is accepted only once no transaction can still settle it: not while the voucher can still be executed, and not after it was executed (see [Reporting a conversion failed](#reporting-a-conversion-failed)). On `confirmed`, ENSC fetches the receipt and verifies that it succeeded, that ENSC moved to or from your wallet, and that the converter emitted the event for exactly this conversion. Crypto legs and `fiat-issue` then reach `succeeded`; a `fiat-redeem` moves on to the payout.

   A hash you reported can be replaced until a receipt is verified: if you sped the transaction up or reported the wrong hash, report `submitted` or `confirmed` again with the right one. Once a receipt is verified for the conversion, a different hash is refused (`409 ENSC_INVALID_STATE`). A hash that another conversion only reported, without a verified receipt, blocks nothing; `409 ENSC_TX_ALREADY_USED` means that transaction's receipt was verified for another conversion.

   If the transaction you reported with `submitted` is dead, `confirmed` says so instead of leaving the conversion stuck: when its receipt shows it reverted, or when the network never saw it and its voucher expired more than two minutes ago, the answer is `409 ENSC_SETTLEMENT_VERIFICATION_FAILED` with `details.voucherReissuable` `true` (`details.reason` is `reverted` or `receipt_not_found`). The conversion is then back at `voucher_issued` with `txHash` `null`. **`voucherReissuable: true` means: ask for a new voucher** (`POST /v1/conversions/{reference}/voucher`, `ensc.conversions.voucher(reference)`), sign it and report again. The converter accepts one transaction per conversion, so a new voucher cannot settle it twice.

```ts
import { EnscClient } from '@ensc/sdk';
import { executeVoucher } from '@ensc/sdk/web3';

const c = await ensc.conversions.create({
  type: 'crypto-issue',
  chain: 'celo',
  wallet,                 // the wallet that will sign; the voucher binds to it
  pair: 'USDC',
  amount: '100',
});

// Sign with the wallet's signer. executeVoucher sends the approval (if any), then the converter call.
const { transaction } = await executeVoucher(c.voucher!, signer, { rpcUrl });
const settled = await ensc.conversions.events.confirmed(c.reference, transaction.txHash);
// settled.status === 'succeeded'
```

`executeVoucher` and `signAndBroadcast` are conveniences; any EVM signer works with the calldata. Their second argument, `signer`, is a raw wallet private key or any viem account. It is a separate secret from the ENSC credentials, never touches the ENSC API and is never stored by the SDK; pass it per call and never put it in `EnscClient` config. Whatever you use, the wallet key never goes to ENSC.

### Signing the calldata

With your own signer, for each of `approvalTransaction` (when present) and `transaction`:

1. Check `chainId` against the chain your RPC endpoint serves, and `from` against the account you are signing with. The voucher is bound to that wallet.
2. Estimate gas first, and send with an explicit gas limit (the estimate plus a margin). Without a limit some nodes estimate at the block gas limit and charge that much gas up front during the simulation. On Celo the native balance is also the CELO ERC-20 balance, so a `crypto-issue` with `pair: "CELO"` then reverts in simulation with `transfer value exceeded balance of sender` unless the wallet holds several CELO more than the amount. `@ensc/sdk/web3` does this for you.
3. If the simulation fails, broadcast nothing. To try again, ask for a new voucher. To give up, report `events.failed(reference, error)`: it is accepted once the voucher has expired, and answers `409 ENSC_INVALID_STATE` with `details.reason` `voucher_live` and `details.retryAfterSeconds` until then (see [Reporting a conversion failed](#reporting-a-conversion-failed)). A `fiat-issue` whose payment has been received cannot be reported failed (`details.reason` `payment_received`): ask for a new voucher instead.
4. Send `value: 0`. ENSC never asks for native value.

### Reporting a conversion failed

`failed` is final: no voucher is issued for the conversion again and nothing reported later moves it. ENSC therefore accepts it only once no transaction can still settle the conversion.

| The conversion | `events.failed` answers |
|---|---|
| has no voucher yet (`created`, `screening_hold`, a `fiat-issue` at `awaiting_payment`) | accepted at once: the conversion is `failed` |
| holds a voucher that can still be executed | `409 ENSC_INVALID_STATE`, `details.reason` `voucher_live`, `details.retryAfterSeconds` |
| holds a voucher that expired and was never executed | accepted: the conversion is `failed` |
| holds a voucher that was executed on chain | `409 ENSC_INVALID_STATE`, `details.reason` `voucher_used` |
| changed while the report was being applied | `409 ENSC_INVALID_STATE`, `details.reason` `changed_meanwhile` |

**`voucher_live`: wait, then report again.** A signed voucher stays executable until `voucher.expiresAt`, whatever you intend to do with it, and ENSC allows two more minutes for a transaction mined at the last moment. The voucher that counts is the last one issued for the conversion, and whether it has expired is decided by the network's own clock, not by ENSC's: while the network's latest block is not past the voucher's expiry the answer stays `voucher_live`, with a `retryAfterSeconds` of 30. `details.retryAfterSeconds` is the whole number of seconds to wait before reporting again. Wait that long and send the same report again; the same idempotency key can be reused, because a refusal is not remembered. Until the report is accepted the conversion is not failed: show it to your user as pending, and do not broadcast the voucher's transaction in the meantime.

**`voucher_used`: report the transaction.** The converter executed a voucher of this conversion, so the conversion happened on chain although no transaction was reported to ENSC (a broadcast whose result your system lost, for example). Find the transaction the conversion's wallet sent to the converter and report it with `events.confirmed(reference, txHash)`: ENSC verifies the receipt and settles the conversion. Do not tell your user it failed.

**`changed_meanwhile`: read the conversion, then report again.** The conversion changed between ENSC's check of the voucher and the report being applied, for example because another of your requests was issued a new voucher for it at that moment. Nothing was changed by the report. Read the conversion and report again; with a new voucher in place the answer is then `voucher_live`.

```ts
import { isEnscErrorCode } from '@ensc/sdk';

try {
  await ensc.conversions.events.failed(reference, 'simulation failed');
} catch (err) {
  if (!isEnscErrorCode(err, 'ENSC_INVALID_STATE')) throw err;
  if (err.details?.reason === 'voucher_live') {
    // Not failed yet: report again after err.details.retryAfterSeconds seconds.
  } else if (err.details?.reason === 'voucher_used') {
    // It settled on chain: report the transaction with events.confirmed(reference, txHash).
  } else if (err.details?.reason === 'changed_meanwhile') {
    // The conversion changed at that moment: read it and report again.
  } else {
    throw err;
  }
}
```

If ENSC cannot read the chain at that moment, or the conversion's network is not being served at that moment, the answer is `502 ENSC_CHAIN_UNAVAILABLE` and nothing has changed: report again shortly, with the same idempotency key if you use one.

Three refusals are older and unchanged, each `409 ENSC_INVALID_STATE`: a transaction hash is recorded for the conversion (report it `confirmed`; a dead one is released as described in step 3 of [The flow](#the-flow)), the conversion is in `requires_manual_review`, or it is a `fiat-issue` whose payment is received (`details.reason` `payment_received`, see [Once the payment is received](#once-the-payment-is-received)).

ENSC does not close a conversion by itself when its voucher expires: it stays `voucher_issued` until you ask for a new voucher or report it failed.

### Amounts and decimals

Amounts you send are decimal strings in the asset's own units: `"0.1"` CELO, `"100"` USDC, `"1000.00"` NGN. Fiat amounts take at most 2 decimals; a crypto amount may not carry more decimals than the asset has (`ENSC_VALIDATION_FAILED` otherwise). No commas, signs or exponents.

Amounts ENSC returns are base-unit integer strings (`amountIn`, `amountOut`, `balance`, the voucher fields) with a decimal twin already divided by the asset's decimals (`amountInFormatted`, `amountOutFormatted`, `formatted`). Decimals: ENSC 18, CELO 18, USDC and USDT 6. NGN legs are stored as ENSC units (18 decimals) with the Naira principal in `fiatAmountNgn` (2 decimals). Do arithmetic on the base units with an arbitrary-precision integer, never on the formatted strings and never in floating point.

### Type-specific fields

- `crypto-issue`, `crypto-redeem`: `pair` (`USDC`, `USDT`, `CELO`). The pair must be listed on the converter of the chain you name.
- `fiat-issue`: `payer` with `email` (required) and optional `name` and `phone`; the payment rail needs a contact for the collection.
- `fiat-redeem`: `payout` with `bankCode`, `accountNumber` (10 digits) and `accountName`. Resolve the account first with `POST /v1/accounts/resolve` (`ensc.accounts.resolve({ bankCode, accountNumber })`) and pass back the name it returns; the create refuses a name that does not match the bank record (`ENSC_ACCOUNT_RESOLUTION_FAILED`). Bank codes come from `GET /v1/banks` (`ensc.banks.list()`).
- Any type: `counterparty` (`type` `individual` or `company`, `name`, `wallet`) for transaction screening, and `metadata` (up to 16 string keys, key up to 40 and value up to 200 characters) echoed back on the conversion object (webhook payloads carry the summary only).

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
  "note": "Transfer the exact amount to this account before it expires.",
  "providerReference": "op:fiat-issue:…"
}
```

`providerReference` is the conversion's own `reference`, and `note` is a fixed sentence you can show the payer.

Show these to the payer. `transferAmount` is the principal plus the rail's collection fee. Only a bank transfer is accepted; there are no cards or USSD. When the transfer is confirmed the conversion moves to `payment_confirmed`, ENSC issues the voucher and the conversion reaches `voucher_issued`; you receive `conversion.payment_confirmed` and `conversion.voucher_issued`, and `GET /v1/conversions/{reference}` now carries `voucher`. Sign and report it as in step 2 and 3 above. ENSC also checks unpaid transfers on its own schedule, so a confirmation does not depend on your polling; when that check confirms one, you receive `conversion.payment_confirmed` first and the voucher is issued on your next `GET /v1/conversions/{reference}` (or `POST /v1/conversions/{reference}/voucher`), followed by `conversion.voucher_issued`. A transfer that arrives short of the principal, above the amount, or in a currency other than NGN parks the conversion in `requires_manual_review`.

### Once the payment is received

A `fiat-issue` whose bank transfer has been confirmed holds the payer's money, so it can no longer be closed by you: from `payment_confirmed` on, `events.failed` answers `409 ENSC_INVALID_STATE` with `details.reason` `payment_received` (and the current `details.status`). The voucher can still be requested and executed: if signing fails or the voucher expires, ask for a new one with `POST /v1/conversions/{reference}/voucher`. If the conversion cannot be completed at all, contact support with the reference.

Two `lastError` sentences are about a payment going back to its payer. While `lastError` reads `The payment for this conversion is being returned to the payer` the conversion is `requires_manual_review`, you have received `conversion.requires_manual_review`, and no voucher is issued for it any more. When it reads `The payment for this conversion was returned to the payer` the conversion is `failed` and you have received `conversion.failed`.

A payment can also arrive late. If a `fiat-issue` is already `failed` (you reported it failed while it was `awaiting_payment`, or an earlier transfer attempt failed) and a transfer for it is then confirmed, no ENSC is issued for it. The conversion moves from `failed` to `requires_manual_review`, `lastError` reads `A payment arrived after this conversion had failed`, and you receive `conversion.requires_manual_review`. A person at ENSC resolves it; contact support with the reference. Do not treat a `failed` fiat-issue as closed for good while its payment instructions could still be paid.

## Being paid in Naira (`fiat-redeem`)

The voucher for a `fiat-redeem` commits to the payout account you gave: the converter records a hash of the bank, account number and name when your wallet burns the ENSC. After `confirmed`, ENSC checks that the recorded hash matches the account it stored and initiates the payout to that account and no other. The conversion moves `payout_pending`, `payout_in_progress`, `payout_confirmed`, `succeeded`, and you receive `payout.initiated` and `payout.succeeded`.

The conversion's `payout` object shows `bankCode`, `accountLast4`, `status` (`pending`, `initiated`, `in_progress`, `successful`, `failed`, `requires_manual_review`) and `providerTransferId`. A transient failure at the rail is retried with backoff for up to five attempts; a payout that still fails, or a definitive refusal, parks the conversion in `requires_manual_review` and sends `payout.failed`. Your ENSC has already been burned at that point, so a person at ENSC resolves the case; contact support with the reference. `POST /v1/conversions/{reference}/payout` (`ensc.conversions.payout(reference)`) nudges a payout that is `payout_pending` ahead of the next scheduled retry; it does nothing once a payout is in progress.

## Transaction screening holds

Conversions may be screened before a voucher is issued. Most are approved immediately. When one needs review the create answers `202` with `status: "screening_hold"` and `screening.status` of `IN_REVIEW` or `AWAITING_USER`; you receive `conversion.screening_hold`. Poll `GET /v1/conversions/screening?reference=…` (`ensc.conversions.screening(reference)`) or `get`, or wait for the webhook: an approval moves the conversion on automatically (`conversion.voucher_issued`, or `conversion.awaiting_payment` for a `fiat-issue`), and a decline fails it (`conversion.failed`). Asking for the voucher while the hold stands returns `409 ENSC_KYT_HOLD` with `retryAfterSeconds`. A conversion declined at create time is stored as `failed` and the create answers `403 ENSC_KYT_DECLINED` with the reference in `details`.

## Vouchers that expire

A voucher not used before `expiresAt` is simply dead; the transaction would revert. Ask for a new one with `POST /v1/conversions/{reference}/voucher` (`ensc.conversions.voucher(reference)`). Crypto legs are re-quoted at the current rate (so `amountOut` may change); fiat legs keep their amounts. A conversion whose voucher expired stays `voucher_issued` until you ask for a new voucher or report it failed; ENSC does not close it by itself.

When a transaction is on record for the conversion, the voucher request first checks it. If that transaction is dead (it reverted, or the network never saw it and its voucher expired more than two minutes ago) the conversion is released and a new voucher is issued. If it may still settle, or a receipt has been verified, no voucher is issued (`409 ENSC_INVALID_STATE`): report the transaction `confirmed` instead. No voucher is issued for a conversion in `requires_manual_review` either (`409 ENSC_INVALID_STATE`).

A conversion whose voucher was already executed on chain gets no new voucher either, whether or not its transaction was reported. Before a second or later voucher is issued ENSC asks the converter whether a voucher of the conversion was executed; if one was, the request answers `409 ENSC_INVALID_STATE` with `details.reason` `voucher_used`, nothing is quoted again, and the conversion keeps the amounts of the voucher that was executed. Find the transaction the conversion's wallet sent to the converter and report it with `events.confirmed(reference, txHash)`. If ENSC cannot read the chain at that moment the request answers `502 ENSC_CHAIN_UNAVAILABLE` and nothing has changed: ask again shortly.

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

A conversion moves forward, with one exception: a conversion at `onchain_submitted` whose reported transaction is dead (see step 3 of [The flow](#the-flow)) goes back to `voucher_issued` so that a new voucher can be issued; `stages` records it as `onchain_released`. `failed` and `requires_manual_review` can be reached from any status, with two limits on what you report: `failed` is refused while the conversion's voucher can still be executed and after it was executed (see [Reporting a conversion failed](#reporting-a-conversion-failed)), and for a `fiat-issue` once its payment is received. `failed` is final for you, and nothing follows it except `requires_manual_review`, which a `fiat-issue` reaches when its payment arrives after it failed. A `fiat-issue` that is `requires_manual_review` because its payment is being returned to the payer (see [Once the payment is received](#once-the-payment-is-received)) ends `failed`. `requires_manual_review` is resolved by ENSC. Reporting the same event twice is harmless. `stages` on the conversion lists every status it passed through with a timestamp.

## The conversion object

`GET /v1/conversions/{reference}` and every write return the same shape:

| Field | Meaning |
|---|---|
| `id`, `reference`, `type`, `status`, `env`, `chain`, `chainId`, `wallet` | Identity |
| `tokenIn`, `tokenOut` | Symbols, `NGN` for the fiat side |
| `amountIn`, `amountOut` | Base units as decimal strings (18 decimals for ENSC and NGN legs, the token's decimals for pair tokens); `amountInFormatted`, `amountOutFormatted` for display |
| `fiatAmountNgn` | The NGN principal of a fiat leg, 2 decimals, or `null` |
| `screening.status` | `APPROVED`, `IN_REVIEW`, `DECLINED`, `AWAITING_USER` or `SKIPPED` |
| `voucher` | `voucher` (the signed fields), `signature`, `domain`, `expiresAt`, `approvalToken`, `approvalTransaction`, `transaction`; `null` until issued |
| `paymentInstructions` | `fiat-issue` only, see above |
| `payout` | `fiat-redeem` only, see above; never the full account number |
| `txHash` | The hash you reported, until a receipt is verified; then the transaction ENSC verified. `null` before you report one, and again after a dead transaction is released. |
| `onchainVerifiedAt` | Set once ENSC verified the receipt |
| `stages`, `metadata`, `lastError`, `createdAt`, `updatedAt` | History and your own data |

`GET /v1/conversions?status=&type=&limit=&cursor=` lists your conversions newest first.

## Webhook events

Register an endpoint from the dashboard or with `ensc.webhookEndpoints.create()`. Every delivery is `{ id, type, apiVersion, product, merchantId, env, created, data }` (a test delivery also carries `synthetic: true`), signed as described in [Webhooks](./webhooks.md#verifying-a-delivery). `data` is the conversion summary (`id`, `reference`, `type`, `status`, `chain`, `wallet`, `tokenIn`, `tokenOut`, `amountIn`, `amountOut`, `fiatAmountNgn`, `txHash`, `lastError`, `updatedAt`) for `conversion.*` events and the payout summary (`conversionId`, `reference`, `payoutId`, `status`, `amountNgn`, `bankCode`, `accountLast4`, `providerTransferId`, `lastError`) for `payout.*` events.

| Event | When |
|---|---|
| `conversion.created` | The row exists (before screening) |
| `conversion.screening_hold` | Held for transaction screening |
| `conversion.awaiting_payment` | `fiat-issue`: payment instructions are ready |
| `conversion.payment_confirmed` | `fiat-issue`: the bank transfer arrived and was verified |
| `conversion.voucher_issued` | A voucher is available (also after a hold is lifted or a re-issue) |
| `conversion.onchain_confirmed` | ENSC verified your transaction receipt |
| `conversion.settled` | ENSC independently saw the ENSC movement for your transaction on chain; `data` here is `id`, `reference`, `type`, `status`, `chain`, `chainId`, `txHash`, `movement` (`mint`, `burn` or `transfer`), `amount`, `from`, `to` and `blockNumber` |
| `conversion.succeeded` | Done |
| `conversion.failed` | Declined by screening, reported failed by you, the bank transfer failed, or the payment of a `fiat-issue` was returned to the payer. For a `fiat-issue` it can be followed by `conversion.requires_manual_review` if a payment arrives afterwards. |
| `conversion.requires_manual_review` | Something needs a person at ENSC: a short payment, a payment that arrived after the conversion had failed, a payment that is being returned to the payer, a payout that could not be completed, a destination mismatch |
| `payout.initiated` | `fiat-redeem`: the payout was handed to the bank rail |
| `payout.succeeded` | `fiat-redeem`: the bank confirmed it |
| `payout.failed` | `fiat-redeem`: the payout failed; the conversion is in manual review |

How to receive, verify and process these is in [Webhooks](./webhooks.md). In Sandbox, `POST /v1/webhook-endpoints/{id}/test` and `POST /v1/test-data/events` emit any of these with a realistic payload, marked `synthetic: true`, so you can exercise your receiver end to end.

## Error codes

Beyond the authentication and validation codes in [Authorization](./authorization.md):

| Code | Status | Meaning |
|---|---|---|
| `ENSC_INVALID_CHAIN` | 400 | Unknown chain, or not enabled for your environment |
| `ENSC_CONVERTER_UNAVAILABLE` | 400 | The chain has no converter; conversions run on `celo` / `celo-sepolia` |
| `ENSC_INVALID_ASSET` | 400 | The pair is not listed on that chain |
| `ENSC_VALIDATION_FAILED` | 400 | `reference` is not `op:<type>:<hex>` for this type (reported under `details.fields`) |
| `ENSC_REFERENCE_CONFLICT` | 409 | Another account already used this reference |
| `ENSC_AMOUNT_TOO_SMALL` | 400 | Zero, or below the NGN 100 payout minimum |
| `ENSC_RATE_STALE` | 409 | The oracle rate is too old to price the leg; retry later |
| `ENSC_RATE_DRIFT` | 409 | The converter's rate for a stablecoin pair is out of line with the market reference; retry later |
| `ENSC_RESERVE_INSUFFICIENT` | 409 | `crypto-redeem`: the reserve cannot pay this much right now; `details.maxAmountIn` is the largest redeemable ENSC amount in base units |
| `ENSC_RESERVE_UNAVAILABLE`, `ENSC_QUOTE_FAILED`, `ENSC_CHAIN_UNAVAILABLE` | 503, 502, 502 | The chain could not be read; nothing changed, retry |
| `ENSC_VOUCHER_UNAVAILABLE` | 503 | The voucher could not be issued; retry |
| `ENSC_VOUCHER_REFUSED` | 422 | The voucher was refused (`details.reason`); contact support if it persists |
| `ENSC_KYT_HOLD` | 409 | On a screening hold; `retryAfterSeconds` in `details` |
| `ENSC_KYT_DECLINED` | 403 | Declined by transaction screening; the conversion is `failed` |
| `ENSC_SCREENING_UNAVAILABLE` | 503 | Screening could not be performed; retry |
| `ENSC_ACCOUNT_RESOLUTION_FAILED` | 422 | The account could not be resolved, or `accountName` does not match the bank record |
| `ENSC_PAYOUT_DETAILS_REQUIRED` | 400 | `fiat-redeem` without usable payout details |
| `ENSC_PAYMENT_NOT_CONFIRMED` | 409 | Voucher requested for a `fiat-issue` whose transfer has not been confirmed |
| `ENSC_INVALID_STATE` | 409 | The action does not fit the conversion's status (for example a voucher while a reported transaction may still settle, a different transaction after a receipt was verified, or `failed` reported after a transaction was recorded). For a refused `failed` report `details.reason` says what to do: `voucher_live` (the voucher can still be executed; wait `details.retryAfterSeconds` and report again), `voucher_used` (the voucher was executed; report the transaction `confirmed`), `changed_meanwhile` (the conversion changed at that moment; read it and report again), `payment_received` (a `fiat-issue` whose payment was received; ask for a new voucher). A voucher request for a conversion whose voucher was executed is refused with `voucher_used` too |
| `ENSC_TX_ALREADY_USED` | 409 | That transaction's receipt was already verified for another conversion |
| `ENSC_SETTLEMENT_VERIFICATION_FAILED` | 409 | The receipt does not prove this conversion. When `details.retriable` is `true` the transaction is not mined yet or not yet deep enough (`details.reason` `not_enough_confirmations`); report again shortly. When `details.voucherReissuable` is `true` the reported transaction is dead; ask for a new voucher. |
| `ENSC_PAYOUT_REF_MISMATCH` | 409 | The payout account recorded on chain differs from the one stored; no payout is made |
| `ENSC_PAYOUT_NOT_READY` | 409 | `payout` called on a conversion that is not `payout_pending` |
| `ENSC_PROVIDER_NOT_CONFIGURED`, `ENSC_PROVIDER_ERROR`, `ENSC_PROVIDER_RATE_LIMITED` | 503, 502, 429 | The bank rail could not be reached or refused; retry later |
