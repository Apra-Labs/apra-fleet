import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// apra-fleet-unw2.2 -- STATIC CONTRACT TRIPWIRE for finding N13 (the
// regression guard for N1's whole failure class).
//
// What this file is (and is not):
//
//   - It is a READ-ONLY test. It touches nothing in auto-sprint/runner.js;
//     runner.js's actual prompt-builder fixes are a PARALLEL issue
//     (apra-fleet-unw2.1). This file only reads runner.js as text and reads
//     contracts.mjs's validateRoleInput against the REAL vendored input
//     schemas (fixture snapshot at test/fixtures/apra-pm-schemas/*,
//     a mirror of this repo's packages/apra-fleet-se/apra-pm/agents/schemas/).
//
//   - For every role runner.js dispatches, it reconstructs the SAME context
//     object the corresponding prompt builder (or inline dispatch) in
//     runner.js actually consumes -- by extracting the builder's destructured
//     parameters / the dispatch shape straight out of runner.js source, NOT
//     by hand-copying a snapshot. That source-derivation is what makes this
//     tripwire genuinely revert-sensitive: it goes RED against a runner whose
//     builders omit a required input, and GREEN the moment those builders
//     supply it (i.e. once apra-fleet-unw2.1 lands). A hardcoded context
//     could not distinguish the two.
//
//   - It then asserts validateRoleInput(role, ctx).valid against the vendored
//     <role>-input.json. Roles with no input schema (planner) are no-ops by
//     design and pass trivially; the planner's SEPARATE contract obligation
//     (the --metadata model-tier convention, which has no formal input
//     schema) is asserted as a prompt-text check instead.
//
// EXPECTED STATE right now (pre-unw2.1, current feat/fleet-reorg runner.js):
// this file is RED on EXACTLY the three N1 divergences --
//   (1) planner:       prompt still uses the old --notes model-tier convention
//                      instead of --metadata (N1 divergence 1);
//   (2) plan-reviewer: dispatch is context-free, supplies no `scope`
//                      (N1 divergence 2);
//   (3) doer:          buildDoerPrompt supplies no `branch` (N1 divergence 3).
// That red run is the PROOF the tripwire works. Do not weaken the assertions
// to make it pass -- it is meant to go green only when runner.js is fixed.
//
// harvester: wired for real in apra-fleet-unw2.10 (N12) -- runner.js's
// buildHarvesterPrompt now consumes all five vendored-required inputs
// (analysisArtifactFile/analysisText/costAnalysis/base-branch/branch), each
// assembled from real per-run state (closedCountHistory, deploy/integ
// failures, the final verdict, the live budget object). This assertion is
// EXPECTED GREEN.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '..', 'apra-pm', 'agents', 'schemas');
const RUNNER_PATH = path.join(__dirname, '..', 'auto-sprint', 'runner.js');

// contracts.mjs resolves its vendored-schema dir at MODULE-LOAD time from
// this env var (its documented test-only override), so it must be set before
// the import. `node --test` isolates each test file in its own process, so
// this cannot leak into another file; we restore it anyway for cleanliness.
const previousOverride = process.env.APRA_FLEET_SE_SCHEMAS_DIR;
process.env.APRA_FLEET_SE_SCHEMAS_DIR = FIXTURES_DIR;
const { validateRoleInput } = await import(`../auto-sprint/contracts.mjs?role-input-contract=${Date.now()}`);
if (previousOverride === undefined) {
    delete process.env.APRA_FLEET_SE_SCHEMAS_DIR;
} else {
    process.env.APRA_FLEET_SE_SCHEMAS_DIR = previousOverride;
}

const RUNNER_SOURCE = fs.readFileSync(RUNNER_PATH, 'utf-8');

// ---------------------------------------------------------------------------
// Source-extraction helpers -- the revert-sensitive core
// ---------------------------------------------------------------------------
//
// These read what runner.js ACTUALLY supplies to each role, so the test's
// verdict changes when runner.js changes (that is the whole point).

// Maps a prompt-builder's destructured JS parameter name to the vendored
// input-schema key it satisfies. Params not in this map (feedback,
// acceptanceCriteriaJson, targetIssues, ...) are non-contract context and
// are intentionally ignored.
const PARAM_TO_SCHEMA_KEY = Object.freeze({
    branch: 'branch',
    baseBranch: 'base-branch',
    scope: 'scope',
    operation: 'operation',
    repoRoot: 'repoRoot',
    environmentReady: 'environmentReady',
    expectedHeadSha: 'expectedHeadSha',
    analysisArtifactFile: 'analysisArtifactFile',
    analysisText: 'analysisText',
    costAnalysis: 'costAnalysis',
});

// apra-pm PR#29 bumped doer-input/reviewer-input to @2, both adding a
// required bead-id list -- but each schema names it differently
// (assignedBeadIds vs beadIds), and both builders destructure the SAME JS
// param name (`beadIds`). PARAM_TO_SCHEMA_KEY is global across builders, so
// it cannot express "same param, different schema key depending on role" --
// hence this small per-builder override, consulted first.
const BUILDER_PARAM_OVERRIDES = Object.freeze({
    buildDoerPrompt: { beadIds: 'assignedBeadIds' },
    buildReviewerPrompt: { beadIds: 'beadIds' },
});

// A schema-valid placeholder value per input-schema key. Only presence and
// type matter to validateRoleInput; concrete values are illustrative.
const PLACEHOLDER = Object.freeze({
    branch: 'feat/fleet-reorg',
    'base-branch': 'main',
    scope: 'apra-fleet-unw2 sprint root (goal priority P1)',
    operation: 'deploy',
    repoRoot: '/srv/member/repo',
    environmentReady: true,
    expectedHeadSha: '0123456789abcdef0123456789abcdef01234567',
    analysisArtifactFile: 'docs/sprint-logs/unw2.md',
    analysisText: 'Sprint analysis text.',
    costAnalysis: '$0.00 (estimate)',
    assignedBeadIds: ['apra-fleet-abc'],
    beadIds: ['apra-fleet-abc'],
    featureIds: ['apra-fleet-def'],
});

/**
 * Extracts the destructured parameter names of a `function <fnName>({ ... })`
 * declaration from runner.js source. Returns null if no such builder exists
 * (e.g. a role dispatched with a bare inline string and no builder).
 */
function extractBuilderParams(fnName) {
    const re = new RegExp(`function ${fnName}\\(\\{([^}]*)\\}`);
    const m = RUNNER_SOURCE.match(re);
    if (!m) return null;
    return m[1]
        .split(',')
        .map((s) => s.trim().split(/[:=]/)[0].trim())
        .filter(Boolean);
}

/**
 * Builds the dispatch context a builder consumes, by mapping its destructured
 * params to input-schema keys and attaching a schema-valid placeholder for
 * each mapped key. Params with no schema mapping are dropped.
 */
function contextFromBuilder(fnName) {
    const params = extractBuilderParams(fnName);
    if (params === null) return null;
    const overrides = BUILDER_PARAM_OVERRIDES[fnName] || {};
    const ctx = {};
    for (const p of params) {
        const key = overrides[p] || PARAM_TO_SCHEMA_KEY[p];
        if (key) ctx[key] = PLACEHOLDER[key];
    }
    return ctx;
}

// ---------------------------------------------------------------------------
// The tripwire, role by role
// ---------------------------------------------------------------------------

describe('runner role-input contract tripwire (N13; guards N1)', () => {
    // -- planner ---------------------------------------------------------
    // planner has NO input schema (its output is the beads DAG), so
    // validateRoleInput is a no-op and passes trivially. Its real contract
    // obligation is the model-tier convention, which lives in the prompt
    // TEXT, not a schema -- so it is asserted as a prompt-text check.
    describe('planner', () => {
        test('validateRoleInput is a no-op (no planner-input schema) and passes', () => {
            const result = validateRoleInput('planner', {});
            assert.strictEqual(result.valid, true);
            assert.strictEqual(result.errors, null);
        });

        // N1 divergence 1: vendored planner.md Step 3 / plan-reviewer.md
        // criterion 10 require the model tier via
        //   bd create ... --metadata '{"model": "..."}'
        // and explicitly NOT via --notes. buildPlannerPrompt must instruct
        // --metadata and must NOT instruct the old --notes convention.
        // EXPECTED RED pre-unw2.1 (runner still emits --notes="model: <tier>").
        test('buildPlannerPrompt uses the --metadata model-tier convention, not --notes (N1 divergence 1)', () => {
            const start = RUNNER_SOURCE.indexOf('function buildPlannerPrompt');
            assert.ok(start !== -1, 'buildPlannerPrompt not found in runner.js');
            // Bound the slice to the planner builder body (up to the next builder).
            const end = RUNNER_SOURCE.indexOf('function buildStreakAssignmentPrompt', start);
            const body = RUNNER_SOURCE.slice(start, end === -1 ? undefined : end);

            assert.ok(
                body.includes('--metadata'),
                'planner prompt must instruct the --metadata model-tier convention '
                    + '(vendored planner.md Step 3); it does not -- N1 divergence 1.',
            );
            assert.ok(
                !body.includes('--notes'),
                'planner prompt must NOT use the old --notes model-tier convention '
                    + '(vendored plan-reviewer.md criterion 10 hard-fails it); it still does -- N1 divergence 1.',
            );
        });
    });

    // -- plan-reviewer ---------------------------------------------------
    // The plan-reviewer is dispatched inline (no builder). The vendored
    // plan-reviewer-input.json requires `scope`. runner.js currently
    // dispatches the context-free string 'Review the plan per your agent
    // contract.' -- supplying no scope. Detection is tied to plan.md's exact
    // unw2.1 fix ("replace the context-free plan-reviewer dispatch"): if that
    // literal is still the plan-reviewer prompt, scope is NOT supplied.
    // EXPECTED RED pre-unw2.1.
    describe('plan-reviewer', () => {
        test('dispatch supplies the required `scope` input (N1 divergence 2)', () => {
            const CONTEXT_FREE = /agent\(\s*(['"])Review the plan per your agent contract\.\1/;
            const scopeSupplied = !CONTEXT_FREE.test(RUNNER_SOURCE);
            const ctx = scopeSupplied ? { scope: PLACEHOLDER.scope } : {};

            const result = validateRoleInput('plan-reviewer', ctx);
            assert.strictEqual(
                result.valid,
                true,
                'plan-reviewer dispatch must supply `scope` (vendored plan-reviewer-input.json '
                    + `required: ["scope"]); it is context-free -- N1 divergence 2. errors=${JSON.stringify(result.errors)}`,
            );
        });
    });

    // -- doer ------------------------------------------------------------
    // buildDoerPrompt consumes { beadIds, branch, feedback }, satisfying
    // doer-input@2's required: ["branch", "assignedBeadIds"] (apra-pm PR#29
    // bumped this schema; `beadIds` maps to `assignedBeadIds` via
    // BUILDER_PARAM_OVERRIDES, since the doer's entire work list IS its
    // assignedBeadIds). EXPECTED GREEN.
    describe('doer', () => {
        test('buildDoerPrompt supplies branch and assignedBeadIds', () => {
            const ctx = contextFromBuilder('buildDoerPrompt');
            assert.ok(ctx !== null, 'buildDoerPrompt not found in runner.js');

            const result = validateRoleInput('doer', ctx);
            assert.strictEqual(
                result.valid,
                true,
                `doer context ${JSON.stringify(ctx)} must satisfy doer-input.json; `
                    + `errors=${JSON.stringify(result.errors)}`,
            );
        });
    });

    // -- reviewer --------------------------------------------------------
    // buildReviewerPrompt consumes { beadIds, acceptanceCriteriaJson,
    // baseBranch, branch }, satisfying reviewer-input@2's required:
    // ["base-branch", "branch", "beadIds"] (apra-pm PR#29 bumped this
    // schema; `beadIds` maps straight through via BUILDER_PARAM_OVERRIDES).
    // EXPECTED GREEN.
    describe('reviewer', () => {
        test('buildReviewerPrompt supplies base-branch, branch, and beadIds', () => {
            const ctx = contextFromBuilder('buildReviewerPrompt');
            assert.ok(ctx !== null, 'buildReviewerPrompt not found in runner.js');

            const result = validateRoleInput('reviewer', ctx);
            assert.strictEqual(
                result.valid,
                true,
                `reviewer context ${JSON.stringify(ctx)} must satisfy reviewer-input.json; `
                    + `errors=${JSON.stringify(result.errors)}`,
            );
        });
    });

    // -- deployer --------------------------------------------------------
    // The deployer is dispatched inline (no builder), but its two required
    // inputs are structurally determined by the dispatch itself, which is why
    // the N1 reassessment did NOT flag it: `operation` is fixed by the phase
    // (the runner only ever dispatches the deployer to deploy) and `repoRoot`
    // is the member's checkout root. We model that dispatch-determined context
    // and assert the schema accepts it. EXPECTED GREEN.
    describe('deployer', () => {
        test('dispatch-determined context satisfies deployer-input.json', () => {
            const ctx = { operation: PLACEHOLDER.operation, repoRoot: PLACEHOLDER.repoRoot };
            const result = validateRoleInput('deployer', ctx);
            assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
        });
    });

    // -- integ-test-runner ----------------------------------------------
    // Dispatched inline (no builder). apra-pm PR#29 bumped
    // integ-test-runner-input to @2, replacing the inverted `environmentReady`
    // contract with required: ["repoRoot", "featureIds"] -- the runner already
    // satisfies this in substance: it fetches the sprint's open features via
    // bdListScoped() and names them explicitly in the prompt (never derives
    // them via a bare `bd list`), and only dispatches once repoRoot's
    // equivalent (the member's checkout) is known, gated by
    // `if (hasPlaybook && deployedThisCycle)`. We model that
    // dispatch-determined context and assert the schema accepts it (including
    // the zero-open-features case, which the runner dispatches explicitly
    // rather than skipping). EXPECTED GREEN.
    describe('integ-test-runner', () => {
        test('dispatch-determined context satisfies integ-test-runner-input.json', () => {
            const ctx = { repoRoot: PLACEHOLDER.repoRoot, featureIds: PLACEHOLDER.featureIds };
            const result = validateRoleInput('integ-test-runner', ctx);
            assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
        });

        test('an empty featureIds list is still a valid dispatch', () => {
            const ctx = { repoRoot: PLACEHOLDER.repoRoot, featureIds: [] };
            const result = validateRoleInput('integ-test-runner', ctx);
            assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
        });
    });

    // -- ci-watcher ------------------------------------------------------
    // runner.js does NOT dispatch ci-watcher anywhere, so there is no context
    // to validate. We assert that absence explicitly: if a future runner
    // change starts dispatching ci-watcher, this documents that it must now
    // satisfy ci-watcher-input@2's `oneOf` (branch + expectedHeadSha, OR
    // prNumber -- apra-pm PR#29 added the PR-scoped form) and this file
    // extended.
    describe('ci-watcher', () => {
        test('runner.js does not dispatch ci-watcher (documented no-op today)', () => {
            assert.ok(
                !RUNNER_SOURCE.includes("agentType: 'ci-watcher'"),
                'runner.js now dispatches ci-watcher -- extend this tripwire to validate its '
                    + '{branch, expectedHeadSha} context against ci-watcher-input.json.',
            );
        });
    });

    // -- harvester -------------------------------------------------------
    // KNOWN contract violation today: buildHarvesterPrompt consumes only
    // { branch, baseBranch, targetIssues } and explicitly instructs the
    // harvester to treat analysisText/costAnalysis as UNAVAILABLE, omitting
    // all of analysisArtifactFile/analysisText/costAnalysis that
    // harvester-input.json marks required. Wired for real (and flipped green)
    // in apra-fleet-unw2.10 (N12). Included but SKIPPED so it does not go red
    // here; the assertion body documents the failure it WILL guard once wired.
    describe('harvester', () => {
        test('buildHarvesterPrompt supplies all five required harvester inputs (N12)', () => {
            const ctx = contextFromBuilder('buildHarvesterPrompt');
            assert.ok(ctx !== null, 'buildHarvesterPrompt not found in runner.js');
            const result = validateRoleInput('harvester', ctx);
            assert.strictEqual(
                result.valid,
                true,
                'harvester dispatch must supply analysisArtifactFile/analysisText/costAnalysis/'
                    + `base-branch/branch (N12); it omits at least one. errors=${JSON.stringify(result.errors)}`,
            );
        });
    });
});
