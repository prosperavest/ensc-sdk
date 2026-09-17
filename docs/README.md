# Public integration docs

Merchant-facing pages for docs.prosperavest.com. They describe API version `2026-09-15` and `@ensc/sdk` 0.4.x. They name no internal component, no payment rail, no screening or RPC provider, no contract address and no retired hostname; keep it that way (the API's OpenAPI test enforces the same rule on the spec).

| Page | Replaces / feeds |
|---|---|
| [security.md](./security.md) | `getting-started/security` |
| [generating-keys.md](./generating-keys.md) | `getting-started/generating-keys` |
| [encrypting-decrypting-request.md](./encrypting-decrypting-request.md) | `getting-started/encrypting-decrypting-request` |
| [authorization.md](./authorization.md) | `getting-started/authorization` |
| [ip-allowlist.md](./ip-allowlist.md) | `getting-started/ip-allowlist` |
| [conversions.md](./conversions.md) | `getting-started/conversions` |
| [environments.md](./environments.md) | `getting-started/environments` |
| [going-live.md](./going-live.md) | `getting-started/going-live` |
| [webhooks.md](./webhooks.md) | `guides/webhooks` |

Source of truth for every statement here is the code under `apps/api/src/middleware/`, `apps/api/src/routes/`, `apps/api/src/services/` and `packages/ensc-shared/src/`, with the internal references in `docs/conversions.md` and `docs/providers.md`. When the wire protocol or a conversion flow changes, change these pages in the same PR.
