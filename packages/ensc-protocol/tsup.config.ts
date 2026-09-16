import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
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
});
