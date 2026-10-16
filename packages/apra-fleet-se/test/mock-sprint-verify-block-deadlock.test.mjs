// =============================================================================
// GitHub #717: a task blocked only by verify-routed beads deadlocks when the
// Integration Test phase cannot run. The sprint must stop early with a named
// diagnosis (the bead ids and the exact fix), never PASS.
//
// Drives the REAL runner through the mock-sprint harness. DAG for every
// scenario: under the sprint epic, task T and bead B; B has one child C that is
// already closed (so B is verify-routed: childful, all children closed) and T
// is blocked by B (`bd dep add T B`).
//
//   1. No integ-test-playbook.md -> stops before any cycle with the diagnosis.
//   2. Playbook present, no deploy.md -> same.
//   3. Playbook and deploy.md present, the deploy fails -> the cycle loop exits
//      with the diagnosis; the verdict is FAIL even when Final Review says PASS.
//   4. Control: playbook + deploy succeed -> no early stop; integ closes B, T
//      becomes ready, closes, and the sprint can PASS.
//   5. Below-goal-priority T -> a warning only, no stop.
//
// Scenarios share one process, so dolt-sync's per-process memo is reset before
// each one.
// =============================================================================

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runCmd, runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import {
    invalidateSyncRemoteCache, clearLastSyncedTip, clearTipProbeFailures,
} from '../fleet-sprint/dolt-sync.mjs';
import { PRE_SPRINT_REFUSAL_REASONS } from '../fleet-sprint/errors.mjs';

beforeEach(() => {
    invalidateSyncRemoteCache();
    clearLastSyncedTip();
    clearTipProbeFailures();
});

const T_TITLE = 'Task: T blocked by a verify-routed bead';
const B_TITLE = 'Task: B implementation-complete parent';

/** Builds the verify-block shape; returns ids through `ids`. */
const buildShape = (ids, { writePlaybookOnly = false } = {}) => async ({ tempDir, tasks }) => {
    ids.t = tasks[0].id;
    ids.b = tasks[1].id;
    const created = await runCmd('bd create "Task: C child of B" -d "Already implemented." --silent', tempDir);
    ids.c = String(created.stdout || '').trim();
    assert.ok(ids.c, `child create must return an id: ${JSON.stringify(created)}`);
    await runCmd(`bd update ${ids.c} --parent ${ids.b}`, tempDir);
    await runCmd(`bd close ${ids.c}`, tempDir);
    await runCmd(`bd dep add ${ids.t} ${ids.b}`, tempDir);
    if (writePlaybookOnly) {
        await fs.writeFile(path.join(tempDir, 'integ-test-playbook.md'), '# Integ Test\nRun `vitest e2e`');
    }
};

const closeAssignedDoer = async ({ opts, tempDir }) => {
    const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    const assigned = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
    for (const id of assigned) await runCmd(`bd close ${id}`, tempDir);
    return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: assigned, notes: 'Closed all assigned beads.' }) }] };
};

const approvingReviewer = async () => ({
    content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Looks good.', reopenIds: [], newTasks: [] }) }],
});

const rubberStampPass = async () => ({
    content: [{ text: JSON.stringify({ verdict: 'PASS', notes: 'Rubber-stamp PASS from the final reviewer.' }) }],
});

const assertDiagnosis = (text, ids, fixPattern) => {
    assert.match(text, /Verify-block deadlock/);
    assert.ok(text.includes(ids.t), `diagnosis must name the blocked bead ${ids.t}: ${text}`);
    assert.ok(text.includes(ids.b), `diagnosis must name the verify-routed blocker ${ids.b}: ${text}`);
    assert.ok(text.includes(`bd dep remove ${ids.t} ${ids.b}`), `diagnosis must carry the exact dep-remove command: ${text}`);
    assert.match(text, fixPattern);
};

test('verify-block: no integ-test-playbook.md stops the sprint before any cycle, with the named fix', async () => {
    await withScenarioMarkers('verifyblocknoplaybook', async () => {
        const ids = {};
        const run = await runDevelopLoopScenario('verifyblocknoplaybook', {
            members: ['local'],
            taskSpecs: [{ title: T_TITLE }, { title: B_TITLE }],
            maxCycles: 3,
            beforeSprint: buildShape(ids),
            doerHandler: closeAssignedDoer,
            reviewerHandler: approvingReviewer,
            finalReviewHandler: rubberStampPass,
        });
        assert.ok(run.error, 'the sprint must stop, not run');
        assert.equal(run.error.reason, PRE_SPRINT_REFUSAL_REASONS.VERIFY_BLOCKED, `typed refusal expected: ${run.error.message}`);
        assertDiagnosis(run.error.message, ids, /add integ-test-playbook\.md/);
        assert.equal(run.result, null, 'a stopped sprint has no verdict, so it can never be PASS');
        // Bounded: no paid dispatch at all -- no planner, no doer, no cycle.
        assert.equal(run.dispatched.length, 0, `no dispatch may be paid for: ${JSON.stringify(run.dispatched.map((d) => d.agent))}`);
        assert.ok(!run.logs.some((l) => /Cycle 1/.test(l)), 'no cycle may start');
    });
});

test('verify-block: playbook without deploy.md stops the sprint before any cycle, with the named fix', async () => {
    await withScenarioMarkers('verifyblocknodeploy', async () => {
        const ids = {};
        const run = await runDevelopLoopScenario('verifyblocknodeploy', {
            members: ['local'],
            taskSpecs: [{ title: T_TITLE }, { title: B_TITLE }],
            maxCycles: 3,
            beforeSprint: buildShape(ids, { writePlaybookOnly: true }),
            doerHandler: closeAssignedDoer,
            reviewerHandler: approvingReviewer,
            finalReviewHandler: rubberStampPass,
        });
        assert.ok(run.error, 'the sprint must stop, not run');
        assert.equal(run.error.reason, PRE_SPRINT_REFUSAL_REASONS.VERIFY_BLOCKED, `typed refusal expected: ${run.error.message}`);
        assertDiagnosis(run.error.message, ids, /add deploy\.md/);
        assert.equal(run.result, null);
        assert.equal(run.dispatched.length, 0, `no dispatch may be paid for: ${JSON.stringify(run.dispatched.map((d) => d.agent))}`);
    });
});

test('verify-block: a failed deploy exits the cycle loop with the diagnosis and the verdict is FAIL, never PASS', async () => {
    await withScenarioMarkers('verifyblockdeployfail', async () => {
        const ids = {};
        let deployCalls = 0;
        const run = await runDevelopLoopScenario('verifyblockdeployfail', {
            members: ['local'],
            taskSpecs: [{ title: T_TITLE }, { title: B_TITLE }],
            maxCycles: 3,
            withRunbooks: true,
            beforeSprint: buildShape(ids),
            doerHandler: closeAssignedDoer,
            reviewerHandler: approvingReviewer,
            deployHandler: async () => {
                deployCalls++;
                return { content: [{ text: JSON.stringify({ deployed: false, notes: 'sandbox port 4100 unreachable' }) }] };
            },
            finalReviewHandler: rubberStampPass,
        });
        assert.ok(!run.error, `the sprint finishes (FAIL), it does not throw: ${run.error && run.error.message}`);
        assert.equal(run.result.verdict, 'FAIL', `never PASS: ${JSON.stringify(run.result)}`);
        assertDiagnosis(run.result.notes, ids, /fix the failing deploy/);
        assert.ok(run.result.notes.includes('sandbox port 4100 unreachable'), 'the deploy notes reach the diagnosis');
        assert.ok(run.logs.some((l) => /^Cycle 1: Verify-block deadlock/.test(l) && /Exiting cycle loop/.test(l)),
            `expected the C1 exit, logs: ${JSON.stringify(run.logs.filter((l) => /Cycle|deadlock/.test(l)))}`);
        assert.equal(deployCalls, 1, 'one cycle, one deploy: the loop does not grind on');
        assert.equal(run.dispatched.filter((d) => d.agent === 'integ-test-runner').length, 0);
    });
});

test('verify-block: control -- playbook and a successful deploy run integ, which unblocks T; no early stop', async () => {
    await withScenarioMarkers('verifyblockcontrol', async () => {
        const ids = {};
        const run = await runDevelopLoopScenario('verifyblockcontrol', {
            members: ['local'],
            taskSpecs: [{ title: T_TITLE }, { title: B_TITLE }],
            maxCycles: 3,
            withRunbooks: true,
            beforeSprint: buildShape(ids),
            doerHandler: closeAssignedDoer,
            reviewerHandler: approvingReviewer,
        });
        assert.ok(!run.error, `scenario must not throw: ${run.error && run.error.message}`);
        assert.ok(!run.logs.some((l) => /Verify-block deadlock/.test(l)), 'no deadlock diagnosis when integ can run');
        assert.equal(run.finalBeadsById.get(ids.b).status, 'closed', 'integ verifies and closes B');
        assert.equal(run.finalBeadsById.get(ids.t).status, 'closed', 'T becomes ready once B closes, and closes');
        assert.equal(run.result.verdict, 'PASS', JSON.stringify(run.result));
    });
});

test('verify-block: a below-goal-priority T only warns -- the sprint is not stopped for it', async () => {
    await withScenarioMarkers('verifyblockbelowgoal', async () => {
        const ids = {};
        const run = await runDevelopLoopScenario('verifyblockbelowgoal', {
            members: ['local'],
            taskSpecs: [{ title: T_TITLE, priority: 'P3' }, { title: B_TITLE }],
            maxCycles: 1,
            beforeSprint: buildShape(ids),
            doerHandler: closeAssignedDoer,
            reviewerHandler: approvingReviewer,
        });
        assert.ok(!run.error || run.error.reason !== PRE_SPRINT_REFUSAL_REASONS.VERIFY_BLOCKED,
            `a below-goal bead must never stop the sprint: ${run.error && run.error.message}`);
        const warning = run.logs.find((l) => /^Pre-sprint validation: WARNING -- Verify-block deadlock/.test(l));
        assert.ok(warning, `expected the pre-sprint warning, logs: ${JSON.stringify(run.logs.filter((l) => /Pre-sprint/.test(l)))}`);
        assertDiagnosis(warning, ids, /add integ-test-playbook\.md/);
        assert.match(warning, /below goal priority/);
        assert.ok(run.logs.some((l) => /Sprint Cycle 1|Route C1|Cycle 1/.test(l)) || run.dispatched.length > 0,
            'the sprint proceeds into its cycle');
    });
});

test('verify-block helpers: integCanRun, goal partition by Pn token, blocked-shape detection', async () => {
    const { integCanRun, integBlockCause, partitionByGoal, findVerifyBlockedBeads } = await import('../fleet-sprint/verify-block.mjs');
    assert.equal(integCanRun({ hasPlaybook: true, hasDeploy: true }), true, 'deploy not attempted yet');
    assert.equal(integCanRun({ hasPlaybook: true, hasDeploy: true, deployAttempted: true, deployedThisCycle: true }), true);
    assert.equal(integCanRun({ hasPlaybook: true, hasDeploy: true, deployAttempted: true, deployedThisCycle: false }), false);
    assert.equal(integCanRun({ hasPlaybook: false, hasDeploy: true }), false);
    assert.equal(integCanRun({ hasPlaybook: true, hasDeploy: false }), false);
    assert.equal(integBlockCause({ hasPlaybook: false, hasDeploy: false }), 'no-playbook');
    assert.equal(integBlockCause({ hasPlaybook: true, hasDeploy: false }), 'no-deploy');
    assert.equal(integBlockCause({ hasPlaybook: true, hasDeploy: true, deployAttempted: true }), 'deploy-failed');

    // goalPriorityMax() returns a 'Pn' token: a P2 bead is at goal for 'P2'.
    const { atGoal, belowGoal } = partitionByGoal([{ id: 'a', priority: 2 }, { id: 'b', priority: 3 }], 'P2');
    assert.deepEqual(atGoal.map((b) => b.id), ['a']);
    assert.deepEqual(belowGoal.map((b) => b.id), ['b']);
    assert.throws(() => partitionByGoal([], 'high'), /Pn/);

    const all = [
        { id: 'T', status: 'open', dependencies: [{ type: 'blocks', depends_on_id: 'B' }] },
        { id: 'U', status: 'open', dependencies: [{ type: 'blocks', depends_on_id: 'B' }, { type: 'blocks', depends_on_id: 'X' }] },
        { id: 'V', status: 'open', dependencies: [{ type: 'blocks', depends_on_id: 'Done' }] },
        { id: 'B', status: 'open' }, { id: 'X', status: 'open' }, { id: 'Done', status: 'closed' },
    ];
    // U also waits on a non-verify bead X, and V waits on nothing open: only T is the deadlock shape.
    assert.deepEqual(findVerifyBlockedBeads(all, all, ['B']).map((b) => b.id), ['T']);
    assert.deepEqual(findVerifyBlockedBeads(all, all, []), []);
});
