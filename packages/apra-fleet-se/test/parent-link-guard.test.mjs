// Unit tests for the parent-link guard (fleet-sprint/parent-link-guard.mjs,
// wired into createBeadsScope in fleet-sprint/beads-scope.mjs):
//   - a vanished, unremoved in-scope parent-child edge is restored on the next
//     fresh snapshot, with an ERROR naming child and parent;
//   - an edge this run itself removed is NOT restored;
//   - a failed restore is loud (ERROR logged AND a thrown error);
//   - a parent whose link a merge dropped is never returned as a
//     dispatchable leaf;
//   - an edge whose parent or child was deleted is dropped with a WARN, never
//     restored, and never aborts the run;
//   - a parent whose children were all moved to another parent (or deleted)
//     stops being a parent and is routed as a leaf;
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
        // feat-a's only child was moved away by this run: feat-a is no longer a parent.
        assert.ok(!h.scope.knownParentIds().has('feat-a'), [...h.scope.knownParentIds()].join(','));
        assert.ok(h.scope.knownParentIds().has('feat-b'));
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

describe('parent-link guard: parenthood and scope', () => {
    test('a parent whose only child lost its link to a merge is never returned as a dispatchable leaf', async () => {
        const h = buildHarness({ beads: TREE });
        await h.scope.fetchAllBeadsShared();
        h.dropEdgeExternally('leaf-a1');
        h.phase('Develop C1 R2');
        const ready = (await h.scope.readyLeafBeads()).map((b) => b.id).sort();
        assert.ok(!ready.includes('feat-a'), `feat-a lost its link to a merge: never a leaf (${ready})`);
        assert.ok((await h.scope.decomposedParentIds()).has('feat-a'));
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

describe('parent-link guard: deleted endpoints', () => {
    test('a parent deleted mid-run is not a merge loss: WARN once, no restore, no ParentLinkRestoreError', async () => {
        // failRestore: any restore attempt would throw, so the test also
        // proves no restore is attempted.
        const h = buildHarness({ beads: TREE, failRestore: true });
        await h.scope.fetchAllBeadsShared();
        // `bd delete feat-b` removes the issue and every edge touching it.
        h.db.beads = h.db.beads.filter((b) => b.id !== 'feat-b');
        delete h.db.beads.find((b) => b.id === 'leaf-b1').parent;
        h.phase('Develop C1 R2');
        await h.scope.fetchAllBeadsShared();
        h.phase('Develop C1 R3');
        await h.scope.fetchAllBeadsShared();

        assert.deepEqual(h.commandLog.filter((c) => /^bd update \S+ --parent /.test(c)), []);
        assert.ok(!h.logs.some((l) => l.startsWith('ERROR')), h.logs.join('\n'));
        const warns = h.logs.filter((l) => l.startsWith('WARN: parent-child link'));
        // One WARN per dropped edge, once across both fresh snapshots: the
        // edge into the deleted parent, and the deleted bead's own edge up.
        assert.equal(warns.length, 2, h.logs.join('\n'));
        assert.ok(warns.some((w) => /'leaf-b1' -> parent 'feat-b'.*the parent 'feat-b' is no longer in the beads database/.test(w)), warns.join('\n'));
        assert.ok(warns.some((w) => /'feat-b' -> parent 'root'.*the child 'feat-b' is no longer in the beads database/.test(w)), warns.join('\n'));
        for (const w of warns) assert.doesNotMatch(w, /merge/);
        assert.ok(!h.scope.knownParentIds().has('feat-b'));
    });

    test('a deleted child is dropped with a WARN naming it; its parent, now childless, is routed as a leaf', async () => {
        const h = buildHarness({ beads: TREE });
        await h.scope.fetchAllBeadsShared();
        h.db.beads = h.db.beads.filter((b) => b.id !== 'leaf-a1');
        h.phase('Develop C1 R2');
        const ready = (await h.scope.readyLeafBeads()).map((b) => b.id).sort();
        assert.deepEqual(ready, ['feat-a', 'leaf-b1']);
        const warns = h.logs.filter((l) => l.startsWith('WARN: parent-child link'));
        assert.equal(warns.length, 1, h.logs.join('\n'));
        assert.match(warns[0], /the child 'leaf-a1' is no longer in the beads database/);
    });

    test('a restore that fails on beads that both exist still aborts loudly', async () => {
        const h = buildHarness({ beads: TREE, failRestore: true });
        await h.scope.fetchAllBeadsShared();
        h.dropEdgeExternally('leaf-a1');
        h.phase('Develop C1 R2');
        await assert.rejects(h.scope.fetchAllBeadsShared(), ParentLinkRestoreError);
    });
});

describe('parent-link guard: stranded parents', () => {
    test('a parent whose only child another actor re-parented elsewhere is routed as a leaf, with nothing restored', async () => {
        const h = buildHarness({ beads: TREE });
        await h.scope.fetchAllBeadsShared();
        h.db.beads.find((b) => b.id === 'leaf-a1').parent = 'feat-b';
        h.phase('Develop C1 R2');
        const ready = (await h.scope.readyLeafBeads()).map((b) => b.id).sort();
        assert.ok(ready.includes('feat-a'), `feat-a has no children left: a leaf (${ready})`);
        assert.ok(!(await h.scope.decomposedParentIds()).has('feat-a'));
        assert.ok((await h.scope.decomposedParentIds()).has('feat-b'));
        assert.deepEqual(h.commandLog.filter((c) => /^bd update \S+ --parent /.test(c)), []);
        assert.equal(h.logs.length, 0, h.logs.join('\n'));
    });

    test('ledger: a moved child releases its old parent only when no other recorded child points at it', () => {
        const ledger = createParentLinkLedger();
        const beads = [{ id: 'r' }, { id: 'p' }, { id: 'q' }, { id: 'c1', parent: 'p' }, { id: 'c2', parent: 'p' }];
        const scope = new Set(['r', 'p', 'q', 'c1', 'c2']);
        ledger.observe(beads, scope);
        let next = beads.map((b) => (b.id === 'c1' ? { ...b, parent: 'q' } : b));
        let r = ledger.reconcile(next);
        assert.deepEqual(r.moved, [{ child: 'c1', from: 'p', to: 'q' }]);
        assert.deepEqual(r.vanished, []);
        ledger.observe(next, scope);
        assert.deepEqual([...ledger.knownParentIds()].sort(), ['p', 'q'], 'p still has c2');
        next = next.map((b) => (b.id === 'c2' ? { ...b, parent: 'q' } : b));
        ledger.reconcile(next);
        ledger.observe(next, scope);
        assert.deepEqual([...ledger.knownParentIds()], ['q'], 'p has no children left');
    });
});

describe('parent-link guard: reverted reparents', () => {
    test('a run reparent that a lossy merge reverts is restored with an ERROR; the new parent stays a parent', async () => {
        const h = buildHarness({ beads: TREE });
        await h.scope.fetchAllBeadsShared();
        await h.command('bd update leaf-a1 --parent feat-b', { member_name: 'backlog-member' });
        h.phase('Develop C1 R2');
        await h.scope.fetchAllBeadsShared();
        // A merge keeps the older side: leaf-a1 is back under feat-a.
        h.db.beads.find((b) => b.id === 'leaf-a1').parent = 'feat-a';
        h.phase('Develop C1 R3');
        const after = await h.scope.fetchAllBeadsShared();

        const restores = h.commandLog.filter((c) => /^bd update \S+ --parent /.test(c));
        assert.deepEqual(restores, ['bd update leaf-a1 --parent feat-b', 'bd update leaf-a1 --parent feat-b']);
        const errors = h.logs.filter((l) => l.startsWith('ERROR: parent-child link reverted'));
        assert.equal(errors.length, 1, h.logs.join('\n'));
        assert.match(errors[0], /'leaf-a1' is back under 'feat-a'.*instead of 'feat-b'/);
        assert.equal(h.db.beads.find((b) => b.id === 'leaf-a1').parent, 'feat-b');
        assert.equal(after.find((b) => b.id === 'leaf-a1').parent, 'feat-b');
        assert.ok(h.scope.knownParentIds().has('feat-b'));
    });

    test('a child another actor moved and a merge then moved back is restored onto the newer parent', async () => {
        const h = buildHarness({ beads: TREE });
        await h.scope.fetchAllBeadsShared();
        h.db.beads.find((b) => b.id === 'leaf-b1').parent = 'feat-a'; // moved by another actor
        h.phase('Develop C1 R2');
        await h.scope.fetchAllBeadsShared();
        h.db.beads.find((b) => b.id === 'leaf-b1').parent = 'feat-b'; // a merge brings back the older link
        h.phase('Develop C1 R3');
        const ready = (await h.scope.readyLeafBeads()).map((b) => b.id).sort();

        assert.deepEqual(h.commandLog.filter((c) => /^bd update \S+ --parent /.test(c)), ['bd update leaf-b1 --parent feat-a']);
        assert.ok(h.logs.some((l) => l.startsWith('ERROR: parent-child link reverted') && l.includes("'leaf-b1'")), h.logs.join('\n'));
        assert.ok(!ready.includes('feat-a'), `feat-a keeps its moved-in child: never a leaf (${ready})`);
        assert.equal(h.db.beads.find((b) => b.id === 'leaf-b1').parent, 'feat-a');
    });
});
