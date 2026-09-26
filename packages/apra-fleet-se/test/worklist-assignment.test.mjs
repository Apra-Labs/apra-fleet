import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    assignDoerWorklists,
    streakRequiredTier,
    streakMinPriority,
    streakEffortPoints,
    beadBlocksDependencyIds,
    resolveWorklistTierPolicy,
    hasContextHeadroomForResume,
    DEFAULT_EFFORT_THRESHOLD,
} from '../fleet-sprint/runner.js';

// =============================================================================
// apra-fleet-eft.79.2 -- unit coverage for the PURE multi-streak worklist
// assignment logic (apra-fleet-eft.79.1): per-doer ordered worklists with
// priority ordering (blocks-edge order always wins), TIER-OUTLIER ISOLATION
// (partition-by-tier-first packing), effort-point budget with overflow
// queueing, and the model-switch-on-resume capability fallback. No engine,
// no LLM, no I/O -- these functions are plain deterministic JavaScript.
// =============================================================================

// Bead factory: numeric `priority` (bd convention: 0 = P0), `model`/`size`
// under metadata (the planner's channel), `deps` as bd `dependencies`.
const bead = (id, { priority, model, size, deps, title } = {}) => ({
    id,
    title: title || `Task ${id}`,
    ...(priority !== undefined ? { priority } : {}),
    metadata: {
        ...(model !== undefined ? { model } : {}),
        ...(size !== undefined ? { size } : {}),
    },
    ...(deps !== undefined ? { dependencies: deps } : {}),
});

// worklists -> [[streak ids]] for compact assertions (1-bead streaks).
const flatIds = (worklists) => worklists.map((wl) => wl.map((s) => s.map((b) => b.id).join('+')));

// -----------------------------------------------------------------------------
// streakRequiredTier
// -----------------------------------------------------------------------------
test('streakRequiredTier: the MAX (most capable) tier across member beads', () => {
    assert.equal(streakRequiredTier([bead('a', { model: 'cheap' }), bead('b', { model: 'premium' }), bead('c', { model: 'standard' })]), 'premium');
    assert.equal(streakRequiredTier([bead('a', { model: 'cheap' }), bead('b', { model: 'standard' })]), 'standard');
    assert.equal(streakRequiredTier([bead('a', { model: 'cheap' })]), 'cheap');
});

test('streakRequiredTier: tier aliases normalize; no tier metadata -> null', () => {
    assert.equal(streakRequiredTier([bead('a', { model: 'standard-tier' })]), 'standard');
    assert.equal(streakRequiredTier([bead('a'), bead('b')]), null);
    assert.equal(streakRequiredTier([]), null);
});

// -----------------------------------------------------------------------------
// streakMinPriority
// -----------------------------------------------------------------------------
test('streakMinPriority: the MIN (highest-urgency) priority across member beads', () => {
    assert.equal(streakMinPriority([bead('a', { priority: 3 }), bead('b', { priority: 0 }), bead('c', { priority: 2 })]), 0);
    assert.equal(streakMinPriority([bead('a', { priority: 2 })]), 2);
});

test('streakMinPriority: no numeric priority -> POSITIVE_INFINITY (sorts last)', () => {
    assert.equal(streakMinPriority([bead('a'), bead('b')]), Number.POSITIVE_INFINITY);
    assert.equal(streakMinPriority([]), Number.POSITIVE_INFINITY);
});

// -----------------------------------------------------------------------------
// streakEffortPoints (planner.md formula: size points x max model weight)
// -----------------------------------------------------------------------------
test('streakEffortPoints: reuses the planner.md formula (S=1 M=2 L=4; cheap=1 standard=10 premium=20)', () => {
    assert.equal(streakEffortPoints([bead('a', { size: 'S', model: 'cheap' })]), 1);
    assert.equal(streakEffortPoints([bead('a', { size: 'M', model: 'standard' }), bead('b', { size: 'L', model: 'premium' })]), (2 + 4) * 20);
});

test('streakEffortPoints: missing size defaults to M, missing model weight defaults to standard', () => {
    // 1 bead, no size (M=2), no model (weight 10) -> 20.
    assert.equal(streakEffortPoints([bead('a')]), 20);
});

// -----------------------------------------------------------------------------
// beadBlocksDependencyIds
// -----------------------------------------------------------------------------
test('beadBlocksDependencyIds: accepts plain id strings and bd object entries; ignores parent-child', () => {
    assert.deepEqual(beadBlocksDependencyIds(bead('x', { deps: ['a', 'b'] })), ['a', 'b']);
    assert.deepEqual(
        beadBlocksDependencyIds(bead('x', {
            deps: [
                { id: 'a', dependency_type: 'blocks' },
                { id: 'p', dependency_type: 'parent-child' },
                { depends_on_id: 'c' },
            ],
        })),
        ['a', 'c']
    );
    assert.deepEqual(beadBlocksDependencyIds(bead('x')), []);
});

// -----------------------------------------------------------------------------
// resolveWorklistTierPolicy (the model-switch-on-resume CAPABILITY seam)
// -----------------------------------------------------------------------------
test('resolveWorklistTierPolicy: BATCH always requires tier-homogeneous worklists', () => {
    assert.deepEqual(resolveWorklistTierPolicy({ mode: 'batch', resumeModelSwitch: true }), { tierHomogeneous: true });
    assert.deepEqual(resolveWorklistTierPolicy({ mode: 'batch' }), { tierHomogeneous: true });
});

test('resolveWorklistTierPolicy: RESUMED SEQUENCE without model-switch-on-resume capability falls back to tier-homogeneous grouping', () => {
    // The capability check asserted by apra-fleet-eft.79's AC: a provider
    // without model-switch-on-resume must never receive a mixed-tier worklist.
    assert.deepEqual(resolveWorklistTierPolicy({ mode: 'resume' }), { tierHomogeneous: true });
    assert.deepEqual(resolveWorklistTierPolicy({ mode: 'resume', resumeModelSwitch: false }), { tierHomogeneous: true });
    assert.deepEqual(resolveWorklistTierPolicy({ mode: 'resume', resumeModelSwitch: true }), { tierHomogeneous: false });
});

// -----------------------------------------------------------------------------
// hasContextHeadroomForResume (apra-fleet-eft.81 seam fallback)
// -----------------------------------------------------------------------------
test('hasContextHeadroomForResume: unknown usage admits; at/over the ceiling fraction refuses', () => {
    assert.equal(hasContextHeadroomForResume(null), true);
    assert.equal(hasContextHeadroomForResume({}), true);
    // Defaults: ceiling 150000 x 0.9 = 135000.
    assert.equal(hasContextHeadroomForResume({ total_tokens: 100000 }), true);
    assert.equal(hasContextHeadroomForResume({ total_tokens: 135000 }), false);
    assert.equal(hasContextHeadroomForResume({ total_tokens: 149000 }), false);
    // Custom ceiling/fraction.
    assert.equal(hasContextHeadroomForResume({ total_tokens: 90 }, { contextCeiling: 100, ceilingFraction: 0.5 }), false);
    assert.equal(hasContextHeadroomForResume({ total_tokens: 40 }, { contextCeiling: 100, ceilingFraction: 0.5 }), true);
});

// -----------------------------------------------------------------------------
// assignDoerWorklists: pass-through (no packing needed)
// -----------------------------------------------------------------------------
test('assignDoerWorklists: streaks <= doers is a pass-through -- one streak per doer, input order, no overflow', () => {
    const s1 = [bead('a', { priority: 3 })];
    const s2 = [bead('b', { priority: 0 })];
    const res = assignDoerWorklists([s1, s2], 3);
    assert.equal(res.packed, false);
    assert.deepEqual(res.overflow, []);
    // Exact input order, NOT re-sorted by priority -- pre-eft.79 behavior.
    assert.deepEqual(flatIds(res.worklists), [['a'], ['b']]);
    // The ORIGINAL streak arrays are returned, not copies of the beads.
    assert.equal(res.worklists[0][0], s1);
});

test('assignDoerWorklists: empty/invalid input -> empty result', () => {
    assert.deepEqual(assignDoerWorklists([], 2), { worklists: [], overflow: [], packed: false });
    assert.deepEqual(assignDoerWorklists(null, 2), { worklists: [], overflow: [], packed: false });
    assert.deepEqual(assignDoerWorklists([[bead('a')]], 0), { worklists: [], overflow: [], packed: false });
});

// -----------------------------------------------------------------------------
// Priority ordering (AC, added 2026-07-30)
// -----------------------------------------------------------------------------
test('priority ordering: 3 independent streaks P2/P0/P1 produce a worklist ordered P0, P1, P2', () => {
    const p2 = [bead('p2', { priority: 2, model: 'standard' })];
    const p0 = [bead('p0', { priority: 0, model: 'standard' })];
    const p1 = [bead('p1', { priority: 1, model: 'standard' })];
    const res = assignDoerWorklists([p2, p0, p1], 1);
    assert.equal(res.packed, true);
    assert.deepEqual(res.overflow, []);
    assert.deepEqual(flatIds(res.worklists), [['p0', 'p1', 'p2']]);
});

test('priority ordering: streak priority is the MIN priority across its member beads', () => {
    // Streak A carries a P3 and a P0 bead -> effective priority 0, so it
    // outranks streak B's uniform P1.
    const a = [bead('a1', { priority: 3, model: 'standard' }), bead('a2', { priority: 0, model: 'standard' })];
    const b = [bead('b1', { priority: 1, model: 'standard' })];
    const res = assignDoerWorklists([b, a], 1);
    assert.deepEqual(flatIds(res.worklists), [['a1+a2', 'b1']]);
});

test('priority never overrides a real blocks-edge dependency: the dependent dispatches after its dependency regardless of priority', () => {
    // Streak B (P0) declares a blocks dependency on streak A's bead (P3):
    // dependency order wins -- A first, B second, on the SAME worklist.
    const a = [bead('a', { priority: 3, model: 'standard' })];
    const b = [bead('b', { priority: 0, model: 'standard', deps: [{ id: 'a', dependency_type: 'blocks' }] })];
    const res = assignDoerWorklists([a, b], 1);
    assert.equal(res.packed, true);
    assert.deepEqual(res.overflow, []);
    assert.deepEqual(flatIds(res.worklists), [['a', 'b']]);
});

test('priority tie-break: equal-priority streaks keep the existing deterministic input order (lane minOrder/streakId/title/id), no new nondeterminism', () => {
    // Input order IS the existing tie-break: groupStreaksFromLaneMetadata
    // already sorted lanes by minOrder then streakId, and selectStreaks'
    // fallback follows the title/id-sorted ready list.
    const s1 = [bead('t1', { priority: 1, model: 'standard' })];
    const s2 = [bead('t2', { priority: 1, model: 'standard' })];
    const s3 = [bead('t3', { priority: 1, model: 'standard' })];
    const res1 = assignDoerWorklists([s1, s2, s3], 1);
    assert.deepEqual(flatIds(res1.worklists), [['t1', 't2', 't3']]);
    // Determinism: identical input -> identical output, twice.
    const res2 = assignDoerWorklists([s1, s2, s3], 1);
    assert.deepEqual(flatIds(res2.worklists), flatIds(res1.worklists));
});

// -----------------------------------------------------------------------------
// Effort-point budget (AC): overflow queues to the next round
// -----------------------------------------------------------------------------
test('effort budget: streaks that would exceed the per-doer budget overflow to the next round rather than over-assigning', () => {
    // Each streak: 1 bead, M (2 pts) x standard (10) = 20 effort. Budget 45
    // fits two (40); the third overflows.
    const s1 = [bead('e1', { model: 'standard' })];
    const s2 = [bead('e2', { model: 'standard' })];
    const s3 = [bead('e3', { model: 'standard' })];
    const res = assignDoerWorklists([s1, s2, s3], 1, { effortBudget: 45 });
    assert.deepEqual(flatIds(res.worklists), [['e1', 'e2']]);
    assert.deepEqual(res.overflow.map((s) => s[0].id), ['e3']);
});

test('effort budget: an empty worklist always accepts (a single over-budget streak still dispatches)', () => {
    // One L+premium streak = 4 x 20 = 80 effort against a budget of 10:
    // it must still be assigned (the planner should have split it; starving
    // it forever is worse) -- but nothing else may pile on after it.
    const big = [bead('big', { size: 'L', model: 'premium' })];
    const s2 = [bead('after', { size: 'S', model: 'premium' })];
    const res = assignDoerWorklists([big, s2], 1, { effortBudget: 10 });
    assert.deepEqual(flatIds(res.worklists), [['big']]);
    assert.deepEqual(res.overflow.map((s) => s[0].id), ['after']);
});

test('effort budget: defaults to the planner.md threshold constant (200)', () => {
    // 10 x M-standard streaks (20 effort each) on 1 doer: exactly 10 fit
    // under the default 200 budget... the 11th overflows.
    const streaks = Array.from({ length: 11 }, (_, i) => [bead(`d${String(i).padStart(2, '0')}`, { model: 'standard' })]);
    const res = assignDoerWorklists(streaks, 1);
    assert.equal(DEFAULT_EFFORT_THRESHOLD, 200);
    assert.equal(res.worklists[0].length, 10);
    assert.equal(res.overflow.length, 1);
});

// -----------------------------------------------------------------------------
// Tier-homogeneous grouping + TIER-OUTLIER ISOLATION (AC, added 2026-07-30)
// -----------------------------------------------------------------------------
test('tier grouping: a cheap+premium pairing is never assigned to the same (batchable) worklist', () => {
    const cheap = [bead('c1', { model: 'cheap' })];
    const premium = [bead('p1', { model: 'premium' })];
    const cheap2 = [bead('c2', { model: 'cheap' })];
    const res = assignDoerWorklists([cheap, premium, cheap2], 1, { tierHomogeneous: true });
    assert.equal(res.packed, true);
    assert.deepEqual(res.overflow, []);
    // Two separate tier-pure worklists (round-robined onto the one doer as
    // separate dispatches) -- never one mixed worklist, never deferred.
    assert.deepEqual(flatIds(res.worklists), [['c1', 'c2'], ['p1']]);
});

test('tier-outlier isolation: 8 standard + 1 premium + 1 cheap -> the outliers each get their own dedicated worklist slot, never merged into a standard-tier worklist', () => {
    const standards = Array.from({ length: 8 }, (_, i) => [bead(`s${i}`, { model: 'standard' })]);
    const premium = [bead('prem', { model: 'premium' })];
    const cheap = [bead('chp', { model: 'cheap' })];
    for (const tierHomogeneous of [true, false]) {
        const res = assignDoerWorklists([...standards, premium, cheap], 3, { tierHomogeneous });
        assert.equal(res.packed, true, `packed (tierHomogeneous=${tierHomogeneous})`);
        assert.deepEqual(res.overflow, [], `no overflow (tierHomogeneous=${tierHomogeneous})`);
        const lists = flatIds(res.worklists);
        const premiumList = lists.find((wl) => wl.includes('prem'));
        const cheapList = lists.find((wl) => wl.includes('chp'));
        // Each outlier sits ALONE in its own dedicated worklist slot -- even
        // though every standard worklist has effort-budget headroom to spare.
        assert.deepEqual(premiumList, ['prem'], `premium isolated (tierHomogeneous=${tierHomogeneous}), got ${JSON.stringify(lists)}`);
        assert.deepEqual(cheapList, ['chp'], `cheap isolated (tierHomogeneous=${tierHomogeneous}), got ${JSON.stringify(lists)}`);
        // And every standard streak is in a standard-only worklist.
        const standardLists = lists.filter((wl) => wl.some((id) => id.startsWith('s')));
        assert.ok(standardLists.every((wl) => wl.every((id) => id.startsWith('s'))), `standard worklists stay pure, got ${JSON.stringify(lists)}`);
    }
});

test('tier partitions outnumber doers under tier-homogeneous policy: separate tier-pure worklists round-robin the doer pool (separate dispatches, no deferral)', () => {
    // cheap + standard + premium on TWO doers, homogeneous: 3 tier-pure
    // worklists come back; the dispatch site round-robins them over the two
    // doers. Nothing overflows and nothing mixes.
    const c = [bead('c', { model: 'cheap' })];
    const s = [bead('s', { model: 'standard' })];
    const p = [bead('p', { model: 'premium' })];
    const res = assignDoerWorklists([c, s, p], 2, { tierHomogeneous: true });
    assert.deepEqual(res.overflow, []);
    assert.deepEqual(flatIds(res.worklists), [['c'], ['s'], ['p']]);
});

test('same-tier packing balances across doers: 4 streaks / 2 doers -> ordered 2-streak worklists each', () => {
    const streaks = ['w', 'x', 'y', 'z'].map((id, i) => [bead(id, { priority: i, model: 'standard' })]);
    const res = assignDoerWorklists(streaks, 2);
    assert.deepEqual(res.overflow, []);
    assert.deepEqual(flatIds(res.worklists), [['w', 'y'], ['x', 'z']]);
});

// -----------------------------------------------------------------------------
// Mixed-tier (capability-gated) merging: contiguous outlier runs
// -----------------------------------------------------------------------------
test('mixed tiers allowed (capability-gated): partitions merge into at most doerCount worklists, each tier as its OWN CONTIGUOUS run, never interleaved', () => {
    // 2 cheap + 2 standard on ONE doer with the model-switch-on-resume
    // capability: one worklist, cheap block then standard block -- the
    // outlier tier is a contiguous run, not interleaved by priority across
    // tier boundaries.
    const c1 = [bead('c1', { priority: 1, model: 'cheap' })];
    const s1 = [bead('s1', { priority: 0, model: 'standard' })];
    const c2 = [bead('c2', { priority: 3, model: 'cheap' })];
    const s2 = [bead('s2', { priority: 2, model: 'standard' })];
    const res = assignDoerWorklists([c1, s1, c2, s2], 1, { tierHomogeneous: false });
    assert.equal(res.worklists.length, 1);
    assert.deepEqual(res.overflow, []);
    const orderIds = res.worklists[0].map((s) => s[0].id);
    // Global priority order is s1(P0), c1(P1), s2(P2), c2(P3); the first
    // partition to appear is `standard` (via s1), so the worklist is the
    // standard block (priority-ordered) followed by the cheap block
    // (priority-ordered) -- contiguous per tier.
    assert.deepEqual(orderIds, ['s1', 's2', 'c1', 'c2']);
});

test('mixed-tier merge never interleaves: tier blocks stay contiguous even when interleaving would better match global priority', () => {
    const tiersOf = (wl) => wl.map((s) => streakRequiredTier(s));
    const c1 = [bead('c1', { priority: 0, model: 'cheap' })];
    const s1 = [bead('s1', { priority: 1, model: 'standard' })];
    const c2 = [bead('c2', { priority: 2, model: 'cheap' })];
    const s2 = [bead('s2', { priority: 3, model: 'standard' })];
    const res = assignDoerWorklists([c1, s1, c2, s2], 1, { tierHomogeneous: false });
    const tiers = tiersOf(res.worklists[0]);
    // Exactly one tier boundary -- each tier is one contiguous run.
    let boundaries = 0;
    for (let i = 1; i < tiers.length; i++) if (tiers[i] !== tiers[i - 1]) boundaries++;
    assert.equal(boundaries, 1, `expected contiguous tier runs, got ${JSON.stringify(tiers)}`);
});

// -----------------------------------------------------------------------------
// Dependency edge cases
// -----------------------------------------------------------------------------
test('dependency whose in-round dependency overflowed overflows too (never dispatched before its dependency)', () => {
    // Budget forces s2 to overflow; s3 depends on s2's bead, so it must
    // overflow as well even though budget headroom would admit it.
    const s1 = [bead('d1', { size: 'L', model: 'standard' })]; // 40
    const s2 = [bead('d2', { size: 'L', model: 'standard' })]; // 40 -> over 50 budget
    const s3 = [bead('d3', { size: 'S', model: 'standard', deps: [{ id: 'd2', dependency_type: 'blocks' }] })];
    const res = assignDoerWorklists([s1, s2, s3], 1, { effortBudget: 50 });
    assert.deepEqual(flatIds(res.worklists), [['d1']]);
    assert.deepEqual(res.overflow.map((s) => s[0].id), ['d2', 'd3']);
});

test('cross-tier blocks edge is never order-guaranteed by mixing tiers: the dependent overflows to the next round', () => {
    // B (standard) depends on A (premium) under tier-homogeneous policy:
    // tier purity is never sacrificed for a dependency -- B waits a round.
    const a = [bead('xa', { model: 'premium' })];
    const b = [bead('xb', { model: 'standard', deps: [{ id: 'xa', dependency_type: 'blocks' }] })];
    const c = [bead('xc', { model: 'standard' })];
    const res = assignDoerWorklists([a, b, c], 1, { tierHomogeneous: true });
    assert.deepEqual(flatIds(res.worklists), [['xa'], ['xc']]);
    assert.deepEqual(res.overflow.map((s) => s[0].id), ['xb']);
});
