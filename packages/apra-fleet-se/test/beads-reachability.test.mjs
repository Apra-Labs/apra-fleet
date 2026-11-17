// Unit checks of the pure pre-launch stale-claim helpers (beads-reachability.mjs)
// (GitHub #715). The runner wiring is exercised behaviourally by
// mock-sprint-stale-in-progress-reclaim.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    claimPredatesLaunch, isPreLaunchReclaimCandidate, confirmPreLaunchCandidates,
    downstreamDependentIds, downstreamSuffix,
} from '../fleet-sprint/beads-reachability.mjs';

const LAUNCH = Date.parse('2026-01-02T00:00:00Z');
const BEFORE = '2026-01-01T00:00:00Z';
const AFTER = '2026-01-03T00:00:00Z';
const blocks = (id) => ({ type: 'blocks', depends_on_id: id });

test('claimPredatesLaunch: earlier, missing and unparseable stamps predate; later ones do not', () => {
    assert.equal(claimPredatesLaunch(BEFORE, LAUNCH), true);
    assert.equal(claimPredatesLaunch(undefined, LAUNCH), true);
    assert.equal(claimPredatesLaunch('not a date', LAUNCH), true);
    assert.equal(claimPredatesLaunch(AFTER, LAUNCH), false);
});

test('isPreLaunchReclaimCandidate: in_progress, pre-launch, no unmet blocks edge, not settled by this run', () => {
    const notDoneIds = new Set(['P']);
    const ctx = { notDoneIds, sprintLaunchTime: LAUNCH };
    assert.equal(isPreLaunchReclaimCandidate({ id: 'S', status: 'in_progress', started_at: BEFORE }, ctx), true);
    assert.equal(isPreLaunchReclaimCandidate({ id: 'S', status: 'open', started_at: BEFORE }, ctx), false);
    assert.equal(isPreLaunchReclaimCandidate({ id: 'S', status: 'in_progress', started_at: AFTER }, ctx), false,
        'a bead first claimed after launch is never a pre-launch candidate');
    assert.equal(isPreLaunchReclaimCandidate({ id: 'S', status: 'in_progress', started_at: BEFORE, dependencies: [blocks('P')] }, ctx), false);
    assert.equal(isPreLaunchReclaimCandidate({ id: 'S', status: 'in_progress', started_at: BEFORE, dependencies: [blocks('Z')] }, ctx), true,
        'a blocks edge to a done bead is met');
    assert.equal(isPreLaunchReclaimCandidate({ id: 'S', status: 'in_progress', started_at: BEFORE, dependencies: [{ type: 'related', depends_on_id: 'P' }] }, ctx), true,
        'only blocks edges gate');
    // bd keeps the FIRST claim's started_at on a re-claim, so a bead this run
    // reclaimed or dispatched still reads as pre-launch: only settledIds
    // keeps the rule off it.
    assert.equal(isPreLaunchReclaimCandidate({ id: 'S', status: 'in_progress', started_at: BEFORE },
        { ...ctx, settledIds: new Set(['S']) }), false);
});

test('confirmPreLaunchCandidates: only a fresh in_progress bead under the same assignee authorizes the write', () => {
    const candidates = [
        { id: 'A', status: 'in_progress', started_at: BEFORE, assignee: 'old-actor' },
        { id: 'B', status: 'in_progress', started_at: BEFORE, assignee: 'old-actor' },
        { id: 'C', status: 'in_progress', started_at: BEFORE, assignee: 'old-actor' },
        { id: 'D', status: 'in_progress', started_at: BEFORE },
        { id: 'E', status: 'in_progress', started_at: BEFORE },
    ];
    const fresh = [
        { id: 'A', status: 'in_progress', started_at: BEFORE, assignee: 'old-actor' },
        { id: 'B', status: 'closed', started_at: BEFORE, assignee: 'old-actor' },
        // Re-claimed by another actor between snapshot and fresh read: bd
        // keeps started_at, only the assignee moves.
        { id: 'C', status: 'in_progress', started_at: BEFORE, assignee: 'new-actor' },
        { id: 'E', status: 'in_progress', started_at: BEFORE },
    ];
    const { confirmed, rejected } = confirmPreLaunchCandidates(candidates, fresh);
    assert.deepEqual(confirmed.map((b) => b.id), ['A', 'E']);
    assert.equal(confirmed[0], fresh[0], 'the confirmed bead is the FRESH object, not the snapshot one');
    assert.deepEqual(rejected.map((r) => r.id), ['B', 'C', 'D']);
    assert.equal(rejected[0].reason, "the fresh read shows 'closed'");
    assert.equal(rejected[1].reason, "the fresh read shows it claimed by 'new-actor', not 'old-actor' as in the snapshot");
    assert.equal(rejected[2].reason, 'it is missing from the fresh read');
    assert.deepEqual(confirmPreLaunchCandidates(candidates, null).confirmed, []);
});

test('downstreamDependentIds/downstreamSuffix: not-closed beads with a blocks edge on the id', () => {
    const beads = [
        { id: 'S', status: 'open' },
        { id: 'D1', status: 'open', dependencies: [blocks('S')] },
        { id: 'D2', status: 'closed', dependencies: [blocks('S')] },
        { id: 'R', status: 'open', dependencies: [{ type: 'related', depends_on_id: 'S' }] },
        { id: 'D3', status: 'blocked', dependencies: [blocks('X'), blocks('S')] },
    ];
    assert.deepEqual(downstreamDependentIds(beads, 'S'), ['D1', 'D3']);
    assert.equal(downstreamSuffix(beads, 'S'), ' Downstream bead(s) waiting on it: D1, D3.');
    assert.equal(downstreamSuffix(beads, 'D1'), ' No downstream bead is waiting on it.');
});
