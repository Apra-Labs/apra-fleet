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
    ERROR_CLASSES,
    PRE_DISPATCH_STEPS,
    POST_RESULT_STEPS,
    SECONDARY_KINDS,
    policyFor,
    allDispatchPolicies,
    pushesCode,
} from '../fleet-sprint/role-policies.mjs';
import { KB_SELF_INJECTING_ROLES } from '../fleet-sprint/runner.js';
import { dispatchRole } from '../fleet-sprint/dispatch-role.mjs';
import { PLANNING_LADDERS, ENGINE_DISPATCHES } from './helpers/planning-ladders.mjs';
import {
    createRecordingCtx,
    ROLE_CALL_OPTS,
    BINDINGS,
    DISPATCH_TIMEOUT_S,
    FIXED_ROLE_TIER,
    SCHEMAS,
    turnExhaustionError,
    authError,
    trustError,
    busyError,
    schemaError,
    transportError,
    postDispatchSyncError,
    infraError,
    gitSyncError,
    doltSyncError,
    divergedError,
    cancelledError,
    budgetError,
    driveEngineDispatch,
    streakValidate,
    watchdogLabelOf,
    TURN_BASES,
    REJECTED_CANDIDATE,
    ACCEPTED_CANDIDATE,
    splicePolicy,
} from './helpers/dispatch-role-harness.mjs';

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
    // The planning-side pin TABLE itself lives in a shared data helper
    // (apra-fleet-3swo.28) so execution-role-dispatch-pins.test.mjs can read
    // its length without re-importing (and re-running) this test file --
    // planning-role-dispatch-pins.test.mjs no longer contains any `anchor:`
    // literals directly, so both must be scanned to recover all 22 anchors.
    path.join(__dirname, 'helpers', 'planning-ladders.mjs'),
    path.join(__dirname, 'planning-role-dispatch-pins.test.mjs'),
    // apra-fleet-3swo.5.7: the execution-side pin TABLE moved into its own
    // shared data helper for the same reason the planning one did -- a
    // migrating ladder needs somewhere to move its pins TO. Both files are
    // scanned so no anchor is lost while the table is split across them.
    path.join(__dirname, 'helpers', 'execution-ladders.mjs'),
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
    // apra-fleet-3swo.5.3: MIGRATED. There is no inline planner ladder in
    // runner.js to anchor on any more -- every field of this row is
    // re-derived by RUNNING dispatch-role.mjs (see section (7) below).
    planner: { engine: true },
    // apra-fleet-3swo.5.3: MIGRATED -- see section (7).
    'plan-reviewer': { engine: true },
    // apra-fleet-3swo.5.3: MIGRATED -- see section (7).
    'scoped-replan-planner': { engine: true },
    // apra-fleet-3swo.5.3: MIGRATED -- see section (7).
    'scoped-replan-plan-reviewer': { engine: true },
    // apra-fleet-3swo.5.3: MIGRATED -- see section (7).
    'streak-assignment': { engine: true },
    // apra-fleet-3swo.5.7: MIGRATED -- see section (7).
    doer: { engine: true },
    // apra-fleet-3swo.5.7: MIGRATED -- see section (7).
    'doer-resume': { engine: true },
    // apra-fleet-3swo.5.7: MIGRATED -- see section (7).
    reviewer: { engine: true },
    // apra-fleet-3swo.5.7: MIGRATED -- see section (7).
    'final-review': { engine: true },
    // apra-fleet-3swo.5.7: MIGRATED -- see section (7).
    deployer: { engine: true },
    // apra-fleet-3swo.5.7: MIGRATED -- see section (7).
    'integ-test-runner': { engine: true },
    // apra-fleet-3swo.5.7: MIGRATED -- see section (7).
    'regression-test-runner': { engine: true },
    // apra-fleet-3swo.5.7: MIGRATED -- see section (7).
    harvester: { engine: true },
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

// ---------------------------------------------------------------------------
// Watchdog rationale gate (apra-fleet-3swo.7.12)
// ---------------------------------------------------------------------------
//
// The enumeration gate lives in a NAMED function so the falsification below
// can drive the very same code the passing test runs, against a spliced table.
// A falsification that re-implements the predicate inside its own
// assert.throws callback proves nothing: it stays green even with the gate
// deleted.

/** role-policies.mjs source with comments stripped -- the only view that can
 *  tell an explicitly DECLARED watchdog from a normalizer-supplied default. */
const ROLE_POLICIES_SRC = stripComments(
    fs.readFileSync(path.join(FLEET_SPRINT_DIR, 'role-policies.mjs'), 'utf8')
);

/** Explicit `watchdog: watchdog(...)` / `watchdog: noWatchdog(...)` declaration
 *  counts, read from source rather than from the loaded table. */
const WATCHDOG_CTOR_SITES = Object.freeze({
    watchdog: (ROLE_POLICIES_SRC.match(/watchdog:\s*watchdog\(/g) || []).length,
    noWatchdog: (ROLE_POLICIES_SRC.match(/watchdog:\s*noWatchdog\(/g) || []).length,
});

/** One declaration's source text: from `start` to the next entry/secondary. */
function policySourceRegionFrom(start) {
    const ends = [
        ROLE_POLICIES_SRC.indexOf("policy('", start + 1),
        ROLE_POLICIES_SRC.indexOf('secondary(', start + 1),
    ].filter((i) => i > -1);
    return ROLE_POLICIES_SRC.slice(start, ends.length > 0 ? Math.min(...ends) : ROLE_POLICIES_SRC.length);
}

/**
 * Locates the source declaration that states a role's watchdog.
 *
 * A role is declared either as its own `policy('<role>', { ... })` entry or as
 * a `secondary(<base>, '<role>', ...)` row. A secondary may state its own
 * watchdog (the planner's resume does) or INHERIT its base row's -- which is
 * legitimate explicitness, because the base states it at a real declaration
 * site, and is a different thing entirely from the normalizer silently
 * supplying one.
 *
 * @param {string} role
 * @returns {{ region: string, declaredBy: string }}
 */
function watchdogDeclarationSourceFor(role) {
    const escaped = role.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const direct = ROLE_POLICIES_SRC.indexOf(`policy('${role}',`);
    if (direct > -1) return { region: policySourceRegionFrom(direct), declaredBy: role };

    const asSecondary = new RegExp(`secondary\\((\\w+), '${escaped}',`).exec(ROLE_POLICIES_SRC);
    assert.ok(
        asSecondary,
        `${role}: no policy('${role}', ...) or secondary(..., '${role}', ...) declaration found in role-policies.mjs source.`
    );
    const region = policySourceRegionFrom(asSecondary.index);
    if (/watchdog:\s*(watchdog|noWatchdog)\(/.test(region)) return { region, declaredBy: role };

    // Inheriting is only acceptable if the base row itself states one.
    const baseConst = asSecondary[1];
    const baseDecl = new RegExp(`const ${baseConst} = policy\\('([\\w-]+)',`).exec(ROLE_POLICIES_SRC);
    assert.ok(baseDecl, `${role}: its secondary base '${baseConst}' is not a policy('<role>', ...) entry.`);
    const baseStart = ROLE_POLICIES_SRC.indexOf(`policy('${baseDecl[1]}',`);
    return { region: policySourceRegionFrom(baseStart), declaredBy: baseDecl[1] };
}

/**
 * THE gate: every role name has a machine-readable, non-placeholder rationale
 * bound to its watchdog.armed value. Throws (AssertionError, or TypeError if
 * the entry has no watchdog object at all) on the first offender.
 * @param {object} policies a ROLE_POLICIES-shaped table
 */
function assertEveryRoleHasWatchdogRationale(policies) {
    for (const name of ROLE_NAMES) {
        const row = policies[name];
        assert.ok(row, `${name}: no policy row at all.`);
        assert.ok(
            row.watchdog && typeof row.watchdog === 'object',
            `${name}: watchdog must be declared explicitly -- there is no silent default any more.`
        );
        const reason = row.watchdog.reason;
        assert.strictEqual(typeof reason, 'string', `${name}: watchdog.reason must be a string a test can read.`);
        assert.ok(
            reason.trim().length >= 20,
            `${name}: watchdog.reason must be a real justification, not a placeholder ("${reason}").`
        );
    }
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
        // apra-fleet-3swo.5.3: a MIGRATED role has no inline runner.js ladder
        // left to anchor on -- its ROLE_SOURCE entry is `{ engine: true }` and
        // every field below is re-derived by RUNNING the engine instead (see
        // the engine-derivation section at the end of this file).
        const engine = entry.migrated === true;
        assert.strictEqual(
            engine,
            src.engine === true,
            `${role}: ROLE_SOURCE must say { engine: true } for exactly the roles role-policies.mjs marks migrated.`
        );
        rows.push({ name: role, policy: entry, anchor: engine ? null : src.anchor, role, engine });
        if (entry.secondary && role !== 'doer') {
            if (!engine) {
                assert.ok(src.secondary, `${role}: policy declares a secondary dispatch but ROLE_SOURCE names no anchor for it.`);
            }
            rows.push({
                name: `${role} (${entry.secondary.kind})`,
                policy: entry.secondary,
                anchor: engine ? null : src.secondary,
                role,
                engine,
            });
        }
    }
    return rows;
}

/** Roles whose ladder still lives inline in runner.js (textual derivation). */
const INLINE_ROLES = ROLE_NAMES.filter((role) => ROLE_POLICIES[role].migrated !== true);
/** Roles whose ladder runs on the engine (behavioural derivation). */
const MIGRATED_ROLES = ROLE_NAMES.filter((role) => ROLE_POLICIES[role].migrated === true);
/** The engine's census entry in the planning-side pin table. */
const ENGINE_CENSUS = PLANNING_LADDERS.find((pin) => pin.mode === 'engine');

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

        // apra-fleet-3swo.5.3: the 22 dispatches are now covered on TWO sides.
        // A still-inline dispatch is covered by a source ANCHOR (unchanged);
        // an engine-served one is covered by an entry in ENGINE_DISPATCHES,
        // the planning pin file's behavioural pin table. Neither side may drop
        // a dispatch, and no dispatch may appear on both.
        const inlineRows = rows.filter((r) => !r.engine);
        const engineRows = rows.filter((r) => r.engine);

        assert.strictEqual(
            new Set(inlineRows.map((r) => siteFor(r.anchor).line)).size,
            inlineRows.length,
            'Each still-inline policy must anchor a DISTINCT dispatch site -- two rows on one site would leave a ' +
            'dispatch undescribed.'
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
        // The engine's own census anchor pins the ENGINE's call site, not any
        // one role's dispatch, so it is accounted for separately rather than
        // matched against a policy row.
        assert.ok(
            pinAnchors.delete(ENGINE_CENSUS.anchor),
            'The planning pin table must carry the engine census entry, so the engine\'s own agent() site stays pinned.'
        );
        assert.strictEqual(
            pinAnchors.size,
            inlineRows.length,
            `Expected ${inlineRows.length} pinned inline anchors across the two pin files, found ${pinAnchors.size}.`
        );
        assert.deepStrictEqual(
            inlineRows.map((r) => r.anchor).sort(),
            [...pinAnchors].sort(),
            'Every still-inline dispatch the pin files pin must have a policy row, and every inline policy row must ' +
            'sit on a pinned dispatch.'
        );

        // Engine-served dispatches: covered by role+kind rather than by text.
        assert.deepStrictEqual(
            ENGINE_DISPATCHES.map((d) => `${d.role}:${d.kind}`).sort(),
            engineRows.map((r) => `${r.policy.role}:${r.policy.kind}`).sort(),
            'Every migrated dispatch must have a behavioural pin in ENGINE_DISPATCHES, and every such pin must ' +
            'correspond to a migrated policy row.'
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
    test('no dispatch is derived from an inline runner.js call site any more', () => {
        assert.deepStrictEqual(
            dispatchRows().filter((r) => !r.engine).map((r) => r.name),
            [],
            'a dispatch has an INLINE runner.js call site again -- this section must cover it rather than iterating nothing.'
        );
        assert.strictEqual(dispatchRows().length, 22, 'All 22 dispatches must still be described.');
    });
    for (const row of dispatchRows().filter((r) => !r.engine)) {
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
// apra-fleet-3swo.5.7: with the execution-side migration complete, INLINE_ROLES
// is EMPTY -- every one of the thirteen rows is now derived by running the
// engine (section (7)) rather than by scanning runner.js. The textual
// derivation machinery above is deliberately kept rather than deleted: it
// becomes live again the moment a role is un-migrated, and a file that had
// thrown it away would silently lose that role's coverage instead of failing.
// These three guards are what stop the now-empty loops from passing vacuously:
// each asserts that emptiness is the EXPECTED state, so an un-migration is
// caught loudly, and section (7)'s own census asserts the engine side really
// covers everything.
function assertInlineDerivationIsExpectedlyEmpty(section) {
    assert.deepStrictEqual(
        INLINE_ROLES,
        [],
        `${section}: a role has an INLINE runner.js ladder again -- this section's loop must cover it rather than ` +
        'silently iterating nothing. Re-check ROLE_SOURCE has a real anchor/region for it.'
    );
    assert.strictEqual(
        MIGRATED_ROLES.length,
        ROLE_NAMES.length,
        `${section}: every row must be derived on exactly one side, and today that side is the engine.`
    );
}

describe('role policy table: retry ladders match runner.js', () => {
    test('no row is derived from an inline runner.js ladder any more', () => {
        assertInlineDerivationIsExpectedlyEmpty('retry ladders');
    });
    for (const role of INLINE_ROLES) {
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

    test('the doer resume ladder is bounded, and really escalates by doubling', async () => {
        // apra-fleet-3swo.5.7: re-anchored. The bound used to be runner.js's
        // MAX_TURN_RESUME_ATTEMPTS constant and the escalation a
        // `currentMaxTurns *= 2;` line; both moved onto the engine, where the
        // bound is retry.resumeAttempts and the escalation is performed by the
        // runtime turn budget the row names. Counting the resumes the engine
        // REALLY issues, and reading the budgets it REALLY passed, proves both.
        const p = policyFor('doer');
        // One exhaustion more than the ladder is allowed to answer, so the
        // BOUND is what stops it rather than the supply of failures running out.
        const { ctx, rec } = createRecordingCtx({
            responses: Array.from({ length: p.retry.resumeAttempts + 1 }, () => turnExhaustionError()),
        });
        await dispatchRole(ctx, 'doer', ROLE_CALL_OPTS.doer);
        const resumes = rec.dispatches.filter((d) => d.options.resume === true);
        assert.strictEqual(
            resumes.length,
            p.retry.resumeAttempts,
            'doer.retry.resumeAttempts must equal the number of resumes the engine really issues, never an unbounded ladder.'
        );
        assert.strictEqual(p.retry.turnEscalation, 'double');
        assert.deepStrictEqual(
            resumes.map((d) => d.options.max_turns),
            [TURN_BASES.BASE_DOER_MAX_TURNS * 2, TURN_BASES.BASE_DOER_MAX_TURNS * 4],
            'Each further turn exhaustion doubles again, from the base the row names.'
        );
        assert.strictEqual(
            ROLE_POLICIES['doer-resume'].maxTurns.kind,
            'runtime',
            'A doubling ladder has no constant budget to record -- the row says so.'
        );
    });
});

describe('role policy table: degrade behaviour matches runner.js', () => {
    test('no row is derived from an inline runner.js ladder any more', () => {
        assertInlineDerivationIsExpectedlyEmpty('degrade behaviour');
    });
    for (const role of INLINE_ROLES) {
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
    test('no dispatch has its steps derived from inline runner.js source any more', () => {
        assertInlineDerivationIsExpectedlyEmpty('pre-dispatch/post-result steps');
    });
    for (const row of dispatchRows().filter((r) => !r.engine)) {
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
        // apra-fleet-3swo.5.3: a MIGRATED ladder no longer owns a kill site of
        // its own -- dispatch-role.mjs performs the kill once, generically, for
        // every resume it runs (its 'kill-stale-session' preDispatch handler).
        // So the census is: one inline site per still-inline resume dispatch,
        // plus the infra-recovery kills of still-inline ladders, plus the
        // engine's single shared site. Counting the engine's site as if it were
        // a per-role one would make this assertion drift by exactly the number
        // of roles migrated, which is the failure this split avoids.
        const inlineKillers = killers.filter((p) => !ROLE_POLICIES[p.ladder].migrated);
        const extraInfraKills = ROLE_NAMES
            .filter((role) => !policyFor(role).migrated)
            .reduce((n, role) => n + policyFor(role).retry.infraResumeAttempts, 0);
        const engineKillSites = (stripComments(
            fs.readFileSync(path.join(FLEET_SPRINT_DIR, 'dispatch-role.mjs'), 'utf8'),
        ).match(/memberSessionGuard\.killIfAlive\(/g) || []).length;
        assert.strictEqual(
            engineKillSites,
            1,
            'The engine must kill a stale session in exactly ONE generic place -- a second site would be a per-role ' +
            'special case creeping back into the engine.'
        );
        const killSites = (stripComments(SRC).match(/memberSessionGuard\.killIfAlive\(/g) || []).length;
        assert.strictEqual(
            killSites,
            inlineKillers.length + extraInfraKills + engineKillSites,
            `The scanned module set has ${killSites} session-kill sites; the table accounts for ` +
            `${inlineKillers.length} still-inline resume dispatches plus ${extraInfraKills} infra-recovery resumes ` +
            `plus the engine's ${engineKillSites} shared site.`
        );
    });

    test('the doer resume checks the streak is not already closed BEFORE killing the session', async () => {
        const p = ROLE_POLICIES['doer-resume'];
        assert.deepStrictEqual(
            p.preDispatch,
            ['verify-streak-closed', 'kill-stale-session'],
            'The closed-streak short-circuit must run first: a streak whose beads all closed gets no resume dispatch at all.'
        );
        // apra-fleet-3swo.5.7: re-anchored. The order used to be a property of
        // runner.js text (the `preResumeUnclosed.length === 0` check sitting
        // above `killIfAlive(doerMember)`); it is now a property of what the
        // engine really does with the row's recorded step order.
        // The step implementation is the runner's, mirrored here: an empty
        // unclosed list at the preDispatch placement means "already done".
        const alreadyClosed = createRecordingCtx({
            responses: [turnExhaustionError()],
            steps: {
                'verify-streak-closed': async ({ phase }) => (phase === 'preDispatch'
                    ? { shortCircuit: true, value: null }
                    : []),
            },
        });
        const outcome = await dispatchRole(alreadyClosed.ctx, 'doer', ROLE_CALL_OPTS.doer);
        assert.strictEqual(
            alreadyClosed.rec.dispatches.length,
            1,
            'A turn-exhausted streak whose beads are ALL already closed is a success and gets NO resume dispatch.'
        );
        assert.deepStrictEqual(
            alreadyClosed.rec.kills,
            [],
            'The short-circuit must run BEFORE the kill: a streak that needs no resume needs no session killed either.'
        );
        assert.strictEqual(outcome.ok, true, 'It is a SUCCESS, not a failure -- the doer merely missed its VERIFY checkpoint.');
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
        // Re-derived from runner.js so a table edit alone cannot move this --
        // but only over the dispatches still bracketed INLINE. A migrated
        // ladder is bracketed by the engine's one generic withGitSync call,
        // whose pushCode argument is an expression rather than a literal, so
        // its flag is proved behaviourally by the pin file instead.
        const inlineCodePushers = allDispatchPolicies()
            .filter((p) => p.bracket.pushCode === true && ROLE_POLICIES[p.ladder].migrated !== true);
        const truesInSource = WITH_GIT_SYNC_SITES.filter((s) => splitTopLevelArgs(s.callText)[1] === 'true');
        assert.strictEqual(
            truesInSource.length,
            inlineCodePushers.length,
            `runner.js must still have exactly ${inlineCodePushers.length} literal code-pushing brackets.`
        );
    });

    test('a watchdog is armed only for the planner-side and long-unattended-phase dispatches', () => {
        // apra-fleet-3swo.7.12: deployer, integ-test-runner and
        // regression-test-runner were audited and ARMED this pass (a deliberate
        // behaviour change from the previously-inherited NO_WATCHDOG default) --
        // each is a long, unattended, single dispatch with no parallel
        // counterpart, gating later phases with no other client-side ceiling.
        // Every other role was audited and left disarmed with a recorded reason
        // (see the enumeration test below); this list is the machine-checked
        // record of the outcome, not just the planner-only set that predates
        // that audit.
        const armed = allDispatchPolicies().filter((p) => p.watchdog.armed);
        assert.deepStrictEqual(
            armed.map((p) => `${p.role}:${p.kind}`).sort(),
            [
                'planner:main', 'planner:max-turns-resume',
                'scoped-replan-planner:main',
                'deployer:main', 'deployer:max-turns-resume',
                'integ-test-runner:main', 'integ-test-runner:max-turns-resume',
                'regression-test-runner:main', 'regression-test-runner:max-turns-resume',
            ].sort(),
            'Only the interactive planner family plus the three audited long-unattended-phase roles arm a '
            + 'client-side watchdog.'
        );
        // Only the still-inline armed dispatches have a runner.js
        // withDispatchWatchdog(...) site of their own; a migrated one is armed
        // by the engine's single generic race, proved behaviourally below.
        const inlineArmed = armed.filter((p) => ROLE_POLICIES[p.ladder].migrated !== true);
        assert.strictEqual(
            inlineArmed.length,
            WATCHDOG_SITES.length,
            'The table must arm exactly as many watchdogs as runner.js still does inline.'
        );
        // The "every armed dispatch targets the planner member" invariant this
        // test used to check no longer holds now that deployer/integ-test-
        // runner/regression-test-runner are armed under their OWN role members
        // (scoped-replan-planner already borrowed the planner member before
        // this pass); `p.watchdog.member === 'dispatch'` -- the real
        // kill-target invariant -- is asserted per-row above and in the
        // migrated-roles behavioural section instead.
        for (const p of armed) {
            assert.strictEqual(p.watchdog.member, 'dispatch', `${p.role}:${p.kind}: watchdog.member must be 'dispatch'.`);
        }
    });

    test('every role name carries a machine-enumerable, non-empty watchdog rationale', () => {
        // apra-fleet-3swo.7.12: the count is DISCOVERED from ROLE_NAMES, never
        // hardcoded, so a role added later cannot silently ship with no
        // recorded justification for its armed/disarmed value.
        assert.ok(ROLE_NAMES.length > 0, 'sanity: ROLE_NAMES must not be empty for this gate to mean anything.');
        assertEveryRoleHasWatchdogRationale(ROLE_POLICIES);
    });

    test('the watchdog rationale gate bites: an entry missing a reason fails loudly', () => {
        // Falsification, per apra-fleet-3swo.7.12's acceptance criteria.
        //
        // This drives the REAL gates, never a re-implementation of them:
        //   (a) assertEveryRoleHasWatchdogRationale -- the exact function the
        //       enumeration test above calls -- run against a spliced table
        //       (splicePolicy, the same mutation seam the phase-3 pins use);
        //   (b) the PRODUCTION constructors in role-policies.mjs, reached
        //       through the real declaration site of a real role.
        // Deleting either gate makes this test fail, which is what a
        // falsification has to guarantee. The frozen table is never mutated:
        // splicePolicy returns a copy.

        // (a1) reason stripped, as if the declaration had omitted it.
        assert.throws(
            () => assertEveryRoleHasWatchdogRationale(
                splicePolicy('harvester', { watchdog: { ...ROLE_POLICIES.harvester.watchdog, reason: undefined } })
            ),
            (err) => err instanceof assert.AssertionError && /harvester: watchdog\.reason/.test(err.message),
            'A role entry with no watchdog.reason must fail the enumeration gate rather than pass silently.'
        );

        // (a2) a placeholder rationale -- present, a string, and worthless.
        assert.throws(
            () => assertEveryRoleHasWatchdogRationale(
                splicePolicy('harvester', { watchdog: { ...ROLE_POLICIES.harvester.watchdog, reason: 'TODO' } })
            ),
            (err) => err instanceof assert.AssertionError && /not a placeholder/.test(err.message),
            'A stub rationale must not satisfy the gate.'
        );

        // (a3) the whole watchdog declaration deleted. With the normalizer's
        // old `spec.watchdog ?? NO_WATCHDOG` fallback gone, the entry carries
        // watchdog === undefined, and the gate must fail LOUDLY rather than
        // read a silently-defaulted disarmed value.
        assert.throws(
            () => assertEveryRoleHasWatchdogRationale(splicePolicy('harvester', { watchdog: undefined })),
            (err) => /harvester: watchdog/.test(err.message),
            'A role entry with no watchdog declaration at all must fail loudly, not default to disarmed.'
        );

        // (a4) the gate is not vacuous in the other direction: the real,
        // unspliced table must pass it.
        assertEveryRoleHasWatchdogRationale(ROLE_POLICIES);

        // (b) the production constructors themselves. WATCHDOG_CTOR_SITES is
        // read from role-policies.mjs source, so this drives the requireReason
        // guard at its real declaration sites rather than a test-local copy.
        for (const ctor of ['watchdog', 'noWatchdog']) {
            assert.ok(
                WATCHDOG_CTOR_SITES[ctor] > 0,
                `sanity: role-policies.mjs must declare at least one ${ctor}(...) watchdog for this gate to mean anything.`
            );
        }
        assert.match(
            ROLE_POLICIES_SRC,
            /function requireReason\(reason, ctorName\) \{\s*if \(typeof reason !== 'string' \|\| reason\.trim\(\)\.length === 0\) \{\s*throw new TypeError\(/,
            'role-policies.mjs must keep the requireReason guard that makes an empty rationale throw at MODULE LOAD -- ' +
            'without it, a watchdog()/noWatchdog() call with no reason ships silently.'
        );
        assert.ok(
            !/spec\.watchdog\s*\?\?/.test(ROLE_POLICIES_SRC),
            'the normalizer must not re-introduce a `spec.watchdog ?? NO_WATCHDOG` fallback: a defaulted watchdog is ' +
            'indistinguishable from a declared one at run time, which is exactly what this bead removed.'
        );
    });

    test('every ROLE_POLICIES entry declares its watchdog in SOURCE, not by normalizer default', () => {
        // Criterion 1 is explicitly a SOURCE-LEVEL claim: enumerating the
        // LOADED table cannot tell a declared watchdog from a defaulted one --
        // both read identically -- and that is exactly what misled two earlier
        // planning passes. So this reads role-policies.mjs source and requires
        // each role's own policy('<role>', { ... }) literal to state a
        // watchdog() or noWatchdog() call of its own. The role list is
        // DISCOVERED from ROLE_NAMES; nothing here is hardcoded.
        for (const name of ROLE_NAMES) {
            const { region, declaredBy } = watchdogDeclarationSourceFor(name);
            assert.match(
                region,
                /watchdog:\s*(watchdog|noWatchdog)\(/,
                `${name}: no watchdog() / noWatchdog() call is stated at its declaration site ` +
                `(resolved to '${declaredBy}'). The normalizer no longer supplies one, so it must be stated in source.`
            );
        }

        // Secondary (resume) rows legitimately INHERIT their main row's
        // explicit declaration, so there are more dispatch rows than
        // declarations -- but never fewer declarations than roles.
        const declared = WATCHDOG_CTOR_SITES.watchdog + WATCHDOG_CTOR_SITES.noWatchdog;
        assert.ok(
            declared >= ROLE_NAMES.length,
            `role-policies.mjs declares ${declared} watchdog(...)/noWatchdog(...) call(s) for ${ROLE_NAMES.length} role(s) -- ` +
            'at least one explicit declaration per role is required.'
        );
        // Every armed row is traceable to an armed declaration in source: more
        // armed rows than armed declarations would mean a row became armed
        // through something other than a stated watchdog(...) call.
        assert.ok(
            allDispatchPolicies().filter((p) => p.watchdog.armed).length >= WATCHDOG_CTOR_SITES.watchdog,
            'every armed watchdog(...) declaration in source must show up as an armed row in the loaded table.'
        );
    });

    test('the integ runner degrades to INCONCLUSIVE, never to a test failure', () => {
        const p = policyFor('integ-test-runner');
        assert.strictEqual(p.degrade.kind, 'inconclusive');
        // apra-fleet-3swo.5.7: sharpened from "fabricates no verdict at all"
        // to name WHICH class fabricates nothing, which is the real invariant.
        // A schema-repair exhaustion or an ordinary dispatch failure DID reach
        // a running pass and legitimately records passed:false (that is what
        // runner.js always did, and the report shape is now in the row). An
        // 'infra'-class failure produced no verdict channel at all, so it is
        // deliberately absent from degrade.classes: the engine fabricates
        // nothing for it and returns an `inconclusive` record instead.
        assert.ok(
            !p.degrade.classes.includes('infra'),
            'An INCONCLUSIVE degrade must fabricate no test report for the class that produced no test evidence.'
        );
        assert.deepStrictEqual(p.degrade.classes, ['schema', 'dispatch']);
        assert.strictEqual(p.degrade.classifiesInfraFailures, true, 'Only a policy that asks for it can tell an infra failure apart from a dispatch failure.');
        assert.deepStrictEqual(
            ROLE_NAMES.filter((r) => policyFor(r).degrade.classifiesInfraFailures),
            ['integ-test-runner'],
            'Only the role whose dispatch produces test evidence needs the distinction.'
        );
        assert.strictEqual(p.retry.infraResumeAttempts, 1, 'One bounded infra-failure recovery attempt, distinct from the turn resume.');
        assert.deepStrictEqual(
            ROLE_NAMES.filter((r) => policyFor(r).retry.infraResumeAttempts > 0),
            ['integ-test-runner'],
        );
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

// -----------------------------------------------------------------------------
// (7) MIGRATED roles: every field re-derived by RUNNING the engine.
//
// WHY THIS SECTION EXISTS AND WHY IT IS NOT A TABLE-COMPARED-TO-A-TABLE.
// Sections (3)-(6) re-derive a policy row from runner.js SOURCE TEXT, which is
// the only evidence available while a ladder is a closure inside one enormous
// function. Once a ladder moves onto dispatchRole that evidence stops existing:
// the engine's loop is `for (let attempt = 1; attempt <= attempts; attempt++)`,
// so no regex over dispatch-role.mjs can tell you how many attempts the PLANNER
// makes -- it would give the same answer for every role.
//
// The replacement is not weaker, it is stronger. Every assertion below RUNS the
// real engine (fleet-sprint/dispatch-role.mjs) against the real frozen policy
// row and observes what it actually did: how many times it really dispatched,
// how long it really said it would wait, whether it really killed the session
// before resuming, what it really handed back once its attempts were spent.
// That is a re-derivation from real, executed source -- and it catches a class
// of defect the old scan could not: a policy field that is recorded but never
// applied. A row whose number is wrong now fails here instead of shipping green.
// -----------------------------------------------------------------------------

/** What the engine must resolve a policy's `member` to, given a ctx. */
function expectedMember(ctx, member) {
    if (member.kind === 'role') return ctx.getMemberForRole(member.role);
    return ROLE_CALL_OPTS_BINDINGS[member.binding];
}
// The runner-local values a 'pool-head'/'runtime' member or a 'per-bead' tier
// names by binding -- the reviewer's pool head and the doer's assigned member
// and declared tier (apra-fleet-3swo.5.7). Shared with the pin file through
// the harness so both prove the SAME resolution.
const ROLE_CALL_OPTS_BINDINGS = BINDINGS;

/** What the engine must resolve a policy's `model` to. */
function expectedModel(ctx, model) {
    if (!model) return null;
    if (model.kind === 'fixed') return ctx.fixedRoleTier[model.key];
    if (model.kind === 'inherited') return null;
    return ROLE_CALL_OPTS_BINDINGS[model.binding] ?? null;
}

/** Every dispatch of a migrated role, paired with the kind that produces it. */
function engineDispatchesOf(role) {
    const entry = ROLE_POLICIES[role];
    const rows = [{ policy: entry, kind: 'main', name: role }];
    if (entry.secondary) {
        rows.push({ policy: entry.secondary, kind: entry.secondary.kind, name: `${role} (${entry.secondary.kind})` });
    }
    return rows;
}

// 'doer-resume' is registered as a role of its own (it shares nothing but its
// member with the dispatch it continues), but it is not a LADDER of its own:
// it is the doer's secondary, reachable only after the doer spends its turns.
// engineDispatchesOf('doer') already covers it, so driving it as a standalone
// main dispatch would assert a ladder that does not exist.
const MIGRATED_LADDER_ROLES = MIGRATED_ROLES.filter((role) => ROLE_POLICIES[role].kind === 'main');

describe('role policy table: migrated roles re-derived by running the engine', () => {
    for (const role of MIGRATED_LADDER_ROLES) {
        for (const row of engineDispatchesOf(role)) {
            test(`${row.name}: member, model, turn budget, timeouts, bracket, watchdog, KB source and schema`, async () => {
                const { ctx, dispatch, opts } = await driveEngineDispatch(role, row.kind);
                assert.ok(dispatch, `${row.name}: the engine never made this dispatch.`);
                const p = row.policy;
                const o = dispatch.options;

                assert.strictEqual(o.member_name, expectedMember(ctx, p.member), `${row.name}: member resolution.`);
                assert.strictEqual(o.model ?? null, expectedModel(ctx, p.model), `${row.name}: model tier resolution.`);

                // The turn VALUE the row records must be the engine's own
                // named base times the recorded multiplier -- the same proof
                // the textual section makes against runner.js's constant.
                // A 'runtime'-kind turn budget (the doer's escalating resume
                // ladder) has no recorded VALUE at all: the number is computed
                // per resume attempt and arrives as a binding, so the pin is
                // that the engine passes THAT binding rather than a constant.
                assert.strictEqual(
                    o.max_turns ?? null,
                    p.maxTurns === null
                        ? null
                        : (p.maxTurns.kind === 'runtime' ? BINDINGS[p.maxTurns.binding] : p.maxTurns.value),
                    `${row.name}: turn budget.`
                );
                if (p.maxTurns && p.maxTurns.kind === 'constant') {
                    assert.strictEqual(
                        TURN_BASES[p.maxTurns.base] * p.maxTurns.multiplier,
                        p.maxTurns.value,
                        `${row.name}: recorded turn VALUE must equal the named turn base times the recorded multiplier.`
                    );
                }

                assert.strictEqual(
                    o.timeout_s ?? null,
                    p.timeouts.timeoutS === null ? null : ctx.budgets[p.timeouts.timeoutS],
                    `${row.name}: inactivity timeout budget, resolved from the SYMBOLIC name the row records.`
                );
                assert.strictEqual(
                    o.max_total_s ?? null,
                    p.timeouts.maxTotalS === null ? null : ctx.budgets[p.timeouts.maxTotalS],
                    `${row.name}: hard elapsed-time budget.`
                );

                const expectedResume = p.resumeArg === null
                    ? null
                    : (p.resumeArg.kind === 'same-session' ? true : (opts.resumeArg ?? null));
                assert.strictEqual(o.resume ?? null, expectedResume, `${row.name}: same-session resume argument.`);
                assert.strictEqual(o.agentType ?? null, p.agentType, `${row.name}: persona.`);
                assert.strictEqual(
                    o.schema ?? null,
                    p.schema === null ? null : SCHEMAS[p.schema],
                    `${row.name}: returnable verdict schema.`
                );

                // --- bracket ----------------------------------------------------
                if (!p.bracket.wrapped) {
                    assert.strictEqual(dispatch.bracket, null, `${row.name}: policy says no git-sync bracket, but one was opened.`);
                } else {
                    assert.ok(dispatch.bracket, `${row.name}: policy says bracketed, but no bracket was opened.`);
                    assert.strictEqual(dispatch.bracket.member, expectedMember(ctx, p.member), `${row.name}: the bracket must sync the dispatched member.`);
                    assert.strictEqual(dispatch.bracket.pushCode, p.bracket.pushCode === true, `${row.name}: pushCode flag.`);
                    assert.strictEqual(dispatch.bracket.options.pushBeads, p.bracket.pushBeads === true, `${row.name}: pushBeads flag.`);
                }

                // --- watchdog ---------------------------------------------------
                if (!p.watchdog.armed) {
                    assert.strictEqual(dispatch.watchdog, null, `${row.name}: policy arms no watchdog, but the dispatch was raced against one.`);
                } else {
                    assert.ok(dispatch.watchdog, `${row.name}: policy arms a watchdog, but the dispatch was not raced against one.`);
                    assert.strictEqual(dispatch.watchdog.timeoutS, ctx.budgets[p.watchdog.timeoutS], `${row.name}: watchdog budget.`);
                    assert.strictEqual(p.watchdog.member, 'dispatch');
                    assert.strictEqual(
                        dispatch.watchdog.member,
                        expectedMember(ctx, p.member),
                        `${row.name}: the watchdog must name the dispatched member (policy records this as member:'dispatch').`
                    );
                    assert.strictEqual(dispatch.watchdog.label, watchdogLabelOf(p.watchdog.label), `${row.name}: watchdog label.`);
                }

                // --- KB injection source ---------------------------------------
                const expectedKb = p.agentType === null
                    ? 'none'
                    : (KB_SELF_INJECTING_ROLES.has(p.agentType) ? 'prompt-builder' : 'wrapper');
                assert.strictEqual(
                    p.kbInjection,
                    expectedKb,
                    `${row.name}: kbInjection must match where the knowledge block actually comes from for persona ` +
                    `${JSON.stringify(p.agentType)}.`
                );
            });
        }

        test(`${role}: attempts, backoff, resume escalation, auth self-heal and sync-failure handling (engine-derived)`, async () => {
            const p = policyFor(role);
            const opts = ROLE_CALL_OPTS[role];
            const withValidate = ROLE_POLICIES[role].postResult.includes('select-streaks-validate')
                ? { ...opts, validate: streakValidate }
                : opts;
            const spend = (make) => Array.from({ length: p.retry.attempts + 1 }, make);
            /** Runs the ladder to exhaustion, tolerating a fatal degrade's rethrow. */
            const runSpent = async (make, ctxOver = {}) => {
                const { ctx, rec } = createRecordingCtx({ responses: spend(make), ...ctxOver });
                let thrown = null;
                let outcome = null;
                try {
                    outcome = await dispatchRole(ctx, role, withValidate);
                } catch (err) {
                    thrown = err;
                }
                return { ctx, rec, outcome, thrown };
            };

            // --- attempts, re-derived by counting real dispatches -------------
            const spent = await runSpent(() => busyError());
            assert.strictEqual(
                spent.rec.dispatches.length,
                p.retry.attempts,
                `${role}: retry.attempts must equal the number of dispatches the engine really makes before giving up.`
            );

            // --- backoff ladder, re-derived from the waits it announced -------
            const waits = spent.rec.logs.filter((m) => /waiting [\d.]+s before retry attempt/.test(m));
            if (p.retry.backoffMs) {
                assert.deepStrictEqual(
                    waits,
                    p.retry.backoffMs
                        .map((ms, i) => (ms > 0
                            ? `${opts.roleLabel} dispatch: waiting ${ms / 1000}s before retry attempt ${i + 1}/${p.retry.backoffMs.length}...`
                            : null))
                        .filter(Boolean),
                    `${role}: retry.backoffMs must be the backoff ladder the engine really waits out.`
                );
            } else {
                assert.deepStrictEqual(waits, [], `${role}: the policy records no backoff ladder, so the engine must announce no waits.`);
            }

            // --- max_turns resume ---------------------------------------------
            // One exhaustion per resume the ladder is allowed to issue, so a
            // BOUNDED escalating ladder (the doer's) is driven to its bound
            // rather than stopping because the failures ran out.
            const exhausted = createRecordingCtx({
                responses: Array.from({ length: Math.max(p.retry.resumeAttempts, 1) }, () => turnExhaustionError()),
            });
            let resumeThrew = null;
            try {
                await dispatchRole(exhausted.ctx, role, withValidate);
            } catch (err) {
                resumeThrew = err;
            }
            assert.strictEqual(
                exhausted.rec.dispatches.length > 1,
                p.retry.maxTurnsResume,
                `${role}: retry.maxTurnsResume must match whether turn exhaustion really resumes.`
            );
            if (p.retry.maxTurnsResume) {
                assert.strictEqual(resumeThrew, null, `${role}: a successful resume must not propagate the exhaustion.`);
                assert.strictEqual(
                    exhausted.rec.dispatches.length - 1,
                    p.retry.resumeAttempts,
                    `${role}: retry.resumeAttempts must equal the number of resumes the engine really issues per attempt.`
                );
                assert.strictEqual(
                    exhausted.rec.dispatches[1].options.max_turns,
                    exhausted.rec.dispatches[0].options.max_turns * 2,
                    `${role}: retry.turnEscalation='double' must be the escalation the resume really performs.`
                );
                for (let i = 2; i < exhausted.rec.dispatches.length; i++) {
                    assert.strictEqual(
                        exhausted.rec.dispatches[i].options.max_turns,
                        exhausted.rec.dispatches[i - 1].options.max_turns * 2,
                        `${role}: every further resume must double again, not repeat the same budget.`
                    );
                }
                assert.strictEqual(p.retry.turnEscalation, 'double');
            } else {
                assert.strictEqual(p.retry.resumeAttempts, 0);
                assert.strictEqual(p.retry.turnEscalation, null);
            }

            // --- auth self-heal ------------------------------------------------
            const authRun = await runSpent(() => authError(), { healed: false });
            assert.strictEqual(
                authRun.rec.authHeals.length > 0,
                p.retry.authSelfHeal,
                `${role}: retry.authSelfHeal must match whether the ladder really self-heals an LLM-auth failure.`
            );
            if (p.retry.authSelfHeal) {
                assert.strictEqual(
                    authRun.rec.authHeals[0].label,
                    `${opts.roleLabel} dispatch`,
                    `${role}: the self-heal must name the dispatch it is healing.`
                );
            }

            // --- abort on a non-retryable (auth/trust) failure -----------------
            // Observed through the engine's own abort announcement rather than
            // through the dispatch COUNT: a ladder that also rethrows
            // unrecognised errors would stop after one dispatch either way, so
            // a count-based derivation would report the flag as set for a role
            // that does not carry it.
            const trustRun = await runSpent(() => trustError());
            assert.strictEqual(
                trustRun.rec.logs.some((m) => /threw a non-retryable error \(auth\/trust\)/.test(m)),
                p.retry.abortOnNonRetryable,
                `${role}: retry.abortOnNonRetryable must match whether an auth/trust failure really ends the ladder early.`
            );
            if (p.retry.abortOnNonRetryable) {
                assert.strictEqual(
                    trustRun.rec.dispatches.length,
                    1,
                    `${role}: an aborting ladder must not burn its remaining attempts on a deterministic failure.`
                );
            }

            // --- a dispatch that already ran is never re-dispatched ------------
            const syncRun = await runSpent(() => postDispatchSyncError());
            assert.strictEqual(
                syncRun.rec.logs.some((m) => /COMPLETED but its post-dispatch sync failed/.test(m)),
                p.retry.skipRedispatchOnPostDispatchSyncFailure,
                `${role}: a dispatch that already ran must not be re-dispatched for a post-dispatch sync failure.`
            );
            if (p.retry.skipRedispatchOnPostDispatchSyncFailure) {
                assert.strictEqual(
                    syncRun.rec.dispatches.length,
                    1,
                    `${role}: a turn whose writes are already local must never be re-dispatched.`
                );
            }

            // --- no-mutation pre-sync skip ------------------------------------
            if (p.retry.attempts > 1 && p.bracket.wrapped) {
                const skipped = await runSpent(() => busyError(), { noMutation: () => true });
                assert.strictEqual(
                    skipped.rec.dispatches[1].bracket.options.skipPreDispatchSync === true,
                    p.retry.skipPreDispatchSyncOnNoMutation,
                    `${role}: only a provably no-mutation failure may let the next attempt skip its pre-dispatch sync.`
                );
            }

            // --- resuming a retry onto the branch's remote tip ----------------
            // A RETRY only: the first attempt of any ladder keeps plain
            // ff-only pre-dispatch sync, and only a retry that follows a
            // failure which may have COMMITTED needs to build on already-
            // published work instead of creating a divergent, content-identical
            // duplicate commit.
            const bracketed = spent.rec.dispatches.filter((d) => d.bracket);
            for (const d of bracketed) {
                const isFirst = d === bracketed[0];
                assert.strictEqual(
                    d.bracket.options.resumeOntoRemoteTip === true,
                    p.retry.resumeOntoRemoteTipOnRetry && !isFirst,
                    `${role}: retry.resumeOntoRemoteTipOnRetry must match whether a RETRY really resumes onto the remote tip.`
                );
            }
            if (p.retry.resumeOntoRemoteTipOnRetry) {
                // ...and NOT after an auth/trust failure, which provably ran
                // nothing: there is no published work for it to build on.
                const healedRun = await runSpent(() => authError(), { healed: true });
                for (const d of healedRun.rec.dispatches.filter((x) => x.bracket)) {
                    assert.notStrictEqual(
                        d.bracket.options.resumeOntoRemoteTip,
                        true,
                        `${role}: a retry after a provably no-mutation auth failure must not reset onto the remote tip.`
                    );
                }
            }
            // --- infra-failure recovery resume ---------------------------------
            // An envelope-less dispatch failure is a DIFFERENT condition from
            // turn exhaustion, so it needs its own drive: count the extra
            // dispatches the engine really issues before the first attempt is
            // over. Zero for every ladder but the integ runner.
            const infraRun = createRecordingCtx({ responses: [infraError()] });
            let infraThrew = null;
            try {
                await dispatchRole(infraRun.ctx, role, withValidate);
            } catch (err) {
                infraThrew = err;
            }
            assert.strictEqual(
                infraRun.rec.logs.filter((m) => /infrastructure dispatch failure .* resuming the same session once/.test(m)).length,
                p.retry.infraResumeAttempts,
                `${role}: retry.infraResumeAttempts must equal the number of infra-recovery resumes the engine really issues.`
            );
            if (p.retry.infraResumeAttempts > 0) {
                assert.strictEqual(infraThrew, null, `${role}: a successful infra recovery must not propagate the failure.`);
                assert.ok(
                    infraRun.rec.dispatches.length > 1,
                    `${role}: an infra-recovering ladder must really re-dispatch, not merely log about it.`
                );
            }

            // --- a healed retry that ends the ladder ---------------------------
            // Derived by SPLICING the field on a copy of this role's real row
            // and giving both arms the same enlarged attempt budget, because
            // at the real budget of two the two settings coincide: the heal
            // consumes attempt one and the generic retry IS attempt two. With
            // room to tell them apart, a short-circuiting ladder stops after
            // the healed retry while a non-short-circuiting one keeps going.
            for (const shortCircuits of [true, false]) {
                const spliced = splicePolicy(role, {
                    retry: { ...p.retry, attempts: 3, authSelfHeal: true, abortOnNonRetryable: true, authSelfHealShortCircuits: shortCircuits },
                });
                const { ctx, rec } = createRecordingCtx({
                    responses: [authError(), busyError(), busyError()],
                    healed: true,
                    policies: spliced,
                });
                try {
                    await dispatchRole(ctx, role, withValidate);
                } catch { /* a fatal degrade rethrows; the dispatch COUNT is the pin */ }
                assert.strictEqual(
                    rec.dispatches.length,
                    shortCircuits ? 2 : 3,
                    `${role}: retry.authSelfHealShortCircuits=${shortCircuits} must decide whether the healed retry is ` +
                    'the ladder\'s last word or merely another attempt.'
                );
            }
            assert.strictEqual(
                p.retry.authSelfHealShortCircuits,
                ROLE_POLICIES[role].retry.authSelfHealShortCircuits,
                `${role}: the real row's setting is what the ladder ships with.`
            );

            // --- bounded semantic-repair re-ask -------------------------------
            const repair = createRecordingCtx({ responses: [REJECTED_CANDIDATE, ACCEPTED_CANDIDATE] });
            await dispatchRole(repair.ctx, role, withValidate);
            const reAsks = repair.rec.logs.filter((m) => /candidate rejected .* re-asking once/.test(m)).length;
            assert.strictEqual(
                reAsks,
                p.retry.semanticRepairReAsks,
                `${role}: retry.semanticRepairReAsks must equal the number of validation-failure re-asks the engine really makes.`
            );
        });

        test(`${role}: what the ladder produces when its attempts are spent (engine-derived)`, async () => {
            const p = policyFor(role);
            const d = p.degrade;
            const opts = ROLE_POLICIES[role].postResult.includes('select-streaks-validate')
                ? { ...ROLE_CALL_OPTS[role], validate: streakValidate }
                : ROLE_CALL_OPTS[role];
            const spend = (make) => Array.from({ length: p.retry.attempts + 1 }, make);
            const run = async (make) => {
                const { ctx, rec } = createRecordingCtx({ responses: spend(make) });
                try {
                    return { outcome: await dispatchRole(ctx, role, opts), thrown: null, rec };
                } catch (err) {
                    return { outcome: null, thrown: err, rec };
                }
            };

            // Every ERROR_CLASS this ladder's degrade RECOGNISES, driven one at
            // a time with an error that really is of that class. The first two
            // are universal; the other three exist only for the roles whose
            // policy asks for them, so driving a class the policy does not
            // recognise would prove nothing about it.
            const recognisedClasses = ['schema', 'dispatch'];
            if (d.classifiesInfraFailures) recognisedClasses.unshift('infra');
            if (d.classifiesSyncFailures) recognisedClasses.push('sync');
            if (d.classifiesUnrecognisedErrors) recognisedClasses.push('unknown');
            const CLASS_DRIVERS = {
                schema: () => schemaError(),
                dispatch: () => transportError(),
                infra: () => infraError(),
                sync: () => gitSyncError(),
                unknown: () => new TypeError('not a dispatch failure at all'),
            };
            const runs = [];
            for (const errorClass of recognisedClasses) {
                runs.push({ errorClass, ...(await run(CLASS_DRIVERS[errorClass])) });
            }

            if (d.kind === 'fatal') {
                for (const r of runs) {
                    assert.ok(r.thrown, `${role}: an abortsSprint degrade must really rethrow its accumulated error.`);
                }
                assert.ok(d.abortsSprint, `${role}: only a sprint-ending degrade may be fatal.`);
                return;
            }

            for (const r of runs) {
                assert.strictEqual(
                    r.thrown,
                    null,
                    `${role}: a non-fatal degrade must never propagate a failure of a class it recognises (${r.errorClass}).`
                );
                assert.strictEqual(r.outcome.degraded, true, `${role}: a spent ladder must report itself degraded.`);
            }

            const synthesizing = runs.filter((r) => r.outcome.value !== null);
            assert.deepStrictEqual(
                synthesizing.map((r) => r.errorClass).sort(),
                [...d.classes].sort(),
                `${role}: degrade.classes must be exactly the error classes that really fabricate a value.`
            );
            // `paths` counts distinct degrade PATHS, not classes: a ladder
            // whose auth self-heal short-circuits reaches every class twice
            // (once from the healed retry, once from the generic one), which
            // is why the final review records four paths over two classes.
            assert.strictEqual(
                d.paths,
                d.classes.length * (p.retry.authSelfHealShortCircuits ? 2 : 1),
                `${role}: degrade.paths must be its classes times the number of ladder positions that reach them.`
            );
            if (d.synthesized) {
                for (const r of synthesizing) {
                    for (const [key, value] of Object.entries(d.synthesized)) {
                        if (key === 'grouping') continue; // a caller-side deterministic fallback, not a fabricated value
                        assert.deepStrictEqual(r.outcome.value[key], value, `${role}: the degrade must synthesize ${key}=${JSON.stringify(value)}.`);
                    }
                    assert.strictEqual(
                        typeof r.outcome.value[d.notesField],
                        'string',
                        `${role}: every synthesized value must carry its failure text in '${d.notesField}'.`
                    );
                    if (d.marker) {
                        assert.strictEqual(r.outcome.value[d.marker], true, `${role}: every synthesized value must carry the '${d.marker}' marker.`);
                    }
                    for (const forbidden of d.neverSynthesizes) {
                        assert.ok(d.verdictField, `${role}: neverSynthesizes constrains degrade.verdictField, which must be recorded.`);
                        assert.notStrictEqual(
                            r.outcome.value[d.verdictField],
                            forbidden,
                            `${role}: no degrade path may ever synthesize ${d.verdictField}=${forbidden}.`
                        );
                    }
                }
            } else {
                assert.deepStrictEqual(d.classes, [], `${role}: a degrade with no template can fabricate nothing.`);
            }

            // An unrecognised error class still propagates (or does not),
            // exactly as the row records.
            const unrecognised = await run(() => new TypeError('not a dispatch failure at all'));
            assert.strictEqual(
                unrecognised.thrown !== null,
                d.rethrowsUnrecognisedErrors,
                `${role}: degrade.rethrowsUnrecognisedErrors must match whether an unrecognised error really propagates.`
            );
        });

        test(`${role}: every recorded step is a step the engine really performs`, async () => {
            for (const row of engineDispatchesOf(role)) {
                const { ctx, rec } = await driveEngineDispatch(role, row.kind);
                const p = row.policy;
                for (const step of p.preDispatch) {
                    if (step === 'kill-stale-session') {
                        assert.ok(
                            rec.kills.includes(expectedMember(ctx, p.member)),
                            `${row.name}: policy records 'kill-stale-session', but the engine killed no session for that member.`
                        );
                        const killIndex = rec.events.findIndex((e) => e.type === 'kill');
                        const dispatchIndex = rec.events.findIndex((e) => e.type === 'dispatch' && e.entry === rec.dispatches[1]);
                        assert.ok(killIndex >= 0 && killIndex < dispatchIndex, `${row.name}: the kill must precede the dispatch it precedes.`);
                        continue;
                    }
                    // Every other step is a ctx.steps HOOK, so the evidence is
                    // that the engine really invoked it -- and invoked it
                    // BEFORE the dispatch it precedes, which is the whole
                    // meaning of 'preDispatch'.
                    const invoked = rec.steps.filter((e) => e.step === step);
                    assert.ok(
                        invoked.length > 0,
                        `${row.name}: policy records preDispatch step '${step}', but the engine never invoked it.`
                    );
                    // Compared against the dispatch this step PRECEDES -- for a
                    // secondary that is the resume, not the main dispatch that
                    // already ran (same rule the kill-stale-session branch uses).
                    const stepIndex = rec.events.findIndex((e) => e.type === 'step' && e.step === step);
                    const precedes = row.kind === 'main' ? rec.dispatches[0] : rec.dispatches[1];
                    const dispatchIndex = rec.events.findIndex((e) => e.type === 'dispatch' && e.entry === precedes);
                    assert.ok(
                        stepIndex >= 0 && (dispatchIndex < 0 || stepIndex < dispatchIndex),
                        `${row.name}: preDispatch step '${step}' must run BEFORE the dispatch, not after it.`
                    );
                }
            }
            const { rec, outcome } = await driveEngineDispatch(role, 'main');
            for (const step of ROLE_POLICIES[role].postResult) {
                if (step === 'invalidate-beads-cache') {
                    assert.strictEqual(
                        rec.invalidations,
                        1,
                        `${role}: policy records 'invalidate-beads-cache', but the engine did not drop the orchestrator's beads cache.`
                    );
                    continue;
                }
                if (step === 'select-streaks-validate') {
                    assert.ok(
                        outcome.validation,
                        `${role}: policy records 'select-streaks-validate', but the engine returned no validation result.`
                    );
                    continue;
                }
                // A postResult hook must run AFTER the dispatch and must be
                // handed the dispatch's own RESULT -- a step that cannot see
                // what came back could not act on it.
                const invoked = rec.steps.filter((e) => e.step === step);
                assert.ok(
                    invoked.length > 0,
                    `${role}: policy records postResult step '${step}', but the engine never invoked it.`
                );
                assert.ok(
                    Object.prototype.hasOwnProperty.call(invoked[0], 'value'),
                    `${role}: postResult step '${step}' must be handed the dispatch's result.`
                );
                const stepIndex = rec.events.findIndex((e) => e.type === 'step' && e.step === step);
                const lastDispatchIndex = rec.events.map((e) => e.type).lastIndexOf('dispatch');
                assert.ok(
                    stepIndex > lastDispatchIndex,
                    `${role}: postResult step '${step}' must run AFTER the dispatch it follows.`
                );
            }

            // --- degrade steps: run on FAILURE, and never on success ----------
            // The distinction is the whole reason DEGRADE_STEPS is a separate
            // vocabulary: the per-round reviewer must drop its round session
            // when a round fails and must KEEP it when the round succeeds, and
            // a step recorded in the wrong list gets exactly that backwards.
            const degradeSteps = ROLE_POLICIES[role].degrade.steps;
            for (const step of degradeSteps) {
                assert.strictEqual(
                    rec.steps.filter((e) => e.step === step).length,
                    0,
                    `${role}: degrade step '${step}' must NOT run after a successful dispatch.`
                );
            }
            if (degradeSteps.length > 0) {
                const pDegrade = policyFor(role);
                const failing = createRecordingCtx({
                    responses: Array.from({ length: pDegrade.retry.attempts + 1 }, () => transportError()),
                });
                try {
                    await dispatchRole(failing.ctx, role, ROLE_CALL_OPTS[role]);
                } catch { /* a fatal degrade rethrows; the step record is the pin */ }
                for (const step of degradeSteps) {
                    assert.ok(
                        failing.rec.steps.some((e) => e.step === step),
                        `${role}: policy records degrade step '${step}', but a failing ladder never invoked it.`
                    );
                }
            }
        });
    }

    test('the engine-derived section really covers every migrated role', () => {
        // Guards the loops themselves: if MIGRATED_ROLES were ever empty (or
        // short) the per-role tests above would silently not exist rather than
        // fail, which is exactly how a migration would lose its coverage.
        assert.deepStrictEqual(
            MIGRATED_ROLES,
            ROLE_NAMES.filter((r) => ROLE_POLICIES[r].migrated === true),
            'MIGRATED_ROLES must be exactly the roles role-policies.mjs marks migrated.'
        );
        assert.strictEqual(
            MIGRATED_ROLES.length + INLINE_ROLES.length,
            ROLE_NAMES.length,
            'Every role must be derived on exactly one side: textually from runner.js, or behaviourally from the engine.'
        );
    });
});

// =============================================================================
// apra-fleet-3swo.5.4 -- the CONSOLIDATED verdict/fallback path, and the proof
// that each role's remaining variance is DATA rather than a branch in it.
//
// The ladders themselves collapsed onto dispatchRole in .5.3/.5.7. What was
// still duplicated afterwards was the DEGRADE side: every runner.js dispatch
// site handed the engine its own `synthesizedNotes` map of per-error-class
// note builders, six near-identical copies of the same two sentences. Those
// are now `degrade.noteTemplates` in role-policies.mjs, rendered by ONE
// implementation (dispatch-role.mjs renderDegradeNote).
//
// The tests below are deliberately MUTATION tests, not table-vs-table
// comparisons: each takes the real frozen row, changes exactly one degrade
// FIELD, runs the real engine, and asserts the behaviour changed accordingly.
// That is the only assertion shape that can tell "driven by the table" apart
// from "hard-coded in the engine and happens to agree with the table" -- a
// per-role fallback branch restored inside dispatch-role.mjs would keep
// producing the real row's behaviour and fail these.
// =============================================================================

/** Enough failures to spend `role`'s whole ladder, all of one class. */
function spendLadder(role, make) {
    return Array.from({ length: policyFor(role).retry.attempts + 1 }, make);
}

/** Runs `role`'s ladder to exhaustion against `policies`, capturing a throw. */
async function runSpentLadder(role, make, policies) {
    const { ctx, rec } = createRecordingCtx({ responses: spendLadder(role, make), ...(policies ? { policies } : {}) });
    try {
        return { outcome: await dispatchRole(ctx, role, ROLE_CALL_OPTS[role]), thrown: null, rec };
    } catch (err) {
        return { outcome: null, thrown: err, rec };
    }
}

/** The same row with one degrade FIELD replaced. */
function spliceDegrade(role, over) {
    return splicePolicy(role, { degrade: { ...ROLE_POLICIES[role].degrade, ...over } });
}

describe('apra-fleet-3swo.5.4: the consolidated degrade path is driven by the table', () => {
    test('every fabricating role records a note template for exactly the classes it fabricates for', () => {
        for (const role of ROLE_NAMES) {
            const d = ROLE_POLICIES[role].degrade;
            assert.deepStrictEqual(
                Object.keys(d.noteTemplates).sort(),
                [...d.classes].sort(),
                `${role}: degrade.noteTemplates must cover exactly degrade.classes -- a fabricated value with no ` +
                'template would write an empty note, and a template for a class the ladder never fabricates for is dead data.'
            );
            for (const [errorClass, template] of Object.entries(d.noteTemplates)) {
                assert.ok(ERROR_CLASSES.includes(errorClass), `${role}: '${errorClass}' is not one of ERROR_CLASSES.`);
                assert.ok(
                    template.includes('{message}'),
                    `${role}: the '${errorClass}' note template must interpolate {message} -- a degrade note that ` +
                    'drops the terminal error text tells the operator nothing about what actually failed.'
                );
                assert.ok(
                    !/\{(?!message\}|name\})/.test(template),
                    `${role}: the '${errorClass}' note template uses a placeholder outside the {message}/{name} ` +
                    'vocabulary the engine renders.'
                );
            }
        }
    });

    // The consolidation's own falsification: the note text must have exactly
    // ONE source. A restored per-role fallback -- a note builder passed in
    // from a dispatch site, or a per-role branch inside the engine -- is what
    // this catches, because both would reintroduce a second place the wording
    // can drift to.
    test('no dispatch site anywhere supplies its own per-role degrade notes', () => {
        for (const file of dispatchLadderModulePaths(FLEET_SPRINT_DIR)) {
            const text = stripComments(fs.readFileSync(file, 'utf8'));
            assert.ok(
                !/synthesizedNotes/.test(text),
                `${path.basename(file)}: a dispatch site is supplying its own per-role degrade notes again. The ` +
                'failure text is degrade.noteTemplates data in role-policies.mjs; there is one renderer for every role.'
            );
        }
        const engine = stripComments(fs.readFileSync(path.join(FLEET_SPRINT_DIR, 'dispatch-role.mjs'), 'utf8'));
        assert.strictEqual(
            (engine.match(/noteTemplates\[/g) || []).length,
            1,
            'The engine must LOOK UP a note template in exactly ONE place (renderDegradeNote) -- a second lookup is ' +
            'a per-role degrade path growing back inside the consolidated one.'
        );
    });

    // Mutating the TEMPLATE, not the caller: the note a degraded value carries
    // changes with the table and with nothing else.
    for (const role of ROLE_NAMES.filter((r) => ROLE_POLICIES[r].degrade.classes.includes('dispatch'))) {
        test(`${role}: the degraded value's failure text comes from degrade.noteTemplates`, async () => {
            const d = ROLE_POLICIES[role].degrade;

            const real = await runSpentLadder(role, () => transportError());
            assert.strictEqual(real.thrown, null, `${role}: a dispatch-class failure must degrade, not propagate.`);
            assert.strictEqual(
                real.outcome.value[d.notesField],
                d.noteTemplates.dispatch.replace('{message}', 'connection dropped'),
                `${role}: the real row's own template, rendered against the terminal error, is what the caller gets.`
            );

            const spliced = await runSpentLadder(
                role,
                () => transportError(),
                spliceDegrade(role, { noteTemplates: { ...d.noteTemplates, dispatch: 'SPLICED-NOTE: {message}' } })
            );
            assert.strictEqual(
                spliced.outcome.value[d.notesField],
                'SPLICED-NOTE: connection dropped',
                `${role}: changing the template must change the note -- if it does not, the text is hard-coded in the engine.`
            );
        });
    }

    // --- the integ runner's INCONCLUSIVE variance ---------------------------
    test('integ: INCONCLUSIVE is degrade DATA -- degrade.kind and classifiesInfraFailures each change it', async () => {
        const role = 'integ-test-runner';
        const d = ROLE_POLICIES[role].degrade;
        assert.strictEqual(d.kind, 'inconclusive', 'The integ runner is the table\'s one inconclusive degrade.');

        // As shipped: an envelope-less failure produces NO verdict at all --
        // an `inconclusive` record instead of a fabricated passed:false.
        const real = await runSpentLadder(role, () => infraError());
        assert.strictEqual(real.thrown, null);
        assert.ok(real.outcome.inconclusive, 'An infra failure must report WHY there is no verdict.');
        assert.strictEqual(
            real.outcome.value,
            null,
            'An infra failure must fabricate nothing: it never reached a test pass, so there is no result to report.'
        );

        // ONE field: stop RECOGNISING the class. The identical error is now an
        // ordinary dispatch failure, so it fabricates the report -- i.e.
        // records a test failure that never happened. That is exactly the
        // regression classifiesInfraFailures exists to prevent, and it is
        // reachable by changing the table alone.
        const unrecognised = await runSpentLadder(role, () => infraError(), spliceDegrade(role, { classifiesInfraFailures: false }));
        assert.strictEqual(unrecognised.thrown, null);
        assert.strictEqual(
            unrecognised.outcome.inconclusive,
            null,
            'With the class unrecognised there is no inconclusive record left to make.'
        );
        assert.strictEqual(
            unrecognised.outcome.value.passed,
            false,
            'It is recorded as a failed pass instead -- the false failure the real row avoids.'
        );

        // ONE field: keep recognising the class, change only the degrade KIND.
        // The inconclusive RECORD is what disappears, which pins that the
        // record is keyed off degrade.kind rather than off the caller.
        const otherKind = await runSpentLadder(role, () => infraError(), spliceDegrade(role, { kind: 'synthesized-report' }));
        assert.strictEqual(otherKind.thrown, null);
        assert.strictEqual(
            otherKind.outcome.inconclusive,
            null,
            'Only an `inconclusive`-kind degrade makes an inconclusive record; the kind is the switch.'
        );

        // And the asymmetry holds the other way: a schema/dispatch failure DID
        // reach a running pass, so it still reports passed:false, never
        // inconclusive.
        for (const make of [schemaError, transportError]) {
            const reached = await runSpentLadder(role, make);
            assert.strictEqual(reached.outcome.inconclusive, null, 'A failure that reached the pass is not inconclusive.');
            assert.strictEqual(reached.outcome.value.passed, false, 'It is a real, reportable failed pass.');
        }
    });

    // --- the regression phase's CATCH-ALL variance --------------------------
    test('regression: the catch-all is degrade DATA -- each recognition field changes what escapes the phase', async () => {
        const role = 'regression-test-runner';
        const d = ROLE_POLICIES[role].degrade;
        assert.strictEqual(d.kind, 'catch-all', 'The regression phase is the table\'s one catch-all.');

        // As shipped: an entirely unrecognised error class still degrades to a
        // reportable summary rather than aborting an informational phase.
        const real = await runSpentLadder(role, () => new TypeError('not a dispatch failure at all'));
        assert.strictEqual(real.thrown, null, 'A catch-all never lets an informational phase abort the sprint.');
        assert.strictEqual(real.outcome.value.passed, false);
        assert.strictEqual(
            real.outcome.value.summary,
            d.noteTemplates.unknown.replace('{message}', 'not a dispatch failure at all'),
            'The unrecognised class has its OWN summary template, not the shared dispatch one.'
        );

        // ONE field: stop recognising the class. The phase still swallows the
        // error (rethrowsUnrecognisedErrors is false on this row), but it can
        // no longer say anything about it.
        const unrecognised = await runSpentLadder(
            role,
            () => new TypeError('not a dispatch failure at all'),
            spliceDegrade(role, { classifiesUnrecognisedErrors: false })
        );
        assert.strictEqual(unrecognised.thrown, null);
        assert.strictEqual(
            unrecognised.outcome.value,
            null,
            'An unrecognised class fabricates nothing -- the catch-all summary is what classifiesUnrecognisedErrors buys.'
        );

        // Both recognition fields off: the error propagates, which is what
        // EVERY other role in the table does with it. The catch-all is a
        // property of these two fields and nothing else.
        const propagates = await runSpentLadder(
            role,
            () => new TypeError('not a dispatch failure at all'),
            spliceDegrade(role, { classifiesUnrecognisedErrors: false, rethrowsUnrecognisedErrors: true })
        );
        assert.ok(propagates.thrown instanceof TypeError, 'With the catch-all fields off, the phase aborts like any other.');

        // ONE field: the sync class. A git/beads sync failure around the
        // dispatch is told apart from the dispatch failing ONLY because
        // classifiesSyncFailures says so.
        const realSync = await runSpentLadder(role, () => gitSyncError());
        assert.strictEqual(
            realSync.outcome.value.summary,
            d.noteTemplates.sync.replace('{name}', 'GitSyncError').replace('{message}', realSync.outcome.error.message),
            'A sync failure is reported through its own template, naming the layer that failed.'
        );
        const noSync = await runSpentLadder(role, () => gitSyncError(), spliceDegrade(role, { classifiesSyncFailures: false }));
        assert.ok(
            noSync.outcome.value.summary.startsWith(d.noteTemplates.unknown.split('{')[0]),
            'Without classifiesSyncFailures the same error falls through to the unrecognised class instead.'
        );

        // ONE field: the RUN-level control signals that must escape even a
        // catch-all. Emptying the list is what stops them escaping.
        for (const make of [cancelledError, budgetError]) {
            const swallowed = await runSpentLadder(role, make, spliceDegrade(role, { rethrowsRunControlSignals: [] }));
            assert.strictEqual(
                swallowed.thrown,
                null,
                'rethrowsRunControlSignals is the ONLY reason a cancellation escapes the catch-all.'
            );
        }
    });

    // --- the streak-assignment semantic-repair re-ask -----------------------
    test('streak assignment: its bounded semantic-repair re-ask survives on top of agent()\'s own schema-repair loop', async () => {
        const role = 'streak-assignment';
        const p = policyFor(role);
        const opts = { ...ROLE_CALL_OPTS[role], validate: streakValidate };
        assert.strictEqual(p.retry.semanticRepairReAsks, 1, 'Exactly ONE re-ask: guarded, never looped.');

        // A schema-VALID but semantically rejected candidate is re-asked once,
        // with the validation failure, and the second answer is what stands.
        const once = createRecordingCtx({ responses: [REJECTED_CANDIDATE, ACCEPTED_CANDIDATE] });
        const healed = await dispatchRole(once.ctx, role, opts);
        assert.strictEqual(once.rec.dispatches.length, 2, 'The re-ask is a real second dispatch, not a log line.');
        assert.strictEqual(healed.validation.usedFallback, false, 'The re-asked answer is accepted.');

        // BOUNDED: a candidate that is rejected twice is NOT re-asked again --
        // it drops to the caller's deterministic fallback instead of looping.
        const bounded = createRecordingCtx({ responses: [REJECTED_CANDIDATE, REJECTED_CANDIDATE, ACCEPTED_CANDIDATE] });
        const fellBack = await dispatchRole(bounded.ctx, role, opts);
        assert.strictEqual(bounded.rec.dispatches.length, 2, 'The re-ask ladder is spent after one re-ask.');
        assert.strictEqual(fellBack.validation.usedFallback, true, 'Only then does the caller\'s own fallback apply.');

        // And it is a bound of its OWN, layered on top of agent()'s built-in
        // schema-repair loop rather than replacing it: the engine never
        // re-dispatches an AgentOutputError as a semantic repair, because by
        // the time one is thrown agent()'s own bounded loop is already spent.
        const schemaSpent = await runSpentLadder(role, () => schemaError());
        assert.strictEqual(
            schemaSpent.rec.dispatches.length,
            p.retry.attempts,
            'Schema repair belongs to agent(); the engine must not re-run its own loop on top of it.'
        );
    });

    // The engine must never implement schema repair itself: agent() owns that
    // bounded loop, and a second one here would double every repair budget in
    // the table while looking like one.
    test('the consolidated path neither duplicates nor bypasses agent()\'s built-in schema-repair loop', () => {
        const engine = stripComments(fs.readFileSync(path.join(FLEET_SPRINT_DIR, 'dispatch-role.mjs'), 'utf8'));
        assert.ok(
            !/schemaRepair|repairAttempts|maxRepairs/.test(engine),
            'dispatch-role.mjs must not carry a schema-repair loop of its own -- agent() already has one.'
        );
        // Every dispatch the engine makes still passes its policy's schema
        // through to agent(), so the built-in loop is never bypassed either.
        for (const role of MIGRATED_ROLES.filter((r) => ROLE_POLICIES[r].schema)) {
            assert.ok(
                SCHEMAS[ROLE_POLICIES[role].schema],
                `${role}: names a schema the engine can resolve, so agent() validates and repairs its output.`
            );
        }
    });
});
