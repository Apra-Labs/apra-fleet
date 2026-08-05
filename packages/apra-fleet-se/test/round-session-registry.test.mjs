import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createRoundSessionRegistry,
    DEFAULT_CONTEXT_CEILING,
} from '../fleet-sprint/runner.js';

// =============================================================================
// apra-fleet-eft.78.3 -- unit coverage for the per-(role, cycle) session
// registry that drives auto-sprint's "round resume". This isolates the core
// guard logic the engine wires into the planner (R1->R2->R3) and reviewer
// (R1->R2->R3) dispatch sites in runner.js. The full end-to-end mock-sprint
// wiring (planner R2 carries resume=, reviewer R2 carries reviewer R1's id,
// cross-cycle plan dispatches carry resume=false, a prior-round error -> fresh)
// is exercised through runSprintCycle() by apra-fleet-eft.78.4; this test pins
// the semantics the engine relies on so a regression is caught cheaply.
// =============================================================================

test('R1 (no prior round) resumes nothing -- resumeArgFor returns false', () => {
    const reg = createRoundSessionRegistry();
    assert.equal(reg.resumeArgFor('planner', 1), false);
    assert.equal(reg.resumeArgFor('reviewer', 1), false);
});

test('R2 within the SAME cycle resumes R1\'s explicit session id', () => {
    const reg = createRoundSessionRegistry();
    reg.record('reviewer', 1, 'sess-rev-c1r1');
    // The next round in the same cycle carries the prior round's id verbatim.
    assert.equal(reg.resumeArgFor('reviewer', 1), 'sess-rev-c1r1');

    // A later round overwrites with the freshest id (R2 -> R3).
    reg.record('reviewer', 1, 'sess-rev-c1r2');
    assert.equal(reg.resumeArgFor('reviewer', 1), 'sess-rev-c1r2');
});

test('roles are tracked independently', () => {
    const reg = createRoundSessionRegistry();
    reg.record('planner', 1, 'sess-plan');
    reg.record('reviewer', 1, 'sess-rev');
    assert.equal(reg.resumeArgFor('planner', 1), 'sess-plan');
    assert.equal(reg.resumeArgFor('reviewer', 1), 'sess-rev');
});

test('NEVER resume across cycles -- a new cycle starts fresh even before any new record', () => {
    const reg = createRoundSessionRegistry();
    reg.record('planner', 1, 'sess-plan-c1');
    assert.equal(reg.resumeArgFor('planner', 1), 'sess-plan-c1');
    // Cycle 2's first plan round must be fresh (fresh eyes), not resume C1's id.
    assert.equal(reg.resumeArgFor('planner', 2), false);
});

test('a prior-round error clears the session -> next round is fresh (no resume id)', () => {
    const reg = createRoundSessionRegistry();
    reg.record('reviewer', 1, 'sess-rev-c1r1');
    assert.equal(reg.resumeArgFor('reviewer', 1), 'sess-rev-c1r1');
    // The failed round drops the session.
    reg.clear('reviewer');
    assert.equal(reg.resumeArgFor('reviewer', 1), false);
});

test('a provider that returns no session id records nothing -> fresh (capability signal, not provider-name)', () => {
    const reg = createRoundSessionRegistry();
    reg.record('planner', 1, undefined);
    reg.record('planner', 1, '');
    reg.record('planner', 1, null);
    assert.equal(reg.resumeArgFor('planner', 1), false);
});

test('near the context ceiling -> next round is fresh even in the same cycle', () => {
    const reg = createRoundSessionRegistry();
    // A dispatch whose reported usage is at/above 90% of the ceiling flags the
    // entry so the next round starts fresh (resuming a near-full window would
    // start the next round out of room).
    reg.record('reviewer', 1, 'sess-huge', { usage: { total_tokens: DEFAULT_CONTEXT_CEILING } });
    assert.equal(reg.resumeArgFor('reviewer', 1), false);

    // A comfortably-sized dispatch resumes normally.
    reg.record('planner', 1, 'sess-small', { usage: { total_tokens: 1000 } });
    assert.equal(reg.resumeArgFor('planner', 1), 'sess-small');
});

test('a custom contextCeiling/ceilingFraction is honored', () => {
    const reg = createRoundSessionRegistry({ contextCeiling: 1000, ceilingFraction: 0.5 });
    reg.record('reviewer', 1, 'sess-over', { usage: { total_tokens: 500 } });
    assert.equal(reg.resumeArgFor('reviewer', 1), false); // 500 >= 1000 * 0.5
    reg.record('planner', 1, 'sess-under', { usage: { total_tokens: 499 } });
    assert.equal(reg.resumeArgFor('planner', 1), 'sess-under');
});
