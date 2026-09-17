# Environments

ENSC has two environments, Sandbox and Live. Your API key selects the environment; everything downstream (the chain, the bank rail, screening) follows the key. The API surface, the SDK and the cryptography are identical in both.

## Keys

| | Sandbox | Live |
|---|---|---|
| Key prefix | `ensc_test_` | `ensc_live_` |
| IP allowlist | optional | required, 1 to 32 addresses or CIDRs |
| Credentials | its own API key, encryption key and signing key | its own set; nothing is shared with Sandbox |

A Sandbox key can never touch Live resources and a Live key can never touch Sandbox resources (`ENSC_TEST_LIVE_MISMATCH`). Naming a chain from the other environment answers `ENSC_INVALID_CHAIN`.

## Chains

Conversions run on one converter chain per environment:

| | Sandbox | Live |
|---|---|---|
| Chain slug | `celo-sepolia` | `celo` |
| Chain id (in every `unsignedTransaction`) | `11142220` | `42220` |
| ENSC | test ENSC | ENSC |
| Pair tokens (`USDC`, `USDT`, `CELO`) | test tokens listed on the test converter | the real tokens |
| Gas | testnet CELO | CELO |

The wallet you name on a conversion must hold the token it sends and enough native CELO for gas on that chain. `GET /v1/balance` reads any whitelisted asset on any enabled chain of your environment.

Other chains in the registry (`base`, `polygon`, `optimism`, `ethereum`, `arbitrum`, `bsc`, `mode` and their testnets `base-sepolia`, `polygon-amoy`, `optimism-sepolia`, `sepolia`, `arbitrum-sepolia`, `bsc-testnet`, `mode-sepolia`) carry the ENSC token only: `balance` and `transfer` work where ENSC is deployed and the chain is enabled for your environment, and `POST /v1/conversions` answers `ENSC_CONVERTER_UNAVAILABLE`.

## The sandbox bank rail

In Sandbox, `GET /v1/banks`, `POST /v1/accounts/resolve`, `fiat-issue` collections and `fiat-redeem` payouts go to a sandbox banking network instead of the live one. No real money moves.

- Use the test bank and the test account numbers shown on the dashboard's Sandbox page. One of them always fails, which is how you exercise the `payout.failed` and `conversion.requires_manual_review` path.
- A Sandbox `fiat-redeem` to a test account succeeds about one minute after `payout.initiated`, so you see the full `payout_pending`, `payout_in_progress`, `payout_confirmed`, `succeeded` sequence.
- Bank transfer only: `paymentInstructions` on a Sandbox `fiat-issue` describe a sandbox account; the transfer amount and expiry are real values.

`accountName` on a `fiat-redeem` must still match what `accounts/resolve` returns for the test account.

## Screening

Transaction screening applies in both environments; screening statuses and holds behave on Sandbox as they do on Live.

## Exercising webhooks

`POST /v1/test-data/events` (`ensc.testEvents.emit`, with your Sandbox or Live key) writes a synthetic event of the type you name into your Sandbox webhook stream with a realistic payload, delivered and signed exactly like a real one. Use it to test every `conversion.*` and `payout.*` handler before you can produce the real event. Synthetic events are always Sandbox events and are only ever delivered to Sandbox endpoints. `POST /v1/webhook-endpoints/{id}/test` (`ensc.webhookEndpoints.sendTest`) queues one event in that endpoint's environment instead of the whole Sandbox stream. The full receiver guide is [Webhooks](./webhooks.md).

## Moving to Live

Generate Live keys, switch the chain slug from `celo-sepolia` to `celo`, point your wallet at the mainnet RPC, and follow the checklist in [Going live](./going-live.md). Nothing else in your integration changes.
