import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    createBeadsScope, discoverScope, buildBeadGraph, classifyVerifySet, isBeadsMutatingCommand,
} from '../fleet-sprint/beads-scope.mjs';
import * as runner from '../fleet-sprint/runner.js';
import { parseBdJson } from '../fleet-sprint/runner.js';

// =============================================================================
// apra-fleet-3swo.4.6 -- beads-scope.mjs extraction.
//
// Two things are pinned here:
//
//   1. THE SNAPSHOT INVALIDATION CONTRACT, as beads-scope.mjs's header writes
//      it down: the shared full-DB snapshot lives at most one phase. A bead
//      created MID-PHASE (the planner's case -- it mutates beads on its own
//      clone, never through the orchestrator's command() wrapper) must stay
//      invisible until the next phase boundary, and must be visible right
//      after it. This is exercised through the REAL wrapCommand()/wrapPhase()
//      seams runner.js installs, not a re-derivation of the rule in the test.
//
//   2. THE SINGLE BFS. Before the extraction the scope rule existed twice --
//      once inside bdListScoped()'s closure and once inside classifyVerifySet()
//      -- and the two could drift. Both PRE-REFACTOR copies are reproduced
//      verbatim below as independent oracles, and the new shared
//      discoverScope() is asserted to agree with both on a fixture graph that
//      includes a grandchild (depth 2, which `bd list --parent` cannot see)
//      and a cross-parent bead (a whole subtree hanging off a NON-target
//      root, which must stay out of scope).
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = path.join(__dirname, '../fleet-sprint/runner.js');
const BEADS_SCOPE_PATH = path.join(__dirname, '../fleet-sprint/beads-scope.mjs');

// -----------------------------------------------------------------------------
// The two PRE-REFACTOR BFS copies, transcribed from runner.js at the parent of
// the extraction commit. These are the oracles: they are deliberately NOT
// imported from the module under test, so "the new implementation matches the
// old result" is a real comparison rather than a tautology.
// -----------------------------------------------------------------------------

/** bdListScoped()'s pre-refactor in-closure copy. */
function preRefactorScopeIdsFromBdListScoped(allBeads, targetIssues) {
    const childrenOf = new Map();
    for (const b of allBeads) {
        if (b && b.parent !== undefined && b.parent !== null && b.parent !== '') {
            if (!childrenOf.has(b.parent)) childrenOf.set(b.parent, []);
            childrenOf.get(b.parent).push(b);
        }
    }
    const scopeIds = new Set();
    const frontier = [...targetIssues];
    while (frontier.length > 0) {
        const id = frontier.shift();
        for (const child of (childrenOf.get(id) || [])) {
            if (!scopeIds.has(child.id)) {
                scopeIds.add(child.id);
                frontier.push(child.id);
            }
        }
    }
    for (const id of targetIssues) {
        scopeIds.add(id);
    }
    return scopeIds;
}

/** classifyVerifySet()'s pre-refactor standalone copy. */
function preRefactorScopeIdsFromClassifyVerifySet(allBeads, targetIssues) {
    const childrenOf = new Map();
    for (const b of (allBeads || [])) {
        if (b && b.parent) {
            if (!childrenOf.has(b.parent)) childrenOf.set(b.parent, []);
            childrenOf.get(b.parent).push(b);
        }
    }
    const scopeIds = new Set();
    const frontier = [...(targetIssues || [])];
    while (frontier.length > 0) {
        const id = frontier.shift();
        for (const child of (childrenOf.get(id) || [])) {
            if (!scopeIds.has(child.id)) {
                scopeIds.add(child.id);
                frontier.push(child.id);
            }
        }
    }
    for (const id of (targetIssues || [])) scopeIds.add(id);
    return scopeIds;
}

// A fixture bead graph with BOTH shapes the acceptance criteria name:
//   - a grandchild (root -> feat-a -> task-a1 -> task-a1a, i.e. depth 3), and
//   - a cross-parent bead: other-root and its child live under a DIFFERENT,
//     non-target root and must never enter scope.
const FIXTURE_BEADS = [
    { id: 'root', status: 'open', title: 'sprint root' },
    { id: 'feat-a', parent: 'root', status: 'open', title: 'feature a' },
    { id: 'task-a1', parent: 'feat-a', status: 'closed', title: 'task a1' },
    { id: 'task-a1a', parent: 'task-a1', status: 'open', title: 'grandchild of feat-a' },
    // Depth 3, and verify-eligible (its only child is closed): a scope walk
    // that is not a full BFS cannot see it at all.
    { id: 'leaf-a1a1', parent: 'task-a1a', status: 'closed', title: 'great-grandchild of feat-a' },
    { id: 'feat-b', parent: 'root', status: 'open', title: 'feature b' },
    { id: 'task-b1', parent: 'feat-b', status: 'closed', title: 'task b1' },
    { id: 'other-root', status: 'open', title: 'a different root entirely' },
    { id: 'cross-parent', parent: 'other-root', status: 'open', title: 'out of scope' },
    { id: 'orphan', status: 'open', title: 'no parent, not a target' },
];

const sorted = (ids) => [...ids].sort();

describe('apra-fleet-3swo.4.6: ONE shared BFS scope-discovery implementation', () => {
    test('discoverScope matches BOTH pre-refactor copies on a graph with a grandchild and a cross-parent bead', () => {
        for (const targets of [['root'], ['root', 'other-root'], ['feat-a'], ['orphan'], []]) {
            const actual = sorted(discoverScope(FIXTURE_BEADS, targets).scopeIds);
            assert.deepEqual(
                actual,
                sorted(preRefactorScopeIdsFromBdListScoped(FIXTURE_BEADS, targets)),
                `bdListScoped's pre-refactor scope differs for targets ${JSON.stringify(targets)}`
            );
            assert.deepEqual(
                actual,
                sorted(preRefactorScopeIdsFromClassifyVerifySet(FIXTURE_BEADS, targets)),
                `classifyVerifySet's pre-refactor scope differs for targets ${JSON.stringify(targets)}`
            );
        }
    });

    test('the grandchild is in scope and the cross-parent subtree is not', () => {
        const { scopeIds } = discoverScope(FIXTURE_BEADS, ['root']);
        assert.deepEqual(
            sorted(scopeIds),
            ['feat-a', 'feat-b', 'leaf-a1a1', 'root', 'task-a1', 'task-a1a', 'task-b1'],
            'scope must include every descendant at any depth and nothing under another root'
        );
        assert.ok(scopeIds.has('task-a1a'), 'the depth-3 grandchild must be in scope');
        assert.ok(!scopeIds.has('cross-parent'), 'a bead under a non-target root must stay out of scope');
        assert.ok(!scopeIds.has('other-root'), 'a non-target root must stay out of scope');
        assert.ok(!scopeIds.has('orphan'), 'a parent-less non-target bead must stay out of scope');
    });

    test('a childless target seeds its own id (the BFS alone would yield an empty scope)', () => {
        const { scopeIds } = discoverScope(FIXTURE_BEADS, ['orphan']);
        assert.deepEqual(sorted(scopeIds), ['orphan']);
    });

    test('buildBeadGraph never keys childrenOf on an empty/absent parent', () => {
        const { childrenOf } = buildBeadGraph([
            { id: 'a' },
            { id: 'b', parent: '' },
            { id: 'c', parent: null },
            { id: 'd', parent: undefined },
            { id: 'e', parent: 'a' },
            null,
        ]);
        assert.deepEqual([...childrenOf.keys()], ['a']);
        assert.deepEqual(childrenOf.get('a').map((b) => b.id), ['e']);
    });

    test('classifyVerifySet routes on the SAME scope discoverScope reports', () => {
        // feat-a and feat-b each have exactly one child and it is closed, so
        // both are verify-eligible -- eligibility looks at DIRECT children
        // only. task-a1 is NOT eligible despite being in scope: its own child
        // (the grandchild task-a1a) is still open. The cross-parent subtree is
        // invisible either way.
        const { verifyIds } = classifyVerifySet(FIXTURE_BEADS, ['root']);
        assert.deepEqual(
            verifyIds.sort(), ['feat-a', 'feat-b', 'task-a1a'],
            'task-a1a is verify-eligible at DEPTH 3 -- a classifier walking anything less than the full BFS cannot see it'
        );
        assert.ok(!verifyIds.includes('task-a1'), 'a parent with an open child is never verify-routed');
        assert.ok(!verifyIds.includes('leaf-a1a1'), 'a childless leaf is never verify-routed');

        const crossParentClosed = [
            ...FIXTURE_BEADS.filter((b) => b.id !== 'cross-parent'),
            { id: 'cross-parent', parent: 'other-root', status: 'closed', title: 'out of scope' },
        ];
        assert.deepEqual(
            classifyVerifySet(crossParentClosed, ['root']).verifyIds.sort(),
            ['feat-a', 'feat-b', 'task-a1a'],
            'an all-children-closed parent under a NON-target root must never be verify-routed'
        );
        assert.deepEqual(
            classifyVerifySet(crossParentClosed, ['root', 'other-root']).verifyIds.sort(),
            ['feat-a', 'feat-b', 'other-root', 'task-a1a'],
            'the same parent IS verify-routed once its root is a sprint target'
        );
    });

    test('runner.js still re-exports classifyVerifySet, and it is the beads-scope.mjs implementation', () => {
        assert.equal(typeof runner.classifyVerifySet, 'function');
        assert.equal(runner.classifyVerifySet, classifyVerifySet, 'runner.js must re-export, not re-implement');
    });

    test('the stale "~line 5099" pointer is gone from both files', () => {
        for (const p of [RUNNER_PATH, BEADS_SCOPE_PATH]) {
            const src = fs.readFileSync(p, 'utf8');
            assert.ok(
                !/~line\s*5099/.test(src),
                `${path.basename(p)} still carries the stale "~line 5099" pointer to bdListScoped; reference the SYMBOL, not a line number`
            );
        }
    });
});

// -----------------------------------------------------------------------------
// The snapshot invalidation contract.
// -----------------------------------------------------------------------------

/**
 * A scope client wired to an in-memory bead DB the test can mutate BEHIND the
 * command() seam -- exactly how a planner/doer/integ-runner mutates beads on
 * its own clone, invisibly to the orchestrator's wrapper.
 */
function buildScopeHarness({ targetIssues = ['root'], assignee = null, beads = [] } = {}) {
    const db = { beads: [...beads] };
    const commandLog = [];
    const phaseLog = [];

    const scope = createBeadsScope({
        targetIssues,
        assignee,
        parseBdJson,
        getOrchestratorMember: () => 'orchestrator-member',
    });

    // A minimal `bd list` stand-in: the full-DB read returns everything, and a
    // filtered read honours `--status=` (the only bd-side property these tests
    // exercise) so a "fresh read" is genuinely fresher than the snapshot.
    const rawCommand = async (cmdStr, opts) => {
        commandLog.push({ cmd: cmdStr, opts });
        if (/^bd list --all/.test(cmdStr)) return JSON.stringify(db.beads);
        if (/^bd list /.test(cmdStr)) {
            const status = /--status=([^\s]+)/.exec(cmdStr);
            const rows = status ? db.beads.filter((b) => b.status === status[1]) : db.beads;
            return JSON.stringify(rows);
        }
        return '';
    };
    const command = scope.wrapCommand(rawCommand, {
        onCommand: (trimmed, opts) => { commandLog[commandLog.length - 1].hook = { trimmed, member: opts && opts.member_name }; },
    });
    const phase = scope.wrapPhase((title) => { phaseLog.push(title); return title; });

    return { scope, db, command, phase, commandLog, phaseLog,
        fullFetches: () => commandLog.filter((e) => e.cmd === 'bd list --all --limit 0 --json').length };
}

describe('apra-fleet-3swo.4.6: the snapshot invalidation contract, enforced', () => {
    test('a bead created MID-PHASE is invisible until the next phase boundary, and visible after it', async () => {
        const h = buildScopeHarness({
            targetIssues: ['root'],
            beads: [{ id: 'root', status: 'open' }, { id: 'a', parent: 'root', status: 'open' }],
        });

        const first = await h.scope.fetchAllBeadsShared();
        assert.deepEqual(first.map((b) => b.id), ['root', 'a']);
        assert.equal(h.fullFetches(), 1, 'exactly one full-DB fetch so far');

        // A role creates a bead on ITS OWN clone -- never through command().
        h.db.beads.push({ id: 'b', parent: 'root', status: 'open' });

        const midPhase = await h.scope.fetchAllBeadsShared();
        assert.deepEqual(
            midPhase.map((b) => b.id), ['root', 'a'],
            'mid-phase reads must be served from the snapshot -- the new bead is NOT visible yet'
        );
        assert.deepEqual(
            (await h.scope.bdListScoped('')).map((b) => b.id), ['root', 'a'],
            'bdListScoped("") reads the same snapshot, so it cannot see the new bead either'
        );
        assert.equal(h.fullFetches(), 1, 'still exactly one full-DB fetch: the snapshot was reused');

        h.phase('Plan C1 R2');

        const afterPhase = await h.scope.fetchAllBeadsShared();
        assert.deepEqual(
            afterPhase.map((b) => b.id), ['root', 'a', 'b'],
            'the phase boundary must drop the snapshot, making the new bead visible'
        );
        assert.equal(h.fullFetches(), 2, 'the phase boundary forces exactly one new full-DB fetch');
        assert.deepEqual(h.phaseLog, ['Plan C1 R2'], 'wrapPhase must still delegate to the raw phase()');
    });

    test('an explicit invalidateAllBeadsCache() (the planner-dispatch clause) makes a mid-phase bead visible with no phase boundary', async () => {
        const h = buildScopeHarness({ beads: [{ id: 'root', status: 'open' }] });
        await h.scope.fetchAllBeadsShared();
        h.db.beads.push({ id: 'planned', parent: 'root', status: 'open' });
        assert.equal((await h.scope.fetchAllBeadsShared()).length, 1);

        h.scope.invalidateAllBeadsCache();

        assert.deepEqual((await h.scope.fetchAllBeadsShared()).map((b) => b.id), ['root', 'planned']);
        assert.equal(h.phaseLog.length, 0, 'no phase() call was needed');
    });

    test('a beads-MUTATING command through the wrapper drops the snapshot; a bd READ does not', async () => {
        const h = buildScopeHarness({ beads: [{ id: 'root', status: 'open' }] });
        await h.scope.fetchAllBeadsShared();
        assert.ok(h.scope.hasCachedSnapshot());

        await h.command('bd list --status=open --json', { member_name: 'm' });
        assert.ok(h.scope.hasCachedSnapshot(), 'bd list is a known read: the snapshot survives');
        await h.command('bd show root --json', { member_name: 'm' });
        assert.ok(h.scope.hasCachedSnapshot(), 'bd show is a known read: the snapshot survives');
        await h.command('git status --porcelain', { member_name: 'm' });
        assert.ok(h.scope.hasCachedSnapshot(), 'a non-bd command never touches beads state');

        await h.command('bd close root', { member_name: 'm' });
        assert.ok(!h.scope.hasCachedSnapshot(), 'bd close is a mutation: the snapshot must be dropped');

        await h.scope.fetchAllBeadsShared();
        await h.command('bd frobnicate --whatever', { member_name: 'm' });
        assert.ok(
            !h.scope.hasCachedSnapshot(),
            'an UNRECOGNIZED bd subcommand is conservatively a mutation -- a redundant fetch is the safe failure'
        );
    });

    test('isBeadsMutatingCommand classifies the documented read/mutate split', () => {
        for (const read of ['bd list --all --limit 0 --json', 'bd show x', 'bd ready', 'bd config get sync.remote', '  BD LIST --json  ']) {
            assert.equal(isBeadsMutatingCommand(read), false, `${read} must be treated as a read`);
        }
        for (const mut of ['bd close x', 'bd create --title t', 'bd update x --claim', 'bd note x --file f', 'bd dep add a b', 'bd dolt pull', 'bd frobnicate']) {
            assert.equal(isBeadsMutatingCommand(mut), true, `${mut} must be treated as a mutation`);
        }
        for (const other of ['git status', 'node -e ""', '', null, undefined, 42]) {
            assert.equal(isBeadsMutatingCommand(other), false, 'non-bd input is never a beads mutation');
        }
    });

    test('the wrapper still delegates its non-snapshot hook (DoltSync memo seam) on every command', async () => {
        const h = buildScopeHarness({ beads: [] });
        await h.command('bd config set sync.remote origin', { member_name: 'member-1' });
        const last = h.commandLog[h.commandLog.length - 1];
        assert.deepEqual(last.hook, { trimmed: 'bd config set sync.remote origin', member: 'member-1' });
    });

    test('a FILTERED bdListScoped call always issues a fresh bd list -- this is the deliberate cache-bypass path', async () => {
        const h = buildScopeHarness({
            beads: [{ id: 'root', status: 'open' }, { id: 'a', parent: 'root', status: 'open' }],
        });
        await h.scope.fetchAllBeadsShared();
        const before = h.commandLog.length;

        // An agent closes an ALREADY-IN-SCOPE bead on its own clone, behind
        // the command() seam -- exactly the case the three bypass sites exist
        // for (stall-detection counts, the verify-set exit check, Final
        // Review's closed count).
        h.db.beads.find((b) => b.id === 'a').status = 'closed';
        const fresh = await h.scope.bdListScoped('--status=closed --json');

        assert.ok(
            h.commandLog.length > before && h.commandLog[h.commandLog.length - 1].cmd === 'bd list --status=closed --json --limit 0',
            'a filtered read must issue a real command, not be served from the snapshot'
        );
        assert.deepEqual(
            fresh.map((b) => b.id), ['a'],
            'the fresh read must see a closure an agent made behind the command() seam'
        );
        assert.equal(h.fullFetches(), 1, 'the SCOPE still came from the cached snapshot -- only the filter result is fresh');
        assert.equal(
            (await h.scope.fetchAllBeadsShared()).find((b) => b.id === 'a').status, 'open',
            'the snapshot itself is untouched by the bypass read -- it still shows the pre-closure status'
        );
    });

    test('the bypass gives fresh STATUS, not fresh SCOPE: a bead CREATED behind the seam stays invisible until the snapshot drops', async () => {
        const h = buildScopeHarness({
            beads: [{ id: 'root', status: 'open' }, { id: 'a', parent: 'root', status: 'closed' }],
        });
        await h.scope.fetchAllBeadsShared();

        h.db.beads.push({ id: 'born-mid-phase', parent: 'root', status: 'closed' });
        assert.deepEqual(
            (await h.scope.bdListScoped('--status=closed --json')).map((b) => b.id), ['a'],
            'scope membership comes from the CACHED snapshot, so a brand-new bead is filtered out even by a fresh read'
        );

        h.phase('next');
        assert.deepEqual(
            (await h.scope.bdListScoped('--status=closed --json')).map((b) => b.id).sort(), ['a', 'born-mid-phase'],
            'once the phase boundary drops the snapshot, the new bead enters scope'
        );
    });

    test('--assignee narrows a filtered read, and scope still filters the result', async () => {
        const h = buildScopeHarness({
            assignee: 'sprint-bot',
            beads: [{ id: 'root', status: 'open' }, { id: 'a', parent: 'root', status: 'open' }, { id: 'elsewhere', status: 'open' }],
        });
        const out = await h.scope.bdListScoped('--ready --json');
        assert.equal(h.commandLog[h.commandLog.length - 1].cmd, 'bd list --ready --json --assignee sprint-bot --limit 0');
        assert.deepEqual(out.map((b) => b.id), ['root', 'a'], 'out-of-scope rows are dropped from a filtered read');
    });

    test('every read this module issues carries member_name, and goes through the invalidating wrapper', async () => {
        const h = buildScopeHarness({ beads: [{ id: 'root', status: 'open' }] });
        await h.scope.bdListScoped('--ready --json');
        assert.ok(h.commandLog.length >= 2);
        for (const entry of h.commandLog) {
            assert.equal(entry.opts.member_name, 'orchestrator-member', `missing member_name on: ${entry.cmd}`);
            assert.ok(entry.hook, `command "${entry.cmd}" bypassed the wrapCommand seam`);
        }
    });

    test('concurrent callers coalesce onto ONE full-DB fetch', async () => {
        const h = buildScopeHarness({ beads: [{ id: 'root', status: 'open' }] });
        await Promise.all([
            h.scope.fetchAllBeadsShared(), h.scope.fetchAllBeadsShared(), h.scope.bdListScoped(''), h.scope.bdListScoped(''),
        ]);
        assert.equal(h.fullFetches(), 1, 'the replay shim matches recorded responses FIFO per command string; N identical concurrent fetches have no reliable order');
    });

    test('an empty target list yields an empty scope without issuing a filtered read', async () => {
        const h = buildScopeHarness({ targetIssues: [], beads: [{ id: 'root', status: 'open' }] });
        assert.deepEqual(await h.scope.bdListScoped('--ready --json'), []);
        assert.equal(h.commandLog.filter((e) => e.cmd.startsWith('bd list --ready')).length, 0);
    });

    test('a read before wrapCommand() is installed fails loudly rather than silently bypassing invalidation', async () => {
        const scope = createBeadsScope({ targetIssues: ['root'], parseBdJson, getOrchestratorMember: () => 'm' });
        await assert.rejects(() => scope.fetchAllBeadsShared(), /wrapCommand\(\) must be installed/);
    });

    test('createBeadsScope refuses missing injected dependencies', () => {
        assert.throws(() => createBeadsScope({ targetIssues: ['root'], getOrchestratorMember: () => 'm' }), /parseBdJson/);
        assert.throws(() => createBeadsScope({ targetIssues: ['root'], parseBdJson }), /getOrchestratorMember/);
    });
});
