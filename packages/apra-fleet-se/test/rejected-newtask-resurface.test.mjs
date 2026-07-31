import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
    trackRejectedNewTaskForResurfacing,
    clearResubmittedNewTask,
    reconcilePendingRejectedNewTasks,
    buildRejectedNewTaskResurfaceLines,
    buildPlannerPrompt,
} from '../fleet-sprint/runner.js';

// apra-fleet-19o.2: a rejected reviewer-proposed newTask (validateNewTask()
// failure) used to dead-end ONLY in the parent bead's notes
// (appendRejectedFindingToParentNotes) -- useless to the next planning
// dispatch, which has no memory of this run and never reads bead notes as
// part of its prompt. These tests pin the pure run-state helpers that now
// resurface a rejected item verbatim into the NEXT planning-phase prompt
// (buildPlannerPrompt's rejectedNewTasksToResubmit), and clear it once
// successfully resubmitted so it does not accumulate forever.

describe('trackRejectedNewTaskForResurfacing', () => {
    test('appends a rejected newTask to an empty pending list', () => {
        const pending = trackRejectedNewTaskForResurfacing([], {
            title: 'Fix the thing', description: 'Do the fix.', reason: 'title fails allowlist', cycle: 1,
        });
        assert.strictEqual(pending.length, 1);
        assert.deepStrictEqual(pending[0], {
            title: 'Fix the thing', description: 'Do the fix.', reason: 'title fails allowlist', cycle: 1,
        });
    });

    test('does not mutate the input array (pure/immutable)', () => {
        const original = [];
        const next = trackRejectedNewTaskForResurfacing(original, { title: 'A', description: 'd', reason: 'r', cycle: 1 });
        assert.strictEqual(original.length, 0);
        assert.notStrictEqual(next, original);
    });

    test('dedupes by title -- a second rejection of the SAME title keeps only the latest reason/cycle', () => {
        let pending = trackRejectedNewTaskForResurfacing([], { title: 'Fix X', description: 'first desc', reason: 'title had a backtick', cycle: 1 });
        pending = trackRejectedNewTaskForResurfacing(pending, { title: 'Fix X', description: 'second desc', reason: 'title STILL has a dollar sign', cycle: 2 });
        assert.strictEqual(pending.length, 1, 'expected exactly one entry for the repeatedly-rejected title, not an unbounded accumulation');
        assert.strictEqual(pending[0].description, 'second desc');
        assert.strictEqual(pending[0].reason, 'title STILL has a dollar sign');
        assert.strictEqual(pending[0].cycle, 2);
    });

    test('different titles accumulate independently', () => {
        let pending = trackRejectedNewTaskForResurfacing([], { title: 'A', description: 'da', reason: 'ra', cycle: 1 });
        pending = trackRejectedNewTaskForResurfacing(pending, { title: 'B', description: 'db', reason: 'rb', cycle: 1 });
        assert.strictEqual(pending.length, 2);
        assert.deepStrictEqual(pending.map((p) => p.title).sort(), ['A', 'B']);
    });

    test('never throws on missing/non-string fields', () => {
        assert.doesNotThrow(() => trackRejectedNewTaskForResurfacing([], {}));
        const pending = trackRejectedNewTaskForResurfacing([], { title: undefined, description: null, reason: undefined, cycle: undefined });
        assert.strictEqual(pending[0].title, '(untitled)');
        assert.strictEqual(pending[0].description, '');
    });
});

describe('clearResubmittedNewTask', () => {
    test('drops the entry whose title matches a successfully-resubmitted title', () => {
        let pending = trackRejectedNewTaskForResurfacing([], { title: 'Fix X', description: 'd', reason: 'r', cycle: 1 });
        pending = trackRejectedNewTaskForResurfacing(pending, { title: 'Fix Y', description: 'd2', reason: 'r2', cycle: 1 });
        const cleared = clearResubmittedNewTask(pending, 'Fix X');
        assert.strictEqual(cleared.length, 1);
        assert.strictEqual(cleared[0].title, 'Fix Y');
    });

    test('is a no-op when the title is not pending', () => {
        const pending = trackRejectedNewTaskForResurfacing([], { title: 'Fix X', description: 'd', reason: 'r', cycle: 1 });
        const cleared = clearResubmittedNewTask(pending, 'Not Pending');
        assert.strictEqual(cleared.length, 1);
    });

    test('does not mutate the input array (pure/immutable)', () => {
        const pending = trackRejectedNewTaskForResurfacing([], { title: 'Fix X', description: 'd', reason: 'r', cycle: 1 });
        const cleared = clearResubmittedNewTask(pending, 'Fix X');
        assert.strictEqual(pending.length, 1, 'the original array must be untouched');
        assert.strictEqual(cleared.length, 0);
    });

    test('handles a non-array input gracefully (no throw)', () => {
        assert.doesNotThrow(() => clearResubmittedNewTask(undefined, 'x'));
        assert.deepStrictEqual(clearResubmittedNewTask(undefined, 'x'), []);
    });

    // apra-fleet-xuo.4: the resurfaced prompt explicitly instructs the
    // planner to correct the stated defect, which usually means changing
    // the title -- title-only matching left the corrected item stuck in the
    // pending list forever. Passing an {title, description} object matches
    // on EITHER field so a title-corrected-but-description-preserved
    // resubmission still clears.
    test('clears by description even when the resubmitted title differs from the rejected title', () => {
        let pending = trackRejectedNewTaskForResurfacing([], {
            title: '[test] foo', description: 'Fix the flaky retry loop.', reason: 'title fails allowlist', cycle: 1,
        });
        const cleared = clearResubmittedNewTask(pending, { title: 'test: foo', description: 'Fix the flaky retry loop.' });
        assert.strictEqual(cleared.length, 0, 'a title-corrected resubmission with the same description must still clear');
    });

    test('object form still matches on title alone when description is absent/blank', () => {
        let pending = trackRejectedNewTaskForResurfacing([], { title: 'Fix X', description: 'd', reason: 'r', cycle: 1 });
        const cleared = clearResubmittedNewTask(pending, { title: 'Fix X' });
        assert.strictEqual(cleared.length, 0);
    });

    test('object form does not clear an unrelated entry whose title AND description both differ', () => {
        let pending = trackRejectedNewTaskForResurfacing([], { title: 'Fix X', description: 'd', reason: 'r', cycle: 1 });
        const cleared = clearResubmittedNewTask(pending, { title: 'Totally different', description: 'also different' });
        assert.strictEqual(cleared.length, 1);
    });
});

describe('reconcilePendingRejectedNewTasks (apra-fleet-xuo.4)', () => {
    // The planner resubmits a corrected finding directly via `bd create`,
    // never through persistNewTaskBestEffort/clearResubmittedNewTask -- so
    // this reconciliation, run against the parent's LIVE child list, is the
    // only place a planner resubmission with a corrected title ever gets
    // cleared from the pending resurface list.
    test('drops a pending entry whose description now matches a real child bead, even with a different title', () => {
        let pending = trackRejectedNewTaskForResurfacing([], {
            title: '[test] foo', description: 'Fix the flaky retry loop.', reason: 'title fails allowlist', cycle: 1,
        });
        const currentChildren = [
            { id: 'apra-fleet-abc.1', title: 'test: foo', description: 'Fix the flaky retry loop.' },
        ];
        const reconciled = reconcilePendingRejectedNewTasks(pending, currentChildren);
        assert.strictEqual(reconciled.length, 0);
    });

    test('leaves a pending entry alone when no current child matches its description', () => {
        let pending = trackRejectedNewTaskForResurfacing([], {
            title: 'Fix X', description: 'Unresolved defect.', reason: 'r', cycle: 1,
        });
        const currentChildren = [
            { id: 'apra-fleet-abc.1', title: 'Unrelated task', description: 'Something else entirely.' },
        ];
        const reconciled = reconcilePendingRejectedNewTasks(pending, currentChildren);
        assert.strictEqual(reconciled.length, 1);
    });

    test('does not mutate the input pending array (pure/immutable)', () => {
        const pending = trackRejectedNewTaskForResurfacing([], { title: 'Fix X', description: 'd', reason: 'r', cycle: 1 });
        const reconciled = reconcilePendingRejectedNewTasks(pending, [{ description: 'd' }]);
        assert.strictEqual(pending.length, 1, 'the original array must be untouched');
        assert.strictEqual(reconciled.length, 0);
    });

    test('handles non-array pending/currentChildren gracefully (no throw)', () => {
        assert.doesNotThrow(() => reconcilePendingRejectedNewTasks(undefined, undefined));
        assert.deepStrictEqual(reconcilePendingRejectedNewTasks(undefined, undefined), []);
        assert.doesNotThrow(() => reconcilePendingRejectedNewTasks([{ title: 'A', description: 'd' }], undefined));
    });

    test('is a no-op when nothing is pending', () => {
        assert.deepStrictEqual(reconcilePendingRejectedNewTasks([], [{ description: 'd' }]), []);
    });
});

describe('buildRejectedNewTaskResurfaceLines', () => {
    test('returns an empty array when nothing is pending', () => {
        assert.deepStrictEqual(buildRejectedNewTaskResurfaceLines([]), []);
        assert.deepStrictEqual(buildRejectedNewTaskResurfaceLines(undefined), []);
    });

    test('renders the item title, description, and rejection reason verbatim', () => {
        const lines = buildRejectedNewTaskResurfaceLines([
            { title: 'Fix the auth race', description: 'Add a lock around the token refresh.', reason: 'title fails safe-character allowlist', cycle: 2 },
        ]);
        assert.ok(lines.length >= 2);
        const joined = lines.join('\n');
        assert.ok(joined.includes('Fix the auth race'), 'expected the title verbatim');
        assert.ok(joined.includes('Add a lock around the token refresh.'), 'expected the description verbatim');
        assert.ok(joined.includes('title fails safe-character allowlist'), 'expected the rejection reason verbatim');
        assert.ok(joined.includes('cycle 2') || joined.includes('(cycle 2)'), 'expected the originating cycle to be surfaced');
    });

    test('renders multiple pending items, one per entry', () => {
        const lines = buildRejectedNewTaskResurfaceLines([
            { title: 'A', description: 'da', reason: 'ra', cycle: 1 },
            { title: 'B', description: 'db', reason: 'rb', cycle: 2 },
        ]);
        const joined = lines.join('\n');
        assert.ok(joined.includes('A') && joined.includes('B'));
        assert.ok(joined.includes('da') && joined.includes('db'));
        assert.ok(joined.includes('ra') && joined.includes('rb'));
    });
});

describe('buildPlannerPrompt: rejectedNewTasksToResubmit surfacing (apra-fleet-19o.2)', () => {
    const baseOpts = {
        isDeltaCycle: true,
        targetIssues: ['apra-fleet-xyz'],
        goal: 'P1/P2',
        requirementsFile: undefined,
        requirementsContent: null,
        feedback: null,
    };

    test('the prompt payload contains the rejected item\'s title, description, and rejection reason verbatim', () => {
        const prompt = buildPlannerPrompt({
            ...baseOpts,
            rejectedNewTasksToResubmit: [
                { title: 'Fix env-var leak', description: 'Scrub AWS_SECRET from the log output.', reason: 'title fails safe-character allowlist (or is empty)', cycle: 3 },
            ],
        });
        assert.ok(prompt.includes('Fix env-var leak'), 'prompt must contain the rejected title verbatim');
        assert.ok(prompt.includes('Scrub AWS_SECRET from the log output.'), 'prompt must contain the rejected description verbatim');
        assert.ok(prompt.includes('title fails safe-character allowlist (or is empty)'), 'prompt must contain the rejection reason verbatim');
    });

    test('omitting rejectedNewTasksToResubmit (or passing []) leaves the prompt byte-identical to before apra-fleet-19o.2', () => {
        const withDefault = buildPlannerPrompt({ ...baseOpts });
        const withEmpty = buildPlannerPrompt({ ...baseOpts, rejectedNewTasksToResubmit: [] });
        assert.strictEqual(withDefault, withEmpty);
        assert.ok(!withDefault.includes('previously REJECTED'), 'no resurface section should appear when nothing is pending');
    });

    test('multiple pending items all appear in the same prompt', () => {
        const prompt = buildPlannerPrompt({
            ...baseOpts,
            rejectedNewTasksToResubmit: [
                { title: 'First rejected item', description: 'desc one', reason: 'reason one', cycle: 1 },
                { title: 'Second rejected item', description: 'desc two', reason: 'reason two', cycle: 2 },
            ],
        });
        assert.ok(prompt.includes('First rejected item') && prompt.includes('Second rejected item'));
        assert.ok(prompt.includes('reason one') && prompt.includes('reason two'));
    });

    test('a full reject -> track -> resubmit -> clear cycle no longer surfaces the item in the next prompt', () => {
        let pending = trackRejectedNewTaskForResurfacing([], {
            title: 'Flaky title', description: 'A description.', reason: 'title fails safe-character allowlist', cycle: 1,
        });
        // Next planning-phase prompt (cycle 2) surfaces it.
        const promptBeforeResubmit = buildPlannerPrompt({ ...baseOpts, rejectedNewTasksToResubmit: pending });
        assert.ok(promptBeforeResubmit.includes('Flaky title'));

        // The planner successfully resubmits it (fixed title now validates
        // and lands as a real bead) -- the run-state clear happens at the
        // create call site; this test exercises the same pure transition.
        pending = clearResubmittedNewTask(pending, 'Flaky title');

        // Next planning-phase prompt after that must NOT surface it again.
        const promptAfterResubmit = buildPlannerPrompt({ ...baseOpts, rejectedNewTasksToResubmit: pending });
        assert.ok(!promptAfterResubmit.includes('Flaky title'), 'a successfully-resubmitted item must not reappear in a later planning prompt');
        assert.ok(!promptAfterResubmit.includes('previously REJECTED'));
    });

    test('the SCOPED in-cycle replan prompt shape (replanScope set) also honors rejectedNewTasksToResubmit', () => {
        const prompt = buildPlannerPrompt({
            ...baseOpts,
            replanScope: ['apra-fleet-xyz.1'],
            rejectedNewTasksToResubmit: [
                { title: 'Resurfaced during scoped replan', description: 'd', reason: 'r', cycle: 1 },
            ],
        });
        assert.ok(prompt.includes('SCOPED IN-CYCLE REPLAN'));
        assert.ok(prompt.includes('Resurfaced during scoped replan'));
    });
});
