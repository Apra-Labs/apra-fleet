import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupStreaksFromLaneMetadata } from '../auto-sprint/runner.js';

// =============================================================================
// apra-fleet-eft.76.3 -- deterministic develop-round grouping from planner-
// emitted lane metadata (`streak` / `streakOrder`), which retires the runtime
// "Streak Assignment" LLM dispatch to a back-compat fallback.
//
// runner.js's develop round (see the wiring at the `groupStreaksFromLaneMetadata`
// call site) branches on this pure function's return value:
//   - NON-null  -> use the deterministic grouping and SKIP the LLM Streak
//                  Assignment agent() dispatch (logs "deterministic from lane
//                  metadata -- ... no Streak Assignment dispatch").
//   - null      -> fall back to the LLM Streak Assignment path UNCHANGED
//                  (back-compat with pre-eft.76 plans that carry no lane
//                  metadata).
// So the two acceptance bullets ("a plan WITH lane metadata produces
// deterministic grouping with NO Streak Assignment dispatch" and "a plan
// WITHOUT lane metadata falls back to the LLM assignment path unchanged") are
// exactly the non-null-vs-null contract asserted here in isolation. The full
// command-log assertion over a live develop round is the downstream mock-sprint
// test (apra-fleet-eft.76.5, blocked by this bead).
// =============================================================================

const bead = (id, streak, streakOrder, title) => ({
    id,
    title: title ?? id,
    metadata: streak === undefined ? {} : { model: 'standard', streak, streakOrder },
});

// -----------------------------------------------------------------------------
// WITH lane metadata -> deterministic grouping (no LLM dispatch downstream)
// -----------------------------------------------------------------------------

test('groupStreaksFromLaneMetadata: fully-laned plan groups by streak id and returns reason:null', () => {
    const ready = [
        bead('t.1', 'laneA', 1),
        bead('t.2', 'laneA', 2),
        bead('t.3', 'laneB', 1),
    ];
    const result = groupStreaksFromLaneMetadata(ready);
    assert.ok(result, 'Expected a non-null grouping when every ready bead carries a streak id');
    assert.equal(result.reason, null, 'A fully-laned plan must report reason:null');
    // Two lanes: laneA (min streakOrder 1) then laneB (min streakOrder 1);
    // tie on minOrder broken by streak id, so laneA precedes laneB.
    const ids = result.streaks.map((s) => s.map((b) => b.id));
    assert.deepEqual(ids, [['t.1', 't.2'], ['t.3']]);
});

test('groupStreaksFromLaneMetadata: orders beads within a lane by streakOrder ascending', () => {
    const ready = [
        bead('t.3', 'lane', 3),
        bead('t.1', 'lane', 1),
        bead('t.2', 'lane', 2),
    ];
    const result = groupStreaksFromLaneMetadata(ready);
    assert.ok(result);
    assert.deepEqual(result.streaks.map((s) => s.map((b) => b.id)), [['t.1', 't.2', 't.3']]);
});

test('groupStreaksFromLaneMetadata: orders lanes by minimum streakOrder, then by streak id', () => {
    const ready = [
        bead('b.1', 'zeta', 5),
        bead('a.1', 'alpha', 10),
        bead('c.1', 'mid', 5),
    ];
    const result = groupStreaksFromLaneMetadata(ready);
    assert.ok(result);
    // 'mid' and 'zeta' both have minOrder 5 -> tie broken by streak id ('mid' < 'zeta');
    // 'alpha' has minOrder 10 so it sorts last despite an alphabetically-first id.
    assert.deepEqual(result.streaks.map((s) => s[0].id), ['c.1', 'b.1', 'a.1']);
});

test('groupStreaksFromLaneMetadata: numeric-string streakOrder is parsed like a number', () => {
    const ready = [
        bead('t.2', 'lane', '2'),
        bead('t.1', 'lane', '1'),
    ];
    const result = groupStreaksFromLaneMetadata(ready);
    assert.ok(result);
    assert.deepEqual(result.streaks.map((s) => s.map((b) => b.id)), [['t.1', 't.2']]);
});

test('groupStreaksFromLaneMetadata: missing/non-numeric streakOrder sorts last, then title, then id', () => {
    const ready = [
        // No streakOrder -> POSITIVE_INFINITY, sorts last; title/id tiebreak.
        { id: 't.z', title: 'zzz', metadata: { streak: 'lane' } },
        { id: 't.a', title: 'aaa', metadata: { streak: 'lane' } },
        bead('t.1', 'lane', 1, 'ordered'),
    ];
    const result = groupStreaksFromLaneMetadata(ready);
    assert.ok(result);
    // t.1 (order 1) first; the two order-less beads follow, ordered by title (aaa < zzz).
    assert.deepEqual(result.streaks.map((s) => s.map((b) => b.id)), [['t.1', 't.a', 't.z']]);
});

test('groupStreaksFromLaneMetadata: returns the ORIGINAL bead objects, not just ids', () => {
    const original = bead('t.1', 'lane', 1);
    const result = groupStreaksFromLaneMetadata([original]);
    assert.ok(result);
    assert.equal(result.streaks[0][0], original, 'Grouping must preserve object identity of the input beads');
});

test('groupStreaksFromLaneMetadata: is deterministic across shuffled input order', () => {
    const make = () => [
        bead('t.4', 'laneB', 2),
        bead('t.1', 'laneA', 1),
        bead('t.3', 'laneB', 1),
        bead('t.2', 'laneA', 2),
    ];
    const forward = groupStreaksFromLaneMetadata(make());
    const shuffled = make().reverse();
    const reversed = groupStreaksFromLaneMetadata(shuffled);
    const idsOf = (r) => r.streaks.map((s) => s.map((b) => b.id));
    assert.deepEqual(idsOf(forward), idsOf(reversed), 'Grouping must not depend on input order');
    assert.deepEqual(idsOf(forward), [['t.1', 't.2'], ['t.3', 't.4']]);
});

// -----------------------------------------------------------------------------
// WITHOUT (complete) lane metadata -> null, so the caller falls back unchanged
// -----------------------------------------------------------------------------

test('groupStreaksFromLaneMetadata: a plan with NO lane metadata returns null (LLM fallback)', () => {
    const ready = [
        { id: 't.1', title: 't.1', metadata: { model: 'standard' } },
        { id: 't.2', title: 't.2', metadata: { model: 'cheap' } },
    ];
    assert.equal(groupStreaksFromLaneMetadata(ready), null);
});

test('groupStreaksFromLaneMetadata: a PARTIALLY-laned plan returns null (all-or-nothing)', () => {
    const ready = [
        bead('t.1', 'laneA', 1),
        { id: 't.2', title: 't.2', metadata: { model: 'standard' } }, // un-laned
    ];
    assert.equal(
        groupStreaksFromLaneMetadata(ready),
        null,
        'One un-laned bead must disqualify the whole deterministic path (no mixed grouping)'
    );
});

test('groupStreaksFromLaneMetadata: empty streak string is treated as un-laned -> null', () => {
    const ready = [
        bead('t.1', 'laneA', 1),
        bead('t.2', '   ', 2), // whitespace-only streak id
    ];
    assert.equal(groupStreaksFromLaneMetadata(ready), null);
});

test('groupStreaksFromLaneMetadata: missing metadata object -> null', () => {
    const ready = [{ id: 't.1', title: 't.1' }];
    assert.equal(groupStreaksFromLaneMetadata(ready), null);
});

test('groupStreaksFromLaneMetadata: empty or non-array input -> null', () => {
    assert.equal(groupStreaksFromLaneMetadata([]), null);
    assert.equal(groupStreaksFromLaneMetadata(null), null);
    assert.equal(groupStreaksFromLaneMetadata(undefined), null);
});
