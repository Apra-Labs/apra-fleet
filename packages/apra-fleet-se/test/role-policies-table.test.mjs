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
    innermostEnclosingCall,
    regionBetween,
    stripComments,
    dispatchLadderModulePaths,
    moduleSetSource,
} from './helpers/dispatch-pin-scanner.mjs';
import {
    ROLE_POLICIES,
    ROLE_NAMES,
    POLICY_FIELDS,
    MEMBER_KINDS,
    MODEL_KINDS,
    KB_INJECTION_KINDS,
    DEGRADE_KINDS,
    PRE_DISPATCH_STEPS,
    POST_RESULT_STEPS,
    SECONDARY_KINDS,
    policyFor,
    allDispatchPolicies,
    pushesCode,
} from '../fleet-sprint/role-policies.mjs';
import { KB_SELF_INJECTING_ROLES } from '../fleet-sprint/runner.js';

// =============================================================================
// apra-fleet-3swo.5.2 -- the per-role dispatch POLICY TABLE, proven against
// today's runner.js.
//
// role-policies.mjs records, as data, the dispatch policy each role ladder
// implements by hand inside runner.js today. Nothing consumes the table yet
// (the dispatchRole engine lands separately), so the only thing that can keep
// it honest is this file: every row is re-derived from runner.js's real
// dispatch sites here, using the SAME structural scanner
// (./helpers/dispatch-pin-scanner.mjs) that the two behaviour-pin files use --
// planning-role-dispatch-pins.test.mjs (apra-fleet-3swo.5.1) and
// execution-role-dispatch-pins.test.mjs (apra-fleet-3swo.5.6).
//
// WHY RE-DERIVE FROM SOURCE RATHER THAN IMPORT THE PIN TABLES: the pin tables
// are module-local consts inside two test files, and importing them would only
// prove this table agrees with another table. Reading runner.js directly proves
// the table describes the RUNNER. A first test below still ties the two
// together structurally: the dispatch anchors used here must be exactly the 22
// anchors the pin files use, so a dispatch that is pinned but missing from the
// policy table -- or a policy row anchored somewhere the pins do not look --
// fails immediately.
//
// WHAT IS DELIBERATELY NOT ASSERTED HERE: anything the pin files already own
// as a cross-cutting invariant (that sprint_id comes from the one dispatch
// wrapper, that exactly 22 dispatch sites exist, ...). This file asserts the
// TABLE, not the runner.
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FLEET_SPRINT_DIR = path.join(__dirname, '..', 'fleet-sprint');
// SRC now scans the module SET dispatch-pin-scanner.mjs defines
// (DISPATCH_LADDER_MODULES: runner.js today, plus role-policies.mjs and,
// once it exists, dispatch-role.mjs), not one hard-coded runner.js path --
// see that file's header for why. Every ROLE_SOURCE anchor below is
// unchanged: it still resolves against runner.js's real text, which is
// still exactly what is in SRC today.
const SRC = moduleSetSource(dispatchLadderModulePaths(FLEET_SPRINT_DIR));
const PIN_FILES = [
    path.join(__dirname, 'planning-role-dispatch-pins.test.mjs'),
    path.join(__dirname, 'execution-role-dispatch-pins.test.mjs'),
];

const AGENT_SITES = findCallSites(SRC, 'agent');
const WITH_GIT_SYNC_SITES = findCallSites(SRC, 'withGitSync', { excludeDeclaration: true });
const WATCHDOG_SITES = findCallSites(SRC, 'withDispatchWatchdog', { excludeDeclaration: true });

/**
 * Where each policy row lives in runner.js. This mapping is the ONLY
 * runner-source knowledge in the whole change: role-policies.mjs itself stays
 * free of source anchors so it can be consumed by an engine, not by a scanner.
 *
 *   anchor    -- unique text inside the role's own dispatch call
 *   secondary -- the same for its resume / re-ask dispatch
 *   region    -- [start, end] anchors bounding the ladder's retry/degrade code
 *   degradeRegion -- narrower bounds when the degrade lives outside `region`
 *   attempts  -- HOW retry.attempts is re-derived from runner.js for this
 *                ladder (see derivedAttempts below). Exactly one shape per
 *                role, and every role must declare one -- the table's attempt
 *                budget is what the forthcoming dispatchRole engine will
 *                execute from, so no role may carry an unproven number:
 *                  { kind: 'loop', var }     bounded attempt loop `var <= N`
 *                  { kind: 'ladder', const } one attempt per backoff entry
 *                  { kind: 'wrapper', call } retry-once wrapper around `call`
 *                  { kind: 'single' }        straight-line, no retry at all
 *
 * retry.resumeAttempts needs no per-role declaration: it is derived uniformly
 * from the ladder's own max_turns-exhaustion block (see derivedResumeAttempts).
 */
const ROLE_SOURCE = {
    planner: {
        anchor: '(plannerPrompt,',
        secondary: 'Continue your planning pass exactly where you left off',
        region: ['const PLANNER_MAX_TURNS = 500;', 'throw plannerErr;'],
        turnBaseConstant: 'PLANNER_MAX_TURNS',
        fatalThrow: 'throw plannerErr;',
        attempts: { kind: 'ladder', const: 'PLANNER_DISPATCH_RETRY_DELAYS_MS' },
    },
    'plan-reviewer': {
        anchor: 'priorRoundVerdicts: priorPlanRoundVerdicts',
        secondary: 'Continue your plan review exactly where you left off',
        region: ['for (let planReviewAttempt = 1;', 'lastVerdict = verdict;'],
        attempts: { kind: 'loop', var: 'planReviewAttempt' },
    },
    'scoped-replan-planner': {
        anchor: "label: 'Scoped Replan Plan (interactive)'",
        secondary: null,
        region: ['const SCOPED_REPLAN_PLANNER_MAX_TURNS = 500;', '--- Scoped plan-review pass ---'],
        attempts: { kind: 'single' },
    },
    'scoped-replan-plan-reviewer': {
        anchor: "label: 'Scoped Replan Review'",
        secondary: null,
        region: ['--- Scoped plan-review pass ---', 'if (scopedReplanApproved) {'],
        attempts: { kind: 'single' },
    },
    'streak-assignment': {
        anchor: "label: 'Streak Assignment',",
        secondary: "label: 'Streak Assignment (semantic repair)'",
        region: ['let streakCandidate = null;', 'if (usedFallback) {'],
        attempts: { kind: 'single' },
    },
    doer: {
        anchor: '(\n                        doerPrompt,',
        secondary: null,
        region: ['const BASE_DOER_MAX_TURNS = 500;', 'kbWork.apply(ROLE_DOER'],
        attempts: { kind: 'wrapper', call: 'dispatchDoer(' },
    },
    'doer-resume': {
        anchor: 'Continue exactly where you left off from this same session',
        secondary: null,
        region: ['const BASE_DOER_MAX_TURNS = 500;', 'kbWork.apply(ROLE_DOER'],
        // Shares the doer's ladder outright: the resume is dispatched from
        // inside it, so its attempt budget is the doer's, re-derived here too.
        attempts: { kind: 'wrapper', call: 'dispatchDoer(' },
    },
    reviewer: {
        anchor: 'acceptanceCriteriaJson,',
        secondary: 'Continue your review exactly where you left off',
        region: ['for (let reviewAttempt = 1;', 'if (!isReviewerContractViolation(verdict)) {'],
        attempts: { kind: 'loop', var: 'reviewAttempt' },
    },
    'final-review': {
        anchor: 'buildFinalVerdictPrompt({',
        secondary: 'Continue your final review exactly where you left off',
        region: ['const FINAL_REVIEW_MAX_TURNS', 'const REGRESSION_TEST_MAX_TURNS'],
        attempts: { kind: 'wrapper', call: 'runFinalReviewAttempt(' },
    },
    deployer: {
        anchor: '(\n                        deployerPrompt,',
        secondary: 'Continue the deploy exactly where you left off',
        // apra-fleet-3swo.32: the start bound used to be 'const sprintSelfId =',
        // a shared per-cycle variable declared far ABOVE the deployer's own
        // dispatch block (it is also read by the integ-test-runner prompt).
        // That made the region span nearly 3000 unrelated lines, including the
        // doer's own "Retrying once." log line -- which RETRY_ONCE_MARKER then
        // matched, making derivedAttempts() wrongly conclude the deployer
        // ladder retries. 'const DEPLOYER_MAX_TURNS = 500;' is the deployer's
        // own region-start constant, matching every other role's convention
        // (PLANNER_MAX_TURNS, INTEG_TEST_MAX_TURNS, ...) and tightly bounding
        // the region to just this ladder's real dispatch/retry/degrade code.
        region: ['const DEPLOYER_MAX_TURNS = 500;', 'deployedThisCycle = deployResult.deployed === true;'],
        attempts: { kind: 'single' },
    },
    'integ-test-runner': {
        anchor: '(\n                    featurePrompt,',
        secondary: 'Continue the integration test run exactly where you left off',
        region: ['const INTEG_TEST_MAX_TURNS = 500;', 'Feature closure is judged'],
        attempts: { kind: 'single' },
    },
    'regression-test-runner': {
        anchor: '(\n                    regressionPrompt,',
        secondary: 'Continue the regression pass exactly where you left off',
        region: ['const REGRESSION_TEST_MAX_TURNS = 500;', 'const harvesterDispatchOpts'],
        degradeRegion: ['A regression-phase infrastructure failure must never abort', 'const harvesterDispatchOpts'],
        attempts: { kind: 'single' },
    },
    harvester: {
        anchor: '(\n                harvesterPrompt,',
        secondary: 'Continue your harvest exactly where you left off',
        region: ['const harvesterDispatchOpts', '7. Publish: push the sprint branch'],
        attempts: { kind: 'single' },
    },
};

/**
 * Value of a `const NAME = [<number>, ...];` declaration, or null. The scanner's
 * numericConstant() only reads scalars; a backoff ladder is an array literal.
 */
function numericArrayConstant(src, name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`(?:const|let|var)\\s+${escaped}\\s*=\\s*\\[([^\\]]*)\\]\\s*;`).exec(src);
    if (!m) return null;
    const parts = m[1].split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    return parts.every((s) => /^\d+$/.test(s)) ? parts.map(Number) : null;
}

/** Every marker that would mean "this ladder re-dispatches after a failure". */
const RETRY_ONCE_MARKER = /Retrying once\./;
const ATTEMPT_LOOP_MARKER = /(?:for|while)\s*\(\s*(?:let\s+)?\w*[Aa]ttempt\w*/;
const LADDER_LOOP_MARKER = /<\s*([A-Za-z_$][\w$]*RETRY_DELAYS_MS)\.length/;

/**
 * retry.attempts, re-derived from runner.js rather than read off the table.
 *
 * Each shape both COMPUTES the number and proves the ladder really has that
 * shape, so neither a wrong number in the table nor a runner.js ladder that
 * silently grew an extra attempt can pass:
 *
 *   loop    -- `var <= N`: N is the bound the loop actually carries.
 *   ladder  -- one attempt per backoff-delay entry, iterated by
 *              `i < <CONST>.length`; the delay array itself is separately
 *              matched against retry.backoffMs below, so the length is a
 *              source fact, not a table fact.
 *   wrapper -- a retry-once wrapper: the attempt expression is invoked once on
 *              the happy path, once from the generic retry catch, and (when the
 *              ladder self-heals LLM auth) once more from the self-heal branch.
 *              That last one is a heal, not a retry budget entry, so it is
 *              subtracted -- see runner.js's Final Review ladder, whose comment
 *              spells out that the healed verdict must short-circuit rather
 *              than spend the generic retry.
 *   single  -- straight-line dispatch: proven by the ABSENCE of all three retry
 *              shapes above, which bounds it at exactly one attempt.
 */
function derivedAttempts(role, region) {
    const spec = ROLE_SOURCE[role].attempts;
    assert.ok(spec, `${role}: ROLE_SOURCE must say how retry.attempts is derived from runner.js.`);
    if (spec.kind === 'loop') {
        const m = new RegExp(`${spec.var}\\s*<=\\s*(\\d+)\\b`).exec(region);
        assert.ok(m, `${role}: expected a bounded attempt loop on '${spec.var}' in runner.js.`);
        return Number(m[1]);
    }
    if (spec.kind === 'ladder') {
        const delays = numericArrayConstant(SRC, spec.const);
        assert.ok(delays, `${role}: backoff ladder '${spec.const}' not found in runner.js.`);
        assert.ok(
            new RegExp(`<\\s*${spec.const}\\.length`).test(region),
            `${role}: the ladder must drive the attempt loop (i < ${spec.const}.length) for attempts to equal its length.`
        );
        return delays.length;
    }
    if (spec.kind === 'wrapper') {
        const calls = region.split(spec.call).length - 1;
        assert.ok(
            RETRY_ONCE_MARKER.test(region),
            `${role}: expected a retry-once wrapper around ${spec.call}) in runner.js.`
        );
        const authHealCalls = policyFor(role).retry.authSelfHeal ? 1 : 0;
        return calls - authHealCalls;
    }
    assert.strictEqual(spec.kind, 'single', `${role}: unknown attempts proof kind ${JSON.stringify(spec.kind)}.`);
    assert.ok(
        !RETRY_ONCE_MARKER.test(region),
        `${role}: runner.js re-dispatches this ladder after a failure, so it is not a single-attempt ladder.`
    );
    assert.ok(
        !ATTEMPT_LOOP_MARKER.test(region),
        `${role}: runner.js has a bounded attempt loop here (${(ATTEMPT_LOOP_MARKER.exec(region) || [])[0]}), ` +
        'so this ladder is not single-attempt.'
    );
    assert.ok(
        !LADDER_LOOP_MARKER.test(region),
        `${role}: runner.js drives this ladder from a backoff array, so it is not single-attempt.`
    );
    return 1;
}

/**
 * The body of the ladder's `reason === 'max_turns_exhausted'` branch -- the
 * ONLY place a resume dispatch can be issued from. Scoped this way on purpose:
 * an enclosing ATTEMPT loop (plan-reviewer, reviewer) must not be mistaken for
 * a resume loop, because resumeAttempts is a per-attempt budget.
 */
function maxTurnsResumeBlock(region) {
    const at = region.indexOf("reason === 'max_turns_exhausted'");
    if (at < 0) return null;
    const open = region.indexOf('{', at);
    if (open < 0) return null;
    let depth = 0;
    for (let i = open; i < region.length; i++) {
        if (region[i] === '{') depth += 1;
        else if (region[i] === '}') {
            depth -= 1;
            if (depth === 0) return region.slice(open + 1, i);
        }
    }
    return null;
}

/**
 * retry.resumeAttempts, re-derived from runner.js. A resume block either loops
 * (the doer's escalating ladder, bounded by a named constant) or issues its
 * resume straight-line, which bounds it at exactly one.
 */
function derivedResumeAttempts(role, region) {
    const block = maxTurnsResumeBlock(region);
    if (block === null) return 0;
    assert.ok(
        /resume: true|Resume\(/.test(block),
        `${role}: the max_turns branch must actually issue a resume dispatch.`
    );
    const loop = /\b(?:while|for)\s*\(([^)]*)\)/.exec(block);
    if (!loop) return 1;
    const bound = /<=?\s*([A-Za-z_$][\w$]*|\d+)/.exec(loop[1]);
    assert.ok(bound, `${role}: the resume loop '${loop[0]}' carries no readable bound.`);
    if (/^\d+$/.test(bound[1])) return Number(bound[1]);
    const named = numericConstant(SRC, bound[1]);
    assert.ok(
        Number.isInteger(named),
        `${role}: resume loop bound '${bound[1]}' is not a numeric constant in runner.js.`
    );
    return named;
}

function siteFor(anchor) {
    const hits = AGENT_SITES.filter((s) => s.callText.includes(anchor));
    assert.strictEqual(
        hits.length,
        1,
        `Expected exactly ONE dispatch site matching anchor ${JSON.stringify(anchor)}, found ${hits.length}. ` +
        'Re-anchor the policy row on the ladder\'s current prompt/label text.'
    );
    return hits[0];
}

/** The options a dispatch site EFFECTIVELY passes: spread bases first, inline last. */
function effectiveOpts(site) {
    const args = splitTopLevelArgs(site.callText);
    const inline = args.length > 1 ? args[args.length - 1] : '{}';
    const merged = new Map();
    for (const name of spreadsOf(inline)) {
        const base = objectLiteralFor(SRC, name);
        assert.ok(base, `spread base object '${name}' not found in runner.js`);
        for (const [k, v] of objectEntries(base)) merged.set(k, v);
    }
    for (const [k, v] of objectEntries(inline)) merged.set(k, v);
    return merged;
}

function regionOf(role, which = 'region') {
    const src = ROLE_SOURCE[role];
    const bounds = src[which] || src.region;
    return stripComments(regionBetween(SRC, bounds[0], bounds[1]));
}

/** The raw (comment-bearing) region -- prose anchors live in comments. */
function rawRegionOf(role, which = 'region') {
    const src = ROLE_SOURCE[role];
    const bounds = src[which] || src.region;
    return regionBetween(SRC, bounds[0], bounds[1]);
}

/** The source expression a policy's `member` must resolve to. */
function memberExpr(member) {
    if (member.kind === 'role') return `getMemberForRole('${member.role}')`;
    if (member.kind === 'pool-head') return member.binding;
    return member.binding;
}

/** The source expression a policy's `model` must resolve to. */
function modelExpr(model) {
    if (model.kind === 'fixed') {
        return /^[A-Za-z_$][\w$]*$/.test(model.key)
            ? `FIXED_ROLE_TIER.${model.key}`
            : `FIXED_ROLE_TIER['${model.key}']`;
    }
    if (model.kind === 'per-bead') return model.binding;
    return 'undefined';
}

/** The source expression a policy's `maxTurns` must resolve to. */
function maxTurnsExpr(maxTurns) {
    if (maxTurns === null) return null;
    if (maxTurns.kind === 'runtime') return maxTurns.binding;
    return maxTurns.multiplier === 1 ? maxTurns.base : `${maxTurns.base} * ${maxTurns.multiplier}`;
}

/** The source expression a policy's `resumeArg` must resolve to. */
function resumeArgExpr(resumeArg) {
    if (resumeArg === null) return null;
    if (resumeArg.kind === 'same-session') return 'true';
    if (resumeArg.kind === 'worklist') return 'worklistResumeArg';
    return `roundSessions.resumeArgFor('${resumeArg.role}', cycle)`;
}

/** Rebuilds a watchdog label's source expression from its segment list. */
function labelExpr(segments) {
    if (segments.every((s) => typeof s === 'string')) return `'${segments.join('')}'`;
    const body = segments.map((s) => (typeof s === 'string' ? s : '${' + s.expr + '}')).join('');
    return '`' + body + '`';
}

/** Every dispatch policy paired with the role-source entry that locates it. */
function dispatchRows() {
    const rows = [];
    for (const role of ROLE_NAMES) {
        const entry = ROLE_POLICIES[role];
        const src = ROLE_SOURCE[role];
        rows.push({ name: role, policy: entry, anchor: src.anchor, role });
        if (entry.secondary && role !== 'doer') {
            assert.ok(src.secondary, `${role}: policy declares a secondary dispatch but ROLE_SOURCE names no anchor for it.`);
            rows.push({ name: `${role} (${entry.secondary.kind})`, policy: entry.secondary, anchor: src.secondary, role });
        }
    }
    return rows;
}

// -----------------------------------------------------------------------------
// (1) Shape: every role carries every policy field, drawn from closed vocabularies.
// -----------------------------------------------------------------------------
describe('role policy table: shape', () => {
    test('the table covers exactly the thirteen sprint roles', () => {
        assert.deepStrictEqual(
            [...ROLE_NAMES].sort(),
            [
                'deployer', 'doer', 'doer-resume', 'final-review', 'harvester',
                'integ-test-runner', 'plan-reviewer', 'planner', 'regression-test-runner',
                'reviewer', 'scoped-replan-plan-reviewer', 'scoped-replan-planner',
                'streak-assignment',
            ],
            'A role added to (or dropped from) runner.js must be added to (or dropped from) the policy table.'
        );
        assert.deepStrictEqual(
            Object.keys(ROLE_SOURCE).sort(),
            [...ROLE_NAMES].sort(),
            'Every role in the table must be locatable in runner.js by this file\'s ROLE_SOURCE map.'
        );
    });

    test('every role entry carries all nine policy fields, and every value comes from a closed vocabulary', () => {
        assert.strictEqual(POLICY_FIELDS.length, 9);
        for (const role of ROLE_NAMES) {
            const p = policyFor(role);
            for (const field of POLICY_FIELDS) {
                assert.ok(
                    Object.prototype.hasOwnProperty.call(p, field),
                    `${role} is missing policy field '${field}' -- a role may not opt out of an axis.`
                );
                assert.notStrictEqual(p[field], undefined, `${role}.${field} must be an explicit value (null is allowed, undefined is not).`);
            }
            assert.ok(MEMBER_KINDS.includes(p.member.kind), `${role}.member.kind '${p.member.kind}' is outside MEMBER_KINDS.`);
            assert.ok(MODEL_KINDS.includes(p.model.kind), `${role}.model.kind '${p.model.kind}' is outside MODEL_KINDS.`);
            assert.ok(KB_INJECTION_KINDS.includes(p.kbInjection), `${role}.kbInjection '${p.kbInjection}' is outside KB_INJECTION_KINDS.`);
            assert.ok(DEGRADE_KINDS.includes(p.degrade.kind), `${role}.degrade.kind '${p.degrade.kind}' is outside DEGRADE_KINDS.`);
            for (const step of p.preDispatch) {
                assert.ok(PRE_DISPATCH_STEPS.includes(step), `${role}.preDispatch step '${step}' is outside PRE_DISPATCH_STEPS.`);
            }
            for (const step of p.postResult) {
                assert.ok(POST_RESULT_STEPS.includes(step), `${role}.postResult step '${step}' is outside POST_RESULT_STEPS.`);
            }
            if (p.secondary) {
                assert.ok(SECONDARY_KINDS.includes(p.secondary.kind), `${role}.secondary.kind '${p.secondary.kind}' is outside SECONDARY_KINDS.`);
            }
        }
    });

    test('the table is frozen, so a consumer cannot mutate one run\'s policy into the next', () => {
        assert.throws(() => { ROLE_POLICIES.doer.bracket.pushCode = false; }, TypeError);
        assert.throws(() => { ROLE_POLICIES.planner.retry.backoffMs.push(1); }, TypeError);
        assert.strictEqual(ROLE_POLICIES.doer.bracket.pushCode, true);
    });

    test('doer-resume is the doer ladder\'s own resume dispatch, not a second ladder', () => {
        assert.strictEqual(
            ROLE_POLICIES['doer-resume'],
            ROLE_POLICIES.doer.secondary,
            'ROLE_POLICIES["doer-resume"] must BE the doer\'s secondary dispatch -- two copies would drift.'
        );
        assert.strictEqual(ROLE_POLICIES['doer-resume'].ladder, 'doer');
        assert.strictEqual(ROLE_POLICIES['doer-resume'].kind, 'max-turns-resume');
    });

    test('policyFor() rejects an unknown role by name', () => {
        assert.throws(() => policyFor('nope'), /no policy for role 'nope'/);
    });
});

// -----------------------------------------------------------------------------
// (2) Coverage: the table's dispatches are exactly the pinned dispatches.
// -----------------------------------------------------------------------------
describe('role policy table: coverage against the behaviour pins', () => {
    test('the table describes all 22 dispatches, anchored on exactly the anchors the two pin files use', () => {
        const rows = dispatchRows();
        assert.strictEqual(rows.length, 22, `Expected 22 dispatch policies, found ${rows.length}.`);
        assert.strictEqual(
            new Set(rows.map((r) => siteFor(r.anchor).line)).size,
            22,
            'Each policy must anchor a DISTINCT dispatch site -- two rows on one site would leave a dispatch undescribed.'
        );

        // The anchors the pin files themselves use, parsed out of their pin
        // tables. Both files write `anchor: <a quoted JS string>,` -- single
        // quotes normally, double quotes when the anchor itself contains an
        // apostrophe (`label: 'Streak Assignment'`).
        const pinAnchors = new Set();
        for (const file of PIN_FILES) {
            const text = fs.readFileSync(file, 'utf8');
            for (const m of text.matchAll(/^\s*anchor: (?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"),$/gm)) {
                const raw = m[1] ?? m[2];
                pinAnchors.add(raw.replace(/\\n/g, '\n').replace(/\\(['"\\])/g, '$1'));
            }
        }
        assert.strictEqual(pinAnchors.size, 22, `Expected 22 pinned anchors across the two pin files, found ${pinAnchors.size}.`);
        assert.deepStrictEqual(
            rows.map((r) => r.anchor).sort(),
            [...pinAnchors].sort(),
            'Every dispatch the pin files pin must have a policy row, and every policy row must sit on a pinned dispatch.'
        );
    });

    test('allDispatchPolicies() enumerates each dispatch once', () => {
        const all = allDispatchPolicies();
        assert.strictEqual(all.length, 22, `allDispatchPolicies() must return all 22 dispatches, got ${all.length}.`);
        assert.strictEqual(new Set(all).size, all.length, 'No dispatch may be enumerated twice.');
    });
});

// -----------------------------------------------------------------------------
// (3) Per-dispatch policy fields, re-derived from runner.js.
// -----------------------------------------------------------------------------
describe('role policy table: per-dispatch fields match runner.js', () => {
    for (const row of dispatchRows()) {
        test(`${row.name}: member, model, turn budget, timeouts, bracket, watchdog, KB source and schema`, () => {
            const site = siteFor(row.anchor);
            const opts = effectiveOpts(site);
            const p = row.policy;

            assert.strictEqual(opts.get('member_name'), memberExpr(p.member), `${row.name}: member resolution.`);
            assert.strictEqual(opts.get('model'), modelExpr(p.model), `${row.name}: model tier resolution.`);
            assert.strictEqual(opts.get('max_turns') ?? null, maxTurnsExpr(p.maxTurns), `${row.name}: turn budget expression.`);
            if (p.maxTurns && p.maxTurns.kind === 'constant') {
                assert.strictEqual(
                    numericConstant(SRC, p.maxTurns.base) * p.maxTurns.multiplier,
                    p.maxTurns.value,
                    `${row.name}: recorded turn VALUE must equal the runner constant times the recorded multiplier.`
                );
            }
            assert.strictEqual(opts.get('timeout_s') ?? null, p.timeouts.timeoutS, `${row.name}: inactivity timeout budget.`);
            assert.strictEqual(opts.get('max_total_s') ?? null, p.timeouts.maxTotalS, `${row.name}: hard elapsed-time budget.`);
            assert.strictEqual(opts.get('resume') ?? null, resumeArgExpr(p.resumeArg), `${row.name}: same-session resume argument.`);
            assert.strictEqual(opts.get('agentType') ?? null, p.agentType === null ? null : `'${p.agentType}'`, `${row.name}: persona.`);
            assert.strictEqual(opts.get('schema') ?? null, p.schema, `${row.name}: returnable verdict schema.`);

            // --- bracket ----------------------------------------------------
            const bracket = innermostEnclosingCall(WITH_GIT_SYNC_SITES, site.index);
            if (!p.bracket.wrapped) {
                assert.strictEqual(bracket, null, `${row.name}: policy says no git-sync bracket, but the dispatch is wrapped in one.`);
            } else {
                assert.ok(bracket, `${row.name}: policy says bracketed, but no withGitSync(...) encloses the dispatch.`);
                const bracketArgs = splitTopLevelArgs(bracket.callText);
                assert.strictEqual(bracketArgs[0], memberExpr(p.member), `${row.name}: the bracket must sync the dispatched member.`);
                assert.strictEqual(bracketArgs[1], String(p.bracket.pushCode), `${row.name}: pushCode flag.`);
                const bracketOpts = bracketArgs.length > 3 ? objectEntries(bracketArgs[3]) : new Map();
                assert.strictEqual(
                    bracketOpts.get('pushBeads') ?? null,
                    p.bracket.pushBeads === null ? null : String(p.bracket.pushBeads),
                    `${row.name}: pushBeads flag.`
                );
            }

            // --- watchdog ---------------------------------------------------
            const armed = innermostEnclosingCall(WATCHDOG_SITES, site.index);
            if (!p.watchdog.armed) {
                assert.strictEqual(armed, null, `${row.name}: policy arms no watchdog, but the dispatch is raced against one.`);
            } else {
                assert.ok(armed, `${row.name}: policy arms a watchdog, but the dispatch is not raced against one.`);
                const wdOpts = objectEntries(splitTopLevelArgs(armed.callText)[1] || '{}');
                assert.strictEqual(wdOpts.get('timeoutS'), p.watchdog.timeoutS, `${row.name}: watchdog budget.`);
                assert.strictEqual(
                    wdOpts.get('member'),
                    memberExpr(p.member),
                    `${row.name}: the watchdog must name the dispatched member (policy records this as member:'dispatch').`
                );
                assert.strictEqual(p.watchdog.member, 'dispatch');
                assert.strictEqual(wdOpts.get('label'), labelExpr(p.watchdog.label), `${row.name}: watchdog label.`);
            }

            // --- KB injection source ---------------------------------------
            const expected = p.agentType === null
                ? 'none'
                : (KB_SELF_INJECTING_ROLES.has(p.agentType) ? 'prompt-builder' : 'wrapper');
            assert.strictEqual(
                p.kbInjection,
                expected,
                `${row.name}: kbInjection must match where the knowledge block actually comes from for persona ` +
                `${JSON.stringify(p.agentType)}.`
            );
        });
    }
});

// -----------------------------------------------------------------------------
// (4) Ladder-level policy fields: retry and degrade.
// -----------------------------------------------------------------------------
describe('role policy table: retry ladders match runner.js', () => {
    for (const role of ROLE_NAMES) {
        test(`${role}: attempts, backoff, resume escalation, auth self-heal and sync-failure handling`, () => {
            const p = policyFor(role);
            const region = regionOf(role);
            const src = ROLE_SOURCE[role];

            // The attempt budget, re-derived from runner.js for EVERY role --
            // not just the two with a bounded loop. This is the number the
            // dispatchRole engine will execute from, so no role may carry an
            // unproven one.
            assert.strictEqual(
                p.retry.attempts,
                derivedAttempts(role, region),
                `${role}: retry.attempts must equal the attempt budget runner.js's ladder really allows ` +
                `(re-derived from its '${src.attempts.kind}' shape).`
            );

            if (p.retry.backoffMs) {
                const literal = p.retry.backoffMs.map((n) => String(n)).join(',\\s*');
                assert.ok(
                    new RegExp(`=\\s*\\[${literal}\\]`).test(region),
                    `${role}: retry.backoffMs must be the backoff ladder runner.js actually uses.`
                );
            } else {
                assert.ok(
                    !/RETRY_DELAYS_MS/.test(region),
                    `${role}: runner.js has a backoff ladder here but the policy records none.`
                );
            }

            assert.strictEqual(
                /reason === 'max_turns_exhausted'/.test(region),
                p.retry.maxTurnsResume,
                `${role}: retry.maxTurnsResume must match whether the ladder resumes on turn exhaustion.`
            );
            if (p.retry.maxTurnsResume) {
                // Re-derived from the ladder's own max_turns branch for EVERY
                // resuming role, not just the doer: a straight-line resume is
                // bounded at 1, a looping one at the constant it carries.
                assert.strictEqual(
                    p.retry.resumeAttempts,
                    derivedResumeAttempts(role, region),
                    `${role}: retry.resumeAttempts must equal the number of resumes runner.js's max_turns branch ` +
                    'really issues per attempt.'
                );
                assert.strictEqual(p.retry.turnEscalation, 'double', `${role}: every resume doubles its turn budget.`);
            } else {
                assert.strictEqual(p.retry.resumeAttempts, 0);
                assert.strictEqual(p.retry.turnEscalation, null);
            }

            assert.strictEqual(
                /isAuthDispatchError\(err\)/.test(region),
                p.retry.authSelfHeal,
                `${role}: retry.authSelfHeal must match whether the ladder self-heals an LLM-auth failure.`
            );
            assert.strictEqual(
                /handledByAuthSelfHeal = true;/.test(region),
                p.retry.authSelfHealShortCircuits,
                `${role}: retry.authSelfHealShortCircuits must match whether a healed attempt skips the generic retry.`
            );
            assert.strictEqual(
                /isNonRetryableDispatchError\(err\)/.test(region),
                p.retry.abortOnNonRetryable,
                `${role}: retry.abortOnNonRetryable must match whether an auth/trust failure ends the ladder.`
            );
            assert.strictEqual(
                /isPostDispatchSyncFailure\(err\)/.test(region),
                p.retry.skipRedispatchOnPostDispatchSyncFailure,
                `${role}: a dispatch that already ran must not be re-dispatched for a post-dispatch sync failure.`
            );
            assert.strictEqual(
                /isNoMutationDispatchFailure\(err\)/.test(region),
                p.retry.skipPreDispatchSyncOnNoMutation,
                `${role}: only a provably no-mutation failure may let the next attempt skip its pre-dispatch sync.`
            );
            assert.strictEqual(
                /resumeOntoRemoteTip: true/.test(region),
                p.retry.resumeOntoRemoteTipOnRetry,
                `${role}: retry.resumeOntoRemoteTipOnRetry must match whether a retry resumes onto the remote tip.`
            );
            assert.strictEqual(
                /isInfraDispatchFailure\(err\)/.test(region),
                p.retry.infraResumeAttempts > 0,
                `${role}: retry.infraResumeAttempts must match whether the ladder recovers an infrastructure failure.`
            );
            assert.strictEqual(
                /Your previous answer was REJECTED/.test(region),
                p.retry.semanticRepairReAsks > 0,
                `${role}: retry.semanticRepairReAsks must match whether the ladder re-asks with the validation failure.`
            );
        });
    }

    test('the doer resume ladder is bounded by the runner constant the policy records', () => {
        assert.strictEqual(
            numericConstant(SRC, 'MAX_TURN_RESUME_ATTEMPTS'),
            ROLE_POLICIES.doer.retry.resumeAttempts,
            'doer.retry.resumeAttempts must equal MAX_TURN_RESUME_ATTEMPTS.'
        );
        assert.ok(
            /currentMaxTurns \*= 2;/.test(regionOf('doer')),
            'doer.retry.turnEscalation="double" must be the escalation the resume ladder really performs.'
        );
    });
});

describe('role policy table: degrade behaviour matches runner.js', () => {
    for (const role of ROLE_NAMES) {
        test(`${role}: what the ladder produces when its attempts are spent`, () => {
            const p = policyFor(role);
            const region = regionOf(role, 'degradeRegion');
            const d = p.degrade;

            if (d.synthesized) {
                for (const [key, value] of Object.entries(d.synthesized)) {
                    if (key === 'verdict') {
                        assert.strictEqual(
                            (region.match(new RegExp(`verdict: '${value}'`, 'g')) || []).length,
                            d.paths,
                            `${role}: degrade.paths must equal the number of paths that synthesize verdict '${value}'.`
                        );
                    } else if (key === 'deployed') {
                        assert.strictEqual(
                            (region.match(new RegExp(`deployed: ${value}`, 'g')) || []).length,
                            d.paths,
                            `${role}: degrade.paths must equal the number of paths that synthesize deployed:${value}.`
                        );
                    } else if (key === 'grouping') {
                        assert.ok(
                            region.includes(String(value)) || rawRegionOf(role).includes(String(value)),
                            `${role}: the fallback value '${value}' must be the one runner.js falls back to.`
                        );
                    }
                }
            } else {
                assert.strictEqual(d.paths, 0, `${role}: a degrade that synthesizes nothing has no synthesizing paths.`);
            }

            for (const forbidden of d.neverSynthesizes) {
                const pattern = forbidden.includes(':') ? forbidden : `verdict: '${forbidden}'`;
                assert.ok(
                    !region.includes(pattern),
                    `${role}: no degrade path may ever synthesize ${forbidden}.`
                );
            }

            if (d.marker) {
                assert.ok(
                    region.includes(d.marker),
                    `${role}: the degrade marker '${d.marker}' must appear in the ladder that stamps it.`
                );
                if (d.kind === 'synthesized-verdict' && d.marker === 'dispatchFailed') {
                    assert.strictEqual(
                        (region.match(/dispatchFailed: true/g) || []).length,
                        d.paths,
                        `${role}: every synthesized verdict must carry the marker, so the counts must match.`
                    );
                }
            }

            // A rethrow guarded by the role's declared RUN-level control
            // signals is not a rethrow of an unrecognised error: strip those
            // guarded blocks out before judging the catch-all.
            let rethrowRegion = region;
            for (const name of d.rethrowsRunControlSignals) {
                assert.ok(
                    new RegExp(`err instanceof ${name}`).test(region),
                    `${role}: degrade.rethrowsRunControlSignals names '${name}', but the ladder never tests for it.`
                );
            }
            if (d.rethrowsRunControlSignals.length > 0) {
                const guard = d.rethrowsRunControlSignals.map((n) => `err instanceof ${n}`).join(' \\|\\| ');
                const guarded = new RegExp(`if \\(${guard}\\) \\{\\s*throw err;\\s*\\}`);
                assert.ok(guarded.test(region), `${role}: the run-control signals must be rethrown together, ahead of the degrade branches.`);
                rethrowRegion = region.replace(guarded, '');
            }
            assert.strictEqual(
                /throw err;/.test(rethrowRegion),
                d.rethrowsUnrecognisedErrors,
                `${role}: degrade.rethrowsUnrecognisedErrors must match whether an unrecognised error class still propagates.`
            );

            if (d.abortsSprint) {
                assert.ok(
                    region.includes(ROLE_SOURCE[role].fatalThrow),
                    `${role}: an abortsSprint degrade must really rethrow its accumulated error.`
                );
            }
        });
    }

    test('the planner is the only role whose degrade can end the sprint', () => {
        const fatal = ROLE_NAMES.filter((r) => policyFor(r).degrade.abortsSprint);
        assert.deepStrictEqual(fatal, ['planner'], 'Only a failed plan is fatal; every other ladder degrades and continues.');
    });

    test('no degrade path anywhere in the table can fabricate a success', () => {
        for (const role of ROLE_NAMES) {
            const d = policyFor(role).degrade;
            if (d.synthesized && 'verdict' in d.synthesized) {
                assert.ok(
                    ['CHANGES_NEEDED', 'FAIL'].includes(d.synthesized.verdict),
                    `${role}: a synthesized verdict must be non-approving, got '${d.synthesized.verdict}'.`
                );
            }
            if (d.synthesized && 'deployed' in d.synthesized) {
                assert.strictEqual(d.synthesized.deployed, false, `${role}: a synthesized deploy must be a failure.`);
            }
        }
    });
});

// -----------------------------------------------------------------------------
// (5) preDispatch / postResult steps.
// -----------------------------------------------------------------------------
const STEP_EVIDENCE = {
    'claim-beads-batched': { scope: 'region', pattern: () => /claimBeadsBatched\(\{/ },
    'kill-stale-session': { scope: 'region', pattern: (p) => new RegExp(`killIfAlive\\(${escapeRe(memberExpr(p.member))}\\)`) },
    'sprint-self-id-in-prompt': { scope: 'region', pattern: () => /sprintSelfId/ },
    'verify-streak-closed': { scope: 'region', pattern: () => /verifyDoerStreakClosed\(\{/ },
    'invalidate-beads-cache': { scope: 'region', pattern: () => /invalidateAllBeadsCache\(\)/ },
    'reviewer-contract-guard': { scope: 'global', pattern: () => /isReviewerContractViolation\(verdict\)/ },
    'clear-round-session': { scope: 'global', pattern: (p) => new RegExp(`roundSessions\\.clear\\('${p.member.role}'\\)`) },
    'select-streaks-validate': { scope: 'region', pattern: () => /selectStreaks\(streakCandidate/ },
    'kb-apply': {
        scope: 'global',
        pattern: (p) => ({
            doer: /kbWork\.apply\(ROLE_DOER,/,
            reviewer: /kbWork\.apply\(ROLE_REVIEWER, kbPriming\.folderOf\(/,
            'final-review': /kbWork\.apply\(ROLE_REVIEWER, finalReviewRepoPath,/,
            harvester: /kbWork\.apply\('harvester',/,
        }[p.ladder]),
    },
};

function escapeRe(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('role policy table: pre-dispatch and post-result steps match runner.js', () => {
    for (const row of dispatchRows()) {
        test(`${row.name}: every recorded step is a step runner.js really performs`, () => {
            const p = row.policy;
            const haystackRegion = regionOf(row.role);
            for (const step of [...p.preDispatch, ...p.postResult]) {
                const evidence = STEP_EVIDENCE[step];
                assert.ok(evidence, `No source evidence is defined for step '${step}'.`);
                const pattern = evidence.pattern(p);
                assert.ok(pattern, `${row.name}: step '${step}' has no evidence pattern for ladder '${p.ladder}'.`);
                const haystack = evidence.scope === 'global' ? SRC : haystackRegion;
                assert.ok(
                    pattern.test(haystack),
                    `${row.name}: policy records step '${step}', but ${evidence.scope === 'global' ? 'runner.js' : 'the ladder\'s source region'} ` +
                    `contains no matching call (${pattern}).`
                );
            }
        });
    }

    test('a resume dispatch is exactly a dispatch that kills its stale session first', () => {
        // Every max_turns resume in the table kills the still-alive session
        // before resuming it; the integ ladder additionally reaches its resume
        // from ONE infra-failure recovery path, which kills again. The total
        // must account for every killIfAlive call site in runner.js -- a resume
        // ladder missing from the table would leave one unexplained.
        const killers = allDispatchPolicies().filter((p) => p.preDispatch.includes('kill-stale-session'));
        for (const p of killers) {
            assert.strictEqual(p.kind, 'max-turns-resume', `${p.role}: only a resume dispatch kills a stale session.`);
        }
        const extraInfraKills = ROLE_NAMES.reduce((n, role) => n + policyFor(role).retry.infraResumeAttempts, 0);
        const killSites = (stripComments(SRC).match(/memberSessionGuard\.killIfAlive\(/g) || []).length;
        assert.strictEqual(
            killSites,
            killers.length + extraInfraKills,
            `runner.js has ${killSites} session-kill sites; the table accounts for ${killers.length} resume dispatches ` +
            `plus ${extraInfraKills} infra-recovery resumes.`
        );
    });

    test('the doer resume checks the streak is not already closed BEFORE killing the session', () => {
        const p = ROLE_POLICIES['doer-resume'];
        assert.deepStrictEqual(
            p.preDispatch,
            ['verify-streak-closed', 'kill-stale-session'],
            'The closed-streak short-circuit must run first: a streak whose beads all closed gets no resume dispatch at all.'
        );
        const region = regionOf('doer-resume');
        assert.ok(
            region.indexOf('preResumeUnclosed.length === 0') < region.indexOf('killIfAlive(doerMember)'),
            'runner.js must still perform the short-circuit check before the kill, in the order the policy records.'
        );
    });
});

// -----------------------------------------------------------------------------
// (6) The named per-role variances, each expressed as data.
// -----------------------------------------------------------------------------
describe('role policy table: every named variance is expressed as data', () => {
    test('streak assignment is the only dispatch outside a git-sync bracket', () => {
        const unbracketed = allDispatchPolicies().filter((p) => !p.bracket.wrapped).map((p) => p.role);
        assert.deepStrictEqual(
            [...new Set(unbracketed)],
            ['streak-assignment'],
            'Only the pure-compute grouping call runs outside a bracket.'
        );
        assert.deepStrictEqual(
            ROLE_POLICIES['streak-assignment'].bracket,
            { wrapped: false, pushCode: null, pushBeads: null },
            'A no-bracket policy carries no push flags at all -- there is no bracket to pass them to.'
        );
    });

    test('the push-code flag is true for exactly the doer and harvester dispatches', () => {
        const codePushers = allDispatchPolicies().filter((p) => p.bracket.pushCode === true).map((p) => p.role);
        assert.deepStrictEqual(
            [...codePushers].sort(),
            ['doer', 'doer-resume', 'harvester', 'harvester'].sort(),
            'Exactly the doer pair and the harvester pair write code and therefore push it.'
        );
        assert.strictEqual(codePushers.length, 4, 'Four code-writing dispatches: doer + its resume, harvester + its resume.');
        assert.ok(pushesCode('doer') && pushesCode('doer-resume') && pushesCode('harvester'));
        for (const role of ROLE_NAMES.filter((r) => !['doer', 'doer-resume', 'harvester'].includes(r))) {
            assert.strictEqual(pushesCode(role), false, `${role} is read-side and must not push code.`);
        }
        // Re-derived from runner.js so a table edit alone cannot move this.
        const truesInSource = WITH_GIT_SYNC_SITES.filter((s) => splitTopLevelArgs(s.callText)[1] === 'true');
        assert.strictEqual(truesInSource.length, 4, 'runner.js must still have exactly 4 code-pushing brackets.');
    });

    test('a watchdog is armed only for the planner-side dispatches', () => {
        const armed = allDispatchPolicies().filter((p) => p.watchdog.armed);
        assert.deepStrictEqual(
            armed.map((p) => `${p.role}:${p.kind}`).sort(),
            ['planner:main', 'planner:max-turns-resume', 'scoped-replan-planner:main'].sort(),
            'Only the interactive planner, its resume, and the scoped replan planner arm a client-side watchdog.'
        );
        assert.strictEqual(armed.length, WATCHDOG_SITES.length, 'The table must arm exactly as many watchdogs as runner.js does.');
        for (const p of armed) {
            assert.strictEqual(p.member.role, 'planner', 'Every watchdog-armed dispatch targets the planner member.');
        }
    });

    test('the integ runner degrades to INCONCLUSIVE, never to a test failure', () => {
        const p = policyFor('integ-test-runner');
        assert.strictEqual(p.degrade.kind, 'inconclusive');
        assert.strictEqual(p.degrade.synthesized, null, 'An INCONCLUSIVE degrade fabricates no verdict at all.');
        assert.strictEqual(p.retry.infraResumeAttempts, 1, 'One bounded infra-failure recovery attempt, distinct from the turn resume.');
        assert.deepStrictEqual(
            ROLE_NAMES.filter((r) => policyFor(r).degrade.kind === 'inconclusive'),
            ['integ-test-runner'],
            'INCONCLUSIVE belongs to the one role whose dispatch produces test evidence.'
        );
    });

    test('the regression phase is the only catch-all, and it never propagates', () => {
        const p = policyFor('regression-test-runner');
        assert.strictEqual(p.degrade.kind, 'catch-all');
        assert.strictEqual(p.degrade.rethrowsUnrecognisedErrors, false);
        assert.strictEqual(p.degrade.abortsSprint, false);
        assert.deepStrictEqual(
            ROLE_NAMES.filter((r) => policyFor(r).degrade.kind === 'catch-all'),
            ['regression-test-runner'],
        );
    });

    test('final review is the only ladder whose auth self-heal short-circuits its retry', () => {
        assert.deepStrictEqual(
            ROLE_NAMES.filter((r) => policyFor(r).retry.authSelfHealShortCircuits),
            ['final-review'],
            'A healed final review already produced a verdict; a second full review would discard it.'
        );
        assert.strictEqual(policyFor('final-review').degrade.paths, 4, 'All four degrade paths record FAIL.');
    });

    test('final review resolves to the reviewer ROLE member, while per-round review takes the pool head', () => {
        assert.deepStrictEqual(policyFor('final-review').member, { kind: 'role', role: 'reviewer' });
        assert.deepStrictEqual(policyFor('reviewer').member, { kind: 'pool-head', role: 'reviewer', binding: 'reviewerPool[0]' });
        assert.strictEqual(policyFor('final-review').agentType, 'reviewer', 'Final review dispatches the reviewer persona.');
    });

    test('the deployer is the only role whose pre-dispatch step is its own sprint reservation id', () => {
        assert.deepStrictEqual(policyFor('deployer').preDispatch, ['sprint-self-id-in-prompt']);
        assert.deepStrictEqual(
            ROLE_NAMES.filter((r) => policyFor(r).preDispatch.includes('sprint-self-id-in-prompt')),
            ['deployer'],
            'Only the deploy runbook gates on foreign sprint reservations.'
        );
    });

    test('the doer is the only role dispatched at a per-bead tier, and the only one claiming beads', () => {
        assert.deepStrictEqual(
            allDispatchPolicies().filter((p) => p.model.kind === 'per-bead').map((p) => p.role),
            ['doer'],
        );
        assert.deepStrictEqual(
            allDispatchPolicies().filter((p) => p.model.kind === 'inherited').map((p) => p.role),
            ['doer-resume'],
            'Only a resume of an already-priced dispatch inherits its tier.',
        );
        assert.deepStrictEqual(
            ROLE_NAMES.filter((r) => policyFor(r).preDispatch.includes('claim-beads-batched')),
            ['doer'],
        );
    });

    test('streak assignment carries no persona, so it is the one dispatch with no knowledge block', () => {
        const p = policyFor('streak-assignment');
        assert.strictEqual(p.agentType, null);
        assert.strictEqual(p.kbInjection, 'none');
        assert.deepStrictEqual(
            allDispatchPolicies().filter((d) => d.kbInjection === 'none').map((d) => d.role),
            ['streak-assignment', 'streak-assignment'],
            'Both the grouping dispatch and its semantic-repair re-ask run without a persona.',
        );
        assert.strictEqual(p.secondary.kind, 'semantic-repair-re-ask');
        assert.strictEqual(p.retry.semanticRepairReAsks, 1, 'Exactly one bounded re-ask, never a loop.');
    });

    test('the doer and reviewer personas are the ones that inject their own knowledge block', () => {
        const selfInjecting = new Set(
            allDispatchPolicies().filter((p) => p.kbInjection === 'prompt-builder').map((p) => p.agentType)
        );
        assert.deepStrictEqual([...selfInjecting].sort(), [...KB_SELF_INJECTING_ROLES].sort());
    });
});
