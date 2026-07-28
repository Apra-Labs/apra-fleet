/**
 * Smoke test for the packaged fleet-sprint binary (dist/fleet-sprint.mjs,
 * produced by scripts/bundle-se.mjs and exposed as the root package's
 * `fleet-sprint` bin).
 *
 * Regression guard: the bundle is ESM (format: 'esm') but pulls in CJS
 * dependencies -- notably undici, via @apralabs/apra-fleet-client's HTTP
 * transport. esbuild rewrites CJS `require(...)` into its own `__require`
 * shim whose fallback THROWS `Dynamic require of "node:assert" is not
 * supported`. undici hits that at runtime from lib/dispatcher/client.js, so
 * the shipped binary died on startup before parsing a single flag -- every
 * `fleet-sprint ...` invocation, and `apra-fleet workflow fleet-sprint` with
 * it. Nothing caught it: cli-server-resolution.test.mjs only ever writes a
 * fake `// bundled cli` placeholder, so no test had ever EXECUTED the real
 * artifact.
 *
 * The check is deliberately end-to-end and dumb: actually spawn the bundle
 * and require it to reach flag parsing. A unit test of the bundler's config
 * would not have caught this, because the config was syntactically fine --
 * only running the output reveals it.
 *
 * Skipped (not failed) when dist/fleet-sprint.mjs is absent: it is built by
 * `npm run build:se` (part of prepublishOnly), not by a plain `npm run
 * build`, so a normal dev checkout legitimately may not have it yet.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const bundlePath = path.join(root, 'dist', 'fleet-sprint.mjs');
const bundleExists = existsSync(bundlePath);

describe.skipIf(!bundleExists)('dist/fleet-sprint.mjs -- packaged binary smoke', () => {
  it('starts and reaches flag parsing instead of dying on a dynamic require', () => {
    const result = spawnSync(process.execPath, [bundlePath, '--help'], {
      encoding: 'utf-8',
      timeout: 60_000,
    });

    const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;

    // Assert on the specific failure first so a regression reports the real
    // cause rather than a bare exit-code mismatch.
    expect(combined).not.toMatch(/Dynamic require of/);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: fleet-se sprint');
  });

  it('keeps its shebang on line 1 so the bin entry stays executable', async () => {
    const { readFileSync } = await import('node:fs');
    const firstLine = readFileSync(bundlePath, 'utf-8').split('\n')[0];
    expect(firstLine).toBe('#!/usr/bin/env node');
  });
});
