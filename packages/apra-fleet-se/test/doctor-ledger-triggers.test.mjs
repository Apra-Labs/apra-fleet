import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    createSprintHealthLedger,
    normalizeErrorSignature,
} from '../fleet-sprint/doctor-ledger.mjs';
import {
    evaluateTriggers,
    DEFAULT_THRESHOLDS,
} from '../fleet-sprint/doctor-triggers.mjs';
import { isInfraDispatchFailure, isInfraDispatchReason } from '../fleet-sprint/errors.mjs';

// =============================================================================
// apra-fleet-iiny.1.3 -- unit coverage for the sprint-doctor dispatch-health
// ledger (doctor-ledger.mjs) and trigger layer (doctor-triggers.mjs), the two
// pure modules from this lane (design: fleet-sprint/docs/escalate-to-llm-
// design.md sections 1.1-1.2). No fleet dispatch, no network, no member --
// everything here is plain deterministic JavaScript over in-memory data.
// =============================================================================

// -----------------------------------------------------------------------------
// Row factory: chronological ledger rows for one bead/member, matching the
// shape createSprintHealthLedger().recordDispatch() stores.
// -----------------------------------------------------------------------------
let nextTs = 1;
function row(over = {}) {
    return {
        cycle: 1,
        phaseLabel: 'Develop',
        role: 'doer',
        member: 'alice',
        beadIds: ['b1'],
        ok: false,
        reason: 'stalled',
        errorSignature: 'stalled: dispatch failed',
        durationS: 30,
        tier: 'standard',
        costUsd: 0.5,
        timestamp: nextTs++,
        ...over,
    };
}

// =============================================================================
// 1. errorSignature normalization
// =============================================================================

describe('normalizeErrorSignature', () => {
    test('two messages differing only in bead ids, paths, numbers or timestamps normalize equal', () => {
        const a = normalizeErrorSignature(
            'stalled',
            'Dispatch failed for bead sprint-doctor-abc.4 at packages/apra-fleet-se/fleet-sprint/runner.js on attempt 1'
        );
        const b = normalizeErrorSignature(
            'stalled',
            'Dispatch failed for bead sprint-doctor-xyz.9 at packages/apra-fleet-se/fleet-sprint/other.js on attempt 7'
        );
        assert.equal(a, b);
    });

    test('two genuinely different failures do not normalize equal', () => {
        const a = normalizeErrorSignature('stalled', 'no member-side progress for the whole stall threshold');
        const b = normalizeErrorSignature('dispatch_failed', 'schema invalid: missing required field summary');
        assert.notEqual(a, b);
    });

    test('strips absolute and relative paths', () => {
        const sig = normalizeErrorSignature('empty_response', 'read failed at /Users/dev/work/repo/fleet-sprint/runner.js');
        assert.ok(!sig.includes('/Users/dev'), `expected path stripped, got: ${sig}`);
        assert.match(sig, /<PATH>/);
    });

    test('strips hex blobs (git shas / hashes)', () => {
        const sig = normalizeErrorSignature(null, 'commit a1b2c3d failed to apply');
        assert.ok(!sig.includes('a1b2c3d'), `expected hex blob stripped, got: ${sig}`);
        assert.match(sig, /<HEX>/);
    });

    test('strips timestamps', () => {
        const sig = normalizeErrorSignature(null, 'observed at 2026-09-22T12:25:16.029Z during dispatch');
        assert.ok(!sig.includes('2026-09-22'), `expected timestamp stripped, got: ${sig}`);
        assert.match(sig, /<TS>/);
    });

    test('preserves substantive hyphenated words that are not bead-id-shaped (no digit)', () => {
        const sig = normalizeErrorSignature('auth', 'authentication failed: not-logged-in on this member');
        assert.match(sig, /not-logged-in/);
    });

    test('falls back to just the reason when there is no message', () => {
        assert.equal(normalizeErrorSignature('stalled', null), 'stalled');
        assert.equal(normalizeErrorSignature('stalled', ''), 'stalled');
    });

    test('uses "unknown" when there is no reason either', () => {
        const sig = normalizeErrorSignature(null, 'attempt 3 failed');
        assert.match(sig, /^unknown:/);
    });
});

// =============================================================================
// 2. Ledger JSONL artifact
// =============================================================================

describe('createSprintHealthLedger: JSONL artifact', () => {
    test('appends one valid-JSON line per recorded dispatch', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-ledger-'));
        const artifactPath = path.join(dir, 'doctor-ledger.jsonl');
        const ledger = createSprintHealthLedger({ artifactPath });

        ledger.recordDispatch(row({ beadIds: ['b1'], ok: false }));
        ledger.recordDispatch(row({ beadIds: ['b2'], ok: true, reason: null, errorSignature: null }));

        const lines = fs.readFileSync(artifactPath, 'utf8').trim().split('\n');
        assert.equal(lines.length, 2);
        for (const line of lines) {
            assert.doesNotThrow(() => JSON.parse(line));
        }
        const parsed = lines.map((l) => JSON.parse(l));
        assert.equal(parsed[0].beadIds[0], 'b1');
        assert.equal(parsed[1].ok, true);
    });

    test('an unwritable artifact path does not throw out of recordDispatch, and logs instead', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-ledger-unwritable-'));
        // Pre-create a PLAIN FILE at the spot the ledger will try to
        // mkdir/append under -- mkdirSync('<file>/sub', {recursive:true})
        // and appendFileSync are then guaranteed to fail (ENOTDIR/EEXIST),
        // giving a deterministic unwritable-path failure without touching
        // real filesystem permissions.
        const blockerPath = path.join(dir, 'not-a-directory');
        fs.writeFileSync(blockerPath, 'i am a file, not a directory');
        const artifactPath = path.join(blockerPath, 'sub', 'ledger.jsonl');

        const logs = [];
        const ledger = createSprintHealthLedger({ artifactPath, log: (msg) => logs.push(msg) });

        let threw = false;
        let returned;
        try {
            returned = ledger.recordDispatch(row());
        } catch {
            threw = true;
        }
        assert.equal(threw, false, 'recordDispatch must never throw, even on an unwritable artifact path');
        assert.ok(returned, 'recordDispatch must still return the recorded row');
        assert.ok(logs.length > 0, 'the write failure must be logged');
        assert.equal(ledger.rows().length, 1, 'the row is still kept in memory despite the artifact write failure');
    });

    test('recordDispatch keeps rows in memory even with no artifactPath configured', () => {
        const ledger = createSprintHealthLedger({});
        ledger.recordDispatch(row({ beadIds: ['b1'] }));
        ledger.recordDispatch(row({ beadIds: ['b2'] }));
        assert.equal(ledger.rows().length, 2);
    });
});

describe('createSprintHealthLedger: accessors', () => {
    test('rowsForBead filters by bead id membership', () => {
        const ledger = createSprintHealthLedger({});
        ledger.recordDispatch(row({ beadIds: ['b1'] }));
        ledger.recordDispatch(row({ beadIds: ['b1', 'b2'] }));
        ledger.recordDispatch(row({ beadIds: ['b3'] }));
        assert.equal(ledger.rowsForBead('b1').length, 2);
        assert.equal(ledger.rowsForBead('b2').length, 1);
        assert.equal(ledger.rowsForBead('b3').length, 1);
        assert.equal(ledger.rowsForBead('nope').length, 0);
    });

    test('rowsForMember filters by member', () => {
        const ledger = createSprintHealthLedger({});
        ledger.recordDispatch(row({ member: 'alice' }));
        ledger.recordDispatch(row({ member: 'bob' }));
        ledger.recordDispatch(row({ member: 'alice' }));
        assert.equal(ledger.rowsForMember('alice').length, 2);
        assert.equal(ledger.rowsForMember('bob').length, 1);
    });

    test('signatureFrequency aggregates across ALL members, not just one', () => {
        const ledger = createSprintHealthLedger({});
        ledger.recordDispatch(row({ member: 'alice', errorSignature: 'stalled: x' }));
        ledger.recordDispatch(row({ member: 'bob', errorSignature: 'stalled: x' }));
        ledger.recordDispatch(row({ member: 'carol', errorSignature: 'dispatch_failed: y' }));
        ledger.recordDispatch(row({ member: 'alice', ok: true, reason: null, errorSignature: null }));
        const freq = ledger.signatureFrequency();
        assert.equal(freq['stalled: x'], 2);
        assert.equal(freq['dispatch_failed: y'], 1);
        assert.equal(Object.keys(freq).length, 2);
    });
});

// =============================================================================
// 3-6. Trigger firing
// =============================================================================

describe('T1: same bead(set), consecutive infra/same-signature failures, zero closures', () => {
    test('does not fire below the threshold', () => {
        const rows = [row({ timestamp: 1 }), row({ timestamp: 2 })];
        const results = evaluateTriggers({ ledgerRows: rows });
        assert.equal(results.filter((r) => r.trigger === 'T1').length, 0);
    });

    test('fires exactly at the configured attempt count (default 3)', () => {
        const rows = [row({ timestamp: 1 }), row({ timestamp: 2 }), row({ timestamp: 3 })];
        const results = evaluateTriggers({ ledgerRows: rows });
        const t1 = results.filter((r) => r.trigger === 'T1');
        assert.equal(t1.length, 1);
        assert.equal(t1[0].scope, 'bead');
        assert.deepEqual(t1[0].beadIds, ['b1']);
        assert.equal(t1[0].evidenceRows.length, 3);
    });

    test('is suppressed for mixed, differing-signature substantive errors (the develop/review loop working, not a stall)', () => {
        const rows = [
            row({ timestamp: 1, reason: 'schema_invalid', errorSignature: 'schema invalid: missing summary' }),
            row({ timestamp: 2, reason: 'reopened_by_review', errorSignature: 'review: reopen for missing test' }),
            row({ timestamp: 3, reason: 'test_failure', errorSignature: 'test: assertion failed on line X' }),
        ];
        const results = evaluateTriggers({ ledgerRows: rows });
        assert.equal(results.filter((r) => r.trigger === 'T1').length, 0);
    });

    test('still fires when attempts are non-infra but share one errorSignature', () => {
        const rows = [
            row({ timestamp: 1, reason: 'weird_reason', errorSignature: 'same: signature' }),
            row({ timestamp: 2, reason: 'weird_reason', errorSignature: 'same: signature' }),
            row({ timestamp: 3, reason: 'weird_reason', errorSignature: 'same: signature' }),
        ];
        const results = evaluateTriggers({ ledgerRows: rows });
        assert.equal(results.filter((r) => r.trigger === 'T1').length, 1);
    });

    test('a closure in between resets the streak', () => {
        const rows = [
            row({ timestamp: 1 }),
            row({ timestamp: 2 }),
            row({ timestamp: 3, ok: true, reason: null, errorSignature: null }), // closure
            row({ timestamp: 4 }),
            row({ timestamp: 5 }),
        ];
        // Only 2 consecutive failures since the closure -- below threshold.
        const results = evaluateTriggers({ ledgerRows: rows });
        assert.equal(results.filter((r) => r.trigger === 'T1').length, 0);
    });

    test('an explicit lower t1AttemptCount threshold fires sooner', () => {
        const rows = [row({ timestamp: 1 }), row({ timestamp: 2 })];
        const results = evaluateTriggers({ ledgerRows: rows }, { t1AttemptCount: 2 });
        assert.equal(results.filter((r) => r.trigger === 'T1').length, 1);
    });
});

describe('T2: same member, consecutive infra failures across >= 2 distinct beads', () => {
    test('does not fire when all consecutive failures are on a single bead', () => {
        const rows = [
            row({ timestamp: 1, beadIds: ['b1'] }),
            row({ timestamp: 2, beadIds: ['b1'] }),
            row({ timestamp: 3, beadIds: ['b1'] }),
        ];
        const results = evaluateTriggers({ ledgerRows: rows });
        assert.equal(results.filter((r) => r.trigger === 'T2').length, 0);
    });

    test('fires once >= 2 distinct beads are involved at the threshold', () => {
        const rows = [
            row({ timestamp: 1, beadIds: ['b1'] }),
            row({ timestamp: 2, beadIds: ['b2'] }),
            row({ timestamp: 3, beadIds: ['b3'] }),
        ];
        const results = evaluateTriggers({ ledgerRows: rows });
        const t2 = results.filter((r) => r.trigger === 'T2');
        assert.equal(t2.length, 1);
        assert.equal(t2[0].scope, 'member');
        assert.equal(t2[0].member, 'alice');
        assert.equal(new Set(t2[0].beadIds).size, 3);
    });

    test('a non-infra failure breaks the streak (T2 has no same-signature alternative)', () => {
        const rows = [
            row({ timestamp: 1, beadIds: ['b1'] }),
            row({ timestamp: 2, beadIds: ['b2'], reason: 'schema_invalid' }),
            row({ timestamp: 3, beadIds: ['b3'] }),
        ];
        const results = evaluateTriggers({ ledgerRows: rows });
        assert.equal(results.filter((r) => r.trigger === 'T2').length, 0);
    });
});

describe('T3: cycle stagnation', () => {
    test('does not fire below the stall-cycle limit', () => {
        const results = evaluateTriggers({ staleCycles: 1 });
        assert.equal(results.filter((r) => r.trigger === 'T3').length, 0);
    });

    test('fires at the default stall-cycle limit (2)', () => {
        assert.equal(DEFAULT_THRESHOLDS.t3StallCycleLimit, 2);
        const results = evaluateTriggers({ staleCycles: 2 });
        const t3 = results.filter((r) => r.trigger === 'T3');
        assert.equal(t3.length, 1);
        assert.equal(t3[0].scope, 'sprint');
    });

    test('respects a caller-overridden threshold', () => {
        const results = evaluateTriggers({ staleCycles: 3 }, { t3StallCycleLimit: 5 });
        assert.equal(results.filter((r) => r.trigger === 'T3').length, 0);
    });
});

describe('T4: spend-without-progress', () => {
    test('flat-default path: fires at the flat $25 default when no budget is configured', () => {
        assert.equal(DEFAULT_THRESHOLDS.t4SpendTriggerFlatUsd, 25);
        assert.equal(evaluateTriggers({ spentSinceHighWaterMark: 20 }).filter((r) => r.trigger === 'T4').length, 0);
        assert.equal(evaluateTriggers({ spentSinceHighWaterMark: 30 }).filter((r) => r.trigger === 'T4').length, 1);
    });

    test('percentage path: fires at 15% of a configured budget total when that is below the flat cap', () => {
        // budget.total=100 -> 15% = $15, well under the $25 flat cap.
        assert.equal(evaluateTriggers({ budget: { total: 100 }, spentSinceHighWaterMark: 14 }).filter((r) => r.trigger === 'T4').length, 0);
        assert.equal(evaluateTriggers({ budget: { total: 100 }, spentSinceHighWaterMark: 16 }).filter((r) => r.trigger === 'T4').length, 1);
    });

    test('percentage path is capped by the flat default when 15% of budget exceeds it', () => {
        // budget.total=1000 -> 15% = $150, capped down to the $25 flat figure.
        assert.equal(evaluateTriggers({ budget: { total: 1000 }, spentSinceHighWaterMark: 24 }).filter((r) => r.trigger === 'T4').length, 0);
        assert.equal(evaluateTriggers({ budget: { total: 1000 }, spentSinceHighWaterMark: 26 }).filter((r) => r.trigger === 'T4').length, 1);
    });
});

describe('T5: unforeseen red state, single-shot per event', () => {
    test('fires once for a newly raised event', () => {
        const results = evaluateTriggers({ redStateEvents: [{ eventId: 'evt-1', summary: 'unrecognized phase crash' }] });
        const t5 = results.filter((r) => r.trigger === 'T5');
        assert.equal(t5.length, 1);
        assert.equal(t5[0].summary, 'unrecognized phase crash');
    });

    test('never fires twice for the same event id, even across separate evaluate calls', () => {
        const event = { eventId: 'evt-1', summary: 'unrecognized phase crash' };
        const first = evaluateTriggers({ redStateEvents: [event] });
        assert.equal(first.filter((r) => r.trigger === 'T5').length, 1);

        // Caller records the consult (as the runner's own consult ledger
        // would) and re-evaluates in a later cycle with the SAME event still
        // present in its accumulated event list.
        const priorConsults = [{ trigger: 'T5', key: 'event:evt-1', actionExecuted: true, firedAt: 1 }];
        const second = evaluateTriggers({ redStateEvents: [event], priorConsults, now: 999999 });
        assert.equal(second.filter((r) => r.trigger === 'T5').length, 0);
    });

    test('a different event id still fires independently', () => {
        const priorConsults = [{ trigger: 'T5', key: 'event:evt-1', actionExecuted: true, firedAt: 1 }];
        const results = evaluateTriggers({ redStateEvents: [{ eventId: 'evt-2', summary: 'other' }], priorConsults });
        assert.equal(results.filter((r) => r.trigger === 'T5').length, 1);
    });
});

// =============================================================================
// 7. Guards: new-high-water-mark suppression, debounce
// =============================================================================

describe('guard: a new-high-water-mark cycle suppresses T2-T5 but NOT T1', () => {
    test('T1 still fires on a high-water-mark cycle', () => {
        const rows = [row({ timestamp: 1 }), row({ timestamp: 2 }), row({ timestamp: 3 })];
        const results = evaluateTriggers({ ledgerRows: rows, isNewHighWaterMark: true });
        assert.equal(results.filter((r) => r.trigger === 'T1').length, 1);
    });

    test('T2 is suppressed on a high-water-mark cycle even when its own condition holds', () => {
        const rows = [
            row({ timestamp: 1, beadIds: ['b1'] }),
            row({ timestamp: 2, beadIds: ['b2'] }),
            row({ timestamp: 3, beadIds: ['b3'] }),
        ];
        const results = evaluateTriggers({ ledgerRows: rows, isNewHighWaterMark: true });
        assert.equal(results.filter((r) => r.trigger === 'T2').length, 0);
    });

    test('T3 is suppressed on a high-water-mark cycle even when staleCycles is (stale-looking) high', () => {
        const results = evaluateTriggers({ staleCycles: 5, isNewHighWaterMark: true });
        assert.equal(results.filter((r) => r.trigger === 'T3').length, 0);
    });

    test('T4 is suppressed on a high-water-mark cycle even when spend is high', () => {
        const results = evaluateTriggers({ spentSinceHighWaterMark: 100, isNewHighWaterMark: true });
        assert.equal(results.filter((r) => r.trigger === 'T4').length, 0);
    });

    test('T5 is suppressed on a high-water-mark cycle even for a fresh event', () => {
        const results = evaluateTriggers({ redStateEvents: [{ eventId: 'evt-hwm' }], isNewHighWaterMark: true });
        assert.equal(results.filter((r) => r.trigger === 'T5').length, 0);
    });
});

describe('guard: debounce holds a repeat (trigger, bead-or-member) pair', () => {
    test('a fired T1 pair stays suppressed while no action has been executed', () => {
        const rows = [row({ timestamp: 1 }), row({ timestamp: 2 }), row({ timestamp: 3 })];
        const first = evaluateTriggers({ ledgerRows: rows });
        assert.equal(first.filter((r) => r.trigger === 'T1').length, 1);

        const priorConsults = [{ trigger: 'T1', key: 'bead:b1', actionExecuted: false, firedAt: 3 }];
        const second = evaluateTriggers({ ledgerRows: rows, priorConsults });
        assert.equal(second.filter((r) => r.trigger === 'T1').length, 0);
    });

    test('stays suppressed even after an executed action, until a NEW failure is recorded', () => {
        const rows = [row({ timestamp: 1 }), row({ timestamp: 2 }), row({ timestamp: 3 })];
        const priorConsults = [{ trigger: 'T1', key: 'bead:b1', actionExecuted: true, firedAt: 3 }];
        // No failure AFTER firedAt=3 yet (the streak is unchanged) -- still suppressed.
        const results = evaluateTriggers({ ledgerRows: rows, priorConsults });
        assert.equal(results.filter((r) => r.trigger === 'T1').length, 0);
    });

    test('re-fires once an executed action is followed by a new failure', () => {
        const rows = [row({ timestamp: 1 }), row({ timestamp: 2 }), row({ timestamp: 3 }), row({ timestamp: 4 })];
        const priorConsults = [{ trigger: 'T1', key: 'bead:b1', actionExecuted: true, firedAt: 3 }];
        const results = evaluateTriggers({ ledgerRows: rows, priorConsults });
        assert.equal(results.filter((r) => r.trigger === 'T1').length, 1);
    });

    test('debounce is scoped per (trigger, key) pair -- a different bead is unaffected', () => {
        const rows = [
            row({ timestamp: 1, beadIds: ['b1'] }),
            row({ timestamp: 2, beadIds: ['b1'] }),
            row({ timestamp: 3, beadIds: ['b1'] }),
            row({ timestamp: 4, beadIds: ['b9'] }),
            row({ timestamp: 5, beadIds: ['b9'] }),
            row({ timestamp: 6, beadIds: ['b9'] }),
        ];
        const priorConsults = [{ trigger: 'T1', key: 'bead:b1', actionExecuted: false, firedAt: 3 }];
        const results = evaluateTriggers({ ledgerRows: rows, priorConsults });
        const t1 = results.filter((r) => r.trigger === 'T1');
        assert.equal(t1.length, 1);
        assert.deepEqual(t1[0].beadIds, ['b9']);
    });
});

// =============================================================================
// Mutation self-checks: prove each guard/threshold is load-bearing, not
// vacuously passing (verified by temporarily breaking each guard locally).
// =============================================================================

describe('mutation self-check', () => {
    test('removing the mixed-signature guard would let T1 fire on substantive develop/review churn (proves the guard matters)', () => {
        const rows = [
            row({ timestamp: 1, reason: 'schema_invalid', errorSignature: 'a' }),
            row({ timestamp: 2, reason: 'schema_invalid', errorSignature: 'b' }),
            row({ timestamp: 3, reason: 'schema_invalid', errorSignature: 'c' }),
        ];
        // The real evaluator suppresses this.
        assert.equal(evaluateTriggers({ ledgerRows: rows }).filter((r) => r.trigger === 'T1').length, 0);
        // A naive "just count consecutive failures" implementation (the bug
        // this guard exists to prevent) WOULD have fired here -- i.e. this
        // scenario is a real positive case for the guard, not a vacuous one.
        assert.equal(rows.length, DEFAULT_THRESHOLDS.t1AttemptCount);
        assert.equal(new Set(rows.map((r) => r.errorSignature)).size, 3);
    });

    test('removing the bead-diversity requirement would let one hard bead impersonate a sick member (proves T2 needs it)', () => {
        const rows = [
            row({ timestamp: 1, beadIds: ['b1'] }),
            row({ timestamp: 2, beadIds: ['b1'] }),
            row({ timestamp: 3, beadIds: ['b1'] }),
        ];
        assert.equal(evaluateTriggers({ ledgerRows: rows }).filter((r) => r.trigger === 'T2').length, 0);
        // Same rows WOULD satisfy T1 (single-bead trigger) -- proving the
        // scenario is a real "one hard bead" case, not an empty one.
        assert.equal(evaluateTriggers({ ledgerRows: rows }).filter((r) => r.trigger === 'T1').length, 1);
    });
});

// =============================================================================
// errors.mjs: the reason-string predicate this lane added
// =============================================================================

describe('errors.mjs: isInfraDispatchReason (the reason-string predicate doctor-triggers.mjs consumes)', () => {
    test('true for every INFRA_DISPATCH_REASONS member', () => {
        for (const reason of ['empty_response', 'dispatch_failed', 'orphan_recovery_timeout', 'stalled', 'preflight_offline']) {
            assert.equal(isInfraDispatchReason(reason), true, `expected ${reason} to be an infra reason`);
        }
    });

    test('false for a non-infra reason', () => {
        assert.equal(isInfraDispatchReason('schema_invalid'), false);
        assert.equal(isInfraDispatchReason(undefined), false);
    });

    test('isInfraDispatchFailure keeps its original err-object signature and delegates to the same list', () => {
        assert.equal(isInfraDispatchFailure({ details: { reason: 'stalled' } }), true);
        assert.equal(isInfraDispatchFailure({ details: { reason: 'schema_invalid' } }), false);
        assert.equal(isInfraDispatchFailure({}), false);
        assert.equal(isInfraDispatchFailure(null), false);
    });
});
