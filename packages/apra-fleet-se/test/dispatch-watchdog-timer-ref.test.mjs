import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

// =============================================================================
// apra-fleet-eft.50.3: fast, dedicated regression pin for the specific defect
// commit d87a5ec5 (apra-fleet-eft.50.1's CI-regression follow-up) fixed --
// withDispatchWatchdog()'s setTimeout being unref'd, which let the event
// loop drain (and the watchdog silently never fire) whenever a stalled
// dispatch left NOTHING else scheduled. See runner.js's own comment at the
// `const DISPATCH_WATCHDOG_GRACE_S = 30;` / `setTimeout(...)` site for the
// full root-cause writeup, and this repo's existing regression guard for the
// end-to-end symptom: mock-sprint-planner-dispatch-stalled-session.test.mjs
// (apra-fleet-eft.28.3/28.4), which reproduces the same defect but only at a
// ~560s real-time ceiling (5 watchdog-bounded retry attempts plus backoff).
//
// dispatch-watchdog.test.mjs (apra-fleet-eft.28.3) already pins
// withDispatchWatchdog()'s REJECTION behavior with node:test's mock.timers --
// but faked timers never exercise real Node event-loop keep-alive semantics
// at all, so that suite could not have caught (and did not catch) the
// unref'd-timer regression CI found. This test instead runs
// withDispatchWatchdog() for REAL, in an isolated child process with a
// never-settling dispatch promise and NOTHING ELSE scheduled on that
// process's event loop -- reproducing, in miniature and at a much cheaper
// ~31s ceiling (timeoutS=1 + the fixed 30s grace), the exact "replay-mode
// harness, no other work pending" shape that triggered the live CI failure.
//
//   - Regression (timer.unref()'d, pre-d87a5ec5): with nothing else on the
//     event loop, Node exits almost immediately once the never-settling
//     promise and the unref'd timer are the only things pending -- no
//     watchdog rejection, no marker, the child exits near-instantly.
//   - Fixed (timer ref'd, current code): the ref'd timer keeps the process
//     alive for the full budget, the watchdog fires, rejects with the typed
//     AgentDispatchError, the child prints the marker, and then exits
//     naturally (clearTimeout() in withDispatchWatchdog()'s .finally()
//     releases the timer once it has already fired, so nothing lingers).
//
// Manually verified this test actually pins the regression (not just the
// happy path): temporarily reinstating `timer.unref();` in runner.js's
// withDispatchWatchdog() and rerunning this file reproduces the pre-
// d87a5ec5 failure -- the child process exits in a few ms with empty
// stdout, so both assertions below fail loud, exactly the CI evidence
// apra-fleet-eft.50.1's notes recorded ("Promise resolution is still
// pending but the event loop has already resolved").
// =============================================================================

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER_URL = pathToFileURL(path.join(REPO_ROOT, 'auto-sprint', 'runner.js')).href;

// timeoutS=1 (the smallest useful value -- withDispatchWatchdog() itself has
// no floor; only auto-sprint's CLI-level validateArgs enforces the >=60s
// floor, which this direct function-level probe deliberately bypasses to
// keep the real-time cost small) + the fixed 30s grace.
const WATCHDOG_TIMEOUT_S = 1;
const WATCHDOG_GRACE_S = 30; // must match runner.js's DISPATCH_WATCHDOG_GRACE_S
const EXPECTED_BUDGET_MS = (WATCHDOG_TIMEOUT_S + WATCHDOG_GRACE_S) * 1000;

function buildChildScript() {
    return [
        `import { withDispatchWatchdog } from ${JSON.stringify(RUNNER_URL)};`,
        '',
        '// A dispatch promise that NEVER settles, and nothing else is ever',
        "// scheduled on this process's event loop -- reproduces the exact",
        '// "replay-mode harness, no other pending work" shape that let the',
        "// unref'd timer regression drain the loop before firing.",
        'const neverSettles = new Promise(() => {});',
        '',
        `withDispatchWatchdog(neverSettles, { timeoutS: ${WATCHDOG_TIMEOUT_S}, member: 'ref-check-probe', label: 'timer-ref regression probe', log: () => {} })`,
        '  .then(() => { process.stdout.write("UNEXPECTED_RESOLVE\\n"); })',
        '  .catch((err) => {',
        '    process.stdout.write(`WATCHDOG_FIRED:${err.code}:${err.details && err.details.reason}\\n`);',
        '  });',
        '',
        '// Deliberately nothing else here: if the watchdog timer is unref\'d,',
        '// this is the ENTIRE event loop, and Node exits with no output at all.',
        '',
    ].join('\n');
}

test(
    "withDispatchWatchdog: the watchdog timer is ref'd -- a stalled dispatch with NOTHING else scheduled still fires the watchdog for real (apra-fleet-eft.50.3, pins d87a5ec5)",
    { timeout: EXPECTED_BUDGET_MS + 30000 },
    () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-dispatch-watchdog-ref-'));
        const scriptPath = path.join(tmpDir, 'probe.mjs');
        fs.writeFileSync(scriptPath, buildChildScript());

        try {
            const startedAt = Date.now();
            const result = spawnSync(process.execPath, [scriptPath], {
                encoding: 'utf-8',
                timeout: EXPECTED_BUDGET_MS + 20000,
            });
            const elapsedMs = Date.now() - startedAt;

            assert.equal(
                result.status,
                0,
                `expected the probe child process to exit cleanly (status 0), got status=${result.status} signal=${result.signal} stderr=${result.stderr}`,
            );

            // The defining regression symptom: an unref'd timer lets Node exit
            // almost instantly (a few ms) with NO watchdog output at all, because
            // nothing else is keeping the event loop alive. Requiring the full
            // budget to have actually elapsed is what proves the timer kept the
            // process alive rather than the watchdog line appearing for some
            // unrelated reason.
            assert.ok(
                elapsedMs >= EXPECTED_BUDGET_MS - 2000,
                `expected the child process to stay alive for close to the full ~${EXPECTED_BUDGET_MS}ms watchdog budget (timer ref'd) -- it exited after only ${elapsedMs}ms, matching the pre-d87a5ec5 unref'd-timer regression (event loop drained before the watchdog could fire)`,
            );

            assert.match(
                result.stdout,
                /WATCHDOG_FIRED:AGENT_DISPATCH_FAILED:watchdog_timeout/,
                `expected the watchdog's typed AgentDispatchError(reason: watchdog_timeout) to have actually fired and been observed by the child process, stdout: ${JSON.stringify(result.stdout)}`,
            );
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    },
);
