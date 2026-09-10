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
    turnExhaustionError,
    ROLE_CALL_OPTS,
    DISPATCH_TIMEOUT_S,
    SCHEMAS,
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
// HOW THESE PIN: runner.js's dispatch sites are not separately importable
// today -- they are closures over per-run state inside one very large
// function, which is the condition the refactor exists to fix. So each ladder
// is located STRUCTURALLY in runner.js's source (by its prompt/label anchor,
// never by line number -- runner.js keeps shrinking as extraction phases land)
// and its dispatch options are resolved the way the JS engine would: the
// spread base object first, then the call site's own inline keys on top. The
// shared scanner lives in ./helpers/dispatch-pin-scanner.mjs.
//
// WHAT EACH LADDER PINS: member routing, sync bracketing + push flags,
// max_turns, timeout, watchdog arming, retry/degrade behaviour, KB knowledge
// injection, returnable verdicts, and sprint_id presence.
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
        // dispatches\' `bracketed` values are each proved behaviourally in the
        // engine block below, so this is the one place the whole planning
        // side\'s bracket census is compared against the standing invariant.
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

    test('streak assignment deliberately carries no persona, borrows the planner member, and runs at the cheap tier', () => {
        for (const anchor of ["label: 'Streak Assignment',", "label: 'Streak Assignment (semantic repair)'"]) {
            const { merged } = effectiveOpts(siteFor(anchor));
            assert.strictEqual(
                merged.get('agentType') ?? null,
                null,
                'Streak Assignment passes no agentType: it has no vendored persona of its own, and activating the planner ' +
                'persona on this narrow grouping task makes the model go exploring instead of answering.'
            );
            assert.strictEqual(
                merged.get('member_name'),
                "getMemberForRole('planner')",
                'Streak Assignment reuses the planner MEMBER purely for model-tier routing.'
            );
            assert.strictEqual(
                merged.get('model'),
                'FIXED_ROLE_TIER.streakAssignment',
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
    test('planner: five-step backoff ladder, no re-dispatch after a post-dispatch sync failure, one auth self-heal, fatal on exhaustion', () => {
        const region = stripComments(regionBetween(SRC, 'const PLANNER_DISPATCH_RETRY_DELAYS_MS', 'throw plannerErr;'));
        assert.ok(
            /PLANNER_DISPATCH_RETRY_DELAYS_MS\s*=\s*\[0,\s*5000,\s*15000,\s*30000,\s*60000\]/.test(region),
            'The planner dispatch retry ladder must stay the bounded [0, 5s, 15s, 30s, 60s] backoff sized for a real member busy-lock.'
        );
        assert.ok(
            /isPostDispatchSyncFailure\(err\)/.test(region),
            'A post-dispatch sync failure must be recognised so the ladder does NOT re-dispatch a planning turn that already ran.'
        );
        assert.ok(
            /isNonRetryableDispatchError\(err\)/.test(region),
            'Auth/workspace-trust failures must abort the ladder rather than burn the remaining attempts.'
        );
        assert.ok(
            /isAuthDispatchError\(err\)\s*&&\s*typeof onLlmAuthFailure === 'function'/.test(region),
            'An LLM-auth failure must get exactly one bounded self-heal attempt inside the ladder.'
        );
        assert.ok(
            /skipPreDispatchSyncNext = isNoMutationDispatchFailure\(err\)/.test(region),
            'Only a provably no-mutation dispatch failure may let the next attempt skip its pre-dispatch sync.'
        );
        // Degrade behaviour: there is none. An exhausted planner ladder rethrows.
        assert.ok(
            /if \(plannerErr\) \{\s*throw plannerErr;/.test(stripComments(SRC)),
            'An exhausted planner ladder is FATAL to the sprint -- it rethrows rather than degrading to a synthesized result.'
        );
    });

    test('planner: max_turns exhaustion resumes the SAME session at doubled turns after killing the stale session', () => {
        const region = stripComments(regionBetween(SRC, 'const dispatchPlanner = async (', 'const PLANNER_DISPATCH_RETRY_DELAYS_MS'));
        assert.ok(
            /err instanceof AgentDispatchError && err\.details\?\.reason === 'max_turns_exhausted'/.test(region),
            'The planner resume must trigger on max_turns exhaustion specifically, not on any dispatch error.'
        );
        assert.ok(
            /memberSessionGuard\.killIfAlive\(getMemberForRole\('planner'\)\)/.test(region),
            'The planner resume must kill a still-alive session before resuming it.'
        );
        assert.ok(/dispatchPlannerResume\(\)/.test(region), 'The planner resume ladder must call dispatchPlannerResume().');
        assert.ok(/throw err;/.test(region), 'Any non-max_turns error must propagate to the retry ladder rather than being swallowed.');
    });

    test('plan-reviewer: two attempts per round, and every failure degrades to CHANGES_NEEDED with dispatchFailed set -- never to an approval', () => {
        const region = stripComments(regionBetween(SRC, 'for (let planReviewAttempt = 1;', 'lastVerdict = verdict;'));
        assert.ok(
            /planReviewAttempt <= 2/.test(region),
            'An infrastructure failure gets exactly one extra attempt WITHIN the round, without consuming a planning round.'
        );
        const changesNeeded = region.match(/verdict: 'CHANGES_NEEDED'/g) || [];
        assert.strictEqual(
            changesNeeded.length,
            2,
            `Expected exactly 2 synthesized CHANGES_NEEDED fallback verdicts (schema-repair exhaustion and dispatch failure), found ${changesNeeded.length}.`
        );
        const dispatchFailed = region.match(/dispatchFailed: true/g) || [];
        assert.strictEqual(
            dispatchFailed.length,
            2,
            'Every synthesized fallback verdict must carry dispatchFailed:true so plan-cap exhaustion can tell a dead dispatch channel from a genuine rejection.'
        );
        assert.ok(
            !/verdict: 'APPROVED'/.test(region),
            'No degrade path may ever synthesize an APPROVED plan verdict.'
        );
        assert.ok(
            /err instanceof AgentOutputError/.test(region) && /err instanceof AgentDispatchError \|\| err instanceof FleetTransportError/.test(region),
            'Both schema-repair exhaustion and transport/dispatch failure must be caught and degraded here.'
        );
        assert.ok(/throw err;/.test(region), 'An unrecognised error class must still propagate rather than being degraded silently.');
        assert.ok(
            /isAuthDispatchError\(err\) && typeof onLlmAuthFailure === 'function'/.test(region),
            'An unhealed LLM-auth failure would reproduce on every remaining planning round, so one self-heal attempt runs here.'
        );
    });

    test('scoped replan planner: single attempt, no retry ladder, degrades by deferring the flagged beads to the next cycle', () => {
        const region = stripComments(regionBetween(SRC, '--- Scoped planner pass ---', '--- Scoped plan-review pass ---'));
        assert.ok(/let scopedPlannerOk = true;/.test(region), 'The scoped planner pass tracks its own success flag.');
        assert.ok(/scopedPlannerOk = false;/.test(region), 'A failed scoped planner dispatch must clear that flag.');
        assert.ok(
            !/\bfor\s*\(/.test(region) && !/\bwhile\s*\(/.test(region),
            'The scoped replan planner is a SINGLE bounded attempt -- it has no retry ladder of its own.'
        );
        assert.ok(
            !/\bthrow\b/.test(region),
            'A scoped replan planner failure must never abort the sprint: it degrades to leaving the flagged beads for the next cycle.'
        );
        assert.ok(
            /isAuthDispatchError\(err\) && typeof onLlmAuthFailure === 'function'/.test(region),
            'A scoped replan auth failure self-heals so the next cycle\'s planner does not hit the identical wall.'
        );
        assert.ok(
            /invalidateAllBeadsCache\(\);/.test(region),
            'A successful scoped replan mutated beads on the planner clone, so the orchestrator cache must be invalidated before the scoped review reads it.'
        );
    });

    test('scoped replan plan-reviewer: only an explicit APPROVED approves, and any failure is a non-approval', () => {
        const region = stripComments(regionBetween(SRC, '--- Scoped plan-review pass ---', 'if (scopedReplanApproved) {'));
        assert.ok(/let scopedReplanApproved = false;/.test(region), 'The scoped replan starts un-approved.');
        assert.ok(
            /scopedReplanApproved = scopedVerdict\.verdict === 'APPROVED';/.test(region),
            'Only a returned APPROVED verdict may approve a scoped replan.'
        );
        assert.ok(
            /if \(scopedPlannerOk\) \{/.test(region),
            'The scoped plan-review only runs when the scoped planner pass itself succeeded.'
        );
        assert.ok(
            !/\bthrow\b/.test(region),
            'A scoped plan-review dispatch failure degrades to NOT approved; it never aborts the sprint.'
        );
    });

    test('streak assignment: schema/dispatch failures fall back to one-bead-per-streak, with exactly one bounded semantic-repair re-ask', () => {
        const region = stripComments(regionBetween(SRC, 'let streakCandidate = null;', 'if (usedFallback) {'));
        assert.ok(
            /err instanceof AgentOutputError/.test(region),
            'Schema-repair exhaustion must degrade to the deterministic fallback grouping.'
        );
        assert.ok(
            /err instanceof AgentDispatchError \|\| err instanceof FleetTransportError/.test(region),
            'A dispatch/transport failure must degrade to the deterministic fallback grouping.'
        );
        assert.ok(/throw err;/.test(region), 'An unrecognised error class must still propagate.');
        assert.ok(
            /isAuthDispatchError\(err\) && typeof onLlmAuthFailure === 'function'/.test(region),
            'Streak Assignment self-heals an auth failure because the SAME member is dispatched again later in the cycle.'
        );
        assert.ok(
            /selectStreaks\(streakCandidate, currentReady\)/.test(region),
            'The candidate grouping is validated by selectStreaks(), which is what decides whether the fallback is used.'
        );

        // The semantic-repair re-ask: ONE bounded attempt layered on top of
        // agent()'s own bounded schema-repair loop -- guarded, not looped.
        const repair = stripComments(regionBetween(SRC, 'if (usedFallback && streakCandidate) {', 'if (usedFallback) {'));
        assert.ok(
            !/\bfor\s*\(/.test(repair) && !/\bwhile\s*\(/.test(repair),
            'The semantic-repair re-ask is ONE bounded attempt -- never a loop.'
        );
        const reAskSites = AGENT_SITES.filter((s) => s.callText.includes("label: 'Streak Assignment (semantic repair)'"));
        assert.strictEqual(reAskSites.length, 1, 'There must be exactly one semantic-repair re-ask dispatch.');
        assert.ok(
            /Your previous answer was REJECTED/.test(repair),
            'The re-ask must feed the exact validation failure back to the model rather than blindly repeating the prompt.'
        );
        assert.ok(
            /\(\{ streaks, usedFallback, reason \} = selectStreaks\(streakCandidate, currentReady\)\);/.test(repair),
            'The re-asked candidate must be re-validated by selectStreaks() before it is trusted.'
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
        for (const anchor of ['(plannerPrompt,', 'Continue your planning pass exactly where you left off', "label: 'Scoped Replan Plan (interactive)'"]) {
            const { merged } = effectiveOpts(siteFor(anchor));
            assert.strictEqual(
                merged.get('schema') ?? null,
                null,
                'A planner dispatch returns free-text prose, not a structured verdict -- its real output is the mutated bead DAG.'
            );
        }
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
 * Drives the REAL engine so that `pin`'s specific dispatch happens, and
 * returns the recording ctx's timeline. Each dispatch KIND needs its own
 * driver because that is what distinguishes them: a resume only happens after
 * turn exhaustion, a semantic-repair re-ask only after a candidate fails
 * validation.
 */
async function driveEngineTo(pin) {
    const opts = { ...ROLE_CALL_OPTS[pin.role] };
    let responses = [];
    if (pin.kind === 'max-turns-resume') {
        responses = [turnExhaustionError()];
    }
    if (pin.kind === 'semantic-repair-re-ask') {
        responses = ['REJECTED CANDIDATE', 'ACCEPTED CANDIDATE'];
    }
    if (pin.role === 'streak-assignment') {
        opts.validate = (value) => (value === 'ACCEPTED CANDIDATE' || value === 'dispatch ok'
            ? { ok: true, reason: null, result: { usedFallback: false } }
            : { ok: false, reason: 'ids did not cover the ready set', result: { usedFallback: true } });
    }
    const { ctx, rec } = createRecordingCtx({ responses });
    const outcome = await dispatchRole(ctx, pin.role, opts);
    const index = pin.kind === 'main' ? 0 : 1;
    assert.ok(
        rec.dispatches[index],
        `${pin.name}: the engine never made the expected ${pin.kind} dispatch (it made ${rec.dispatches.length}).`
    );
    return { rec, outcome, dispatch: rec.dispatches[index] };
}

describe('planning-role dispatch ladders: per-dispatch pins (engine-served)', () => {
    for (const pin of ENGINE_DISPATCHES) {
        test(`${pin.name}: member routing, bracketing, turns, timeout, watchdog, KB and verdict schema`, async () => {
            const { dispatch } = await driveEngineTo(pin);
            const o = dispatch.options;

            // --- member routing -------------------------------------------------
            assert.strictEqual(o.member_name, pin.member, `${pin.name} must route to ${pin.member}.`);

            // --- model tier -----------------------------------------------------
            assert.strictEqual(o.model ?? null, pin.modelTier, `${pin.name} must dispatch at model tier ${pin.modelTier}.`);

            // --- turn budget and timeout ----------------------------------------
            assert.strictEqual(
                o.max_turns ?? null,
                pin.maxTurns,
                `${pin.name} must pass max_turns ${pin.maxTurns === null ? '(none -- the dispatch default)' : pin.maxTurns}.`
            );
            assert.strictEqual(o.timeout_s ?? null, pin.timeoutS, `${pin.name}: inactivity timeout budget.`);
            assert.strictEqual(o.max_total_s ?? null, pin.maxTotalS, `${pin.name}: hard elapsed-time budget.`);

            // --- same-session resume flag ---------------------------------------
            assert.strictEqual(o.resume ?? null, pin.resume, `${pin.name}: same-session resume argument.`);

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
                    pin.member,
                    `${pin.name}'s bracket must sync the SAME member the dispatch routes to.`
                );
                assert.strictEqual(dispatch.bracket.pushCode, pin.pushCode, `${pin.name}: pushCode flag.`);
                assert.strictEqual(
                    dispatch.bracket.options.pushBeads ?? null,
                    pin.pushBeads,
                    `${pin.name}: pushBeads flag.`
                );
            }

            // --- watchdog arming ------------------------------------------------
            if (!pin.watchdog) {
                assert.strictEqual(dispatch.watchdog, null, `${pin.name} is NOT raced against a client-side dispatch watchdog.`);
            } else {
                assert.ok(dispatch.watchdog, `${pin.name} must be raced against a client-side dispatch watchdog.`);
                assert.strictEqual(
                    dispatch.watchdog.timeoutS,
                    DISPATCH_TIMEOUT_S,
                    `${pin.name}'s watchdog must fire on the same DISPATCH_TIMEOUT_S budget the server-side timeout uses.`
                );
                assert.strictEqual(
                    dispatch.watchdog.member,
                    pin.member,
                    `${pin.name}'s watchdog must name the dispatched member so its kill path targets the right session.`
                );
                assert.strictEqual(dispatch.watchdog.label, pin.watchdogLabel, `${pin.name}: watchdog label.`);
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
                `${pin.name}: returnable verdict schema.`
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
