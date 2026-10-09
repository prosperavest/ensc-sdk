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

## Response decryption (ENSC-RESP-V2)

Every successful (2xx) JSON response to a secret or restricted key is sealed to your signing key and signed by ENSC. Error responses are plain JSON.

There are two response versions, and your request chooses between them:

| Your request | The response |
|---|---|
| Carries `X-ENSC-Response-Nonce` | **ENSC-RESP-V2**: signed and sealed for that one request and for your account. Use this. |
| Does not carry it | **ENSC-RESP-V1**: signed and sealed, but not tied to a request. It is served so that `@ensc/sdk` 0.5.0 and earlier keep working. |

### Ask for a response bound to your request

Send a fresh random value with every request, reads included:

```
X-ENSC-Response-Nonce: <32 random bytes as base64url without padding: exactly 43 characters>
```

Take the bytes from a cryptographic random source, use a value once, and keep it until the response arrives: you check the response against the value you sent. A value in any other form is refused with `400 ENSC_VALIDATION_FAILED` before the request is carried out. On a write the value is also one of the lines you sign (ENSC-V2, see [Authorization](./authorization.md#request-signature-writes)), so a write is carried out only with the value you chose.

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
{ "v": 2, "enc": "<base64url, 43 chars>", "ciphertext": "<base64url>" }
```

### Verify, then open

1. Fetch ENSC's public keys from `GET /v1/.well-known/ensc-public-keys.json` (cache them; refetch once if you meet an unknown `X-ENSC-Key-Id`). Pick the entry whose `kid` equals the header and whose `use` includes `"responses"`.
2. Reject the response if `X-ENSC-Timestamp` is more than 300 seconds from your clock.
3. Verify the Ed25519 signature over the UTF-8 bytes of these ten lines, joined with a single `\n`:

```
ENSC-RESP-V2
{requestId}                               the X-ENSC-Request-Id response header
{timestamp}                               the X-ENSC-Timestamp response header
{METHOD}                                  of your request, upper-case
{PATH}                                    of your request, no query string
{sha256_hex(canonical query)}             of your request, see "The canonical query" below
{responseNonce}                           the X-ENSC-Response-Nonce you sent
{merchantId}                              your merchant id (mrc_…)
{signingKeyId}                            the id of your signing key (sig_…): the one you send as X-ENSC-Key-Id, the key the response is sealed to
{sha256_hex(body)}                        the raw response body exactly as received
```

   Take the method, path, query and nonce from the request you sent, and the merchant id and signing key id from your own credentials, never from anything in the response. Do not parse the body before the signature verifies.

4. Check that the body is `{ "v": 2, "enc", "ciphertext" }` with exactly these three keys, then open it with HPKE, RFC 9180, **base mode**:
   - KEM `DHKEM(X25519, HKDF-SHA256)` (0x0020), KDF `HKDF-SHA256` (0x0001), AEAD `ChaCha20-Poly1305` (0x0003)
   - Recipient private key: your Ed25519 signing seed converted to X25519 (SHA-512 of the seed, clamp the first 32 bytes; this is the standard Ed25519-to-X25519 conversion)
   - `enc`: the sender's ephemeral public key from the body
   - `info`: UTF-8 bytes of `ENSC-RESP-V2\n{requestId}\n{METHOD}\n{PATH}\n{sha256_hex(canonical query)}\n{responseNonce}\n{merchantId}\n{signingKeyId}` (eight lines: those of step 3 without the timestamp and the body hash)
   - `aad`: empty
   - Plaintext: the JSON response documented for the endpoint

A response that ENSC made for another request fails step 3 and would fail step 4: it is signed and sealed for another nonce, method, path or query. So does a response ENSC made for another account that sent the very same request: it carries that account's merchant id and key id. The key that opens the body does not replace this check, because a signing key is not exclusive to one account. If you asked for ENSC-RESP-V2, accept nothing else. In particular do not fall back to the ENSC-RESP-V1 check when step 3 fails: a response that is not tied to your request is not an answer to it.

### The canonical query

Both signed strings hash the query of the request in one canonical form. In JavaScript it is `new URLSearchParams(query)`, sorted, then `toString()`. Without it:

1. Take the query string as sent, without the `?`, and split it on `&`. Skip empty pieces. In each piece the text before the first `=` is the name and the rest is the value; a piece without `=` has an empty value.
2. Decode each name and each value as `application/x-www-form-urlencoded`: `+` is a space, `%XX` is one byte, and the bytes are read as UTF-8. A `%` that is not followed by two hex digits stays as it is.
3. Sort the pairs by decoded name, then by decoded value, comparing UTF-16 code units (for ASCII text that is byte order).
4. Write each pair as `name=value` and join the pairs with `&`. Encode each name and value as `application/x-www-form-urlencoded`: a space becomes `+`; the characters `A-Z a-z 0-9 * - . _` stay as they are; every other byte of the UTF-8 text becomes `%XX` in upper-case hex.

No query gives the empty string. **A key that appears more than once** keeps every one of its values under ENSC-V2 and ENSC-RESP-V2: each pair is part of what is signed. Under ENSC-V1 the API reads only the first value of a repeated key, so sign an ENSC-V1 request over one value per key.

| Query string as sent | Canonical query | SHA-256 of the canonical query |
|---|---|---|
| (none) | (empty string) | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `status=succeeded&limit=2` | `limit=2&status=succeeded` | `4d7ef8f5ed84d000ea0f019c83126d42775a0c02cca4dbff6a5f1626a4e98551` |
| `q=a%20b%3Ac&limit=2` (the value is `a b:c`) | `limit=2&q=a+b%3Ac` | `80905aac7dee9d5ffc921c53271169736e4ba4a748a6ee161b4d981a61f7db57` |
| `q=a+b:c&limit=2` (the same value, spelled another way) | `limit=2&q=a+b%3Ac` | `80905aac7dee9d5ffc921c53271169736e4ba4a748a6ee161b4d981a61f7db57` |
| `tag=b&tag=a&tag=b` | `tag=a&tag=b&tag=b` | `20129cea9195cf6223ff40601d1316c144d844e2fbdcbfa8254eacb3045e4747` |
| `name=%C3%A9~&flag` | `flag=&name=%C3%A9%7E` | `1bcc76a18334a64104c9815e7eedca665a46d80ed600ab10585661fe73f94b78` |
| `b=1&=x&a=%2f` | `=x&a=%2F&b=1` | `1e1a939bfa2eb3adb6170caffc6c5fb8a582f7c81dbc55dfd3bc8aa14b18d52a` |

### ENSC-RESP-V1

What a request without `X-ENSC-Response-Nonce` receives. The headers are the same, the body has `"v": 1`, the signed string is

```
ENSC-RESP-V1\n{requestId}\n{timestamp}\n{sha256_hex(body)}
```

and the HPKE `info` is the UTF-8 bytes of `ENSC-RESP-V1\n{requestId}`; everything else is as above. It proves that ENSC sealed and signed the response and that it is recent. It does not prove which request the response answers, so a new integration should not use it.

### Test vectors

Fixed inputs and the exact bytes they produce, to check an implementation against. The keys are test values and protect nothing. Seeds are 32 bytes, base64url: the merchant seed is the bytes `00` to `1f`, ENSC's seed `20` to `3f`, and the nonce the bytes `60` to `7f`. The sender's ephemeral key is RFC 9180 `DeriveKeyPair` of the bytes `40` to `5f`.

| Input | Value |
|---|---|
| Merchant signing seed | `AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8` |
| Merchant public key | `A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg` |
| ENSC signing seed | `ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8` |
| ENSC public key | `Kay64UG8yvCyLhqU000LxzYeUm0L_hLIl5S8kyKWbdc` |
| `X-ENSC-Response-Nonce` | `YGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn8` |
| `X-ENSC-Request-Id` | `req_01HZXVECTOR0000000000000001` |
| `X-ENSC-Timestamp` | `1790000000` |
| Merchant id | `mrc_01HZXVECTOR000000000000000` |
| Signing key id | `sig_01HZXVECTOR000000000000000` |

A read, `GET /v1/conversions?status=succeeded&limit=2`, answered with the plaintext `{"data":[],"pagination":{"nextCursor":null,"hasMore":false}}`:

```
canonical query    limit=2&status=succeeded
sha256 of it       4d7ef8f5ed84d000ea0f019c83126d42775a0c02cca4dbff6a5f1626a4e98551

HPKE info (eight lines)
ENSC-RESP-V2
req_01HZXVECTOR0000000000000001
GET
/v1/conversions
4d7ef8f5ed84d000ea0f019c83126d42775a0c02cca4dbff6a5f1626a4e98551
YGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn8
mrc_01HZXVECTOR000000000000000
sig_01HZXVECTOR000000000000000

response body
{"v":2,"enc":"sln27pLcugERhQsTs_bczIJ3JvmwgjWrYpIraz8_Khk","ciphertext":"X9Vj6XgM7GGMqBeKMDc4JNyH5ocjfp6sKLvjfhmt5zzIsCwhqeo1IkJCZ1MJIXmljCxepnPObCYCp2EYms4D2Ne3bZfcw0QIxNeImw"}

signed string (ten lines)
ENSC-RESP-V2
req_01HZXVECTOR0000000000000001
1790000000
GET
/v1/conversions
4d7ef8f5ed84d000ea0f019c83126d42775a0c02cca4dbff6a5f1626a4e98551
YGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn8
mrc_01HZXVECTOR000000000000000
sig_01HZXVECTOR000000000000000
6fc363dfe69ef0ec8013482d5dca662d866d63b513cca90d98d8a7f760e32627

X-ENSC-Signature
ed25519=kSJXv--ifeosd1fmwXPPqnPHusxqhaIRbewqbia1mqIFT0t99w3Qb8y6DsHBe_aAQxsOGemwAKjkYUZP10GUAg
```

The vector for a signed write is in [Authorization](./authorization.md#request-signature-writes). Both are checked by the SDK's own test suite (`packages/ensc-protocol/tests/response.test.ts`).

### Errors the SDK raises

| Code | Meaning |
|---|---|
| `ENSC_INVALID_SIGNATURE` | Missing headers or an empty body (an unsealed 2xx), unknown ENSC key id, malformed or failed signature, a response signed for another request or another account, or timestamp outside the window. `details.reason` is `response_not_bound` when the response is a genuine ENSC-RESP-V1 one |
| `ENSC_DECRYPTION_FAILED` | The envelope is malformed or does not open with your signing key (usually a mismatched `signingKeyId` / `signingPrivateKey` pair) |
| `ENSC_UPSTREAM_FAILED` | Network error or timeout, an unreadable body, or a non-ENSC answer from a gateway; `status` carries the HTTP status when there was one |

## Which key does ENSC seal to?

The signing key named by the `X-ENSC-Key-Id` header on your request. Writes always carry it; send it on reads too. If you omit it on a read and have exactly one usable signing key, ENSC uses that one; with several, it answers `ENSC_MISSING_PUBLIC_KEY` and asks you to state the key. A key id that is not one of your keys is `ENSC_MISSING_PUBLIC_KEY` on reads and writes alike. The id of the key ENSC seals to is the `{signingKeyId}` line of an ENSC-RESP-V2 response, so always send the header and you know which id to check.

## Reference implementation

`@ensc/sdk` 0.6.0 is the reference: `encryptRequestBody` and `openSealedResponse` in its source do exactly the steps above using Web Crypto and the `@noble` libraries. If your implementation disagrees with the SDK against the same inputs, the SDK is right.
