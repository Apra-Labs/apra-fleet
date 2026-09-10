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
import { PLANNING_LADDERS } from './helpers/planning-ladders.mjs';

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

describe('planning-role dispatch ladders: per-dispatch pins', () => {
    for (const pin of PLANNING_LADDERS) {
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
        assert.strictEqual(
            WATCHDOG_SITES.length,
            3,
            `Expected exactly 3 withDispatchWatchdog(...) call sites in runner.js (planner interactive, planner resume, ` +
            `scoped replan planner), found ${WATCHDOG_SITES.length} (${formatSiteLocations(MODULE_OFFSETS, WATCHDOG_SITES)}). ` +
            `Every other role dispatch relies on the server-side timeout alone.`
        );
        const watchdogLabels = WATCHDOG_SITES
            .map((s) => objectEntries(splitTopLevelArgs(s.callText)[1] || '{}').get('label'))
            .sort();
        assert.deepStrictEqual(
            watchdogLabels,
            [
                "'Plan (interactive)'",
                "'Scoped Replan Plan (interactive)'",
                '`Plan (resume, max_turns=${PLANNER_MAX_TURNS * 2})`',
            ].sort(),
            'The watchdog-armed dispatches must remain exactly the interactive planner, its resume, and the scoped replan planner.'
        );
        for (const site of WATCHDOG_SITES) {
            const member = objectEntries(splitTopLevelArgs(site.callText)[1] || '{}').get('member');
            assert.strictEqual(
                member,
                "getMemberForRole('planner')",
                'Every watchdog-armed dispatch today targets the planner member.'
            );
        }
    });

    test('streak assignment is the only planning-side dispatch outside a git sync bracket', () => {
        const planningSites = PLANNING_LADDERS.map((pin) => ({ pin, site: siteFor(pin.anchor) }));
        const unbracketed = planningSites.filter(({ site }) => !isInsideAnyCall(WITH_GIT_SYNC_SITES, site.index));
        assert.deepStrictEqual(
            unbracketed.map(({ pin }) => pin.name).sort(),
            ['streak assignment', 'streak assignment (semantic repair re-ask)'],
            'Exactly the two Streak Assignment dispatches run outside withGitSync(...); every other planning-side dispatch ' +
            'is bracketed, so a newly-unbracketed planner or plan-reviewer dispatch fails here.'
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
