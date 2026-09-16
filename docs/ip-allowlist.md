# IP allowlist

Live API keys work only from the IP addresses you register. Sandbox keys are not restricted.

## Why

An API key that leaks (a log line, a CI artifact, a laptop) is useless to whoever finds it unless they also control one of your servers' egress addresses. Together with request signing and encryption, the allowlist means all four of your credentials have to be stolen from your infrastructure, from inside your network, for an attacker to act as you.

## Rules

- Required for every **Live** key: you cannot generate one without at least one entry (`ENSC_IP_ALLOWLIST_REQUIRED`), and a live key whose allowlist is somehow empty is refused on every request.
- 1 to 32 entries per key. Each entry is a single IPv4 or IPv6 address (`203.0.113.10`, `2001:db8::10`) or a CIDR range (`203.0.113.0/24`, `2001:db8::/48`).
- A request from an address outside the list is refused with `403 ENSC_IP_NOT_ALLOWED` before anything else is evaluated.
- ENSC determines your address from the connection itself. Headers such as `X-Forwarded-For` are ignored, so a proxy between you and ENSC must be on the list, not the client behind it.

## Managing the list

In the dashboard, under **API keys**, each live key has **Edit IP allowlist**. Saving replaces the whole list at once. Changes apply within a few seconds; you do not need to regenerate the key.

When you **rotate** a live key, the new key inherits the old key's allowlist.

## Choosing entries

- Use your servers' **egress** addresses (what ENSC sees), not their private or ingress addresses. Cloud NAT gateways, egress proxies and static outbound IPs are the usual answer.
- Prefer exact addresses or small ranges. A `/0` or a cloud provider's entire range defeats the purpose.
- If your platform gives you a pool of egress addresses, list the pool; if it gives you none (some serverless platforms), route ENSC traffic through a NAT or proxy with a fixed address.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `ENSC_IP_NOT_ALLOWED` from a new deployment | New egress address; add it |
| `ENSC_IP_NOT_ALLOWED` intermittently | Your egress rotates through several addresses; list them all or pin one |
| `ENSC_IP_ALLOWLIST_REQUIRED` when generating a key | You are generating a live key; enter at least one address first |

The error's `requestId` identifies the exact request if you need to contact support.
