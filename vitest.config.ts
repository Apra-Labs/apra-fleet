import { defineConfig } from 'vitest/config';
import path from 'node:path';
import os from 'node:os';

const TEST_DATA_DIR = path.join(os.tmpdir(), 'apra-fleet-test-data');

// Set APRA_FLEET_DATA_DIR HERE, at config load, before any test code runs.
// This guarantees paths.ts (which captures FLEET_DIR at module-load time)
// always sees the test dir, even if a test file's hoisted import chain
// pulls in paths.ts before tests/setup.ts gets to run its top-level code.
// Setting it only in setup.ts is racy under certain import orderings and
// can leak writes into ~/.apra-fleet/data.
process.env.APRA_FLEET_DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = 'test';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration.test.ts'],
    setupFiles: ['tests/setup.ts'],
    fileParallelism: false,  // Tests share registry.json in temp dir
    env: {
      APRA_FLEET_DATA_DIR: TEST_DATA_DIR,
      NODE_ENV: 'test',
    },
  },
});
