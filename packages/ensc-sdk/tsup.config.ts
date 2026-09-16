import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/web3/index.ts'],
  format: ['esm', 'cjs'],
  // Shared code between the two entries goes into one chunk in both formats,
  // so `@ensc/sdk` and `@ensc/sdk/web3` use the same EnscError class.
  splitting: true,
  // Type declarations are bundled too: the published .d.ts must not import
  // the unpublished `@ensc/*` workspace packages, so their declarations are
  // inlined. `zod` stays an import (it is a real dependency of this package,
  // needed only for the `api` schema types).
  dts: {
    resolve: true,
    // tsup 8.5.1 always passes `baseUrl` to the declaration build, which
    // TypeScript 6 reports as deprecated (TS5101). The option is tsup's, not
    // ours; this silences only that notice for the declaration build.
    compilerOptions: { ignoreDeprecations: '6.0' },
  },
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
  platform: 'neutral',
  // viem is an optional peer dep: never bundle it. The web3 entry imports it
  // lazily; core consumers who don't touch ./web3 never load it.
  external: ['viem', 'zod', '@noble/ciphers', '@noble/curves', '@noble/hashes'],
  // The internal ENSC packages are bundled INTO the SDK so the published
  // package is self-contained: consumers `npm install @ensc/sdk` and get only
  // the SDK plus @noble/* and zod, with no unpublished `workspace:*` deps to
  // resolve.
  //   - @ensc/protocol: used at runtime, its code is inlined. Its own
  //     @noble/* imports stay external (real deps of this package).
  //   - @ensc/api-schemas: type-only import, erased at build time; only its
  //     declarations are inlined (see `dts.resolve`).
  // Both are client-safe by design and are the only internal packages the SDK
  // may import; they are published as source in the public SDK repository.
  // In the workspace, dev/typecheck/test are unaffected: `workspace:*` still
  // resolves locally exactly as before. Only the published tarball changes.
  noExternal: ['@ensc/protocol'],
});
