import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@ensc/protocol',
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
