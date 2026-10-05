# Webhooks

ENSC tells your backend what happened by sending signed events to an https URL you own. Every conversion and payout outcome reaches you this way, without polling. This page is the receiver guide; the event list is in [Conversions](./conversions.md#webhook-events).

## How it works

1. **You register an endpoint**: a public https URL on your backend, per environment (Sandbox, Live), subscribed to the event types you want (`["*"]` for all). From the dashboard (Webhooks tab) or with `POST /v1/webhook-endpoints` (`ensc.webhookEndpoints.create`).
2. **ENSC delivers**: one `POST` per event, JSON body, signed headers.
3. **You verify, acknowledge, then process**: check the signature over the raw body, check that the event is yours (`merchantId`, `env`), answer `200`, and do the work afterwards.
4. **ENSC retries** until your endpoint answers 2xx or the attempts run out, so you must handle duplicates.

Your receiver is part of your backend and runs wherever that runs; register the URL it is reachable at.

## Registering an endpoint

| Field | Rule |
|---|---|
| `env` | `test` or `live`: the environment of the key you register with. Sandbox events go only to Sandbox endpoints and Live events only to Live endpoints. |
| `url` | `https://` on the default port, with a public host name and no credentials in the URL. Anything else is refused when you register or change the endpoint (`400 ENSC_VALIDATION_FAILED`; `details.fields` names the field). See [The destination](#the-destination). |
| `eventTypes` | 1 to 64 entries: event types, or `"*"` for all. |
| `description` | Optional, for your own reference. |
| `apiVersion` | Optional: pin the payload version deliveries use. Defaults to the current version. |

```ts
const endpoint = await ensc.webhookEndpoints.create({
  env: 'test',              // the environment of the key in use
  url: webhookUrl,          // a public https URL on your backend
  eventTypes: ['*'],
});
```

An endpoint can be disabled and re-enabled (`PATCH` with `status`), changed (`url`, `eventTypes`, `description`) and deleted. A disabled endpoint receives no new events, and retries already scheduled for it stop. With the SDK: `webhookEndpoints.list()`, `get(id)`, `update(id, { ... })`, `remove(id)`.

No secret is issued when you register. Deliveries are signed with ENSC's own key (see [Verifying a delivery](#verifying-a-delivery)), so there is nothing to store or rotate on your side.

### Endpoints belong to an environment

A key manages the endpoints of its own environment and no others. With a Sandbox key you create, list, read, change, delete and test Sandbox endpoints; with a Live key, Live endpoints.

- `POST /v1/webhook-endpoints` with an `env` other than the key's is refused with `400 ENSC_TEST_LIVE_MISMATCH`.
- `GET /v1/webhook-endpoints` lists the endpoints of the key's environment, whatever `env` the query names.
- Reading, changing, deleting or testing an endpoint of the other environment answers `404 ENSC_NOT_FOUND`, as an endpoint that does not exist does.

The dashboard shows both environments.

### At most 20 endpoints per environment

You can register up to 20 endpoints in Sandbox and 20 in Live. One more is refused with `409 ENSC_INVALID_STATE`; `details.limit` is `20` and `details.env` names the environment. Delete an endpoint to add another.

### The destination

A webhook URL is `https://`, on the default port, with a public host name and no credentials. The rule is applied when you register an endpoint, when you change its URL, and again each time an event is sent.

When you register or change an endpoint, a URL outside the rule is refused with `400 ENSC_VALIDATION_FAILED`. `details.fields` then holds one entry, `{ "path": "url", "message": "invalid value" }`: the answer names the field and does not say which part of the rule the URL broke. A URL is refused when it:

- is not `https://`;
- carries a user name or a password;
- names a port other than the default (`https://hooks.example.com:8443/...`);
- has a host name that ends in a dot;
- has an IP address, in any notation, as its host;
- has a single-label host name (`localhost`, `intranet`) or a private one: a name that ends in `.localhost`, `.local`, `.internal`, `.home.arpa`, `.lan`, `.home` or `.corp`;
- points at a host under `prosperavest.com`;
- is not a URL.

A URL is at most 2048 characters.

- **An endpoint registered earlier with a URL that names a port** stays registered but is never delivered to. Each attempt for it is recorded as failed with `destination refused: the URL must be https on the default port with a public hostname`, and you see that text in the event log. Change its URL to one on the default port.
- **Redirects are never followed.** A 3xx answer is a failed attempt, retried like any other. Register the final URL.

**Scopes**: a secret key manages webhooks and reads the event log. A restricted key needs `webhooks:read` to list and read, `webhooks:manage` to create, change, test or delete endpoints.

## The delivery

```http
POST /your/path HTTP/1.1
Content-Type: application/json
X-ENSC-Signature: ed25519=<base64url>
X-ENSC-Timestamp: 1789590000
X-ENSC-Webhook-Id: whk_01M2…
X-ENSC-Key-Id: ensc_2026_1
X-ENSC-Event-Type: conversion.succeeded
X-ENSC-Event-Id: ev_01M2…
X-ENSC-API-Version: 2026-09-15

{ "id": "ev_01M2…", "type": "conversion.succeeded", "apiVersion": "2026-09-15", "product": "ensc", "merchantId": "mrc_…", "env": "live", "created": 1789590000, "data": { … } }
```

| Field | Meaning |
|---|---|
| `id` | The event id. The same id is sent on every retry of the same event: de-duplicate on it. |
| `type` | The event type (`conversion.*`, `payout.*`, or `synthetic.test_event`). |
| `apiVersion` | The payload version, the endpoint's pinned version or the current one. |
| `product` | `ensc`. |
| `merchantId` | The merchant the event belongs to: your merchant id (`mrc_…`). |
| `env` | The environment the event belongs to: `test` (Sandbox) or `live`. |
| `synthetic` | Present, and `true`, only on a delivery produced by a test request (`POST /v1/webhook-endpoints/{id}/test`, `POST /v1/test-data/events`). Nothing happened behind it. Absent on real events. |
| `created` | Unix seconds when this delivery was made (also `X-ENSC-Timestamp`). |
| `data` | The conversion summary for `conversion.*` events, the payout summary for `payout.*` events; the same objects the read API returns. Never a bank account number. |

`X-ENSC-Webhook-Id` is unique per delivery attempt and is part of the signed string. `merchantId`, `env` and `synthetic` are inside the signed body, so they cannot be changed without breaking the signature.

## Verifying a delivery

The signature is Ed25519 over

```
ENSC-WH-V1\n<X-ENSC-Webhook-Id>\n<X-ENSC-Timestamp>\n<hex SHA-256 of the raw request body>
```

made with the ENSC key named by `X-ENSC-Key-Id`. The public keys are published at `GET /v1/.well-known/ensc-public-keys.json` (entries with `use` containing `webhooks`).

A valid signature proves that ENSC sent these bytes. It does not say for whom: every delivery ENSC makes, to any merchant and in either environment, is signed with the keys in that document. What ties a delivery to you is in the signed body. A receiver therefore checks four things, in this order:

1. **The signature**, over the **raw bytes** you received. Parsing the JSON and re-serialising it changes the bytes and the signature no longer matches. Compare in constant time, or use the SDK.
2. **The timestamp**: refuse a delivery whose timestamp is more than 5 minutes from your clock; a retry always carries a fresh timestamp and signature.
3. **`merchantId`**: it must be your own merchant id. A delivery that names another merchant, or none, is not yours, whatever its signature says.
4. **`env`**: it must be the environment this receiver serves. A Live receiver refuses a `test` delivery and a Sandbox receiver refuses a `live` one.

Then, on a Live receiver, **ignore an event with `synthetic: true`**: answer `200` and do nothing else. It is a test delivery, not something that happened.

### The key document

Load the key document once and keep it; do not load it for every delivery. `X-ENSC-Key-Id` is whatever the sender of a request wrote, so a receiver that loaded the document each time it met an unknown key id would make one request to ENSC for every request anyone posts to its URL. Load it again for an unknown key id at most once in a fixed interval: that is how a key rotation reaches you without any action on your side, and requests with invented key ids cost you nothing. The SDK's key cache does exactly this, once a minute.

### With `@ensc/sdk`

```ts
import { EnscClient } from '@ensc/sdk';

// One per process. Loads ENSC's webhook keys on first use and keeps them; an
// unknown key id loads them again at most once a minute.
const enscKeys = EnscClient.webhookKeyCache();

export async function handleEnscWebhook(rawBody: string, headers: Headers): Promise<Response> {
  let event;
  try {
    event = EnscClient.constructEvent({
      body: rawBody,                             // exactly as received, before any JSON parsing
      headers,
      publicKey: await enscKeys.get(headers),    // the verifier picks the key named by X-ENSC-Key-Id
      merchantId: process.env.ENSC_MERCHANT_ID!, // refuses a delivery signed for another merchant
      env: 'live',                               // refuses a Sandbox delivery; 'test' on a Sandbox receiver
    });
  } catch {
    return new Response('invalid signature', { status: 401 });
  }
  // Live: a test delivery is acknowledged and never acted on.
  if (event.synthetic) return new Response(null, { status: 200 });
  if (await alreadySeen(event.id)) return new Response(null, { status: 200 });
  await enqueue(event);                 // process after answering
  return new Response(null, { status: 200 });
}
```

Everything that can fail, the key lookup included, is inside the `try`: a delivery that cannot be verified is answered `401`, and a genuine one is delivered again by ENSC's retries.

`constructEvent` takes:

| Option | Meaning |
|---|---|
| `body` | The raw request body, a string or bytes, exactly as received and before any JSON parsing. |
| `headers` | A `Headers` instance or a plain record (Node's `req.headers` works). |
| `publicKey` | The key map, `{ [kid]: publicKey }`, from `EnscClient.webhookKeyCache()` (a single key string is accepted too). The verifier picks the key named by `X-ENSC-Key-Id`. |
| `merchantId` | Your merchant id. The delivery must have been signed for it. |
| `env` | `'test'` or `'live'`: the environment this receiver serves. The delivery must have been signed for it. |
| `toleranceSeconds` | The timestamp window, 300 by default. `0` turns the check off; any other value that is not a number of zero or more is refused. |

Always pass `merchantId` and `env`. Without them the verifier checks the signature and the timestamp only, and a genuine delivery made for another merchant, or in Sandbox, would pass.

`constructEvent` throws `ENSC_INVALID_SIGNATURE`, with the reason in `details.reason`, when a check fails, and `ENSC_VALIDATION_FAILED` when the verified body is not an event envelope. `EnscClient.verifyWebhookSignature` takes the same options, never throws and returns `{ valid, reason? }`. The reasons:

| `reason` | Meaning |
|---|---|
| `missing_signature`, `missing_timestamp`, `missing_webhook_id` | A signed header is absent or malformed |
| `bad_signature_format` | `X-ENSC-Signature` is not `ed25519=<base64url>` |
| `timestamp_out_of_tolerance` | The timestamp is outside the window |
| `invalid_tolerance` | `toleranceSeconds` is not a finite number of zero or more (for example `NaN` from an unset variable). The delivery is refused; it is never read as "no window". |
| `unknown_key_id` | The key id is not in the key map |
| `signature_mismatch` | The signature does not verify under that key |
| `merchant_mismatch` | The signature is genuine, but the signed body names another merchant, or none |
| `env_mismatch` | The signature is genuine, but the signed body names the other environment, or none |

`EnscClient.webhookKeyCache()`, `merchantId` and `env` need `@ensc/sdk` 0.5.0 or later. On 0.4.1, verify with `constructEvent({ body, headers, publicKey })` and then compare `event.merchantId` and `event.env` with your own values yourself, refusing the delivery when either differs.

Any Ed25519 implementation can do the same checks without the SDK; the SDK's test suite carries the vectors.

## Answering and processing

- **Answer 2xx within 15 seconds.** ENSC waits that long. Verify, record the event id, answer, then process. Do not call your bank, ENSC or a chain node before answering.
- **Any other outcome is retried**: a non-2xx answer, a redirect, a timeout or a connection failure. The retries come after 1 minute, 5 minutes, 15 minutes, 1 hour, 2 hours, 4 hours and 8 hours: 8 attempts in total over about 15 hours. Then the delivery is marked `gave_up`. Disabling the endpoint ends its retries.
- **Delivery is at least once.** A retry after a lost answer delivers the same event id again. Store the ids you have processed and skip duplicates.
- **Order is not guaranteed.** Two events for one conversion can arrive out of order or seconds apart. Act on the `status` the event carries, not on the sequence, and before releasing goods or money read the conversion back with `GET /v1/conversions/{reference}` (`ensc.conversions.get(reference)`).
- **Credit on the final event**: `conversion.succeeded` for crypto legs and `fiat-issue`, `payout.succeeded` for a `fiat-redeem`. Earlier events are progress, not money. Credit only after the checks above and the read-back.
- **Ignore fields you do not know.** New fields can appear in a payload; write the handler so they do not break it.

## Seeing what was delivered

`GET /v1/events` (`ensc.events.list`) is the log of every event ENSC generated for you in the key's environment, with a `type` filter. `GET /v1/events/{id}` (`ensc.events.get`) adds the delivery attempts: for each, the endpoint, the attempt number, `status` (`pending`, `delivered`, `failed`, `gave_up`), the HTTP status your endpoint answered, when the next attempt is due and the first 500 characters of your response. The dashboard shows the same log.

## Testing your receiver

1. Deploy the receiver to the URL you will register, on the same hosting as the rest of your backend.
2. Register that URL in Sandbox, with a Sandbox key.
3. `POST /v1/webhook-endpoints/{id}/test` (`ensc.webhookEndpoints.sendTest(id, { eventType })`) emits one signed event in that endpoint's environment; every active endpoint there that subscribes to the type receives it, and the response says whether the endpoint you named is among them (`willDeliverToTargetEndpoint`). With an `eventType` from the catalogue and no `payload`, the delivery carries the fields a real event of that type carries; with no `eventType` it is a `synthetic.test_event`. `POST /v1/test-data/events` (`ensc.testEvents.emit`) sends a realistic event to every Sandbox endpoint, and `GET /v1/test-data/events` (`ensc.testEvents.list`) shows the catalogue with a sample payload per type.
4. Read the attempt back with `GET /v1/events/{eventId}` and confirm `status: "delivered"` with your `200`.

Every delivery these two routes produce carries `synthetic: true` in its signed body, with your `merchantId` and the endpoint's `env`. A Live endpoint can be sent only `synthetic.test_event` (`ENSC_TEST_LIVE_MISMATCH` otherwise).

```ts
const { eventId, willDeliverToTargetEndpoint } = await ensc.webhookEndpoints.sendTest(endpoint.id, {
  eventType: 'payout.succeeded',
}); // emitted in the endpoint's environment; false if this endpoint does not subscribe to the type
await ensc.testEvents.emit({ eventType: 'conversion.requires_manual_review' }); // to every Sandbox endpoint
const detail = await ensc.events.get(eventId);   // each attempt, with your endpoint's HTTP answer
```

A test event looks like a real one in every other respect: the same types, the same payload fields, the same signature. Do not rely on the event type, or on where a delivery arrived, to tell a test from a real event. Rely on `env` and `synthetic`, checked as described in [Verifying a delivery](#verifying-a-delivery).

During local development, before the receiver is deployed, any tool that gives a local port a public https hostname works for step 2. It is a stand-in for the deployed URL, not part of the integration, and the URL changes when the tool restarts.

## Going live

Register a Live endpoint with a Live key (or in the Live dashboard) and your production URL. Sandbox endpoints never receive Live events and Live endpoints never receive Sandbox events, so both can stay registered. In the Live receiver pass `env: 'live'` and your merchant id to the verifier, and ignore events with `synthetic: true`. A Sandbox receiver passes `env: 'test'`.
