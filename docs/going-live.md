# Going live

Moving from Sandbox to Live changes your credentials and your endpoint's expectations of you. The API surface is identical.

## Checklist

1. **Complete business verification** in the dashboard. Live keys cannot be generated before it is approved.
2. **Know your egress IPs.** Live keys require an IP allowlist (1 to 32 addresses or CIDR ranges). See [IP allowlist](./ip-allowlist.md).
3. **Generate Live keys** (dashboard → Live → API keys → Generate keys). Save the six values once. See [Generating keys](./generating-keys.md).
4. **Configure your production environment** with the six live values. Keep them in a secret manager; never in source control or a client bundle.
5. **Upgrade the SDK** to `@ensc/sdk` 0.4.0 or later. 0.4.0 introduced the conversions API; earlier versions call endpoints that no longer exist, and versions before 0.3.0 send plaintext requests the API refuses.
6. **Register your production webhook endpoint** and verify deliveries against the public key at `GET /v1/.well-known/ensc-public-keys.json`. Send a test event from the dashboard or with `ensc.webhookEndpoints.sendTest(id)`. Handle every event type listed in [Conversions](./conversions.md), in particular `conversion.requires_manual_review` and `payout.failed`.
7. **Run one read and one write** against Live before routing traffic: for example `ensc.banks.list()` and a small `ensc.conversions.create({ type: 'crypto-issue', chain: 'celo', ... })` that you sign, broadcast and report with `ensc.conversions.events.confirmed()`. Fund the wallet with a little native gas token first.
8. **Switch the chain slug.** Sandbox conversions run on `celo-sepolia`; Live conversions run on `celo`. The chain id in every unsigned transaction changes with it (see [Environments](./environments.md)).
9. **Set up rotation.** Decide who holds the dashboard access that can rotate and revoke, and rehearse a rotation on Sandbox: rotate, deploy the new value, confirm, let the old key expire after 24 hours.

## Sandbox vs Live

| | Sandbox | Live |
|---|---|---|
| Key prefix | `ensc_test_` | `ensc_live_` |
| IP allowlist | optional | required |
| Converter chain | `celo-sepolia` (chain id 11142220) | `celo` (chain id 42220) |
| Money | test tokens; the sandbox bank rail simulates collections and payouts | real tokens and real NGN collections and payouts |
| Bank list, account resolution | sandbox bank rail | live bank rail |
| Request encryption, signing, sealed responses | identical | identical |

A test key can never touch live resources and a live key can never touch test resources (`ENSC_TEST_LIVE_MISMATCH`, or `ENSC_INVALID_CHAIN` when a live key names a testnet). Everything else about the two environments is in [Environments](./environments.md).

## Operational expectations

- **Idempotency keys on every write.** Your retries then can never double-execute. The SDK does this by default.
- **Clock accuracy.** Signatures and sealed responses are time-bound to 5 minutes; run NTP on the servers that call ENSC.
- **Handle `ENSC_RATE_LIMITED`** (429) by backing off; the default limit is 600 requests per minute per key.
- **Watch `expiresAt`** on rotated keys (`signingKeys.list()`, `apiKeys.list()`, `encryptionKeys.list()`) so a rotation is completed inside its 24-hour window.
- **Pin `X-ENSC-API-Version`.** The SDK pins `2026-09-15`. Read the changelog before adopting a newer version.

## If a credential leaks

Revoke it in the dashboard immediately (revocation takes effect within seconds), generate a replacement, deploy. Because responses are sealed to your signing key and writes need your encryption key, a leaked API key alone does not expose data or enable writes, but treat any leak as a rotation of all four credentials.
