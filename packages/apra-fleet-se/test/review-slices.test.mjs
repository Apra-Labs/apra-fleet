import { test } from 'node:test';
import assert from 'node:assert/strict';
import { areaOf, buildReviewSlices, sliceFocus, crossCuttingFocus, mergeVerdicts } from '../fleet-sprint/review-slices.mjs';

test('files group by leading directories', () => {
    assert.equal(areaOf('README.md'), '(root)');
    assert.equal(areaOf('src/a.ts'), 'src');
    assert.equal(areaOf('src/components/Button.tsx'), 'src/components');
    assert.equal(areaOf('src/components/deep/x.tsx'), 'src/components');
});

test('slices balance areas and never split an area', () => {
    const files = [
        'src/ui/a.ts', 'src/ui/b.ts', 'src/ui/c.ts',
        'src/api/x.ts', 'src/api/y.ts',
        'docs/guide.md', 'README.md',
    ];
    const slices = buildReviewSlices(files, 3);
    assert.equal(slices.length, 3);
    assert.deepEqual(slices.map((s) => s.files.length).sort(), [2, 2, 3]);
    const all = slices.flatMap((s) => s.files).sort();
    assert.deepEqual(all, [...files].sort(), 'every file reviewed exactly once');
    for (const s of slices) {
        for (const a of s.areas) assert.ok(s.files.every((f) => areaOf(f) !== a || s.areas.includes(a)));
    }
    assert.deepEqual(buildReviewSlices(['src/a.ts', 'src/b.ts'], 4), [], 'one area is one review');
    assert.deepEqual(buildReviewSlices(files, 1), []);
    assert.deepEqual(buildReviewSlices([], 3), []);
});

test('reviewers are told their slice, the cross reviewer is told to look across', () => {
    const slices = buildReviewSlices(['src/ui/a.ts', 'src/api/b.ts'], 2);
    assert.match(sliceFocus(slices[0], 0, 2), /REVIEW SLICE 1 OF 2/);
    assert.match(sliceFocus(slices[0], 0, 2), /src\/(ui|api)\//);
    assert.match(crossCuttingFocus(slices), /Look only ACROSS areas/);
});

test('merged verdict approves only when every reviewer approves, findings deduplicated', () => {
    const ok = { verdict: 'APPROVED', notes: 'fine', reopenIds: [], newTasks: [] };
    const bad = { verdict: 'CHANGES_NEEDED', notes: 'fix x', reopenIds: ['t1', { id: 't2' }], newTasks: [{ title: 'Add tests', description: 'd' }] };
    const bad2 = { verdict: 'CHANGES_NEEDED', notes: 'fix y', reopenIds: ['t1'], newTasks: [{ title: 'add tests', description: 'd2' }] };
    assert.equal(mergeVerdicts([ok, ok]).verdict, 'APPROVED');
    const m = mergeVerdicts([ok, bad, bad2]);
    assert.equal(m.verdict, 'CHANGES_NEEDED');
    assert.deepEqual(m.reopenIds, ['t1', { id: 't2' }]);
    assert.equal(m.newTasks.length, 1);
    assert.match(m.notes, /Reviewer 2: fix x/);
    assert.equal(mergeVerdicts([]).verdict, 'CHANGES_NEEDED', 'no verdicts is never an approval');
});

import { runReReviewPhase } from '../fleet-sprint/phases/re-review.mjs';

function reReviewDeps(overrides) {
    return {
        phase: () => {}, log: () => {}, command: async () => '',
        cycle: 1, validated: { goal: 'P1/P2' }, targetIssues: ['root'], orchestratorMember: 'h0',
        gitSync: { syncBeadsAfter: async () => {} },
        rejectedNewTasks: [], lastReviewVerdict: null, reviewedThisCycle: false, pendingRejectedNewTasks: [],
        bdListScoped: async () => [], goalMax: 2, recordReopen: () => {},
        childIdAllocator: null, sprintMutexId: 's', computeChildFloor: async () => 0,
        createChildBeadWithAllocatedId: async () => {}, trackRejectedNewTaskForResurfacing: (l) => l, clearResubmittedNewTask: (l) => l,
        ...overrides,
    };
}

test('pipeline Re-Review runs one reviewer per slice plus one across, at the same time', async () => {
    const calls = [];
    let inFlight = 0;
    let peak = 0;
    const slices = buildReviewSlices(['src/ui/a.ts', 'src/api/b.ts', 'docs/c.md'], 3);
    const res = await runReReviewPhase(reReviewDeps({
        planReviewSlices: async () => ({ slices, members: ['h0', 'h1', 'h2', 'h3'] }),
        dispatchReview: async (opts) => {
            calls.push(opts);
            inFlight += 1; peak = Math.max(peak, inFlight);
            await new Promise((r) => setTimeout(r, 20));
            inFlight -= 1;
            return { verdict: 'APPROVED', notes: 'ok', reopenIds: [], newTasks: [] };
        },
    }));
    assert.equal(calls.length, 4);
    assert.equal(peak, 4, 'all reviewers ran at once');
    assert.deepEqual(calls.map((c) => c.member), ['h0', 'h1', 'h2', 'h3']);
    assert.match(calls[3].focus, /CROSS-AREA REVIEW/);
    assert.equal(res.lastReviewVerdict, 'APPROVED');
    assert.equal(res.reviewedThisCycle, true);
});

test('a failing slice falls back to one full review; no plan means one review', async () => {
    const calls = [];
    const slices = buildReviewSlices(['src/ui/a.ts', 'src/api/b.ts'], 2);
    const res = await runReReviewPhase(reReviewDeps({
        planReviewSlices: async () => ({ slices, members: ['h0', 'h1', 'h2'] }),
        dispatchReview: async (opts) => {
            calls.push(opts);
            if (opts.member === 'h1') throw new Error('reviewer crashed');
            return { verdict: opts.member ? 'APPROVED' : 'CHANGES_NEEDED', notes: 'n', reopenIds: [], newTasks: [{ title: 'Fix it', description: 'x', priority: 1 }] };
        },
    }));
    assert.equal(calls.at(-1).member, undefined, 'the fallback is the ordinary full review');
    assert.equal(res.lastReviewVerdict, 'CHANGES_NEEDED');

    const single = [];
    await runReReviewPhase(reReviewDeps({
        planReviewSlices: async () => null,
        dispatchReview: async (opts) => { single.push(opts); return { verdict: 'APPROVED', notes: '', reopenIds: [], newTasks: [] }; },
    }));
    assert.equal(single.length, 1);
    assert.equal(single[0].member, undefined);
});

import { planReviewSlicesFor } from '../fleet-sprint/review-slices.mjs';

test('planning slices reads the sprint diff and moves each reviewer onto the sprint branch', async () => {
    const cmds = [];
    const command = async (cmd, opts) => {
        cmds.push([opts.member_name, cmd]);
        if (cmd.startsWith('git diff --name-only')) return { ok: true, output: 'src/ui/a.ts\nsrc/api/b.ts\ndocs/c.md\n' };
        return { ok: true, output: '' };
    };
    const plan = await planReviewSlicesFor({ command, validated: { baseBranch: 'main', branch: 'feat/s' }, orchestratorMember: 'h0', members: ['h0', 'h1', 'h2', 'h3'] });
    assert.equal(plan.slices.length, 3);
    assert.deepEqual(plan.members, ['h0', 'h1', 'h2', 'h3']);
    assert.ok(cmds.some(([m, c]) => m === 'h0' && c === 'git diff --name-only origin/main...feat/s'));
    for (const m of ['h1', 'h2', 'h3']) assert.ok(cmds.some(([mm, c]) => mm === m && c === 'git checkout -B feat/s origin/feat/s'));
    assert.equal(await planReviewSlicesFor({ command, validated: { baseBranch: 'main', branch: 'feat/s' }, orchestratorMember: 'h0', members: ['h0', 'h1'] }), null);
});
