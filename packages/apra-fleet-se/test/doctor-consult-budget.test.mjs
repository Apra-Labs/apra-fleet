import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createSprintDoctor } from '../fleet-sprint/runner.js';

// =============================================================================
// apra-fleet-iiny.9 -- record-only trigger fires must never spend the
// doctor's real consult budget.
//
// `doctor.evaluate()` serves TWO callers with very different needs from the
// SAME accepted-trigger array:
//   1. debounce bookkeeping (`consults`, fed back into evaluateTriggers() as
//      `priorConsults`) -- every accepted fire must be recorded here, even a
//      "record only, no consult is dispatched by this layer" one (the H4
//      fast-path T1/T2 evaluate() whose return value is discarded, and the
//      T5 red-state raise for a doer's BLOCKED report);
//   2. the per-sprint consult-BUDGET cap (`doctor_max_consults`) -- which
//      must be charged ONLY where a consult is actually dispatched, i.e.
//      only where createConsultLimiter's noteConsult() runs (inside
//      doctor.consult(), doctor-consult.mjs).
//
// Regression coverage for a real production incident: the sprint-doctor
// BLOCKED parent bead recorded three doer BLOCKED reports in one sprint,
// each raising T5 through doctor.evaluate() with no consult ever dispatched
// for two of them (no replan phase ran) -- and pre-fix, evaluate()'s own
// inline cap check counted every ACCEPTED fire (not every DISPATCH) against
// doctor_max_consults (default 3), so three BLOCKED beads alone exhausted
// the budget and suppressed every subsequent T1-T4 consult for the rest of
// the run.
//
// Entirely offline: a fake dispatch function is injected as `agent`, never a
// live member and never a network call.
// =============================================================================

/** A schema-valid verdict carrying an action (no probes), matching doctor-consult.test.mjs's fixture shape. */
function actionVerdict(over = {}) {
    return {
        classification: 'ENVIRONMENT',
        confidence: 'high',
        evidence: ['at least one evidence bullet'],
        matchedRegistryEntry: null,
        notes: 'notes',
        action: { kind: 'retry_different_member', member: 'member-b', reason: 'discriminating probe' },
        ...over,
    };
}

/** A queue-driven fake agent(): returns the next queued response, recording every call's opts. */
function queuedAgent(responses) {
    const queue = [...responses];
    const calls = [];
    const fn = async (prompt, opts) => {
        calls.push({ prompt, opts });
        if (queue.length === 0) throw new Error('queuedAgent: exhausted -- no more responses queued');
        const next = queue.shift();
        if (next instanceof Error) throw next;
        return next;
    };
    fn.calls = calls;
    return fn;
}

/** Records three consecutive infra-reason ('stalled') failures on one bead -- T1's firing condition. */
function recordT1Streak(doctor, beadId = 'bd-t1', member = 'member-a') {
    for (let i = 0; i < 3; i += 1) {
        doctor.record({ beadIds: [beadId], ok: false, reason: 'stalled', member, message: 'dispatch failed' });
    }
}

describe('sprint-doctor: record-only trigger fires never spend the consult budget', () => {
    test('several record-only T5 red-state fires do not suppress a later consult-bearing T1 trigger', async () => {
        const logs = [];
        const doctor = createSprintDoctor({ enabled: true, caps: { maxConsults: 1 }, log: (msg) => logs.push(msg) });

        // Three record-only T5 fires (distinct event ids, so none debounces
        // the next) -- the exact shape three BLOCKED beads raise. None of
        // these is ever followed by a doctor.consult() call, matching the
        // runner's own "recorded only -- no consult is dispatched by this
        // layer" T5 raise.
        for (const eventId of ['blocked:bd-a:1:1', 'blocked:bd-b:1:1', 'blocked:bd-c:1:1']) {
            const accepted = doctor.evaluate(
                { isNewHighWaterMark: false, redStateEvents: [{ eventId, beadIds: ['x'], summary: 'doer reported BLOCKED' }] },
                { only: ['T5'], hook: 'Develop C1 R1' },
            );
            assert.equal(accepted.length, 1, `expected T5 to be accepted for ${eventId} (the real budget must not already read as spent)`);
        }

        // The debounce ledger recorded all three record-only fires...
        assert.equal(doctor.consults().length, 3, 'all three record-only T5 fires must still be recorded for debounce');
        // ...but no real consult was ever dispatched, so the cap-reached
        // line (which only fires once the budget is truly spent) must never
        // have been logged.
        assert.equal(
            logs.filter((m) => m.includes('consult cap') && m.includes('reached')).length, 0,
            'record-only fires alone must never trip the consult cap',
        );

        // Now raise a real T1 (three consecutive infra-reason failures on
        // one bead, zero closures in between): a genuinely consult-bearing
        // trigger.
        recordT1Streak(doctor);
        const acceptedT1 = doctor.evaluate({ isNewHighWaterMark: false }, { only: ['T1'], hook: 'Cycle Evaluation C1' });
        assert.equal(
            acceptedT1.length, 1,
            `T1 must still be accepted after three record-only T5 fires with maxConsults=1: ${JSON.stringify(doctor.consults())}`,
        );
        assert.equal(acceptedT1[0].trigger, 'T1');

        // And the consult it earns must actually dispatch -- proving the
        // budget was never spent by the record-only fires above.
        const agent = queuedAgent([actionVerdict()]);
        const verdict = await doctor.consult(acceptedT1[0], {
            agent,
            consultMember: 'member-a',
            orchestratorMember: 'orchestrator-member',
            position: { branch: 'feat/doctor-consult-budget-test' },
            sprintLogText: '',
        });

        assert.ok(verdict, 'the T1 consult must actually dispatch and return a verdict');
        assert.equal(agent.calls.length, 1, 'exactly one premium dispatch must have been made for the T1 consult');
        assert.equal(
            logs.filter((m) => m.includes('consult for T1 skipped')).length, 0,
            'the T1 consult must not be skipped for a budget the record-only fires never actually spent',
        );
    });

    test('a real dispatched consult DOES spend the budget, and a subsequent trigger is then correctly suppressed', async () => {
        const logs = [];
        const doctor = createSprintDoctor({ enabled: true, caps: { maxConsults: 1 }, log: (msg) => logs.push(msg) });

        recordT1Streak(doctor);
        const acceptedT1 = doctor.evaluate({ isNewHighWaterMark: false }, { only: ['T1'], hook: 'Cycle Evaluation C1' });
        assert.equal(acceptedT1.length, 1);

        const agent = queuedAgent([actionVerdict()]);
        const verdict = await doctor.consult(acceptedT1[0], {
            agent,
            consultMember: 'member-a',
            orchestratorMember: 'orchestrator-member',
            position: { branch: 'feat/doctor-consult-budget-test' },
            sprintLogText: '',
        });
        assert.ok(verdict, 'the T1 consult must dispatch');

        // Budget (maxConsults=1) is now genuinely spent -- a further
        // record-only T5 fire must be suppressed by the cap.
        const acceptedT5 = doctor.evaluate(
            { isNewHighWaterMark: false, redStateEvents: [{ eventId: 'blocked:bd-z:1:1', beadIds: ['bd-z'], summary: 'doer reported BLOCKED' }] },
            { only: ['T5'], hook: 'Develop C1 R2' },
        );
        assert.equal(acceptedT5.length, 0, 'once the real budget is spent, further triggers must be suppressed');
        assert.equal(
            logs.filter((m) => m.includes('consult cap') && m.includes('reached')).length, 1,
            'the cap-reached line must be logged exactly once, only once the budget is truly spent',
        );
    });
});
