import { test, describe } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    findCallSites,
    splitTopLevelArgs,
    objectLiteralFor,
    objectEntries,
    spreadsOf,
    numericConstant,
    innermostEnclosingCall,
    regionBetween,
    stripComments,
    dispatchLadderModulePaths,
    moduleSetSource,
} from './helpers/dispatch-pin-scanner.mjs';
import {
    reviewerVerdict,
    doerReport,
    deployerReport,
    integReport,
    finalVerdict,
    regressionReport,
    harvesterReport,
} from '../fleet-sprint/contracts.mjs';
import { KB_SELF_INJECTING_ROLES } from '../fleet-sprint/runner.js';

// =============================================================================
// apra-fleet-3swo.5.6 -- EXECUTION-ROLE dispatch behaviour pins.
//
// Sibling of planning-role-dispatch-pins.test.mjs (apra-fleet-3swo.5.1); read
// that file's header for the shared rationale (both land BEFORE any
// dispatchRole engine code exists, both pin TODAY's unrefactored runner.js,
// both anchor structurally rather than by line number, and both share
// ./helpers/dispatch-pin-scanner.mjs).
//
// SCOPE (execution and verification side, seven ladders, fourteen dispatches
// -- each role has a max_turns-exhaustion resume):
//   1. reviewer (per-round)     5. final review
//   2. doer                     6. regression-test-runner
//   3. deployer                 7. harvester
//   4. integ-test-runner
//
// Per-role variances pinned below: the integ INCONCLUSIVE path, the
// regression phase's load-bearing catch-all, the final-review auth-heal
// short-circuit, the deployer's sprintSelfId, the exact set of pushCode:true
// dispatches, and final review resolving to the REVIEWER role member.
//
// CORRECTION TO THIS TASK'S BRIEF, verified against the tree these pins were
// written on: the brief asserted the pushCode:true set was exactly
// "doer-resume and harvester". It is not -- it is FOUR dispatches: the doer's
// MAIN dispatch and its resume, plus the harvester's main dispatch and its
// resume (dispatch-sync-bracket-coverage.test.mjs independently counts the
// same four). The pin below records the real set; the code wins over the
// brief.
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FLEET_SPRINT_DIR = path.join(__dirname, '..', 'fleet-sprint');
// SRC now scans the module SET dispatch-pin-scanner.mjs defines
// (DISPATCH_LADDER_MODULES: runner.js today, plus role-policies.mjs and,
// once it exists, dispatch-role.mjs), not one hard-coded runner.js path --
// see that file's header for why. Every pin below is unchanged: they all
// still resolve against runner.js's real text, which is still exactly
// what is in SRC today.
const SRC = moduleSetSource(dispatchLadderModulePaths(FLEET_SPRINT_DIR));

const AGENT_SITES = findCallSites(SRC, 'agent');
const WITH_GIT_SYNC_SITES = findCallSites(SRC, 'withGitSync', { excludeDeclaration: true });
const WATCHDOG_SITES = findCallSites(SRC, 'withDispatchWatchdog', { excludeDeclaration: true });

function resolveTurns(expr) {
    if (expr === null || expr === undefined) return null;
    const m = /^([A-Za-z_$][\w$]*)(?:\s*\*\s*(\d+))?$/.exec(expr.trim());
    if (!m) return null;
    const base = numericConstant(SRC, m[1]);
    if (base === null) return null;
    return m[2] ? base * Number(m[2]) : base;
}

function effectiveOpts(site) {
    const args = splitTopLevelArgs(site.callText);
    const inline = args.length > 1 ? args[args.length - 1] : '{}';
    const merged = new Map();
    for (const name of spreadsOf(inline)) {
        const base = objectLiteralFor(SRC, name);
        assert.ok(base, `spread base object '${name}' not found in runner.js -- the pin cannot resolve this dispatch's options.`);
        for (const [k, v] of objectEntries(base)) merged.set(k, v);
    }
    for (const [k, v] of objectEntries(inline)) merged.set(k, v);
    return { merged, inline, args };
}

function siteFor(anchor) {
    const hits = AGENT_SITES.filter((s) => s.callText.includes(anchor));
    assert.strictEqual(
        hits.length,
        1,
        `Expected exactly ONE agent() dispatch site matching anchor ${JSON.stringify(anchor)}, found ${hits.length}` +
        `${hits.length ? ` (runner.js:${hits.map((h) => h.line).join(', ')})` : ''}. Re-anchor this pin on the ladder's ` +
        `current prompt/label text rather than deleting it.`
    );
    return hits[0];
}

// -----------------------------------------------------------------------------
// The pin table. Every value was read off the CURRENT unrefactored runner.js.
//   maxTurnsExpr  -- the literal max_turns expression at the dispatch
//   maxTurnsValue -- what it resolves to, or null when it is a runtime value
//                    (the doer's escalating resume ladder), pinned separately
// -----------------------------------------------------------------------------
const EXECUTION_LADDERS = [
    {
        ladder: 'reviewer',
        name: 'reviewer (per-round, once)',
        anchor: 'acceptanceCriteriaJson,',
        member: 'reviewerPool[0]',
        agentType: "'reviewer'",
        modelTier: 'FIXED_ROLE_TIER.reviewer',
        maxTurnsExpr: 'BASE_REVIEWER_MAX_TURNS',
        maxTurnsValue: 500,
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'DISPATCH_TIMEOUT_S',
        pushCode: 'false',
        pushBeads: null,
        schema: 'reviewerVerdict',
        resume: "roundSessions.resumeArgFor('reviewer', cycle)",
    },
    {
        ladder: 'reviewer',
        name: 'reviewer (resume after max_turns exhaustion)',
        anchor: 'Continue your review exactly where you left off',
        member: 'reviewerPool[0]',
        agentType: "'reviewer'",
        modelTier: 'FIXED_ROLE_TIER.reviewer',
        maxTurnsExpr: 'BASE_REVIEWER_MAX_TURNS * 2',
        maxTurnsValue: 1000,
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'DISPATCH_TIMEOUT_S',
        pushCode: 'false',
        pushBeads: null,
        schema: 'reviewerVerdict',
        resume: 'true',
    },
    {
        ladder: 'doer',
        name: 'doer (streak)',
        anchor: '(\n                        doerPrompt,',
        member: 'doerMember',
        agentType: "'doer'",
        // The doer is the ONE role dispatched at a per-bead declared tier
        // instead of a FIXED_ROLE_TIER constant.
        modelTier: 'doerModel',
        maxTurnsExpr: 'BASE_DOER_MAX_TURNS',
        maxTurnsValue: 500,
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'DISPATCH_TIMEOUT_S',
        pushCode: 'true',
        pushBeads: 'true',
        schema: 'doerReport',
        resume: 'worklistResumeArg',
    },
    {
        ladder: 'doer',
        name: 'doer (resume after max_turns exhaustion)',
        anchor: 'Continue exactly where you left off from this same session',
        member: 'doerMember',
        agentType: "'doer'",
        // Deliberately undefined: the tier was already resolved and priced on
        // the main dispatch this resume continues.
        modelTier: 'undefined',
        maxTurnsExpr: 'maxTurns',
        maxTurnsValue: null,
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'DISPATCH_TIMEOUT_S',
        pushCode: 'true',
        pushBeads: 'true',
        schema: 'doerReport',
        resume: 'true',
    },
    {
        ladder: 'deployer',
        name: 'deployer (once)',
        anchor: '(\n                        deployerPrompt,',
        member: "getMemberForRole('deployer')",
        agentType: "'deployer'",
        modelTier: 'FIXED_ROLE_TIER.deployer',
        maxTurnsExpr: 'DEPLOYER_MAX_TURNS',
        maxTurnsValue: 500,
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'DISPATCH_TIMEOUT_S',
        pushCode: 'false',
        pushBeads: null,
        schema: 'deployerReport',
        resume: null,
    },
    {
        ladder: 'deployer',
        name: 'deployer (resume after max_turns exhaustion)',
        anchor: 'Continue the deploy exactly where you left off',
        member: "getMemberForRole('deployer')",
        agentType: "'deployer'",
        modelTier: 'FIXED_ROLE_TIER.deployer',
        maxTurnsExpr: 'DEPLOYER_MAX_TURNS * 2',
        maxTurnsValue: 1000,
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'DISPATCH_TIMEOUT_S',
        pushCode: 'false',
        pushBeads: null,
        schema: 'deployerReport',
        resume: 'true',
    },
    {
        ladder: 'integ-test-runner',
        name: 'integ test runner (once)',
        anchor: '(\n                    featurePrompt,',
        member: "getMemberForRole('integ-test-runner')",
        agentType: "'integ-test-runner'",
        modelTier: "FIXED_ROLE_TIER['integ-test-runner']",
        maxTurnsExpr: 'INTEG_TEST_MAX_TURNS',
        maxTurnsValue: 500,
        // Shorter INACTIVITY timer, longer HARD elapsed ceiling: a hung runner
        // still dies on silence, an active long pass is never killed.
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'INTEG_MAX_TOTAL_S',
        pushCode: 'false',
        pushBeads: 'true',
        schema: 'integReport',
        resume: null,
    },
    {
        ladder: 'integ-test-runner',
        name: 'integ test runner (resume after max_turns exhaustion)',
        anchor: 'Continue the integration test run exactly where you left off',
        member: "getMemberForRole('integ-test-runner')",
        agentType: "'integ-test-runner'",
        modelTier: "FIXED_ROLE_TIER['integ-test-runner']",
        maxTurnsExpr: 'INTEG_TEST_MAX_TURNS * 2',
        maxTurnsValue: 1000,
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'INTEG_MAX_TOTAL_S',
        pushCode: 'false',
        pushBeads: 'true',
        schema: 'integReport',
        resume: 'true',
    },
    {
        ladder: 'final-review',
        name: 'final review (once)',
        anchor: 'buildFinalVerdictPrompt({',
        // Final Review is the SAME reviewer role member -- not a distinct
        // final-review role.
        member: "getMemberForRole('reviewer')",
        agentType: "'reviewer'",
        modelTier: 'FIXED_ROLE_TIER.reviewer',
        maxTurnsExpr: 'FINAL_REVIEW_MAX_TURNS',
        maxTurnsValue: 500,
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'DISPATCH_TIMEOUT_S',
        pushCode: 'false',
        pushBeads: null,
        schema: 'finalVerdict',
        resume: null,
    },
    {
        ladder: 'final-review',
        name: 'final review (resume after max_turns exhaustion)',
        anchor: 'Continue your final review exactly where you left off',
        member: "getMemberForRole('reviewer')",
        agentType: "'reviewer'",
        modelTier: 'FIXED_ROLE_TIER.reviewer',
        maxTurnsExpr: 'FINAL_REVIEW_MAX_TURNS * 2',
        maxTurnsValue: 1000,
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'DISPATCH_TIMEOUT_S',
        pushCode: 'false',
        pushBeads: null,
        schema: 'finalVerdict',
        resume: 'true',
    },
    {
        ladder: 'regression-test-runner',
        name: 'regression test runner (once)',
        anchor: '(\n                    regressionPrompt,',
        member: "getMemberForRole('regression-test-runner')",
        agentType: "'regression-test-runner'",
        modelTier: "FIXED_ROLE_TIER['regression-test-runner']",
        maxTurnsExpr: 'REGRESSION_TEST_MAX_TURNS',
        maxTurnsValue: 500,
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'REGRESSION_TEST_MAX_TOTAL_S',
        pushCode: 'false',
        pushBeads: 'true',
        schema: 'regressionReport',
        resume: null,
    },
    {
        ladder: 'regression-test-runner',
        name: 'regression test runner (resume after max_turns exhaustion)',
        anchor: 'Continue the regression pass exactly where you left off',
        member: "getMemberForRole('regression-test-runner')",
        agentType: "'regression-test-runner'",
        modelTier: "FIXED_ROLE_TIER['regression-test-runner']",
        maxTurnsExpr: 'REGRESSION_TEST_MAX_TURNS * 2',
        maxTurnsValue: 1000,
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'REGRESSION_TEST_MAX_TOTAL_S',
        pushCode: 'false',
        pushBeads: 'true',
        schema: 'regressionReport',
        resume: 'true',
    },
    {
        ladder: 'harvester',
        name: 'harvester (once)',
        anchor: '(\n                harvesterPrompt,',
        member: "getMemberForRole('harvester')",
        agentType: "'harvester'",
        modelTier: 'FIXED_ROLE_TIER.harvester',
        maxTurnsExpr: 'HARVESTER_MAX_TURNS',
        maxTurnsValue: 500,
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'DISPATCH_TIMEOUT_S',
        pushCode: 'true',
        pushBeads: 'true',
        schema: 'harvesterReport',
        resume: null,
    },
    {
        ladder: 'harvester',
        name: 'harvester (resume after max_turns exhaustion)',
        anchor: 'Continue your harvest exactly where you left off',
        member: "getMemberForRole('harvester')",
        agentType: "'harvester'",
        modelTier: 'FIXED_ROLE_TIER.harvester',
        maxTurnsExpr: 'HARVESTER_MAX_TURNS * 2',
        maxTurnsValue: 1000,
        timeoutS: 'DISPATCH_TIMEOUT_S',
        maxTotalS: 'DISPATCH_TIMEOUT_S',
        pushCode: 'true',
        pushBeads: 'true',
        schema: 'harvesterReport',
        resume: 'true',
    },
];

describe('execution-role dispatch ladders: per-dispatch pins', () => {
    for (const pin of EXECUTION_LADDERS) {
        test(`${pin.name}: member routing, bracketing, turns, timeout, watchdog, KB and verdict schema`, () => {
            const site = siteFor(pin.anchor);
            const { merged } = effectiveOpts(site);

            // --- member routing -------------------------------------------------
            assert.strictEqual(merged.get('member_name'), pin.member, `${pin.name} must route to ${pin.member}.`);

            // --- model tier -----------------------------------------------------
            assert.strictEqual(merged.get('model'), pin.modelTier, `${pin.name} must dispatch at model ${pin.modelTier}.`);

            // --- turn budget and timeout ----------------------------------------
            assert.strictEqual(
                merged.get('max_turns') ?? null,
                pin.maxTurnsExpr,
                `${pin.name} must pass max_turns=${pin.maxTurnsExpr}.`
            );
            assert.strictEqual(
                resolveTurns(merged.get('max_turns') ?? null),
                pin.maxTurnsValue,
                `${pin.name}'s max_turns must resolve to ${pin.maxTurnsValue} (null = a runtime value, pinned separately).`
            );
            assert.strictEqual(merged.get('timeout_s') ?? null, pin.timeoutS, `${pin.name} must pass timeout_s ${pin.timeoutS}.`);
            assert.strictEqual(merged.get('max_total_s') ?? null, pin.maxTotalS, `${pin.name} must pass max_total_s ${pin.maxTotalS}.`);

            // --- same-session resume flag ---------------------------------------
            assert.strictEqual(
                merged.get('resume') ?? null,
                pin.resume,
                `${pin.name} must pass resume=${pin.resume === null ? '(absent)' : pin.resume}.`
            );

            // --- git sync bracketing and push flags -----------------------------
            const bracket = innermostEnclosingCall(WITH_GIT_SYNC_SITES, site.index);
            assert.ok(bracket, `${pin.name} must be wrapped in a withGitSync(...) bracket -- every execution-side dispatch is.`);
            const bracketArgs = splitTopLevelArgs(bracket.callText);
            assert.strictEqual(
                bracketArgs[0],
                pin.member,
                `${pin.name}'s withGitSync bracket must sync the SAME member the dispatch routes to (${pin.member}).`
            );
            assert.strictEqual(bracketArgs[1], pin.pushCode, `${pin.name}'s withGitSync bracket must pass pushCode=${pin.pushCode}.`);
            const bracketOpts = bracketArgs.length > 3 ? objectEntries(bracketArgs[3]) : new Map();
            assert.strictEqual(
                bracketOpts.get('pushBeads') ?? null,
                pin.pushBeads,
                `${pin.name}'s withGitSync bracket must pass pushBeads=${pin.pushBeads === null ? '(absent)' : pin.pushBeads}.`
            );

            // --- watchdog arming ------------------------------------------------
            // No execution-side dispatch arms a client-side watchdog today; they
            // rely on the server-side timeout_s/max_total_s pair above.
            assert.strictEqual(
                innermostEnclosingCall(WATCHDOG_SITES, site.index),
                null,
                `${pin.name} is NOT raced against withDispatchWatchdog today -- only the planner-side dispatches are.`
            );

            // --- KB knowledge injection -----------------------------------------
            const agentType = merged.get('agentType') ?? null;
            assert.strictEqual(agentType, pin.agentType, `${pin.name} must pass agentType=${pin.agentType}.`);
            const role = agentType.replace(/^['"]|['"]$/g, '');
            const fromWrapper = !KB_SELF_INJECTING_ROLES.has(role);
            assert.strictEqual(
                fromWrapper,
                !['doer', 'reviewer'].includes(role),
                `${pin.name}: doer and reviewer place their own KNOWLEDGE BANK block from their prompt builders; every ` +
                `other execution role receives it from the agent() wrapper.`
            );

            // --- returnable verdicts --------------------------------------------
            assert.strictEqual(merged.get('schema') ?? null, pin.schema, `${pin.name} must pass schema=${pin.schema}.`);

            // --- sprint_id ------------------------------------------------------
            assert.strictEqual(
                merged.get('sprint_id') ?? null,
                null,
                `${pin.name} must NOT pass its own sprint_id -- the agent() wrapper supplies the sprint-identity token for every dispatch.`
            );
        });
    }
});

describe('execution-role dispatch: cross-cutting invariants', () => {
    test('the pin table covers every execution-side dispatch runner.js makes', () => {
        // 22 agent() sites total: 8 planning-side (pinned by the sibling file)
        // and the 14 pinned here. A new role dispatch lands in neither table
        // and fails this count.
        assert.strictEqual(
            AGENT_SITES.length,
            22,
            `Expected 22 agent() dispatch sites in runner.js, found ${AGENT_SITES.length}. A new dispatch must be added to ` +
            `this pin table (execution/verification side) or to the planning-side pin file, not left unpinned.`
        );
        assert.strictEqual(EXECUTION_LADDERS.length, 14, 'Seven execution-side ladders, each with a max_turns-exhaustion resume.');
        const lines = new Set(EXECUTION_LADDERS.map((pin) => siteFor(pin.anchor).line));
        assert.strictEqual(lines.size, 14, 'Each pin must anchor a DISTINCT dispatch site -- two pins resolving to one site would leave a dispatch unpinned.');
    });

    test('pushCode:true is exactly the doer and harvester dispatch pairs', () => {
        // NOTE: this task's brief claimed the set was "doer-resume and
        // harvester". The tree says otherwise -- the doer's MAIN dispatch and
        // the harvester's resume are pushCode:true as well. These are the four
        // code-writing dispatches; every other role is read-side.
        const pushCodeTrue = EXECUTION_LADDERS.filter((pin) => pin.pushCode === 'true').map((pin) => pin.name);
        assert.deepStrictEqual(
            pushCodeTrue.sort(),
            [
                'doer (resume after max_turns exhaustion)',
                'doer (streak)',
                'harvester (once)',
                'harvester (resume after max_turns exhaustion)',
            ],
            'Exactly the doer and harvester dispatch pairs write code and therefore G-push.'
        );
        // Independently re-derived from the source rather than from the table
        // above, so a table edit alone cannot move this pin.
        const truesInSource = WITH_GIT_SYNC_SITES.filter((s) => {
            const args = splitTopLevelArgs(s.callText);
            return args[1] === 'true';
        });
        assert.strictEqual(
            truesInSource.length,
            4,
            `Expected exactly 4 withGitSync(...) call sites with pushCode:true, found ${truesInSource.length} ` +
            `(runner.js:${truesInSource.map((s) => s.line).join(', ')}).`
        );
        for (const pin of EXECUTION_LADDERS.filter((p) => p.ladder === 'harvester')) {
            assert.strictEqual(pin.pushBeads, 'true', 'The harvester also defers low-priority beads, so it D-pushes as well as G-pushes.');
        }
    });

    test('final review resolves to the reviewer ROLE member, while per-round review dispatches to the reviewer pool head', () => {
        const stripped = stripComments(SRC);
        assert.ok(
            /const reviewerPool = getMembersForRole\(ROLE_REVIEWER\);/.test(stripped),
            'The per-round reviewer pool must be built from the reviewer role, which is what makes pool head and role member the same role.'
        );
        for (const anchor of ['acceptanceCriteriaJson,', 'Continue your review exactly where you left off']) {
            assert.strictEqual(effectiveOpts(siteFor(anchor)).merged.get('member_name'), 'reviewerPool[0]');
        }
        for (const anchor of ['buildFinalVerdictPrompt({', 'Continue your final review exactly where you left off']) {
            assert.strictEqual(
                effectiveOpts(siteFor(anchor)).merged.get('member_name'),
                "getMemberForRole('reviewer')",
                'Final Review has no distinct role member of its own -- it shares the reviewer role resolution.'
            );
        }
        assert.strictEqual(
            effectiveOpts(siteFor('buildFinalVerdictPrompt({')).merged.get('agentType'),
            "'reviewer'",
            'Final Review dispatches the reviewer persona.'
        );
    });

    test('every execution-side dispatch inherits sprint_id and its KB block from the one agent() wrapper', () => {
        const stripped = stripComments(SRC);
        assert.ok(
            /agentRaw\(\s*finalPrompt\s*,\s*\{\s*sprint_id:\s*sprintMutexId\s*,\s*\.\.\.opts\s*\}\s*\)/.test(stripped),
            'The agent() wrapper must pass sprint_id into every underlying dispatch.'
        );
        assert.deepStrictEqual(
            [...KB_SELF_INJECTING_ROLES].sort(),
            ['doer', 'reviewer'],
            'Exactly the doer and reviewer place their own knowledge block; a role added to the set without updating its prompt builder gets none.'
        );
        // The three self-injecting prompt builders really do carry the block.
        for (const builderCall of ['buildDoerPrompt({', 'buildReviewerPrompt({', 'buildFinalVerdictPrompt({']) {
            const call = findCallSites(SRC, builderCall.replace('({', ''))[0];
            assert.ok(call, `${builderCall} call site not found in runner.js.`);
            assert.ok(
                /kbKnowledge:/.test(call.callText),
                `${builderCall} must be handed kbKnowledge explicitly -- its role is excluded from the agent() wrapper injection.`
            );
        }
        // ...and the wrapper-fed roles pass no kbKnowledge of their own.
        for (const anchor of ['(\n                        deployerPrompt,', '(\n                    featurePrompt,', '(\n                    regressionPrompt,', '(\n                harvesterPrompt,']) {
            assert.ok(
                !/kbKnowledge/.test(siteFor(anchor).callText),
                'A wrapper-fed role must not also inject its own knowledge block, or it would receive the block twice.'
            );
        }
    });

    test('the deployer prompt carries the sprint\'s own reservation id so its active-sprints gate cannot self-block', () => {
        const region = stripComments(regionBetween(SRC, 'const sprintSelfId =', 'const deployerDispatchOpts'));
        assert.ok(
            /const sprintSelfId = validated\.runId \|\| validated\.branch;/.test(region),
            'sprintSelfId is the forwarded --run-id, falling back to the branch name for a direct/standalone launch -- the same key the supervisor reserves under.'
        );
        assert.ok(
            /sprintId\): \$\{sprintSelfId\}/.test(region),
            'The deployer prompt must state the sprint\'s OWN reservation id, or the deploy runbook gate treats the sprint\'s own reservation as a foreign one and stops.'
        );
        assert.ok(
            /Stop only\s*'?\s*\+?\s*'?for a reservation with a different sprintId/.test(region),
            'The prompt must tell the deployer to stop only for a FOREIGN reservation.'
        );
    });
});

describe('execution-role dispatch: retry and degrade ladders', () => {
    test('reviewer: two attempts, max_turns resume, and infrastructure failures degrade to CHANGES_NEEDED marked dispatchFailed', () => {
        const region = stripComments(regionBetween(SRC, 'for (let reviewAttempt = 1;', 'if (!isReviewerContractViolation(verdict)) {'));
        assert.ok(/reviewAttempt <= 2/.test(region), 'The reviewer gets exactly one extra infrastructure attempt per round.');
        assert.ok(
            /err instanceof AgentDispatchError && err\.details\?\.reason === 'max_turns_exhausted'/.test(region),
            'Turn exhaustion resumes the same session rather than restarting the review.'
        );
        assert.ok(/memberSessionGuard\.killIfAlive\(reviewerPool\[0\]\)/.test(region), 'A still-alive exhausted session is killed before the resume.');
        const changesNeeded = region.match(/verdict: 'CHANGES_NEEDED'/g) || [];
        assert.strictEqual(changesNeeded.length, 2, 'Both degrade paths (schema-repair exhaustion, dispatch/sync failure) synthesize CHANGES_NEEDED.');
        assert.strictEqual((region.match(/dispatchFailed: true/g) || []).length, 2, 'Both synthesized verdicts are marked dispatchFailed so the contract-violation guard never mistakes them for a self-contradictory verdict.');
        assert.ok(!/verdict: 'APPROVED'/.test(region), 'No reviewer degrade path may synthesize an APPROVED verdict.');
        assert.ok(
            /err instanceof GitSyncError/.test(region) && /err instanceof DoltSyncError/.test(region),
            'The review\'s own read-side sync bracket failures degrade identically to a dispatch failure.'
        );
        assert.ok(
            !/GitDivergedError/.test(region) && !/DoltDivergedError/.test(region),
            'A real divergence is a branch integrity problem and must still propagate rather than degrade to a verdict.'
        );
        assert.ok(/roundSessions\.clear\('reviewer'\)/.test(region), 'A failed round must not leave its session to be resumed by the next round.');
        assert.ok(/throw err;/.test(region), 'An unrecognised error class still propagates.');
    });

    test('doer: bounded escalating resume ladder, closed-streak short-circuit, and no re-dispatch after a post-dispatch sync failure', () => {
        const region = stripComments(regionBetween(SRC, 'report = await dispatchDoer();', 'Per-bead failure attribution'));
        assert.strictEqual(numericConstant(SRC, 'MAX_TURN_RESUME_ATTEMPTS'), 2, 'The doer resume ladder is bounded at two attempts.');
        assert.strictEqual(numericConstant(SRC, 'BASE_DOER_MAX_TURNS'), 500, 'The doer streak turn base.');
        assert.ok(
            /let currentMaxTurns = BASE_DOER_MAX_TURNS \* 2;/.test(region),
            'The first resume doubles the base turn budget.'
        );
        assert.ok(/currentMaxTurns \*= 2;/.test(region), 'Each further turn exhaustion doubles again.');
        assert.ok(
            /while \(resumeAttempt < MAX_TURN_RESUME_ATTEMPTS\)/.test(region),
            'The escalation is bounded by MAX_TURN_RESUME_ATTEMPTS, never unbounded.'
        );
        assert.ok(
            /verifyDoerStreakClosed\(/.test(region) && /preResumeUnclosed\.length === 0/.test(region),
            'A turn-exhausted streak whose beads are ALL already closed is a success (the doer merely missed its VERIFY checkpoint) and gets NO resume dispatch.'
        );
        assert.ok(
            /isPostDispatchSyncFailure\(err\)/.test(region),
            'A completed streak whose post-dispatch sync failed must NOT be re-dispatched -- the work is already committed locally.'
        );
        assert.ok(
            /isNonRetryableDispatchError\(err\)/.test(region) && /isAuthDispatchError\(err\) && typeof onLlmAuthFailure === 'function'/.test(region),
            'An auth failure gets one self-heal plus one bounded retry; a workspace-trust failure is not retried at all.'
        );
        assert.ok(
            /dispatchDoer\(\{ resumeOntoRemoteTip: true \}\)/.test(region),
            'The generic retry resumes onto the streak branch remote tip so it builds on already-published work instead of creating a divergent duplicate commit.'
        );
    });

    test('deployer: max_turns resume, then any infrastructure failure degrades to deployed:false', () => {
        const region = stripComments(regionBetween(SRC, 'const DEPLOYER_MAX_TURNS', 'deployedThisCycle = deployResult.deployed === true;'));
        assert.ok(/memberSessionGuard\.killIfAlive\(getMemberForRole\('deployer'\)\)/.test(region), 'The deployer resume kills a still-alive session first.');
        assert.strictEqual(
            (region.match(/deployed: false/g) || []).length,
            2,
            'Both degrade paths (schema-repair exhaustion and dispatch/transport failure) record deployed:false.'
        );
        assert.ok(!/deployed: true/.test(region), 'No degrade path may synthesize a successful deploy.');
        assert.ok(/isAuthDispatchError\(err\) && typeof onLlmAuthFailure === 'function'/.test(region), 'An auth failure self-heals so the next cycle\'s deploy is not walled off identically.');
        assert.ok(/throw err;/.test(region), 'An unrecognised error class still propagates.');
    });

    test('integ: an infrastructure dispatch failure is INCONCLUSIVE, never a false test FAIL', () => {
        const region = stripComments(regionBetween(SRC, 'const dispatchIntegOnce =', 'Feature closure is judged'));
        assert.ok(
            /isInfraDispatchFailure\(err\)/.test(region),
            'The integ ladder must separate an INFRA dispatch failure (no result envelope) from a genuine test verdict.'
        );
        assert.ok(
            /integInfraInconclusive = \{ reason: err\.details\?\.reason \?\? 'unknown', message: err\.message \};/.test(region),
            'A persistent infra failure records the INCONCLUSIVE marker rather than a verdict.'
        );
        // The single infra resume retry, distinct from the max_turns resume.
        assert.strictEqual(
            (region.match(/integResult = await dispatchIntegResume\(\);/g) || []).length,
            2,
            'There are exactly two paths into the resume dispatch: max_turns exhaustion and ONE infra-failure recovery attempt.'
        );
        assert.ok(
            /passed: false/.test(region),
            'The stubbed integResult keeps downstream references defined; the INCONCLUSIVE branch owns what is actually recorded.'
        );
        assert.ok(
            /err instanceof AgentDispatchError && isInfraDispatchFailure\(err\)/.test(region),
            'The INCONCLUSIVE branch must be reached only for an infra-flavoured dispatch error.'
        );
        assert.ok(/throw err;/.test(region), 'An unrecognised error class still propagates.');
    });

    test('final review: the auth self-heal short-circuits the generic retry so a healed verdict is never discarded', () => {
        const region = stripComments(regionBetween(SRC, 'let handledByAuthSelfHeal = false;', 'No duplicate log() dump -- see dispatchReview() for why.'));
        assert.ok(/let healedByLlmAuthSelfHeal = false;/.test(region), 'The heal path tracks whether it produced a verdict.');
        assert.ok(
            /if \(!healedByLlmAuthSelfHeal\) throw err;/.test(region),
            'A non-retryable error that could NOT be healed must still propagate.'
        );
        assert.ok(
            /handledByAuthSelfHeal = true;/.test(region) && /if \(!handledByAuthSelfHeal\) \{/.test(region),
            'A healed final review must SHORT-CIRCUIT the generic retry-once ladder -- otherwise a second full Final Review fires and silently discards the healed verdict.'
        );
        // Every degrade lands on FAIL; a dead dispatch channel never passes a sprint.
        assert.strictEqual(
            (region.match(/verdict: 'FAIL'/g) || []).length,
            4,
            'All four degrade paths (heal-retry schema/dispatch failure, generic-retry schema/dispatch failure) record FAIL.'
        );
        assert.ok(!/verdict: 'PASS'/.test(region), 'No final-review degrade path may synthesize a PASS.');
        assert.ok(
            /finalVerdictResult = await runFinalReviewAttempt\(\);/.test(region),
            'The retry re-runs the whole attempt helper, so the retry inherits the max_turns resume too.'
        );
    });

    test('regression: a load-bearing catch-all keeps an informational phase from ever aborting the sprint', () => {
        const region = stripComments(regionBetween(SRC, 'const regressionDispatchOpts', 'Harvest'));
        assert.ok(
            /\} catch \(err\) \{/.test(region),
            'The regression phase must wrap its dispatch in a catch.'
        );
        // Deliberately NO instanceof filtering on the outer catch: sync-layer
        // aborts (divergence classes) must be swallowed here too.
        const outerCatch = stripComments(regionBetween(SRC, 'A regression-phase infrastructure failure must never abort', 'Harvest'));
        assert.ok(
            !/throw /.test(outerCatch),
            'The regression catch-all must never rethrow: a D-push failure while filing carry-over bugs would otherwise turn a green sprint into a terminal ABORTED record, skipping Harvest and Publish PR.'
        );
        assert.ok(
            /memberSessionGuard\.killIfAlive\(getMemberForRole\('regression-test-runner'\)\)/.test(region),
            'The regression resume kills a still-alive session first.'
        );
        assert.ok(
            /regressionResult\.passed !== true/.test(region),
            'Only an explicit passed:true is treated as a green regression pass.'
        );
    });

    test('harvester: max_turns resume, and any failure proceeds without a validated report rather than failing the sprint', () => {
        const region = stripComments(regionBetween(SRC, 'const harvesterDispatchOpts', '7. Publish: push the sprint branch'));
        assert.ok(/memberSessionGuard\.killIfAlive\(getMemberForRole\('harvester'\)\)/.test(region), 'The harvester resume kills a still-alive session first.');
        assert.ok(
            /proceeding without a validated harvester report/.test(region),
            'A harvester schema/dispatch failure degrades to proceeding without a report -- the sprint verdict is already decided by this point.'
        );
        assert.ok(
            /isAuthDispatchError\(err\) && typeof onLlmAuthFailure === 'function'/.test(region),
            'The harvester still self-heals an auth failure: the same member and credentials are reused by the NEXT sprint.'
        );
        assert.ok(/throw err;/.test(region), 'An unrecognised error class still propagates.');
        assert.ok(
            /kbWork\.apply\('harvester'/.test(region),
            'The harvester report\'s kb_captures are applied through kbWork -- capture only, since promotions are reviewer-only.'
        );
    });
});

describe('execution-role dispatch: returnable verdicts', () => {
    test('each execution role can return exactly the verdict vocabulary its ladder branches on', () => {
        assert.deepStrictEqual(reviewerVerdict.properties.verdict.enum, ['APPROVED', 'CHANGES_NEEDED']);
        assert.deepStrictEqual(reviewerVerdict.required, ['verdict', 'notes', 'reopenIds', 'newTasks']);
        assert.deepStrictEqual(doerReport.properties.status.enum, ['VERIFY', 'BLOCKED']);
        assert.deepStrictEqual(doerReport.required, ['status', 'closedIds', 'notes']);
        assert.strictEqual(deployerReport.properties.deployed.type, 'boolean');
        assert.deepStrictEqual(deployerReport.required, ['deployed', 'notes']);
        assert.strictEqual(integReport.properties.passed.type, 'boolean');
        assert.deepStrictEqual(integReport.required, ['featuresClosed', 'issuesCreated', 'passed', 'bugsFiled', 'summary']);
        assert.deepStrictEqual(finalVerdict.properties.verdict.enum, ['PASS', 'FAIL']);
        assert.deepStrictEqual(finalVerdict.required, ['verdict', 'notes']);
        assert.strictEqual(regressionReport.properties.passed.type, 'boolean');
        assert.deepStrictEqual(regressionReport.required, ['passed', 'suitePassed', 'smokePassed', 'bugsFiled', 'summary']);
        assert.deepStrictEqual(harvesterReport.properties.status.enum, ['OK', 'FAILED']);
        assert.deepStrictEqual(harvesterReport.required, ['status', 'notes']);
    });
});
