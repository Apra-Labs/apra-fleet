import { test } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getFleetDataDir, getServerInfoPath } from '../src/client/server-resolution.mjs';

// This package's tests run inside the shared test sandbox
// (scripts/with-test-sandbox.mjs): a temp HOME/USERPROFILE/APRA_FLEET_DATA_DIR,
// and a preloaded guard that refuses any node process resolving the real
// profile. Auto-start and probe code must never see the real installation.

const REAL = process.env.APRA_TEST_REAL_HOME;

test('client tests run sandboxed: home and fleet data dir are not the real profile', () => {
    assert.ok(REAL, 'not running inside the test sandbox -- use npm test');
    assert.notStrictEqual(path.resolve(os.homedir()).toLowerCase(), path.resolve(REAL).toLowerCase());
    const realFleet = path.resolve(REAL, '.apra-fleet').toLowerCase();
    for (const p of [getFleetDataDir(), getServerInfoPath(), path.join(os.homedir(), '.apra-fleet', 'bin')]) {
        assert.ok(!path.resolve(p).toLowerCase().startsWith(realFleet), `${p} is inside the real ${realFleet}`);
    }
});

test('a child pointed back at the real home is refused by the preloaded guard', () => {
    // isolated-home-allow: deliberately points the child at the real home to prove the sandbox guard refuses it.
    const r = spawnSync(process.execPath, ['-e', 'console.log("RAN")'], {
        env: { ...process.env, HOME: REAL, USERPROFILE: REAL }, encoding: 'utf8', windowsHide: true,
    });
    assert.notStrictEqual(r.status, 0);
    assert.ok(!r.stdout.includes('RAN'));
    assert.match(r.stderr, /\[test-sandbox\] refusing to run/);
});
