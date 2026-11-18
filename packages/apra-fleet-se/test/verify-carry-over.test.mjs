// Unit coverage for fleet-sprint/verify-carry-over.mjs: the engine-derived
// needs-external-evidence count, the exit gate's still-open verify list
// (carried-over and deferred ids dropped), and the verdict gate that names
// the carry-over and forces FAIL for a needs-external-evidence bead or a bead
// the verify bounce cap deferred (a plain deferral stays notes-only).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    NEEDS_EXTERNAL_EVIDENCE_CYCLE_LIMIT, NEEDS_EXTERNAL_EVIDENCE, DEFERRED_VERIFY, DEFERRED_BOUNCE_CAP,
    markBounceCapDeferral, recordInconclusiveVerifyCycle, stillOpenVerifyIdsForExit, syncDeferredVerifyIds,
    buildVerifyCarryOver, formatVerifyCarryOverNotes, applyVerifyCarryOverVerdictGate,
} from '../fleet-sprint/verify-carry-over.mjs';

test('the default limit is 2 consecutive inconclusive cycles', () => {
    assert.equal(NEEDS_EXTERNAL_EVIDENCE_CYCLE_LIMIT, 2);
});

test('counter trips at the constant: open with no gap bug on N consecutive dispatches', () => {
    const counts = new Map();
    const closedIds = new Set();
    assert.deepEqual(recordInconclusiveVerifyCycle(counts, { dispatchedIds: ['v-1'], closedIds }), []);
    assert.equal(counts.get('v-1'), 1);
    assert.deepEqual(recordInconclusiveVerifyCycle(counts, { dispatchedIds: ['v-1'], closedIds }), ['v-1']);
    assert.equal(counts.get('v-1'), 2);
});

test('counter honours an explicit limit', () => {
    const counts = new Map();
    for (let i = 0; i < 2; i++) assert.deepEqual(recordInconclusiveVerifyCycle(counts, { dispatchedIds: ['v-1'], closedIds: new Set(), limit: 3 }), []);
    assert.deepEqual(recordInconclusiveVerifyCycle(counts, { dispatchedIds: ['v-1'], closedIds: new Set(), limit: 3 }), ['v-1']);
});

test('counter is per bead: only dispatched ids move, others keep their count', () => {
    const counts = new Map();
    recordInconclusiveVerifyCycle(counts, { dispatchedIds: ['v-1', 'v-2'], closedIds: new Set() });
    // v-2 not dispatched this cycle (e.g. it got a gap bug and is not eligible): untouched.
    assert.deepEqual(recordInconclusiveVerifyCycle(counts, { dispatchedIds: ['v-1'], closedIds: new Set() }), ['v-1']);
    assert.equal(counts.get('v-2'), 1);
});

test('a cycle where the bead closes resets its count', () => {
    const counts = new Map([['v-1', 1]]);
    assert.deepEqual(recordInconclusiveVerifyCycle(counts, { dispatchedIds: ['v-1'], closedIds: new Set(['v-1']) }), []);
    assert.equal(counts.has('v-1'), false);
});

test('a cycle that files a gap bug under the bead resets its count', () => {
    const counts = new Map([['v-1', 1]]);
    assert.deepEqual(recordInconclusiveVerifyCycle(counts, { dispatchedIds: ['v-1'], closedIds: new Set(), gapParentIds: ['v-1'] }), []);
    assert.equal(counts.has('v-1'), false);
    // Starts over: one more inconclusive cycle does not trip.
    assert.deepEqual(recordInconclusiveVerifyCycle(counts, { dispatchedIds: ['v-1'], closedIds: new Set() }), []);
});

test('exit gate: a deferred verify id is not in the still-open list', () => {
    const ids = stillOpenVerifyIdsForExit({
        verifyEverIds: new Set(['v-open', 'v-deferred', 'v-closed']),
        closedIds: new Set(['v-closed']),
        deferred: new Map([['v-deferred', 'deferred by the verify-route bounce cap']]),
    });
    assert.deepEqual(ids, ['v-open']);
});

test('exit gate: a needs-external-evidence verify id is not in the still-open list', () => {
    const ids = stillOpenVerifyIdsForExit({
        verifyEverIds: new Set(['v-open', 'v-ext']),
        closedIds: new Set(),
        needsEvidence: new Map([['v-ext', { reason: 'needs a host the members lack', cycles: 2 }]]),
    });
    assert.deepEqual(ids, ['v-open']);
});

test('syncDeferredVerifyIds records deferred verify ids, keeps a specific reason, drops a reopened one', () => {
    const deferred = new Map();
    markBounceCapDeferral(deferred, 'v-cap', 'deferred by the verify-route bounce cap after failing verification 3 times');
    const verifyEverIds = new Set(['v-cap', 'v-new', 'v-reopened']);
    deferred.set('v-reopened', 'deferred during the run');
    syncDeferredVerifyIds(deferred, {
        verifyEverIds,
        beads: [
            { id: 'v-cap', status: 'deferred' },
            { id: 'v-new', status: 'deferred' },
            { id: 'v-reopened', status: 'open' },
            { id: 'not-verify', status: 'deferred' },
        ],
    });
    assert.match(deferred.get('v-cap').reason, /bounce cap/);
    assert.equal(deferred.get('v-cap').bounceCap, true, 'the bounce-cap mark survives a sync');
    assert.equal(deferred.get('v-new'), 'deferred during the run');
    assert.equal(deferred.has('v-reopened'), false);
    assert.equal(deferred.has('not-verify'), false);
});

test('buildVerifyCarryOver: null when nothing carried over or everything closed after all', () => {
    assert.equal(buildVerifyCarryOver({}), null);
    assert.equal(buildVerifyCarryOver({ needsEvidence: new Map([['v-1', { reason: 'r', cycles: 2 }]]), closedIds: new Set(['v-1']) }), null);
});

test('verdict gate: needs-external-evidence forces FAIL and names the bead with the runner reason', () => {
    const carry = buildVerifyCarryOver({
        needsEvidence: new Map([['v-ext', { reason: 'acceptance needs a live run on a different OS', cycles: 2 }]]),
        deferred: new Map([['v-def', 'deferred by the verify-route bounce cap']]),
    });
    assert.deepEqual(carry.entries.map((e) => [e.id, e.kind]), [['v-ext', NEEDS_EXTERNAL_EVIDENCE], ['v-def', DEFERRED_VERIFY]]);
    const out = applyVerifyCarryOverVerdictGate({ verdict: 'PASS', notes: 'looks good' }, carry);
    assert.equal(out.verdict, 'FAIL');
    assert.match(out.notes, /needs-external-evidence[^]*v-ext[^]*acceptance needs a live run on a different OS/);
    assert.match(out.notes, /deferred[^]*v-def/);
    assert.match(out.notes, /overrode it to FAIL/);
    assert.match(out.notes, /looks good$/);
    assert.equal(formatVerifyCarryOverNotes(carry).includes('v-ext'), true);
});

test('verdict gate: a bounce-cap deferral forces FAIL even with no needs-external-evidence bead', () => {
    const deferred = new Map();
    markBounceCapDeferral(deferred, 'v-cap', 'deferred by the verify-route bounce cap after failing verification 3 times');
    const carry = buildVerifyCarryOver({ deferred });
    assert.deepEqual(carry.entries.map((e) => [e.id, e.kind]), [['v-cap', DEFERRED_BOUNCE_CAP]]);
    assert.deepEqual(carry.bounceCapIds, ['v-cap']);
    assert.deepEqual(carry.deferredIds, ['v-cap']);
    const out = applyVerifyCarryOverVerdictGate({ verdict: 'PASS', notes: 'looks good' }, carry);
    assert.equal(out.verdict, 'FAIL');
    assert.match(out.notes, /deferred-bounce-cap[^]*v-cap[^]*failing verification 3 times/);
    assert.match(out.notes, /overrode it to FAIL/);
});

test('verdict gate: a deferred-only carry-over is named but does not force FAIL', () => {
    const carry = buildVerifyCarryOver({ deferred: new Map([['v-def', 'deferred during the run']]) });
    const out = applyVerifyCarryOverVerdictGate({ verdict: 'PASS', notes: '' }, carry);
    assert.equal(out.verdict, 'PASS');
    assert.match(out.notes, /deferred[^]*v-def/);
    assert.equal(applyVerifyCarryOverVerdictGate({ verdict: 'PASS' }, null).verdict, 'PASS');
});

// ---------------------------------------------------------------------------
// Priority gate: only carried-over verify beads at/above the sprint goal
// priority force FAIL; a below-goal one is named but does not override.
// ---------------------------------------------------------------------------

test('priority gate: a P3 bounce-capped bead under a P2 goal is named and does NOT force FAIL', () => {
    const deferred = new Map(); markBounceCapDeferral(deferred, 'v-p3', 'bounced');
    const co = buildVerifyCarryOver({ deferred, atGoalIds: new Set() });
    assert.deepEqual(co.bounceCapIds, []);
    assert.deepEqual(co.belowGoalIds, ['v-p3']);
    const out = applyVerifyCarryOverVerdictGate({ verdict: 'PASS', notes: 'fine' }, co);
    assert.equal(out.verdict, 'PASS');
    assert.match(out.notes, /v-p3/);
    assert.match(out.notes, new RegExp(DEFERRED_BOUNCE_CAP));
});

test('priority gate: a P3 needs-evidence bead under a P1 goal is named and does NOT force FAIL', () => {
    const co = buildVerifyCarryOver({ needsEvidence: new Map([['v-p3', { reason: 'x', cycles: 2 }]]), atGoalIds: new Set() });
    assert.deepEqual(co.needsEvidenceIds, []);
    const out = applyVerifyCarryOverVerdictGate({ verdict: 'PASS', notes: 'fine' }, co);
    assert.equal(out.verdict, 'PASS');
    assert.match(out.notes, /v-p3/);
});

test('priority gate: a P1 bounce-capped bead under a P1 goal forces FAIL; without atGoalIds everything counts as at-goal', () => {
    const deferred = new Map(); markBounceCapDeferral(deferred, 'v-p1', 'bounced'); markBounceCapDeferral(deferred, 'v-unk', 'bounced');
    const co = buildVerifyCarryOver({ deferred, atGoalIds: new Set(['v-p1']) });
    assert.deepEqual(co.bounceCapIds, ['v-p1']);
    assert.deepEqual(buildVerifyCarryOver({ deferred }).bounceCapIds, ['v-p1', 'v-unk'], 'no atGoalIds: every carried-over bead counts as at-goal');
    assert.equal(applyVerifyCarryOverVerdictGate({ verdict: 'PASS', notes: 'fine' }, co).verdict, 'FAIL');
});
