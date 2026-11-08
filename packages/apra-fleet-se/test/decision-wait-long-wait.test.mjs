// A long paused-awaiting-decision wait touches no member and keeps every
// reservation.
//
// The REAL engine (FleetWorkflow: its pause gate, requestPause/requestResume,
// requestStop and the run stop signal), the REAL cli.mjs reservation wiring
// (wirePauseReservations, with counting release/re-reserve seams) and the REAL
// createDecisionWait, driven by a fake clock (node:test mock timers) through
// 300 poll intervals of 60s -- five hours. The fleet API is a fake whose
// executeCommand() records every member command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FleetWorkflow, CancelledError } from '@apralabs/apra-fleet-workflow';
import { wirePauseReservations } from '../bin/cli.mjs';
import {
    createDecisionWait, answerPendingDecision, activeDecisionWaits, DECISION_PAUSE_SOURCE,
} from '../fleet-sprint/decision-wait.mjs';

const POLL_MS = 60_000;
const INTERVALS = 300; // 5 hours at 60s

const flush = () => new Promise((r) => setImmediate(r));

// Each test uses its own decision id: decision-wait.mjs keeps a process-wide
// registry of waits (answerPendingDecision looks a decision up there), and a
// stopped wait from an earlier test still lists its pending decision.
function sprintStateWithDecision(decisionId) {
    const decision = {
        decisionId, beadId: 'x-1', decisionBeadId: 'x-dec',
        question: 'Keep the cookie attributes?', options: [{ id: 'a', text: 'Keep' }, { id: 'b', text: 'Drop' }],
        recommendation: 'a', raisedBy: 'doer', cycle: 1, round: 1, notification: {},
    };
    return {
        pendingDecisions: new Map([[decision.decisionId, decision]]),
        doctorBlockedIds: new Map([
            ['x-1', { kind: 'needs-decision', blockedBy: 'x-1', reason: 'awaiting', decisionId: decision.decisionId, cycle: 1, round: 1 }],
            ['x-2', { kind: 'dependent', blockedBy: 'x-1', reason: 'dep', decisionId: decision.decisionId, cycle: 1, round: 1 }],
        ]),
    };
}

/**
 * Starts a run that immediately waits on one pending decision. Returns the
 * observable seams and the run promise (settles with the applied answers).
 */
function startWait(t, decisionId) {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const memberCommands = [];
    const fleetApi = {
        async executePrompt() { throw new Error('no agent dispatch expected'); },
        async executeCommand(payload) {
            memberCommands.push(payload.command);
            const cmd = payload.command;
            let text = '';
            if (cmd.startsWith('bd show')) text = JSON.stringify([{ id: 'x-dec', status: 'open' }]);
            else if (cmd.startsWith('node -e')) text = '/tmp/staged-body.txt';
            return { content: [{ text }], isError: false };
        },
    };
    const wf = new FleetWorkflow(fleetApi);
    const reservations = { releases: 0, reReserves: 0 };
    wirePauseReservations({
        workflow: wf,
        releaseForPause: async () => { reservations.releases += 1; },
        reReserve: async () => { reservations.reReserves += 1; return { reacquired: [] }; },
    });
    const events = { pauseRequested: [], paused: 0, resumed: 0 };
    wf.on('pause:requested', (p) => events.pauseRequested.push(p));
    wf.on('paused', () => { events.paused += 1; });
    wf.on('resumed', () => { events.resumed += 1; });
    const logs = [];
    const sprintState = sprintStateWithDecision(decisionId);
    const run = wf.runWithContext({}, async (ctx) => {
        const wait = createDecisionWait({
            sprintState, requestPause: ctx.requestPause, requestResume: ctx.requestResume, command: ctx.command,
            stopSignal: ctx.stopSignal, member: 'backlog-member', pollIntervalMs: POLL_MS, log: (m) => logs.push(m),
        });
        return wait.awaitAnswer({ where: 'test', cycle: 1 });
    });
    run.catch(() => {}); // asserted by each test
    return { wf, run, memberCommands, reservations, events, logs, sprintState };
}

/** Advances the fake clock by the given number of poll intervals, letting the wait react to each. */
async function elapseIntervals(t, n) {
    for (let i = 0; i < n; i++) {
        t.mock.timers.tick(POLL_MS);
        await flush();
    }
}

test(`a ${INTERVALS}-interval (5 hour) wait with no answer issues zero member commands and never releases or re-acquires a reservation`, async (t) => {
    const s = startWait(t, 'decision-long-wait');
    await flush();
    assert.equal(s.events.paused, 1, 'the run is parked');
    assert.equal(s.events.pauseRequested[0].source, DECISION_PAUSE_SOURCE);
    await elapseIntervals(t, 1);
    const logLinesAfterOne = s.logs.length;
    await elapseIntervals(t, INTERVALS - 1);

    assert.deepEqual(s.memberCommands, [], 'no command reached any member during the whole wait');
    assert.deepEqual(s.reservations, { releases: 0, reReserves: 0 }, 'no reservation released or re-acquired');
    assert.equal(s.events.pauseRequested.length, 1, 'parked once, not once per interval');
    assert.equal(s.events.resumed, 0, 'never resumed without an answer');
    assert.equal(s.logs.length, logLinesAfterOne, `log volume does not grow with the number of polls: ${JSON.stringify(s.logs)}`);
    assert.equal(s.logs.length, 1, 'one line: the pause itself');
    assert.ok(activeDecisionWaits().some((w) => w.pending().some((d) => d.decisionId === 'decision-long-wait')), 'still waiting');

    s.wf.requestStop('test teardown');
    await assert.rejects(s.run, (err) => err instanceof CancelledError);
});

test('an answer recorded mid-wait resumes the run exactly once; member commands start only after the answer and the bead is released', async (t) => {
    const s = startWait(t, 'decision-mid-wait');
    await flush();
    await elapseIntervals(t, INTERVALS / 2);
    assert.deepEqual(s.memberCommands, [], 'nothing ran on a member before the answer');

    const rec = await answerPendingDecision('decision-mid-wait', 'a: keep them');
    const answered = await s.run;

    assert.equal(rec.status, 'recorded');
    assert.equal(answered[0].answer, 'a: keep them');
    assert.equal(answered.length, 1);
    assert.equal(s.events.resumed, 1, 'exactly one resume');
    assert.equal(s.events.pauseRequested.length, 1, 'parked once for the whole wait');
    assert.deepEqual(s.reservations, { releases: 0, reReserves: 0 }, 'kept reservations need no re-acquire or resync');
    // The first member command is the read released by the resume, then the
    // answer is recorded on the decision bead and appended to the work bead.
    assert.match(s.memberCommands[0], /^bd show x-dec --json/);
    assert.ok(s.memberCommands.some((c) => /^bd human respond x-dec --file "/.test(c)), 'answered with bd human respond');
    assert.ok(s.memberCommands.some((c) => c.startsWith('bd note x-1 --file')), 'answer appended to the work bead notes');
    // Released: the bead and its dependent leave the set-aside map, so they
    // re-enter the ready set (the mock-sprint scenario in
    // mock-sprint-decision-wait.test.mjs shows the re-dispatch end to end).
    assert.deepEqual(answered[0].released.sort(), ['x-1', 'x-2']);
    assert.equal(s.sprintState.doctorBlockedIds.size, 0);
    assert.equal(s.sprintState.pendingDecisions.size, 0);
    assert.equal(activeDecisionWaits().length, 0, 'the wait is no longer registered as paused');
});

test('an operator stop during the wait rejects with CancelledError at once, with no further dispatch', async (t) => {
    const s = startWait(t, 'decision-stopped');
    await flush();
    await elapseIntervals(t, 10);
    s.wf.requestStop('operator stop during the decision wait');
    // No clock advance: the stop alone settles the wait.
    await assert.rejects(s.run, (err) => err instanceof CancelledError && /operator stop/.test(err.message));
    await elapseIntervals(t, 20);
    assert.deepEqual(s.memberCommands, [], 'nothing was dispatched, before or after the stop');
    assert.equal(s.events.pauseRequested.length, 1, 'never re-parked after the stop');
    assert.equal(s.events.resumed, 0);
    assert.equal(activeDecisionWaits().length, 0);
    assert.equal(s.sprintState.pendingDecisions.size, 1, 'the decision stays pending for a later run');
});
