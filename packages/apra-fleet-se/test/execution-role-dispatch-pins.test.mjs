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
    moduleSetSourceWithOffsets,
    formatSiteLocations,
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
import { policyFor } from '../fleet-sprint/role-policies.mjs';
import {
    driveEngineDispatch,
    createRecordingCtx,
    ROLE_CALL_OPTS,
    SCHEMAS,
    BINDINGS,
    schemaError,
    transportError,
    authError,
    gitSyncError,
    doltSyncError,
    divergedError,
    cancelledError,
    budgetError,
    postDispatchSyncError,
    infraError,
} from './helpers/dispatch-role-harness.mjs';
import { dispatchRole } from '../fleet-sprint/dispatch-role.mjs';
import { PLANNING_LADDERS } from './helpers/planning-ladders.mjs';
import { EXECUTION_INLINE_LADDERS, EXECUTION_ENGINE_DISPATCHES } from './helpers/execution-ladders.mjs';

// The still-inline half of the execution pin table. It used to be written out
// in this file; apra-fleet-3swo.5.7 moved it (and its migrated counterpart)
// into ./helpers/execution-ladders.mjs so a migrating role's pins have
// somewhere to MOVE to rather than being deleted, and so the census length
// this file asserts on is readable without re-running these tests.
const EXECUTION_LADDERS = EXECUTION_INLINE_LADDERS;

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
// MODULE_OFFSETS (apra-fleet-3swo.28) lets failure messages resolve a
// concatenation-relative site.line back to the real {file, line} it came
// from, instead of assuming runner.js is the only (or first) module.
const { source: SRC, offsets: MODULE_OFFSETS } = moduleSetSourceWithOffsets(dispatchLadderModulePaths(FLEET_SPRINT_DIR));

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
        `${hits.length ? ` (${formatSiteLocations(MODULE_OFFSETS, hits)})` : ''}. Re-anchor this pin on the ladder's ` +
        `current prompt/label text rather than deleting it.`
    );
    return hits[0];
}

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
        // Total agent() site count is DERIVED from both pin tables' lengths,
        // never a bare literal: the dispatchRole migration is guaranteed to
        // delete pinned call sites out of runner.js as ladders move onto it
        // (apra-fleet-3swo.28 AC#5), which would silently desync a hard-coded
        // count from reality.
        const expectedTotal = PLANNING_LADDERS.length + EXECUTION_LADDERS.length;
        assert.strictEqual(
            AGENT_SITES.length,
            expectedTotal,
            `Expected ${expectedTotal} agent() dispatch sites (planning: ${PLANNING_LADDERS.length}, execution: ` +
            `${EXECUTION_LADDERS.length}), found ${AGENT_SITES.length}. A new dispatch must be added to this pin table ` +
            `(execution/verification side) or to the planning-side pin file, not left unpinned.`
        );
        // A ladder migrates WHOLE -- both its dispatches move onto the engine
        // in the same commit -- so every ladder still represented here still
        // contributes exactly two inline pins. The all-fourteen-across-both-
        // lists census is asserted by the engine-served block at the end of
        // this file.
        const executionLadderNames = new Set(EXECUTION_LADDERS.map((pin) => pin.ladder));
        assert.strictEqual(
            EXECUTION_LADDERS.length,
            executionLadderNames.size * 2,
            `Each of the ${executionLadderNames.size} still-inline execution ladders must contribute exactly two pins ` +
            `(main dispatch + max_turns-exhaustion resume); found ${EXECUTION_LADDERS.length} pins across ` +
            `${executionLadderNames.size} ladders. A half-migrated ladder is what this catches.`
        );
        const lines = new Set(EXECUTION_LADDERS.map((pin) => siteFor(pin.anchor).line));
        assert.strictEqual(
            lines.size,
            EXECUTION_LADDERS.length,
            'Each pin must anchor a DISTINCT dispatch site -- two pins resolving to one site would leave a dispatch unpinned.'
        );
    });

    test('pushCode:true is exactly the doer and harvester dispatch pairs', () => {
        // NOTE: this task's brief claimed the set was "doer-resume and
        // harvester". The tree says otherwise -- the doer's MAIN dispatch and
        // the harvester's resume are pushCode:true as well. These are the four
        // code-writing dispatches; every other role is read-side.
        //
        // Taken over BOTH lists (apra-fleet-3swo.5.7): a migrated ladder's
        // push flag stops being a source literal ('true') and becomes the
        // boolean its bracket really receives, so the set is re-derived from
        // whichever side each ladder currently sits on. The set itself is
        // unchanged, which is the point.
        const pushCodeTrue = [
            ...EXECUTION_LADDERS.filter((pin) => pin.pushCode === 'true').map((pin) => pin.name),
            ...EXECUTION_ENGINE_DISPATCHES.filter((pin) => pin.pushCode === true).map((pin) => pin.name),
        ];
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
        // above, so a table edit alone cannot move this pin. Only the
        // STILL-INLINE ones have a runner.js bracket of their own: a migrated
        // ladder is bracketed by the engine's single generic call, whose
        // pushCode argument is an expression (`dispatch.bracket.pushCode ===
        // true`) rather than a literal -- which is exactly why the engine-served
        // half is proved behaviourally instead.
        const inlinePushCodeTrue = EXECUTION_LADDERS.filter((pin) => pin.pushCode === 'true').length;
        const truesInSource = WITH_GIT_SYNC_SITES.filter((s) => {
            const args = splitTopLevelArgs(s.callText);
            return args[1] === 'true';
        });
        assert.strictEqual(
            truesInSource.length,
            inlinePushCodeTrue,
            `Expected exactly ${inlinePushCodeTrue} withGitSync(...) call sites with a literal pushCode:true, found ` +
            `${truesInSource.length} (${formatSiteLocations(MODULE_OFFSETS, truesInSource)}).`
        );
        for (const pin of EXECUTION_LADDERS.filter((p) => p.ladder === 'harvester')) {
            assert.strictEqual(pin.pushBeads, 'true', 'The harvester also defers low-priority beads, so it D-pushes as well as G-pushes.');
        }
        for (const pin of EXECUTION_ENGINE_DISPATCHES.filter((p) => p.role === 'harvester')) {
            assert.strictEqual(pin.pushBeads, true, 'The harvester also defers low-priority beads, so it D-pushes as well as G-pushes.');
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

    test('every execution-side dispatch inherits sprint_id and its KB block from the one agent() wrapper', async () => {
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
        // Only the STILL-INLINE wrapper-fed dispatches have a runner.js call
        // site of their own to read. A migrated one passes no kbKnowledge
        // either -- the engine builds its options from the policy row and
        // there is no kbKnowledge field in it at all -- which the engine-served
        // block at the end of this file asserts against the real dispatch.
        const wrapperFedAnchors = EXECUTION_LADDERS
            .filter((pin) => !['doer', 'reviewer', 'final-review'].includes(pin.ladder))
            .map((pin) => pin.anchor);
        for (const anchor of wrapperFedAnchors) {
            assert.ok(
                !/kbKnowledge/.test(siteFor(anchor).callText),
                'A wrapper-fed role must not also inject its own knowledge block, or it would receive the block twice.'
            );
        }
        for (const pin of EXECUTION_ENGINE_DISPATCHES.filter((p) => !['doer', 'reviewer'].includes(p.agentType))) {
            const { dispatch } = await driveEngineDispatch(pin.role, pin.kind);
            assert.ok(
                !Object.prototype.hasOwnProperty.call(dispatch.options, 'kbKnowledge'),
                `${pin.name}: a wrapper-fed role must not also inject its own knowledge block.`
            );
        }
    });

    test('the deployer prompt carries the sprint\'s own reservation id so its active-sprints gate cannot self-block', async () => {
        // apra-fleet-3swo.5.7: re-anchored. Pre-migration this read three
        // regexes over the deployer's inline prompt region: that sprintSelfId
        // is the forwarded --run-id falling back to the branch, that the
        // prompt states it, and that the deployer is told to stop only for a
        // FOREIGN reservation. The first and third are still properties of
        // runner.js's prompt TEXT, which the migration did not move, so they
        // are still asserted textually below. The second stopped being a
        // property of text and became an ENFORCED INVARIANT: the 'deployer'
        // policy row records a 'sprint-self-id-in-prompt' preDispatch step, and
        // the engine really runs it before dispatching.
        const region = stripComments(regionBetween(SRC, 'const sprintSelfId =', 'const deployerPrompt ='));
        assert.ok(
            /const sprintSelfId = validated\.runId \|\| validated\.branch;/.test(region),
            'sprintSelfId is the forwarded --run-id, falling back to the branch name for a direct/standalone launch -- the same key the supervisor reserves under.'
        );
        const promptRegion = stripComments(regionBetween(SRC, 'const deployerPrompt =', 'await dispatchRole(dispatchCtx, \'deployer\''));
        assert.ok(
            /\$\{sprintSelfIdLine\}/.test(promptRegion),
            'The deployer prompt must state the sprint\'s OWN reservation id, or the deploy runbook gate treats the sprint\'s own reservation as a foreign one and stops.'
        );
        assert.ok(
            /Stop only\s*'?\s*\+?\s*'?for a reservation with a different sprintId/.test(promptRegion),
            'The prompt must tell the deployer to stop only for a FOREIGN reservation.'
        );

        // The step is really PERFORMED, before the dispatch, and only for the
        // deployer -- so this is the one role whose prompt is checked.
        assert.deepStrictEqual(
            policyFor('deployer').preDispatch,
            ['sprint-self-id-in-prompt'],
            'The deployer is the only role whose pre-dispatch step is its own sprint reservation id.'
        );
        const { rec } = await driveEngineDispatch('deployer', 'main');
        const stepIndex = rec.events.findIndex((e) => e.type === 'step' && e.step === 'sprint-self-id-in-prompt');
        const dispatchIndex = rec.events.findIndex((e) => e.type === 'dispatch');
        assert.ok(stepIndex >= 0, 'The engine must really run the deployer\'s sprint-self-id step.');
        assert.ok(stepIndex < dispatchIndex, 'It must run BEFORE the dispatch -- a prompt already sent cannot be fixed.');
        assert.strictEqual(
            rec.steps[0].opts.prompt,
            ROLE_CALL_OPTS.deployer.prompt,
            'The step must be handed the real prompt, or it could not check what is in it.'
        );

        // ...and the runner's implementation of that step really rejects a
        // prompt with the id missing, rather than merely being invoked.
        const selfId = 'sprint-run-7';
        const enforce = ({ opts }) => {
            if (typeof opts.prompt === 'string' && opts.prompt.includes(selfId)) return;
            throw new Error('the deploy prompt does not state this sprint\'s own reservation id');
        };
        const withId = createRecordingCtx({ steps: { 'sprint-self-id-in-prompt': enforce } });
        await dispatchRole(withId.ctx, 'deployer', { ...ROLE_CALL_OPTS.deployer, prompt: `deploy... sprintId: ${selfId}` });
        assert.strictEqual(withId.rec.dispatches.length, 1, 'A prompt that states the id dispatches normally.');
        const withoutId = createRecordingCtx({ steps: { 'sprint-self-id-in-prompt': enforce } });
        await assert.rejects(
            () => dispatchRole(withoutId.ctx, 'deployer', { ...ROLE_CALL_OPTS.deployer, prompt: 'deploy to test env' }),
            /own reservation id/,
            'A prompt missing the id must never reach the member -- the deploy would silently self-block.'
        );
        assert.strictEqual(withoutId.rec.dispatches.length, 0, 'The gate-blind prompt must not be dispatched at all.');
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

    test('deployer: max_turns resume, then any infrastructure failure degrades to deployed:false', async () => {
        // apra-fleet-3swo.5.7: re-anchored onto the engine. Same facts:
        //   killIfAlive before the resume       -> rec.kills, ordered
        //   two 'deployed: false' degrade paths -> both recognised error
        //                                          classes really fabricate it
        //   no 'deployed: true' anywhere        -> degrade.neverSynthesizes,
        //                                          enforced against the real
        //                                          fabricated value
        //   auth self-heal                      -> rec.authHeals
        //   'throw err;' (unrecognised)         -> really propagates
        const p = policyFor('deployer');

        const resumed = await driveEngineDispatch('deployer', 'max-turns-resume');
        assert.deepStrictEqual(
            resumed.rec.kills,
            [resumed.ctx.getMemberForRole('deployer')],
            'The deployer resume kills a still-alive session first.'
        );
        const killIndex = resumed.rec.events.findIndex((e) => e.type === 'kill');
        const resumeIndex = resumed.rec.events.findIndex((e) => e.type === 'dispatch' && e.entry === resumed.rec.dispatches[1]);
        assert.ok(killIndex >= 0 && killIndex < resumeIndex, 'The kill must precede the resume dispatch.');

        const degraded = [];
        for (const make of [schemaError, transportError]) {
            const { ctx, rec } = createRecordingCtx({ responses: [make(), make()] });
            const outcome = await dispatchRole(ctx, 'deployer', ROLE_CALL_OPTS.deployer);
            assert.strictEqual(rec.dispatches.length, 1, 'The deployer makes a single bounded attempt -- no generic retry.');
            degraded.push(outcome.value);
        }
        assert.strictEqual(degraded.length, 2, 'Both degrade paths (schema-repair exhaustion and dispatch/transport failure) produce a report.');
        for (const value of degraded) {
            assert.strictEqual(value.deployed, false, 'Both degrade paths record deployed:false.');
            assert.notStrictEqual(value.deployed, true, 'No degrade path may synthesize a successful deploy.');
            assert.strictEqual(typeof value.notes, 'string', 'A degraded report still says why.');
        }
        assert.deepStrictEqual(p.degrade.neverSynthesizes, [true], 'deployed:true is what no degrade path may ever fabricate.');
        assert.strictEqual(p.degrade.verdictField, 'deployed', 'The deployer answers in `deployed`, not `verdict`.');

        const authRun = createRecordingCtx({ responses: [authError()] });
        await dispatchRole(authRun.ctx, 'deployer', ROLE_CALL_OPTS.deployer);
        assert.strictEqual(
            authRun.rec.authHeals.length,
            1,
            "An auth failure self-heals so the next cycle's deploy is not walled off identically."
        );

        const unrecognised = createRecordingCtx({ responses: [new TypeError('not a dispatch failure at all')] });
        await assert.rejects(
            () => dispatchRole(unrecognised.ctx, 'deployer', ROLE_CALL_OPTS.deployer),
            TypeError,
            'An unrecognised error class still propagates.'
        );
    });

    test('integ: an infrastructure dispatch failure is INCONCLUSIVE, never a false test FAIL', async () => {
        // apra-fleet-3swo.5.7: re-anchored onto the engine. Same facts, now
        // proved by running it:
        //   isInfraDispatchFailure(err) separates infra from a verdict
        //        -> the row's degrade.classifiesInfraFailures, and an infra
        //           failure really lands in its own class
        //   integInfraInconclusive = { reason, message }
        //        -> the engine really returns that record, and ONLY under an
        //           'inconclusive' degrade
        //   exactly two paths into the resume dispatch
        //        -> turn exhaustion and ONE infra recovery, counted as real
        //           dispatches
        //   the stubbed passed:false integResult
        //        -> the engine fabricates NOTHING for the infra class; the
        //           downstream stub is the caller's, which is what "the
        //           INCONCLUSIVE branch owns what is recorded" always meant
        //   'throw err;' (unrecognised)   -> really propagates
        const p = policyFor('integ-test-runner');
        assert.strictEqual(p.degrade.kind, 'inconclusive');
        assert.strictEqual(p.degrade.classifiesInfraFailures, true, 'The integ ladder must separate an INFRA dispatch failure from a genuine test verdict.');
        assert.strictEqual(p.retry.infraResumeAttempts, 1, 'ONE bounded infra-failure recovery attempt, distinct from the max_turns resume.');
        assert.ok(!p.degrade.classes.includes('infra'), 'An INCONCLUSIVE degrade fabricates no test report for the infra class at all.');

        // TWO paths into the resume dispatch, and no more.
        const viaTurns = await driveEngineDispatch('integ-test-runner', 'max-turns-resume');
        assert.strictEqual(viaTurns.rec.dispatches.length, 2, 'Turn exhaustion resumes the same session.');
        const viaInfra = createRecordingCtx({ responses: [infraError()] });
        const recovered = await dispatchRole(viaInfra.ctx, 'integ-test-runner', ROLE_CALL_OPTS['integ-test-runner']);
        assert.strictEqual(viaInfra.rec.dispatches.length, 2, 'An infra failure resumes the same session ONCE to recover.');
        assert.deepStrictEqual(
            viaInfra.rec.kills,
            [viaInfra.ctx.getMemberForRole('integ-test-runner')],
            'The infra recovery kills a still-alive session first, exactly as the turn resume does.'
        );
        assert.strictEqual(recovered.ok, true, 'A recovered infra failure is a normal result, not an INCONCLUSIVE one.');
        assert.strictEqual(recovered.inconclusive, null);

        // A PERSISTENT infra failure records the marker rather than a verdict.
        const persistent = createRecordingCtx({ responses: [infraError('envelope lost'), infraError('envelope lost again')] });
        const outcome = await dispatchRole(persistent.ctx, 'integ-test-runner', ROLE_CALL_OPTS['integ-test-runner']);
        assert.strictEqual(persistent.rec.dispatches.length, 2, 'Exactly one recovery resume, never an unbounded ladder.');
        assert.strictEqual(outcome.degraded, true);
        assert.deepStrictEqual(
            outcome.inconclusive,
            { reason: 'empty_response', message: 'envelope lost again' },
            'A persistent infra failure records the INCONCLUSIVE reason and message rather than a verdict.'
        );
        assert.strictEqual(
            outcome.value,
            null,
            'It fabricates NO test report -- the caller stubs one only so downstream references stay defined.'
        );
        assert.strictEqual(p.degrade.marker, 'integInfraInconclusive', 'The marker names what the caller records it as.');

        // ...while a schema or ordinary dispatch failure DID reach a running
        // pass and legitimately records passed:false. That asymmetry is the
        // whole variance.
        for (const make of [schemaError, transportError]) {
            const { ctx } = createRecordingCtx({ responses: [make(), make()] });
            const failed = await dispatchRole(ctx, 'integ-test-runner', ROLE_CALL_OPTS['integ-test-runner']);
            assert.strictEqual(failed.value.passed, false, 'A real dispatch/schema failure is recorded as a failed pass.');
            assert.notStrictEqual(failed.value.passed, true);
            assert.strictEqual(failed.inconclusive, null, 'It is NOT inconclusive -- there was a verdict channel, and it failed.');
        }

        const unrecognised = createRecordingCtx({ responses: [new TypeError('not a dispatch failure at all')] });
        await assert.rejects(
            () => dispatchRole(unrecognised.ctx, 'integ-test-runner', ROLE_CALL_OPTS['integ-test-runner']),
            TypeError,
            'An unrecognised error class still propagates.'
        );
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

    test('regression: a load-bearing catch-all keeps an informational phase from ever aborting the sprint', async () => {
        // apra-fleet-3swo.5.7: re-anchored onto the engine. The textual version
        // asserted the SHAPE of a catch-all (a bare `} catch (err) {`, no
        // `throw` anywhere in the outer catch region); the engine version
        // asserts the BEHAVIOUR that shape existed for -- which is stronger,
        // because a catch-all that swallows an error and then fabricates
        // nothing usable would have passed the text scan.
        //   bare catch / no throw in the outer catch
        //        -> every error class, including a typed sprint abort, really
        //           degrades instead of propagating
        //   memberSessionGuard.killIfAlive before the resume  -> rec.kills
        //   regressionResult.passed !== true                  -> the degrade
        //           really fabricates passed:false, never true
        const p = policyFor('regression-test-runner');
        assert.strictEqual(p.degrade.kind, 'catch-all', 'The regression phase is the table\'s one catch-all.');

        const resumed = await driveEngineDispatch('regression-test-runner', 'max-turns-resume');
        assert.deepStrictEqual(
            resumed.rec.kills,
            [resumed.ctx.getMemberForRole('regression-test-runner')],
            'The regression resume kills a still-alive session first.'
        );

        // Every class, including a REAL divergence -- a typed sprint abort that
        // every other ladder propagates -- must be swallowed here. This is the
        // exact failure the catch-all exists for: a D-push failure while filing
        // carry-over bugs must never turn a green sprint into a terminal
        // ABORTED record that skips Harvest and Publish PR.
        const classDrivers = [
            ['schema', schemaError, 'HARNESS-SCHEMA-CLASS'],
            ['dispatch', transportError, 'HARNESS-DISPATCH-CLASS'],
            ['sync', gitSyncError, 'HARNESS-SYNC-CLASS'],
            ['sync', doltSyncError, 'HARNESS-SYNC-CLASS'],
            ['sync', divergedError, 'HARNESS-SYNC-CLASS'],
            ['unknown', () => new TypeError('not a dispatch failure at all'), 'HARNESS-UNKNOWN-CLASS'],
        ];
        for (const [errorClass, make, marker] of classDrivers) {
            const { ctx } = createRecordingCtx({ responses: [make()] });
            const outcome = await dispatchRole(ctx, 'regression-test-runner', ROLE_CALL_OPTS['regression-test-runner']);
            assert.strictEqual(outcome.degraded, true, `a ${errorClass}-class failure must degrade, never propagate`);
            assert.strictEqual(outcome.value.passed, false, 'Only an explicit passed:true is treated as a green regression pass.');
            assert.notStrictEqual(outcome.value.passed, true, 'No degrade path may report a green pass.');
            assert.ok(
                outcome.value.summary.startsWith(marker),
                `a ${errorClass}-class failure must be reported through its OWN summary builder, not a shared one ` +
                `(got ${JSON.stringify(outcome.value.summary)})`
            );
            assert.deepStrictEqual(outcome.value.bugsFiled, [], 'A degraded pass filed no bugs it can vouch for.');
        }
        assert.strictEqual(p.degrade.paths, 4, 'Four degrade paths: schema, dispatch, sync and unrecognised.');

        // A completed pass whose post-dispatch sync failed is NOT re-dispatched
        // (the pass already ran), but it still reports honestly that its
        // carry-over beads may be local-only.
        const syncFailed = createRecordingCtx({ responses: [postDispatchSyncError(), postDispatchSyncError()] });
        const syncOutcome = await dispatchRole(syncFailed.ctx, 'regression-test-runner', ROLE_CALL_OPTS['regression-test-runner']);
        assert.strictEqual(syncFailed.rec.dispatches.length, 1, 'A pass that already ran is never re-dispatched.');
        assert.ok(syncOutcome.value.summary.startsWith('HARNESS-SYNC-CLASS'), 'It is reported as a sync failure, not as a failed pass.');

        // The two deliberate exceptions: RUN-level control signals are not
        // failures of this phase and keep propagating.
        for (const make of [cancelledError, budgetError]) {
            const { ctx } = createRecordingCtx({ responses: [make()] });
            await assert.rejects(
                () => dispatchRole(ctx, 'regression-test-runner', ROLE_CALL_OPTS['regression-test-runner']),
                (err) => err === undefined || make().constructor === err.constructor,
                'Cancellation and a blown spend ceiling are run-level signals, not a failure of this phase.'
            );
        }
        assert.deepStrictEqual(
            p.degrade.rethrowsRunControlSignals,
            ['CancelledError', 'BudgetExceededError'],
            'Exactly those two signals still propagate through the catch-all.'
        );
    });

    test('harvester: max_turns resume, and any failure proceeds without a validated report rather than failing the sprint', async () => {
        // apra-fleet-3swo.5.7: re-anchored onto the engine. Every fact the
        // textual version asserted is asserted here against a real run:
        //   killIfAlive before the resume  -> rec.kills, ordered before the
        //                                     resume dispatch
        //   'proceeding without a validated harvester report'
        //                                  -> the ladder really returns no
        //                                     value at all for either failure
        //                                     class, which is the degrade that
        //                                     phrase described
        //   auth self-heal                 -> rec.authHeals
        //   'throw err;' (unrecognised)    -> an unrecognised class really
        //                                     propagates
        //   kbWork.apply('harvester', ...) -> the 'kb-apply' postResult step is
        //                                     really performed, and only on a
        //                                     successful dispatch
        const p = policyFor('harvester');

        const resumed = await driveEngineDispatch('harvester', 'max-turns-resume');
        assert.strictEqual(resumed.rec.dispatches.length, 2, 'Turn exhaustion resumes the same session rather than restarting the harvest.');
        assert.deepStrictEqual(
            resumed.rec.kills,
            [resumed.ctx.getMemberForRole('harvester')],
            'A still-alive exhausted session is killed before the resume.'
        );
        const killIndex = resumed.rec.events.findIndex((e) => e.type === 'kill');
        const resumeIndex = resumed.rec.events.findIndex((e) => e.type === 'dispatch' && e.entry === resumed.rec.dispatches[1]);
        assert.ok(killIndex >= 0 && killIndex < resumeIndex, 'The kill must precede the resume dispatch.');

        for (const make of [schemaError, transportError]) {
            const { ctx, rec } = createRecordingCtx({ responses: [make(), make()] });
            const outcome = await dispatchRole(ctx, 'harvester', ROLE_CALL_OPTS.harvester);
            assert.strictEqual(outcome.ok, false);
            assert.strictEqual(outcome.degraded, true);
            assert.strictEqual(
                outcome.value,
                null,
                'A harvester schema/dispatch failure degrades to proceeding WITHOUT a report -- it never fabricates one.'
            );
            assert.strictEqual(
                rec.steps.filter((e) => e.step === 'kb-apply').length,
                0,
                'A failed harvest has no report whose kb_captures could be applied.'
            );
        }

        const authRun = createRecordingCtx({ responses: [authError()] });
        await dispatchRole(authRun.ctx, 'harvester', ROLE_CALL_OPTS.harvester);
        assert.strictEqual(
            authRun.rec.authHeals.length,
            1,
            'The harvester still self-heals an auth failure: the same member and credentials are reused by the NEXT sprint.'
        );

        const unrecognised = createRecordingCtx({ responses: [new TypeError('not a dispatch failure at all')] });
        await assert.rejects(
            () => dispatchRole(unrecognised.ctx, 'harvester', ROLE_CALL_OPTS.harvester),
            TypeError,
            'An unrecognised error class still propagates.'
        );
        assert.strictEqual(p.degrade.rethrowsUnrecognisedErrors, true);

        const good = await driveEngineDispatch('harvester', 'main');
        assert.deepStrictEqual(
            good.rec.steps.map((e) => e.step),
            ['kb-apply'],
            "The harvester report's kb_captures are applied through the policy's 'kb-apply' step -- capture only, since promotions are reviewer-only."
        );
        assert.strictEqual(good.rec.steps[0].policy.agentType, 'harvester', 'kb-apply is routed by the dispatching persona.');
        assert.strictEqual(good.rec.steps[0].member, good.ctx.getMemberForRole('harvester'), 'kb-apply lands in the dispatched member\'s own work folder.');
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

// =============================================================================
// ENGINE-SERVED execution dispatches (apra-fleet-3swo.5.7).
//
// PER-PIN INVENTORY -- what happened to each assertion above when a ladder
// migrated. Nothing was dropped or weakened; only the EVIDENCE changed, from
// "this text appears at this runner.js call site" to "the real engine, run
// against the real frozen policy row, really did this".
//
//   pre-migration (textual, above)          post-migration (behavioural, below)
//   ------------------------------------    ------------------------------------
//   merged.get('member_name') === expr      dispatch.options.member_name === the
//                                           resolved member (role member, or the
//                                           runner-local binding for the
//                                           reviewer pool head / doer member)
//   merged.get('model')                     dispatch.options.model, resolved from
//                                           runner.js's own FIXED_ROLE_TIER (read
//                                           from source by the harness) or the
//                                           per-bead tier binding
//   merged.get('max_turns') + resolveTurns  dispatch.options.max_turns, the real
//                                           number the engine passed
//   merged.get('timeout_s'/'max_total_s')   the same, resolved through
//                                           ctx.budgets from the SYMBOLIC name
//                                           the policy records -- a sentinel
//                                           value, so a hard-coded fallback
//                                           cannot pass
//   merged.get('resume')                    dispatch.options.resume
//   innermostEnclosingCall(WITH_GIT_SYNC)   dispatch.bracket !== null, plus its
//     + bracketArgs[0]/[1] + pushBeads      member / pushCode / pushBeads as
//                                           really received
//   innermostEnclosingCall(WATCHDOG) null   dispatch.watchdog === null
//   KB_SELF_INJECTING_ROLES membership      unchanged: still asserted against the
//                                           real exported set, now paired with
//                                           the policy's own kbInjection field
//   merged.get('schema')                    dispatch.options.schema, identity-
//                                           compared to the real contracts.mjs
//                                           object
//   merged.get('sprint_id') === null        dispatch.options.sprint_id === null
//   the 14 EXECUTION_LADDERS entries        the same 14, as
//                                           EXECUTION_INLINE_LADDERS entries
//                                           until each role migrates and then as
//                                           EXECUTION_ENGINE_DISPATCHES entries;
//                                           the cross-cutting test below asserts
//                                           the two lists still sum to 14 and
//                                           still cover 7 ladders x 2 dispatches
// =============================================================================

/** Resolved member for an engine-served pin: a role member, or a binding. */
function engineMemberOf(ctx, pin) {
    return pin.memberRole ? ctx.getMemberForRole(pin.memberRole) : BINDINGS[pin.memberBinding];
}

describe('execution-role dispatch ladders: per-dispatch pins (engine-served)', () => {
    for (const pin of EXECUTION_ENGINE_DISPATCHES) {
        test(`${pin.name}: member routing, bracketing, turns, timeout, watchdog, KB and verdict schema`, async () => {
            const { ctx, dispatch, opts, rec } = await driveEngineDispatch(pin.role, pin.kind);
            assert.ok(
                dispatch,
                `${pin.name}: the engine never made the expected ${pin.kind} dispatch (it made ${rec.dispatches.length}).`
            );
            const o = dispatch.options;
            const member = engineMemberOf(ctx, pin);

            // --- member routing -------------------------------------------------
            assert.strictEqual(
                o.member_name,
                member,
                `${pin.name} must route to ${pin.memberRole ? `the '${pin.memberRole}' role member` : pin.memberBinding}.`
            );

            // --- model tier -----------------------------------------------------
            assert.strictEqual(o.model ?? null, pin.modelTier, `${pin.name} must dispatch at model tier ${pin.modelTier}.`);

            // --- turn budget and timeout ----------------------------------------
            assert.strictEqual(o.max_turns ?? null, pin.maxTurns, `${pin.name} must pass max_turns ${pin.maxTurns}.`);
            assert.strictEqual(
                o.timeout_s ?? null,
                pin.timeoutS === null ? null : ctx.budgets[pin.timeoutS],
                `${pin.name} must pass timeout_s resolved from the symbolic budget ${pin.timeoutS}.`
            );
            assert.strictEqual(
                o.max_total_s ?? null,
                pin.maxTotalS === null ? null : ctx.budgets[pin.maxTotalS],
                `${pin.name} must pass max_total_s resolved from the symbolic budget ${pin.maxTotalS}.`
            );

            // --- same-session resume flag ---------------------------------------
            const expectedResume = pin.resume === 'call-site' ? opts.resumeArg : pin.resume;
            assert.strictEqual(o.resume ?? null, expectedResume ?? null, `${pin.name}: same-session resume argument.`);

            // --- git sync bracketing and push flags -----------------------------
            assert.ok(dispatch.bracket, `${pin.name} must be wrapped in a withGitSync(...) bracket -- every execution-side dispatch is.`);
            assert.strictEqual(
                dispatch.bracket.member,
                member,
                `${pin.name}'s bracket must sync the SAME member the dispatch routes to.`
            );
            assert.strictEqual(dispatch.bracket.pushCode, pin.pushCode, `${pin.name}: pushCode flag.`);
            assert.strictEqual(dispatch.bracket.options.pushBeads, pin.pushBeads, `${pin.name}: pushBeads flag.`);

            // --- watchdog arming ------------------------------------------------
            assert.strictEqual(
                dispatch.watchdog,
                null,
                `${pin.name} is NOT raced against a client-side watchdog -- only the planner-side dispatches are.`
            );

            // --- KB knowledge injection -----------------------------------------
            assert.strictEqual(o.agentType ?? null, pin.agentType, `${pin.name} must pass agentType=${pin.agentType}.`);
            const fromWrapper = !KB_SELF_INJECTING_ROLES.has(pin.agentType);
            assert.strictEqual(
                fromWrapper,
                !['doer', 'reviewer'].includes(pin.agentType),
                `${pin.name}: doer and reviewer place their own KNOWLEDGE BANK block from their prompt builders; every ` +
                'other execution role receives it from the agent() wrapper.'
            );
            assert.strictEqual(
                policyFor(pin.role).kbInjection,
                fromWrapper ? 'wrapper' : 'prompt-builder',
                `${pin.name}: the policy's kbInjection field must agree with where the block really comes from.`
            );

            // --- returnable verdicts --------------------------------------------
            assert.strictEqual(
                o.schema ?? null,
                pin.schema === null ? null : SCHEMAS[pin.schema],
                `${pin.name}: returnable verdict schema (identity-compared to the real contracts.mjs object).`
            );

            // --- sprint_id ------------------------------------------------------
            assert.strictEqual(
                o.sprint_id ?? null,
                null,
                `${pin.name} must NOT pass its own sprint_id -- the agent() wrapper supplies the sprint-identity token.`
            );
        });
    }

    test('the two execution lists together still cover all fourteen dispatches across seven ladders', () => {
        const all = [
            ...EXECUTION_INLINE_LADDERS.map((pin) => ({ ladder: pin.ladder, name: pin.name })),
            ...EXECUTION_ENGINE_DISPATCHES.map((pin) => ({ ladder: pin.role, name: pin.name })),
        ];
        assert.strictEqual(
            all.length,
            14,
            'Seven execution ladders x (main dispatch + max_turns-exhaustion resume). Migrating a role MOVES its two ' +
            'entries between the lists; it must never drop one.'
        );
        assert.strictEqual(
            new Set(all.map((e) => e.ladder)).size,
            7,
            'The seven execution-side ladders: reviewer, doer, deployer, integ-test-runner, final review, ' +
            'regression-test-runner, harvester.'
        );
        for (const ladder of new Set(all.map((e) => e.ladder))) {
            assert.strictEqual(
                all.filter((e) => e.ladder === ladder).length,
                2,
                `${ladder} must contribute exactly two dispatches (main + resume) across the two lists.`
            );
        }
        assert.strictEqual(new Set(all.map((e) => e.name)).size, 14, 'Every dispatch must be named distinctly.');
    });
});
