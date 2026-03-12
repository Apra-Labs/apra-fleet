import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration.test.ts'],
    setupFiles: ['tests/setup.ts'],
    fileParallelism: false,  // Tests share registry.json in temp dir
  },
});
