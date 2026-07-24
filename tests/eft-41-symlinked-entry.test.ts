/**
 * Regression test for apra-fleet-eft.41 (product defects 1a/1b):
 *
 * 1a) On macOS, `mktemp -d` returns a path under /var/folders/... which is
 *     itself a symlink to /private/var/.... Node's ESM loader canonicalizes
 *     `import.meta.url` to the REAL (realpath'd) location, but
 *     `process.argv[1]` is left un-canonicalized. cli.mjs's `isMainModule()`
 *     used to compare the two raw URLs, which never matched through a
 *     symlinked invocation path -- the self-executing block silently never
 *     ran, and the CLI exited 0 having done nothing (see
 *     packages/apra-fleet-se/bin/cli.mjs, apra-fleet-eft.41.1's fix).
 *
 * 1b) Defense-in-depth: `apra-fleet workflow`'s import-trampoline launcher
 *     (src/cli/workflow.ts runWorkflow) must fail loud (nonzero exit +
 *     actionable stderr) if an imported workflow module neither self-executes
 *     nor exports a callable entry -- covered in tests/workflow.test.ts
 *     (apra-fleet-eft.41.2 test cases). This file covers 1a end-to-end.
 *
 * This test reproduces the symlink scenario deterministically on ANY
 * platform (not just macOS, where TMPDIR happens to be symlinked already):
 * it manually symlinks a wrapper directory to the real bin/ directory and
 * invokes cli.mjs through the un-canonicalized symlinked path, exactly
 * mirroring the argv[1]-vs-import.meta.url mismatch that triggered the bug.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(__dirname, '..');
const realBinDir = path.join(root, 'packages', 'apra-fleet-se', 'bin');

describe('cli.mjs entry-resolution self-executes through a symlinked invocation path (apra-fleet-eft.41.1)', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--help via a symlinked bin/ dir prints usage text on stdout and exits 0 (not a silent no-op)', () => {
    // Build a fresh parent dir with a symlink pointing at the real bin/
    // directory. process.argv[1] (the invoked path) will run through the
    // symlink and stay un-canonicalized, while Node's ESM loader will
    // canonicalize import.meta.url to the realpath -- exactly the mismatch
    // that used to make isMainModule() return false.
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-eft41-'));
    tmpDirs.push(parent);
    const linkedBinDir = path.join(parent, 'linked-bin');
    fs.symlinkSync(realBinDir, linkedBinDir, 'dir');

    const invokedPath = path.join(linkedBinDir, 'cli.mjs');
    // Sanity: the invoked path is not realpath-equal to itself pre-resolution
    // (i.e. the symlink hop is real, not a no-op on this filesystem).
    expect(fs.realpathSync(invokedPath)).not.toBe(invokedPath);

    let stdout: string;
    let status = 0;
    try {
      stdout = execFileSync('node', [invokedPath, '--help'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      status = e.status ?? 1;
      stdout = e.stdout ?? '';
      // Surface stderr in the failure message for easier debugging.
      throw new Error(
        `cli.mjs --help via symlinked path exited ${status} (expected 0).\n` +
          `stdout: ${stdout}\nstderr: ${e.stderr ?? ''}`,
      );
    }

    // The original defect: this would be '' (silent no-op) with exit 0,
    // reported as success while doing nothing.
    expect(stdout).toContain('Usage: fleet-se sprint');
    expect(status).toBe(0);
  });

  it('a non-symlinked (direct) invocation still works, unaffected by the realpath fallback', () => {
    const invokedPath = path.join(realBinDir, 'cli.mjs');
    const stdout = execFileSync('node', [invokedPath, '--help'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(stdout).toContain('Usage: fleet-se sprint');
  });
});
