# Generating keys

You need three secrets and three identifiers per environment to call the ENSC API. The dashboard issues them together.

## Before you start

- **Sandbox** keys are available once your business profile is complete.
- **Live** keys require an approved business verification, and you must add at least one IP address or range to the allowlist before a live key can be generated (see [IP allowlist](./ip-allowlist.md)).

## Steps

1. Sign in to the dashboard and choose **Sandbox** or **Live**.
2. Open the **Credentials** tab and click **Generate keys**.
3. For Live, enter the IP addresses or CIDR ranges your servers call ENSC from (up to 32).
4. The dashboard creates your API key, your encryption key and an Ed25519 signing keypair, registers the public half with ENSC, and shows the six values **once**:

```sh
ENSC_API_KEY=ensc_live_sk_…
ENSC_MERCHANT_ID=mrc_…
ENSC_ENCRYPTION_KEY=…            # 43 characters, base64url
ENSC_ENCRYPTION_KEY_ID=enc_…
ENSC_SIGNING_KEY_ID=sig_…
ENSC_SIGNING_PRIVATE_KEY=…       # 43 characters, base64url
```

5. Click **Download .env** (or **Copy as .env**) and store the values in your secret manager or environment, then tick **I have stored these values**. They cannot be shown again.

## Using them

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
```

All six are required. The client validates their shape at construction and throws `ENSC_VALIDATION_FAILED` with the name of the field that is missing or malformed.

## Key types

- **Secret key** (`sk`): full access for your backend. The type the dashboard generates.
- **Restricted key** (`rk`): a secret key with a reduced permission set, for services that only need part of the API.
- **Publishable key** (`pk`): browser-safe, read-only, limited to the origins you allow. Not used with the SDK.

## Rotating and revoking

Each credential rotates independently from the dashboard:

- **Rotate** issues a replacement and shows it once. The previous key keeps working for **24 hours**, so deploy the new value, confirm traffic is healthy, and let the old one expire. The lists show the exact expiry (`expiresAt`).
- **Revoke** stops a key immediately. Use it when a credential has leaked.

When you rotate the encryption key, update `ENSC_ENCRYPTION_KEY` and `ENSC_ENCRYPTION_KEY_ID` together. When you rotate the signing key, update `ENSC_SIGNING_PRIVATE_KEY` and `ENSC_SIGNING_KEY_ID` together.

The SDK can list your keys (`ensc.apiKeys.list()`, `ensc.encryptionKeys.list()`, `ensc.signingKeys.list()`) but cannot create, rotate or revoke them; those actions are available only in the dashboard.

## Losing a secret

There is no recovery. Rotate the affected key and update your deployment.
