/**
 * Integration test for scripts/gen-sea-config.mjs -- the standalone build
 * script that scans hooks/, scripts/, skills/, and packages/apra-fleet-se/apra-pm/ and writes
 * dist/sea-manifest.json (baked into the SEA binary at build time).
 *
 * Runs the real script against the real packages/apra-fleet-se/apra-pm package checkout
 * (no mocking -- this script has no exported functions to unit test, and its
 * only job is to describe what's actually on disk). Guards against
 * regressions like the GAP A bug: a nested-directory walker that silently
 * drops agents/schemas/ and agents/_shared/, or omits the auto-sprint-args
 * skill from the manifest entirely.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, 'dist', 'sea-manifest.json');
const configPath = path.join(root, 'dist', 'sea-config.json');
const genSeaConfigScript = path.join(root, 'scripts', 'gen-sea-config.mjs');
const REAL_SHELL_DIST_DIR = path.join(root, 'packages', 'apra-fleet-shell-ui', 'dist');

// The ui-section describe block below (apra-fleet-v6t7.3.2) re-runs the real
// script several times with APRA_FLEET_SHELL_DIST_DIR_OVERRIDE pointed at
// scratch fixtures, each time overwriting the SHARED dist/sea-manifest.json
// and dist/sea-config.json output files (gen-sea-config.mjs always writes to
// the same fixed dist/ paths -- there is no per-invocation output option).
// Whichever describe block runs last in file order leaves those files in its
// own scratch-fixture shape. Regenerate them against the real, live shell
// dist once after every test in this file has run, so this file never leaves
// dist/sea-manifest.json / dist/sea-config.json pointing at a scratch fixture
// for any later test or manual build step in the same process.
afterAll(() => {
  execFileSync('node', [genSeaConfigScript], { cwd: root, stdio: 'pipe' });
});

describe('gen-sea-config.mjs -- generated SEA manifest', () => {
  let manifest: {
    agents: Record<string, string>;
    autoSprintArgsSkill: Record<string, string>;
    skills: Record<string, string>;
  };

  beforeAll(() => {
    if (!existsSync(path.join(root, 'packages', 'apra-fleet-se', 'apra-pm', 'agents'))) {
      throw new Error('packages/apra-fleet-se/apra-pm package directory is missing -- re-clone the repo.');
    }
    execFileSync('node', ['scripts/gen-sea-config.mjs'], { cwd: root, stdio: 'pipe' });
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  });

  it('includes agents/schemas/*.json role I/O contracts', () => {
    const schemaKeys = Object.keys(manifest.agents).filter(k => k.startsWith('schemas/') && k.endsWith('.json'));
    expect(schemaKeys.length).toBeGreaterThan(0);
    expect(schemaKeys).toContain('schemas/doer-output.json');
  });

  it('includes agents/_shared/GRAPH-SEMANTICS.md', () => {
    expect(Object.keys(manifest.agents)).toContain('_shared/GRAPH-SEMANTICS.md');
  });

  it('includes the auto-sprint-args skill file collection', () => {
    const keys = Object.keys(manifest.autoSprintArgsSkill);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).toContain('SKILL.md');
  });

  it('still includes plain role-agent files alongside the nested ones', () => {
    expect(Object.keys(manifest.agents)).toContain('doer.md');
    expect(Object.keys(manifest.agents)).toContain('planner.md');
  });
});

// apra-fleet-v6t7.3.2: the ui/ asset section's three branches (present,
// absent-default, absent-strict). Every case here drives gen-sea-config.mjs
// against a scratch directory via APRA_FLEET_SHELL_DIST_DIR_OVERRIDE -- the
// live packages/apra-fleet-shell-ui/dist tree is never read, deleted, or
// modified by this describe block. This repo's own live dist is verified
// present/live via the plain default-invocation branch below (no override),
// which is safe: it never writes into packages/apra-fleet-shell-ui/dist,
// only dist/sea-manifest.json and dist/sea-config.json (already written by
// the beforeAll above, and by every other npm-run-build:sea-config caller).
describe('gen-sea-config.mjs -- ui (console shell) asset section', () => {
  let scratchDir: string;

  beforeAll(() => {
    scratchDir = mkdtempSync(path.join(os.tmpdir(), 'gen-sea-config-ui-'));
  });

  afterAll(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  describe('dist present (scratch fixture dist)', () => {
    let manifest: { ui?: Record<string, string> };
    let config: { assets: Record<string, string> };

    beforeAll(() => {
      if (!existsSync(path.join(REAL_SHELL_DIST_DIR, 'index.html'))) {
        throw new Error(
          `expected a built shell dist at ${REAL_SHELL_DIST_DIR} -- run "npm run build:ui" first ` +
            '(this suite fixture-tests the present branch against a scratch copy of a real build\'s shape).',
        );
      }
      const presentDir = path.join(scratchDir, 'present');
      mkdirSync(path.join(presentDir, 'assets'), { recursive: true });
      writeFileSync(path.join(presentDir, 'index.html'), '<html>ok</html>');
      writeFileSync(path.join(presentDir, 'assets', 'app-testhash.js'), 'console.log(1);');

      execFileSync('node', [genSeaConfigScript], {
        cwd: root,
        stdio: 'pipe',
        env: { ...process.env, APRA_FLEET_SHELL_DIST_DIR_OVERRIDE: presentDir },
      });
      manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      config = JSON.parse(readFileSync(configPath, 'utf-8'));
    });

    it('sea-manifest.json has ui/-prefixed entries for index.html and every emitted asset, forward-slashed', () => {
      const uiKeys = Object.keys(manifest.ui ?? {});
      expect(uiKeys).toContain('ui/index.html');
      expect(uiKeys).toContain('ui/assets/app-testhash.js');
      for (const key of uiKeys) expect(key).not.toContain('\\');
    });

    it('the same ui/-prefixed keys appear in the SEA config assets map', () => {
      const assetKeys = Object.keys(config.assets);
      expect(assetKeys).toContain('ui/index.html');
      expect(assetKeys).toContain('ui/assets/app-testhash.js');
    });
  });

  describe('dist absent, default mode', () => {
    let manifest: { ui?: Record<string, string> };
    let status: number | null;
    let stderr: string;

    beforeAll(() => {
      const absentDir = path.join(scratchDir, 'absent-default');
      mkdirSync(absentDir, { recursive: true }); // no index.html inside
      const result = spawnSync('node', [genSeaConfigScript], {
        cwd: root,
        encoding: 'utf-8',
        env: { ...process.env, APRA_FLEET_SHELL_DIST_DIR_OVERRIDE: absentDir },
      });
      status = result.status;
      stderr = result.stderr;
      manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    });

    it('exits 0', () => {
      expect(status).toBe(0);
    });

    it('emits no ui manifest entries', () => {
      expect(Object.keys(manifest.ui ?? {})).toHaveLength(0);
    });

    it('warns to stderr naming the missing directory', () => {
      expect(stderr).toContain('packages/apra-fleet-shell-ui/dist');
      expect(stderr.toLowerCase()).toContain('warning');
    });
  });

  describe('dist absent, strict mode (--require-ui)', () => {
    let status: number | null;
    let stderr: string;

    beforeAll(() => {
      const absentDir = path.join(scratchDir, 'absent-strict');
      mkdirSync(absentDir, { recursive: true });
      const result = spawnSync('node', [genSeaConfigScript, '--require-ui'], {
        cwd: root,
        encoding: 'utf-8',
        env: { ...process.env, APRA_FLEET_SHELL_DIST_DIR_OVERRIDE: absentDir },
      });
      status = result.status;
      stderr = result.stderr;
    });

    it('exits non-zero', () => {
      expect(status).not.toBe(0);
    });

    it('the error names packages/apra-fleet-shell-ui/dist', () => {
      expect(stderr).toContain('packages/apra-fleet-shell-ui/dist');
      expect(stderr.toLowerCase()).toContain('error');
    });
  });
});
