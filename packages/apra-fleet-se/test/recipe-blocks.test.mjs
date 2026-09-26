import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRecipeBlocks, commandFailureTask, outputTail } from '../fleet-sprint/phases/recipe-blocks.mjs';
import { normalizeRecipe } from '../fleet-sprint/recipe.mjs';
import { validateNewTask } from '../fleet-sprint/abort.mjs';

// =============================================================================
// A sprint design's custom blocks (phases/recipe-blocks.mjs) against fakes:
// what each kind dispatches, and what its failure turns into.
// =============================================================================

function harness({ commandResult = { ok: true, output: '' }, verdict = { verdict: 'APPROVED', notes: '', reopenIds: [], newTasks: [] } } = {}) {
    const calls = { commands: [], reviews: [], creates: [], reopens: [], phases: [], logs: [], syncs: [], dispatches: [] };
    const deps = {
        cycle: 1,
        phase: (p) => calls.phases.push(p),
        log: (m) => calls.logs.push(m),
        command: async (cmd, opts) => {
            calls.commands.push({ cmd, member: opts.member_name });
            if (/^bd list/.test(cmd) || /^bd show/.test(cmd)) return '[]';
            if (/^bd update .* --status=open/.test(cmd)) { calls.reopens.push(cmd); return { ok: true, output: '' }; }
            if (/^git /.test(cmd)) return { ok: true, output: '' };
            return commandResult;
        },
        dispatchCtx: {},
        validated: { branch: 'feat/x', goal: 'P1/P2' },
        targetIssues: ['e1'],
        orchestratorMember: 'h0',
        doerPool: ['h1'],
        reviewer: 'h1',
        gitSync: {
            withGitSync: async (member, pushCode, fn) => { calls.syncs.push({ member, pushCode }); return fn(); },
            syncBeadsBefore: async () => {},
            syncBeadsAfter: async () => {},
        },
        dispatchReview: async (opts) => { calls.reviews.push(opts); return verdict; },
        bdListScoped: async () => [{ id: 't1', priority: 1, status: 'closed' }],
        updateDashboard: async () => {},
        transitions: {
            rejectedNewTasks: [], pendingRejectedNewTasks: [], goalMax: 2, recordReopen: () => {},
            childIdAllocator: null, sprintMutexId: 's',
            computeChildFloor: async () => 0,
            createChildBeadWithAllocatedId: async (o) => { calls.creates.push(o); },
            trackRejectedNewTaskForResurfacing: (list) => list,
            clearResubmittedNewTask: (list) => list,
        },
    };
    return { calls, deps };
}

test('a passing command block files nothing', async () => {
    const { calls, deps } = harness();
    const recipe = normalizeRecipe({ blocks: [{ kind: 'command', name: 'Lint', command: 'npm run lint' }] });
    const out = await runRecipeBlocks({ ...deps, slot: 'after-build', recipe });
    assert.equal(out.ran, 1);
    assert.deepEqual(calls.phases, ['Block: Lint C1']);
    assert.ok(calls.commands.some((c) => c.cmd === 'npm run lint' && c.member === 'h0'));
    assert.deepEqual(calls.syncs, [{ member: 'h0', pushCode: false }], 'read-side bracket only');
    assert.equal(calls.creates.length, 0);
});

test('a failing command block files a task with the output', async () => {
    const { calls, deps } = harness({ commandResult: { ok: false, output: 'FAIL 3 tests\n' } });
    const recipe = normalizeRecipe({ blocks: [{ kind: 'command', name: 'Unit tests', command: 'npm test' }] });
    await runRecipeBlocks({ ...deps, slot: 'after-build', recipe });
    assert.equal(calls.creates.length, 1);
    assert.equal(calls.creates[0].title, 'Fix: Unit tests failed');
    assert.match(calls.creates[0].description, /FAIL 3 tests/);
    assert.equal(calls.creates[0].parentId, 'e1');
});

test('onFail ignore keeps a failing command as a log line', async () => {
    const { calls, deps } = harness({ commandResult: { ok: false, output: 'nope' } });
    const recipe = normalizeRecipe({ blocks: [{ kind: 'command', name: 'Bench', command: 'npm run bench', onFail: 'ignore' }] });
    await runRecipeBlocks({ ...deps, slot: 'after-build', recipe });
    assert.equal(calls.creates.length, 0);
    assert.ok(calls.logs.some((m) => /failed \(ignored by the design\)/.test(m)));
});

test('a check block is a fresh review with the rule as its focus, and its findings apply', async () => {
    const { calls, deps } = harness({ verdict: {
        verdict: 'CHANGES_NEEDED', notes: 'README example 2 throws.',
        reopenIds: ['t1'], newTasks: [{ title: 'Fix README example 2', description: 'It throws a TypeError.', priority: 'P1' }],
    } });
    const recipe = normalizeRecipe({ blocks: [{ kind: 'check', name: 'Docs', instructions: 'Every README example must run.' }] });
    await runRecipeBlocks({ ...deps, slot: 'after-build', recipe });
    assert.equal(calls.reviews.length, 1);
    assert.match(calls.reviews[0].focus, /Every README example must run\./);
    assert.equal(calls.reviews[0].member, 'h1', 'explicit member: never resumes the round reviewer');
    assert.equal(calls.reviews[0].label, 'Block: Docs');
    assert.equal(calls.reopens.length, 1);
    assert.match(calls.reopens[0], /bd update t1 --status=open/);
    assert.equal(calls.creates.length, 1);
    assert.equal(calls.creates[0].title, 'Fix README example 2');
});

test('a report-only check applies nothing', async () => {
    const { calls, deps } = harness({ verdict: { verdict: 'CHANGES_NEEDED', notes: 'x', reopenIds: ['t1'], newTasks: [] } });
    const recipe = normalizeRecipe({ blocks: [{ kind: 'check', name: 'Audit', instructions: 'Look for dead code.', onFail: 'ignore' }] });
    await runRecipeBlocks({ ...deps, slot: 'after-build', recipe });
    assert.equal(calls.reopens.length, 0);
    assert.ok(calls.logs.some((m) => /report only/.test(m)));
});

test('only the requested slot runs', async () => {
    const { calls, deps } = harness();
    const recipe = normalizeRecipe({ blocks: [
        { kind: 'command', name: 'During', command: 'true' },
        { kind: 'command', name: 'At the end', command: 'true', slot: 'finish' },
    ] });
    await runRecipeBlocks({ ...deps, slot: 'finish', recipe });
    assert.deepEqual(calls.phases, ['Block: At the end']);
});

test('command failure tasks always pass the new-task validator', () => {
    const block = { name: 'Unit tests', command: 'npm test' };
    for (const output of ['', 'plain', '\u001b[31mred\u001b[0m and é accents', 'x'.repeat(10000)]) {
        const v = validateNewTask(commandFailureTask(block, output));
        assert.ok(v.ok, v.reason);
    }
    assert.ok(outputTail('y'.repeat(9000)).length <= 3003);
});

test('a work block runs a doer on the sprint branch with nothing to claim', async () => {
    const { calls, deps } = harness();
    const seen = [];
    const recipe = normalizeRecipe({ build: { mode: 'off' }, plan: { run: 'off' }, blocks: [{ kind: 'work', name: 'E2E', instructions: 'Write end-to-end tests.' }] });
    await runRecipeBlocks({ ...deps, slot: 'after-build', recipe, dispatchDoer: async (ctx, opts) => {
        seen.push(opts);
        await opts.claimBeads();
        assert.deepEqual(await opts.verifyStreakClosed('preDispatch'), []);
        const first = await opts.prepare({ dispatch: { kind: 'first' } });
        assert.match(first.prompt, /Write end-to-end tests\./);
        assert.equal(first.bindings.doerModel, 'standard');
        return { value: { status: 'VERIFY', closedIds: [], notes: 'added test/e2e.test.js' } };
    } });
    assert.equal(seen.length, 1);
    assert.ok(calls.commands.some((c) => c.cmd === 'git checkout feat/x' && c.member === 'h1'));
    assert.deepEqual(calls.syncs, [{ member: 'h1', pushCode: true }], 'code-write bracket');
    assert.ok(calls.logs.some((m) => /Block "E2E" C1: VERIFY -- added test\/e2e\.test\.js/.test(m)));
});

test('a work block that fails stops the sprint with a clear error', async () => {
    const { deps } = harness();
    const recipe = normalizeRecipe({ blocks: [{ kind: 'work', name: 'Docs', instructions: 'Update the docs.' }] });
    await assert.rejects(
        runRecipeBlocks({ ...deps, slot: 'after-build', recipe, dispatchDoer: async () => ({ error: new Error('boom') }) }),
        /Sprint design block "Docs" failed: boom/,
    );
    await assert.rejects(
        runRecipeBlocks({ ...deps, slot: 'after-build', recipe, dispatchDoer: async () => ({ value: { status: 'BLOCKED', notes: 'Write blocked' } }) }),
        /Sprint design block "Docs" failed: the helper reported BLOCKED: Write blocked/,
    );
});
