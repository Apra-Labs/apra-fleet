/**
 * The test sandbox (scripts/test-sandbox.mjs) must make it impossible for a
 * test to touch the developer's real installation: every test process runs
 * with a temp HOME/USERPROFILE/APRA_FLEET_DATA_DIR, and any node process that
 * resolves the real profile anyway refuses to start.
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// @ts-expect-error -- plain .mjs helper
import { assertNotRealProfile, REAL_HOME_ENV, SANDBOX_ROOT_ENV } from '../scripts/test-sandbox.mjs';
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
