import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

// =============================================================================
// apra-fleet-iiny.1.5 -- integration coverage for the sprint-doctor
// OBSERVATION layer's wiring (design: fleet-sprint/docs/escalate-to-llm-
// design.md section 1.3), driven through the real mock-sprint harness rather
// than by calling the ledger/trigger modules directly.
//
// WHY THIS TEST EXISTS ALONGSIDE doctor-ledger-triggers.test.mjs. That suite
// proves the two pure modules behave correctly given rows; it cannot prove
// the ENGINE ever hands them a row, nor that doing so left every existing
// outcome alone. This one runs whole mock sprints through
// WorkflowEngine.executeFile() and asserts the three things only an
// end-to-end run can show:
//
//   1. the hooks record at the REAL dispatch sites (a doer streak that fails
//      three times produces exactly three ledger rows attributed to its bead,
//      and exactly one T1 log line),
//   2. the bead-diversity rule survives the wiring -- failures spread across
//      two beads on one member raise T2, the same count on ONE bead does not,
//   3. the layer is genuinely observation-only: doctor_enabled=false is
//      silent to the byte, and an enabled run's terminal outcome (its error,
//      its final bead states and every non-doctor log line) is identical to
//      the disabled run's.
//
// It runs fully offline: no live member, no network. Every dispatch is
// answered by the harness's in-process mock fleet and every `bd` call is
// replayed from this file's committed recordings (test/helpers/bd-replay.mjs).
//
// IT FAILS IF THE HOOK WIRING IS REVERTED. Removing the develop-phase H1
// record calls empties the ledger -- the row assertions and both trigger-log
// assertions fail. Removing the H4 evaluation keeps the rows but loses the
// T1/T2 log lines. Removing the artifact path leaves nothing on disk for the
// JSONL assertions to read.
// =============================================================================

// One member, so every streak in a scenario lands on the same doer -- which
// is what makes the T2 (one member, >= 2 distinct beads) case expressible at
// all, and what makes the single-bead scenario a genuine negative control for
// it rather than an accident of member round-robining.
const MEMBERS = ['local'];

const approveReviewer = async () => ({
    content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }],
});

// An INFRASTRUCTURE dispatch failure (errors.mjs's INFRA_DISPATCH_REASONS),
// not a task failure: the member CLI never delivered a result envelope. This
// is the failure class T1/T2 exist for, and it is identical on every attempt,
// so the normalized errorSignature is stable across rounds too.
const infraFailingDoer = async () => ({
    content: [{ text: 'command killed after inactivity timeout (no output)' }],
    structuredContent: { isError: true, reason: 'dispatch_failed' },
});

const doctorLines = (logs) => logs.filter((m) => m.includes('[sprint-doctor]'));
const triggerLines = (logs, trigger) => logs.filter((m) => m.includes(`[sprint-doctor] ${trigger} fired`));

/**
 * The run's log stream with everything scenario-unique folded away (bead ids,
 * the scenario tag and the branch/run id built from it, temp paths, elapsed
 * times) and every doctor line removed -- so two structurally identical runs
 * that differ ONLY in whether the doctor was enabled compare equal.
 */
function normalizeLogs(logs, tag) {
    const beadIdRe = new RegExp(`apra-fleet-mock-sprint-${tag}-\\d+-\\d+(?:-[a-z0-9]+)?`, 'g');
    const tagRe = new RegExp(tag, 'g');
    return logs
        .filter((m) => !m.includes('[sprint-doctor]'))
        .map((m) => m
            .replace(beadIdRe, '<BEAD>')
            .replace(/\/(?:var|private)\/[^\s,)'"\]]+/g, '<TMP>')
            .replace(tagRe, '<TAG>')
            // Wall-clock values and branch-derived digests are per-RUN, not
            // per-configuration: a VCS credential's expiry stamp and the
            // sprint-analysis filename's branch-slug hash differ between any
            // two runs, doctor or no doctor.
            .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '<TS>')
            .replace(/\b[0-9a-f]{8,}\b/g, '<HEX>')
            .replace(/\d+(?:\.\d+)?\s*ms\b/g, '<MS>')
            .replace(/\b\d{10,}\b/g, '<NUM>'));
}

/**
 * Terminal bead state, keyed by title so two runs with different (random,
 * per-scratch-dir) bead ids compare. setupMinimal() names the scenario's epic
 * after its tag, so the tag is folded out here for the same reason
 * normalizeLogs() folds it out of the log stream.
 */
const beadStatusesByTitle = (finalBeadsById, tag) => [...finalBeadsById.values()]
    .map((b) => `${String(b.title).split(tag).join('<TAG>')}=${b.status}`)
    .sort();

/**
 * Runs one mock sprint with a private fleet data directory, so the doctor's
 * health-ledger artifact (written beside the run state under the fleet data
 * dir, never into the target repo checkout) lands somewhere this test owns
 * and can read back -- and never in the developer's real ~/.apra-fleet.
 */
async function runDoctorScenario(tag, { taskSpecs, doctorArgs }) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `doctor-wiring-${tag}-`));
    const priorDataDir = process.env.APRA_FLEET_DATA_DIR;
    process.env.APRA_FLEET_DATA_DIR = dataDir;
    const runId = `${tag}-run`;
    try {
        return await withScenarioMarkers(tag, async () => {
            const result = await runDevelopLoopScenario(tag, {
                members: MEMBERS,
                taskSpecs,
                maxCycles: 1,
                runId,
                doerHandler: infraFailingDoer,
                reviewerHandler: approveReviewer,
                ...(doctorArgs !== undefined ? { doctorArgs } : {}),
            });
            const artifactPath = path.join(dataDir, 'doctor', `${runId}-health-ledger.jsonl`);
            const artifactExists = fs.existsSync(artifactPath);
            return {
                ...result,
                tag,
                artifactPath,
                artifactExists,
                artifactLines: artifactExists
                    ? fs.readFileSync(artifactPath, 'utf8').split('\n').filter((l) => l.length > 0)
                    : [],
            };
        });
    } finally {
        if (priorDataDir === undefined) delete process.env.APRA_FLEET_DATA_DIR;
        else process.env.APRA_FLEET_DATA_DIR = priorDataDir;
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
}

// Captured by the first test and compared against by the doctor_enabled=false
// test below, so the "changed nothing else" claim is made against a real
// enabled run of the SAME scenario shape rather than against a hand-written
// expectation. node:test runs the tests in a file in order, so this is
// populated by the time the later test reads it (asserted there explicitly
// rather than assumed).
let enabledBaseline = null;

test('mock sprint: three infra dispatch failures on ONE bead produce three ledger rows for it and exactly one T1 line', async () => {
    const result = await runDoctorScenario('dwireone', {
        taskSpecs: [{ title: 'Task: doctor wiring single bead work' }],
    });

    assert.equal(result.error, null, `the scenario must not throw: ${result.error ? result.error.message : ''}`);

    const taskId = result.tasks[0].id;
    const rows = result.artifactLines.map((l) => JSON.parse(l));
    const doerRows = rows.filter((r) => r.role === 'doer');

    // Three develop rounds, one streak each, every one failing: the runner's
    // own per-round attribution log is the independent witness that there
    // really were three, so the ledger is being compared against the engine's
    // behaviour rather than against itself.
    const attributionLines = result.logs.filter((m) => m.startsWith('Doer streak attribution'));
    assert.equal(attributionLines.length, 3, `expected three doer streak attributions, got ${attributionLines.length}`);
    assert.equal(doerRows.length, 3, `expected three doer ledger rows, got ${doerRows.length}: ${JSON.stringify(doerRows)}`);
    for (const row of doerRows) {
        assert.deepEqual(row.beadIds, [taskId], 'every doer row must be attributed to the failing bead');
        assert.equal(row.ok, false, 'a failed streak must be recorded as a failed dispatch');
        assert.equal(row.reason, 'dispatch_failed', 'the structured infra reason must survive into the row');
        assert.equal(row.member, 'local', 'the row must name the member the streak was dispatched to');
        assert.ok(row.errorSignature, 'a failed row must carry a normalized error signature');
    }
    // Same failure every round -> one signature, which is what makes the
    // repetition legible as a pattern rather than as three different problems.
    assert.equal(new Set(doerRows.map((r) => r.errorSignature)).size, 1, 'three identical failures must normalize to ONE signature');

    const t1 = triggerLines(result.logs, 'T1');
    assert.equal(t1.length, 1, `expected exactly one T1 log line, got ${t1.length}: ${JSON.stringify(doctorLines(result.logs))}`);
    assert.ok(t1[0].includes(taskId), `the T1 line must name the bead it fired for: ${t1[0]}`);
    // Record-only: this layer must never claim to have consulted anything.
    assert.ok(t1[0].includes('no consult is dispatched'), `the T1 line must say it is record-only: ${t1[0]}`);

    // The T2 negative control: the SAME three failures, on the same member,
    // confined to ONE bead must NOT raise T2 -- a single hard bead may never
    // impersonate a sick member.
    assert.equal(
        triggerLines(result.logs, 'T2').length, 0,
        `three failures on a single bead must not raise T2: ${JSON.stringify(doctorLines(result.logs))}`
    );

    enabledBaseline = {
        tag: result.tag,
        logs: normalizeLogs(result.logs, result.tag),
        beadStatuses: beadStatusesByTitle(result.finalBeadsById, result.tag),
        error: result.error,
    };
});

test('mock sprint: the health-ledger artifact is one parseable JSON line per recorded dispatch', async () => {
    assert.ok(enabledBaseline, 'the enabled-run test above must have run first');
    // Re-driven rather than reusing the first test's rows, so the ARTIFACT
    // itself (the JSONL file on disk, not the in-memory ledger) is what is
    // being asserted about.
    const result = await runDoctorScenario('dwireart', {
        taskSpecs: [{ title: 'Task: doctor wiring artifact work' }],
    });

    assert.equal(result.error, null, `the scenario must not throw: ${result.error ? result.error.message : ''}`);
    assert.ok(result.artifactExists, `expected a health-ledger artifact at ${result.artifactPath}`);
    assert.ok(result.artifactLines.length > 0, 'the artifact must not be empty');

    const rows = [];
    for (const [index, line] of result.artifactLines.entries()) {
        let parsed;
        try {
            parsed = JSON.parse(line);
        } catch (err) {
            assert.fail(`artifact line ${index + 1} is not valid JSON (${err.message}): ${line}`);
        }
        assert.equal(typeof parsed, 'object', `artifact line ${index + 1} must be a JSON object`);
        assert.ok(Array.isArray(parsed.beadIds), `artifact line ${index + 1} must carry a beadIds array`);
        assert.equal(typeof parsed.ok, 'boolean', `artifact line ${index + 1} must carry a boolean ok`);
        assert.ok(Number.isFinite(parsed.timestamp), `artifact line ${index + 1} must carry a timestamp`);
        rows.push(parsed);
    }

    // One line per RECORDED dispatch, not per dispatch the sprint made: the
    // hooks are at named outcome sites, so the count is the doer streak
    // outcomes plus the plan-review round this scenario also records.
    const doerRows = rows.filter((r) => r.role === 'doer');
    assert.equal(doerRows.length, 3, `expected three doer rows in the artifact, got ${doerRows.length}`);
    assert.equal(
        rows.length, result.artifactLines.length,
        'every artifact line must have parsed into exactly one row'
    );
    assert.ok(
        rows.every((r) => typeof r.role === 'string' && r.role.length > 0),
        `every recorded row must name the role it came from: ${JSON.stringify(rows)}`
    );
});

test('mock sprint: infra failures across TWO distinct beads on one member raise T2', async () => {
    const result = await runDoctorScenario('dwiretwo', {
        taskSpecs: [
            { title: 'Task: doctor wiring alpha work' },
            { title: 'Task: doctor wiring beta work' },
        ],
    });

    assert.equal(result.error, null, `the scenario must not throw: ${result.error ? result.error.message : ''}`);

    const t2 = triggerLines(result.logs, 'T2');
    assert.equal(t2.length, 1, `expected exactly one T2 log line, got ${t2.length}: ${JSON.stringify(doctorLines(result.logs))}`);
    assert.ok(t2[0].includes("Member 'local'"), `the T2 line must name the member: ${t2[0]}`);
    assert.ok(t2[0].includes('2 distinct beads'), `the T2 line must state the bead diversity that justified it: ${t2[0]}`);

    // The rows behind it: failures on BOTH beads, all against the one member.
    const rows = result.artifactLines.map((l) => JSON.parse(l)).filter((r) => r.role === 'doer');
    const failedBeadIds = new Set(rows.filter((r) => !r.ok).flatMap((r) => r.beadIds));
    assert.equal(failedBeadIds.size, 2, `expected recorded failures on both beads, got ${[...failedBeadIds].join(', ')}`);
    for (const task of result.tasks) {
        assert.ok(failedBeadIds.has(task.id), `expected a recorded failure for bead ${task.id}`);
    }
});

test('mock sprint: doctor_enabled=false writes no artifact, logs nothing, and leaves the terminal outcome identical', async () => {
    assert.ok(enabledBaseline, 'the enabled-run test above must have run first to compare against');

    const result = await runDoctorScenario('dwireoff', {
        taskSpecs: [{ title: 'Task: doctor wiring single bead work' }],
        doctorArgs: { doctor_enabled: false },
    });

    assert.equal(
        doctorLines(result.logs).length, 0,
        `a disabled doctor must emit no log line at all: ${JSON.stringify(doctorLines(result.logs))}`
    );
    assert.equal(result.artifactExists, false, `a disabled doctor must write no artifact (found ${result.artifactPath})`);

    // The observation-only claim, stated as an equality rather than as a
    // collection of negatives: with the doctor's own lines removed and
    // scenario-unique values folded away, an enabled run and a disabled run
    // of the same sprint produce the same log stream, the same terminal bead
    // states and the same (absent) terminal error.
    assert.equal(result.error, enabledBaseline.error, 'the terminal error must be unchanged by the doctor hooks');
    assert.deepEqual(
        beadStatusesByTitle(result.finalBeadsById, result.tag),
        enabledBaseline.beadStatuses,
        'the terminal bead states must be unchanged by the doctor hooks'
    );
    assert.deepEqual(
        normalizeLogs(result.logs, result.tag),
        enabledBaseline.logs,
        'with the doctor lines removed, an enabled run must produce byte-identical output to a disabled one'
    );
});
