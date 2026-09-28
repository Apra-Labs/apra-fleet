import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { describe, it, expect, afterEach } from 'vitest';
import { applyIsolatedHome, assertHomeResolves, buildIsolatedHomeEnv, fleetDataDirFor } from './isolated-home.mjs';

// apra-fleet-y3xp.1: unit test for the shared isolated-home helper itself.
// This file deliberately never assigns process.env.HOME/USERPROFILE/etc.
// with a bare literal assignment -- it goes exclusively through
// applyIsolatedHome()/restore() (a loop over saved keys, not `process.env.HOME =`)
// so it does not trip the later guard test added by apra-fleet-y3xp.4, which
// forbids exactly that literal-assignment pattern outside this helper module.

describe('isolated-home helper', () => {
  let restore: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (restore) {
      await restore();
      restore = undefined;
    }
  });

  it('points os.homedir() and APRA_FLEET_DATA_DIR at a fresh temp dir', async () => {
    const home = await applyIsolatedHome('isolated-home-selftest-');
    restore = home.restore;

    expect(os.homedir()).toBe(home.tempHome);
    expect(process.env.APRA_FLEET_DATA_DIR).toBe(home.dataDir);
    expect(home.dataDir).toBe(path.join(home.tempHome, '.apra-fleet', 'data'));
    expect(fleetDataDirFor(home.tempHome)).toBe(home.dataDir);
    expect(fs.existsSync(home.tempHome)).toBe(true);

    if (process.platform === 'win32') {
      expect(process.env.USERPROFILE).toBe(home.tempHome);
      expect(process.env.HOMEDRIVE! + process.env.HOMEPATH!).toBe(home.tempHome);
    }
  });

  it('restore() returns every variable to its exact prior value, including a previously-unset one', async () => {
    const priorHome = process.env.HOME;
    // Force the "previously unset" branch for a var this helper owns --
    // tests/global-setup.ts + tests/setup.ts already set APRA_FLEET_DATA_DIR
    // for every test in this suite, so simulate the unset case explicitly.
    const priorDataDir = process.env.APRA_FLEET_DATA_DIR;
    delete process.env.APRA_FLEET_DATA_DIR;

    const home = await applyIsolatedHome('isolated-home-selftest-restore-');
    expect(process.env.APRA_FLEET_DATA_DIR).toBe(home.dataDir);

    await home.restore();

    expect(process.env.HOME).toBe(priorHome);
    expect(process.env.APRA_FLEET_DATA_DIR).toBeUndefined();
    expect(fs.existsSync(home.tempHome)).toBe(false);

    // Restore the suite-wide isolation this test borrowed for its own check.
    if (priorDataDir !== undefined) process.env.APRA_FLEET_DATA_DIR = priorDataDir;
  });

  it('restore() is idempotent (safe to call twice)', async () => {
    const home = await applyIsolatedHome('isolated-home-selftest-idempotent-');
    await home.restore();
    await expect(home.restore()).resolves.toBeUndefined();
  });

  it('assertHomeResolves throws with a clear message when os.homedir() does not match', () => {
    const fakeHomedir = () => path.join(os.tmpdir(), 'definitely-not-the-expected-home');
    expect(() => assertHomeResolves(path.join(os.tmpdir(), 'expected-home'), fakeHomedir)).toThrow(
      /isolated-home guard/,
    );
  });

  it('assertHomeResolves passes when the resolved home matches exactly', () => {
    const expected = path.join(os.tmpdir(), 'some-temp-home');
    expect(() => assertHomeResolves(expected, () => expected)).not.toThrow();
  });

  it('the child-env builder yields the same variable set as applying the helper in-process', async () => {
    const home = await applyIsolatedHome('isolated-home-selftest-childenv-');
    restore = home.restore;

    const otherTempHome = path.join(os.tmpdir(), 'isolated-home-childenv-target');
    const env = buildIsolatedHomeEnv(otherTempHome, process.env);

    expect(env.HOME).toBe(otherTempHome);
    expect(env.USERPROFILE).toBe(otherTempHome);
    expect(env.APRA_FLEET_DATA_DIR).toBe(fleetDataDirFor(otherTempHome));
    if (process.platform === 'win32') {
      expect(env.HOMEDRIVE! + env.HOMEPATH!).toBe(otherTempHome);
    }
  });

  it('the child-env builder drops a case-insensitive duplicate of an owned var from the base env', () => {
    const target = path.join(os.tmpdir(), 'isolated-home-childenv-dedupe-target');
    const base: Record<string, string> = { UserProfile: 'C:\\Users\\someone-real', OTHER_VAR: 'kept' };
    const env = buildIsolatedHomeEnv(target, base);

    expect(env.OTHER_VAR).toBe('kept');
    expect(env.USERPROFILE).toBe(target);
    expect(Object.keys(env).filter((k) => k.toUpperCase() === 'USERPROFILE')).toEqual(['USERPROFILE']);
  });
});
