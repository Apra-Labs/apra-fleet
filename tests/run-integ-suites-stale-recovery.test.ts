import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Tests for apra-fleet-9te.2.2, verifying the apra-fleet-9te.2.1 fix in
// scripts/run-integ-suites.mjs: checkStale() must auto-recover (not fail
// loud) when the gitignored integ-suite-status.json belongs to a COMPLETED
// pass but references test files that were since removed, while still
// fail-loud exiting when the same stale file set belongs to a non-complete
// (crashed or live) run. See scripts/run-integ-suites.mjs checkStale() and
// its "--status exit codes" doc comment (0/1/3 ok, 2 = infra fail-loud).
//
// scripts/run-integ-suites.mjs hardcodes its status file to
// <repoRoot>/integ-suite-status.json (no env/CLI override), so this suite
// operates directly on that real, gitignored path -- saving any pre-existing
// content in beforeAll/afterAll and restoring it exactly, so a real
// in-flight or completed suite run recorded there by other work is never
// lost. cmdStatus() (the --status path exercised here) only *reads* the
// status file, so no other gitignored state file needs to be touched.

const repoRoot = path.resolve(__dirname, '..');
const scriptPath = path.join(repoRoot, 'scripts', 'run-integ-suites.mjs');
const statusFile = path.join(repoRoot, 'integ-suite-status.json');
const FAIL_LOUD_MARKER = 'This is a fail-loud condition: file a bug bead';
const REMOVED_FILE = 'this-test-file-does-not-exist-9te-2-2.test.mjs';

function writeStatus(runComplete: boolean) {
  fs.writeFileSync(
    statusFile,
    JSON.stringify(
      {
        startedAt: new Date().toISOString(),
        testDir: 'packages/apra-fleet-se/test',
        results: {
          [REMOVED_FILE]: {
            passed: true,
            durationMs: 1000,
            elapsedSeconds: 1,
            finishedAt: new Date().toISOString(),
            failures: [],
          },
        },
        run: {
          pid: 999999,
          startedAt: new Date().toISOString(),
          pendingFiles: [],
          inflight: [],
          runComplete,
          exitCode: 0,
          finishedAt: runComplete ? new Date().toISOString() : undefined,
        },
      },
      null,
      2
    ) + '\n',
    'utf8'
  );
}

function runStatus(): { stdout: string; stderr: string; status: number | null } {
  try {
    const stdout = execFileSync('node', [scriptPath, '--status'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    return { stdout, stderr: '', status: 0 };
  } catch (e: any) {
    return { stdout: e.stdout || '', stderr: e.stderr || '', status: e.status ?? null };
  }
}

describe('run-integ-suites.mjs --status stale-file recovery (apra-fleet-9te.2.2)', () => {
  let hadOriginalStatusFile = false;
  let originalStatusContent = '';

  beforeAll(() => {
    hadOriginalStatusFile = fs.existsSync(statusFile);
    if (hadOriginalStatusFile) {
      originalStatusContent = fs.readFileSync(statusFile, 'utf8');
    }
  });

  afterAll(() => {
    if (hadOriginalStatusFile) {
      fs.writeFileSync(statusFile, originalStatusContent, 'utf8');
    } else if (fs.existsSync(statusFile)) {
      fs.rmSync(statusFile);
    }
  });

  it('positive: a COMPLETED stale status file auto-recovers -- exit != 2, no fail-loud message', () => {
    writeStatus(/* runComplete */ true);
    const result = runStatus();
    expect(result.status).not.toBe(2);
    expect(result.stdout + result.stderr).not.toContain(FAIL_LOUD_MARKER);
    // cmdStatus() treats a recovered stale-complete status as "no run
    // recorded" and exits 0 -- assert the clean/fresh-startable state too,
    // not just the absence of the fail-loud marker.
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('no run recorded');
  });

  it('negative (regression guard): a non-complete stale status file still exits 2 fail-loud', () => {
    writeStatus(/* runComplete */ false);
    const result = runStatus();
    expect(result.status).toBe(2);
    expect(result.stdout + result.stderr).toContain(FAIL_LOUD_MARKER);
    expect(result.stdout + result.stderr).toContain(REMOVED_FILE);
  });
});
