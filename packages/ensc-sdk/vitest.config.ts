import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@ensc/sdk',
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
