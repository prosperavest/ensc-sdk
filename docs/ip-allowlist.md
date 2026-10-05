# IP allowlist

Live API keys work only from the IP addresses you register. Sandbox keys are not restricted.

## Why

An API key that leaks (a log line, a CI artifact, a laptop) is useless to whoever finds it unless they also control one of your servers' outbound addresses. Together with request signing and encryption, the allowlist means all four of your credentials have to be stolen from your infrastructure, from inside your network, for an attacker to act as you.

## Rules

- Required for every **Live** key: you cannot generate one without at least one entry (`ENSC_IP_ALLOWLIST_REQUIRED`), and a live key whose allowlist is somehow empty is refused on every request.
- 1 to 32 entries per key. Each entry is a single IPv4 or IPv6 address (`203.0.113.10`, `2001:db8::10`) or a CIDR range (`203.0.113.0/24`, `2001:db8::/48`). A range must be `/8` or narrower for IPv4 and `/32` or narrower for IPv6; a wider one (such as `0.0.0.0/0`) is refused when you save it.
- A request from an address outside the list is refused with `403 ENSC_IP_NOT_ALLOWED` as soon as the key is recognised, before its signature is checked or its body is decrypted.
- ENSC determines your address from the connection itself; addresses carried in request headers are ignored. List the address your requests actually arrive from.

## Managing the list

In the dashboard, on the **Credentials** tab, each live key has **Edit IP allowlist**. Saving replaces the whole list at once. Changes usually apply within a few seconds and always within one minute; you do not need to regenerate the key. Add a new address before you move traffic to it, and remove an old one only after traffic has left it.

When you **rotate** a live key, the new key inherits the old key's allowlist.

## Choosing entries

- Use your servers' **outbound** addresses (what ENSC sees), not their private or inbound addresses. A static outbound IP from your hosting provider is the usual answer.
- Prefer exact addresses or small ranges. A cloud provider's entire range defeats the purpose, even where it is narrow enough to be accepted.
- If your platform gives you a pool of outbound addresses, list the pool; if it gives you no fixed address, send ENSC traffic from a host that has one.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `ENSC_IP_NOT_ALLOWED` from a new deployment | New outbound address; add it |
| `ENSC_IP_NOT_ALLOWED` intermittently | Your outbound address rotates through several; list them all or pin one |
| `ENSC_IP_ALLOWLIST_REQUIRED` when generating a key | You are generating a live key; enter at least one address first |
| `ENSC_IP_ALLOWLIST_REQUIRED` on a request | The live key's allowlist is empty; add at least one address |
| `ENSC_VALIDATION_FAILED` when saving the list | An entry is not an address or range, or a range is wider than `/8` (IPv4) or `/32` (IPv6) |
| `ENSC_IP_NOT_ALLOWED` just after you added the address | The change has not reached every server yet; it does within a minute |

The error's `requestId` identifies the exact request if you need to contact support.
