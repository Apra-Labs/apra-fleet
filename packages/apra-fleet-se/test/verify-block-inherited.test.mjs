// =============================================================================
// Verify-block detection follows `blocks` edges inherited from ancestors.
//
// A child of a blocked parent is never ready, so a feature -> feature edge
// (`bd dep add B A`, A verify-routed) holds every child task of B even though
// those tasks carry no edge of their own. findVerifyBlockedBeads must count
// them, the diagnosis must name the bead that carries the edge, and a
// non-verify unmet blocker anywhere on the chain must disqualify the bead.
//
// Reverting the ancestor walk in fleet-sprint/verify-block.mjs (checking only
// the bead's own dependencies) fails the "counts a leaf ..." and diagnosis
// tests: the leaf is not reported at all.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findVerifyBlockedBeads, buildVerifyBlockDiagnosis } from '../fleet-sprint/verify-block.mjs';

const blocks = (id) => ({ type: 'blocks', depends_on_id: id });

/** Epic E; feature A (verify-routed, child A1 closed); feature B blocked by A; B1 open under B. */
const shape = ({ bDeps = [blocks('A')], b1Deps = [] } = {}) => [
    { id: 'E', status: 'open', title: 'Epic', dependencies: [] },
    { id: 'A', status: 'open', title: 'Feature A', parent: 'E', dependencies: [] },
    { id: 'A1', status: 'closed', title: 'A child', parent: 'A', dependencies: [] },
    { id: 'B', status: 'open', title: 'Feature B', parent: 'E', dependencies: bDeps },
    { id: 'B1', status: 'open', title: 'B child task', parent: 'B', priority: 1, dependencies: b1Deps },
    { id: 'X', status: 'open', title: 'Unrelated open task', parent: 'E', dependencies: [] },
];

test('counts a leaf whose parent feature carries the only unmet blocks edge, to a verify-routed bead', () => {
    const all = shape();
    const b1 = all.find((b) => b.id === 'B1');
    const found = findVerifyBlockedBeads([b1], all, ['A']);
    assert.equal(found.length, 1, `B1 must be counted as verify-blocked: ${JSON.stringify(found)}`);
    assert.equal(found[0].id, 'B1');
    assert.deepEqual(found[0].blockerIds, ['A']);
    assert.deepEqual(found[0].edges, [{ from: 'B', to: 'A' }]);
});

test('follows the full ancestor chain (grandparent edge), and honours an authoritative closedIds set', () => {
    const all = [
        { id: 'A', status: 'open', dependencies: [] },
        { id: 'G', status: 'open', dependencies: [blocks('A')] },
        { id: 'P', status: 'open', parent: 'G', dependencies: [] },
        { id: 'L', status: 'open', parent: 'P', dependencies: [] },
    ];
    const leaf = all.find((b) => b.id === 'L');
    assert.deepEqual(findVerifyBlockedBeads([leaf], all, ['A']).map((b) => b.id), ['L']);
    // A fresher closed read that says A is closed: nothing is blocked.
    assert.deepEqual(findVerifyBlockedBeads([leaf], all, ['A'], { closedIds: new Set(['A']) }), []);
});

test('a leaf whose ancestor has one verify-routed and one non-verify unmet blocker is NOT counted', () => {
    const all = shape({ bDeps: [blocks('A'), blocks('X')] });
    const b1 = all.find((b) => b.id === 'B1');
    assert.deepEqual(findVerifyBlockedBeads([b1], all, ['A']), []);
});

test('a non-verify blocker on the leaf itself disqualifies an inherited verify-routed edge', () => {
    const all = shape({ b1Deps: [blocks('X')] });
    const b1 = all.find((b) => b.id === 'B1');
    assert.deepEqual(findVerifyBlockedBeads([b1], all, ['A']), []);
});

test('an ancestor blocker the snapshot does not know counts as unmet and not verify-routed', () => {
    const all = shape({ bDeps: [blocks('A'), blocks('GHOST')] });
    const b1 = all.find((b) => b.id === 'B1');
    assert.deepEqual(findVerifyBlockedBeads([b1], all, ['A']), []);
});

test('own-edge behaviour is unchanged (closed-id stubs as the snapshot still work)', () => {
    const t = { id: 'T', status: 'open', title: 'T', priority: 1, dependencies: [blocks('B')] };
    const found = findVerifyBlockedBeads([t], [{ id: 'C', status: 'closed' }], ['B']);
    assert.deepEqual(found.map((b) => [b.id, b.blockerIds, b.edges]), [['T', ['B'], [{ from: 'T', to: 'B' }]]]);
    // A closed blocker is met; a verify bead itself is never a candidate.
    assert.deepEqual(findVerifyBlockedBeads([t], [{ id: 'B', status: 'closed' }], ['B']), []);
    assert.deepEqual(findVerifyBlockedBeads([{ id: 'B', status: 'open', dependencies: [] }], [], ['B']), []);
});

test('the parent-cycle guard terminates', () => {
    const all = [
        { id: 'A', status: 'open', dependencies: [] },
        { id: 'P', status: 'open', parent: 'Q', dependencies: [blocks('A')] },
        { id: 'Q', status: 'open', parent: 'P', dependencies: [] },
    ];
    assert.deepEqual(findVerifyBlockedBeads([all[1]], all, ['A']).map((b) => b.id), ['P']);
});

test('the diagnosis dep-remove hint names the ancestor that carries an inherited edge, once', () => {
    const all = shape();
    all.push({ id: 'B2', status: 'open', title: 'Another B child', parent: 'B', priority: 1, dependencies: [] });
    const candidates = all.filter((b) => b.id === 'B1' || b.id === 'B2');
    const blocked = findVerifyBlockedBeads(candidates, all, ['A']);
    assert.deepEqual(blocked.map((b) => b.id), ['B1', 'B2']);
    const text = buildVerifyBlockDiagnosis({ blocked, cause: 'deploy-failed', deployNotes: 'port unreachable' });
    assert.ok(text.includes('bd dep remove B A'), `hint must name the edge carrier B: ${text}`);
    assert.ok(!text.includes('bd dep remove B1 A'), `hint must not name the leaf: ${text}`);
    assert.equal(text.split('bd dep remove B A').length - 1, 1, `the shared edge is named once: ${text}`);
    assert.match(text, /inherited from ancestor B/);
    assert.match(text, /port unreachable/);
});

test('the diagnosis still names an own edge on the blocked bead, including for an entry with no edges field', () => {
    const text = buildVerifyBlockDiagnosis({ blocked: [{ id: 'T', title: '', blockerIds: ['B'] }], cause: 'no-playbook' });
    assert.ok(text.includes('bd dep remove T B'), text);
    assert.ok(!/inherited from ancestor/.test(text), text);
});
