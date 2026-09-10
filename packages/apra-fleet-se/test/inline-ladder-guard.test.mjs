import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkModules, findInlineLadderViolations, memberExprFor } from '../fleet-sprint/inline-ladder-guard.mjs';
import { findCallSites } from '../fleet-sprint/dispatch-safety-guard.mjs';
import { GUARDED_MODULES, guardedModulePaths, guardedModuleBasenames } from '../fleet-sprint/guarded-modules.mjs';
import { ROLE_POLICIES, ROLE_NAMES, migratedRoleNames, allDispatchPolicies } from '../fleet-sprint/role-policies.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// =============================================================================
// apra-fleet-3swo.5.8 -- inline-ladder guard test.
//
// See fleet-sprint/inline-ladder-guard.mjs's header for the full rationale:
// this guard flags any surviving inline `agent(` role-dispatch call for a
// role role-policies.mjs marks `migrated: true`, so a dispatchRole migration
// bead that adds the new engine call but forgets to delete the old ladder
// cannot pass silently.
//
// TODAY'S TREE: no role is migrated (migratedRoleNames() === []), so the
// guard must report zero violations against the real guarded-module list --
// that is the green baseline the two dispatchRole migration beads
// (apra-fleet-3swo.5.3/.5.6) have to keep green as they migrate roles one at
// a time.
//
// FALSIFIABILITY (a role "marked migrated in role-policies.mjs"): no real
// role is migrated today, and this suite must not flip that in the shared,
// frozen ROLE_POLICIES table (mutating a frozen object throws, and doing so
// would corrupt every other test file's import of it besides). Instead each
// seeded-violation test below builds a ONE-ROLE-CHANGED COPY of the real
// table -- `{ ...ROLE_POLICIES, planner: { ...ROLE_POLICIES.planner, migrated: true } }`
// -- so "a role marked migrated in role-policies.mjs" is exercised using
// that role's REAL policy shape (its real member-routing expression), not an
// unrelated synthetic fixture, while the actual shared file stays untouched.
// =============================================================================

/** Creates a sandbox dir under os.tmpdir(); returns { dir, write, cleanup }. */
function createSandbox() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inline-ladder-guard-'));
    return {
        dir,
        write(name, lines) {
            const file = path.join(dir, name);
            fs.writeFileSync(file, lines.join('\n'), 'utf8');
            return file;
        },
        cleanup() {
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

// A fixture module carrying one inline `agent(` dispatch that routes to the
// planner role's real member expression (getMemberForRole('planner') --
// ROLE_POLICIES.planner.member is { kind: 'role', role: 'planner' }, and
// memberExprFor() rebuilds that exact runner.js expression from it) AND
// carries the planner's real ladderAnchor ('plannerPrompt,' --
// apra-fleet-3swo.24). The anchor is required alongside the member
// expression: the member expression alone is not role-unique (three
// policies share roleMember('planner')), so a fixture matching only the
// expression is no longer enough to exercise a "real" seeded violation. This
// is what "an inline ladder that was not removed when its role migrated"
// looks like structurally.
const SEEDED_LADDER_FIXTURE = [
    "import { getMemberForRole } from './member-target.mjs';",
    '',
    'export async function dispatchPlanner(agent, plannerPrompt) {',
    '    await agent(plannerPrompt, {',
    '        member_name: getMemberForRole(\'planner\'),',
    '        max_turns: 10,',
    '    });',
    '}',
    '',
];

// The same module with the inline ladder removed -- what the migration bead
// is supposed to leave behind (the real dispatch now lives behind
// dispatchRole(), which this fixture does not need to model: the guard only
// cares that no raw `agent(` call routing to the migrated role's member
// survives).
const CLEARED_LADDER_FIXTURE = [
    "import { dispatchRole } from './dispatch-role.mjs';",
    '',
    'export async function dispatchPlanner(ctx) {',
    "    await dispatchRole(ctx, 'planner', {});",
    '}',
    '',
];

/** ROLE_POLICIES with exactly one role's `migrated` flag flipped to true. */
function withRoleMigrated(role) {
    return { ...ROLE_POLICIES, [role]: { ...ROLE_POLICIES[role], migrated: true } };
}

describe('inline-ladder guard: baseline against the real tree', () => {
    test('no role is migrated today, so migratedRoleNames() is empty', () => {
        assert.deepStrictEqual(migratedRoleNames(), []);
    });

    test('checkModules() over the shared list reports zero violations today, sourced from guarded-modules.mjs alone', () => {
        const { violations, files } = checkModules();
        // Compared against basenames, not GUARDED_MODULES verbatim, mirroring
        // every sibling guard's own baseline assertion (apra-fleet-3swo.14).
        assert.deepStrictEqual(files, guardedModuleBasenames(), 'the default scan set is exactly the shared list');
        assert.deepStrictEqual(violations, [], `Found ${violations.length} inline-ladder violation(s):\n${violations.join('\n')}`);
    });

    test('inline-ladder-guard.mjs is registered in GUARDED_MODULES', () => {
        assert.ok(
            GUARDED_MODULES.includes('inline-ladder-guard.mjs'),
            `expected inline-ladder-guard.mjs in the shared list, got: ${JSON.stringify(GUARDED_MODULES)}`
        );
    });

    test('checkModules() defines no private path array -- explicit paths still come from guardedModulePaths()', () => {
        const sandbox = createSandbox();
        try {
            const fixture = sandbox.write('newly-extracted.mjs', ['export const nothing = 1;', '']);
            const paths = guardedModulePaths([fixture]);
            const { files } = checkModules({ paths });
            assert.deepStrictEqual(files, [...guardedModuleBasenames(), 'newly-extracted.mjs']);
        } finally {
            sandbox.cleanup();
        }
    });
});

describe('inline-ladder guard: falsifiability against a seeded violation', () => {
    test('flags a surviving inline agent() ladder for a role marked migrated in role-policies.mjs', () => {
        const sandbox = createSandbox();
        try {
            const fixture = sandbox.write('planner-ladder.mjs', SEEDED_LADDER_FIXTURE);
            const { violations } = checkModules({
                paths: [fixture],
                migratedRoles: ['planner'],
                rolePolicies: withRoleMigrated('planner'),
            });
            assert.strictEqual(violations.length, 1, `expected exactly one violation, got: ${JSON.stringify(violations, null, 2)}`);
            assert.match(violations[0], /^planner-ladder\.mjs:4 /);
            assert.match(violations[0], /role 'planner'/);
        } finally {
            sandbox.cleanup();
        }
    });

    test('reports zero violations once the seeded ladder is removed (falsifiable, not vacuous)', () => {
        const sandbox = createSandbox();
        try {
            const fixture = sandbox.write('planner-ladder.mjs', CLEARED_LADDER_FIXTURE);
            const { violations } = checkModules({
                paths: [fixture],
                migratedRoles: ['planner'],
                rolePolicies: withRoleMigrated('planner'),
            });
            assert.deepStrictEqual(violations, []);
        } finally {
            sandbox.cleanup();
        }
    });

    test('reports zero violations for the SAME seeded ladder when the role is not marked migrated', () => {
        const sandbox = createSandbox();
        try {
            const fixture = sandbox.write('planner-ladder.mjs', SEEDED_LADDER_FIXTURE);
            // migratedRoles omitted -> defaults to migratedRoleNames() against
            // the REAL table, which marks no role migrated -- the seeded
            // ladder is a legitimate, still-active dispatch until its role
            // actually migrates.
            const { violations } = checkModules({ paths: [fixture] });
            assert.deepStrictEqual(violations, []);
        } finally {
            sandbox.cleanup();
        }
    });

    test('a migrated role with no matching call site in the scanned file reports zero violations', () => {
        const sandbox = createSandbox();
        try {
            // Seeded ladder routes to 'planner'; marking 'doer' migrated
            // instead must not false-positive on an unrelated call site.
            const fixture = sandbox.write('planner-ladder.mjs', SEEDED_LADDER_FIXTURE);
            const { violations } = checkModules({
                paths: [fixture],
                migratedRoles: ['doer'],
                rolePolicies: withRoleMigrated('doer'),
            });
            assert.deepStrictEqual(violations, []);
        } finally {
            sandbox.cleanup();
        }
    });
});

describe('inline-ladder guard: memberExprFor()', () => {
    test('rebuilds the getMemberForRole() expression for a role-kind member', () => {
        assert.strictEqual(memberExprFor({ kind: 'role', role: 'planner' }), "getMemberForRole('planner')");
    });

    test('returns null for a pool-head/runtime member (out of scope for this guard today)', () => {
        assert.strictEqual(memberExprFor({ kind: 'pool-head', role: 'reviewer', binding: 'reviewerPool[0]' }), null);
        assert.strictEqual(memberExprFor({ kind: 'runtime', binding: 'doerMember' }), null);
        assert.strictEqual(memberExprFor(null), null);
    });
});

describe('inline-ladder guard: findInlineLadderViolations() unit behaviour', () => {
    test('returns immediately with no scan when migratedRoles is empty', () => {
        const src = SEEDED_LADDER_FIXTURE.join('\n');
        assert.deepStrictEqual(findInlineLadderViolations(src, 'x.mjs', [], ROLE_POLICIES), []);
    });

    test('skips a migrated role entry the rolePolicies map does not contain', () => {
        const src = SEEDED_LADDER_FIXTURE.join('\n');
        assert.deepStrictEqual(findInlineLadderViolations(src, 'x.mjs', ['no-such-role'], ROLE_POLICIES), []);
    });

    // -------------------------------------------------------------------
    // apra-fleet-3swo.30 -- proves the apra-fleet-3swo.24 anchor fix ACTUALLY
    // discriminates the two three/two-way member-sharing clusters
    // (roleMember('planner'): planner, scoped-replan-planner,
    // streak-assignment; roleMember('plan-reviewer'): plan-reviewer,
    // scoped-replan-plan-reviewer), using FIXTURE policy tables so nothing
    // here ever mutates the real, frozen ROLE_POLICIES table (see this file's
    // header for why: migratedRoleNames() reads policy.migrated on the real
    // table, and marking a real policy migrated from a test would change
    // production behaviour).
    // -------------------------------------------------------------------

    /**
     * A dispatch's real (member-expression, ladderAnchor) pair, read from the
     * live ROLE_POLICIES table rather than re-typed as a duplicate literal --
     * so a fixture built from this helper is byte-tied to whatever the real
     * table says today, and a corruption of the real table (anchor emptied
     * or de-duplicated away) shows up as a fixture collision too, not just as
     * a silently-still-passing hardcoded string elsewhere.
     */
    function realDispatchIdentity(role, kind = 'main') {
        const entry = ROLE_POLICIES[role];
        const dispatch = kind === 'secondary' ? entry.secondary : entry;
        const expr = memberExprFor(dispatch.member);
        assert.ok(expr, `fixture setup: role '${role}' (${kind}) is not a 'role'-kind member -- this helper only builds 'role'-kind fixtures`);
        return { expr, anchor: dispatch.ladderAnchor };
    }

    /**
     * Builds a fixture module with one `agent(...)` call site per
     * `{role, kind, label}` entry in `specs`, each carrying that dispatch's
     * REAL member expression and REAL ladderAnchor (via realDispatchIdentity
     * above). The anchor is embedded as a same-call-site comment rather than
     * re-derived structurally, so it works uniformly whichever shape the real
     * anchor happens to have (a bare `label: '...'` property vs. a bare
     * `promptVar,` substring). Returns { source, lineFor } keyed by `label` so
     * a test can assert on call-site IDENTITY (line number), not merely on
     * violation count -- see cases (b)/(c) below.
     *
     * @param {Array<{role: string, kind?: 'main'|'secondary', label: string}>} specs
     */
    function buildLadderClusterFixture(specs) {
        const lines = [];
        const lineFor = {};
        specs.forEach(({ role, kind = 'main', label }, i) => {
            const { expr, anchor } = realDispatchIdentity(role, kind);
            lines.push(`export async function dispatch${i}(agent) {`);
            const callLine = lines.length + 1;
            lines.push("    await agent('prompt text', {");
            lines.push(`        member_name: ${expr},`);
            lines.push(`        // ${anchor}`);
            lines.push('    });');
            lines.push('}');
            lines.push('');
            lineFor[label] = callLine;
        });
        return { source: lines.join('\n'), lineFor };
    }

    test('(a) only planner migrated: a source with all three roleMember(planner) ladders yields exactly one violation, naming the planner ladder', () => {
        const sandbox = createSandbox();
        try {
            const { source, lineFor } = buildLadderClusterFixture([
                { role: 'planner', label: 'planner' },
                { role: 'scoped-replan-planner', label: 'scoped-replan-planner' },
                { role: 'streak-assignment', label: 'streak-assignment' },
            ]);
            const fixture = sandbox.write('planner-cluster.mjs', source.split('\n'));
            const { violations } = checkModules({
                paths: [fixture],
                migratedRoles: ['planner'],
                rolePolicies: withRoleMigrated('planner'),
            });
            assert.strictEqual(violations.length, 1, `expected exactly one violation, got: ${JSON.stringify(violations, null, 2)}`);
            assert.match(violations[0], new RegExp(`^planner-cluster\\.mjs:${lineFor.planner} `), 'the one violation must name the planner ladder\'s own line');
            assert.match(violations[0], /role 'planner'/);
        } finally {
            sandbox.cleanup();
        }
    });

    test('(b) same fixture as (a): neither the scoped-replan-planner nor the streak-assignment call site appears in the violations', () => {
        const sandbox = createSandbox();
        try {
            const { source, lineFor } = buildLadderClusterFixture([
                { role: 'planner', label: 'planner' },
                { role: 'scoped-replan-planner', label: 'scoped-replan-planner' },
                { role: 'streak-assignment', label: 'streak-assignment' },
            ]);
            const fixture = sandbox.write('planner-cluster.mjs', source.split('\n'));
            const { violations } = checkModules({
                paths: [fixture],
                migratedRoles: ['planner'],
                rolePolicies: withRoleMigrated('planner'),
            });
            // NEGATIVE assertion by call-site IDENTITY (line number), not by
            // count: this fails even if some unrelated bug happened to keep
            // the total violation count at the "expected" number.
            for (const label of ['scoped-replan-planner', 'streak-assignment']) {
                assert.ok(
                    !violations.some((v) => v.startsWith(`planner-cluster.mjs:${lineFor[label]} `)),
                    `the ${label} call site (line ${lineFor[label]}) must NOT be reported: ${JSON.stringify(violations, null, 2)}`
                );
            }
        } finally {
            sandbox.cleanup();
        }
    });

    test('(c) only plan-reviewer migrated: exactly one violation, and scoped-replan-plan-reviewer is not reported', () => {
        const sandbox = createSandbox();
        try {
            const { source, lineFor } = buildLadderClusterFixture([
                { role: 'plan-reviewer', label: 'plan-reviewer' },
                { role: 'scoped-replan-plan-reviewer', label: 'scoped-replan-plan-reviewer' },
            ]);
            const fixture = sandbox.write('plan-reviewer-cluster.mjs', source.split('\n'));
            const { violations } = checkModules({
                paths: [fixture],
                migratedRoles: ['plan-reviewer'],
                rolePolicies: withRoleMigrated('plan-reviewer'),
            });
            assert.strictEqual(violations.length, 1, `expected exactly one violation, got: ${JSON.stringify(violations, null, 2)}`);
            assert.match(violations[0], new RegExp(`^plan-reviewer-cluster\\.mjs:${lineFor['plan-reviewer']} `));
            assert.match(violations[0], /role 'plan-reviewer'/);
            assert.ok(
                !violations.some((v) => v.startsWith(`plan-reviewer-cluster.mjs:${lineFor['scoped-replan-plan-reviewer']} `)),
                `the scoped-replan-plan-reviewer call site (line ${lineFor['scoped-replan-plan-reviewer']}) must NOT be reported: ${JSON.stringify(violations, null, 2)}`
            );
        } finally {
            sandbox.cleanup();
        }
    });

    test('(e) [regression] a role whose secondary shares its main dispatch\'s member AND anchor still yields ONE violation per real call site, not two', () => {
        // A synthetic fixture rolePolicies map -- NOT the real table -- whose
        // main and secondary dispatches deliberately share an identical
        // (member, ladderAnchor) pair. Exercises the pairs Set de-duplication
        // in findInlineLadderViolations() (inline-ladder-guard.mjs lines
        // ~110-121): without it, one real call site matching both dispatch
        // variants' identical pair would be visited twice.
        const expr = memberExprFor({ kind: 'role', role: 'planner' });
        const sharedAnchor = 'SHARED_ANCHOR_APRA_FLEET_3SWO_30_CASE_E';
        const fixtureRolePolicies = {
            'dup-role': {
                member: { kind: 'role', role: 'planner' },
                ladderAnchor: sharedAnchor,
                secondary: {
                    member: { kind: 'role', role: 'planner' },
                    ladderAnchor: sharedAnchor,
                },
            },
        };
        const src = [
            'export async function dispatchDup(agent) {',
            "    await agent('prompt text', {",
            `        member_name: ${expr},`,
            `        // ${sharedAnchor}`,
            '    });',
            '}',
            '',
        ].join('\n');
        const violations = findInlineLadderViolations(src, 'dup.mjs', ['dup-role'], fixtureRolePolicies);
        assert.strictEqual(
            violations.length,
            1,
            `expected exactly one violation despite main+secondary sharing an identical (member, anchor) pair, got: ${JSON.stringify(violations, null, 2)}`
        );
    });

    test('(f) baseline: the real ROLE_POLICIES table on the real guarded-module list still yields zero violations', () => {
        // Same baseline as 'inline-ladder guard: baseline against the real
        // tree' above, restated here under its (f) label for this bead's
        // lettered checklist (apra-fleet-3swo.30): the real table is only
        // ever READ in this case, never mutated (AC#3).
        const { violations } = checkModules();
        assert.deepStrictEqual(violations, [], `Found ${violations.length} inline-ladder violation(s):\n${violations.join('\n')}`);
    });
});

describe('inline-ladder guard: (d) anchor uniqueness over the REAL ROLE_POLICIES table', () => {
    // OWNERSHIP (apra-fleet-3swo.30 AC#5b): this describe block is the SOLE
    // place in the suite that asserts every real dispatch's ladderAnchor is
    // non-empty AND unique across the whole table. The paired [impl] bead
    // apra-fleet-3swo.24 gives every dispatch its own ladderAnchor, but
    // role-policies.mjs's policy()/secondary() constructors only ever check
    // that a SINGLE spec's own anchor is non-empty -- neither checks that it
    // differs from every OTHER dispatch's anchor. This describe block owns
    // that cross-table invariant, and is written (via its two falsification
    // tests below) to fail for BOTH failure modes on its own: a missing/empty
    // anchor, and two dispatches sharing one.
    //
    // doer.secondary === ROLE_POLICIES['doer-resume'] IS THE SAME OBJECT
    // (role-policies.mjs assigns doerResume to doer.secondary, and 'doer-resume'
    // is also its own top-level ROLE_NAMES entry), so a naive sweep over
    // [entry, entry.secondary] for every name in ROLE_NAMES would visit that
    // one real dispatch TWICE and report a false self-collision.
    // dispatchesOf() below de-duplicates by object identity (mirroring
    // role-policies.mjs's own allDispatchPolicies(), generalized to accept an
    // injected table so the falsification tests can drive it against a
    // broken fixture without touching the real one).

    /** Every distinct dispatch object in `rolePolicies`, de-duplicated by identity. */
    function dispatchesOf(rolePolicies) {
        const seen = new Set();
        const out = [];
        for (const name of ROLE_NAMES) {
            const entry = rolePolicies[name];
            for (const dispatch of [entry, entry && entry.secondary]) {
                if (!dispatch || seen.has(dispatch)) continue;
                seen.add(dispatch);
                out.push(dispatch);
            }
        }
        return out;
    }

    /** Throws if any dispatch in `rolePolicies` has an empty/missing anchor, or if two share one. */
    function assertAnchorsUniqueAndNonEmpty(rolePolicies) {
        const seenAnchors = new Map();
        for (const dispatch of dispatchesOf(rolePolicies)) {
            assert.ok(
                typeof dispatch.ladderAnchor === 'string' && dispatch.ladderAnchor.length > 0,
                `dispatch for role '${dispatch.role}' (kind=${dispatch.kind}) has no non-empty ladderAnchor`
            );
            const priorOwner = seenAnchors.get(dispatch.ladderAnchor);
            assert.strictEqual(
                priorOwner,
                undefined,
                `ladderAnchor ${JSON.stringify(dispatch.ladderAnchor)} is shared by role '${priorOwner && priorOwner.role}' and role '${dispatch.role}'`
            );
            seenAnchors.set(dispatch.ladderAnchor, dispatch);
        }
    }

    test('(d) every real dispatch has a non-empty, unique ladderAnchor', () => {
        assertAnchorsUniqueAndNonEmpty(ROLE_POLICIES);
    });

    test('(d) falsification: the check fails when a dispatch has an empty ladderAnchor', () => {
        // FALSIFIABILITY, failure mode 1/2: a fixture copy of the real table
        // with one dispatch's anchor emptied out.
        const broken = { ...ROLE_POLICIES, planner: { ...ROLE_POLICIES.planner, ladderAnchor: '' } };
        assert.throws(() => assertAnchorsUniqueAndNonEmpty(broken), /no non-empty ladderAnchor/);
    });

    test('(d) falsification: the check fails when two dispatches share one ladderAnchor', () => {
        // FALSIFIABILITY, failure mode 2/2: a fixture copy of the real table
        // with scoped-replan-planner's anchor collapsed onto planner's --
        // exactly the apra-fleet-3swo.24 collision this bead's guard exists
        // to catch.
        const broken = {
            ...ROLE_POLICIES,
            'scoped-replan-planner': { ...ROLE_POLICIES['scoped-replan-planner'], ladderAnchor: ROLE_POLICIES.planner.ladderAnchor },
        };
        assert.throws(() => assertAnchorsUniqueAndNonEmpty(broken), /is shared by role/);
    });

    // AC#4 FALSIFIABILITY RECORD (confirmed by hand, not left applied): with
    // fleet-sprint/inline-ladder-guard.mjs's match condition
    //     if (site.callText.includes(expr) && site.callText.includes(anchor)) {
    // reverted (one line) to
    //     if (site.callText.includes(expr)) {
    // -- i.e. reverting exactly the apra-fleet-3swo.24 change this guard is
    // built on -- cases (a), (b) and (c) above fail: with only the member
    // expression required, every roleMember('planner')/roleMember(
    // 'plan-reviewer') sibling ladder in the fixture source matches, so (a)
    // and (c) each report 2-3 violations instead of 1, and (b)'s negative
    // call-site-identity assertions fail outright because the sibling sites
    // ARE reported. Case (d) fails independently of that guard-code revert,
    // by its own two falsification sub-tests immediately above, which drive
    // assertAnchorsUniqueAndNonEmpty() directly against a broken copy of the
    // real table -- AC#5b requires (d) to own that check standalone, so its
    // falsifiability does not depend on (and is not provided by) the guard's
    // matching code at all.
});

describe('inline-ladder guard: (apra-fleet-3swo.35) every real dispatch anchor pins to a real agent() call site', () => {
    // WHY THIS EXISTS: a dispatch's ladderAnchor exists only to disambiguate
    // a real call site once inline-ladder-guard's member-expression
    // pre-filter matches (see that module's header -- the member expression
    // alone is not role-unique). Nothing before this test asserted an anchor
    // still corresponds to a real agent() call site in the guarded-module
    // set: if a migration bead, or any unrelated prompt reword, renames
    // plannerPrompt, changes a label literal, or edits the first sentence of
    // a resume prompt, the anchor silently stops matching ANYTHING. The
    // guard would then report zero violations for that role forever --
    // exactly the false-negative apra-fleet-3swo.24 was written to prevent,
    // now reintroduced through the anchor itself rather than through the
    // member-expression check it replaced. This test pins every anchor to
    // the real source today, so that drift is caught here instead of by a
    // guard that has gone silently inert.
    //
    // apra-fleet-3swo.35 confirmed by hand: all 22 real dispatches
    // (allDispatchPolicies(), de-duplicated the same way this file's case
    // (d) block does) have an anchor occurring in runner.js today.
    //
    // AT-LEAST-ONE, not exactly-one (per apra-fleet-3swo.35's own text): the
    // stronger "exactly one call site" form was considered, and it does NOT
    // hold even after apra-fleet-3swo.34's extractBalancedCall comment-mask
    // fix (verified: re-ran this scan post-fix). Two of the 22 real
    // dispatches -- integ-test-runner's and regression-test-runner's MAIN
    // anchors, 'featurePrompt,' and 'regressionPrompt,' -- each genuinely
    // match TWO agent() call sites, because each role's OWN resume prompt
    // re-embeds the same prompt variable verbatim, e.g. runner.js:6205's
    // "'...restated so a resumed dispatch never loses it: ' + featurePrompt,"
    // inside dispatchIntegResume's call text (mirrored at :7081 for
    // regressionPrompt/dispatchRegressionResume). That is real, deliberate
    // source text -- not a residue of the comment-swallowing bug -- so an
    // "exactly one" assertion would be a standing false failure for these two
    // roles unless/until their anchors are redesigned to exclude the shared
    // prompt variable name, which is anchor-authoring work outside this
    // bead's scope (its title pins an anchor to A real call site, not to its
    // own EXCLUSIVE call site).
    const agentSitesByFile = new Map(
        guardedModulePaths().map((p) => [
            path.basename(p),
            findCallSites(fs.readFileSync(p, 'utf8')).filter((s) => s.fnName === 'agent'),
        ])
    );

    /** {file, line}[] of every real agent() call site whose text contains `anchor`. */
    function sitesMatchingAnchor(anchor) {
        const matches = [];
        for (const [file, sites] of agentSitesByFile) {
            for (const site of sites) {
                if (site.callText.includes(anchor)) matches.push(`${file}:${site.line}`);
            }
        }
        return matches;
    }

    for (const dispatch of allDispatchPolicies()) {
        test(`role '${dispatch.role}' (kind=${dispatch.kind}) anchor ${JSON.stringify(dispatch.ladderAnchor)} matches a real agent() call site`, () => {
            const matches = sitesMatchingAnchor(dispatch.ladderAnchor);
            assert.ok(
                matches.length >= 1,
                `role '${dispatch.role}' (kind=${dispatch.kind}) ladderAnchor ${JSON.stringify(dispatch.ladderAnchor)} ` +
                'matches NO agent() call site in the guarded-module set -- if this role were ever marked migrated, ' +
                'the inline-ladder guard would silently report zero violations for it no matter what runner.js still does.'
            );
        });
    }

    test('every real dispatch anchor is covered by the loop above (count sanity)', () => {
        // Guards the loop itself: if allDispatchPolicies() ever returned an
        // empty/short list (e.g. a de-duplication bug), the per-dispatch
        // tests above would silently not exist rather than fail.
        assert.strictEqual(allDispatchPolicies().length, 22, 'expected 22 distinct real dispatches (11 role ladders x main + resume/re-ask) -- if this changed, a role ladder was added/removed; update this count deliberately.');
    });

    test('falsification: an anchor that matches no source text is caught', () => {
        // FALSIFIABILITY: proves the assertion above is not vacuous by
        // running the SAME matcher against an anchor that cannot occur in
        // real source, and checking it correctly finds nothing.
        const bogusAnchor = '__apra_fleet_3swo_35_this_anchor_never_appears_in_runner_js__';
        assert.deepStrictEqual(sitesMatchingAnchor(bogusAnchor), []);
    });
});
