// Run by tests/test-sandbox-guard.test.ts only: two files in parallel workers,
// with tests/setup.ts, against a protected dir the parent made in temp.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    root: path.resolve(here, '..', '..', '..'),
    include: ['tests/fixtures/write-guard/*.fixture.ts'],
    setupFiles: ['tests/setup.ts'],
    pool: 'forks',
    fileParallelism: true,
    maxWorkers: 2,
  },
});
