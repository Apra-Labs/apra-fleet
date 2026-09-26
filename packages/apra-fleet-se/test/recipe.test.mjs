import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeRecipe, RecipeError, planRunsThisCycle, hasUndecomposedWork,
    buildRuns, reviewRuns, testRuns, splitReview, applyModelFloor, blocksFor,
} from '../fleet-sprint/recipe.mjs';
import {
    PIPELINE_PLANNING_GUIDANCE, PIPELINE_PLANNING_GUIDANCE_NO_ACCEPTANCE,
    buildPlannerPrompt, buildWorkBlockPrompt, buildCheckBlockFocus,
} from '../fleet-sprint/prompts.mjs';
import { validateArgs } from '../fleet-sprint/sprint-args.mjs';

// =============================================================================
// Sprint designs (fleet-sprint/recipe.mjs): validation and the per-cycle
// decisions the runner asks. No recipe must mean exactly today's behaviour.
// =============================================================================

test('no recipe is the engine default for every decision', () => {
    assert.equal(normalizeRecipe(undefined), null);
    assert.equal(normalizeRecipe(null), null);
    assert.equal(planRunsThisCycle(null, { cycle: 3, needsPlanning: false }), true);
    assert.equal(buildRuns(null), true);
    assert.equal(reviewRuns(null), true);
    assert.equal(testRuns(null), true);
    assert.equal(splitReview(null, 1), true);
    assert.equal(applyModelFloor(null, 'cheap'), 'cheap');
    assert.deepEqual(blocksFor(null, 'after-build'), []);
});

test('an empty recipe fills in the engine defaults', () => {
    const r = normalizeRecipe({});
    assert.equal(r.name, 'Custom');
    assert.deepEqual(r.plan, { run: 'always', review: true });
    assert.deepEqual(r.build, { mode: null, minModel: null, acceptanceTasks: true });
    assert.deepEqual(r.review, { run: 'on', split: 'always', splitMinFiles: 20 });
    assert.deepEqual(r.test, { run: 'auto' });
    assert.deepEqual(r.finish, { finalReview: true, harvest: true });
    assert.deepEqual(r.blocks, []);
});

test('bad values fail with a message that names the field', () => {
    const cases = [
        [{ plan: { run: 'sometimes' } }, /plan\.run must be one of/],
        [{ build: { minModel: 'huge' } }, /build\.minModel/],
        [{ review: { splitMinFiles: 0 } }, /splitMinFiles/],
        [{ finish: { harvest: 'no' } }, /finish\.harvest must be true or false/],
        [{ blocks: [{ kind: 'check', name: 'x' }] }, /instructions is required/],
        [{ blocks: [{ kind: 'command', name: 'x', command: 'a\nb' }] }, /single line/],
        [{ blocks: [{ kind: 'shell', name: 'x' }] }, /kind must be one of/],
        [{ blocks: [{ kind: 'check', name: 'A', instructions: 'i' }, { kind: 'check', name: 'a', instructions: 'j' }] }, /two blocks are called/],
        [{ blocks: [{ kind: 'check', name: 'x', instructions: 'café' }] }, /plain ASCII/],
        [[], /JSON object/],
    ];
    for (const [raw, re] of cases) {
        assert.throws(() => normalizeRecipe(raw), (err) => err instanceof RecipeError && re.test(err.message), JSON.stringify(raw));
    }
});

test('designs that cannot do anything are refused', () => {
    assert.throws(() => normalizeRecipe({ build: { mode: 'off' }, test: { run: 'off' }, finish: { finalReview: false } }), /does nothing/);
    assert.throws(() => normalizeRecipe({ build: { mode: 'off' } }), /nothing builds them/);
    // A test-only design is fine: no plan, no build, one work block.
    const e2e = normalizeRecipe({
        plan: { run: 'off' }, build: { mode: 'off' },
        blocks: [{ kind: 'work', name: 'E2E tests', instructions: 'Write and run end-to-end tests.' }],
    });
    assert.equal(e2e.blocks[0].model, 'standard');
    assert.equal(e2e.blocks[0].slot, 'after-build');
});

test('Plan runs by design: always, first cycle, when needed, or never', () => {
    const when = normalizeRecipe({ plan: { run: 'when-needed' } });
    assert.equal(planRunsThisCycle(when, { cycle: 1, needsPlanning: false }), true, 'cycle 1 always plans');
    assert.equal(planRunsThisCycle(when, { cycle: 2, needsPlanning: false }), false, 'only reopens: straight back to building');
    assert.equal(planRunsThisCycle(when, { cycle: 2, needsPlanning: true }), true);
    const first = normalizeRecipe({ plan: { run: 'first-cycle' } });
    assert.equal(planRunsThisCycle(first, { cycle: 2, needsPlanning: true }), false);
    const off = normalizeRecipe({ plan: { run: 'off' } });
    assert.equal(planRunsThisCycle(off, { cycle: 1, needsPlanning: true }), false);
});

test('undecomposed work is an open non-task bead with no children', () => {
    const decomposed = new Set(['f1']);
    assert.equal(hasUndecomposedWork([{ id: 't1', issue_type: 'task' }, { id: 'f1', issue_type: 'feature' }], decomposed), false);
    assert.equal(hasUndecomposedWork([{ id: 'f2', issue_type: 'feature' }], decomposed), true);
    assert.equal(hasUndecomposedWork([{ id: 'b1', issue_type: 'bug' }], decomposed), true);
    assert.equal(hasUndecomposedWork([{ id: 'x' }], decomposed), false, 'an untyped bead is a task');
});

test('review splitting follows the design', () => {
    assert.equal(splitReview(normalizeRecipe({ review: { split: 'never' } }), 500), false);
    const auto = normalizeRecipe({ review: { split: 'auto', splitMinFiles: 10 } });
    assert.equal(splitReview(auto, 9), false);
    assert.equal(splitReview(auto, 10), true);
});

test('the model floor only ever raises a tier', () => {
    const r = normalizeRecipe({ build: { minModel: 'standard' } });
    assert.equal(applyModelFloor(r, 'cheap'), 'standard');
    assert.equal(applyModelFloor(r, 'standard'), 'standard');
    assert.equal(applyModelFloor(r, 'premium'), 'premium');
    assert.equal(applyModelFloor(r, undefined), 'standard');
});

test('pipeline planning without acceptance-test tasks drops only that rule', () => {
    assert.match(PIPELINE_PLANNING_GUIDANCE, /Acceptance test:/);
    assert.doesNotMatch(PIPELINE_PLANNING_GUIDANCE_NO_ACCEPTANCE, /Acceptance test:/);
    assert.match(PIPELINE_PLANNING_GUIDANCE_NO_ACCEPTANCE, /Do NOT add separate acceptance-test tasks/);
    for (const kept of ['1. Split the work by CODE', '3. Fix the SHAPE', '4. Record the files', '5. Prefer many short']) {
        assert.ok(PIPELINE_PLANNING_GUIDANCE_NO_ACCEPTANCE.includes(kept), kept);
    }
    const base = { isDeltaCycle: false, targetIssues: ['e1'], goal: 'P1/P2', pipeline: true };
    assert.match(buildPlannerPrompt({ ...base }), /Acceptance test:/);
    assert.doesNotMatch(buildPlannerPrompt({ ...base, acceptanceTasks: false }), /Acceptance test:/);
});

test('block prompts carry the instructions and the doer rules', () => {
    const work = buildWorkBlockPrompt({ block: { name: 'E2E', instructions: 'Write e2e tests under test/e2e.' }, branch: 'feat/x' });
    assert.match(work, /Sprint track branch to work on: feat\/x\./);
    assert.match(work, /Write e2e tests under test\/e2e\./);
    assert.match(work, /must NOT run any `bd` command/);
    assert.match(work, /STAY IN YOUR OWN CHECKOUT/);
    assert.match(work, /PERMISSION BLOCKS MUST BE SURFACED/);
    const focus = buildCheckBlockFocus({ name: 'Docs', instructions: 'README examples must run.' });
    assert.match(focus, /SPRINT DESIGN CHECK "Docs"/);
    assert.match(focus, /README examples must run\./);
});

test('the arg contract accepts a recipe and rejects a mode mismatch', () => {
    const base = { target_issues: ['e1'], members: ['m1'], branch: 'feat/x', base_branch: 'main' };
    assert.equal(validateArgs(base).recipe, null);
    const v = validateArgs({ ...base, recipe: { name: 'Lean', finish: { harvest: false } } });
    assert.equal(v.recipe.name, 'Lean');
    assert.equal(v.recipe.finish.harvest, false);
    assert.throws(() => validateArgs({ ...base, recipe: { build: { mode: 'pipeline' } } }), /pass pipeline: true/);
    assert.throws(() => validateArgs({ ...base, pipeline: true, recipe: { build: { mode: 'classic' } } }), /classic mode/);
    assert.throws(() => validateArgs({ ...base, recipe: { plan: { run: 'x' } } }), /Invalid recipe: plan\.run/);
});
