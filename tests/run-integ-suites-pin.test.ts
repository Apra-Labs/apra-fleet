import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

// scripts/run-integ-suites.mjs pins its status file to the commit it was
// recorded at (headSha + lockSha). A --start/--status against a status file
// recorded at another HEAD, or a legacy file with no headSha, must fail loud
// (exit 2) naming both SHAs instead of silently resuming stale results.
// The env overrides keep this test off the developer's real status file;
// --start never reaches spawn() here because the pin check runs first.

const repoRoot = path.resolve(__dirname, '..');
const scriptPath = path.join(repoRoot, 'scripts', 'run-integ-suites.mjs');
const FAKE_SHA = '0123456789abcdef0123456789abcdef01234567';

function realHead(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function realLockSha(): string | null {
  const lock = path.join(repoRoot, 'package-lock.json');
  if (!fs.existsSync(lock)) return null;
  return createHash('sha256').update(fs.readFileSync(lock)).digest('hex');
}

let tmp: string;
let statusFile: string;

function run(...args: string[]) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      INTEG_SUITES_STATUS_FILE: statusFile,
      INTEG_SUITES_HEARTBEAT_FILE: path.join(tmp, 'hb.json'),
      INTEG_SUITES_LOG_FILE: path.join(tmp, 'run.log'),
    },
  });
}

function writeStatus(obj: Record<string, unknown>) {
  fs.writeFileSync(statusFile, JSON.stringify(obj, null, 2));
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'integ-pin-'));
  statusFile = path.join(tmp, 'integ-suite-status.json');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('run-integ-suites status pin', () => {
  for (const cmd of ['--start', '--status']) {
    it(`${cmd} exits 2 naming both SHAs when the status file was recorded at another HEAD`, () => {
      writeStatus({ startedAt: new Date().toISOString(), results: {}, headSha: FAKE_SHA, lockSha: realLockSha() });
      const r = run(cmd);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(FAKE_SHA);
      expect(r.stderr).toContain(realHead());
      expect(r.stderr).toContain('--fresh');
      // --start must not have launched or rewritten anything.
      expect(JSON.parse(fs.readFileSync(statusFile, 'utf8')).run).toBeUndefined();
    });

    it(`${cmd} exits 2 on a legacy status file with no headSha`, () => {
      writeStatus({ startedAt: new Date().toISOString(), results: {} });
      const r = run(cmd);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('no headSha');
      expect(r.stderr).toContain(realHead());
      expect(r.stderr).toContain('--fresh');
    });
  }

  it('--start exits 2 when package-lock.json changed under the same HEAD', () => {
    writeStatus({ startedAt: new Date().toISOString(), results: {}, headSha: realHead(), lockSha: 'f'.repeat(64) });
    const r = run('--start');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('f'.repeat(64));
  });

  it('--status accepts a file pinned to the current HEAD and prints headSha', () => {
    const testDir = path.join(repoRoot, 'packages', 'apra-fleet-se', 'test');
    const files = fs.readdirSync(testDir).filter((f) => f.endsWith('.test.mjs'));
    const results = Object.fromEntries(files.map((f) => [f, { passed: true, durationMs: 1, elapsedSeconds: 0 }]));
    const head = realHead();
    writeStatus({
      startedAt: new Date().toISOString(),
      results,
      headSha: head,
      lockSha: realLockSha(),
      bdVersion: null,
      run: { pid: 0, runComplete: true, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() },
    });
    const r = run('--status');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`headSha=${head}`);
    expect(r.stdout).toContain('pass COMPLETE');
  });
});
