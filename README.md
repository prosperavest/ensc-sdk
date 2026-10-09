# ENSC SDK

Source of [`@ensc/sdk`](https://www.npmjs.com/package/@ensc/sdk), the official
server-side client for the ENSC API, and of the three packages it bundles.

| Package | Published | Contents |
| --- | --- | --- |
| `packages/ensc-sdk` | yes, as `@ensc/sdk` | The client: typed resources and the optional `@ensc/sdk/web3` helper on the shared client core |
| `packages/sdk-core` | no, bundled into the SDK | The client core shared by the ProsperaVest SDKs: configuration, transport with retries and idempotency, request encryption and signing, sealed-response verification, webhook verification |
| `packages/ensc-protocol` | no, bundled into the SDK | The wire protocol: canonical request string and Ed25519 signing (ENSC-V1 and ENSC-V2), ENSC-ENC-V1 request envelope, ENSC-RESP-V1 and ENSC-RESP-V2 sealed responses (HPKE), the error envelope |
| `packages/ensc-api-schemas` | no, types bundled into the SDK | Request and response schemas of the public API |

Usage, credentials and examples: [`packages/ensc-sdk/README.md`](./packages/ensc-sdk/README.md).
Integration guides: [`docs/`](./docs/README.md).

## Verifying a release

Every release is built and published by this repository's CI with npm trusted
publishing and a provenance statement, and approved by a maintainer before it
goes live. To check what you installed:

```sh
npm audit signatures
```

The npm page of each version links to the commit and workflow run that built it.

## Development

Node 22.12 or later, pnpm 12 (the version is pinned in `package.json`).

```sh
pnpm install --frozen-lockfile
pnpm check        # build, typecheck, lint, format check, tests
```

## Releases

1. Bump `packages/ensc-sdk/package.json` and `packages/ensc-sdk/CHANGELOG.md`, merge to `main`.
2. `git tag sdk-v<version> && git push origin sdk-v<version>`, on that commit of `main`. A tag on a commit that is not on `main` is refused by the release job.
3. CI runs the checks, builds the package and stages it on npm (`npm stage publish`).
4. A maintainer reviews the staged version on npmjs.com and approves it with 2FA.

## Security

See [SECURITY.md](./SECURITY.md).

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
