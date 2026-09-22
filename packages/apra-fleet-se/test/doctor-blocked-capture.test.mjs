import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

// =============================================================================
// apra-fleet-mduk.1 -- integration coverage for capturing a doer BLOCKED
// report into the sprint-doctor health ledger and stopping the re-dispatch
// loop (design: fleet-sprint/docs/escalate-to-llm-design.md section 1.2 T5;
// owner doctrine on bead apra-fleet-mduk).
//
// Driven through the real mock-sprint harness (like doctor-ledger-wiring.
// test.mjs) rather than by calling phases/develop.mjs or the pure
// doctor-triggers.mjs module directly, because the behavior under test spans
// three real call sites: phases/develop.mjs's recordStreakHealth (the H1
// ledger row), the runner's post-develop-phase red-state raise (the T5
// consult log line), and the runner's own ready-bead queries (the exclusion
// that actually stops re-dispatch). A pure-module test could prove any one
// of these in isolation but not that the engine really wires them together
// end to end.
//
// It runs fully offline: no live member, no network. Every dispatch is
// answered by the harness's in-process mock fleet.
// =============================================================================

const MEMBERS = ['local'];

const approveReviewer = async () => ({
    content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }],
});

const BLOCKED_REASON = 'Doer contract forbids running playbook Setup/Reset/Teardown in a dev dispatch; '
    + 'recommends the regression-test-runner role instead.';

// A doer that reports BLOCKED on every dispatch, with its assigned bead(s)
// left open (closedIds: []) -- the exact shape a real doer.md-contract
// refusal produces (see doer.md's missing-input BLOCKED example, and the
// mock harness's own branch-missing BLOCKED response this mirrors).
const blockedDoer = async () => ({
    content: [{
        text: JSON.stringify({
            status: 'BLOCKED',
            closedIds: [],
            notes: BLOCKED_REASON,
        }),
    }],
});

const doctorLines = (logs) => logs.filter((m) => m.includes('[sprint-doctor]'));
const triggerLines = (logs, trigger) => logs.filter((m) => m.includes(`[sprint-doctor] ${trigger} fired`));

/**
 * Runs one mock sprint with a private fleet data directory, so the doctor's
 * health-ledger artifact (written beside the run state under the fleet data
 * dir, never into the target repo checkout) lands somewhere this test owns
 * and can read back -- and never in the developer's real ~/.apra-fleet.
 * Mirrors doctor-ledger-wiring.test.mjs's runDoctorScenario() exactly.
 */
async function runBlockedScenario(tag, { doctorArgs, maxCycles = 1 } = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `doctor-blocked-${tag}-`));
    const priorDataDir = process.env.APRA_FLEET_DATA_DIR;
    process.env.APRA_FLEET_DATA_DIR = dataDir;
    const runId = `${tag}-run`;
    try {
        return await withScenarioMarkers(tag, async () => {
            const result = await runDevelopLoopScenario(tag, {
                members: MEMBERS,
                taskSpecs: [{ title: 'Task: doctor blocked capture work' }],
                maxCycles,
                runId,
                doerHandler: blockedDoer,
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

test('mock sprint: a doer BLOCKED report is captured as a distinct ledger outcome, raises exactly one T5, and is never re-dispatched', async () => {
    // maxCycles: 1, matching doctor-ledger-wiring.test.mjs's infra-failure
    // scenario -- the round loop alone (up to 3 develop rounds per cycle)
    // is what proves "never re-dispatched" here: WITHOUT the fix, an
    // unclosed bead re-appears in `currentReadyAll` every round and is
    // re-dispatched up to 3 times (exactly what the infra-failure sibling
    // test asserts for a genuine infra failure); WITH the fix, the bead is
    // excluded after its first BLOCKED report, so rounds 2 and 3 find an
    // empty ready set and `break` before ever dispatching again.
    const result = await runBlockedScenario('mdukcap', { maxCycles: 1 });

    assert.equal(result.error, null, `the scenario must not throw: ${result.error ? result.error.message : ''}`);

    const taskId = result.tasks[0].id;

    // --- 1. Distinct ledger outcome, carrying the stated reason ---
    const rows = result.artifactLines.map((l) => JSON.parse(l));
    const doerRows = rows.filter((r) => r.role === 'doer');
    assert.equal(doerRows.length, 1, `expected exactly one doer ledger row (no re-lane), got ${doerRows.length}: ${JSON.stringify(doerRows)}`);
    assert.deepEqual(doerRows[0].beadIds, [taskId], 'the row must be attributed to the blocked bead');
    assert.equal(doerRows[0].ok, false, 'a BLOCKED report with open beads must be recorded as a failed dispatch');
    assert.equal(doerRows[0].reason, 'doer_blocked', 'a BLOCKED report must record its OWN reason, not a generic streak_beads_not_closed/infra reason');
    assert.ok(doerRows[0].errorSignature, 'the row must carry a normalized error signature');
    assert.ok(
        doerRows[0].errorSignature.startsWith('doer_blocked:'),
        `the signature must be built from the distinct 'doer_blocked' reason: ${doerRows[0].errorSignature}`
    );

    // --- 2. The red-state trigger fires exactly once for that bead ---
    const t5 = triggerLines(result.logs, 'T5');
    assert.equal(t5.length, 1, `expected exactly one T5 log line, got ${t5.length}: ${JSON.stringify(doctorLines(result.logs))}`);
    assert.ok(t5[0].includes(taskId), `the T5 line must name the bead it fired for: ${t5[0]}`);
    assert.ok(t5[0].includes('no consult is dispatched'), `the T5 line must say it is record-only (the consult dispatcher is a later task): ${t5[0]}`);

    // Distinct from the T5-fired line above: the T5 line's own summary text
    // happens to CONTAIN "reported BLOCKED for bead" too (it is built from
    // the same event summary), so this filters on the exclusion line's own
    // distinguishing phrase instead of the substring the two lines share.
    const blockedLines = result.logs.filter((m) => m.includes('excluding it from re-lane'));
    assert.equal(blockedLines.length, 1, `expected exactly one BLOCKED-exclusion log line, got ${blockedLines.length}`);
    assert.ok(blockedLines[0].includes(taskId));
    assert.ok(blockedLines[0].includes(BLOCKED_REASON), 'the doer\'s stated reason must be captured VERBATIM into the log line');

    // --- 3. Never re-dispatched: exactly one streak attribution total ---
    const attributionLines = result.logs.filter((m) => m.startsWith('Doer streak attribution'));
    assert.equal(
        attributionLines.length, 1,
        `expected exactly one doer streak attribution (no unchanged re-dispatch across the round cap), got ${attributionLines.length}: ${JSON.stringify(attributionLines)}`
    );

    // The bead itself is left open -- nothing here fabricates a close, and
    // nothing routes it back through the doer a second time.
    const bead = result.finalBeadsById.get(taskId);
    assert.ok(bead, 'the blocked bead must still exist in the final beads snapshot');
    assert.notEqual(bead.status, 'closed', 'a BLOCKED bead must never be silently marked closed');
});

test('mock sprint: doctor_enabled=false leaves a BLOCKED report on the old re-lane path (no ledger, no exclusion, no T5)', async () => {
    const result = await runBlockedScenario('mdukoff', { maxCycles: 1, doctorArgs: { doctor_enabled: false } });

    assert.equal(result.error, null, `the scenario must not throw: ${result.error ? result.error.message : ''}`);
    assert.equal(result.artifactExists, false, 'a disabled doctor must write no health-ledger artifact');
    assert.equal(doctorLines(result.logs).length, 0, 'a disabled doctor must emit no [sprint-doctor] log line at all');
    assert.equal(
        result.logs.filter((m) => m.includes('reported BLOCKED for bead')).length, 0,
        'the BLOCKED-exclusion bookkeeping is part of the doctor subsystem and must stay silent when it is disabled'
    );

    // Without the doctor's exclusion, the SAME bead re-lanes and gets
    // re-dispatched every round the round cap allows -- the pre-fix
    // behavior this task replaces, preserved here as the explicit
    // doctor_enabled=false fallback rather than a silent behavior change.
    const attributionLines = result.logs.filter((m) => m.startsWith('Doer streak attribution'));
    assert.ok(
        attributionLines.length > 1,
        `expected the unchanged bead to be re-dispatched more than once with the doctor disabled, got ${attributionLines.length}`
    );
});
