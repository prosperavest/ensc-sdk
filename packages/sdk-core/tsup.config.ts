import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/testing/index.ts'],
  format: ['esm', 'cjs'],
  splitting: true,
  // tsup 8.5.1 always passes `baseUrl` to the declaration build, which
  // TypeScript 6 reports as deprecated (TS5101). The option is tsup's, not
  // ours; this silences only that notice for the declaration build.
  dts: {
    compilerOptions: { ignoreDeprecations: '6.0' },
  },
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
  platform: 'neutral',
  // This package is never published: each SDK inlines its main entry with
  // tsup's `noExternal`. The workspace resolution is what dist serves here.
  external: ['@ensc/protocol', '@noble/curves', '@noble/hashes'],
});
