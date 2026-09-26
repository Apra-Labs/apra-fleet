// =============================================================================
// Sprint designs ("recipes"): which blocks a sprint runs, and how.
//
// A recipe is plain JSON handed to the CLI as --recipe-file. Without one the
// engine behaves exactly as it always has; every field below that a recipe
// leaves out also keeps today's behaviour. This module is pure: it validates
// and normalizes a recipe and answers the per-cycle questions the runner asks
// ("does Plan run this cycle?"). The blocks it describes run through the
// existing phases; custom blocks run in phases/recipe-blocks.mjs.
//
// Shape (every field optional):
// {
//   "name": "Fast pipeline",
//   "plan":   { "run": "always" | "when-needed" | "first-cycle" | "off", "review": true },
//   "build":  { "mode": "classic" | "pipeline" | "off", "minModel": "cheap" | "standard" | "premium",
//               "acceptanceTasks": true },
//   "review": { "run": "on" | "off", "split": "auto" | "always" | "never", "splitMinFiles": 20 },
//   "test":   { "run": "auto" | "off" },
//   "blocks": [ { "slot": "after-build" | "finish", "kind": "check" | "work" | "command",
//                 "name": "...", "instructions": "...", "command": "...",
//                 "model": "cheap" | "standard" | "premium", "onFail": "new-task" | "ignore" } ],
//   "finish": { "finalReview": true, "harvest": true }
// }
// Launcher-level settings (helpers, the landing check, cycles) are CLI flags,
// not recipe fields, so the engine has one source for each.
// =============================================================================

export const MODEL_TIERS = ['cheap', 'standard', 'premium'];
const PLAN_RUN = ['always', 'when-needed', 'first-cycle', 'off'];
const BUILD_MODE = ['classic', 'pipeline', 'off'];
const REVIEW_RUN = ['on', 'off'];
const REVIEW_SPLIT = ['auto', 'always', 'never'];
const TEST_RUN = ['auto', 'off'];
const BLOCK_SLOTS = ['after-build', 'finish'];
const BLOCK_KINDS = ['check', 'work', 'command'];
const ON_FAIL = ['new-task', 'ignore'];
const MAX_BLOCKS = 12;
const MAX_TEXT = 8000;

export class RecipeError extends Error {}

function pick(obj, key, allowed, fallback, where) {
    const v = obj && obj[key];
    if (v === undefined || v === null) return fallback;
    if (!allowed.includes(v)) throw new RecipeError(`${where}.${key} must be one of ${allowed.join(', ')} (got ${JSON.stringify(v)})`);
    return v;
}

function bool(obj, key, fallback, where) {
    const v = obj && obj[key];
    if (v === undefined || v === null) return fallback;
    if (typeof v !== 'boolean') throw new RecipeError(`${where}.${key} must be true or false`);
    return v;
}

function text(v, where, { required = false, max = MAX_TEXT } = {}) {
    if (v === undefined || v === null || v === '') {
        if (required) throw new RecipeError(`${where} is required`);
        return '';
    }
    if (typeof v !== 'string') throw new RecipeError(`${where} must be text`);
    // Recipes reach prompts and shells: printable ASCII plus newlines and tabs only.
    if (!/^[\x20-\x7e\n\t]*$/.test(v)) throw new RecipeError(`${where} may only contain plain ASCII text`);
    if (v.length > max) throw new RecipeError(`${where} is longer than ${max} characters`);
    return v.trim();
}

/**
 * Validate and fill in a recipe. Returns null for "no recipe" (the engine's
 * own behaviour); throws RecipeError with a message a person can act on.
 */
export function normalizeRecipe(raw) {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new RecipeError('a sprint design must be a JSON object');
    const plan = {
        run: pick(raw.plan, 'run', PLAN_RUN, 'always', 'plan'),
        review: bool(raw.plan, 'review', true, 'plan'),
    };
    const build = {
        mode: pick(raw.build, 'mode', BUILD_MODE, null, 'build'),
        minModel: pick(raw.build, 'minModel', MODEL_TIERS, null, 'build'),
        acceptanceTasks: bool(raw.build, 'acceptanceTasks', true, 'build'),
    };
    const review = {
        run: pick(raw.review, 'run', REVIEW_RUN, 'on', 'review'),
        split: pick(raw.review, 'split', REVIEW_SPLIT, 'always', 'review'),
        splitMinFiles: 20,
    };
    if (raw.review && raw.review.splitMinFiles !== undefined) {
        const n = raw.review.splitMinFiles;
        if (!Number.isInteger(n) || n < 1 || n > 10000) throw new RecipeError('review.splitMinFiles must be a whole number from 1 to 10000');
        review.splitMinFiles = n;
    }
    const test = { run: pick(raw.test, 'run', TEST_RUN, 'auto', 'test') };
    const finish = {
        finalReview: bool(raw.finish, 'finalReview', true, 'finish'),
        harvest: bool(raw.finish, 'harvest', true, 'finish'),
    };
    const rawBlocks = raw.blocks === undefined ? [] : raw.blocks;
    if (!Array.isArray(rawBlocks)) throw new RecipeError('blocks must be a list');
    if (rawBlocks.length > MAX_BLOCKS) throw new RecipeError(`a design can have at most ${MAX_BLOCKS} custom blocks`);
    const seen = new Set();
    const blocks = rawBlocks.map((b, i) => {
        const where = `blocks[${i}]`;
        if (!b || typeof b !== 'object') throw new RecipeError(`${where} must be an object`);
        const kind = pick(b, 'kind', BLOCK_KINDS, null, where);
        if (!kind) throw new RecipeError(`${where}.kind is required (check, work or command)`);
        const name = text(b.name, `${where}.name`, { required: true, max: 60 });
        if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(name)) throw new RecipeError(`${where}.name may use letters, digits, spaces, dots, dashes and underscores`);
        const key = name.toLowerCase();
        if (seen.has(key)) throw new RecipeError(`two blocks are called "${name}"`);
        seen.add(key);
        const block = {
            slot: pick(b, 'slot', BLOCK_SLOTS, 'after-build', where),
            kind,
            name,
            model: pick(b, 'model', MODEL_TIERS, kind === 'work' ? 'standard' : null, where),
            onFail: pick(b, 'onFail', ON_FAIL, 'new-task', where),
            instructions: '',
            command: '',
        };
        if (kind === 'command') {
            block.command = text(b.command, `${where}.command`, { required: true, max: 500 });
            if (/[\n\r]/.test(block.command)) throw new RecipeError(`${where}.command must be a single line`);
        } else {
            block.instructions = text(b.instructions, `${where}.instructions`, { required: true });
        }
        return block;
    });
    const recipe = { name: text(raw.name, 'name', { max: 60 }) || 'Custom', plan, build, review, test, blocks, finish };
    const problems = recipeProblems(recipe);
    if (problems.length) throw new RecipeError(problems[0]);
    return recipe;
}

/** Combinations that cannot do anything useful, as messages. */
export function recipeProblems(recipe) {
    const out = [];
    const hasWork = recipe.build.mode !== 'off' || recipe.blocks.some((b) => b.kind === 'work');
    const hasAnything = hasWork || recipe.blocks.length > 0 || recipe.test.run !== 'off' || recipe.finish.finalReview;
    if (!hasAnything) out.push('this design does nothing: turn on Build, a test, a custom block or the final review');
    if (recipe.build.mode === 'off' && recipe.plan.run !== 'off' && !recipe.blocks.some((b) => b.kind === 'work')) {
        out.push('Plan makes tasks, but nothing builds them: turn Build on or Plan off');
    }
    return out;
}

/**
 * Does the Plan phase run this cycle? `needsPlanning` is the runner's
 * data-driven answer to "is there anything left to plan": work that is not yet
 * split into tasks, tasks a reviewer said have wrong acceptance criteria, or
 * rejected findings waiting to be resubmitted.
 */
export function planRunsThisCycle(recipe, { cycle, needsPlanning }) {
    if (!recipe) return true;
    switch (recipe.plan.run) {
        case 'off': return false;
        case 'first-cycle': return cycle === 1;
        case 'when-needed': return cycle === 1 || needsPlanning;
        default: return true;
    }
}

/**
 * Is there open work a planner still has to split? `openBeads` is the scope's
 * not-done beads, `decomposedIds` the ids that already have children. A
 * reopened or reviewer-created task is ready to build as it is.
 */
export function hasUndecomposedWork(openBeads, decomposedIds) {
    return openBeads.some((b) => (b.issue_type || 'task') !== 'task' && !decomposedIds.has(b.id));
}

export function buildRuns(recipe) {
    return !recipe || recipe.build.mode !== 'off';
}

export function reviewRuns(recipe) {
    return !recipe || recipe.review.run !== 'off';
}

export function testRuns(recipe) {
    return !recipe || recipe.test.run !== 'off';
}

/** Should the end-of-cycle review split across reviewers for a diff of `fileCount` files? */
export function splitReview(recipe, fileCount) {
    if (!recipe) return true;
    if (recipe.review.split === 'never') return false;
    if (recipe.review.split === 'always') return true;
    return fileCount >= recipe.review.splitMinFiles;
}

/** Raise a tier to the recipe's floor. Unknown tiers pass through untouched. */
export function applyModelFloor(recipe, tier) {
    const floor = recipe && recipe.build.minModel;
    if (!floor) return tier;
    const have = MODEL_TIERS.indexOf(tier);
    const need = MODEL_TIERS.indexOf(floor);
    if (have === -1) return floor;
    return have < need ? floor : tier;
}

export function blocksFor(recipe, slot) {
    return recipe ? recipe.blocks.filter((b) => b.slot === slot) : [];
}
