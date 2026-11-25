// Unit tests for the parent-link guard (fleet-sprint/parent-link-guard.mjs,
// wired into createBeadsScope in fleet-sprint/beads-scope.mjs):
//   - an in-scope parent-child edge a pull dropped (present just before it,
//     missing just after) is restored on the next fresh snapshot, with an
//     ERROR naming child and parent;
//   - an edge removed outside any pull (an agent on its own clone: a
//     retarget, a reversal/cycle-break, a reparent) is forgotten, never
//     restored -- nor is one this run itself removed -- and a removal another
//     clone recorded (the run-wide agent-removal record) is not restored by
//     a pull that carries it;
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
function buildHarness({ beads, targetIssues = ['root'], failRestore = false, restoreThrows = false, cycleOn = null } = {}) {
    const db = { beads: beads.map((b) => ({ ...b })) };
    let pendingMerge = null;
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
        const byId = /--id "([^"]+)"/.exec(cmd);
        if (/^bd list --all/.test(cmd)) return JSON.stringify(byId ? db.beads.filter((b) => byId[1].split(',').includes(b.id)) : db.beads);
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
            if (bead && Array.isArray(bead.dependencies)) {
                bead.dependencies = bead.dependencies.filter((d) => !(d.type === 'blocks' && d.depends_on_id === rm[2]));
            }
            return '';
        }
        if (/^bd dolt pull\b/.test(cmd)) {
            const merge = pendingMerge;
            pendingMerge = null;
            if (merge) merge.apply();
            // What the pinned bd prints for a pull that auto-resolved a
            // conflict (stdout then stderr, as the engine's command seam
            // returns them); a clean pull prints only the first two lines.
            return merge && merge.conflicted
                ? 'Pulling from Dolt remote...\nPull complete.\n[stderr]\nNotice: auto-merged issue root; title, updated_at settled last-write-wins'
                : 'Pulling from Dolt remote...\nPull complete.';
        }
        const add = /^bd dep add (\S+) (\S+)$/.exec(cmd);
        if (add) {
            if (cycleOn && cycleOn(add[1], add[2])) {
                const err = 'Error: adding dependency would create a cycle';
                if (opts.failSoft) return { ok: false, output: '', error: err };
                throw new Error(err);
            }
            if (restoreThrows) throw new Error('member unreachable');
            if (failRestore) return opts.failSoft ? { ok: false, output: '', error: 'Error: issue not found' } : '';
            const bead = db.beads.find((b) => b.id === add[1]);
            bead.dependencies = [...(bead.dependencies || []), { issue_id: add[1], depends_on_id: add[2], type: 'blocks' }];
            return opts.failSoft ? { ok: true, output: '', error: null } : '';
        }
        return '';
    };
    const command = scope.wrapCommand(rawCommand);
    const phase = scope.wrapPhase((title) => title);
    /** Drop a parent link straight in the table (no command path). */
    const dropEdge = (child) => { delete db.beads.find((b) => b.id === child).parent; };
    /** Drop a blocks edge straight in the table (no command path). */
    const dropBlocks = (blocked, blocker) => {
        const bead = db.beads.find((b) => b.id === blocked);
        bead.dependencies = (bead.dependencies || []).filter((d) => !(d.type === 'blocks' && d.depends_on_id === blocker));
    };
    /** Add a blocks edge straight in the table (no command path). */
    const addBlocks = (blocked, blocker) => {
        const bead = db.beads.find((b) => b.id === blocked);
        bead.dependencies = [...(bead.dependencies || []), { issue_id: blocked, depends_on_id: blocker, type: 'blocks' }];
    };
    /**
     * A CONFLICTED `bd dolt pull` on the backlog clone, issued through the
     * engine's command path, whose auto-merge applies `merge` (the lossy
     * result: it drops or reverts links).
     */
    const conflictedPull = async (merge) => {
        pendingMerge = { apply: merge, conflicted: true };
        await command('bd dolt pull', { member_name: 'backlog-member', silent: true });
    };
    /** A clean `bd dolt pull` carrying `change` (what another clone published). */
    const cleanPull = async (change) => {
        pendingMerge = { apply: change, conflicted: false };
        await command('bd dolt pull', { member_name: 'backlog-member', silent: true });
    };
    return { scope, db, command, phase, commandLog, logs, dropEdge, dropBlocks, addBlocks, conflictedPull, cleanPull };
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
    test('restores exactly the in-scope edges a conflicted pull dropped and logs an ERROR naming child and parent', async () => {
        const h = buildHarness({ beads: TREE });
        await h.scope.fetchAllBeadsShared();

        await h.conflictedPull(() => { h.dropEdge('feat-a'); h.dropEdge('leaf-a1'); });
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
        // The seed snapshot, the pull bracket's before- and after-reads, and
        // this phase's snapshot.
        assert.equal(h.commandLog.filter((c) => c.startsWith('bd list --all') && !/ --id /.test(c)).length, 4);
        const scoped = (await h.scope.bdListScoped('')).map((b) => b.id).sort();
        assert.deepEqual(scoped, ['feat-a', 'feat-b', 'leaf-a1', 'leaf-b1', 'root']);
    });

    test('an edge this run itself removed (through the command path) is NOT restored', async () => {
        const h = buildHarness({ beads: TREE });
        await h.scope.fetchAllBeadsShared();

        await h.command('bd dep remove leaf-b1 feat-b', { member_name: 'backlog-member' });
        await h.conflictedPull(() => h.dropEdge('leaf-a1')); // and one a conflicted pull dropped
        h.phase('Plan C2 R1');
        await h.scope.fetchAllBeadsShared();

        const restoreCmds = h.commandLog.filter((c) => /^bd update \S+ --parent /.test(c));
        assert.deepEqual(restoreCmds, ['bd update leaf-a1 --parent feat-a'], 'only the edge the pull dropped is restored');
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
        await h.conflictedPull(() => h.dropEdge('feat-b'));
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
        await h.conflictedPull(() => h.dropEdge('leaf-b1'));
        h.phase('Develop C1 R2');
        await assert.rejects(h.scope.fetchAllBeadsShared(), /member unreachable/);
        assert.ok(h.logs.some((l) => l.startsWith('ERROR: could not restore') && l.includes("'leaf-b1'")), h.logs.join('\n'));
    });
});

describe('parent-link guard: parenthood and scope', () => {
    test('a parent whose only child lost its link to a merge is never returned as a dispatchable leaf', async () => {
        const h = buildHarness({ beads: TREE });
        await h.scope.fetchAllBeadsShared();
        await h.conflictedPull(() => h.dropEdge('leaf-a1'));
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

    test('the ledger owes only in-scope links a pull dropped, never ones whose endpoint is gone', () => {
        const ledger = createParentLinkLedger();
        const beads = [{ id: 'r' }, { id: 'c', parent: 'r' }, { id: 'x', parent: 'y' }, { id: 'y' }];
        ledger.observe(beads, new Set(['r', 'c']));
        assert.deepEqual(ledger.notePull('m', beads, [{ id: 'r' }, { id: 'x' }, { id: 'y' }]), [], 'a deleted child is not a dropped edge');
        assert.equal(ledger.hasOwedLinks('m'), false);
        const lossy = [{ id: 'r' }, { id: 'c' }, { id: 'x' }, { id: 'y' }];
        assert.deepEqual(ledger.notePull('m', beads, lossy), [{ kind: 'parent-child', child: 'c', parent: 'r' }], 'out-of-scope x -> y is not compared');
        assert.deepEqual(ledger.findVanishedLinks('m', lossy), [{ kind: 'parent-child', child: 'c', parent: 'r' }]);
        assert.deepEqual(ledger.findVanishedLinks('other-member', lossy), [], 'owed per pulling clone');
        assert.deepEqual([...ledger.knownParentIds()], ['r']);
    });

    test('ledger: a link missing with no pull in between is forgotten, not owed', () => {
        const ledger = createParentLinkLedger();
        const beads = [{ id: 'r' }, { id: 'c', parent: 'r' }, { id: 'a', dependencies: [{ depends_on_id: 'b', type: 'blocks' }] }, { id: 'b' }];
        ledger.observe(beads, new Set(['r', 'c', 'a', 'b']));
        const agentEdited = [{ id: 'r' }, { id: 'c' }, { id: 'a' }, { id: 'b', dependencies: [{ depends_on_id: 'a', type: 'blocks' }] }];
        const r = ledger.reconcile(agentEdited, 'm');
        assert.deepEqual(r.vanished, []);
        assert.deepEqual(r.vanishedBlocks, []);
        assert.deepEqual(ledger.knownBlocksEdges(), [], 'the removed blocks edge is forgotten');
        assert.deepEqual([...ledger.knownParentIds()], [], 'r stops being a parent');
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
        await h.conflictedPull(() => h.dropEdge('leaf-a1'));
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
        // A conflicted merge keeps the older side: leaf-a1 is back under feat-a.
        await h.conflictedPull(() => { h.db.beads.find((b) => b.id === 'leaf-a1').parent = 'feat-a'; });
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
        await h.conflictedPull(() => { h.db.beads.find((b) => b.id === 'leaf-b1').parent = 'feat-b'; }); // a conflicted merge brings back the older link
        h.phase('Develop C1 R3');
        const ready = (await h.scope.readyLeafBeads()).map((b) => b.id).sort();

        assert.deepEqual(h.commandLog.filter((c) => /^bd update \S+ --parent /.test(c)), ['bd update leaf-b1 --parent feat-a']);
        assert.ok(h.logs.some((l) => l.startsWith('ERROR: parent-child link reverted') && l.includes("'leaf-b1'")), h.logs.join('\n'));
        assert.ok(!ready.includes('feat-a'), `feat-a keeps its moved-in child: never a leaf (${ready})`);
        assert.equal(h.db.beads.find((b) => b.id === 'leaf-b1').parent, 'feat-a');
    });
});

// Blocks edges (A blocked-by B) ride the same ledger: a lossy merge drops them
// exactly like parent links, and a dropped one releases A before B is done.
const BLOCKS_TREE = [
    { id: 'root', status: 'open', issue_type: 'bug' },
    { id: 'task-x', parent: 'root', status: 'open', issue_type: 'task', dependencies: [{ issue_id: 'task-x', depends_on_id: 'task-y', type: 'blocks' }] },
    { id: 'task-y', parent: 'root', status: 'open', issue_type: 'task' },
    { id: 'task-z', parent: 'root', status: 'open', issue_type: 'task', dependencies: [{ issue_id: 'task-z', depends_on_id: 'task-y', type: 'blocks' }] },
    { id: 'outsider', status: 'open', issue_type: 'task' },
    { id: 'outsider-2', status: 'open', issue_type: 'task', dependencies: [{ issue_id: 'outsider-2', depends_on_id: 'outsider', type: 'blocks' }] },
];

describe('parent-link guard: blocks edges', () => {
    test('a blocks edge a conflicted pull dropped is reported with an ERROR and restored with bd dep add', async () => {
        const h = buildHarness({ beads: BLOCKS_TREE });
        await h.scope.fetchAllBeadsShared();
        await h.conflictedPull(() => h.dropBlocks('task-x', 'task-y'));
        h.phase('Develop C1 R2');
        const after = await h.scope.fetchAllBeadsShared();

        assert.deepEqual(h.commandLog.filter((c) => c.startsWith('bd dep add')), ['bd dep add task-x task-y']);
        const errors = h.logs.filter((l) => l.startsWith('ERROR: blocks link vanished'));
        assert.equal(errors.length, 1, h.logs.join('\n'));
        assert.ok(errors[0].includes("'task-x'") && errors[0].includes("'task-y'"), errors[0]);
        assert.ok(h.db.beads.find((b) => b.id === 'task-x').dependencies.some((d) => d.depends_on_id === 'task-y' && d.type === 'blocks'));
        assert.ok(after.find((b) => b.id === 'task-x').dependencies.some((d) => d.depends_on_id === 'task-y' && d.type === 'blocks'),
            'this phase snapshot already carries the restored blocks edge');
    });

    test('a blocks edge this run removed (bd dep remove, e.g. the cycle auto-repair) is NOT restored', async () => {
        const h = buildHarness({ beads: BLOCKS_TREE });
        await h.scope.fetchAllBeadsShared();
        await h.command('bd dep remove task-x task-y', { member_name: 'backlog-member' });
        h.phase('Plan C2 R1');
        await h.scope.fetchAllBeadsShared();
        assert.deepEqual(h.commandLog.filter((c) => c.startsWith('bd dep add')), []);
        assert.ok(!h.logs.some((l) => l.includes('blocks link')), h.logs.join('\n'));
        assert.ok(!h.scope.knownParentIds().has('task-y'));
    });

    test('a blocks edge whose endpoint was deleted is dropped with a WARN, never restored', async () => {
        const h = buildHarness({ beads: BLOCKS_TREE });
        await h.scope.fetchAllBeadsShared();
        h.db.beads = h.db.beads.filter((b) => b.id !== 'task-y');
        h.db.beads.find((b) => b.id === 'task-x').dependencies = [];
        h.db.beads.find((b) => b.id === 'task-z').dependencies = [];
        h.phase('Develop C1 R2');
        await h.scope.fetchAllBeadsShared();
        assert.deepEqual(h.commandLog.filter((c) => c.startsWith('bd dep add')), []);
        const warns = h.logs.filter((l) => l.startsWith('WARN: blocks link'));
        assert.equal(warns.length, 2, h.logs.join('\n'));
        assert.ok(warns.every((w) => w.includes("the blocker 'task-y' is") && w.includes('deleted')), warns.join('\n'));
        // Forgotten: a later snapshot does not WARN again.
        h.phase('Develop C1 R3');
        await h.scope.fetchAllBeadsShared();
        assert.equal(h.logs.filter((l) => l.startsWith('WARN: blocks link')).length, 2);
    });

    test('an out-of-scope blocks edge is not tracked', async () => {
        const h = buildHarness({ beads: BLOCKS_TREE });
        await h.scope.fetchAllBeadsShared();
        await h.conflictedPull(() => h.dropBlocks('outsider-2', 'outsider'));
        h.phase('Develop C1 R2');
        await h.scope.fetchAllBeadsShared();
        assert.deepEqual(h.commandLog.filter((c) => c.startsWith('bd dep add')), []);
    });

    test('a failed blocks restore is loud: ERROR line and a ParentLinkRestoreError naming the edge', async () => {
        const h = buildHarness({ beads: BLOCKS_TREE, failRestore: true });
        await h.scope.fetchAllBeadsShared();
        await h.conflictedPull(() => h.dropBlocks('task-z', 'task-y'));
        h.phase('Develop C1 R2');
        await assert.rejects(() => h.scope.fetchAllBeadsShared(), (err) => {
            assert.ok(err instanceof ParentLinkRestoreError, String(err));
            assert.deepEqual(err.edges, [{ kind: 'blocks', blocked: 'task-z', blocker: 'task-y' }]);
            assert.match(err.message, /blocks link 'task-z' blocked by 'task-y'/);
            assert.match(err.message, /bd dep add task-z task-y/);
            return true;
        });
        assert.ok(h.logs.some((l) => l.startsWith('ERROR: could not restore vanished beads link')), h.logs.join('\n'));
    });

    test('ledger: parseRunEdgeChange reads bd dep add; a run removal cancels an owed restore, a run re-add does not re-owe it', () => {
        assert.deepEqual(parseRunEdgeChange('bd dep add a b'), { kind: 'add', a: 'a', b: 'b' });
        const ledger = createParentLinkLedger();
        const beads = [{ id: 'a', dependencies: [{ depends_on_id: 'b', type: 'blocks' }] }, { id: 'b' }];
        ledger.observe(beads, new Set(['a', 'b']));
        const lossy = [{ id: 'a' }, { id: 'b' }];
        ledger.notePull('m', beads, lossy);
        assert.deepEqual(ledger.findVanishedLinks('m', lossy), [{ kind: 'blocks', blocked: 'a', blocker: 'b' }], 'dropped by the pull: owed');
        ledger.noteRunEdgeChange(parseRunEdgeChange('bd dep remove a b'));
        assert.deepEqual(ledger.findVanishedLinks('m', lossy), [], 'run-removed: not owed');
        ledger.noteRunEdgeChange(parseRunEdgeChange('bd dep add a b'));
        assert.deepEqual(ledger.findVanishedLinks('m', lossy), [], 'a re-add is not a pull loss');
    });
});

// Agents (the planner, a doer) change links on their own clone, outside the
// engine's command path. None of that is a merge loss: only a link a
// CONFLICTED pull dropped is ever restored.
describe('parent-link guard: agent link changes are never reverted', () => {
    const restoreCmds = (h) => h.commandLog.filter((c) => /^bd dep add |^bd update \S+ --parent /.test(c));

    test('a retarget (X blocked-by Y replaced by X blocked-by Z) between two snapshots with no pull is kept', async () => {
        const h = buildHarness({ beads: BLOCKS_TREE });
        await h.scope.fetchAllBeadsShared();
        h.dropBlocks('task-x', 'task-y');
        h.addBlocks('task-x', 'task-z');
        h.phase('Plan C1 R2');
        const after = await h.scope.fetchAllBeadsShared();
        assert.deepEqual(restoreCmds(h), [], h.commandLog.join('\n'));
        assert.equal(h.logs.length, 0, h.logs.join('\n'));
        const x = after.find((b) => b.id === 'task-x');
        assert.deepEqual(x.dependencies.map((d) => d.depends_on_id), ['task-z'], 'the snapshot carries the retargeted edge only');
        // Still kept after a later (clean or conflicted) pull: it is forgotten, not owed.
        await h.conflictedPull(() => {});
        h.phase('Plan C1 R3');
        await h.scope.fetchAllBeadsShared();
        assert.deepEqual(restoreCmds(h), [], h.commandLog.join('\n'));
    });

    test('a reversal/cycle-break (remove X blocked-by Y, add Y blocked-by X) is not re-added and raises nothing', async () => {
        // Re-adding X blocked-by Y would now be refused by bd as a cycle.
        const h = buildHarness({ beads: BLOCKS_TREE, cycleOn: (a, b) => a === 'task-x' && b === 'task-y' });
        await h.scope.fetchAllBeadsShared();
        h.dropBlocks('task-x', 'task-y');
        h.addBlocks('task-y', 'task-x');
        h.phase('Plan C1 R2');
        const after = await h.scope.fetchAllBeadsShared();
        assert.deepEqual(restoreCmds(h), [], h.commandLog.join('\n'));
        assert.ok(after.find((b) => b.id === 'task-y').dependencies.some((d) => d.depends_on_id === 'task-x'));
        assert.ok(!h.logs.some((l) => l.startsWith('ERROR')), h.logs.join('\n'));
    });

    test('a reparent by an agent is not reverted; the new parent is a parent', async () => {
        const h = buildHarness({ beads: TREE });
        await h.scope.fetchAllBeadsShared();
        h.db.beads.find((b) => b.id === 'leaf-a1').parent = 'feat-b';
        h.phase('Plan C1 R2');
        await h.scope.fetchAllBeadsShared();
        await h.conflictedPull(() => {});
        h.phase('Plan C1 R3');
        await h.scope.fetchAllBeadsShared();
        assert.deepEqual(restoreCmds(h), [], h.commandLog.join('\n'));
        assert.equal(h.db.beads.find((b) => b.id === 'leaf-a1').parent, 'feat-b');
        assert.ok(h.scope.knownParentIds().has('feat-b'));
    });

    test('a removal made before a conflicted pull is not owed; a link that pull dropped is', async () => {
        const h = buildHarness({ beads: BLOCKS_TREE });
        await h.scope.fetchAllBeadsShared();
        h.dropBlocks('task-x', 'task-y'); // the agent, before the pull
        await h.conflictedPull(() => h.dropBlocks('task-z', 'task-y')); // the merge
        h.phase('Develop C1 R2');
        await h.scope.fetchAllBeadsShared();
        assert.deepEqual(restoreCmds(h), ['bd dep add task-z task-y'], h.commandLog.join('\n'));
    });

    test('a clean pull carrying another clone\'s RECORDED removal restores nothing; the record is run-wide and lifted by a deliberate re-add', () => {
        const ledger = createParentLinkLedger();
        const withEdge = () => [{ id: 'a', dependencies: [{ depends_on_id: 'b', type: 'blocks' }] }, { id: 'b' }, { id: 'c' }];
        const without = () => [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
        ledger.observe(withEdge(), new Set(['a', 'b', 'c']));
        // Clone X: read (baseline), the agent removes a blocked-by b, read again
        // (no pull in between) -- the read the engine takes before X's push.
        assert.deepEqual(ledger.noteRead('X', withEdge()), [], 'the first read only sets a baseline');
        assert.deepEqual(ledger.noteRead('X', without()), [{ kind: 'blocks', blocked: 'a', blocker: 'b' }]);
        assert.deepEqual(ledger.agentRemovalLinks(), [{ kind: 'blocks', blocked: 'a', blocker: 'b' }]);
        // Clone Y pulls X's push: present before, missing after -- but recorded.
        assert.deepEqual(ledger.notePull('Y', withEdge(), without()), [], 'a recorded removal is never owed');
        assert.deepEqual(ledger.findVanishedLinks('Y', without()), []);
        // Clone Z still holds the edge (it has not pulled yet): its read does
        // not lift the record -- only a deliberate re-add does.
        ledger.noteRead('Z', withEdge());
        ledger.noteRead('Z', withEdge());
        assert.equal(ledger.agentRemovalLinks().length, 1, 'a stale clone still holding the link does not lift the record');
        // X re-adds it on purpose: off the record, so a later lossy pull owes it again.
        ledger.noteRead('X', withEdge());
        assert.deepEqual(ledger.agentRemovalLinks(), []);
        assert.deepEqual(ledger.notePull('Y', withEdge(), without()), [{ kind: 'blocks', blocked: 'a', blocker: 'b' }]);
    });

    test('a pull comparison with no record of the removal owes the link (the documented gap: a clone the engine never read)', async () => {
        const h = buildHarness({ beads: BLOCKS_TREE });
        await h.scope.fetchAllBeadsShared();
        await h.cleanPull(() => h.dropBlocks('task-x', 'task-y'));
        h.phase('Develop C1 R2');
        await h.scope.fetchAllBeadsShared();
        assert.deepEqual(restoreCmds(h), ['bd dep add task-x task-y'], h.commandLog.join('\n'));
    });

    test('a removal or reparent this run issues through its command path goes on the record; its re-add lifts it', () => {
        const ledger = createParentLinkLedger();
        const beads = [{ id: 'a', parent: 'p', dependencies: [{ depends_on_id: 'b', type: 'blocks' }] }, { id: 'b', parent: 'p' }, { id: 'p' }, { id: 'q' }];
        ledger.observe(beads, new Set(['a', 'b', 'p', 'q']));
        ledger.noteRunEdgeChange(parseRunEdgeChange('bd dep remove a b'));
        ledger.noteRunEdgeChange(parseRunEdgeChange('bd update a --parent q'));
        const keys = ledger.agentRemovalLinks().map((e) => (e.kind === 'blocks' ? `${e.blocked}<${e.blocker}` : `${e.child}^${e.parent}`)).sort();
        assert.deepEqual(keys, ['a<b', 'a^p', 'b<a']);
        const after = [{ id: 'a', parent: 'q' }, { id: 'b', parent: 'p' }, { id: 'p' }, { id: 'q' }];
        assert.deepEqual(ledger.notePull('other', beads, after), [], 'another clone pulling the run\'s own changes owes nothing');
        ledger.noteRunEdgeChange(parseRunEdgeChange('bd dep add a b'));
        assert.ok(!ledger.agentRemovalLinks().some((e) => e.kind === 'blocks' && e.blocked === 'a' && e.blocker === 'b'));
    });
});
