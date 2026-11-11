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
import { fileURLToPath } from 'node:url';
// @ts-expect-error -- plain .mjs helper
import { assertNotRealProfile, dropBeadsWorkspaceEnv, REAL_HOME_ENV, SANDBOX_ROOT_ENV } from '../scripts/test-sandbox.mjs';
// @ts-expect-error -- plain .mjs helper
import { PROTECTED_DIRS_ENV, takeWriteGuardViolations } from '../scripts/test-sandbox-write-guard.mjs';
import { FLEET_DIR, SERVER_INFO_PATH } from '../src/paths.js';
import { BIN_DIR, FLEET_BASE } from '../src/cli/config.js';

const REAL = process.env[REAL_HOME_ENV] as string;
const WITH_TEST_SANDBOX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'with-test-sandbox.mjs');

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
});

/** Removes a probe the guard let through (only without the guard); never recursive. */
function realRm(p: string): void {
  for (const f of [path.join(p, 'hooks'), p]) {
    try {
      if (fs.statSync(f).isDirectory()) fs.rmdirSync(f); else fs.unlinkSync(f);
    } catch { /* absent */ }
  }
}
