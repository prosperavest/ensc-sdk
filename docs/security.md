# Security

Every call between your server and ENSC is protected by three independent layers on top of TLS. The official SDK (`@ensc/sdk`) applies all of them automatically; this page explains what they are so you know what you are relying on.

## Your credentials

When you generate keys in the dashboard you receive three secrets, with their identifiers, for each environment (Sandbox, Live):

| Credential | Secret | What it does |
|---|---|---|
| **API key** (`ensc_live_sk_…` / `ensc_test_sk_…`) | yes | Identifies your merchant account and its permissions. Sent as `Authorization: Bearer`. |
| **Encryption key** + id (`enc_…`) | yes | A 256-bit AES key. Every request body you send is encrypted with it before it leaves your server. |
| **Signing private key** + id (`sig_…`) | yes | An Ed25519 key. Signs every write, and is the only key that can open the responses ENSC sends you. |
| **IP allowlist** (Live only) | no | The addresses your live API key may be used from. |

Plus your **merchant id** (`mrc_…`), which is not secret.

The secrets are shown once, at generation. ENSC keeps only a hash of the API key and only the public half of your signing key; it stores your encryption key wrapped under its own key so it can decrypt your requests. Nobody at ENSC can recover a lost secret: rotate instead.

## Layer 1: encrypted requests

The body of every write (creating a conversion, reporting its transaction, requesting a voucher or payout, resolving a bank account, building a transfer, webhook endpoint management) is encrypted with AES-256-GCM under your encryption key and sent as an envelope:

```json
{ "v": 1, "encKeyId": "enc_…", "iv": "…", "ciphertext": "…", "tag": "…" }
```

The encryption is bound to the HTTP method, the path, your merchant id and the key id, so a captured envelope cannot be replayed against another endpoint or another account. ENSC decrypts inside its application code, after TLS termination, and validates the plaintext there. Plaintext bodies are refused; there is no way to turn encryption off.

## Layer 2: signed requests

Every write also carries an Ed25519 signature over the method, path, query, a hash of the (encrypted) body, a timestamp, a single-use nonce, your merchant id and your idempotency key. ENSC verifies it against your registered public key, rejects timestamps more than five minutes off, and rejects any nonce it has seen before. A request cannot be altered in transit or replayed.

## Layer 3: sealed and signed responses

Every successful response is encrypted to your signing key using HPKE (RFC 9180: X25519, HKDF-SHA256, ChaCha20-Poly1305) and signed by ENSC:

```json
{ "v": 1, "enc": "…", "ciphertext": "…" }
```

with headers `X-ENSC-Signature`, `X-ENSC-Key-Id`, `X-ENSC-Timestamp`, `X-ENSC-Request-Id`. The SDK checks ENSC's signature against the public keys published at `GET /v1/.well-known/ensc-public-keys.json` before it opens anything, so a forged or substituted response is never parsed. Only your signing private key can open the body: someone holding just your API key learns nothing from the responses.

Error responses are not sealed, so a 4xx or 5xx is always readable.

## What each stolen credential buys an attacker

| Attacker has | Can | Cannot |
|---|---|---|
| API key only | Send requests from an allowlisted IP | Read any response; make any write |
| API key + encryption key | Produce well-formed requests | Get them accepted (no signature); read responses |
| API key + signing key | Read responses; sign requests | Get a write accepted (body must be encrypted with your encryption key) |
| Everything, from an unknown network | Nothing (Live keys are IP-allowlisted) | |

If you suspect any credential has leaked, rotate it from the dashboard. Rotation keeps the old key working for 24 hours so you can roll your deployment; revocation is immediate.

## Your wallet key stays yours

ENSC never holds or asks for a wallet private key. Every on-chain action (a conversion, a transfer) is returned as unsigned calldata, `{ from, to, data, value: "0", chainId }`, that your own wallet signs and broadcasts. Conversions are additionally gated by a voucher that ENSC signs for the exact wallet, amounts and deadline you asked for; the converter contract refuses a voucher presented by any other wallet, reused, or presented after its deadline. See [Conversions](./conversions.md).

Bank account details you give for a payout are stored encrypted; ENSC's responses and webhooks show only the last four digits. A payout is sent only to the account your conversion committed to on chain.

## Webhooks

Webhooks ENSC sends to you are signed with the same Ed25519 key that signs responses, over the webhook id, the timestamp and the SHA-256 of the raw body (`ENSC-WH-V1`). There is no shared secret to store or rotate. Verify them with `EnscClient.constructEvent()` and the key from `/v1/.well-known/ensc-public-keys.json` before acting on a delivery, and de-duplicate on the event id. Webhook payloads never carry bank account numbers. The receiver guide is [Webhooks](./webhooks.md).

## Where this is implemented

All of the above is standard cryptography (AES-GCM, Ed25519, HPKE) implemented on audited primitives; nothing is proprietary. The SDK and the API share the same implementation, and the API's test suite runs the SDK end to end against it.
