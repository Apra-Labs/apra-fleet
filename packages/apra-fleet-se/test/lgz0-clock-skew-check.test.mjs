import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exec } from 'node:child_process';
import {
    CLOCK_SKEW_PROBE_POSIX,
    CLOCK_SKEW_PROBE_WINDOWS,
    parseEpochMillis,
} from '../fleet-sprint/runner.js';
import { runCmd, runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-lgz0.1.3: end-to-end coverage of the Clock Skew Check phase wired
// into Sprint Setup by apra-fleet-lgz0.1.2. Pure-helper unit coverage for
// evaluateClockSkew()/parseEpochMillis()/clockSkewThresholdMs() (member
// ahead/behind/in-bracket, NaN input) already lives in
// clock-skew-helpers.test.mjs (apra-fleet-lgz0.1.1) and is deliberately not
// duplicated here -- this file exercises the PHASE itself, wired into a real
// (mocked) sprint run.
//
// These scenarios drive the phase through the SAME in-process mock-sprint
// harness the sibling develop-loop tests use (runDevelopLoopScenario /
// buildMockFleetApi): a single, fast Develop cycle that closes its one task
// and approves review, so the interesting part -- what the Clock Skew Check
// phase logs during Sprint Setup, before Develop even starts -- happens
// identically to a real sprint's first phase, without a real remote member.
//
// The phase's probe commands ('date +%s%3N' / the PowerShell equivalent) are
// not git/gh/bd, so buildMockFleetApi's default behavior actually runs the
// POSIX one for REAL against the local shell in tempDir -- exactly what the
// "healthy member" scenario below wants (same host, same clock, ~0 skew, no
// fabrication needed). The "skewed"/"threshold"/"probe failure" scenarios
// instead use the harness's commandStdoutOverride/commandFailurePattern hooks
// (commandStdoutOverride added by this task -- commandFailurePattern alone
// can only inject a failure, never a specific successful reading) to control
// the probe's answer deterministically, since there is no other way to
// simulate a skewed remote clock from a single-host test run.

const WARNING_RE = /WARNING: Clock Skew Check: member '([^']+)' clock is (ahead of|behind) the hub by (\d+)ms/;
const UNMEASURED_RE = /Clock Skew Check: could not read the clock probe on member '([^']+)'/;

function parseAssignedIds(prompt) {
    const match = prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
}

async function closingDoerHandler({ opts, tempDir }) {
    const ids = parseAssignedIds(opts.prompt);
    for (const id of ids) {
        await runCmd(`bd close ${id} --reason "Done"`, tempDir);
    }
    return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'Closed for real.' }) }] };
}

const approvingReviewerHandler = async () => ({
    content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }]
});

const baseScenarioOptions = {
    taskSpecs: [{ title: 'Task: closes normally' }],
    maxCycles: 1,
    doerHandler: closingDoerHandler,
    reviewerHandler: approvingReviewerHandler,
};

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// -----------------------------------------------------------------------
// 1. Healthy member: probe returns an epoch inside [hubT0, hubT1] -> a
//    'Clock Skew Check' phase ran for that member, and NO warning logged.
// -----------------------------------------------------------------------
test('mock sprint: healthy member (real same-host probe) -> Clock Skew Check phase runs, no warning logged', async () => {
    await withScenarioMarkers('lgz0.1.3 (1): healthy member, silent phase', async () => {
        const scenario = await runDevelopLoopScenario('lgz013-healthy', {
            ...baseScenarioOptions,
            members: ['local'],
        });

        check(
            !scenario.error,
            `Expected the sprint to complete cleanly, got: ${scenario.error ? scenario.error.constructor.name + ': ' + scenario.error.message : 'none'}`
        );
        const probed = scenario.commandLogDetailed.some((e) => e.command === CLOCK_SKEW_PROBE_POSIX && e.member === 'local');
        check(
            probed,
            `Expected the Clock Skew Check phase to have probed member 'local' with the POSIX probe, got commandLogDetailed: ${JSON.stringify(scenario.commandLogDetailed)}`
        );
        const warnings = scenario.logs.filter((m) => WARNING_RE.test(m));
        check(warnings.length === 0, `Expected NO clock-skew warning for a healthy (same-host) member, got: ${JSON.stringify(warnings)}`);
        const unmeasured = scenario.logs.filter((m) => UNMEASURED_RE.test(m));
        check(unmeasured.length === 0, `Expected the real probe to succeed on a healthy host (no 'could not measure' advisory), got: ${JSON.stringify(unmeasured)}`);
    });
});

// -----------------------------------------------------------------------
// 2. Skewed member: probe returns hubT1 + 215000 (the real fleet-win-dev1
//    case) -> exactly one WARNING is logged, naming the member and a skew
//    value in the ~215s range; the sprint still proceeds past Sprint Setup.
// -----------------------------------------------------------------------
test('mock sprint: skewed member (probe reads hubT1 + 215s, the real fleet-win-dev1 case) -> exactly one WARNING, sprint proceeds', async () => {
    await withScenarioMarkers('lgz0.1.3 (2): skewed member -> warning, no abort', async () => {
        const scenario = await runDevelopLoopScenario('lgz013-skewed', {
            ...baseScenarioOptions,
            members: ['local'],
            commandStdoutOverride: (opts) => (opts.command === CLOCK_SKEW_PROBE_POSIX ? String(Date.now() + 215000) : null),
        });

        check(
            !scenario.error,
            `Expected the sprint to proceed past Sprint Setup (advisory-only), got: ${scenario.error ? scenario.error.constructor.name + ': ' + scenario.error.message : 'none'}`
        );
        check(scenario.result != null, 'Expected the sprint to reach a real completion result, not abort at Sprint Setup.');

        const warnings = scenario.logs.filter((m) => WARNING_RE.test(m));
        check(warnings.length === 1, `Expected exactly one clock-skew WARNING, got ${warnings.length}: ${JSON.stringify(warnings)}`);
        const [, member, direction, skewMsStr] = WARNING_RE.exec(warnings[0]);
        check(member === 'local', `Expected the warning to name member 'local', got '${member}'`);
        check(direction === 'ahead of', `Expected the member to be reported ahead of the hub, got '${direction}'`);
        const skewMs = Number(skewMsStr);
        check(
            skewMs >= 215000 && skewMs < 220000,
            `Expected a skew value in the ~215s range (a few seconds of test overhead allowed), got ${skewMs}ms`
        );
    });
});

// -----------------------------------------------------------------------
// 3. Threshold is derived, not hardcoded: with STALL_THRESHOLD_MS=400000 a
//    60000ms skew produces NO warning (60s < 100s quarter-threshold); with
//    the 120000 default the SAME 60000ms skew DOES warn.
// -----------------------------------------------------------------------
test('mock sprint: clock-skew threshold is derived from STALL_THRESHOLD_MS, not hardcoded', async () => {
    await withScenarioMarkers('lgz0.1.3 (3): threshold derived from env', async () => {
        const skewOverride = (opts) => (opts.command === CLOCK_SKEW_PROBE_POSIX ? String(Date.now() + 60000) : null);
        const priorThreshold = process.env.STALL_THRESHOLD_MS;
        try {
            process.env.STALL_THRESHOLD_MS = '400000';
            const wide = await runDevelopLoopScenario('lgz013-thresh-wide', {
                ...baseScenarioOptions,
                members: ['local'],
                commandStdoutOverride: skewOverride,
            });
            check(!wide.error, `Expected the sprint to proceed cleanly, got: ${wide.error ? wide.error.message : 'none'}`);
            const wideWarnings = wide.logs.filter((m) => WARNING_RE.test(m));
            check(
                wideWarnings.length === 0,
                `Expected NO warning for a 60s skew under a 100s quarter-threshold (STALL_THRESHOLD_MS=400000), got: ${JSON.stringify(wideWarnings)}`
            );

            delete process.env.STALL_THRESHOLD_MS;
            const narrow = await runDevelopLoopScenario('lgz013-thresh-narrow', {
                ...baseScenarioOptions,
                members: ['local'],
                commandStdoutOverride: skewOverride,
            });
            check(!narrow.error, `Expected the sprint to proceed cleanly, got: ${narrow.error ? narrow.error.message : 'none'}`);
            const narrowWarnings = narrow.logs.filter((m) => WARNING_RE.test(m));
            check(
                narrowWarnings.length === 1,
                `Expected a warning for the SAME 60s skew under the default 30s quarter-threshold (STALL_THRESHOLD_MS unset), got: ${JSON.stringify(narrowWarnings)}`
            );
        } finally {
            if (priorThreshold === undefined) delete process.env.STALL_THRESHOLD_MS;
            else process.env.STALL_THRESHOLD_MS = priorThreshold;
        }
    });
});

// -----------------------------------------------------------------------
// 4. Probe failure: first (POSIX) probe fails -> the Windows PowerShell
//    fallback probe is attempted; if BOTH fail, no warning is emitted, an
//    advisory 'could not measure' line is logged, and the sprint proceeds
//    normally (advisory-only invariant).
// -----------------------------------------------------------------------
test('mock sprint: both probes fail -> advisory "could not measure" line only, sprint proceeds', async () => {
    await withScenarioMarkers('lgz0.1.3 (4): probe failure -> advisory only', async () => {
        const bothProbesFail = new RegExp(
            `^(${escapeRegExp(CLOCK_SKEW_PROBE_POSIX)}|${escapeRegExp(CLOCK_SKEW_PROBE_WINDOWS)})$`
        );
        const scenario = await runDevelopLoopScenario('lgz013-probefail', {
            ...baseScenarioOptions,
            members: ['local'],
            commandFailurePattern: bothProbesFail,
        });

        check(
            !scenario.error,
            `Expected the sprint to proceed normally when both probes fail (advisory-only), got: ${scenario.error ? scenario.error.message : 'none'}`
        );

        const posixAttempted = scenario.commandLogDetailed.some((e) => e.command === CLOCK_SKEW_PROBE_POSIX && e.member === 'local');
        const windowsAttempted = scenario.commandLogDetailed.some((e) => e.command === CLOCK_SKEW_PROBE_WINDOWS && e.member === 'local');
        check(posixAttempted, 'Expected the POSIX probe to have been attempted first.');
        check(windowsAttempted, 'Expected the Windows PowerShell fallback probe to have been attempted after the POSIX probe failed.');

        const warnings = scenario.logs.filter((m) => WARNING_RE.test(m));
        check(warnings.length === 0, `Expected NO clock-skew warning when both probes fail, got: ${JSON.stringify(warnings)}`);
        const unmeasured = scenario.logs.filter((m) => UNMEASURED_RE.test(m));
        check(unmeasured.length === 1, `Expected exactly one advisory 'could not measure' line, got: ${JSON.stringify(unmeasured)}`);
    });
});

// -----------------------------------------------------------------------
// 5. Per-member coverage: with two dispatched members, the phase probes
//    both.
// -----------------------------------------------------------------------
test('mock sprint: two dispatched members -> the Clock Skew Check phase probes both', async () => {
    await withScenarioMarkers('lgz0.1.3 (5): per-member coverage', async () => {
        const scenario = await runDevelopLoopScenario('lgz013-twomember', {
            ...baseScenarioOptions,
            members: ['member-a', 'member-b'],
        });

        check(!scenario.error, `Expected the sprint to complete cleanly, got: ${scenario.error ? scenario.error.message : 'none'}`);
        for (const member of ['member-a', 'member-b']) {
            const probed = scenario.commandLogDetailed.some((e) => e.command === CLOCK_SKEW_PROBE_POSIX && e.member === member);
            check(
                probed,
                `Expected the Clock Skew Check phase to have probed member '${member}', got commandLogDetailed: ${JSON.stringify(scenario.commandLogDetailed)}`
            );
        }
    });
});

// -----------------------------------------------------------------------
// Probe-string reality check (REQUIRED, not covered by any of the mocked
// scenarios above): execute the exported CLOCK_SKEW_PROBE_* string for the
// CURRENT platform through the real local shell (child_process, same shell
// runner.js's own command-execution path ultimately spawns), and confirm
// parseEpochMillis() on its stdout returns a finite value within 5 seconds
// of Date.now(). Every scenario above answers the probe via the mock (or,
// for the "healthy" scenario, via a real run whose SUCCESS is asserted only
// indirectly through "no warning/no advisory logged") -- none of them catch
// a probe string that is syntactically wrong or mangled by the quoting
// layer, since a mangled probe degrades to "unparsable" and every mocked
// case above stays green regardless. This is the one case that actually
// proves the probe strings work. Hermetic: local shell only, no remote
// member, negligible runtime.
// -----------------------------------------------------------------------
test('reality check: the exported CLOCK_SKEW_PROBE_* string for this platform actually returns a fresh epoch-millis reading', async () => {
    const probeCommand = process.platform === 'win32' ? CLOCK_SKEW_PROBE_WINDOWS : CLOCK_SKEW_PROBE_POSIX;
    const execOptions = process.platform === 'win32' ? { shell: 'powershell.exe', timeout: 5000 } : { timeout: 5000 };

    const stdout = await new Promise((resolve, reject) => {
        exec(probeCommand, execOptions, (err, out, errOut) => {
            if (err) {
                reject(new Error(`probe command '${probeCommand}' failed: ${err.message}; stderr=${errOut}`));
                return;
            }
            resolve(out);
        });
    });

    const parsed = parseEpochMillis(stdout);
    check(
        typeof parsed === 'number' && Number.isFinite(parsed),
        `Expected parseEpochMillis() to extract a finite epoch-millis value from the real probe's stdout ${JSON.stringify(stdout)}, got ${parsed}`
    );
    const drift = Math.abs(parsed - Date.now());
    check(drift < 5000, `Expected the real probe's reading to be within 5s of Date.now() (same host), got drift=${drift}ms`);
});
