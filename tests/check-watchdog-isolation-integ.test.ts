import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// apra-fleet-xuo.11: pins the fix from apra-fleet-xuo.10 (scripts/check-
// watchdog-isolation.mjs's entrypoint guard changed from a raw
// `file://${process.argv[1]}` string comparison -- which is a MALFORMED file
// URL on a Windows drive-letter path and so never equals the real
// import.meta.url -- to a pathToFileURL()-based comparison) so the
// silent-pass regression this repo already hit once (see xuo.8/xuo.9 for the
// analogous bug in check-sandbox-sync-remote.mjs) cannot return here.
//
// This suite spawns scripts/check-watchdog-isolation.mjs as a REAL CLI child
// process (never imports it -- importing would bypass the very
// `if (... ) { main(); }` guard under test) and asserts on stdout/exit-code
// evidence that main() actually ran, both on a genuine PASS and on a
// failure path.
//
// Verification that this suite actually discriminates the fix (criterion 3):
// the pre-fix guard read (per git show 4f2fe43, no `process.argv[1] &&`
// guard clause)
//   if (import.meta.url === `file://${process.argv[1]}`) { main(); }
// Temporarily reverting scripts/check-watchdog-isolation.mjs to that exact
// line (restoring the malformed-file-URL string comparison) and re-running
// `npx vitest run tests/check-watchdog-isolation-integ.test.ts` on this
// Windows machine made all three tests in this file fail, because under the
// pre-fix guard main() never runs for EITHER a genuine status file or a
// nonexistent one: both spawns exit 0 with empty stdout/stderr. Concretely:
// the "PASS" test failed on its stdout assertions (empty output, no
// budget-report lines); the "nonexistent status file" test failed at
// `expect(status).not.toBe(0)` (status was 0, not nonzero); and the
// "over-budget/not-passed" test failed at `expect(status).toBe(1)` (status
// was 0, not 1). Restoring the real pathToFileURL guard (git checkout --
// scripts/check-watchdog-isolation.mjs) made the suite pass again. No code
// changes were left behind from that manual check.

const SCRIPT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'check-watchdog-isolation.mjs',
);

// Must stay in lockstep with check-watchdog-isolation.mjs's own DEAD_PID_FILE.
// (Was mock-sprint-planner-dispatch-dead-pid.test.mjs until that file was
// retired as a strict assertion subset of the survivor named below.)
const DEAD_PID_FILE = 'mock-sprint-planner-dispatch-attempt1-clean-fail-attempt2-dead-session.test.mjs';
const STALLED_SESSION_FILE = 'mock-sprint-planner-dispatch-stalled-session.test.mjs';

function spawnScript(args: string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [SCRIPT_PATH, ...args], { encoding: 'utf-8' });
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

describe('check-watchdog-isolation.mjs entrypoint guard actually runs main() when spawned directly as a real CLI (apra-fleet-xuo.11)', () => {
  let outerDir: string;
  let statusFile: string;

  beforeEach(() => {
    outerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-watchdog-isolation-guard-spawn-'));
    statusFile = path.join(outerDir, 'integ-suite-status.json');
  });

  afterEach(() => {
    fs.rmSync(outerDir, { recursive: true, force: true });
  });

  it("spawning 'node scripts/check-watchdog-isolation.mjs <status-file>' for real on a genuine PASS status file prints both budget-report lines and exits 0, proving main() ran", () => {
    // Before apra-fleet-xuo.10's fix, this spawn would exit 0 with EMPTY
    // stdout/stderr on Windows -- main() never ran, and neither report line
    // below would ever be printed. Asserting on both proves main() genuinely
    // executed, not just that the process happened to exit cleanly.
    fs.writeFileSync(
      statusFile,
      JSON.stringify({
        results: {
          [DEAD_PID_FILE]: { passed: true, durationMs: 5000 },
          [STALLED_SESSION_FILE]: { passed: true, durationMs: 8000 },
        },
      }),
      'utf-8',
    );

    const { status, stdout, stderr } = spawnScript([statusFile]);

    expect(status, `stdout: ${stdout}\nstderr: ${stderr}`).toBe(0);
    expect(stdout).toContain(`[check-watchdog-isolation] OK: ${DEAD_PID_FILE}`);
    expect(stdout).toContain(`[check-watchdog-isolation] OK: ${STALLED_SESSION_FILE}`);
    expect(stdout).toContain('[check-watchdog-isolation] PASS: both watchdog tests passed within budget under full suite concurrency');
  });

  it("spawning 'node scripts/check-watchdog-isolation.mjs <nonexistent-path>' (invalid-argument/failure condition) exits NONZERO with a diagnostic on stderr -- silent exit 0 is impossible", () => {
    // An arbitrary argument pointing at a status file that does not exist is
    // the script's documented fail-loud path (exit code 2, see the script's
    // own header comment). A silent exit 0 here -- the pre-fix defect's
    // signature symptom -- must fail this test.
    const bogusStatusFile = path.join(outerDir, 'does-not-exist.json');

    const { status, stdout, stderr } = spawnScript([bogusStatusFile]);

    expect(status).not.toBe(0);
    expect(stdout.length + stderr.length).toBeGreaterThan(0);
    expect(stderr).toContain('[check-watchdog-isolation] ERROR: no status file at');
    expect(stdout).not.toContain('PASS: both watchdog tests passed');
  });

  it("spawning against a status file whose recorded results FAIL the budget check exits NONZERO (status 1) with FAIL diagnostics on stdout, proving main() ran on the failure path too", () => {
    fs.writeFileSync(
      statusFile,
      JSON.stringify({
        results: {
          [DEAD_PID_FILE]: { passed: true, durationMs: 999999 }, // over the 180000ms budget
          [STALLED_SESSION_FILE]: { passed: false, durationMs: 8000 },
        },
      }),
      'utf-8',
    );

    const { status, stdout, stderr } = spawnScript([statusFile]);

    expect(status).toBe(1);
    expect(stdout).toMatch(new RegExp(`FAIL: ${DEAD_PID_FILE.replace(/\./g, '\\.')} .* exceeds budget`));
    expect(stdout).toContain(`FAIL: ${STALLED_SESSION_FILE} did not pass`);
    // The final summary FAIL line goes to stderr (console.error), not stdout.
    expect(stderr).toContain('[check-watchdog-isolation] FAIL: watchdog isolation check failed');
  });
});
