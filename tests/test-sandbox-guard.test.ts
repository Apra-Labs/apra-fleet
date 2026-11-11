/**
 * The test sandbox (scripts/test-sandbox.mjs) must make it impossible for a
 * test to touch the developer's real installation: every test process runs
 * with a temp HOME/USERPROFILE/APRA_FLEET_DATA_DIR, and any node process that
 * resolves the real profile anyway refuses to start.
 */
import { describe, it, expect } from 'vitest';
import fs, { writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
// @ts-expect-error -- plain .mjs helper
import { assertNotRealProfile, dropBeadsWorkspaceEnv, findGitCommonDir, REAL_HOME_ENV, SANDBOX_ROOT_ENV } from '../scripts/test-sandbox.mjs';
// @ts-expect-error -- plain .mjs helper
import { PROTECTED_DIRS_ENV, TEST_LOG_ENV, takeWriteGuardViolations, withWriteGuardBypass } from '../scripts/test-sandbox-write-guard.mjs';
import { FLEET_DIR, SERVER_INFO_PATH } from '../src/paths.js';
import { BIN_DIR, FLEET_BASE } from '../src/cli/config.js';

const REAL = process.env[REAL_HOME_ENV] as string;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WITH_TEST_SANDBOX = path.join(ROOT, 'scripts', 'with-test-sandbox.mjs');
const WRITE_GUARD = path.join(ROOT, 'scripts', 'test-sandbox-write-guard.mjs');
const VITEST = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const FIXTURE_CONFIG = path.join(ROOT, 'tests', 'fixtures', 'write-guard', 'vitest.config.ts');

function under(p: string, dir: string): boolean {
  const a = path.resolve(p).toLowerCase();
  const b = path.resolve(dir).toLowerCase();
  return a === b || a.startsWith(b + path.sep);
}

describe('test sandbox', () => {
  it('this worker runs sandboxed: homedir, data dir, key dir and bin dir are not the real profile', () => {
    expect(REAL, 'runner did not set up the sandbox').toBeTruthy();
    expect(process.env[SANDBOX_ROOT_ENV]).toBeTruthy();
    expect(path.resolve(os.homedir()).toLowerCase()).not.toBe(path.resolve(REAL).toLowerCase());
    const realFleet = path.join(REAL, '.apra-fleet');
    for (const p of [FLEET_DIR, SERVER_INFO_PATH, FLEET_BASE, BIN_DIR, path.join(os.homedir(), '.apra-fleet', 'fleet.key')]) {
      expect(under(p, realFleet), `${p} is inside the real ${realFleet}`).toBe(false);
    }
  });

  it('assertNotRealProfile trips on the real home or a data dir inside the real profile', () => {
    const real = path.join(os.tmpdir(), 'pretend-real-home');
    expect(() => assertNotRealProfile({ [REAL_HOME_ENV]: real }, () => real)).toThrow(/os\.homedir\(\) is the real home/);
    expect(() => assertNotRealProfile({ [REAL_HOME_ENV]: real, USERPROFILE: real }, () => '/x')).toThrow(/USERPROFILE is the real home/);
    expect(() => assertNotRealProfile(
      { [REAL_HOME_ENV]: real, APRA_FLEET_DATA_DIR: path.join(real, '.apra-fleet', 'data') }, () => '/x',
    )).toThrow(/APRA_FLEET_DATA_DIR points into the real profile/);
    expect(() => assertNotRealProfile(
      { [REAL_HOME_ENV]: real, APRA_FLEET_DATA_DIR: path.join(os.tmpdir(), 'sbx', 'data') }, () => path.join(os.tmpdir(), 'sbx'),
    )).not.toThrow();
  });

  it('dropBeadsWorkspaceEnv removes the beads variables whatever their case and keeps the rest', () => {
    const env = { Beads_Dir: '/a', beads_db: '/b', BD_DB: '/c', BEADS_DIR_EXTRA: 'keep', Path: '/bin' };
    expect(dropBeadsWorkspaceEnv(env)).toEqual({ BEADS_DIR_EXTRA: 'keep', Path: '/bin' });
  });

  it.each([
    ['reusing this run\'s sandbox', {}],
    ['creating a fresh sandbox', { [SANDBOX_ROOT_ENV]: '' }],
  ])('with-test-sandbox.mjs hands its child no beads workspace variables when %s', (_case, overrides) => {
    const polluted = path.join(os.tmpdir(), 'polluted-ambient-beads', '.beads');
    const r = spawnSync(process.execPath, [
      WITH_TEST_SANDBOX, 'node', '-e',
      'console.log(JSON.stringify(["BEADS_DIR","BEADS_DB","BD_DB"].map((k) => process.env[k] ?? null)))',
    ], {
      env: { ...process.env, BEADS_DIR: polluted, BEADS_DB: path.join(polluted, 'beads.db'), BD_DB: path.join(polluted, 'beads.db'), ...overrides },
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual([null, null, null]);
  });

  it('a child node process pointed back at the real home is refused before any module loads', () => {
    expect(process.env.NODE_OPTIONS ?? '').toMatch(/test-sandbox-guard\.mjs/);
    const r = spawnSync(process.execPath, ['-e', 'console.log("RAN")'], {
      env: { ...process.env, HOME: REAL, USERPROFILE: REAL },
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('RAN');
    expect(r.stderr).toMatch(/\[test-sandbox\] refusing to run/);
  });
});

describe('test sandbox write guard', () => {
  const dirs: string[] = JSON.parse(process.env[PROTECTED_DIRS_ENV] ?? '[]');
  const gitDir = dirs.find((d) => path.basename(d) === '.git') as string;
  const probe = () => path.join(gitDir, `apra-fleet-guard-probe-${process.pid}-${Math.random().toString(36).slice(2)}`);

  it('protects the git dir this checkout shares, and the real profile', () => {
    expect(gitDir, `no .git in ${PROTECTED_DIRS_ENV}`).toBeTruthy();
    expect(dirs).toContain(path.join(REAL, '.apra-fleet'));
  });

  it('a write into the real git dir throws, writes nothing, and is recorded even when the code catches it', async () => {
    const targets = [probe(), probe(), probe(), probe()];
    try {
      expect(() => fs.writeFileSync(targets[0], 'x')).toThrow(/E-TEST-SANDBOX-WRITE/);
      expect(() => writeFileSync(targets[1], 'x')).toThrow(/E-TEST-SANDBOX-WRITE/);
      await expect(fsp.writeFile(targets[2], 'x')).rejects.toThrow(/E-TEST-SANDBOX-WRITE/);
      try { fs.mkdirSync(path.join(targets[3], 'hooks'), { recursive: true }); } catch { /* swallowed, as a best-effort hook install would */ }
      expect(takeWriteGuardViolations()).toHaveLength(4);
      for (const t of targets) expect(fs.existsSync(t), t).toBe(false);
    } finally {
      for (const t of targets) realRm(t);
    }
  });

  it('a child node process is refused too, and its write is reported to this test', () => {
    const target = probe();
    try {
      const r = spawnSync(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(target)}, 'x')`], {
        encoding: 'utf8', windowsHide: true,
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/E-TEST-SANDBOX-WRITE/);
      expect(fs.existsSync(target)).toBe(false);
      expect(takeWriteGuardViolations()).toEqual([expect.stringContaining(target)]);
    } finally {
      realRm(target);
    }
  });

  it('writes under the sandbox and the temp dir are untouched by the guard', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-ok-'));
    fs.writeFileSync(path.join(tmp, 'f'), 'x');
    fs.rmSync(tmp, { recursive: true, force: true });
    expect(takeWriteGuardViolations()).toEqual([]);
  });

  it('opening a protected file to read, in the callback form with no flags, is not a write', async () => {
    const handle = await new Promise<number>((resolve, reject) => {
      fs.open(path.join(gitDir, 'HEAD'), (error, handleOpened) => (error ? reject(error) : resolve(handleOpened)));
    });
    fs.closeSync(handle);
    expect(takeWriteGuardViolations()).toEqual([]);
  });

  it('the cleanup allowance lets a test remove what a broken guard let through, and only inside it', () => {
    const prot = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-bypass-'));
    const script = [
      `const fs = (await import('node:fs')).default; const f = (await import('node:path')).join(${JSON.stringify(prot)}, 'leftover');`,
      `const guard = await import(${JSON.stringify(pathToFileURL(WRITE_GUARD).href)});`,
      `guard.withWriteGuardBypass(() => fs.writeFileSync(f, 'x'));`,
      `const made = fs.existsSync(f); guard.withWriteGuardBypass(() => fs.unlinkSync(f));`,
      `let refused = false; try { fs.writeFileSync(f, 'x'); } catch (e) { refused = e.code === 'E-TEST-SANDBOX-WRITE'; }`,
      `console.log(JSON.stringify({ made, gone: !fs.existsSync(f), refused }));`,
    ].join('\n');
    try {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...process.env, [PROTECTED_DIRS_ENV]: JSON.stringify([prot]), [TEST_LOG_ENV]: '' }, encoding: 'utf8', windowsHide: true,
      });
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout.trim())).toEqual({ made: true, gone: true, refused: true });
    } finally {
      fs.rmSync(prot, { recursive: true, force: true });
    }
  });

  it('vitest fails the test that made a refused write, even a caught one or a child\'s, and only that test', () => {
    const prot = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-fixture-'));
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-fixture-out-'));
    try {
      const report = path.join(out, 'report.json');
      const r = spawnSync(process.execPath, [VITEST, 'run', '--config', FIXTURE_CONFIG, '--reporter=json', `--outputFile=${report}`], {
        cwd: ROOT,
        env: {
          ...process.env, [PROTECTED_DIRS_ENV]: JSON.stringify([prot]), [TEST_LOG_ENV]: '',
          WRITE_GUARD_FIXTURE_DIR: prot, WRITE_GUARD_FIXTURE_SIGNAL: path.join(out, 'signal'),
        },
        encoding: 'utf8', windowsHide: true, timeout: 120_000,
      });
      expect(fs.existsSync(report), r.stderr).toBe(true);
      const results = JSON.parse(fs.readFileSync(report, 'utf8')) as { testResults: Array<{ assertionResults: Array<{ title: string; status: string }> }> };
      const status = Object.fromEntries(results.testResults.flatMap((f) => f.assertionResults.map((a) => [a.title, a.status])));
      expect(Object.keys(status)).toHaveLength(4);
      expect(status['writes nothing outside, in another worker, while the other file violates'], 'another worker').toBe('passed');
      expect(status['writes nothing outside, after the others'], 'a later test').toBe('passed');
      expect(status['swallows its own refused write'], 'a caught write').toBe('failed');
      expect(status['runs a child whose write is refused'], 'a child\'s write').toBe('failed');
      expect(fs.readdirSync(prot)).toEqual([]);
    } finally {
      fs.rmSync(prot, { recursive: true, force: true });
      fs.rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('findGitCommonDir', () => {
  const noGit = () => null;
  it('finds the git dir without git: a clone, and a linked worktree through its commondir', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-git-')));
    try {
      fs.mkdirSync(path.join(root, 'main', '.git', 'worktrees', 'wt'), { recursive: true });
      fs.writeFileSync(path.join(root, 'main', '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
      fs.mkdirSync(path.join(root, 'wt', 'sub'), { recursive: true });
      fs.writeFileSync(path.join(root, 'wt', '.git'), `gitdir: ${path.join(root, 'main', '.git', 'worktrees', 'wt')}\n`);
      expect(findGitCommonDir(path.join(root, 'main'), noGit)).toBe(path.join(root, 'main', '.git'));
      expect(findGitCommonDir(path.join(root, 'wt', 'sub'), noGit)).toBe(path.join(root, 'main', '.git'));
      fs.writeFileSync(path.join(root, 'wt', '.git'), 'not a gitdir line\n');
      expect(() => findGitCommonDir(path.join(root, 'wt'), noGit)).toThrow(/cannot be protected/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('a git before 2.31 echoes --path-format back: the plain form is used', () => {
    const cwd = os.tmpdir();
    const oldGit = (_cwd: string, args: string[]) => (args.includes('--path-format=absolute') ? '--path-format=absolute\n.git' : '.git');
    expect(findGitCommonDir(cwd, oldGit)).toBe(path.resolve(cwd, '.git'));
  });
});

/** Removes a probe a broken guard let through, using the test-only allowance; never recursive. */
function realRm(p: string): void {
  withWriteGuardBypass(() => {
    for (const f of [path.join(p, 'hooks'), p]) {
      try {
        if (fs.statSync(f).isDirectory()) fs.rmdirSync(f); else fs.unlinkSync(f);
      } catch { /* absent */ }
    }
  });
}
