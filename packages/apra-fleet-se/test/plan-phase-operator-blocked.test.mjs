import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPlanPhase } from '../fleet-sprint/phases/plan.mjs';
import { createRecordingCtx } from './helpers/dispatch-role-harness.mjs';
import { SprintBlockedOnOperatorError, SprintPlanRejectedError } from '../fleet-sprint/errors.mjs';

// The Plan phase driven directly (real dispatchRole engine over a recording
// ctx): a BLOCKED planner stops the loop and routes to a decision; contested
// beads held by an open decision bead are non-blocking; a genuine rejection
// is unchanged.

const NOTES = 'Planning needs the production region chosen by an operator before the DAG can be built.';

function fakeBd() {
    const commands = [];
    const command = async (cmd) => {
        commands.push(cmd);
        if (cmd.includes('rmSync')) return '';
        if (cmd.startsWith('node -e')) return `/tmp/staged-${commands.length}.txt`;
        if (cmd.startsWith('bd list')) return '[]';
        if (cmd.startsWith('bd create')) return 'x-dec\n';
        return '';
    };
    return { commands, command };
}

function harness({ responses, scope, decisionWait = null, sprintState = {}, allBeads = null }) {
    const { ctx, rec } = createRecordingCtx({ responses });
    const bd = fakeBd();
    const logs = [];
    const gitSync = {
        withOpenSyncBracket: async (fn) => fn(),
        syncBeadsAfter: async () => {},
        syncBeadsBefore: async () => {},
    };
    const run = () => runPlanPhase({
        phase: () => {}, log: (m) => logs.push(m), command: bd.command, dispatchCtx: ctx,
        cycle: 1, validated: { goal: 'P2', requirementsFile: null }, targetIssues: ['x-1'], requirementsContent: '',
        backlogMember: 'm', getMemberForRole: () => 'm',
        sprintState, gitSync, args: {},
        verifySetThisCycle: [], roundSessions: { resumeArgFor: () => false, record() {} },
        pendingRejectedNewTasks: [],
        resolveSettleShell: async () => '', parseBdJson: (raw) => JSON.parse(raw || '[]'),
        extractContestedBeadIds: (v) => (v && Array.isArray(v.taskAssignments)
            ? v.taskAssignments.map((a) => a.id).filter((id) => String(v.notes || '').includes(id)) : []),
        reconcilePendingRejectedNewTasks: (p) => p, stageCommandBodyMemberSide: async () => '/tmp/n.txt',
        updateDashboard: async () => {},
        bdListScoped: async () => scope.map((b) => ({ ...b })),
        decisionWait,
        fetchAllBeads: async () => (allBeads || scope).map((b) => ({ ...b })),
    });
    return { run, rec, bd, logs, sprintState };
}

const roleDispatches = (rec, name) => rec.dispatches.filter((d) => d.options && (d.options.agent === name || d.options.role === name)).length;
const SCOPE = [{ id: 'x-1', status: 'open', priority: 1, dependencies: [] }, { id: 'x-2', status: 'open', dependencies: [] }];
const blocked = JSON.stringify({ status: 'BLOCKED', notes: NOTES });
const changesNeeded = (ids, findings) => ({
    verdict: 'CHANGES_NEEDED', notes: `${ids.join(' ')} need work.`,
    taskAssignments: [{ id: 'x-1', bucket: 'S', model: 'standard' }, { id: 'x-2', bucket: 'S', model: 'standard' }, { id: 'x-3', bucket: 'S', model: 'standard' }],
    findings,
});

test('planner BLOCKED, no pause channel: one planner dispatch, one decision bead, typed blocked-on-operator error (never plan rejection)', async () => {
    const h = harness({ responses: [blocked, changesNeeded(['x-1'], [])], scope: SCOPE });
    await assert.rejects(h.run(), (err) => {
        assert.ok(err instanceof SprintBlockedOnOperatorError, `${err && err.constructor.name}: ${err && err.message}`);
        assert.ok(!(err instanceof SprintPlanRejectedError));
        assert.equal(err.question, NOTES);
        assert.equal(err.decisionBeadId, 'x-dec');
        assert.deepEqual(err.beadIds, ['x-1']);
        return true;
    });
    assert.equal(h.rec.dispatches.length, 1, 'exactly one dispatch: the planner; no reviewer, no re-plan');
    const creates = h.bd.commands.filter((c) => c.startsWith('bd create'));
    assert.equal(creates.length, 1);
    assert.ok(/ -t decision /.test(creates[0]) && / -s deferred /.test(creates[0]) && / -l human /.test(creates[0]), creates[0]);
});

test('planner BLOCKED with a pause channel: pauses on the answer, then plans again with the answer in the planner feedback', async () => {
    const waits = [];
    let pending = true;
    const decisionWait = {
        hasPending: () => pending,
        awaitAnswer: async (o) => { waits.push(o); pending = false; return [{ decisionId: 'd1', beadId: 'x-1', question: NOTES, answer: 'Use region eu-west.' }]; },
    };
    const ok = { verdict: 'APPROVED', notes: 'ok', taskAssignments: [] };
    const h = harness({ responses: [blocked, 'planned', ok], scope: SCOPE, decisionWait });
    const out = await h.run();
    assert.equal(waits.length, 1, 'paused once');
    assert.equal(h.bd.commands.filter((c) => c.startsWith('bd create')).length, 1, 'one decision bead');
    assert.equal(h.rec.dispatches.length, 3, 'planner (blocked), planner (after answer), plan-reviewer');
    assert.ok(h.rec.dispatches[1].prompt.includes('Use region eu-west.'), 'the answer reaches the planner feedback');
    assert.equal(out.lastVerdict.verdict, 'APPROVED');
});

test('last CHANGES_NEEDED whose contested beads are all held by an open decision bead proceeds (no plan rejection)', async () => {
    const scope = [
        { id: 'x-1', status: 'open', dependencies: [] },
        { id: 'x-2', status: 'open', dependencies: [] },
    ];
    // The decision bead is outside the scoped listing (a discovered-from edge is not walked).
    const allBeads = [...scope, { id: 'x-dec', status: 'deferred', issue_type: 'decision', labels: ['human'], dependencies: [{ depends_on_id: 'x-1', type: 'discovered-from' }] }];
    const verdict = changesNeeded(['x-1'], [{ id: 'x-1', kind: 'coverage', detail: 'held' }]);
    const h = harness({ responses: ['p1', verdict, 'p2', verdict, 'p3', verdict], scope, allBeads });
    const out = await h.run();
    assert.equal(out.planCapDeferredIds.length, 0);
    assert.ok(h.logs.some((l) => l.includes('held by an open operator decision')), h.logs.join('\n'));
});

test('genuine rejection (reviewer CHANGES_NEEDED on unheld beads for 3 rounds) still ends SPRINT_PLAN_REJECTED', async () => {
    const verdict = changesNeeded(['x-1', 'x-2', 'x-3'], [{ id: 'x-1', kind: 'coverage', detail: 'd' }]);
    const h = harness({ responses: ['p1', verdict, 'p2', verdict, 'p3', verdict], scope: SCOPE });
    await assert.rejects(h.run(), (err) => err instanceof SprintPlanRejectedError);
    assert.equal(h.rec.dispatches.length, 6);
});

test('planner BLOCKED that carries a decision while other work is unheld does not stop the cycle', async () => {
    const decision = { beadId: 'x-1', question: NOTES, options: [{ id: 'a', text: 'eu-west' }, { id: 'b', text: 'us-east' }], recommendation: 'a: closest to users' };
    const withDecision = JSON.stringify({ status: 'BLOCKED', notes: NOTES, decision });
    const ok = { verdict: 'APPROVED', notes: 'ok', taskAssignments: [] };
    const h = harness({ responses: [withDecision, ok], scope: SCOPE });
    const out = await h.run();
    assert.equal(out.lastVerdict.verdict, 'APPROVED', 'the plan went on to the reviewer instead of pausing');
    assert.equal(h.rec.dispatches.length, 2, 'planner, then plan-reviewer');
    assert.equal(h.bd.commands.filter((c) => c.startsWith('bd create')).length, 1, 'the decision is still filed once');
    assert.ok(h.logs.some((l) => l.includes('planning continues with the rest')), h.logs.join('\n'));
});
