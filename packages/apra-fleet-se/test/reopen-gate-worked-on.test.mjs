import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    applyGuardedReopens, isDeferredScopeReopen, buildReopenAllowlist, parseIdWithReasonEntry,
    isReviewerContractViolation, needsRedBranchFixTask, ensureRedBranchFixTask,
    buildRedBranchFixTask, isInGoalPriority, RED_BRANCH_FIX_TITLE,
} from '../fleet-sprint/beads-transitions.mjs';
import { runReviewPhase } from '../fleet-sprint/phases/review.mjs';

// =============================================================================
// Reviewer reopens of below-goal beads THIS sprint already worked on must be
// applied, not deferred; and a red branch at review must always leave an
// in-goal fix task behind.
//
// Live failure this pins: a reviewer found the test suite red from the
// sprint's own commits and asked to reopen three P3 beads the sprint had
// dispatched in round 1 of a P1/P2 sprint. The goal-scope guard skipped all
// three on priority alone ("below this sprint's goal ... deferred scope"), so
// nothing ever fixed the red branch.
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOAL = 'P1/P2';

const SCOPE = [
    { id: 'in-goal', priority: 1, status: 'closed' },
    { id: 'worked-p3', priority: 3, status: 'closed' },
    { id: 'untouched-p3', priority: 3, status: 'open' },
    { id: 'no-priority', status: 'closed' },
];

function harness({ scope = SCOPE, scopeThrows = false } = {}) {
    const logs = [];
    const commands = [];
    return {
        logs, commands,
        log: (m) => logs.push(m),
        bdListScoped: async () => {
            if (scopeThrows) throw new Error('scope lookup failed (simulated)');
            return scope;
        },
        command: async (cmd, opts) => { commands.push({ cmd, opts }); return ''; },
        updatedIds: () => commands.map((c) => /^bd update (\S+)/.exec(c.cmd)[1]),
    };
}

// The three verdict sites as their phase modules configure them.
const SITES = [
    {
        name: 'per-round Review',
        logPrefix: 'Reviewer reopenIds',
        entries: ['worked-p3', 'untouched-p3'],
        opts: { buildReopenCommand: ({ id }) => ({ cmd: `bd update ${id} --status=open`, label: `Reopen ${id}` }) },
    },
    {
        name: 'Final Review',
        logPrefix: 'Final Review reopenIds',
        entries: [{ id: 'worked-p3', reason: 'broke the tests' }, { id: 'untouched-p3', reason: 'nice to have' }],
        opts: {
            parseEntry: parseIdWithReasonEntry,
            buildReopenCommand: ({ id, reason }) => ({ cmd: `bd update ${id} --status=open --append-notes "${reason}"`, label: `Reopen ${id}` }),
        },
    },
    {
        name: 'Re-Review',
        logPrefix: 'Re-review reopenIds',
        entries: ['worked-p3', 'untouched-p3'],
        opts: { buildReopenCommand: ({ id }) => ({ cmd: `bd update ${id} --status=open`, label: `Reopen ${id}` }) },
    },
];

describe('reopen goal gate: beads this sprint worked on are exempt', () => {
    for (const site of SITES) {
        for (const workedOnForm of [new Set(['worked-p3']), ['worked-p3']]) {
            test(`${site.name}: a below-goal bead the sprint worked on is reopened; an untouched one is still skipped (workedOnIds as ${workedOnForm instanceof Set ? 'Set' : 'array'})`, async () => {
                const h = harness();
                const reopened = await applyGuardedReopens({
                    entries: site.entries, bdListScoped: h.bdListScoped, goalMax: 'P2', goal: GOAL,
                    log: h.log, command: h.command, member: 'm', logPrefix: site.logPrefix,
                    workedOnIds: workedOnForm, ...site.opts,
                });
                assert.deepEqual(reopened, ['worked-p3']);
                assert.deepEqual(h.updatedIds(), ['worked-p3'], 'only the worked-on bead gets a bd update');
                // REGRESSION: the untouched below-goal bead keeps the exact
                // pre-existing skip text.
                assert.ok(h.logs.includes(
                    `${site.logPrefix}: SKIPPED 'untouched-p3' (priority P3 is below this sprint's goal ${GOAL} -- deferred scope, not reopened).`
                ), `missing the verbatim skip line; got ${JSON.stringify(h.logs)}`);
                // The kept bead is logged with WHY it was kept, never as SKIPPED.
                assert.ok(h.logs.some((l) => l.startsWith(`${site.logPrefix}: KEPT 'worked-p3'`) && l.includes('already dispatched or closed')));
                assert.ok(!h.logs.some((l) => l.includes("SKIPPED 'worked-p3'")));
            });
        }
    }

    test('without workedOnIds the guard behaves exactly as before (both P3 beads skipped)', async () => {
        const h = harness();
        const reopened = await applyGuardedReopens({
            entries: ['in-goal', 'worked-p3', 'untouched-p3'], bdListScoped: h.bdListScoped, goalMax: 'P2', goal: GOAL,
            log: h.log, command: h.command, member: 'm', logPrefix: 'Reviewer reopenIds',
            buildReopenCommand: ({ id }) => ({ cmd: `bd update ${id} --status=open`, label: 'x' }),
        });
        assert.deepEqual(reopened, ['in-goal']);
        assert.equal(h.logs.filter((l) => l.includes('deferred scope, not reopened')).length, 2);
    });

    test('FAIL OPEN still holds: a null allowlist never skips, with or without workedOnIds', async () => {
        const h = harness({ scopeThrows: true });
        const reopened = await applyGuardedReopens({
            entries: ['worked-p3', 'untouched-p3'], bdListScoped: h.bdListScoped, goalMax: 'P2', goal: GOAL,
            log: h.log, command: h.command, member: 'm', logPrefix: 'Reviewer reopenIds',
            workedOnIds: new Set(['worked-p3']),
            buildReopenCommand: ({ id }) => ({ cmd: `bd update ${id} --status=open`, label: 'x' }),
        });
        assert.deepEqual(reopened, ['worked-p3', 'untouched-p3']);
    });

    test('isDeferredScopeReopen reports belowGoal/workedOn and defers only an untouched below-goal bead', async () => {
        const allowlist = await buildReopenAllowlist(async () => SCOPE);
        const worked = new Set(['worked-p3']);
        assert.deepEqual(isDeferredScopeReopen(allowlist, 'worked-p3', 'P2', worked),
            { deferred: false, priority: 3, belowGoal: true, workedOn: true });
        assert.deepEqual(isDeferredScopeReopen(allowlist, 'untouched-p3', 'P2', worked),
            { deferred: true, priority: 3, belowGoal: true, workedOn: false });
        assert.equal(isDeferredScopeReopen(allowlist, 'no-priority', 2, worked).deferred, false);
        assert.equal(isDeferredScopeReopen(null, 'untouched-p3', 2, worked).deferred, false);
        assert.equal(isDeferredScopeReopen(allowlist, 'untouched-p3', 2).deferred, true, 'no worked-on set: historical behaviour');
    });
});

describe('reopen goal gate: every verdict site is wired with the worked-on set', () => {
    const read = (rel) => fs.readFileSync(path.join(__dirname, '../fleet-sprint', rel), 'utf8');
    for (const [file, prefix] of [
        ['phases/review.mjs', 'Reviewer reopenIds'],
        ['phases/final-review.mjs', 'Final Review reopenIds'],
        ['phases/re-review.mjs', 'Re-review reopenIds'],
    ]) {
        test(`${file} passes workedOnIds into its applyGuardedReopens call`, () => {
            const src = read(file);
            const at = src.indexOf(`logPrefix: '${prefix}'`);
            const callAt = src.lastIndexOf('applyGuardedReopens({', at);
            assert.ok(callAt > 0 && at > callAt);
            assert.match(src.slice(callAt, at), /\bworkedOnIds\b/, `${file}: the guarded reopen call must receive workedOnIds`);
            assert.match(src, /^\s+workedOnIds,$/m, `${file}: the phase must accept workedOnIds in its state argument`);
        });
    }

    test('runner.js records every dispatched bead and hands the set to Review, Re-Review and Final Review', () => {
        const src = read('runner.js');
        assert.match(src, /const workedOnBeadIds = new Set\(\);/);
        assert.match(src, /for \(const o of streakOutcomes\) \{\s*for \(const id of \(o\.beadIds \|\| \[\]\)\) workedOnBeadIds\.add\(id\);/);
        for (const phaseFn of ['runReviewPhase', 'runReReviewPhase', 'runFinalReviewPhase']) {
            const at = src.indexOf(`await ${phaseFn}({`);
            assert.ok(at > 0, `${phaseFn} call not found`);
            const end = src.indexOf('});', at);
            assert.match(src.slice(at, end), /workedOnIds: workedOnBeadIds/, `${phaseFn} must receive the worked-on set`);
        }
    });
});

describe('red branch: always a fix dispatch', () => {
    test('needsRedBranchFixTask fires only on CHANGES_NEEDED + buildFailing with nothing actionable left', () => {
        const red = { verdict: 'CHANGES_NEEDED', buildFailing: true };
        assert.equal(needsRedBranchFixTask({ verdict: red, reopenedCount: 0, inGoalNewTaskCount: 0 }), true);
        assert.equal(needsRedBranchFixTask({ verdict: red, reopenedCount: 1, inGoalNewTaskCount: 0 }), false);
        assert.equal(needsRedBranchFixTask({ verdict: red, reopenedCount: 0, inGoalNewTaskCount: 1 }), false);
        assert.equal(needsRedBranchFixTask({ verdict: { verdict: 'CHANGES_NEEDED' }, reopenedCount: 0, inGoalNewTaskCount: 0 }), false);
        assert.equal(needsRedBranchFixTask({ verdict: { verdict: 'APPROVED', buildFailing: true }, reopenedCount: 0, inGoalNewTaskCount: 0 }), false);
    });

    test('a buildFailing verdict naming nothing is NOT a contract violation (it is actionable)', () => {
        assert.equal(isReviewerContractViolation({ verdict: 'CHANGES_NEEDED', reopenIds: [], newTasks: [] }), true);
        assert.equal(isReviewerContractViolation({ verdict: 'CHANGES_NEEDED', reopenIds: [], newTasks: [], buildFailing: true }), false);
    });

    test('isInGoalPriority / buildRedBranchFixTask pick an in-goal priority and carry the notes as ASCII', () => {
        assert.equal(isInGoalPriority('P2', 'P2'), true);
        assert.equal(isInGoalPriority('P3', 'P2'), false);
        assert.equal(isInGoalPriority('junk', 'P2'), false);
        const t = buildRedBranchFixTask({ goal: 'P1/P2', notes: 'npm test: 3 failures — see foo.test', site: 'Review C1 R2', skippedReopenIds: ['untouched-p3'] });
        assert.equal(t.title, RED_BRANCH_FIX_TITLE);
        assert.equal(t.priority, 'P1');
        assert.match(t.description, /npm test: 3 failures \? see foo\.test/);
        assert.match(t.description, /untouched-p3/);
        assert.match(t.description, /^[\t\n\r\x20-\x7E]+$/);
    });

    test('ensureRedBranchFixTask does not file a second task while one is still open', async () => {
        const logs = [];
        let created = 0;
        const result = await ensureRedBranchFixTask({
            verdict: { verdict: 'CHANGES_NEEDED', buildFailing: true, notes: 'red' },
            reopenedCount: 0, inGoalNewTaskCount: 0, goal: GOAL, site: 'Review C1 R2',
            bdListScoped: async () => [{ id: 'fix-1', title: RED_BRANCH_FIX_TITLE, status: 'open' }],
            createTask: async () => { created += 1; return true; },
            log: (m) => logs.push(m),
        });
        assert.equal(result, 'exists');
        assert.equal(created, 0);
        assert.ok(logs.some((l) => l.includes('fix-1')));
    });
});

// ---------------------------------------------------------------------------
// Review phase unit test: a tiny in-memory beads store stands in for bd.
// ---------------------------------------------------------------------------

function reviewPhaseHarness({ verdict, scope, workedOnIds }) {
    const store = scope.map((b) => ({ ...b }));
    const logs = [];
    let nextChild = 1;
    const command = async (cmd) => {
        const m = /^bd update (\S+) --status=open/.exec(cmd);
        if (m) {
            const b = store.find((x) => x.id === m[1]);
            if (b) b.status = 'open';
        }
        if (cmd.startsWith('bd show')) return '[]';
        return '';
    };
    const state = {
        phase: () => {}, log: (m) => logs.push(m), command,
        cycle: 1, validated: { goal: GOAL }, targetIssues: ['epic'], backlogMember: 'orch',
        gitSync: { syncBeadsAfter: async () => {} },
        replanIds: new Set(), replannedThisCycle: new Set(), perBeadFeedback: new Map(), rejectedNewTasks: [],
        devRounds: 1,
        streakOutcomes: [{ beadIds: ['in-goal-task'], outcome: 'success' }],
        readyTitleById: new Map(),
        lastReviewVerdict: undefined, reviewedThisCycle: false, pendingRejectedNewTasks: [],
        dispatchReview: async () => verdict,
        bdListScoped: async () => store.map((b) => ({ ...b })),
        goalMax: 'P2',
        workedOnIds,
        recordReopen: () => {},
        childIdAllocator: null, sprintMutexId: 's1',
        computeChildFloor: async () => 0,
        createChildBeadWithAllocatedId: async ({ title, description, priority, parentId }) => {
            const childId = `epic.${nextChild++}`;
            store.push({ id: childId, title, description, priority: Number(priority.slice(1)), parent: parentId, status: 'open', issue_type: 'task' });
            return { childId };
        },
        trackRejectedNewTaskForResurfacing: (list) => list,
        clearResubmittedNewTask: (list) => list,
    };
    return { state, store, logs };
}

const REVIEW_SCOPE = [
    { id: 'epic', priority: 1, status: 'open', issue_type: 'epic' },
    { id: 'in-goal-task', priority: 1, status: 'closed', parent: 'epic', issue_type: 'task' },
    { id: 'worked-p3', priority: 3, status: 'closed', issue_type: 'task' },
    { id: 'untouched-p3', priority: 3, status: 'closed', issue_type: 'task' },
];

const openInGoalTasks = (store) => store.filter((b) => b.status === 'open' && b.issue_type === 'task' && b.priority <= 2);

describe('Review phase: a red branch is never left with zero open work', () => {
    test('CHANGES_NEEDED + failing tests whose reopens were all filtered -> an open, dispatchable in-goal fix task exists', async () => {
        const verdict = { verdict: 'CHANGES_NEEDED', buildFailing: true, notes: 'npm test fails: 3 errors', reopenIds: ['untouched-p3'], newTasks: [] };
        const { state, store, logs } = reviewPhaseHarness({ verdict, scope: REVIEW_SCOPE, workedOnIds: new Set(['in-goal-task']) });
        await runReviewPhase(state);

        assert.equal(store.find((b) => b.id === 'untouched-p3').status, 'closed', 'the untouched below-goal reopen stays filtered');
        const fix = openInGoalTasks(store);
        assert.equal(fix.length, 1, `expected exactly one open in-goal task; store=${JSON.stringify(store)}`);
        assert.equal(fix[0].title, RED_BRANCH_FIX_TITLE);
        assert.equal(fix[0].parent, 'epic', 'filed under the sprint target so it is in scope');
        assert.match(fix[0].description, /npm test fails: 3 errors/);
        assert.ok(logs.some((l) => l.includes('filed in-goal red-branch fix task epic.1')), JSON.stringify(logs));
    });

    test('CHANGES_NEEDED + failing tests naming NO reopens at all -> still a fix task', async () => {
        const verdict = { verdict: 'CHANGES_NEEDED', buildFailing: true, notes: 'build broken', reopenIds: [], newTasks: [] };
        const { state, store } = reviewPhaseHarness({ verdict, scope: REVIEW_SCOPE, workedOnIds: new Set() });
        await runReviewPhase(state);
        assert.equal(openInGoalTasks(store).length, 1);
    });

    test('a reopen of a below-goal bead the sprint worked on is applied, and no extra fix task is filed', async () => {
        const verdict = { verdict: 'CHANGES_NEEDED', buildFailing: true, notes: 'worked-p3 broke the tests', reopenIds: ['worked-p3'], newTasks: [] };
        const { state, store, logs } = reviewPhaseHarness({ verdict, scope: REVIEW_SCOPE, workedOnIds: new Set(['worked-p3']) });
        await runReviewPhase(state);
        assert.equal(store.find((b) => b.id === 'worked-p3').status, 'open');
        assert.equal(store.filter((b) => b.title === RED_BRANCH_FIX_TITLE).length, 0);
        assert.ok(!logs.some((l) => l.includes("SKIPPED 'worked-p3'")));
        assert.equal(state.perBeadFeedback.get('worked-p3'), 'worked-p3 broke the tests', 'the reviewer notes are routed to the reopened bead');
    });

    test('a green-branch CHANGES_NEEDED (no buildFailing) whose reopens were all filtered files nothing', async () => {
        const verdict = { verdict: 'CHANGES_NEEDED', notes: 'P3 polish', reopenIds: ['untouched-p3'], newTasks: [] };
        const { state, store } = reviewPhaseHarness({ verdict, scope: REVIEW_SCOPE, workedOnIds: new Set() });
        await runReviewPhase(state);
        assert.equal(store.filter((b) => b.title === RED_BRANCH_FIX_TITLE).length, 0,
            'deferred scope stays deferred when the branch is not red');
    });
});
