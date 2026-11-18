// Unit tests for the parent-link guard (fleet-sprint/parent-link-guard.mjs,
// wired into createBeadsScope in fleet-sprint/beads-scope.mjs):
//   - a vanished, unremoved in-scope parent-child edge is restored on the next
//     fresh snapshot, with an ERROR naming child and parent;
//   - an edge this run itself removed is NOT restored;
//   - a failed restore is loud (ERROR logged AND a thrown error);
//   - a bead once seen as a parent is never returned as a dispatchable leaf,
//     even when the current snapshot shows it childless;
//   - a descendant once in scope stays in scope.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createBeadsScope } from '../fleet-sprint/beads-scope.mjs';
import { parseBdJson } from '../fleet-sprint/runner.js';
import {
    createParentLinkLedger, parseRunEdgeChange, ParentLinkRestoreError,
} from '../fleet-sprint/parent-link-guard.mjs';

/**
 * A createBeadsScope over an in-memory bead table. `bd update <c> --parent
 * <p>` and `bd dep remove <c> <p>` really change the table; `failRestore`
 * makes every `bd update ... --parent` fail (failSoft shape).
 */
function buildHarness({ beads, targetIssues = ['root'], failRestore = false, restoreThrows = false } = {}) {
    const db = { beads: beads.map((b) => ({ ...b })) };
    const commandLog = [];
    const logs = [];
    const scope = createBeadsScope({
        targetIssues,
        parseBdJson,
        getBacklogMember: () => 'backlog-member',
        log: (line) => logs.push(line),
    });
    const rawCommand = async (cmd, opts = {}) => {
        commandLog.push(cmd);
        if (/^bd list --all/.test(cmd)) return JSON.stringify(db.beads);
        if (/^bd list --ready/.test(cmd)) {
            const parents = new Set(db.beads.filter((b) => b.parent).map((b) => b.parent));
            return JSON.stringify(db.beads.filter((b) => b.status === 'open' && !parents.has(b.id)));
        }
        const up = /^bd update (\S+) --parent (\S+)$/.exec(cmd);
        if (up) {
            if (restoreThrows) throw new Error('member unreachable');
            if (failRestore) return opts.failSoft ? { ok: false, output: '', error: 'Error: issue not found' } : '';
            const bead = db.beads.find((b) => b.id === up[1]);
            bead.parent = up[2];
            return opts.failSoft ? { ok: true, output: '', error: null } : '';
        }
        const rm = /^bd dep remove (\S+) (\S+)$/.exec(cmd);
        if (rm) {
            const bead = db.beads.find((b) => b.id === rm[1]);
            if (bead && bead.parent === rm[2]) delete bead.parent;
            return '';
        }
        return '';
    };
    const command = scope.wrapCommand(rawCommand);
    const phase = scope.wrapPhase((title) => title);
    /** An edge dropped OUTSIDE this run (a beads merge on another clone). */
    const dropEdgeExternally = (child) => { delete db.beads.find((b) => b.id === child).parent; };
    return { scope, db, command, phase, commandLog, logs, dropEdgeExternally };
}

const TREE = [
    { id: 'root', status: 'open', issue_type: 'bug' },
    { id: 'feat-a', parent: 'root', status: 'open', issue_type: 'feature' },
    { id: 'feat-b', parent: 'root', status: 'open', issue_type: 'feature' },
    { id: 'leaf-a1', parent: 'feat-a', status: 'open', issue_type: 'task' },
    { id: 'leaf-b1', parent: 'feat-b', status: 'open', issue_type: 'task' },
    { id: 'outsider', status: 'open', issue_type: 'task' },
];

describe('parent-link guard: vanished parent-child links', () => {
    test('restores exactly the vanished, unremoved in-scope edges and logs an ERROR naming child and parent', async () => {
        const h = buildHarness({ beads: TREE });
        await h.scope.fetchAllBeadsShared();

        h.dropEdgeExternally('feat-a');
        h.dropEdgeExternally('leaf-a1');
        h.phase('Develop C1 R2');
        const after = await h.scope.fetchAllBeadsShared();

        const restoreCmds = h.commandLog.filter((c) => /^bd update \S+ --parent /.test(c)).sort();
        assert.deepEqual(restoreCmds, ['bd update feat-a --parent root', 'bd update leaf-a1 --parent feat-a']);
        const errors = h.logs.filter((l) => l.startsWith('ERROR: parent-child link vanished'));
        assert.equal(errors.length, 2, h.logs.join('\n'));
        assert.ok(errors.some((l) => l.includes("'feat-a'") && l.includes("'root'")), errors.join('\n'));
        assert.ok(errors.some((l) => l.includes("'leaf-a1'") && l.includes("'feat-a'")), errors.join('\n'));

        // The DB really carries the edges again, and this phase's snapshot
        // already shows them (no second full fetch needed).
        assert.equal(h.db.beads.find((b) => b.id === 'feat-a').parent, 'root');
        assert.equal(h.db.beads.find((b) => b.id === 'leaf-a1').parent, 'feat-a');
        assert.equal(after.find((b) => b.id === 'feat-a').parent, 'root');
        assert.equal(after.find((b) => b.id === 'leaf-a1').parent, 'feat-a');
        assert.equal(h.commandLog.filter((c) => c.startsWith('bd list --all')).length, 2);
        const scoped = (await h.scope.bdListScoped('')).map((b) => b.id).sort();
        assert.deepEqual(scoped, ['feat-a', 'feat-b', 'leaf-a1', 'leaf-b1', 'root']);
    });

    test('an edge this run itself removed (through the command path) is NOT restored', async () => {
        const h = buildHarness({ beads: TREE });
        await h.scope.fetchAllBeadsShared();

        await h.command('bd dep remove leaf-b1 feat-b', { member_name: 'backlog-member' });
        h.dropEdgeExternally('leaf-a1'); // and one dropped by someone else
        h.phase('Plan C2 R1');
        await h.scope.fetchAllBeadsShared();

        const restoreCmds = h.commandLog.filter((c) => /^bd update \S+ --parent /.test(c));
        assert.deepEqual(restoreCmds, ['bd update leaf-a1 --parent feat-a'], 'only the externally dropped edge is restored');
        assert.equal(h.db.beads.find((b) => b.id === 'leaf-b1').parent, undefined, 'the run-removed edge stays removed');
        assert.ok(!h.logs.some((l) => l.includes("'leaf-b1'")), h.logs.join('\n'));
    });

    test('a run reparent (bd update --parent) moves the recorded edge; a child moved by another actor is not "restored"', async () => {
        const h = buildHarness({ beads: TREE });
        await h.scope.fetchAllBeadsShared();
        await h.command('bd update leaf-a1 --parent feat-b', { member_name: 'backlog-member' });
        h.db.beads.find((b) => b.id === 'leaf-b1').parent = 'outsider'; // moved elsewhere, not dropped
        h.phase('Route C2');
        await h.scope.fetchAllBeadsShared();
        assert.deepEqual(h.commandLog.filter((c) => /^bd update \S+ --parent /.test(c)), ['bd update leaf-a1 --parent feat-b']);
        assert.equal(h.logs.length, 0, h.logs.join('\n'));
    });

    test('a failed restore is loud: an ERROR line AND a thrown ParentLinkRestoreError (failSoft result)', async () => {
        const h = buildHarness({ beads: TREE, failRestore: true });
        await h.scope.fetchAllBeadsShared();
        h.dropEdgeExternally('feat-b');
        h.phase('Develop C1 R2');
        await assert.rejects(h.scope.fetchAllBeadsShared(), (err) => {
            assert.ok(err instanceof ParentLinkRestoreError, String(err));
            assert.match(err.message, /could not restore the vanished parent-child link 'feat-b' -> parent 'root': Error: issue not found/);
            return true;
        });
        assert.ok(h.logs.some((l) => l.startsWith('ERROR: could not restore') && l.includes("'feat-b'")), h.logs.join('\n'));
        assert.ok(!h.scope.hasCachedSnapshot(), 'no snapshot is published from a scope that lost its children');
    });

    test('a restore command that throws is loud too', async () => {
        const h = buildHarness({ beads: TREE, restoreThrows: true });
        await h.scope.fetchAllBeadsShared();
        h.dropEdgeExternally('leaf-b1');
        h.phase('Develop C1 R2');
        await assert.rejects(h.scope.fetchAllBeadsShared(), /member unreachable/);
        assert.ok(h.logs.some((l) => l.startsWith('ERROR: could not restore') && l.includes("'leaf-b1'")), h.logs.join('\n'));
    });
});

describe('parent-link guard: monotone parenthood and scope', () => {
    test('a bead once seen as a parent is never returned as a dispatchable leaf, even when the snapshot shows it childless', async () => {
        const h = buildHarness({ beads: TREE });
        await h.scope.fetchAllBeadsShared();
        // The only child of feat-a disappears entirely (nothing to restore).
        h.db.beads = h.db.beads.filter((b) => b.id !== 'leaf-a1');
        h.phase('Develop C1 R2');

        const ready = (await h.scope.readyLeafBeads()).map((b) => b.id).sort();
        assert.ok(!ready.includes('feat-a'), `feat-a was seen as a parent: never a leaf (${ready})`);
        assert.deepEqual(ready, ['leaf-b1']);
        assert.ok((await h.scope.decomposedParentIds()).has('feat-a'));

        // Non-vacuous: a fresh run with no history WOULD call it a leaf.
        const fresh = buildHarness({ beads: h.db.beads });
        assert.ok((await fresh.scope.readyLeafBeads()).some((b) => b.id === 'feat-a'));
    });

    test('a descendant once in scope stays in scope after another actor moves it out', async () => {
        const h = buildHarness({ beads: TREE });
        await h.scope.fetchAllBeadsShared();
        h.db.beads.find((b) => b.id === 'feat-b').parent = 'outsider';
        h.phase('Route C2');
        const scoped = (await h.scope.bdListScoped('')).map((b) => b.id);
        assert.ok(scoped.includes('feat-b'), scoped.join(','));
        assert.ok(!scoped.includes('outsider'), 'monotone scope does not pull in new strangers');
    });
});

describe('parent-link guard: pure helpers', () => {
    test('parseRunEdgeChange reads reparent and removal forms', () => {
        assert.deepEqual(parseRunEdgeChange('bd update a.1 --parent a'), { kind: 'reparent', child: 'a.1', parent: 'a' });
        assert.deepEqual(parseRunEdgeChange('bd update a.1 --status=open --parent=b'), { kind: 'reparent', child: 'a.1', parent: 'b' });
        assert.deepEqual(parseRunEdgeChange('bd update a.1 --parent ""'), { kind: 'reparent', child: 'a.1', parent: '' });
        assert.deepEqual(parseRunEdgeChange('bd dep remove c p'), { kind: 'remove', a: 'c', b: 'p' });
        assert.deepEqual(parseRunEdgeChange('bd dep rm c p'), { kind: 'remove', a: 'c', b: 'p' });
        assert.equal(parseRunEdgeChange('bd update a.1 --status=closed'), null);
        assert.equal(parseRunEdgeChange('bd list --parent a --json'), null);
        assert.equal(parseRunEdgeChange(null), null);
    });

    test('the ledger ignores out-of-scope edges and children that were deleted', () => {
        const ledger = createParentLinkLedger();
        const beads = [{ id: 'r' }, { id: 'c', parent: 'r' }, { id: 'x', parent: 'y' }];
        ledger.observe(beads, new Set(['r', 'c']));
        assert.deepEqual(ledger.findVanished([{ id: 'r' }, { id: 'x' }]), [], 'a deleted child is not a vanished edge');
        assert.deepEqual(ledger.findVanished([{ id: 'r' }, { id: 'c' }, { id: 'x' }]), [{ child: 'c', parent: 'r' }]);
        assert.deepEqual([...ledger.knownParentIds()], ['r']);
    });
});
