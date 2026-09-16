# Encrypting requests and decrypting responses

`@ensc/sdk` does everything on this page for you. Read on if you integrate from a language without an SDK or want to audit what the SDK does. The formats below are exact; the API refuses anything that deviates.

## Request encryption (ENSC-ENC-V1)

Applies to every `POST`, `PUT`, `PATCH` and `DELETE` made with a secret or restricted key. `GET` requests have no body and are not encrypted.

### Algorithm

- **Cipher**: AES-256-GCM.
- **Key**: your 32-byte encryption key (base64url-decode `ENSC_ENCRYPTION_KEY`).
- **IV**: 12 random bytes, fresh for every request.
- **Tag**: 16 bytes, transmitted separately from the ciphertext.
- **Additional authenticated data (AAD)**: the UTF-8 bytes of

```
ENSC-ENC-V1\n{METHOD}\n{PATH}\n{merchantId}\n{encKeyId}
```

where `METHOD` is upper-case, `PATH` is the request path without query string (for example `/v1/conversions`), and `\n` is a single line feed.

### Envelope

Serialize your request as JSON (this is the plaintext), encrypt it, and send this object as the HTTP body with `Content-Type: application/json`:

```json
{
  "v": 1,
  "encKeyId": "enc_01J…",
  "iv": "<base64url, 16 chars>",
  "ciphertext": "<base64url>",
  "tag": "<base64url, 22 chars>"
}
```

Rules: exactly these five keys, base64url without padding, `v` must be `1`, `encKeyId` must match `^enc_[0-9A-Z]{26}$`, ciphertext must be non-empty and at most 1 MiB. A request without a body still sends an encrypted `{}`.

### Then sign it

The Ed25519 signature (see [Authorization](./authorization.md)) is computed over the envelope bytes exactly as sent, not over the plaintext. Encrypt first, then sign.

### Errors

| Code | Status | Meaning |
|---|---|---|
| `ENSC_ENCRYPTION_REQUIRED` | 400 | Body is not a well-formed envelope (plaintext, extra fields, wrong version, empty ciphertext) |
| `ENSC_UNKNOWN_ENCRYPTION_KEY` | 401 | `encKeyId` does not belong to your account and environment |
| `ENSC_ENCRYPTION_KEY_REVOKED` | 401 | The key was revoked, or rotated more than 24 hours ago |
| `ENSC_DECRYPTION_FAILED` | 400 | Wrong key, wrong AAD (method/path/merchant/key id mismatch), or tampered ciphertext/tag |
| `ENSC_VALIDATION_FAILED` | 400 | Decrypted successfully, but the plaintext is not JSON or fails the endpoint's schema |

## Response decryption (ENSC-RESP-V1)

Every successful (2xx) JSON response to a secret or restricted key is sealed to your signing key and signed by ENSC. Error responses are plain JSON.

### Headers

```
X-ENSC-Signature: ed25519=<base64url, 86 chars>
X-ENSC-Key-Id: <ENSC key id>
X-ENSC-Timestamp: <unix seconds>
X-ENSC-Request-Id: <request id>
Cache-Control: no-store
```

### Body

```json
{ "v": 1, "enc": "<base64url, 43 chars>", "ciphertext": "<base64url>" }
```

### Verify, then open

1. Fetch ENSC's public keys from `GET /v1/.well-known/ensc-public-keys.json` (cache them; refetch once if you meet an unknown `X-ENSC-Key-Id`). Pick the entry whose `kid` equals the header and whose `use` includes `"responses"`.
2. Reject the response if `X-ENSC-Timestamp` is more than 300 seconds from your clock.
3. Verify the Ed25519 signature over the UTF-8 bytes of

```
ENSC-RESP-V1\n{requestId}\n{timestamp}\n{sha256_hex(body)}
```

where `body` is the raw response body exactly as received. Do not parse the body before the signature verifies.

4. Open the envelope with HPKE, RFC 9180, **base mode**:
   - KEM `DHKEM(X25519, HKDF-SHA256)` (0x0020), KDF `HKDF-SHA256` (0x0001), AEAD `ChaCha20-Poly1305` (0x0003)
   - Recipient private key: your Ed25519 signing seed converted to X25519 (SHA-512 of the seed, clamp the first 32 bytes; this is the standard Ed25519-to-X25519 conversion)
   - `enc`: the sender's ephemeral public key from the body
   - `info`: UTF-8 bytes of `ENSC-RESP-V1\n{requestId}`
   - `aad`: empty
   - Plaintext: the JSON response documented for the endpoint

### Errors the SDK raises

| Code | Meaning |
|---|---|
| `ENSC_INVALID_SIGNATURE` | Missing headers (an unsealed 2xx), unknown key id, malformed or failed signature, or timestamp outside the window |
| `ENSC_DECRYPTION_FAILED` | The envelope is malformed or does not open with your signing key (usually a mismatched `signingKeyId` / `signingPrivateKey` pair) |

## Which key does ENSC seal to?

The signing key named by the `X-ENSC-Key-Id` header on your request. Writes always carry it; send it on reads too. If you omit it on a read and have exactly one usable signing key, ENSC uses that one; with several, it answers `ENSC_MISSING_PUBLIC_KEY` and asks you to state the key.

## Reference implementation

`@ensc/sdk` is the reference: `encryptRequestBody` and `openSealedResponse` in its source do exactly the steps above using Web Crypto and the `@noble` libraries. If your implementation disagrees with the SDK against the same inputs, the SDK is right.
