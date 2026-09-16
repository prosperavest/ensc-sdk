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

Other chains in the registry (`base`, `polygon`, `optimism`, `ethereum` and their testnets) carry the ENSC token only: `balance` and `transfer` work where ENSC is deployed, and `POST /v1/conversions` answers `ENSC_CONVERTER_UNAVAILABLE`.

## The sandbox bank rail

In Sandbox, `GET /v1/banks`, `POST /v1/accounts/resolve`, `fiat-issue` collections and `fiat-redeem` payouts go to the bank rail's sandbox instead of the live banking network. No real money moves. The sandbox has fixed conventions:

- **Test bank**: bank code `044`.
- **Test accounts**: `0690000031` to `0690000041` simulate payouts. `0690000036` is the blacklisted account: a payout to it fails, which is how you exercise the `payout.failed` / `conversion.requires_manual_review` path.
- **Payout outcomes** are driven by a suffix on the transfer reference the rail receives: `_PMCK` succeeds, `_PMCK_ST_F` fails, and `DU_<n>` delays the outcome by `n` minutes. ENSC sends every Sandbox payout with the suffix `_PMCKDU_1`, so a Sandbox `fiat-redeem` to a test account succeeds about one minute after `payout.initiated`, and you see the full `payout_pending` → `payout_in_progress` → `payout_confirmed` → `succeeded` sequence. You cannot choose another suffix through the API; use the blacklisted account for the failure path.
- **Bank transfer only**: the sandbox account, like the live one, has no cards or USSD enabled. `paymentInstructions` on a Sandbox `fiat-issue` describe a sandbox account; the transfer amount and expiry are real values from the rail's sandbox.

`accountName` on a `fiat-redeem` must still match what `accounts/resolve` returns for the test account.

## Screening

Transaction screening applies in both environments with the same statuses and holds. On Sandbox the chain is a testnet, so no wallet analytics run on the counterparty wallet; screening otherwise behaves as on Live.

## Exercising webhooks

`POST /v1/test-data/events` (any key) writes a synthetic event of the type you name into your Sandbox webhook stream with a realistic payload, delivered and signed exactly like a real one. Use it to test every `conversion.*` and `payout.*` handler before you can produce the real event. Sandbox events are only ever delivered to Sandbox endpoints.

## Moving to Live

Generate Live keys, switch the chain slug from `celo-sepolia` to `celo`, point your wallet at the mainnet RPC, and follow the checklist in [Going live](./going-live.md). Nothing else in your integration changes.
