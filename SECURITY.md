# Security

## Reporting a vulnerability

Report security issues privately to ProsperaVest; do not open a public issue
or pull request for them.

## What this repository contains

Only client code: the SDK and the protocol it speaks. No credentials, no
server code, no infrastructure configuration and no contract data are kept
here. A pull request that adds any of these is refused.

## Supply chain

- Dependencies are pinned to exact versions and resolved from the committed
  lockfile only (`pnpm install --frozen-lockfile`).
- Releases younger than three days are not resolved (`minimumReleaseAge`).
- Git and tarball dependencies are refused (`blockExoticSubdeps`).
- Install scripts run only for the packages listed in `allowBuilds`.
- `overrides` in `pnpm-workspace.yaml` force a patched version of a transitive
  dependency when its parent has not shipped the fix yet:
  `esbuild` 0.28.2 in place of the 0.27 line pulled in by the build tooling
  (GHSA-g7r4-m6w7-qqqr).
- `@ensc/sdk` is published only from this repository's CI, over npm trusted
  publishing (no stored token), with provenance, and only after a maintainer
  approves the staged version.
