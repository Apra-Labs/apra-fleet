import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
    ROLE_NAMES,
    ROLE_POLICIES,
    allDispatchPolicies,
    migratedRoleNames,
    policyFor,
} from '../fleet-sprint/role-policies.mjs';
import { dispatchRole } from '../fleet-sprint/dispatch-role.mjs';
import { checkModules, findInlineLadderViolations, memberExprFor } from '../fleet-sprint/inline-ladder-guard.mjs';
import { guardedModulePaths } from '../fleet-sprint/guarded-modules.mjs';
import {
    findCallSites,
    splitTopLevelArgs,
    dispatchLadderModulePaths,
    moduleSetSourceWithOffsets,
} from './helpers/dispatch-pin-scanner.mjs';
import { PLANNING_LADDERS, PLANNING_ENGINE_DISPATCHES } from './helpers/planning-ladders.mjs';
import { EXECUTION_INLINE_LADDERS, EXECUTION_ENGINE_DISPATCHES } from './helpers/execution-ladders.mjs';
import {
    createRecordingCtx,
    ROLE_CALL_OPTS,
    BINDINGS,
    splicePolicy,
    streakValidate,
    infraError,
    transportError,
    authError,
    cancelledError,
    turnExhaustionError,
    REJECTED_CANDIDATE,
    ACCEPTED_CANDIDATE,
} from './helpers/dispatch-role-harness.mjs';

// =============================================================================
// PHASE 3 COMPLETENESS GATE -- prove the dispatchRole engine is a faithful,
// DATA-DRIVEN replacement for the hand-written per-role ladders, not a lossy
// rewrite and not a pass-through wrapper around ladders that still live in
// runner.js.
//
// Its four sibling gates each answer a narrower question, and this file
// deliberately does not restate their assertions:
//   planning-role-dispatch-pins.test.mjs / execution-role-dispatch-pins.test.mjs
//                                 -- per-dispatch behaviour pins
//   role-policies-table.test.mjs  -- every policy FIELD is re-derived from real
//                                    executed source
//   inline-ladder-guard.test.mjs  -- the guard itself discriminates correctly
// What THIS file adds is the phase-level question none of them asks: is the set
// of migrated roles complete, is every pinned fact still covered by SOMETHING
// after the pins were re-anchored, and is each named per-role variance really
// policy DATA rather than a branch in the engine that happens to agree with the
// table?
//
// THE ONE OUTCOME THAT MUST BE IMPOSSIBLE HERE IS A VACUOUS PASS. Three known
// vacuity modes are guarded explicitly:
//   - inline-ladder-guard.mjs's checkModules() defaults migratedRoles to
//     migratedRoleNames(), and findInlineLadderViolations() returns [] IMMEDIATELY
//     when that list is empty. A guard run over an empty (or silently shrunken)
//     role set therefore reports zero violations while proving nothing, so
//     section (1) discovers the set at run time and refuses an empty or short one.
//   - a re-anchored pin whose census list went empty iterates nothing, so
//     section (2) audits the per-pin inventory as a BIJECTION against the real
//     dispatch table rather than trusting either list's length.
//   - a nested `node --test` child that silently no-ops (see section (7)) exits
//     0 with no tests run, so every nested run below is checked for a non-zero
//     pass count as well as a zero fail count.
//
// COUNTS ARE DISCOVERED, NEVER TYPED. The role set comes from
// migratedRoleNames(), the dispatch set from allDispatchPolicies(); an
// assertion written against a literal role count would leave a role unverified
// while still reporting this gate green. (The tree this landed against has
// THIRTEEN migrated roles and TWENTY-TWO dispatches, and runner.js has only
// twelve dispatchRole() call sites because doer-resume is the same frozen
// object as ROLE_POLICIES.doer.secondary and is reached through the doer path,
// never dispatched by name -- section (6) asserts exactly that relationship
// rather than any of those three numbers.)
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SE_DIR = path.join(__dirname, '..');
const REPO_ROOT = path.join(SE_DIR, '../..');
const FLEET_SPRINT_DIR = path.join(SE_DIR, 'fleet-sprint');
const RUNNER_SRC = fs.readFileSync(path.join(FLEET_SPRINT_DIR, 'runner.js'), 'utf8');
const DISPATCH_ROLE_SRC = fs.readFileSync(path.join(FLEET_SPRINT_DIR, 'dispatch-role.mjs'), 'utf8');
const GOLDEN_FIXTURE_REL = 'packages/apra-fleet-se/test/fixtures/golden-transcript';

/**
 * A deep snapshot of the REAL frozen table, taken at module load. Section (8)
 * compares it again at the end: every mutation below runs against a SPLICED
 * COPY handed to the engine as ctx.policies, and a test that reached into the
 * real table instead would change production behaviour for every other file in
 * the same suite process.
 */
const REAL_TABLE_SNAPSHOT = JSON.stringify(ROLE_POLICIES);

// -----------------------------------------------------------------------------
// Shared helpers.
// -----------------------------------------------------------------------------

/**
 * The (role, kind) pair `driveEngineDispatch`-style drivers need in order to
 * make THIS dispatch actually happen, discovered from the table by object
 * IDENTITY rather than from a hand-written map.
 *
 * The secondary owner is looked up FIRST and that ordering is load-bearing:
 * doer-resume is registered as a role in its own right AND is the very same
 * frozen object as ROLE_POLICIES.doer.secondary, so a main-first lookup would
 * try to drive it by name -- which the engine cannot do, because the resume is
 * only reachable through the doer's turn-exhaustion path.
 */
function driverFor(dispatch) {
    for (const name of ROLE_NAMES) {
        if (ROLE_POLICIES[name].secondary === dispatch) return { role: name, kind: dispatch.kind };
    }
    for (const name of ROLE_NAMES) {
        if (ROLE_POLICIES[name] === dispatch) return { role: name, kind: 'main' };
    }
    throw new Error(`no driver for dispatch '${dispatch.role}' (kind=${dispatch.kind}) -- it is unreachable from any role row.`);
}

/** The per-call opts a role's dispatch needs, plus the validator its policy names. */
function callOptsFor(role, over = {}) {
    const opts = { bindings: BINDINGS, ...(ROLE_CALL_OPTS[role] || {}), ...over };
    if (ROLE_POLICIES[role] && ROLE_POLICIES[role].postResult.includes('select-streaks-validate') && !opts.validate) {
        opts.validate = streakValidate;
    }
    return opts;
}

/**
 * Runs the REAL engine and returns everything observable about the run --
 * including a thrown error, which for several variances below IS the
 * observation (a catch-all that stops swallowing, a missing policy row).
 */
async function observe(role, { policies, responses = [], healed = false, steps, opts: over } = {}) {
    const { ctx, rec } = createRecordingCtx({
        responses,
        healed,
        ...(policies ? { policies } : {}),
        ...(steps ? { steps } : {}),
    });
    let outcome = null;
    let thrown = null;
    try {
        outcome = await dispatchRole(ctx, role, callOptsFor(role, over || {}));
    } catch (err) {
        thrown = err;
    }
    return { ctx, rec, outcome, thrown };
}

/**
 * Drives EVERY dispatch the table describes, once, and returns the recorded
 * agent() call for each keyed by `role/kind`. Several sections below are
 * whole-table censuses (sprint_id, bracket membership, watchdog arming, push
 * flags) and all of them read this one map, so a dispatch that cannot be driven
 * at all fails once here rather than being quietly skipped by each census.
 */
async function driveEveryDispatch() {
    const byKey = new Map();
    for (const dispatch of allDispatchPolicies()) {
        const { role, kind } = driverFor(dispatch);
        let responses = [];
        if (kind === 'max-turns-resume') responses = [turnExhaustionError()];
        else if (kind === 'semantic-repair-re-ask') responses = [REJECTED_CANDIDATE, ACCEPTED_CANDIDATE];
        const { ctx, rec } = await observe(role, { responses });
        const recorded = rec.dispatches[kind === 'main' ? 0 : 1];
        assert.ok(
            recorded,
            `dispatch '${dispatch.role}' (kind=${dispatch.kind}) never happened when the engine was driven as ` +
            `${role}/${kind} -- it made ${rec.dispatches.length} dispatch(es). A dispatch the engine cannot be made ` +
            'to perform is one no census below can cover.'
        );
        byKey.set(`${dispatch.role}/${dispatch.kind}`, { dispatch, recorded, ctx, rec, steps: rec.steps });
    }
    return byKey;
}

/**
 * The eight per-role variances this phase claimed were expressible as policy
 * DATA. Each is only allowed to count as proven once a test has mutated a real
 * field of the real row and observed the behaviour follow; the meta-test at the
 * end of section (3) fails if any is left unproven, so deleting or renaming one
 * of the variance tests cannot quietly shrink this gate.
 */
const NAMED_VARIANCES = Object.freeze([
    'integ INCONCLUSIVE',
    'regression catch-all',
    'final-review heal short-circuit',
    'watchdog-only-planner',
    'deployer sprintSelfId',
    'streak assignment outside any git-sync bracket',
    'the pushCode:true set',
    'final review resolves to the reviewer role member',
]);

/** variance name -> the `role: field.path` mutations that proved it. */
const PROVEN_FIELD_DRIVEN = new Map();

/** Reads `fieldPath` out of the REAL frozen row, asserting every segment exists. */
function realFieldAt(role, fieldPath) {
    let node = ROLE_POLICIES[role];
    for (const key of fieldPath.split('.')) {
        assert.ok(
            node !== null && typeof node === 'object' && key in node,
            `'${role}' has no policy field '${fieldPath}' -- a variance cannot be proven table-driven by mutating a ` +
            'field the real table does not have.'
        );
        node = node[key];
    }
    return node;
}

/**
 * Records that `variance` was proven driven by `role`'s `fieldPath`. The field
 * path is resolved against the REAL row first, so a variance "proven" by
 * splicing a field name that does not exist (a splice the engine would simply
 * ignore, making the mutated run identical to the baseline for the wrong
 * reason) cannot be booked as proof.
 */
function markFieldDriven(variance, role, fieldPath) {
    assert.ok(NAMED_VARIANCES.includes(variance), `'${variance}' is not one of the named variances.`);
    realFieldAt(role, fieldPath);
    const entries = PROVEN_FIELD_DRIVEN.get(variance) || [];
    entries.push(`${role}: ${fieldPath}`);
    PROVEN_FIELD_DRIVEN.set(variance, entries);
}

// -----------------------------------------------------------------------------
// (1) The migrated-role set is DISCOVERED at run time, non-empty, and complete.
//
// Everything else in this file iterates this set. An empty or silently shrunken
// set would make those loops report success while covering nothing, so it is
// checked against three independent sources before anything else runs: the
// table's own `migrated` flags, the ROLE_NAMES key list, and the pin censuses.
// -----------------------------------------------------------------------------
describe('(1) the migrated-role set is discovered, non-empty and complete', () => {
    test('migratedRoleNames() is non-empty and is exactly the rows marked migrated', () => {
        const discovered = migratedRoleNames();
        assert.ok(
            discovered.length > 0,
            'migratedRoleNames() returned NOTHING. Every check in this file iterates it, and inline-ladder-guard.mjs ' +
            "returns zero violations immediately for an empty set -- an empty set is a failure of the check itself, " +
            'never a satisfied gate.'
        );
        assert.deepStrictEqual(
            discovered,
            ROLE_NAMES.filter((name) => ROLE_POLICIES[name].migrated === true),
            'migratedRoleNames() must return exactly the rows whose own `migrated` flag is true, in table order.'
        );
    });

    test('every role in the table is migrated -- the phase left none behind', () => {
        const notMigrated = ROLE_NAMES.filter((name) => ROLE_POLICIES[name].migrated !== true);
        assert.deepStrictEqual(
            notMigrated,
            [],
            `these roles still carry a hand-written inline ladder: ${notMigrated.join(', ')}. This gate certifies the ` +
            'WHOLE phase, so a role left un-migrated is a failure here even though every other gate stays green ' +
            '(each of them derives that role from runner.js source instead, which still passes).'
        );
        assert.strictEqual(
            migratedRoleNames().length,
            ROLE_NAMES.length,
            'the discovered set must cover every ROLE_NAMES entry.'
        );
    });

    test('the discovered set is not SHORT: it covers every role the two pin censuses name', () => {
        // An independent source for the same set. The pin censuses are written
        // per DISPATCH, so a role that vanished from the policy table but is
        // still pinned (or vice versa) shows up here rather than as a loop that
        // silently iterates one role fewer.
        const pinnedRoles = new Set(
            [...PLANNING_ENGINE_DISPATCHES, ...EXECUTION_ENGINE_DISPATCHES].map((pin) => pin.role)
        );
        const discovered = new Set(migratedRoleNames());
        assert.deepStrictEqual(
            [...pinnedRoles].filter((role) => !discovered.has(role)).sort(),
            [],
            'a role is pinned on the engine side but is not in the discovered migrated set.'
        );
        assert.deepStrictEqual(
            [...discovered].filter((role) => !pinnedRoles.has(role)).sort(),
            [],
            'a role is marked migrated but no engine-side pin covers it -- the pin census shrank without the table ' +
            'shrinking with it.'
        );
    });

    test('falsification: the guard really does pass vacuously over an empty set, which is why the checks above exist', () => {
        // Proves the vacuity mode is REAL rather than a hypothetical the
        // assertions above are defending against for no reason: the same
        // seeded source that yields a violation for a discovered role yields
        // NOTHING once the role set is empty.
        const role = migratedRoleNames()[0];
        const expr = memberExprFor(ROLE_POLICIES[role].member);
        assert.ok(expr, `fixture setup: role '${role}' has no resolvable member expression.`);
        const seeded = [
            'export async function survivingLadder(agent) {',
            "    await agent('prompt text', {",
            `        member_name: ${expr},`,
            `        // ${ROLE_POLICIES[role].ladderAnchor}`,
            '    });',
            '}',
        ].join('\n');
        assert.strictEqual(
            findInlineLadderViolations(seeded, 'seeded.mjs', [role], ROLE_POLICIES).length,
            1,
            'the seeded inline ladder must be flagged when the role set contains its role.'
        );
        assert.deepStrictEqual(
            findInlineLadderViolations(seeded, 'seeded.mjs', [], ROLE_POLICIES),
            [],
            'the SAME seeded ladder must go unreported over an empty role set -- this is the vacuous pass that makes ' +
            'a shrunken migratedRoleNames() dangerous, and the reason it is asserted non-empty above.'
        );
    });
});

// -----------------------------------------------------------------------------
// (2) The behaviour pins still pass, and the per-pin inventory dropped nothing.
//
// Both pin FILES were deliberately re-anchored off runner.js and onto
// dispatch-role.mjs + role-policies.mjs by the two migration beads: the pin
// scanner is textual and asserted one call site per anchor, so a genuine
// migration necessarily deletes the text the old pins matched. Their text
// differing from the pre-migration version is therefore expected and is NOT a
// defect. What must hold is that every pinned FACT is still covered by
// something, which is what this section audits.
// -----------------------------------------------------------------------------
describe('(2) the per-pin inventory: no pinned fact was dropped, weakened or made vacuous', () => {
    test('no ladder is pinned against inline runner.js source any more, on either side', () => {
        assert.deepStrictEqual(
            PLANNING_LADDERS.filter((pin) => pin.mode === 'inline').map((pin) => pin.name),
            [],
            'a planning ladder has an inline runner.js call site again.'
        );
        assert.deepStrictEqual(
            EXECUTION_INLINE_LADDERS.map((pin) => pin.name),
            [],
            'an execution ladder has an inline runner.js call site again.'
        );
    });

    test('the engine-side pin census is a BIJECTION with the real dispatch table', () => {
        // The strongest form of "nothing was dropped": not a count, but a
        // two-way cover. A pin deleted during re-anchoring shows up as a
        // dispatch with no pin; a pin left behind for a dispatch that no longer
        // exists shows up as a pin with no dispatch. Neither can hide behind a
        // list length that happens to still match.
        const pinKeys = [...PLANNING_ENGINE_DISPATCHES, ...EXECUTION_ENGINE_DISPATCHES]
            .map((pin) => `${pin.role}/${pin.kind}`);
        const dispatchKeys = allDispatchPolicies().map((d) => `${d.role}/${d.kind}`);
        assert.strictEqual(
            new Set(pinKeys).size,
            pinKeys.length,
            `two pins claim the same dispatch: ${pinKeys.join(', ')}`
        );
        assert.deepStrictEqual(
            pinKeys.filter((key) => !dispatchKeys.includes(key)).sort(),
            [],
            'a pin covers a dispatch the policy table no longer describes.'
        );
        assert.deepStrictEqual(
            dispatchKeys.filter((key) => !pinKeys.includes(key)).sort(),
            [],
            'a real dispatch has NO engine-side pin -- its pre-migration assertions were dropped rather than ' +
            're-anchored.'
        );
    });

    test('no engine-side pin was WEAKENED by dropping a field the textual pins used to assert', () => {
        // Each of these keys stands for one pre-migration textual assertion
        // (see the per-pin inventory tables in both pin files). A pin entry
        // missing one of them turns that file's `assert.strictEqual(o.x ?? null,
        // pin.x)` into `undefined ?? null === undefined` -- a tautology that
        // passes for every dispatch. Presence is checked with `in`, not
        // truthiness: `null` is a meaningful pinned value (no watchdog, no
        // schema, no resume) and must not be confused with an absent key.
        const REQUIRED_PIN_KEYS = [
            'role', 'kind', 'name', 'agentType', 'modelTier', 'maxTurns', 'timeoutS', 'maxTotalS',
            'bracketed', 'pushCode', 'pushBeads', 'watchdog', 'watchdogLabel', 'schema', 'resume',
        ];
        const problems = [];
        for (const pin of [...PLANNING_ENGINE_DISPATCHES, ...EXECUTION_ENGINE_DISPATCHES]) {
            for (const key of REQUIRED_PIN_KEYS) {
                if (!(key in pin)) problems.push(`${pin.name || pin.role}: missing '${key}'`);
            }
            // Member routing is pinned as EITHER a role member or a
            // runner-local binding; a pin with neither would compare an
            // undefined expectation against an undefined observation.
            const hasMember = (pin.memberRole !== undefined && pin.memberRole !== null)
                || (pin.memberBinding !== undefined && pin.memberBinding !== null);
            if (!hasMember) problems.push(`${pin.name || pin.role}: pins neither memberRole nor memberBinding`);
            // A bracketed pin must state both push flags as real booleans; an
            // unbracketed one must state neither.
            if (pin.bracketed === true) {
                if (typeof pin.pushCode !== 'boolean') problems.push(`${pin.name}: bracketed but pushCode is not a boolean`);
                if (typeof pin.pushBeads !== 'boolean') problems.push(`${pin.name}: bracketed but pushBeads is not a boolean`);
            }
            // A watchdog pin must name the label it arms with, or assert none.
            if (pin.watchdog === true && typeof pin.watchdogLabel !== 'string') {
                problems.push(`${pin.name}: arms a watchdog but pins no label`);
            }
        }
        assert.deepStrictEqual(problems, [], `weakened pin entries:\n${problems.join('\n')}`);
    });

    test('the pinned expectations still DISCRIMINATE -- they are not all the same value', () => {
        // A subtler weakening than a dropped key: every pin re-anchored to the
        // same placeholder would keep all the keys and still assert nothing
        // role-specific. Each axis below is one the ladders genuinely differ on.
        const pins = [...PLANNING_ENGINE_DISPATCHES, ...EXECUTION_ENGINE_DISPATCHES];
        const distinct = (key) => new Set(pins.map((pin) => JSON.stringify(pin[key]))).size;
        for (const [key, floor] of [['agentType', 3], ['modelTier', 2], ['schema', 3], ['bracketed', 2], ['watchdog', 2], ['pushCode', 2]]) {
            assert.ok(
                distinct(key) >= floor,
                `every pin now records the SAME '${key}' (${distinct(key)} distinct value(s), expected at least ` +
                `${floor}) -- the pins stopped discriminating between the ladders they exist to tell apart.`
            );
        }
    });

    test('both behaviour-pin suites pass against the post-refactor tree', () => {
        const out = runNestedSuite('dispatch-behaviour-pins', [
            '--test',
            'test/planning-role-dispatch-pins.test.mjs',
            'test/execution-role-dispatch-pins.test.mjs',
        ]);
        assertNestedSuiteReallyRan('dispatch-behaviour-pins', out, PLANNING_ENGINE_DISPATCHES.length + EXECUTION_ENGINE_DISPATCHES.length);
    });
});

// -----------------------------------------------------------------------------
// (3) Every named per-role variance is POLICY DATA, not an engine branch.
//
// The shape every test in this section shares: run the engine against the REAL
// frozen row, run it again against a copy with ONE field spliced, and require
// the observation to change accordingly. Reading the field and asserting it
// equals what the engine does would prove nothing -- an engine branch that
// happens to agree with the table reads identically. Only the mutation
// distinguishes the two.
//
// ctx.policies is the seam that makes this possible: dispatchRole resolves its
// row through it when supplied, so the real ROLE_POLICIES stays frozen and
// untouched (asserted in section (8)).
// -----------------------------------------------------------------------------
describe('(3) the named per-role variances are driven by role-policies.mjs fields', () => {
    test('integ INCONCLUSIVE: an envelope-less infra failure records "no evidence", never a false passed:false', async () => {
        const ROLE = 'integ-test-runner';
        const row = policyFor(ROLE);

        // BASELINE: the real row. degrade.classes lists schema and dispatch but
        // deliberately NOT infra, and degrade.classifiesInfraFailures tells the
        // classifier to separate an envelope-less dispatch from an ordinary one.
        const baseline = await observe(ROLE, { responses: [infraError(), infraError()] });
        assert.strictEqual(baseline.thrown, null, 'an infra failure must not abort the sprint.');
        assert.strictEqual(baseline.outcome.ok, false);
        assert.ok(
            baseline.outcome.inconclusive,
            'the integ ladder must report INCONCLUSIVE when its terminal failure produced no result envelope.'
        );
        assert.strictEqual(baseline.outcome.inconclusive.reason, 'empty_response');
        assert.strictEqual(
            baseline.outcome.value,
            null,
            'nothing is fabricated for the infra class -- a fabricated passed:false would be recorded as a real ' +
            'test failure the run never actually observed.'
        );

        // MUTATION A: stop classifying infra failures. The very same error is
        // now an ordinary dispatch failure, which the row DOES fabricate for.
        const notClassified = await observe(ROLE, {
            responses: [infraError(), infraError()],
            policies: splicePolicy(ROLE, { degrade: { ...row.degrade, classifiesInfraFailures: false } }),
        });
        assert.strictEqual(
            notClassified.outcome.inconclusive,
            null,
            'degrade.classifiesInfraFailures=false must stop the INCONCLUSIVE record -- if it did not, the record is ' +
            'coming from a branch in the engine rather than from the table.'
        );
        assert.ok(
            notClassified.outcome.value && notClassified.outcome.value.passed === false,
            'and the same failure now degrades to the fabricated passed:false report the INCONCLUSIVE path exists to avoid.'
        );
        markFieldDriven('integ INCONCLUSIVE', ROLE, 'degrade.classifiesInfraFailures');

        // MUTATION B: keep the classification, change the degrade KIND. The
        // "no verdict, and here is why" record is a property of the kind.
        const otherKind = await observe(ROLE, {
            responses: [infraError(), infraError()],
            policies: splicePolicy(ROLE, { degrade: { ...row.degrade, kind: 'synthesized-report' } }),
        });
        assert.strictEqual(
            otherKind.outcome.inconclusive,
            null,
            "degrade.kind must decide whether an 'inconclusive' record is produced at all."
        );
        markFieldDriven('integ INCONCLUSIVE', ROLE, 'degrade.kind');

        // ...and the variance is not merely reachable, it is the SHIPPED row.
        assert.strictEqual(row.degrade.kind, 'inconclusive');
        assert.strictEqual(row.degrade.classifiesInfraFailures, true);
        assert.ok(!row.degrade.classes.includes('infra'), 'the shipped row must not fabricate a verdict for infra.');
    });

    test('regression catch-all: an unrecognised error is swallowed, but a run-control signal is not', async () => {
        const ROLE = 'regression-test-runner';
        const row = policyFor(ROLE);

        // BASELINE: a plain Error is a class no other ladder recognises. The
        // regression phase is informational, so it degrades rather than aborting.
        const baseline = await observe(ROLE, { responses: [new Error('a totally unexpected boom')] });
        assert.strictEqual(baseline.thrown, null, 'the regression phase must never abort the sprint.');
        assert.strictEqual(baseline.outcome.ok, false);
        assert.ok(
            baseline.outcome.value && baseline.outcome.value.passed === false,
            'the catch-all still produces a report saying the pass did not happen.'
        );
        assert.match(
            String(baseline.outcome.value.summary),
            /unexpected error/,
            "the 'unknown' class has its own degrade note -- a generic one would hide which class was reached."
        );

        // MUTATION: stop recognising the unrecognised class and let it propagate.
        const propagates = await observe(ROLE, {
            responses: [new Error('a totally unexpected boom')],
            policies: splicePolicy(ROLE, {
                degrade: { ...row.degrade, classifiesUnrecognisedErrors: false, rethrowsUnrecognisedErrors: true },
            }),
        });
        assert.ok(
            propagates.thrown && /a totally unexpected boom/.test(propagates.thrown.message),
            'degrade.classifiesUnrecognisedErrors / rethrowsUnrecognisedErrors must decide whether the catch-all ' +
            'catches -- if the error is swallowed either way, the catch-all is an engine branch.'
        );
        markFieldDriven('regression catch-all', ROLE, 'degrade.classifiesUnrecognisedErrors');
        markFieldDriven('regression catch-all', ROLE, 'degrade.rethrowsUnrecognisedErrors');

        // The carve-out inside the catch-all is table data too: a cancellation
        // outranks finishing an informational phase.
        const cancelled = await observe(ROLE, { responses: [cancelledError()] });
        assert.ok(
            cancelled.thrown && /run cancelled/.test(cancelled.thrown.message),
            'a run-level control signal must keep propagating THROUGH the catch-all.'
        );
        const swallowed = await observe(ROLE, {
            responses: [cancelledError()],
            policies: splicePolicy(ROLE, { degrade: { ...row.degrade, rethrowsRunControlSignals: [] } }),
        });
        assert.strictEqual(
            swallowed.thrown,
            null,
            'degrade.rethrowsRunControlSignals must be what preserves the carve-out.'
        );
        markFieldDriven('regression catch-all', ROLE, 'degrade.rethrowsRunControlSignals');
        assert.deepStrictEqual(row.degrade.rethrowsRunControlSignals, ['CancelledError', 'BudgetExceededError']);
    });

    test('final-review heal short-circuit: a healed retry is the ladder\'s last word', async () => {
        const ROLE = 'final-review';
        const row = policyFor(ROLE);

        // BASELINE, on the shipped row: one heal, one retry, and the healed
        // verdict is what the caller gets.
        const healed = await observe(ROLE, { responses: [authError(), 'HEALED VERDICT'], healed: true });
        assert.strictEqual(healed.rec.authHeals.length, 1, 'exactly one bounded LLM-auth self-heal.');
        assert.strictEqual(healed.rec.dispatches.length, 2, 'the heal is followed by exactly one retry.');
        assert.strictEqual(healed.outcome.value, 'HEALED VERDICT');

        // At the SHIPPED budget of two attempts the healed retry and the generic
        // retry coincide, so the field is spliced to a budget with room to tell
        // them apart -- attempts=3 on BOTH arms, with only the short-circuit
        // flag differing. That difference is the whole observation.
        const dispatchesFor = async (shortCircuits) => {
            const { rec } = await observe(ROLE, {
                responses: [authError(), transportError(), transportError()],
                healed: true,
                policies: splicePolicy(ROLE, {
                    retry: { ...row.retry, attempts: 3, authSelfHealShortCircuits: shortCircuits },
                }),
            });
            return rec.dispatches.length;
        };
        assert.strictEqual(await dispatchesFor(true), 2, 'a healed Final Review must not fall through to the generic retry.');
        assert.strictEqual(
            await dispatchesFor(false),
            3,
            'retry.authSelfHealShortCircuits=false must let a SECOND full Final Review fire -- if both settings ' +
            'behave alike the short-circuit is hard-coded, and the sprint\'s PASS/FAIL gate could silently discard ' +
            'a healed verdict.'
        );
        markFieldDriven('final-review heal short-circuit', ROLE, 'retry.authSelfHealShortCircuits');
        assert.strictEqual(row.retry.authSelfHealShortCircuits, true, 'the shipped row short-circuits.');
    });
});

describe('(3) the named per-role variances are driven by role-policies.mjs fields (continued)', () => {
    test('watchdog-only-planner: the client-side watchdog is armed for the planner-persona dispatches alone', async () => {
        const driven = await driveEveryDispatch();
        const armedInPractice = [];
        for (const [key, { dispatch, recorded }] of driven) {
            const shouldArm = dispatch.watchdog.armed === true;
            assert.strictEqual(
                recorded.watchdog !== null,
                shouldArm,
                `${key}: watchdog.armed=${shouldArm} but the engine ${recorded.watchdog ? 'armed' : 'did not arm'} one.`
            );
            if (recorded.watchdog) armedInPractice.push(key);
        }
        assert.ok(armedInPractice.length > 0, 'no dispatch arms a watchdog at all -- the census below would be vacuous.');
        // The VARIANCE itself, derived rather than typed: every armed dispatch
        // carries the planner persona, and no non-planner dispatch arms one.
        for (const key of armedInPractice) {
            assert.strictEqual(
                driven.get(key).dispatch.agentType,
                'planner',
                `${key} arms a client-side watchdog but is not a planner-persona dispatch -- the "watchdog only for ` +
                'the planner" variance has drifted.'
            );
        }

        // MUTATION, both directions: arm a role that has none, and disarm one
        // that does.
        const ARM_ONTO = 'harvester';
        const harvesterRow = policyFor(ARM_ONTO);
        const armed = await observe(ARM_ONTO, {
            policies: splicePolicy(ARM_ONTO, {
                watchdog: {
                    armed: true,
                    timeoutS: 'DISPATCH_TIMEOUT_S',
                    member: 'dispatch',
                    label: ['SPLICED HARVEST WATCHDOG'],
                },
            }),
        });
        assert.ok(
            armed.rec.dispatches[0].watchdog,
            'watchdog.armed=true must arm a watchdog for a role whose shipped row has none.'
        );
        assert.strictEqual(armed.rec.dispatches[0].watchdog.label, 'SPLICED HARVEST WATCHDOG');
        assert.strictEqual(
            armed.rec.dispatches[0].watchdog.timeoutS,
            armed.ctx.budgets.DISPATCH_TIMEOUT_S,
            'and the watchdog resolves the SYMBOLIC budget the row names, rather than a hard-coded number.'
        );
        assert.strictEqual(harvesterRow.watchdog.armed, false, 'the shipped harvester row arms none.');

        const PLANNER = 'planner';
        const disarmed = await observe(PLANNER, {
            policies: splicePolicy(PLANNER, { watchdog: { armed: false, timeoutS: null, member: null, label: null } }),
        });
        assert.strictEqual(
            disarmed.rec.dispatches[0].watchdog,
            null,
            'watchdog.armed=false must disarm the planner watchdog -- if it stays armed the arming is a branch in ' +
            'the engine, not a policy field.'
        );
        markFieldDriven('watchdog-only-planner', PLANNER, 'watchdog.armed');
        markFieldDriven('watchdog-only-planner', ARM_ONTO, 'watchdog.armed');
    });

    test('deployer sprintSelfId: the pre-dispatch prompt invariant runs for the deployer and nobody else', async () => {
        const ROLE = 'deployer';
        const STEP = 'sprint-self-id-in-prompt';
        const SELF_ID = 'sprint-self-id-sentinel';
        // A recording hook that behaves like the runner's real one: the deploy
        // runbook's active-sprints gate self-blocks unless the prompt states
        // this sprint's OWN reservation id, so the step VERIFIES that rather
        // than trusting it.
        const steps = {
            [STEP]: ({ opts }) => {
                if (typeof opts.prompt === 'string' && opts.prompt.includes(SELF_ID)) return undefined;
                throw new Error('PROMPT-MISSING-SELF-ID');
            },
        };

        // BASELINE, prompt satisfying the invariant: the step runs, then the
        // dispatch happens.
        const ok = await observe(ROLE, { steps, opts: { prompt: `DEPLOYER PROMPT (active sprint: ${SELF_ID})` } });
        assert.strictEqual(ok.thrown, null);
        assert.deepStrictEqual(ok.rec.steps.map((s) => s.step), [STEP], 'the deployer runs exactly its one pre-dispatch step.');
        assert.strictEqual(ok.rec.dispatches.length, 1);

        // BASELINE, prompt violating it: the dispatch never happens at all.
        const blocked = await observe(ROLE, { steps, opts: { prompt: 'DEPLOYER PROMPT with no reservation id' } });
        assert.ok(
            blocked.thrown && /PROMPT-MISSING-SELF-ID/.test(blocked.thrown.message),
            'a deploy prompt missing the sprint self-id must fail loudly.'
        );
        assert.strictEqual(
            blocked.rec.dispatches.length,
            0,
            'and it must fail BEFORE the dispatch -- a gate that only complains afterwards has already paid for the turn.'
        );

        // MUTATION: drop the step from the row. The identical prompt now
        // dispatches, which is only possible if the invariant was table data.
        const withoutStep = await observe(ROLE, {
            steps,
            opts: { prompt: 'DEPLOYER PROMPT with no reservation id' },
            policies: splicePolicy(ROLE, { preDispatch: [] }),
        });
        assert.strictEqual(withoutStep.thrown, null, 'removing the step from the row must remove the invariant.');
        assert.strictEqual(withoutStep.rec.dispatches.length, 1);
        assert.deepStrictEqual(withoutStep.rec.steps.map((s) => s.step), []);

        // MUTATION, the other direction: the same step imposed on a role that
        // does not record it today.
        const imposed = await observe('harvester', {
            steps,
            opts: { prompt: 'HARVESTER PROMPT with no reservation id' },
            policies: splicePolicy('harvester', { preDispatch: [STEP] }),
        });
        assert.ok(
            imposed.thrown && /PROMPT-MISSING-SELF-ID/.test(imposed.thrown.message),
            'the step is not deployer-specific engine code -- any row that names it gets it.'
        );
        markFieldDriven('deployer sprintSelfId', ROLE, 'preDispatch');

        // ...and no OTHER dispatch in the table records it.
        const recordedBy = allDispatchPolicies()
            .filter((d) => d.preDispatch.includes(STEP))
            .map((d) => `${d.role}/${d.kind}`);
        assert.deepStrictEqual(
            recordedBy,
            ['deployer/main'],
            `only the deployer's main dispatch may carry the sprint-self-id invariant; found: ${recordedBy.join(', ')}`
        );
    });

    test('streak assignment runs OUTSIDE any git-sync bracket, and that is a bracket.wrapped field', async () => {
        const driven = await driveEveryDispatch();
        const unbracketed = [];
        for (const [key, { dispatch, recorded }] of driven) {
            assert.strictEqual(
                recorded.bracket !== null,
                dispatch.bracket.wrapped === true,
                `${key}: bracket.wrapped=${dispatch.bracket.wrapped} but the engine ${recorded.bracket ? 'opened' : 'skipped'} a bracket.`
            );
            if (!recorded.bracket) unbracketed.push(key);
        }
        assert.deepStrictEqual(
            unbracketed.sort(),
            ['streak-assignment/main', 'streak-assignment/semantic-repair-re-ask'],
            'streak assignment is the ONLY pure-compute dispatch, so it is the only one that may run outside the ' +
            'shared sync bracket. Anything else running unbracketed is dispatching against unsynced state.'
        );

        // MUTATION, both directions.
        const ROLE = 'streak-assignment';
        const wrapped = await observe(ROLE, {
            policies: splicePolicy(ROLE, { bracket: { wrapped: true, pushCode: false, pushBeads: false } }),
        });
        assert.ok(
            wrapped.rec.dispatches[0].bracket,
            'bracket.wrapped=true must open a bracket around the streak-assignment dispatch.'
        );
        const HARVESTER = 'harvester';
        const unwrapped = await observe(HARVESTER, {
            policies: splicePolicy(HARVESTER, { bracket: { wrapped: false, pushCode: null, pushBeads: null } }),
        });
        assert.strictEqual(
            unwrapped.rec.dispatches[0].bracket,
            null,
            'bracket.wrapped=false must skip the bracket -- if the harvester is bracketed either way, bracketing is ' +
            'an engine branch rather than a policy field.'
        );
        markFieldDriven('streak assignment outside any git-sync bracket', ROLE, 'bracket.wrapped');
        markFieldDriven('streak assignment outside any git-sync bracket', HARVESTER, 'bracket.wrapped');
    });

    test('the pushCode:true set is exactly the doer and harvester dispatch pairs, and it is a bracket.pushCode field', async () => {
        // CORRECTION carried forward from execution-role-dispatch-pins.test.mjs:
        // this phase's brief asserted the push-flag-true set was "exactly
        // doer-resume and harvester". It is not, and the code wins over the
        // brief -- it is FOUR dispatches: the doer's main dispatch AND its
        // resume, plus the harvester's main dispatch AND its resume. Those are
        // the four that write code and therefore G-push.
        const driven = await driveEveryDispatch();
        const pushesCodeInPractice = [];
        for (const [key, { dispatch, recorded }] of driven) {
            if (!recorded.bracket) continue;
            assert.strictEqual(
                recorded.bracket.pushCode,
                dispatch.bracket.pushCode === true,
                `${key}: the bracket must receive the push flag the row records.`
            );
            if (recorded.bracket.pushCode === true) pushesCodeInPractice.push(key);
        }
        assert.deepStrictEqual(
            pushesCodeInPractice.sort(),
            ['doer-resume/max-turns-resume', 'doer/main', 'harvester/main', 'harvester/max-turns-resume'],
            'only the code-writing dispatches may G-push. A read-only role that started pushing code would publish ' +
            'work no reviewer ever saw.'
        );

        // MUTATION: a read-side role told to push code really does.
        const ROLE = 'reviewer';
        const row = policyFor(ROLE);
        const pushing = await observe(ROLE, {
            policies: splicePolicy(ROLE, { bracket: { ...row.bracket, pushCode: true } }),
        });
        assert.strictEqual(
            pushing.rec.dispatches[0].bracket.pushCode,
            true,
            'bracket.pushCode must be what the engine hands withGitSync -- if the reviewer stays read-side after the ' +
            'splice, the push flag is hard-coded per role.'
        );
        markFieldDriven('the pushCode:true set', ROLE, 'bracket.pushCode');
        assert.strictEqual(row.bracket.pushCode, false, 'the shipped reviewer row is read-side.');
    });

    test('final review resolves to the REVIEWER role member, while the per-round reviewer takes its pool head', async () => {
        const ROLE = 'final-review';
        const baseline = await observe(ROLE);
        const reviewerMember = baseline.ctx.getMemberForRole('reviewer');
        assert.strictEqual(
            baseline.rec.dispatches[0].options.member_name,
            reviewerMember,
            'final review is dispatched to the reviewer ROLE member -- there is no separate final-review member.'
        );
        assert.notStrictEqual(
            reviewerMember,
            baseline.ctx.getMemberForRole('final-review'),
            'the two would be indistinguishable if getMemberForRole answered identically for both names, which would ' +
            'make the assertion above vacuous.'
        );

        // The other half of the same variance: the per-round reviewer resolves
        // to a runner-local pool head, which the engine cannot compute itself.
        const perRound = await observe('reviewer');
        assert.strictEqual(
            perRound.rec.dispatches[0].options.member_name,
            BINDINGS['reviewerPool[0]'],
            'the per-round reviewer routes to its pool head, not to the reviewer role member.'
        );
        assert.notStrictEqual(
            BINDINGS['reviewerPool[0]'],
            reviewerMember,
            'the two member resolutions must be distinguishable for the pin above to mean anything.'
        );

        // MUTATION: the role the member field names is what the engine resolves.
        const rerouted = await observe(ROLE, {
            policies: splicePolicy(ROLE, { member: { kind: 'role', role: 'deployer' } }),
        });
        assert.strictEqual(
            rerouted.rec.dispatches[0].options.member_name,
            rerouted.ctx.getMemberForRole('deployer'),
            'member.role must be what decides the member -- a final review pinned to the reviewer by an engine ' +
            'branch would ignore this splice.'
        );
        assert.strictEqual(
            rerouted.rec.dispatches[0].bracket.member,
            rerouted.ctx.getMemberForRole('deployer'),
            'and the bracket follows the dispatch, so a re-routed dispatch is never synced against the old member.'
        );
        markFieldDriven('final review resolves to the reviewer role member', ROLE, 'member.role');
    });

    test('every named variance above was proven by mutating a real policy field', () => {
        const unproven = NAMED_VARIANCES.filter((name) => !PROVEN_FIELD_DRIVEN.has(name));
        assert.deepStrictEqual(
            unproven,
            [],
            `these variances were never proven table-driven: ${unproven.join('; ')}. A variance nobody mutated is a ` +
            'variance that could still be a hard-coded branch, and deleting one of the tests above must fail HERE ' +
            'rather than quietly shrinking this gate.'
        );
        for (const [variance, fields] of PROVEN_FIELD_DRIVEN) {
            assert.ok(fields.length > 0, `${variance}: recorded no mutated field.`);
        }
    });
});

// -----------------------------------------------------------------------------
// (4) sprint_id and shared-bracket membership hold for EVERY role.
// -----------------------------------------------------------------------------
describe('(4) sprint_id and shared-bracket membership hold across the whole table', () => {
    test('no dispatch passes its own sprint_id -- the runner\'s agent() wrapper supplies it for all of them', async () => {
        const driven = await driveEveryDispatch();
        assert.ok(driven.size > 0, 'no dispatch was driven -- this census would be vacuous.');
        for (const [key, { recorded }] of driven) {
            assert.ok(
                !('sprint_id' in recorded.options),
                `${key} passes its own sprint_id. One wrapper covers every dispatch; a per-dispatch sprint_id is a ` +
                'second source of truth for the identity members are reserved under.'
            );
        }
        // The other half of the claim: the wrapper really does supply it, so
        // "the engine passes none" is not the same as "nobody passes one".
        // (runner-sprint-id-token-flow.test.mjs exercises the full flow; this is
        // only the anchor that keeps the two halves of the claim together.)
        assert.match(
            RUNNER_SRC,
            /agentRaw\(finalPrompt,\s*\{\s*sprint_id:/,
            "runner.js's agent() wrapper must still inject sprint_id for every dispatch that flows through it."
        );
    });

    test('every dispatch except streak assignment runs inside the shared sync bracket, on its own member', async () => {
        const driven = await driveEveryDispatch();
        const unbracketed = [];
        for (const [key, { recorded }] of driven) {
            if (!recorded.bracket) {
                unbracketed.push(key);
                continue;
            }
            assert.strictEqual(
                recorded.bracket.member,
                recorded.options.member_name,
                `${key}: the bracket must sync the SAME member the dispatch routes to, or the dispatch runs against ` +
                "another member's synced state."
            );
            assert.strictEqual(
                typeof recorded.bracket.options.pushBeads,
                'boolean',
                `${key}: a bracketed dispatch must receive a literal pushBeads flag.`
            );
        }
        assert.deepStrictEqual(
            unbracketed.sort(),
            allDispatchPolicies().filter((d) => !d.bracket.wrapped).map((d) => `${d.role}/${d.kind}`).sort(),
            'the set of unbracketed dispatches must be exactly the set the table says is unbracketed.'
        );
        assert.ok(
            unbracketed.length < driven.size,
            'if EVERY dispatch were unbracketed the membership assertion above would be vacuous.'
        );
    });
});

// -----------------------------------------------------------------------------
// (5) Falsification: a missing policy row fails LOUDLY, never silently defaults.
//
// The engine reads one row per dispatch. If a role whose row went missing fell
// back to some default row, the dispatch would still happen -- at another
// role's member, budget and degrade -- and every census above would still pass,
// because they all read the table the deletion just changed.
// -----------------------------------------------------------------------------
describe('(5) a role with no policy row fails loudly rather than falling back to a default', () => {
    for (const role of migratedRoleNames()) {
        test(`deleting '${role}' from the table makes its dispatch throw, naming the roles that do exist`, async () => {
            const table = { ...ROLE_POLICIES };
            delete table[role];
            const { ctx, rec } = createRecordingCtx({ policies: table });
            await assert.rejects(
                () => dispatchRole(ctx, role, callOptsFor(role)),
                (err) => {
                    assert.match(
                        err.message,
                        new RegExp(`no policy for role '${role.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`),
                        `the failure must name the missing role; got: ${err.message}`
                    );
                    assert.match(err.message, /known roles:/, 'and must list the roles that do exist.');
                    return true;
                }
            );
            assert.strictEqual(
                rec.dispatches.length,
                0,
                `'${role}' still dispatched with no policy row -- it fell back to a default instead of failing.`
            );
        });
    }

    test('the loop above covered every discovered role', () => {
        // Guards the loop itself: an empty migratedRoleNames() would generate no
        // per-role tests at all, and a file with no tests is a file that passes.
        assert.ok(migratedRoleNames().length > 0, 'no per-role falsification test was generated.');
        assert.strictEqual(migratedRoleNames().length, ROLE_NAMES.length);
    });
});

// -----------------------------------------------------------------------------
// (6) The ladders really COLLAPSED -- this is not a pass-through wrapper.
//
// A dispatchRole() that merely called into ladders still living in runner.js
// would satisfy every behavioural pin above (the engine really would be the
// thing making the dispatch) while collapsing nothing. What distinguishes the
// two is absence: no inline agent() ladder, and none of the per-role
// brackets-and-watchdog scaffolding that wrapped them, may survive in runner.js.
// -----------------------------------------------------------------------------
describe('(6) no inline role ladder or its bracket/watchdog scaffolding survives in runner.js', () => {
    test('runner.js contains no agent() call site at all, and the engine hosts exactly one', () => {
        const runnerSites = findCallSites(RUNNER_SRC, 'agent', { excludeDeclaration: true });
        assert.deepStrictEqual(
            runnerSites.map((s) => `runner.js:${s.line}`),
            [],
            'an inline agent() dispatch survives in runner.js. Every role dispatch must route through dispatchRole().'
        );
        const { source } = moduleSetSourceWithOffsets(dispatchLadderModulePaths(FLEET_SPRINT_DIR));
        assert.strictEqual(
            findCallSites(source, 'agent').length,
            1,
            'across the whole dispatch-ladder module set there must be exactly ONE agent() call site -- the engine\'s.'
        );
        assert.strictEqual(
            findCallSites(DISPATCH_ROLE_SRC, 'agent').length,
            1,
            'and it must be the one in dispatch-role.mjs.'
        );
    });

    test('the per-role bracket and watchdog scaffolding moved with the ladders', () => {
        assert.deepStrictEqual(
            findCallSites(RUNNER_SRC, 'withGitSync', { excludeDeclaration: true }).map((s) => `runner.js:${s.line}`),
            [],
            'a per-dispatch withGitSync(...) bracket survives in runner.js -- the engine opens the one shared bracket.'
        );
        assert.deepStrictEqual(
            findCallSites(RUNNER_SRC, 'withDispatchWatchdog', { excludeDeclaration: true }).map((s) => `runner.js:${s.line}`),
            [],
            'a per-dispatch withDispatchWatchdog(...) race survives in runner.js.'
        );
        // ...and the engine really is where both now live, exactly once each.
        // These are ctx.* calls, which the shared call-site scanner deliberately
        // does not treat as call sites, so they are counted directly.
        assert.strictEqual((DISPATCH_ROLE_SRC.match(/ctx\.withGitSync\(/g) || []).length, 1);
        assert.strictEqual((DISPATCH_ROLE_SRC.match(/ctx\.withDispatchWatchdog\(/g) || []).length, 1);
    });

    test('the engine does not import runner.js back -- it cannot be delegating to a surviving ladder', () => {
        const specifiers = [...DISPATCH_ROLE_SRC.matchAll(/^import[^;]*?from\s+['"]([^'"]+)['"]/gms)].map((m) => m[1]);
        assert.ok(specifiers.length > 0, 'no imports were parsed out of dispatch-role.mjs -- the check would be vacuous.');
        assert.deepStrictEqual(
            specifiers.filter((s) => s.includes('runner')),
            [],
            'dispatch-role.mjs imports runner.js. Every runner-side primitive it needs is INJECTED through ctx; an ' +
            'import back would let a "migrated" ladder keep running inside runner.js behind the engine.'
        );
    });

    test('every dispatchRole() call site in runner.js names a migrated role, and together they cover the whole set', () => {
        const sites = findCallSites(RUNNER_SRC, 'dispatchRole', { excludeDeclaration: true });
        assert.ok(sites.length > 0, 'runner.js makes no dispatchRole() call at all.');
        const dispatchedByName = sites.map((site) => {
            const args = splitTopLevelArgs(site.callText);
            const raw = (args[1] || '').trim();
            assert.match(
                raw,
                /^'[^']+'$/,
                `runner.js:${site.line} dispatches a role by EXPRESSION (${raw}) rather than by literal name -- a ` +
                'computed role name cannot be audited for coverage here.'
            );
            return raw.slice(1, -1);
        });
        for (const role of dispatchedByName) {
            assert.ok(ROLE_NAMES.includes(role), `runner.js dispatches unknown role '${role}'.`);
            assert.strictEqual(ROLE_POLICIES[role].migrated, true, `runner.js dispatches '${role}', which is not marked migrated.`);
        }
        // COVERAGE, discovered rather than counted: every migrated role must be
        // reachable, and the only one runner.js does not name is the doer's
        // resume -- which is the SAME frozen object as the doer's secondary and
        // is reached through the doer path. An assertion written against the
        // number of call sites would leave exactly that role unverified.
        const reachedByName = new Set(dispatchedByName);
        const notDispatchedByName = migratedRoleNames().filter((role) => !reachedByName.has(role));
        for (const role of notDispatchedByName) {
            const owner = ROLE_NAMES.find((name) => ROLE_POLICIES[name].secondary === ROLE_POLICIES[role]);
            assert.ok(
                owner && reachedByName.has(owner),
                `'${role}' is marked migrated but runner.js never dispatches it by name and it is not the secondary ` +
                'of a role that is -- so nothing in production reaches it.'
            );
        }
        assert.ok(
            notDispatchedByName.length < migratedRoleNames().length,
            'no role is dispatched by name at all -- the coverage check above would be vacuous.'
        );
    });

    test('the inline-ladder guard reports zero violations over the shared guarded-module list', () => {
        const { violations, files } = checkModules();
        assert.deepStrictEqual(violations, [], `surviving inline ladders:\n${violations.join('\n')}`);
        assert.ok(files.length > 0, 'the guard scanned NO files -- zero violations would mean nothing.');
        assert.deepStrictEqual(
            files.sort(),
            guardedModulePaths().map((p) => path.basename(p)).sort(),
            'the guard must take its scanned-file list from the shared guarded-module list, not a private array.'
        );
        assert.ok(files.includes('runner.js'), 'runner.js must be in the scanned set.');
    });

    test('...and that zero is FALSIFIABLE for every role in the discovered set, not just in aggregate', () => {
        // The guard returns [] both when nothing is wrong and when it cannot see
        // anything -- an anchor that matches no text, or a member expression it
        // cannot rebuild, makes a role permanently unflaggable. Seeding one
        // surviving ladder per DISCOVERED role proves the zero above is a real
        // negative for each of them individually.
        const roles = migratedRoleNames();
        assert.ok(roles.length > 0, 'no role to falsify against.');
        const unfalsifiable = [];
        for (const role of roles) {
            const dispatch = ROLE_POLICIES[role];
            const expr = memberExprFor(dispatch.member);
            if (!expr) {
                unfalsifiable.push(`${role}: no member expression could be rebuilt`);
                continue;
            }
            const seeded = [
                `export async function survivingLadderFor${roles.indexOf(role)}(agent) {`,
                "    await agent('prompt text', {",
                `        member_name: ${expr},`,
                `        // ${dispatch.ladderAnchor}`,
                '    });',
                '}',
            ].join('\n');
            const found = findInlineLadderViolations(seeded, 'seeded.mjs', [role], ROLE_POLICIES);
            if (found.length !== 1) unfalsifiable.push(`${role}: seeded ladder produced ${found.length} violation(s), expected 1`);
        }
        assert.deepStrictEqual(
            unfalsifiable,
            [],
            'these roles cannot be flagged even when an inline ladder is seeded, so the guard\'s zero says nothing ' +
            `about them:\n${unfalsifiable.join('\n')}`
        );
    });
});

// -----------------------------------------------------------------------------
// (7) The mock-sprint suite and both golden transcripts still pass, with the
// fixtures untouched and WITHOUT UPDATE_GOLDEN.
//
// Nested `node --test` children, following the pattern established by
// phase1-leaf-facade-completeness.test.mjs. Two hazards are handled there and
// repeated here because both are silent:
//   - NODE_TEST_CONTEXT is set by `node --test` on its own process, and a child
//     spawned with it still in the environment NO-OPS: empty stdout, exit 0, no
//     test run. It is deleted for every child below, and every child's output is
//     then checked for a non-zero pass count so a no-op can never read as
//     success.
//   - UPDATE_GOLDEN would make the golden suites REWRITE the fixtures they are
//     supposed to be compared against, turning any transcript drift into a
//     silent pass. It is deleted from the child env, and the fixture directory
//     is checked clean before AND after.
// -----------------------------------------------------------------------------
const DEFAULT_NESTED_SUITE_TIMEOUT_MS = 900_000;

function resolveNestedSuiteTimeoutMs() {
    const raw = process.env.PHASE3_NESTED_SUITE_TIMEOUT_MS;
    if (raw === undefined || raw === '') return DEFAULT_NESTED_SUITE_TIMEOUT_MS;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`PHASE3_NESTED_SUITE_TIMEOUT_MS must be a positive number of milliseconds, got: ${JSON.stringify(raw)}`);
    }
    return parsed;
}

const NESTED_SUITE_TIMEOUT_MS = resolveNestedSuiteTimeoutMs();

/** Runs a nested `node --test` child and returns its stdout, or throws describing the timeout. */
function runNestedSuite(suiteLabel, args, extraOpts = {}) {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.UPDATE_GOLDEN;
    assert.strictEqual(env.UPDATE_GOLDEN, undefined, 'UPDATE_GOLDEN must be unset for every nested child run.');
    try {
        return execFileSync(process.execPath, args, {
            cwd: SE_DIR,
            encoding: 'utf8',
            stdio: 'pipe',
            timeout: NESTED_SUITE_TIMEOUT_MS,
            maxBuffer: 200 * 1024 * 1024,
            env,
            ...extraOpts,
        });
    } catch (err) {
        if (err && err.code === 'ETIMEDOUT') {
            const source = process.env.PHASE3_NESTED_SUITE_TIMEOUT_MS
                ? `PHASE3_NESTED_SUITE_TIMEOUT_MS=${process.env.PHASE3_NESTED_SUITE_TIMEOUT_MS}`
                : 'the default (no PHASE3_NESTED_SUITE_TIMEOUT_MS override set)';
            throw new Error(
                `nested suite '${suiteLabel}' exceeded its ${NESTED_SUITE_TIMEOUT_MS}ms budget, from ${source}. ` +
                'Raise PHASE3_NESTED_SUITE_TIMEOUT_MS if this run is genuinely this slow here.'
            );
        }
        throw err;
    }
}

/**
 * A nested child that ran NOTHING exits 0 with no TAP summary, which reads as
 * success. This turns "exit 0" into "at least `minPasses` tests really ran and
 * none failed".
 */
function assertNestedSuiteReallyRan(suiteLabel, childOut, minPasses) {
    const passMatch = childOut.match(/^# pass (\d+)$/m);
    assert.ok(
        passMatch && Number(passMatch[1]) >= minPasses,
        `nested suite '${suiteLabel}' reported ${passMatch ? passMatch[1] : 'NO'} passing tests (expected at least ` +
        `${minPasses}) -- a child that silently ran nothing must not read as a pass. Output tail:\n${childOut.slice(-2000)}`
    );
    const failMatch = childOut.match(/^# fail (\d+)$/m);
    assert.strictEqual(
        failMatch && failMatch[1],
        '0',
        `nested suite '${suiteLabel}' reported failures. Output tail:\n${childOut.slice(-4000)}`
    );
}

/** `git status --porcelain` for the golden fixture directory, from the repo root. */
function goldenFixtureStatus() {
    return execFileSync('git', ['status', '--porcelain', '--', GOLDEN_FIXTURE_REL], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
    }).trim();
}

describe('(7) the mock-sprint suite and both golden transcripts pass on the post-refactor tree', () => {
    test('both golden transcript suites pass without UPDATE_GOLDEN and leave the fixtures untouched', () => {
        const before = goldenFixtureStatus();
        assert.strictEqual(
            before,
            '',
            `the golden fixture directory must be clean BEFORE this test, or the after-check proves nothing:\n${before}`
        );
        const out = runNestedSuite('golden-transcript', [
            '--test',
            'test/golden-transcript.test.mjs',
            'test/golden-transcript-3bead.test.mjs',
        ]);
        assertNestedSuiteReallyRan('golden-transcript', out, 2);
        const after = goldenFixtureStatus();
        assert.strictEqual(
            after,
            '',
            `running the golden transcript suites rewrote a fixture -- the transcripts were regenerated rather than ` +
            `compared:\n${after}`
        );
    });

    // COST, stated deliberately rather than discovered later: this nested run
    // is the slowest thing in this file (~13s of its ~17s) and it is the THIRD
    // pass over the mock-sprint files in one `npm test` -- the package glob
    // runs them, phase1-leaf-facade-completeness.test.mjs runs them as a set,
    // and this gate runs them again for a different claim (that the dispatch
    // ENGINE did not change any sprint's behaviour). It is kept anyway because
    // the alternative -- asserting that some other file runs them -- is exactly
    // the kind of second-hand check that goes vacuous the moment that file
    // changes, and this bead's whole point is that a vacuous pass here must be
    // impossible.
    //
    // MEASURED SIDE EFFECT, pre-existing and NOT introduced here: one full
    // mock-sprint pass leaves ~10 `fleet-sprint-body-*.txt` files in the system
    // temp directory, and the golden 3-bead suite leaves one
    // `apra-fleet-sprint-lock-golden-3bead-*` entry. Both come from the suites
    // being run, not from anything this file writes, and both already happen on
    // every `npm test` today; this gate multiplies the count, it does not
    // create the leak. Tracked separately so it is fixed at its source rather
    // than by quietly dropping coverage here.
    test('every mock-sprint test file passes against the engine-driven runner', () => {
        const testDir = path.join(SE_DIR, 'test');
        const mockSprintFiles = fs.readdirSync(testDir)
            .filter((name) => name.startsWith('mock-sprint-') && name.endsWith('.test.mjs'))
            .sort();
        assert.ok(
            mockSprintFiles.length >= 50,
            `expected a substantial mock-sprint suite, found ${mockSprintFiles.length} file(s) -- a shrunken list ` +
            'would make this run pass while covering almost nothing.'
        );
        // Scoped to test/mock-sprint-*.test.mjs, the same boundary `npm test`
        // uses; test/slow/ is deliberately excluded because the repo already
        // separates it into its own `test:slow` script for cost reasons.
        const out = runNestedSuite('mock-sprint', [
            '--test',
            '--test-concurrency=8',
            ...mockSprintFiles.map((f) => path.join('test', f)),
        ]);
        assertNestedSuiteReallyRan('mock-sprint', out, mockSprintFiles.length);
    });
});

// -----------------------------------------------------------------------------
// (8) Nothing above mutated the real table.
//
// Every splice runs against a COPY handed to the engine through ctx.policies.
// A test that reached into ROLE_POLICIES itself would change the behaviour of
// every other test file sharing this process, and the damage would surface as
// an unrelated failure somewhere else rather than here.
// -----------------------------------------------------------------------------
describe('(8) the real frozen policy table was never mutated by this file', () => {
    test('ROLE_POLICIES is byte-identical to the snapshot taken at module load', () => {
        assert.strictEqual(
            JSON.stringify(ROLE_POLICIES),
            REAL_TABLE_SNAPSHOT,
            'the real ROLE_POLICIES table changed while this file ran -- a variance test spliced the live table ' +
            'instead of a copy.'
        );
        assert.ok(Object.isFrozen(ROLE_POLICIES), 'the table must stay frozen.');
        for (const name of ROLE_NAMES) {
            assert.ok(Object.isFrozen(ROLE_POLICIES[name]), `row '${name}' must stay frozen.`);
        }
    });
});
