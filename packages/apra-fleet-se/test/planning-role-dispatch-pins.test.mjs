import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    findCallSites,
    splitTopLevelArgs,
    objectLiteralFor,
    objectEntries,
    spreadsOf,
    numericConstant,
    isInsideAnyCall,
    innermostEnclosingCall,
    regionBetween,
    stripComments,
    dispatchLadderModulePaths,
    moduleSetSourceWithOffsets,
    formatSiteLocations,
} from './helpers/dispatch-pin-scanner.mjs';
import { planReviewerVerdict, streakAssignment } from '../fleet-sprint/contracts.mjs';
import { KB_SELF_INJECTING_ROLES } from '../fleet-sprint/runner.js';
import { PLANNING_LADDERS, ENGINE_DISPATCHES } from './helpers/planning-ladders.mjs';
import { dispatchRole } from '../fleet-sprint/dispatch-role.mjs';
import {
    createRecordingCtx,
    driveEngineDispatch,
    ROLE_CALL_OPTS,
    SCHEMAS,
    turnExhaustionError,
    authError,
    trustError,
    busyError,
    schemaError,
    transportError,
    postDispatchSyncError,
    streakValidate,
    REJECTED_CANDIDATE,
    ACCEPTED_CANDIDATE,
} from './helpers/dispatch-role-harness.mjs';

// =============================================================================
// apra-fleet-3swo.5.1 -- PLANNING-ROLE dispatch behaviour pins.
//
// This file, together with its sibling execution-role-dispatch-pins.test.mjs
// (apra-fleet-3swo.5.6), is the safety net the dispatchRole engine extraction
// rests on. BOTH land and pass BEFORE any dispatchRole engine code exists, so
// what they assert is TODAY's behaviour of the unrefactored runner.js -- not
// the intended design of the engine that will replace it. When the engine
// lands, every pin below must still hold; a pin that has to be edited to make
// the engine pass is a behaviour change that needs justifying, which is
// exactly the signal these files exist to produce.
//
// SCOPE (planning side, five ladders):
//   1. planner            -- interactive dispatch + max_turns-exhaustion resume
//   2. plan-reviewer      -- once + max_turns-exhaustion resume
//   3. scoped replan planner
//   4. scoped replan plan-reviewer
//   5. streak assignment  -- dispatch + bounded semantic-repair re-ask
// The execution/verification-side roles (doer, reviewer, deployer, integ,
// final review, regression, harvester) belong to the sibling file.
//
// HOW THESE PIN, BEFORE AND AFTER THE MIGRATION. An UNMIGRATED ladder is not
// separately importable -- it is a closure over per-run state inside one very
// large function, which is the condition the refactor exists to fix -- so it
// is located STRUCTURALLY in runner.js's source (by its prompt/label anchor,
// never by line number: runner.js keeps shrinking as extraction phases land)
// and its dispatch options are resolved the way the JS engine would, spread
// base object first then the call site's own inline keys on top. The shared
// scanner lives in ./helpers/dispatch-pin-scanner.mjs.
//
// A MIGRATED ladder (apra-fleet-3swo.5.3) has no such source text left, so its
// pins are RE-ANCHORED onto fleet-sprint/dispatch-role.mjs plus
// fleet-sprint/role-policies.mjs and proved by running the real engine against
// a recording ctx (./helpers/dispatch-role-harness.mjs). No pinned FACT is
// dropped in that move -- only the evidence changes, from "this text appears
// in runner.js" to "the engine really did this". The per-pin inventory mapping
// each pre-migration assertion to its post-migration replacement is in the
// engine section at the end of this file.
//
// As of apra-fleet-3swo.5.3 all five planning ladders are migrated, so the
// inline half of this file currently pins nothing and the engine half pins all
// eight dispatches. The inline machinery is deliberately KEPT: it is what the
// execution-side sibling still uses, and what this file would use again if a
// planning ladder were ever un-migrated.
//
// WHAT EACH LADDER PINS: member routing, sync bracketing + push flags,
// max_turns, timeout, watchdog arming, retry/degrade behaviour, KB knowledge
// injection, returnable verdicts, and sprint_id presence.
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FLEET_SPRINT_DIR = path.join(__dirname, '..', 'fleet-sprint');
// SRC scans the module SET dispatch-pin-scanner.mjs defines
// (DISPATCH_LADDER_MODULES: runner.js, role-policies.mjs and dispatch-role
// .mjs), not one hard-coded runner.js path -- see that file's header for why.
// Every INLINE pin still resolves against runner.js's real text; the engine's
// own call site is pinned as a census entry here and asserted behaviourally
// (see the engine section at the end of this file).
// MODULE_OFFSETS (apra-fleet-3swo.28) lets failure messages resolve a
// concatenation-relative site.line back to the real {file, line} it came
// from, instead of assuming runner.js is the only (or first) module.
const { source: SRC, offsets: MODULE_OFFSETS } = moduleSetSourceWithOffsets(dispatchLadderModulePaths(FLEET_SPRINT_DIR));

const AGENT_SITES = findCallSites(SRC, 'agent');
const WITH_GIT_SYNC_SITES = findCallSites(SRC, 'withGitSync', { excludeDeclaration: true });
const WATCHDOG_SITES = findCallSites(SRC, 'withDispatchWatchdog', { excludeDeclaration: true });

/** Resolves `PLANNER_MAX_TURNS` / `PLANNER_MAX_TURNS * 2` to a number. */
function resolveTurns(expr) {
    if (expr === null || expr === undefined) return null;
    const m = /^([A-Za-z_$][\w$]*)(?:\s*\*\s*(\d+))?$/.exec(expr.trim());
    if (!m) return null;
    const base = numericConstant(SRC, m[1]);
    if (base === null) return null;
    return m[2] ? base * Number(m[2]) : base;
}

/**
 * The dispatch options an `agent(...)` site EFFECTIVELY passes: its spread
 * base object(s) first, then its own inline keys (JS spread precedence).
 */
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

// -----------------------------------------------------------------------------
// The pin table. Every value here was read off the CURRENT unrefactored
// runner.js; each is asserted, not merely documented. It lives in
// ./helpers/planning-ladders.mjs (apra-fleet-3swo.28) so the sibling
// execution-role-dispatch-pins.test.mjs can read its LENGTH without either
// hard-coding a literal or re-importing (and re-running) this test file.
// -----------------------------------------------------------------------------

const INLINE_LADDERS = PLANNING_LADDERS.filter((pin) => pin.mode === 'inline');
const ENGINE_LADDER = PLANNING_LADDERS.find((pin) => pin.mode === 'engine');

describe('planning-role dispatch ladders: per-dispatch pins', () => {
    for (const pin of INLINE_LADDERS) {
        test(`${pin.name}: member routing, bracketing, turns, timeout, watchdog, KB and verdict schema`, () => {
            const site = siteFor(pin.anchor);
            const { merged } = effectiveOpts(site);

            // --- member routing -------------------------------------------------
            assert.strictEqual(
                merged.get('member_name'),
                pin.member,
                `${pin.name} must route to ${pin.member}.`
            );

            // --- model tier -----------------------------------------------------
            assert.strictEqual(
                merged.get('model'),
                pin.modelTier,
                `${pin.name} must dispatch at model tier ${pin.modelTier}.`
            );

            // --- turn budget and timeout ----------------------------------------
            assert.strictEqual(
                resolveTurns(merged.get('max_turns') ?? null),
                pin.maxTurns,
                `${pin.name} must pass max_turns resolving to ${pin.maxTurns} (null = no max_turns, i.e. the dispatch default).`
            );
            assert.strictEqual(
                merged.get('timeout_s') ?? null,
                pin.timeoutS,
                `${pin.name} must pass timeout_s ${pin.timeoutS === null ? '(none -- the dispatch default)' : pin.timeoutS}.`
            );
            assert.strictEqual(
                merged.get('max_total_s') ?? null,
                pin.maxTotalS,
                `${pin.name} must pass max_total_s ${pin.maxTotalS === null ? '(none -- the dispatch default)' : pin.maxTotalS}.`
            );

            // --- same-session resume flag ---------------------------------------
            assert.strictEqual(
                merged.get('resume') ?? null,
                pin.resume,
                `${pin.name} must pass resume=${pin.resume === null ? '(absent)' : pin.resume}.`
            );

            // --- git sync bracketing and push flags -----------------------------
            const bracket = innermostEnclosingCall(WITH_GIT_SYNC_SITES, site.index);
            if (!pin.bracketed) {
                assert.strictEqual(
                    bracket,
                    null,
                    `${pin.name} runs OUTSIDE any withGitSync(...) bracket today -- it is a pure-compute grouping call with no repo access.`
                );
            } else {
                assert.ok(bracket, `${pin.name} must be wrapped in a withGitSync(...) bracket.`);
                const bracketArgs = splitTopLevelArgs(bracket.callText);
                assert.strictEqual(
                    bracketArgs[0],
                    pin.member,
                    `${pin.name}'s withGitSync bracket must sync the SAME member the dispatch routes to (${pin.member}).`
                );
                assert.strictEqual(
                    bracketArgs[1],
                    pin.pushCode,
                    `${pin.name}'s withGitSync bracket must pass pushCode=${pin.pushCode}.`
                );
                const bracketOpts = bracketArgs.length > 3 ? objectEntries(bracketArgs[3]) : new Map();
                assert.strictEqual(
                    bracketOpts.get('pushBeads') ?? null,
                    pin.pushBeads,
                    `${pin.name}'s withGitSync bracket must pass pushBeads=${pin.pushBeads === null ? '(absent)' : pin.pushBeads}.`
                );
            }

            // --- watchdog arming ------------------------------------------------
            const watchdog = innermostEnclosingCall(WATCHDOG_SITES, site.index);
            if (!pin.watchdog) {
                assert.strictEqual(
                    watchdog,
                    null,
                    `${pin.name} is NOT raced against a client-side dispatch watchdog today.`
                );
            } else {
                assert.ok(watchdog, `${pin.name} must be raced against withDispatchWatchdog(...).`);
                const watchdogOpts = objectEntries(splitTopLevelArgs(watchdog.callText)[1] || '{}');
                assert.strictEqual(
                    watchdogOpts.get('timeoutS'),
                    'DISPATCH_TIMEOUT_S',
                    `${pin.name}'s watchdog must fire on the same DISPATCH_TIMEOUT_S budget the server-side timeout uses.`
                );
                assert.strictEqual(
                    watchdogOpts.get('member'),
                    pin.member,
                    `${pin.name}'s watchdog must name the dispatched member so its kill path targets the right session.`
                );
                assert.strictEqual(
                    watchdogOpts.get('label'),
                    pin.watchdogLabel,
                    `${pin.name}'s watchdog label must stay ${pin.watchdogLabel}.`
                );
            }

            // --- KB knowledge injection -----------------------------------------
            // agent() injects the KNOWLEDGE BANK block only for a dispatch that
            // carries an agentType outside KB_SELF_INJECTING_ROLES; a dispatch
            // with no agentType (streak assignment) gets none.
            const agentType = merged.get('agentType') ?? null;
            assert.strictEqual(
                agentType,
                pin.agentType,
                `${pin.name} must pass agentType=${pin.agentType === null ? '(absent)' : pin.agentType}.`
            );
            const roleLiteral = agentType ? agentType.replace(/^['"]|['"]$/g, '') : null;
            const kbInjected = Boolean(roleLiteral) && !KB_SELF_INJECTING_ROLES.has(roleLiteral);
            assert.strictEqual(
                kbInjected,
                pin.agentType !== null,
                `${pin.name}: every planning-side dispatch WITH an agentType receives the engine-injected KNOWLEDGE BANK ` +
                `block, and the one without an agentType receives none.`
            );

            // --- returnable verdicts --------------------------------------------
            assert.strictEqual(
                merged.get('schema') ?? null,
                pin.schema,
                `${pin.name} must pass schema=${pin.schema === null ? '(absent -- free-text response)' : pin.schema}.`
            );

            // --- sprint_id ------------------------------------------------------
            // Supplied once by the agent() wrapper for EVERY dispatch; no
            // planning-side call site overrides it.
            assert.strictEqual(
                merged.get('sprint_id') ?? null,
                null,
                `${pin.name} must NOT pass its own sprint_id -- the agent() wrapper supplies the sprint-identity token for every dispatch.`
            );
        });
    }
});

describe('planning-role dispatch: cross-cutting invariants', () => {
    test('every agent() dispatch inherits sprint_id from the one agent() wrapper', () => {
        const stripped = stripComments(SRC);
        assert.ok(
            /agentRaw\(\s*finalPrompt\s*,\s*\{\s*sprint_id:\s*sprintMutexId\s*,\s*\.\.\.opts\s*\}\s*\)/.test(stripped),
            'The agent() wrapper must pass sprint_id (the opaque sprint-identity token the reservation ledger keys by) ' +
            'into every underlying dispatch, with the call site opts spread AFTER it so an explicit override still wins.'
        );
        // The wrapper is the only place a raw dispatch is issued, which is what
        // makes the per-ladder "no local sprint_id" pins above sufficient.
        const rawSites = findCallSites(SRC, 'agentRaw', { excludeDeclaration: true });
        assert.strictEqual(
            rawSites.length,
            1,
            `Expected exactly ONE agentRaw(...) call site (inside the agent() wrapper), found ${rawSites.length}. ` +
            'A second one would bypass both the sprint_id token and the KNOWLEDGE BANK injection.'
        );
    });

    test('the KNOWLEDGE BANK block reaches planning roles from the engine, not from a kb_* tool call', () => {
        const stripped = stripComments(SRC);
        assert.ok(
            /if\s*\(opts\.agentType\s*&&\s*!KB_SELF_INJECTING_ROLES\.has\(opts\.agentType\)\s*&&\s*opts\.member_name\)/.test(stripped),
            'agent() must inject the knowledge block for any dispatch carrying an agentType that is not self-injecting.'
        );
        // Neither planning role places the block itself, so both depend on the
        // wrapper above; doer/reviewer are the documented self-injecting pair.
        assert.ok(!KB_SELF_INJECTING_ROLES.has('planner'), 'planner must receive its knowledge block from the agent() wrapper.');
        assert.ok(!KB_SELF_INJECTING_ROLES.has('plan-reviewer'), 'plan-reviewer must receive its knowledge block from the agent() wrapper.');
    });

    test('only the planner and the scoped-replan planner arm a dispatch watchdog', () => {
        // The remaining INLINE ladders' watchdogs are still proved textually.
        // The count is DERIVED from the inline pin table rather than written
        // as a literal, because each dispatchRole migration commit moves one
        // ladder (and therefore its watchdog) out of runner.js and onto the
        // engine, where arming is proved behaviourally instead -- see the
        // engine block below. A literal would go stale on every such commit
        // and stop meaning anything.
        const inlineWatchdogPins = INLINE_LADDERS.filter((pin) => pin.watchdog);
        assert.strictEqual(
            WATCHDOG_SITES.length,
            inlineWatchdogPins.length,
            `Expected exactly ${inlineWatchdogPins.length} withDispatchWatchdog(...) call sites in runner.js (one per ` +
            `still-inline watchdog-armed pin: ${inlineWatchdogPins.map((p) => p.name).join(', ') || '(none)'}), found ` +
            `${WATCHDOG_SITES.length} (${formatSiteLocations(MODULE_OFFSETS, WATCHDOG_SITES)}). Every other role ` +
            `dispatch relies on the server-side timeout alone.`
        );
        const watchdogLabels = WATCHDOG_SITES
            .map((s) => objectEntries(splitTopLevelArgs(s.callText)[1] || '{}').get('label'))
            .sort();
        assert.deepStrictEqual(
            watchdogLabels,
            inlineWatchdogPins.map((pin) => pin.watchdogLabel).sort(),
            'Each still-inline watchdog must keep the exact label its pin records.'
        );
        for (const site of WATCHDOG_SITES) {
            const member = objectEntries(splitTopLevelArgs(site.callText)[1] || '{}').get('member');
            assert.strictEqual(
                member,
                "getMemberForRole('planner')",
                'Every watchdog-armed dispatch today targets the planner member.'
            );
        }

        // The WHOLE planning side, inline and engine-served together: the
        // watchdog-armed set must stay exactly the three planner-persona
        // dispatches, whichever side of the migration each currently sits on.
        const armed = [...INLINE_LADDERS, ...ENGINE_LADDER.dispatches].filter((pin) => pin.watchdog).map((pin) => pin.name);
        assert.deepStrictEqual(
            armed.sort(),
            [
                'planner (interactive)',
                'planner (resume after max_turns exhaustion)',
                'scoped replan planner',
            ],
            'The watchdog-armed dispatches must remain exactly the interactive planner, its resume, and the scoped replan planner.'
        );
    });

    test('streak assignment is the only planning-side dispatch outside a git sync bracket', () => {
        // Textual half: every still-inline ladder's real bracketing must
        // agree with what its pin declares.
        const inlineSites = INLINE_LADDERS.map((pin) => ({ pin, site: siteFor(pin.anchor) }));
        const unbracketed = inlineSites.filter(({ site }) => !isInsideAnyCall(WITH_GIT_SYNC_SITES, site.index));
        assert.deepStrictEqual(
            unbracketed.map(({ pin }) => pin.name).sort(),
            INLINE_LADDERS.filter((pin) => !pin.bracketed).map((pin) => pin.name).sort(),
            'A still-inline ladder that is (un)bracketed in runner.js must be recorded that way in the pin table -- a ' +
            'newly-unbracketed planner or plan-reviewer dispatch fails here.'
        );

        // Table half, spanning BOTH sides of the migration: the engine-served
        // dispatches' `bracketed` values are each proved behaviourally in the
        // engine block below, so this is the one place the whole planning
        // side's bracket census is compared against the standing invariant.
        const allUnbracketed = [...INLINE_LADDERS, ...ENGINE_LADDER.dispatches]
            .filter((pin) => !pin.bracketed)
            .map((pin) => pin.name);
        assert.deepStrictEqual(
            allUnbracketed.sort(),
            ['streak assignment', 'streak assignment (semantic repair re-ask)'],
            'Exactly the two Streak Assignment dispatches run outside a git-sync bracket; every other planning-side ' +
            'dispatch is bracketed.'
        );
    });

    test('streak assignment deliberately carries no persona, borrows the planner member, and runs at the cheap tier', async () => {
        // apra-fleet-3swo.5.3: the two Streak Assignment dispatches are
        // engine-served, so the per-dispatch facts (no agentType, the planner
        // member, the cheap tier) are proved behaviourally by their pins
        // above. What is asserted HERE is the same three-way statement across
        // both dispatches at once, plus the runner constant those tiers are
        // read from, which is still runner.js source text.
        const streakPins = ENGINE_LADDER.dispatches.filter((pin) => pin.role === 'streak-assignment');
        assert.strictEqual(streakPins.length, 2, 'Streak Assignment has exactly two dispatches: the grouping call and its bounded semantic-repair re-ask.');
        for (const pin of streakPins) {
            const { dispatch, ctx } = await driveEngineTo(pin);
            assert.strictEqual(
                dispatch.options.agentType ?? null,
                null,
                'Streak Assignment passes no agentType: it has no vendored persona of its own, and activating the planner ' +
                'persona on this narrow grouping task makes the model go exploring instead of answering.'
            );
            assert.strictEqual(
                dispatch.options.member_name,
                ctx.getMemberForRole('planner'),
                'Streak Assignment reuses the planner MEMBER purely for model-tier routing.'
            );
            assert.strictEqual(
                dispatch.options.model,
                'cheap',
                'Streak Assignment must use its own fixed tier, not the planner tier.'
            );
        }
        const tiers = objectEntries(objectLiteralFor(SRC, 'FIXED_ROLE_TIER'));
        assert.strictEqual(tiers.get('planner'), "'premium'", 'The planner role dispatches at the premium tier.');
        assert.strictEqual(tiers.get('plan-reviewer'), "'premium'", 'The plan-reviewer role dispatches at the premium tier.');
        assert.strictEqual(
            tiers.get('streakAssignment'),
            "'cheap'",
            'Streak Assignment is a small fully-specified classification call and dispatches at the cheap tier.'
        );
    });

    test('the planning-side anchors each resolve to a distinct dispatch site', () => {
        // To verify this assertion can fail, temporarily change a pin's anchor
        // to match another: e.g., in planning-ladders.mjs change one of the
        // plan-reviewer (once) anchors to 'Continue your plan review exactly where you left off'
        // (an existing anchor that resolves to an agent() site).
        const lines = new Set(PLANNING_LADDERS.map((pin) => siteFor(pin.anchor).line));
        assert.strictEqual(
            lines.size,
            PLANNING_LADDERS.length,
            'Each pin must anchor a DISTINCT dispatch site -- two pins resolving to one site would leave a dispatch unpinned.'
        );
    });
});

describe('planning-role dispatch: retry and degrade ladders', () => {
    // apra-fleet-3swo.5.3: the planner ladder now runs on the engine, so its
    // retry/degrade shape is no longer a property of runner.js source text --
    // a regex over dispatch-role.mjs's generic loop would report the same
    // answer for every role. These two pins are RE-ANCHORED onto the engine
    // and prove the same facts by driving it: same backoff ladder, same
    // no-re-dispatch rule, same single self-heal, same no-mutation pre-sync
    // skip, same fatal exhaustion, same kill-then-resume-at-doubled-turns.
    test('planner: five-step backoff ladder, no re-dispatch after a post-dispatch sync failure, one auth self-heal, fatal on exhaustion', async () => {
        // (a) the bounded [0, 5s, 15s, 30s, 60s] ladder, sized for a real
        //     member busy-lock -- five attempts, four waits, and the ladder is
        //     FATAL once spent (it rethrows rather than degrading).
        const busy = createRecordingCtx({ responses: Array.from({ length: 5 }, () => busyError()) });
        await assert.rejects(
            () => dispatchRole(busy.ctx, 'planner', ROLE_CALL_OPTS.planner),
            /execute_prompt is already running/,
            'An exhausted planner ladder is FATAL to the sprint -- it rethrows rather than degrading to a synthesized result.'
        );
        assert.strictEqual(busy.rec.dispatches.length, 5, 'The planner ladder must make exactly five dispatch attempts.');
        assert.deepStrictEqual(
            busy.rec.logs.filter((m) => /waiting \d+s before retry attempt/.test(m)),
            [
                'Planner dispatch: waiting 5s before retry attempt 2/5...',
                'Planner dispatch: waiting 15s before retry attempt 3/5...',
                'Planner dispatch: waiting 30s before retry attempt 4/5...',
                'Planner dispatch: waiting 60s before retry attempt 5/5...',
            ],
            'The planner dispatch retry ladder must stay the bounded [0, 5s, 15s, 30s, 60s] backoff.'
        );

        // (b) a post-dispatch sync failure must NOT re-dispatch: the planning
        //     turn already ran and its beads writes are local.
        const synced = createRecordingCtx({ responses: [postDispatchSyncError()] });
        await assert.rejects(() => dispatchRole(synced.ctx, 'planner', ROLE_CALL_OPTS.planner));
        assert.strictEqual(
            synced.rec.dispatches.length,
            1,
            'A post-dispatch sync failure must abort the ladder WITHOUT re-dispatching a turn that already ran.'
        );

        // (c) an auth/trust failure is deterministic, so the ladder aborts
        //     rather than burning its remaining attempts -- but an LLM-auth
        //     failure (unlike workspace trust) gets exactly ONE self-heal try.
        const trust = createRecordingCtx({ responses: [trustError()] });
        await assert.rejects(() => dispatchRole(trust.ctx, 'planner', ROLE_CALL_OPTS.planner));
        assert.strictEqual(trust.rec.dispatches.length, 1, 'A workspace-trust failure must end the ladder immediately.');
        assert.strictEqual(trust.rec.authHeals.length, 0, 'Workspace trust is not something LLM-auth self-heal can fix.');

        const unhealable = createRecordingCtx({ responses: [authError(), authError()], healed: false });
        await assert.rejects(() => dispatchRole(unhealable.ctx, 'planner', ROLE_CALL_OPTS.planner));
        assert.strictEqual(
            unhealable.rec.authHeals.length,
            1,
            'An LLM-auth failure must get exactly ONE bounded self-heal attempt inside the ladder.'
        );
        assert.strictEqual(unhealable.rec.dispatches.length, 1, 'An unhealed auth failure ends the ladder.');
        assert.strictEqual(unhealable.rec.authHeals[0].label, 'Planner dispatch');

        const healable = createRecordingCtx({ responses: [authError()], healed: true });
        await dispatchRole(healable.ctx, 'planner', ROLE_CALL_OPTS.planner);
        assert.strictEqual(healable.rec.dispatches.length, 2, 'A healed auth failure must be retried once healed.');

        // (d) only a provably no-mutation failure may let the next attempt
        //     skip its pre-dispatch sync.
        const noMutation = createRecordingCtx({ responses: Array.from({ length: 5 }, () => busyError()), noMutation: () => true });
        await assert.rejects(() => dispatchRole(noMutation.ctx, 'planner', ROLE_CALL_OPTS.planner));
        assert.strictEqual(
            noMutation.rec.dispatches[1].bracket.options.skipPreDispatchSync,
            true,
            'After a provably no-mutation failure the next attempt skips its pre-dispatch sync.'
        );
        const mutated = createRecordingCtx({ responses: Array.from({ length: 5 }, () => busyError()), noMutation: () => false });
        await assert.rejects(() => dispatchRole(mutated.ctx, 'planner', ROLE_CALL_OPTS.planner));
        assert.strictEqual(
            mutated.rec.dispatches[1].bracket.options.skipPreDispatchSync,
            false,
            'Any other error must re-arm the next attempt\'s pre-dispatch sync.'
        );
    });

    test('planner: max_turns exhaustion resumes the SAME session at doubled turns after killing the stale session', async () => {
        const { ctx, rec } = createRecordingCtx({ responses: [turnExhaustionError()] });
        await dispatchRole(ctx, 'planner', ROLE_CALL_OPTS.planner);
        assert.strictEqual(rec.dispatches.length, 2, 'Turn exhaustion must resume rather than restart or give up.');
        assert.deepStrictEqual(
            rec.kills,
            [ctx.getMemberForRole('planner')],
            'The planner resume must kill a still-alive session before resuming it.'
        );
        const killIndex = rec.events.findIndex((e) => e.type === 'kill');
        const resumeIndex = rec.events.lastIndexOf(rec.events.find((e) => e.type === 'dispatch' && e.entry === rec.dispatches[1]));
        assert.ok(killIndex < resumeIndex, 'The kill must precede the resume dispatch.');
        assert.strictEqual(rec.dispatches[1].options.resume, true, 'The resume must continue the SAME session.');
        assert.strictEqual(
            rec.dispatches[1].options.max_turns,
            rec.dispatches[0].options.max_turns * 2,
            'The resume must double the turn budget.'
        );
        assert.strictEqual(rec.dispatches[1].prompt, ROLE_CALL_OPTS.planner.resumePrompt);

        // Any NON-max_turns error must propagate to the retry ladder rather
        // than being swallowed into a resume.
        const other = createRecordingCtx({ responses: [busyError(), busyError(), busyError(), busyError(), busyError()] });
        await assert.rejects(() => dispatchRole(other.ctx, 'planner', ROLE_CALL_OPTS.planner));
        assert.strictEqual(other.rec.kills.length, 0, 'A non-turn-exhaustion error must never trigger a session kill/resume.');
    });

    // apra-fleet-3swo.5.3: RE-ANCHORED onto the engine, same facts.
    test('plan-reviewer: two attempts per round, and every failure degrades to CHANGES_NEEDED with dispatchFailed set -- never to an approval', async () => {
        const opts = ROLE_CALL_OPTS['plan-reviewer'];

        // Two attempts per round: an infrastructure failure gets exactly one
        // extra attempt WITHIN the round, without consuming a planning round.
        const spent = createRecordingCtx({ responses: [schemaError(), transportError(), 'never reached'] });
        const outcome = await dispatchRole(spent.ctx, 'plan-reviewer', opts);
        assert.strictEqual(spent.rec.dispatches.length, 2, 'The plan review must be attempted exactly twice per round.');

        // Both recognised failure classes -- schema-repair exhaustion and a
        // dropped transport -- degrade to the SAME non-approving verdict, and
        // every synthesized verdict carries the dispatchFailed marker so
        // plan-cap exhaustion can tell a dead dispatch channel from a genuine
        // rejection.
        assert.strictEqual(outcome.degraded, true);
        assert.strictEqual(outcome.value.verdict, 'CHANGES_NEEDED');
        assert.strictEqual(outcome.value.dispatchFailed, true);
        assert.deepStrictEqual(outcome.value.taskAssignments, []);
        assert.match(outcome.value.notes, /^HARNESS-DISPATCH-CLASS: connection dropped$/, 'A transport failure must be noted through the dispatch-class note builder.');

        const schemaOnly = createRecordingCtx({ responses: [schemaError(), schemaError()] });
        const schemaOutcome = await dispatchRole(schemaOnly.ctx, 'plan-reviewer', opts);
        assert.strictEqual(schemaOutcome.value.verdict, 'CHANGES_NEEDED');
        assert.strictEqual(schemaOutcome.value.dispatchFailed, true);
        assert.match(schemaOutcome.value.notes, /^HARNESS-SCHEMA-CLASS: /, 'Schema-repair exhaustion must be noted through the schema-class note builder, not the dispatch one.');

        // No degrade path may ever synthesize an APPROVED plan verdict.
        for (const o of [outcome, schemaOutcome]) {
            assert.notStrictEqual(o.value.verdict, 'APPROVED', 'No degrade path may ever synthesize an APPROVED plan verdict.');
        }

        // An unrecognised error class must still propagate rather than being
        // degraded silently.
        const unrecognised = createRecordingCtx({ responses: [new TypeError('not a dispatch failure at all')] });
        await assert.rejects(
            () => dispatchRole(unrecognised.ctx, 'plan-reviewer', opts),
            TypeError,
            'An unrecognised error class must still propagate rather than being degraded silently.'
        );

        // An unhealed LLM-auth failure would reproduce on every remaining
        // planning round, so one self-heal attempt runs here.
        const auth = createRecordingCtx({ responses: [authError(), authError()], healed: false });
        await dispatchRole(auth.ctx, 'plan-reviewer', opts);
        assert.strictEqual(auth.rec.authHeals.length, 2, 'Each failing attempt self-heals, so the next round has a real chance.');
        assert.strictEqual(auth.rec.authHeals[0].label, 'Plan Reviewer dispatch');
    });

    // apra-fleet-3swo.5.3: RE-ANCHORED onto the engine, same facts.
    test('scoped replan planner: single attempt, no retry ladder, degrades by deferring the flagged beads to the next cycle', async () => {
        const opts = ROLE_CALL_OPTS['scoped-replan-planner'];

        // A SINGLE bounded attempt: no retry ladder of its own, and no
        // announced backoff wait.
        const failed = createRecordingCtx({ responses: [transportError(), 'never reached'] });
        const outcome = await dispatchRole(failed.ctx, 'scoped-replan-planner', opts);
        assert.strictEqual(failed.rec.dispatches.length, 1, 'The scoped replan planner is a SINGLE bounded attempt.');
        assert.deepStrictEqual(
            failed.rec.logs.filter((m) => /waiting [\d.]+s before retry attempt/.test(m)),
            [],
            'A single-attempt ladder announces no backoff waits.'
        );

        // A failure must never abort the sprint: it degrades to leaving the
        // flagged bead(s) for the next cycle, fabricating nothing.
        assert.strictEqual(outcome.ok, false, 'A failed scoped planner dispatch must be reported as not-ok, so the caller can defer.');
        assert.strictEqual(outcome.degraded, true);
        assert.strictEqual(outcome.value, null, 'A defer-to-next-cycle degrade fabricates no value at all.');
        assert.ok(outcome.error, 'The caller needs the real error to log why it is deferring.');

        // Even an UNRECOGNISED error class degrades here rather than
        // propagating -- the original ladder wrapped the dispatch in a bare
        // catch, and a scoped replan must never end the sprint.
        const weird = createRecordingCtx({ responses: [new TypeError('something else entirely')] });
        const weirdOutcome = await dispatchRole(weird.ctx, 'scoped-replan-planner', opts);
        assert.strictEqual(weirdOutcome.ok, false);
        assert.strictEqual(weirdOutcome.degraded, true);

        // A scoped replan auth failure self-heals so the next cycle's planner
        // does not hit the identical wall.
        const auth = createRecordingCtx({ responses: [authError()], healed: false });
        await dispatchRole(auth.ctx, 'scoped-replan-planner', opts);
        assert.strictEqual(auth.rec.authHeals.length, 1);
        assert.strictEqual(auth.rec.authHeals[0].label, 'Scoped Replan Plan dispatch');

        // A SUCCESSFUL scoped replan mutated beads on the planner clone, so
        // the orchestrator cache must be invalidated before the scoped review
        // reads it -- and a FAILED one must not pretend anything changed.
        const ok = createRecordingCtx({});
        await dispatchRole(ok.ctx, 'scoped-replan-planner', opts);
        assert.strictEqual(ok.rec.invalidations, 1, 'A successful scoped replan must invalidate the orchestrator beads cache.');
        assert.strictEqual(failed.rec.invalidations, 0, 'A failed scoped replan must not invalidate anything.');
    });

    // apra-fleet-3swo.5.3: RE-ANCHORED onto the engine, same facts.
    test('scoped replan plan-reviewer: only an explicit APPROVED approves, and any failure is a non-approval', async () => {
        const opts = ROLE_CALL_OPTS['scoped-replan-plan-reviewer'];

        // ONLY a returned APPROVED verdict may approve a scoped replan: the
        // engine hands the caller the verdict verbatim and fabricates nothing,
        // so the caller's `=== 'APPROVED'` check is the only approval path.
        const approved = createRecordingCtx({ responses: [{ verdict: 'APPROVED', notes: 'ok', taskAssignments: [] }] });
        const approvedOutcome = await dispatchRole(approved.ctx, 'scoped-replan-plan-reviewer', opts);
        assert.strictEqual(approvedOutcome.ok, true);
        assert.strictEqual(approvedOutcome.value.verdict, 'APPROVED');

        // A schema-repair-exhausted or dispatch failure is a FAILED scoped
        // review -- never an approval -- and never aborts the sprint.
        for (const err of [schemaError(), transportError(), new TypeError('something else entirely')]) {
            const failed = createRecordingCtx({ responses: [err] });
            const outcome = await dispatchRole(failed.ctx, 'scoped-replan-plan-reviewer', opts);
            assert.strictEqual(failed.rec.dispatches.length, 1, 'The scoped plan-review is a SINGLE bounded attempt.');
            assert.strictEqual(outcome.ok, false, `${err.constructor.name}: a failed scoped review must be reported not-ok.`);
            assert.strictEqual(outcome.degraded, true);
            assert.strictEqual(
                outcome.value,
                null,
                'A non-approval degrade fabricates NO verdict at all -- there is nothing for the caller to mistake for an approval.'
            );
            assert.ok(outcome.error, 'The caller needs the real error to log why the replan was not approved.');
        }

        // Same rationale as the scoped planner: self-heal before deferring to
        // the next cycle's planner/plan-reviewer pass.
        const auth = createRecordingCtx({ responses: [authError()], healed: false });
        await dispatchRole(auth.ctx, 'scoped-replan-plan-reviewer', opts);
        assert.strictEqual(auth.rec.authHeals.length, 1);
        assert.strictEqual(auth.rec.authHeals[0].label, 'Scoped Replan Review dispatch');
    });

    // apra-fleet-3swo.5.3: RE-ANCHORED onto the engine, same facts.
    test('streak assignment: schema/dispatch failures fall back to one-bead-per-streak, with exactly one bounded semantic-repair re-ask', async () => {
        const opts = { ...ROLE_CALL_OPTS['streak-assignment'], validate: streakValidate };

        // Schema-repair exhaustion and a dispatch/transport failure must BOTH
        // degrade to the deterministic fallback grouping -- the engine hands
        // the caller a validated null candidate, which is exactly what
        // selectStreaks() turns into one-bead-per-streak.
        for (const err of [schemaError(), transportError()]) {
            const failed = createRecordingCtx({ responses: [err] });
            const outcome = await dispatchRole(failed.ctx, 'streak-assignment', opts);
            assert.strictEqual(failed.rec.dispatches.length, 1, 'Streak Assignment is a SINGLE bounded attempt.');
            assert.strictEqual(outcome.degraded, true);
            assert.strictEqual(outcome.value, null, 'The degrade fabricates no grouping; the caller applies its deterministic fallback.');
            assert.strictEqual(
                outcome.validation.usedFallback,
                true,
                'The candidate grouping is validated by selectStreaks(), which is what decides whether the fallback is used.'
            );
        }

        // An unrecognised error class must still propagate.
        const weird = createRecordingCtx({ responses: [new TypeError('something else entirely')] });
        await assert.rejects(() => dispatchRole(weird.ctx, 'streak-assignment', opts), TypeError);

        // Streak Assignment self-heals an auth failure because the SAME member
        // is dispatched again later in the cycle.
        const auth = createRecordingCtx({ responses: [authError()], healed: false });
        await dispatchRole(auth.ctx, 'streak-assignment', opts);
        assert.strictEqual(auth.rec.authHeals.length, 1);
        assert.strictEqual(auth.rec.authHeals[0].label, 'Streak Assignment dispatch');

        // The semantic-repair re-ask: ONE bounded attempt layered on top of
        // agent()'s own bounded schema-repair loop -- guarded, not looped. A
        // candidate that keeps failing validation gets exactly one re-ask and
        // then the fallback, never a second.
        const repaired = createRecordingCtx({ responses: [REJECTED_CANDIDATE, ACCEPTED_CANDIDATE] });
        const repairedOutcome = await dispatchRole(repaired.ctx, 'streak-assignment', opts);
        assert.strictEqual(repaired.rec.dispatches.length, 2, 'A rejected candidate must be re-asked exactly once.');
        assert.strictEqual(
            repaired.rec.dispatches[1].options.label,
            ROLE_CALL_OPTS['streak-assignment'].repairLabel,
            'There must be exactly one semantic-repair re-ask dispatch, and it must be labelled as such.'
        );
        assert.match(
            repaired.rec.dispatches[1].prompt,
            /Your previous answer was REJECTED: ids did not cover the ready set/,
            'The re-ask must feed the exact validation failure back to the model rather than blindly repeating the prompt.'
        );
        assert.strictEqual(
            repairedOutcome.validation.usedFallback,
            false,
            'The re-asked candidate must be re-validated by selectStreaks() before it is trusted.'
        );

        const neverAccepted = createRecordingCtx({ responses: [REJECTED_CANDIDATE, REJECTED_CANDIDATE, REJECTED_CANDIDATE] });
        const neverOutcome = await dispatchRole(neverAccepted.ctx, 'streak-assignment', opts);
        assert.strictEqual(neverAccepted.rec.dispatches.length, 2, 'The re-ask is ONE bounded attempt -- never a loop.');
        assert.strictEqual(neverOutcome.validation.usedFallback, true, 'A twice-rejected candidate falls back deterministically.');

        // A re-ask whose own dispatch fails falls back rather than propagating.
        const repairFailed = createRecordingCtx({ responses: [REJECTED_CANDIDATE, transportError()] });
        const repairFailedOutcome = await dispatchRole(repairFailed.ctx, 'streak-assignment', opts);
        assert.strictEqual(repairFailedOutcome.validation.usedFallback, true);
        assert.ok(
            repairFailed.rec.logs.some((m) => /\(semantic repair\): dispatch failed/.test(m)),
            'A failed re-ask must announce the fallback rather than aborting the round.'
        );
    });
});

describe('planning-role dispatch: returnable verdicts', () => {
    test('the plan-reviewer ladders can return exactly APPROVED or CHANGES_NEEDED', () => {
        assert.deepStrictEqual(
            planReviewerVerdict.properties.verdict.enum,
            ['APPROVED', 'CHANGES_NEEDED'],
            'The plan-reviewer verdict vocabulary is what the planning loop branches on; widening it silently changes plan-cap behaviour.'
        );
        assert.deepStrictEqual(
            planReviewerVerdict.required,
            ['verdict', 'notes', 'taskAssignments'],
            'A plan-review verdict must carry its notes (fed back to the planner) and taskAssignments (read by the plan-cap deferral path).'
        );
    });

    test('streak assignment returns a streaks grouping, and the planner ladders return free text', () => {
        assert.deepStrictEqual(streakAssignment.required, ['streaks'], 'Streak Assignment returns a schema-validated streaks grouping.');
        assert.strictEqual(streakAssignment.properties.streaks.type, 'array');
        assert.strictEqual(streakAssignment.properties.streaks.items.type, 'array');
        assert.strictEqual(streakAssignment.properties.streaks.items.items.type, 'string');
        // The planner-persona ladders, whichever side of the migration each
        // currently sits on. A still-inline one is read off runner.js; an
        // engine-served one's `schema` is proved behaviourally by its
        // per-dispatch pin above, so here it is the census that matters.
        const plannerLadders = INLINE_LADDERS.filter((pin) => pin.ladder.includes('planner'));
        for (const pin of plannerLadders) {
            const { merged } = effectiveOpts(siteFor(pin.anchor));
            assert.strictEqual(
                merged.get('schema') ?? null,
                null,
                'A planner dispatch returns free-text prose, not a structured verdict -- its real output is the mutated bead DAG.'
            );
        }
        const engagedPlannerDispatches = ENGINE_LADDER.dispatches.filter((pin) => pin.role.includes('planner'));
        for (const pin of engagedPlannerDispatches) {
            assert.strictEqual(
                pin.schema,
                null,
                `${pin.name} returns free-text prose, not a structured verdict.`
            );
        }
        assert.strictEqual(
            plannerLadders.length + engagedPlannerDispatches.length,
            3,
            'There are exactly three planner-persona planning dispatches: the interactive planner, its resume, and the ' +
            'scoped replan planner.'
        );
    });
});

// =============================================================================
// apra-fleet-3swo.5.3 -- the ENGINE half of these pins.
//
// PER-PIN INVENTORY: how each pre-migration assertion above is replaced once a
// ladder moves onto dispatchRole. Nothing is dropped; only the evidence
// changes from "this text appears in runner.js" to "the real engine, driven
// with the real frozen policy row, actually did this".
//
//   PRE-MIGRATION (textual, runner.js)        POST-MIGRATION (behavioural, engine)
//   ----------------------------------------  --------------------------------------
//   merged.get('member_name') === expr         recorded dispatch options.member_name
//   merged.get('model') === FIXED_ROLE_TIER.x  options.model, resolved through
//                                              ctx.fixedRoleTier read from runner.js
//   resolveTurns(merged.get('max_turns'))      options.max_turns (absent => default)
//   merged.get('timeout_s'/'max_total_s')      options.timeout_s / options.max_total_s,
//                                              resolved from the SYMBOLIC budget name
//   merged.get('resume')                       options.resume
//   merged.get('agentType')                    options.agentType
//   merged.get('schema')                       options.schema, identity-compared to
//                                              the real contracts.mjs object
//   merged.get('sprint_id') === null           options has no sprint_id key (the
//                                              agent() wrapper still supplies it --
//                                              that wrapper pin is unchanged above)
//   innermostEnclosingCall(WITH_GIT_SYNC_SITES) the withGitSync bracket really opened
//     + bracketArgs[0]/[1]/pushBeads             around the dispatch: member, pushCode,
//                                                pushBeads
//   innermostEnclosingCall(WATCHDOG_SITES)     the withDispatchWatchdog really armed
//     + timeoutS/member/label                    around it: timeoutS, member, label
//   KB_SELF_INJECTING_ROLES reasoning          unchanged: still asserted from the
//                                              agentType the engine passes
//   region regex: retry ladder shape           the attempts/backoff/self-heal/abort
//                                              behaviour the engine really performs
//   region regex: degrade shape                the value dispatchRole really returns
//                                              once the attempts are spent
// =============================================================================

const DISPATCH_ROLE_SRC = fs.readFileSync(path.join(FLEET_SPRINT_DIR, 'dispatch-role.mjs'), 'utf8');

describe('planning-role dispatch: the dispatchRole engine call site', () => {
    test('the engine hosts exactly ONE agent() dispatch, and it names its member at the call site', () => {
        const engineSites = findCallSites(DISPATCH_ROLE_SRC, 'agent');
        assert.strictEqual(
            engineSites.length,
            1,
            `dispatch-role.mjs must contain exactly ONE agent() call site -- the whole point of the engine is that ` +
            `every per-role difference is read out of the policy row rather than written out again as a second ` +
            `dispatch. Found ${engineSites.length}.`
        );
        assert.ok(
            engineSites[0].callText.includes(ENGINE_LADDER.anchor),
            `The engine's dispatch must spell ${JSON.stringify(ENGINE_LADDER.anchor)} at the call site itself ` +
            '(dispatch-safety-guard.mjs requires every agent() call site to name its member explicitly).'
        );
        // ...and the census entry above must resolve to that same single site
        // within the scanned module set, so no engine dispatch is unpinned.
        siteFor(ENGINE_LADDER.anchor);
    });

    test('the engine wraps its ONE dispatch in at most one bracket and one watchdog', () => {
        // These are ctx.* calls (injected, never imported), so the shared
        // scanner deliberately does not see them as call sites; assert them
        // directly against the engine's own source instead.
        assert.strictEqual(
            (DISPATCH_ROLE_SRC.match(/ctx\.withGitSync\(/g) || []).length,
            1,
            'The engine must open the git-sync bracket in exactly ONE place -- a second bracket call would be a ' +
            'per-role special case creeping back in.'
        );
        assert.strictEqual(
            (DISPATCH_ROLE_SRC.match(/ctx\.withDispatchWatchdog\(/g) || []).length,
            1,
            'The engine must race its dispatch against the watchdog in exactly ONE place.'
        );
    });
});

/**
 * Drives the REAL engine so that `pin`'s specific dispatch happens. The
 * driver lives in ./helpers/dispatch-role-harness.mjs so this file and
 * role-policies-table.test.mjs cannot drift on HOW a dispatch is produced.
 */
async function driveEngineTo(pin) {
    const driven = await driveEngineDispatch(pin.role, pin.kind);
    assert.ok(
        driven.dispatch,
        `${pin.name}: the engine never made the expected ${pin.kind} dispatch (it made ${driven.rec.dispatches.length}).`
    );
    return driven;
}

describe('planning-role dispatch ladders: per-dispatch pins (engine-served)', () => {
    for (const pin of ENGINE_DISPATCHES) {
        test(`${pin.name}: member routing, bracketing, turns, timeout, watchdog, KB and verdict schema`, async () => {
            const { ctx, dispatch, opts } = await driveEngineTo(pin);
            const o = dispatch.options;
            const member = ctx.getMemberForRole(pin.memberRole);

            // --- member routing -------------------------------------------------
            assert.strictEqual(
                o.member_name,
                member,
                `${pin.name} must route to the '${pin.memberRole}' role member.`
            );

            // --- model tier -----------------------------------------------------
            assert.strictEqual(
                o.model ?? null,
                pin.modelTier,
                `${pin.name} must dispatch at model tier ${pin.modelTier} (runner.js's own FIXED_ROLE_TIER value).`
            );

            // --- turn budget and timeout ----------------------------------------
            assert.strictEqual(
                o.max_turns ?? null,
                pin.maxTurns,
                `${pin.name} must pass max_turns ${pin.maxTurns === null ? '(none -- the dispatch default)' : pin.maxTurns}.`
            );
            // Budgets stay SYMBOLIC: the pin names the budget, and the engine
            // must resolve it through ctx.budgets rather than hard-coding a
            // number -- the harness's sentinel value makes a hard-coded
            // fallback impossible to miss.
            assert.strictEqual(
                o.timeout_s ?? null,
                pin.timeoutS === null ? null : ctx.budgets[pin.timeoutS],
                `${pin.name} must pass timeout_s resolved from ${pin.timeoutS ?? '(none -- the dispatch default)'}.`
            );
            assert.strictEqual(
                o.max_total_s ?? null,
                pin.maxTotalS === null ? null : ctx.budgets[pin.maxTotalS],
                `${pin.name} must pass max_total_s resolved from ${pin.maxTotalS ?? '(none -- the dispatch default)'}.`
            );

            // --- same-session resume flag ---------------------------------------
            const expectedResume = pin.resume === 'call-site' ? opts.resumeArg : pin.resume;
            assert.strictEqual(
                o.resume ?? null,
                expectedResume ?? null,
                `${pin.name}: same-session resume argument.`
            );

            // --- git sync bracketing and push flags -----------------------------
            if (!pin.bracketed) {
                assert.strictEqual(
                    dispatch.bracket,
                    null,
                    `${pin.name} runs OUTSIDE any git-sync bracket -- it is a pure-compute call with no repo access.`
                );
            } else {
                assert.ok(dispatch.bracket, `${pin.name} must be wrapped in a git-sync bracket.`);
                assert.strictEqual(
                    dispatch.bracket.member,
                    member,
                    `${pin.name}'s bracket must sync the SAME member the dispatch routes to.`
                );
                assert.strictEqual(dispatch.bracket.pushCode, pin.pushCode, `${pin.name}: pushCode flag.`);
                assert.strictEqual(dispatch.bracket.options.pushBeads, pin.pushBeads, `${pin.name}: pushBeads flag.`);
            }

            // --- watchdog arming ------------------------------------------------
            if (!pin.watchdog) {
                assert.strictEqual(dispatch.watchdog, null, `${pin.name} is NOT raced against a client-side dispatch watchdog.`);
            } else {
                assert.ok(dispatch.watchdog, `${pin.name} must be raced against a client-side dispatch watchdog.`);
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
            assert.strictEqual(o.agentType ?? null, pin.agentType, `${pin.name}: persona.`);
            const kbInjected = Boolean(pin.agentType) && !KB_SELF_INJECTING_ROLES.has(pin.agentType);
            assert.strictEqual(
                kbInjected,
                pin.agentType !== null,
                `${pin.name}: every planning-side dispatch WITH an agentType receives the engine-injected KNOWLEDGE ` +
                'BANK block, and the one without an agentType receives none.'
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
});
