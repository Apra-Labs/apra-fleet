import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// apra-fleet-v6t7.4 -- scripts/dist-pm.mjs vendors the current source tree
// into dist/agents (and the other dist/skills, dist/workflows targets) via
// cpSync, which only OVERLAYS an existing destination -- it never deletes a
// destination-only file. That let an orphan survive `npm run dist-pm`
// (reproduced upstream with sprint-doctor-input.json / sprint-doctor-
// output.json left over from a prior checkout of a different branch),
// which meant contracts-schema-dist-staleness-guard.test.mjs's documented
// remediation ("run `npm run dist-pm` to fix it") did not actually fix
// anything for an ONLY-IN-DIST drift. The fix makes dist-pm clear each
// destination tree before copying; this test seeds an orphan file directly
// into a throwaway temp dist root, runs the real vendoring script end-to-end
// against that temp root, and asserts the orphan is gone afterward.
//
// apra-fleet-v6t7.13 -- the original version of this test pointed dist-pm at
// the LIVE repo dist/ tree, so `npm test` had a side effect on the
// developer's dist/ (and could race a concurrent build). scripts/dist-pm.mjs
// now honours a DIST_PM_DIST_DIR env override for its destination root, so
// this test vendors into an os.tmpdir()-rooted directory instead and never
// touches the real dist/. Source paths (the packages/apra-fleet-se/apra-pm
// submodule) are still the real repo tree -- they are only ever read.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const scriptPath = path.join(repoRoot, 'scripts', 'dist-pm.mjs');
const scriptModuleUrl = pathToFileURL(scriptPath).href;
const submoduleAgents = path.join(repoRoot, 'packages', 'apra-fleet-se', 'apra-pm', 'agents');

const submoduleSourceAvailable = fs.existsSync(submoduleAgents) && fs.readdirSync(submoduleAgents).length > 0;

describe.skipIf(!submoduleSourceAvailable)('dist-pm.mjs orphan pruning (apra-fleet-v6t7.4)', () => {
  let tempDistRoot: string;

  beforeEach(() => {
    tempDistRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-pm-vendoring-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDistRoot, { recursive: true, force: true });
  });

  it('removes a destination-only (orphan) file from dist/agents/schemas when re-vendored, inspecting only the temp root', () => {
    const tempAgentsSchemas = path.join(tempDistRoot, 'agents', 'schemas');
    fs.mkdirSync(tempAgentsSchemas, { recursive: true });
    const orphanPath = path.join(tempAgentsSchemas, 'sprint-doctor-orphan-regression-fixture.json');
    fs.writeFileSync(orphanPath, '{"orphan": true}', 'utf-8');
    expect(fs.existsSync(orphanPath)).toBe(true);

    execFileSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DIST_PM_DIST_DIR: tempDistRoot },
    });

    expect(fs.existsSync(orphanPath)).toBe(false);
    // The real, current schema files must still be present -- this is a
    // prune of destination-only entries, not a wholesale wipe.
    expect(fs.existsSync(tempAgentsSchemas)).toBe(true);
    expect(fs.readdirSync(tempAgentsSchemas).filter((f) => f.endsWith('.json')).length).toBeGreaterThan(0);
  });

  it('vendors into DIST_PM_DIST_DIR exactly like a default run would vendor into dist/ (npm run dist-pm is unaffected)', () => {
    execFileSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DIST_PM_DIST_DIR: tempDistRoot },
    });

    expect(fs.existsSync(path.join(tempDistRoot, 'agents'))).toBe(true);
    expect(fs.existsSync(path.join(tempDistRoot, 'skills', 'pm'))).toBe(true);
  });
});

describe('dist-pm.mjs vendorDir() atomic replace (apra-fleet-v6t7.13)', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-pm-vendordir-test-'));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('leaves the previous destination content intact (not empty) when the copy throws partway through', async () => {
    const { vendorDir } = await import(scriptModuleUrl);

    const src = path.join(workDir, 'src');
    const dest = path.join(workDir, 'dest');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'a.txt'), 'new-a', 'utf-8');
    fs.writeFileSync(path.join(src, 'b.txt'), 'new-b', 'utf-8');

    // Seed dest with "previous" content that must survive a failed vendor.
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'old.txt'), 'previous-content', 'utf-8');

    // A copy function that copies one file and then throws, simulating an
    // I/O error partway through cpSync's recursive copy.
    function partialCopyThenThrow(fromDir: string, toDir: string) {
      const entries = fs.readdirSync(fromDir);
      if (entries.length > 0) {
        fs.copyFileSync(path.join(fromDir, entries[0]), path.join(toDir, entries[0]));
      }
      throw new Error('simulated copy failure partway through');
    }

    expect(() => vendorDir(src, dest, null, { copyFn: partialCopyThenThrow })).toThrow(
      'simulated copy failure partway through'
    );

    // dest must be exactly what it was before the failed vendor attempt --
    // not empty, not partially overwritten with the new content.
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.readFileSync(path.join(dest, 'old.txt'), 'utf-8')).toBe('previous-content');
    expect(fs.readdirSync(dest)).toEqual(['old.txt']);

    // No leftover temp staging directory next to dest.
    const siblings = fs.readdirSync(workDir);
    expect(siblings.filter((name) => name.startsWith('dest.tmp-'))).toEqual([]);
  });

  it('still ends up exactly equal to the source on a successful vendor', async () => {
    const { vendorDir } = await import(scriptModuleUrl);

    const src = path.join(workDir, 'src2');
    const dest = path.join(workDir, 'dest2');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'keep.txt'), 'keep-me', 'utf-8');

    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'orphan.txt'), 'stale', 'utf-8');

    vendorDir(src, dest, null);

    expect(fs.readdirSync(dest)).toEqual(['keep.txt']);
    expect(fs.readFileSync(path.join(dest, 'keep.txt'), 'utf-8')).toBe('keep-me');
  });
});
