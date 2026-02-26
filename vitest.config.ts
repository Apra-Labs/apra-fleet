import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration.test.ts'],
    fileParallelism: false,  // Tests share ~/.claude-fleet/registry.json
  },
});
