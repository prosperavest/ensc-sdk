# Webhooks

ENSC tells your backend what happened by sending signed events to an https URL you own. Every conversion and payout outcome reaches you this way, without polling. This page is the receiver guide; the event list is in [Conversions](./conversions.md#webhook-events).

## How it works

1. **You register an endpoint**: a public https URL on your backend, per environment (Sandbox, Live), subscribed to the event types you want (`["*"]` for all). From the dashboard (Webhooks tab) or with `POST /v1/webhook-endpoints` (`ensc.webhookEndpoints.create`).
2. **ENSC delivers**: one `POST` per event, JSON body, signed headers.
3. **You verify, acknowledge, then process**: check the signature over the raw body, answer `200`, and do the work afterwards.
4. **ENSC retries** until your endpoint answers 2xx or the attempts run out, so you must handle duplicates.

Nothing here needs a tunnel or a request inspector. Your receiver is part of your backend and runs wherever that runs; register the URL it is reachable at.

## Registering an endpoint

| Field | Rule |
|---|---|
| `env` | `test` or `live`. Sandbox events go only to Sandbox endpoints and Live events only to Live endpoints. |
| `url` | `https://` with a public hostname. `http://`, `localhost`, IP addresses and single-label hosts are refused (`ENSC_VALIDATION_FAILED`). No credentials in the URL. |
| `eventTypes` | 1 to 64 entries: event types, or `"*"` for all. |
| `description` | Optional, for your own reference. |
| `apiVersion` | Optional: pin the payload version deliveries use. Defaults to the current version. |

An endpoint can be disabled and re-enabled (`PATCH` with `status`), changed (`url`, `eventTypes`, `description`) and deleted. A disabled endpoint receives no new events, and retries already scheduled for it stop.

No secret is issued when you register. Deliveries are signed with ENSC's own key (next section), so there is nothing to store or rotate on your side.

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

{ "id": "ev_01M2…", "type": "conversion.succeeded", "apiVersion": "2026-09-15", "created": 1789590000, "data": { … } }
```

| Field | Meaning |
|---|---|
| `id` | The event id. The same id is sent on every retry of the same event: de-duplicate on it. |
| `type` | The event type (`conversion.*`, `payout.*`, or `synthetic.test_event`). |
| `apiVersion` | The payload version, the endpoint's pinned version or the current one. |
| `created` | Unix seconds when this delivery was made (also `X-ENSC-Timestamp`). |
| `data` | The conversion summary for `conversion.*` events, the payout summary for `payout.*` events; the same objects the read API returns. Never a bank account number. |

`X-ENSC-Webhook-Id` is unique per delivery attempt and is part of the signed string.

## Verifying a delivery

The signature is Ed25519 over

```
ENSC-WH-V1\n<X-ENSC-Webhook-Id>\n<X-ENSC-Timestamp>\n<hex SHA-256 of the raw request body>
```

made with the ENSC key named by `X-ENSC-Key-Id`. The public keys are published at `GET /v1/.well-known/ensc-public-keys.json` (entries with `use` containing `webhooks`); `EnscClient.fetchPublicKeys()` loads them as `{ [kid]: publicKey }`. Fetch the document once, cache it per key id, and refetch on an unknown id: that is how a key rotation reaches you without any action on your side.

Rules that keep the check sound:

- Hash the **raw bytes** you received. Parsing the JSON and re-serialising it changes the bytes and the signature no longer matches.
- Refuse a delivery whose timestamp is more than 5 minutes from your clock; a retry always carries a fresh timestamp and signature.
- Compare in constant time, or use the SDK.

With `@ensc/sdk`:

```ts
import { EnscClient } from '@ensc/sdk';

export async function handleEnscWebhook(rawBody: string, headers: Headers): Promise<Response> {
  let event;
  try {
    event = EnscClient.constructEvent({ body: rawBody, headers, publicKey: enscKeys }); // enscKeys = await EnscClient.fetchPublicKeys(), cached
  } catch {
    return new Response('invalid signature', { status: 401 });
  }
  if (await alreadySeen(event.id)) return new Response(null, { status: 200 });
  await enqueue(event);                 // process after answering
  return new Response(null, { status: 200 });
}
```

`constructEvent` throws `ENSC_INVALID_SIGNATURE` when the signature does not verify under the key you pass, the key id is not in the map you pass, or the timestamp is outside the window, and `ENSC_VALIDATION_FAILED` when the verified body is not an event envelope. `EnscClient.verifyWebhookSignature` is the non-throwing form. Any Ed25519 implementation can do the same check without the SDK; the SDK's test suite carries the vectors.

## Answering and processing

- **Answer 2xx within 15 seconds.** ENSC waits that long. Verify, record the event id, answer, then process. Do not call your bank, ENSC or a chain node before answering.
- **Any other outcome is retried**: a non-2xx answer, a redirect, a timeout or a connection failure. The retries come after 1 minute, 5 minutes, 15 minutes, 1 hour, 2 hours, 4 hours and 8 hours: 8 attempts in total over about 15 hours. Then the delivery is marked `gave_up`. Disabling the endpoint ends its retries.
- **Delivery is at least once.** A retry after a lost answer delivers the same event id again. Store the ids you have processed and skip duplicates.
- **Order is not guaranteed.** Two events for one conversion can arrive out of order or seconds apart. Act on the `status` the event carries, not on the sequence, and before releasing goods or money read the conversion back with `GET /v1/conversions/{reference}`.
- **Credit on the final event**: `conversion.succeeded` for crypto legs and `fiat-issue`, `payout.succeeded` for a `fiat-redeem`. Earlier events are progress, not money.
- **Ignore fields you do not know.** New fields can appear in a payload; write the handler so they do not break it.

## Seeing what was delivered

`GET /v1/events` (`ensc.events.list`) is the log of every event ENSC generated for you, with `env` and `type` filters. `GET /v1/events/{id}` (`ensc.events.get`) adds the delivery attempts: for each, the endpoint, the attempt number, `status` (`pending`, `delivered`, `failed`, `gave_up`), the HTTP status your endpoint answered, when the next attempt is due and the first 500 characters of your response. The dashboard shows the same log.

## Testing your receiver

1. Deploy the receiver to the URL you will register, on the same hosting as the rest of your backend.
2. Register that URL in Sandbox.
3. `POST /v1/webhook-endpoints/{id}/test` (`ensc.webhookEndpoints.sendTest(id, { eventType })`) queues one signed event in that endpoint's environment; every active endpoint there that subscribes to the type receives it, and the response says whether the endpoint you named is among them (`willDeliverToTargetEndpoint`). With an `eventType` from the catalogue and no `payload`, the delivery carries the fields a real event of that type carries; with no `eventType` it is a `synthetic.test_event`. A Live endpoint accepts only `synthetic.test_event`, so a real event type can never be forged into a Live receiver. `POST /v1/test-data/events` (`ensc.testEvents.emit`) sends a realistic event to every Sandbox endpoint, and `GET /v1/test-data/events` (`ensc.testEvents.list`) shows the catalogue with a sample payload per type.
4. Read the attempt back with `GET /v1/events/{eventId}` and confirm `status: "delivered"` with your `200`.

During local development, before the receiver is deployed, any tool that gives a local port a public https hostname works for step 2. It is a stand-in for the deployed URL, not part of the integration, and the URL changes when the tool restarts.

## Going live

Register a Live endpoint (a Live key or the Live dashboard) with your production URL. Sandbox endpoints never receive Live events and Live endpoints never receive Sandbox events, so both can stay registered. Keep the same verification code: the key set and the signing scheme are the same in both environments.
