import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// scripts/run-integ-suites.mjs must run its node --test lane children inside
// the per-run test sandbox (scripts/test-sandbox.mjs): otherwise a lane test
// that spawns a supervisor/fleet client with no server reachable auto-starts a
// real apra-fleet on the default port from the developer's real profile.
// Drives the internal --supervise entry (what --start spawns detached) against
// a tiny fixture test that records its own env. Status/heartbeat/log files are
// redirected to a temp dir via the INTEG_SUITES_* overrides.

const repoRoot = path.resolve(__dirname, '..');
const scriptPath = path.join(repoRoot, 'scripts', 'run-integ-suites.mjs');
const testDir = path.join(repoRoot, 'packages', 'apra-fleet-se', 'test');

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'integ-sandbox-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('run-integ-suites lane sandbox', () => {
  it('lane children run with HOME/APRA_FLEET_DATA_DIR under the sandbox root, beads env dropped, sandbox removed after', () => {
    const outFile = path.join(tmp, 'env-out.json');
    const fixture = path.join(tmp, 'env-fixture.test.mjs');
    fs.writeFileSync(
      fixture,
      [
        "import { test } from 'node:test';",
        "import fs from 'node:fs';",
        "import os from 'node:os';",
        "test('record env', () => {",
        '  fs.writeFileSync(process.env.FIXTURE_OUT, JSON.stringify({',
        '    HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,',
        '    DATA: process.env.APRA_FLEET_DATA_DIR, ROOT: process.env.APRA_TEST_SANDBOX_ROOT,',
        '    REAL: process.env.APRA_TEST_REAL_HOME, HOMEDIR: os.homedir(),',
        '    BEADS_DIR: process.env.BEADS_DIR || null, BD_DB: process.env.BD_DB || null,',
        '  }));',
        '});',
        '',
      ].join('\n'),
    );

    // vitest itself runs inside a sandbox; strip its markers so the script
    // under test must create its own (and clean it up).
    const baseEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const k of ['APRA_TEST_SANDBOX_ROOT', 'APRA_TEST_REAL_HOME', 'APRA_FLEET_DATA_DIR']) delete baseEnv[k];
    const realHome = os.homedir();
    const res = spawnSync(process.execPath, [scriptPath, '--supervise', path.relative(testDir, fixture)], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 120000,
      env: {
        ...baseEnv,
        BEADS_DIR: path.join(tmp, 'fake-beads'),
        BD_DB: path.join(tmp, 'fake-db'),
        FIXTURE_OUT: outFile,
        INTEG_SUITES_STATUS_FILE: path.join(tmp, 'status.json'),
        INTEG_SUITES_HEARTBEAT_FILE: path.join(tmp, 'hb.json'),
        INTEG_SUITES_LOG_FILE: path.join(tmp, 'run.log'),
      },
    });
    expect(res.status, res.stdout + res.stderr).toBe(0);

    const seen = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    const root = seen.ROOT as string;
    expect(root, 'sandbox marker must be set in the lane child').toBeTruthy();
    const under = (p: string) => path.resolve(p).startsWith(path.resolve(root) + path.sep);
    expect(under(seen.HOME)).toBe(true);
    expect(under(seen.USERPROFILE)).toBe(true);
    expect(under(seen.DATA)).toBe(true);
    expect(under(seen.HOMEDIR)).toBe(true);
    expect(path.resolve(seen.HOME)).not.toBe(path.resolve(realHome));
    expect(seen.BEADS_DIR).toBeNull();
    expect(seen.BD_DB).toBeNull();
    // Owned by the supervise process: removed when both lanes finish.
    expect(fs.existsSync(root)).toBe(false);
    // Status file still lands at the overridden (non-sandbox) path.
    expect(fs.existsSync(path.join(tmp, 'status.json'))).toBe(true);
  }, 130000);
});
