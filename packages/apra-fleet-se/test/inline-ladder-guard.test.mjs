import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkModules, findInlineLadderViolations, memberExprFor } from '../fleet-sprint/inline-ladder-guard.mjs';
import { GUARDED_MODULES, guardedModulePaths, guardedModuleBasenames } from '../fleet-sprint/guarded-modules.mjs';
import { ROLE_POLICIES, migratedRoleNames } from '../fleet-sprint/role-policies.mjs';

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
});
