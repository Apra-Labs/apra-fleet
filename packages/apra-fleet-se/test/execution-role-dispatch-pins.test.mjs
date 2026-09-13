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
import { policyFor, ROLE_POLICIES, PRE_DISPATCH_STEPS_IN_BRACKET } from '../fleet-sprint/role-policies.mjs';
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
    trustError,
    turnExhaustionError,
    TURN_BASES,
    sentinelNotePolicies,
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
    // apra-fleet-3swo.5.7: with all seven ladders migrated this list is EMPTY,
    // and every pin it held now lives in the engine-served block at the end of
    // this file. The textual scanner above is deliberately kept rather than
    // deleted -- it becomes live again the moment a ladder is un-migrated, and
    // a file that had thrown it away would silently lose that ladder's coverage
    // instead of failing. This guard is what stops the now-empty loop from
    // passing vacuously.
    test('no execution ladder is pinned against inline runner.js source any more', () => {
        assert.deepStrictEqual(
            EXECUTION_LADDERS.map((pin) => pin.name),
            [],
            'an execution ladder has an INLINE runner.js call site again -- this section must pin it rather than ' +
            'iterating nothing. Move its entry back from EXECUTION_ENGINE_DISPATCHES to EXECUTION_INLINE_LADDERS.'
        );
        assert.strictEqual(
            EXECUTION_ENGINE_DISPATCHES.length,
            14,
            'All fourteen execution dispatches must be pinned on the engine side instead.'
        );
    });
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
            // apra-fleet-3swo.7.12: deployer/integ-test-runner/regression-test-
            // runner are now armed, but only once MIGRATED onto the engine (see
            // the engine-served block below) -- EXECUTION_INLINE_LADDERS is
            // empty today (every execution role has migrated), so this branch
            // is dormant, kept only so a role that is ever reverted to an inline
            // ladder is still proved by source scan rather than silently
            // skipped.
            const watchdogSite = innermostEnclosingCall(WATCHDOG_SITES, site.index);
            if (!pin.watchdog) {
                assert.strictEqual(
                    watchdogSite,
                    null,
                    `${pin.name} is NOT raced against withDispatchWatchdog today.`
                );
            } else {
                assert.ok(watchdogSite, `${pin.name} must be raced against withDispatchWatchdog(...).`);
            }

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

    test('final review resolves to the reviewer ROLE member, while per-round review dispatches to the reviewer pool head', async () => {
        // apra-fleet-3swo.5.7: half re-anchored. The per-round reviewer is
        // still inline, so its pool-head routing is still a property of
        // runner.js text; final review has migrated, so its role-member routing
        // is proved by running the engine. The FACT the pin exists for -- that
        // the two resolve differently, and that the difference is expressible
        // per role -- is asserted across both.
        const stripped = stripComments(SRC);
        assert.ok(
            /const reviewerPool = getMembersForRole\(ROLE_REVIEWER\);/.test(stripped),
            'The per-round reviewer pool must be built from the reviewer role, which is what makes pool head and role member the same role.'
        );
        for (const pin of EXECUTION_LADDERS.filter((p) => p.ladder === 'reviewer')) {
            assert.strictEqual(effectiveOpts(siteFor(pin.anchor)).merged.get('member_name'), 'reviewerPool[0]');
        }
        for (const pin of EXECUTION_ENGINE_DISPATCHES.filter((p) => p.role === 'reviewer')) {
            const { ctx, dispatch } = await driveEngineDispatch(pin.role, pin.kind);
            assert.strictEqual(dispatch.options.member_name, BINDINGS['reviewerPool[0]'], 'The per-round reviewer takes the pool head.');
            assert.notStrictEqual(dispatch.options.member_name, ctx.getMemberForRole('reviewer'));
        }
        for (const pin of EXECUTION_ENGINE_DISPATCHES.filter((p) => p.role === 'final-review')) {
            const { ctx, dispatch } = await driveEngineDispatch(pin.role, pin.kind);
            assert.strictEqual(
                dispatch.options.member_name,
                ctx.getMemberForRole('reviewer'),
                'Final Review has no distinct role member of its own -- it shares the reviewer role resolution.'
            );
            assert.strictEqual(dispatch.options.agentType, 'reviewer', 'Final Review dispatches the reviewer persona.');
        }
        // The two resolution KINDS really differ, which is what makes member
        // resolution expressible per role rather than one shared rule.
        assert.deepStrictEqual(policyFor('final-review').member, { kind: 'role', role: 'reviewer' });
        assert.deepStrictEqual(policyFor('reviewer').member, { kind: 'pool-head', role: 'reviewer', binding: 'reviewerPool[0]' });
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
        // apra-fleet-3swo.6.5: re-anchored again. `const deployerPrompt =`
        // moved into fleet-sprint/phases/deploy.mjs, which sits AFTER runner.js
        // in the concatenated SRC -- so keeping it as the region END would have
        // stretched this region from runner.js's sprintSelfId across every
        // phase module in between, quietly turning a one-line region into a
        // few-thousand-line one. `const sprintSelfIdLine =` is the very next
        // statement after sprintSelfId and stays in runner.js, so the region
        // remains exactly the declaration this assertion is about.
        const region = stripComments(regionBetween(SRC, 'const sprintSelfId =', 'const sprintSelfIdLine ='));
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
    test('reviewer: two attempts, max_turns resume, and infrastructure failures degrade to CHANGES_NEEDED marked dispatchFailed', async () => {
        // apra-fleet-3swo.5.7: re-anchored onto the engine.
        //   /reviewAttempt <= 2/                    -> the ladder really makes
        //        two dispatches before degrading
        //   max_turns_exhausted -> same-session resume, and
        //   memberSessionGuard.killIfAlive(reviewerPool[0])
        //                                           -> rec.kills, ordered
        //                                              before the resume
        //   two `verdict: 'CHANGES_NEEDED'` paths   -> both recognised classes
        //                                              really fabricate it
        //   two `dispatchFailed: true`              -> degrade.marker, stamped
        //                                              on every fabricated one
        //   no `verdict: 'APPROVED'`                -> neverSynthesizes,
        //                                              enforced on the real value
        //   GitSyncError / DoltSyncError degrade    -> degrade.extraDispatchErrors
        //   NO GitDivergedError / DoltDivergedError -> a real divergence really
        //                                              still propagates
        //   roundSessions.clear('reviewer')         -> the 'clear-round-session'
        //                                              DEGRADE step, which runs
        //                                              on failure and NOT on
        //                                              success
        //   `throw err;`                            -> an unrecognised class
        //                                              really propagates
        const p = policyFor('reviewer');
        const opts = ROLE_CALL_OPTS.reviewer;

        const resumed = await driveEngineDispatch('reviewer', 'max-turns-resume');
        assert.deepStrictEqual(
            resumed.rec.kills,
            [BINDINGS['reviewerPool[0]']],
            'A still-alive exhausted session is killed before the resume, on the pool head the dispatch routes to.'
        );
        const killIndex = resumed.rec.events.findIndex((e) => e.type === 'kill');
        const resumeIndex = resumed.rec.events.findIndex((e) => e.type === 'dispatch' && e.entry === resumed.rec.dispatches[1]);
        assert.ok(killIndex >= 0 && killIndex < resumeIndex, 'Turn exhaustion resumes the same session rather than restarting the review.');

        // Two attempts, then degrade -- one extra infrastructure attempt per round.
        const spent = createRecordingCtx({ responses: [transportError(), transportError()] });
        const degraded = await dispatchRole(spent.ctx, 'reviewer', opts);
        assert.strictEqual(spent.rec.dispatches.length, 2, 'The reviewer gets exactly one extra infrastructure attempt per round.');
        assert.strictEqual(p.retry.attempts, 2);

        // Both degrade paths, plus the two sync classes that degrade identically.
        const degradeDrivers = [schemaError, transportError, gitSyncError, doltSyncError];
        for (const make of degradeDrivers) {
            const { ctx } = createRecordingCtx({ responses: [make(), make()] });
            const outcome = await dispatchRole(ctx, 'reviewer', opts);
            assert.strictEqual(outcome.value.verdict, 'CHANGES_NEEDED', 'Both degrade paths synthesize CHANGES_NEEDED.');
            assert.notStrictEqual(outcome.value.verdict, 'APPROVED', 'No reviewer degrade path may synthesize an APPROVED verdict.');
            assert.strictEqual(
                outcome.value.dispatchFailed,
                true,
                'Every synthesized verdict is marked dispatchFailed so the contract-violation guard never mistakes it for a self-contradictory verdict.'
            );
            assert.deepStrictEqual(outcome.value.reopenIds, [], 'A fabricated verdict claims nothing to reopen.');
            assert.deepStrictEqual(outcome.value.newTasks, []);
        }
        assert.deepStrictEqual(
            p.degrade.extraDispatchErrors,
            ['GitSyncError', 'DoltSyncError'],
            "The review's own read-side sync bracket failures degrade identically to a dispatch failure."
        );
        assert.strictEqual(degraded.value.verdict, 'CHANGES_NEEDED');

        // A REAL divergence is a branch integrity problem and must still
        // propagate rather than degrade to a verdict.
        const diverged = createRecordingCtx({ responses: [divergedError(), divergedError()] });
        await assert.rejects(
            () => dispatchRole(diverged.ctx, 'reviewer', opts),
            /branch diverged/,
            'A real divergence must still propagate rather than degrade to a verdict.'
        );
        const unrecognised = createRecordingCtx({ responses: [new TypeError('not a dispatch failure at all')] });
        await assert.rejects(
            () => dispatchRole(unrecognised.ctx, 'reviewer', opts),
            TypeError,
            'An unrecognised error class still propagates.'
        );

        // A failed round drops its session; a SUCCESSFUL round keeps it.
        const failedRound = createRecordingCtx({ responses: [transportError(), transportError()] });
        await dispatchRole(failedRound.ctx, 'reviewer', opts);
        assert.ok(
            failedRound.rec.steps.some((e) => e.step === 'clear-round-session'),
            'A failed round must not leave its session to be resumed by the next round.'
        );
        const goodRound = await driveEngineDispatch('reviewer', 'main');
        assert.ok(
            !goodRound.rec.steps.some((e) => e.step === 'clear-round-session'),
            "A SUCCESSFUL round's session is exactly what the next round wants to resume -- that asymmetry is why this is a degrade step."
        );
        assert.deepStrictEqual(p.degrade.steps, ['clear-round-session']);
    });

    test('reviewer: a self-contradictory verdict is retried once on the SAME budget, then raised as its own error', async () => {
        // apra-fleet-3swo.5.7: the contract guard used to be a loop condition
        // inside dispatchReview (`isReviewerContractViolation(verdict)` ->
        // retry once -> throw ReviewerContractViolationError). It is now a
        // postResult STEP that rejects the result plus
        // retry.retryOnInvalidResult, and the behaviour is pinned here.
        const opts = ROLE_CALL_OPTS.reviewer;
        const contradictory = { verdict: 'CHANGES_NEEDED', notes: 'nothing actionable', reopenIds: [], newTasks: [] };
        const usable = { verdict: 'CHANGES_NEEDED', notes: 'fix X', reopenIds: ['bead-1'], newTasks: [] };
        const guard = ({ value }) => (value && value.reopenIds && value.reopenIds.length === 0
            && (value.newTasks || []).length === 0 && value.verdict === 'CHANGES_NEEDED' && !value.dispatchFailed
            ? { rejected: true, reason: 'nothing for the orchestrator to act on' }
            : undefined);

        // Rejected once, then a fresh review returns something usable.
        const recovered = createRecordingCtx({
            responses: [contradictory, usable],
            steps: { 'reviewer-contract-guard': guard },
        });
        const outcome = await dispatchRole(recovered.ctx, 'reviewer', opts);
        assert.strictEqual(recovered.rec.dispatches.length, 2, 'A verdict that contradicts itself is answered with a whole fresh review, not a nudge.');
        assert.strictEqual(outcome.value, usable);
        assert.strictEqual(
            recovered.rec.steps.filter((e) => e.step === 'kb-apply').length,
            1,
            'kb-apply must not run for a verdict the guard rejected -- steps run in order and the rejection ends the attempt.'
        );

        // Rejected twice: the caller gets its OWN error, never a fabricated verdict.
        const persistent = createRecordingCtx({
            responses: [contradictory, contradictory],
            steps: { 'reviewer-contract-guard': guard },
        });
        await assert.rejects(
            () => dispatchRole(persistent.ctx, 'reviewer', opts),
            /HARNESS-REJECTED/,
            'Twice in a row is a distinct failure the caller raises as ReviewerContractViolationError, not a degrade.'
        );
        assert.strictEqual(persistent.rec.dispatches.length, 2, 'The contract guard shares the ladder\'s two-attempt budget.');
        assert.strictEqual(
            persistent.rec.steps.filter((e) => e.step === 'kb-apply').length,
            0,
            'No usable verdict was ever produced, so no KB work was applied.'
        );
        assert.strictEqual(policyFor('reviewer').retry.retryOnInvalidResult, true);
        assert.deepStrictEqual(policyFor('reviewer').postResult, ['reviewer-contract-guard', 'kb-apply']);
    });

    test('doer: bounded escalating resume ladder, closed-streak short-circuit, and no re-dispatch after a post-dispatch sync failure', async () => {
        // apra-fleet-3swo.5.7: re-anchored onto the engine.
        //   MAX_TURN_RESUME_ATTEMPTS === 2        -> retry.resumeAttempts, and
        //        the number of resumes the engine really issues
        //   BASE_DOER_MAX_TURNS === 500           -> TURN_BASES, which the row
        //        names symbolically
        //   `currentMaxTurns = BASE * 2` and
        //   `currentMaxTurns *= 2;`               -> the budgets the resumes
        //        really pass, doubling each time
        //   `while (resumeAttempt < MAX_...)`     -> the ladder really stops at
        //        the bound rather than running while failures last
        //   verifyDoerStreakClosed + preResumeUnclosed.length === 0
        //                                         -> the 'verify-streak-closed'
        //        preDispatch step really short-circuits the resume, and runs
        //        BEFORE the kill
        //   isPostDispatchSyncFailure(err)        -> really no re-dispatch
        //   isNonRetryableDispatchError + auth self-heal
        //                                         -> one heal plus one bounded
        //        retry; a workspace-trust failure is not retried at all
        //   dispatchDoer({ resumeOntoRemoteTip: true })
        //                                         -> the generic retry really
        //        asks for it, and the auth-healed retry really does not
        const p = policyFor('doer');
        const opts = ROLE_CALL_OPTS.doer;
        assert.strictEqual(p.retry.resumeAttempts, 2, 'The doer resume ladder is bounded at two attempts.');
        assert.strictEqual(TURN_BASES.BASE_DOER_MAX_TURNS, 500, 'The doer streak turn base.');

        // Bounded, escalating ladder. One more exhaustion than it may answer,
        // so the BOUND is what stops it.
        const escalating = createRecordingCtx({
            responses: Array.from({ length: p.retry.resumeAttempts + 1 }, () => turnExhaustionError()),
        });
        await dispatchRole(escalating.ctx, 'doer', opts);
        const resumes = escalating.rec.dispatches.filter((d) => d.options.resume === true);
        assert.strictEqual(resumes.length, p.retry.resumeAttempts, 'The escalation is bounded, never unbounded.');
        assert.deepStrictEqual(
            resumes.map((d) => d.options.max_turns),
            [TURN_BASES.BASE_DOER_MAX_TURNS * 2, TURN_BASES.BASE_DOER_MAX_TURNS * 4],
            'The first resume doubles the base turn budget; each further exhaustion doubles again.'
        );
        assert.strictEqual(p.retry.turnEscalation, 'double');

        // A turn-exhausted streak whose beads are ALL already closed is a
        // SUCCESS and gets NO resume dispatch -- and no session killed either,
        // because the check runs BEFORE the kill.
        const alreadyClosed = createRecordingCtx({
            responses: [turnExhaustionError()],
            steps: {
                'verify-streak-closed': async ({ phase }) => (phase === 'preDispatch'
                    ? { shortCircuit: true, value: null }
                    : []),
            },
        });
        const shortCircuited = await dispatchRole(alreadyClosed.ctx, 'doer', opts);
        assert.strictEqual(alreadyClosed.rec.dispatches.length, 1, 'A closed streak gets NO resume dispatch.');
        assert.deepStrictEqual(alreadyClosed.rec.kills, [], 'The closure check runs before the kill.');
        assert.strictEqual(shortCircuited.ok, true, 'The doer merely missed its VERIFY checkpoint -- that is a success.');
        assert.deepStrictEqual(
            ROLE_POLICIES['doer-resume'].preDispatch,
            ['verify-streak-closed', 'kill-stale-session'],
            'The order is recorded in the row, and the engine honours it.'
        );

        // A completed streak whose post-dispatch sync failed must NOT be
        // re-dispatched -- the work is already committed locally.
        const syncFailed = createRecordingCtx({ responses: [postDispatchSyncError(), postDispatchSyncError()] });
        const syncOutcome = await dispatchRole(syncFailed.ctx, 'doer', opts);
        assert.strictEqual(syncFailed.rec.dispatches.length, 1, 'A streak whose writes are already local is never re-dispatched.');
        assert.ok(syncOutcome.error, 'The caller still sees the failure, and attributes per bead.');
        assert.strictEqual(p.retry.skipRedispatchOnPostDispatchSyncFailure, true);

        // An auth failure gets one self-heal plus one bounded retry; a
        // workspace-trust failure is not retried at all.
        const healed = createRecordingCtx({ responses: [authError()], healed: true });
        await dispatchRole(healed.ctx, 'doer', opts);
        assert.strictEqual(healed.rec.authHeals.length, 1, 'One bounded LLM-auth self-heal.');
        assert.strictEqual(healed.rec.dispatches.length, 2, 'A healed auth failure is retried once.');
        const trust = createRecordingCtx({ responses: [trustError(), trustError()], healed: false });
        await dispatchRole(trust.ctx, 'doer', opts);
        assert.strictEqual(trust.rec.dispatches.length, 1, 'A workspace-trust failure is not retried at all.');
        assert.strictEqual(trust.rec.authHeals.length, 0, 'Self-heal cannot fix workspace trust, so it is not attempted.');

        // The GENERIC retry resumes onto the streak branch's remote tip so it
        // builds on already-published work instead of creating a divergent,
        // content-identical duplicate commit that can never fast-forward. The
        // auth-healed retry does NOT: that failure provably ran nothing.
        const generic = createRecordingCtx({ responses: [transportError()] });
        await dispatchRole(generic.ctx, 'doer', opts);
        assert.strictEqual(generic.rec.dispatches.length, 2, 'A generic failure is retried once.');
        assert.strictEqual(
            generic.rec.dispatches[0].bracket.options.resumeOntoRemoteTip,
            undefined,
            'The FIRST attempt keeps plain ff-only pre-dispatch sync.'
        );
        assert.strictEqual(
            generic.rec.dispatches[1].bracket.options.resumeOntoRemoteTip,
            true,
            'The generic retry resumes onto the streak branch remote tip.'
        );
        assert.strictEqual(
            healed.rec.dispatches[1].bracket.options.resumeOntoRemoteTip,
            undefined,
            'A retry after a provably no-mutation auth failure has no published work to build on.'
        );
        assert.strictEqual(p.retry.resumeOntoRemoteTipOnRetry, true);

        // The claim runs INSIDE the bracket, so it sees the remote state the
        // pre-dispatch D-pull just brought in -- and its narrowing is visible
        // to the prompt the dispatch actually sends.
        assert.deepStrictEqual(p.preDispatch, ['claim-beads-batched']);
        assert.ok(
            PRE_DISPATCH_STEPS_IN_BRACKET.includes('claim-beads-batched'),
            'Claiming before the bracket opens is claiming against stale remote state.'
        );
        const claimed = createRecordingCtx({ responses: ['REPORT'] });
        await dispatchRole(claimed.ctx, 'doer', opts);
        const bracketIndex = claimed.rec.events.findIndex((e) => e.type === 'bracket-open');
        const claimIndex = claimed.rec.events.findIndex((e) => e.type === 'step' && e.step === 'claim-beads-batched');
        const dispatchIndex = claimed.rec.events.findIndex((e) => e.type === 'dispatch');
        assert.ok(
            bracketIndex >= 0 && bracketIndex < claimIndex && claimIndex < dispatchIndex,
            'The claim must sit INSIDE the bracket and BEFORE the dispatch it narrows.'
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

    test('final review: the auth self-heal short-circuits the generic retry so a healed verdict is never discarded', async () => {
        // apra-fleet-3swo.5.7: re-anchored onto the engine.
        //   healedByLlmAuthSelfHeal tracking            -> a healed auth
        //        failure really produces a second dispatch
        //   `if (!healedByLlmAuthSelfHeal) throw err;`   -> an UNHEALED
        //        non-retryable failure really propagates
        //   handledByAuthSelfHeal short-circuit         -> the healed retry is
        //        the ladder's LAST dispatch; no second full Final Review fires
        //   four `verdict: 'FAIL'` degrade paths        -> two error classes
        //        reached from two ladder positions, all fabricating FAIL
        //   no `verdict: 'PASS'` anywhere               -> neverSynthesizes,
        //        enforced against the real fabricated value
        //   runFinalReviewAttempt() re-run on retry     -> the retry inherits
        //        the max_turns resume too
        const p = policyFor('final-review');
        const opts = ROLE_CALL_OPTS['final-review'];

        // A HEALED auth failure retries once, and that retry is the last word.
        const healed = createRecordingCtx({ responses: [authError(), 'HEALED VERDICT'], healed: true });
        const healedOutcome = await dispatchRole(healed.ctx, 'final-review', opts);
        assert.strictEqual(healed.rec.authHeals.length, 1, 'An LLM-auth failure gets exactly ONE self-heal.');
        assert.strictEqual(healed.rec.dispatches.length, 2, 'The heal is followed by exactly one retry.');
        assert.strictEqual(healedOutcome.value, 'HEALED VERDICT', 'The healed verdict is what the caller gets.');

        // ...and if that healed retry ALSO fails, the ladder stops rather than
        // firing a second full Final Review. Proved by SPLICING the field on a
        // copy of the real row with room to tell the two settings apart: at the
        // shipped budget of two attempts the heal consumes attempt one and the
        // generic retry IS attempt two, so they coincide.
        for (const shortCircuits of [true, false]) {
            const spliced = {
                ...ROLE_POLICIES,
                'final-review': {
                    ...ROLE_POLICIES['final-review'],
                    retry: { ...p.retry, attempts: 3, authSelfHealShortCircuits: shortCircuits },
                },
            };
            const { ctx, rec } = createRecordingCtx({
                responses: [authError(), transportError(), transportError()],
                healed: true,
                policies: spliced,
            });
            await dispatchRole(ctx, 'final-review', opts);
            assert.strictEqual(
                rec.dispatches.length,
                shortCircuits ? 2 : 3,
                `authSelfHealShortCircuits=${shortCircuits}: a healed Final Review must SHORT-CIRCUIT the generic ` +
                'retry-once ladder -- otherwise a second full Final Review fires and silently discards the healed verdict.'
            );
        }
        assert.strictEqual(p.retry.authSelfHealShortCircuits, true, 'The shipped row short-circuits.');

        // An auth/trust failure the heal could NOT fix propagates.
        const unhealed = createRecordingCtx({ responses: [trustError()], healed: false });
        await assert.rejects(
            () => dispatchRole(unhealed.ctx, 'final-review', opts),
            /workspace not trusted/,
            'A non-retryable error that could NOT be healed must still propagate.'
        );
        assert.strictEqual(unhealed.rec.dispatches.length, 1, 'It must not burn the retry on the identical wall.');
        assert.strictEqual(p.retry.rethrowsUnhealedNonRetryable, true);

        // Every degrade lands on FAIL; a dead dispatch channel never passes a
        // sprint. Two classes x two ladder positions = the four paths the row
        // records.
        const positions = [
            ['generic retry', false],
            ['healed retry', true],
        ];
        let pathCount = 0;
        for (const [label, viaHeal] of positions) {
            for (const make of [schemaError, transportError]) {
                const responses = viaHeal ? [authError(), make()] : [make(), make()];
                const { ctx } = createRecordingCtx({ responses, healed: viaHeal });
                const outcome = await dispatchRole(ctx, 'final-review', opts);
                assert.strictEqual(outcome.value.verdict, 'FAIL', `${label}: every degrade path records FAIL.`);
                assert.notStrictEqual(outcome.value.verdict, 'PASS', `${label}: no degrade path may synthesize a PASS.`);
                assert.strictEqual(typeof outcome.value.notes, 'string', `${label}: a fabricated verdict still says why.`);
                pathCount += 1;
            }
        }
        assert.strictEqual(pathCount, p.degrade.paths, 'degrade.paths counts classes times ladder positions.');
        assert.deepStrictEqual(p.degrade.neverSynthesizes, ['PASS']);

        // The retry re-runs the WHOLE attempt, so it inherits the max_turns
        // resume: a retry whose own dispatch exhausts its turns still resumes.
        const retryThenExhaust = createRecordingCtx({ responses: [transportError(), turnExhaustionError(), 'RESUMED VERDICT'] });
        const inherited = await dispatchRole(retryThenExhaust.ctx, 'final-review', opts);
        assert.strictEqual(retryThenExhaust.rec.dispatches.length, 3, 'attempt 1, attempt 2, and attempt 2\'s own resume.');
        assert.strictEqual(inherited.value, 'RESUMED VERDICT');
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
        // apra-fleet-3swo.5.4: the per-class summary text is table data
        // (degrade.noteTemplates) rather than a per-call note builder, so the
        // sentinels are spliced into the table the engine reads. A catch-all
        // that collapsed four classes into one shared message -- or an engine
        // that grew a per-role branch instead of reading the table -- would
        // stop reproducing them.
        const notePolicies = sentinelNotePolicies('regression-test-runner');
        for (const [errorClass, make, marker] of classDrivers) {
            const { ctx } = createRecordingCtx({ responses: [make()], policies: notePolicies });
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
        const syncFailed = createRecordingCtx({ responses: [postDispatchSyncError(), postDispatchSyncError()], policies: notePolicies });
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
            const { ctx, dispatch, opts, rec } = await driveEngineDispatch(pin.driveAs ?? pin.role, pin.kind);
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
            // apra-fleet-3swo.7.12: deployer/integ-test-runner/regression-test-
            // runner were audited and ARMED (a behaviour change from the
            // previously-inherited NO_WATCHDOG default); every other execution
            // role stays disarmed. Driven by the pin's own watchdog/
            // watchdogLabel fields rather than a hardcoded expectation, so this
            // pin table is the single place that decision is recorded.
            if (!pin.watchdog) {
                assert.strictEqual(
                    dispatch.watchdog,
                    null,
                    `${pin.name} is NOT raced against a client-side watchdog.`
                );
            } else {
                assert.ok(dispatch.watchdog, `${pin.name} must be raced against a client-side watchdog.`);
                assert.strictEqual(
                    dispatch.watchdog.timeoutS,
                    ctx.budgets.DISPATCH_TIMEOUT_S,
                    `${pin.name}'s watchdog must fire on the same DISPATCH_TIMEOUT_S budget the server-side timeout uses.`
                );
                assert.strictEqual(
                    dispatch.watchdog.member,
                    member,
                    `${pin.name}'s watchdog must name the dispatched member so its kill path targets the right session.`
                );
                assert.strictEqual(dispatch.watchdog.label, pin.watchdogLabel, `${pin.name}: watchdog label.`);
                assert.ok(dispatch.watchdog.hasLog, `${pin.name}'s watchdog must be given the sprint log so its kill path is visible.`);
            }

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
            // `driveAs` when present: doer-resume is registered as a role of
            // its own but belongs to the DOER's ladder, which is what this
            // census counts.
            ...EXECUTION_ENGINE_DISPATCHES.map((pin) => ({ ladder: pin.driveAs ?? pin.role, name: pin.name })),
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
