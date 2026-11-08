// A long paused-awaiting-decision wait touches no sprint member and keeps
// every reservation: its only member commands are the pause-exempt
// `bd show` reads of the decision bead on the backlog member, one per read
// poll interval (5 minutes by default).
//
// The REAL engine (FleetWorkflow: its pause gate, requestPause/requestResume,
// requestStop and the run stop signal), the REAL cli.mjs reservation wiring
// (wirePauseReservations, with counting release/re-reserve seams) and the REAL
// createDecisionWait, driven by a fake clock (node:test mock timers) through
// 300 poll intervals of 60s -- five hours. The fleet API is a fake whose
// executeCommand() records every member command (with its member and
// pauseExempt-ness) and answers the decision bead as open until a test closes
// it (as an out-of-process `bd human respond` would).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FleetWorkflow, CancelledError } from '@apralabs/apra-fleet-workflow';
import { wirePauseReservations } from '../bin/cli.mjs';
import {
    createDecisionWait, answerPendingDecision, activeDecisionWaits, DECISION_PAUSE_SOURCE,
} from '../fleet-sprint/decision-wait.mjs';

const POLL_MS = 60_000;
const READ_POLL_MS = 5 * 60_000;
const INTERVALS = 300; // 5 hours at 60s
const SHOW = 'bd show x-dec --json';

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
    const detailed = [];
    const bead = { status: 'open', response: null };
    const counts = { pulls: 0, pushes: 0 };
    let hangNextShow = false;
    const fleetApi = {
        async executePrompt() { throw new Error('no agent dispatch expected'); },
        async executeCommand(payload) {
            memberCommands.push(payload.command);
            detailed.push({ command: payload.command, member: payload.member_name });
            const cmd = payload.command;
            if (cmd.startsWith('bd show') && hangNextShow) {
                hangNextShow = false;
                // Behaves like the real client: rejects with ABORTED once the
                // run's stop signal fires.
                return new Promise((_, reject) => {
                    payload.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ABORTED' })), { once: true });
                });
            }
            let text = '';
            if (cmd.startsWith('bd show')) text = JSON.stringify([{ id: 'x-dec', status: bead.status }]);
            else if (cmd.startsWith('bd comments')) text = JSON.stringify(bead.response ? [{ text: `Response: ${bead.response}` }] : []);
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
            stopSignal: ctx.stopSignal, member: 'backlog-member', pollIntervalMs: POLL_MS, readPollIntervalMs: READ_POLL_MS,
            pullBeads: async () => { counts.pulls += 1; }, pushBeads: async () => { counts.pushes += 1; },
            log: (m) => logs.push(m),
        });
        return wait.awaitAnswer({ where: 'test', cycle: 1 });
    });
    run.catch(() => {}); // asserted by each test
    return {
        wf, run, memberCommands, detailed, reservations, events, logs, sprintState, counts,
        /** Out of process: `bd human respond x-dec "<answer>"` closed the decision bead. */
        respondOutOfProcess(answer) { bead.status = 'closed'; bead.response = answer; },
        hangNextShow() { hangNextShow = true; },
    };
}

/** Advances the fake clock by the given number of poll intervals, letting the wait react to each. */
async function elapseIntervals(t, n) {
    for (let i = 0; i < n; i++) {
        t.mock.timers.tick(POLL_MS);
        await flush();
    }
}

test(`a ${INTERVALS}-interval (5 hour) wait with no answer issues only the 5-minute decision bead reads and never releases or re-acquires a reservation`, async (t) => {
    const s = startWait(t, 'decision-long-wait');
    await flush();
    assert.equal(s.events.paused, 1, 'the run is parked');
    assert.equal(s.events.pauseRequested[0].source, DECISION_PAUSE_SOURCE);
    await elapseIntervals(t, 1);
    const logLinesAfterOne = s.logs.length;
    await elapseIntervals(t, 3);
    assert.deepEqual(s.memberCommands, [], 'no read before the first 5-minute read interval');
    await elapseIntervals(t, 1);
    assert.deepEqual(s.memberCommands, [SHOW], 'the first read at 5 minutes');
    await elapseIntervals(t, INTERVALS - 5);

    assert.deepEqual(
        s.memberCommands, Array(INTERVALS * POLL_MS / READ_POLL_MS).fill(SHOW),
        'the only commands are one bd show of the decision bead per 5 minutes',
    );
    assert.ok(s.detailed.every((c) => c.member === 'backlog-member'), 'every read goes to the backlog member');
    assert.deepEqual(s.counts, { pulls: 0, pushes: 0 }, 'no beads pull or push while waiting');
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
    const reads = INTERVALS / 2 * POLL_MS / READ_POLL_MS;
    assert.deepEqual(s.memberCommands, Array(reads).fill(SHOW), 'only the periodic decision bead reads ran before the answer');

    const rec = await answerPendingDecision('decision-mid-wait', 'a: keep them');
    const answered = await s.run;

    assert.equal(rec.status, 'recorded');
    assert.equal(answered[0].answer, 'a: keep them');
    assert.equal(answered.length, 1);
    assert.equal(s.events.resumed, 1, 'exactly one resume');
    assert.equal(s.events.pauseRequested.length, 1, 'parked once for the whole wait');
    assert.deepEqual(s.reservations, { releases: 0, reReserves: 0 }, 'kept reservations need no re-acquire or resync');
    // The first command after the periodic reads is the read released by the
    // resume, then the answer is recorded on the decision bead and appended
    // to the work bead.
    assert.equal(s.memberCommands[reads], SHOW);
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
    assert.deepEqual(s.memberCommands, Array(2).fill(SHOW), 'only the two periodic reads in 10 minutes, nothing after the stop');
    assert.equal(s.events.pauseRequested.length, 1, 'never re-parked after the stop');
    assert.equal(s.events.resumed, 0);
    assert.equal(activeDecisionWaits().length, 0);
    assert.equal(s.sprintState.pendingDecisions.size, 1, 'the decision stays pending for a later run');
});

test('an answer recorded out of process with bd human respond is seen by the periodic read: the run resumes once on its own and applies it', async (t) => {
    const s = startWait(t, 'decision-out-of-process');
    await flush();
    await elapseIntervals(t, 60); // one hour: 12 reads, all open
    assert.deepEqual(s.memberCommands, Array(12).fill(SHOW));
    assert.equal(s.events.resumed, 0);

    s.respondOutOfProcess('b: drop them');
    // Within one read interval the next read sees the bead closed.
    await elapseIntervals(t, READ_POLL_MS / POLL_MS);
    const answered = await s.run;

    assert.equal(answered.length, 1);
    assert.equal(answered[0].answer, 'b: drop them');
    assert.equal(answered[0].via, 'bd human respond');
    assert.deepEqual(answered[0].released.sort(), ['x-1', 'x-2']);
    // While waiting: only bd show reads; after the closed read the run resumes
    // once, the gated read runs, and the answer text is read with bd comments.
    assert.deepEqual(s.memberCommands.slice(0, 15), [...Array(14).fill(SHOW), 'bd comments x-dec --json']);
    assert.ok(!s.memberCommands.some((c) => c.startsWith('bd human respond')), 'the bead is already answered: no respond command');
    assert.ok(s.memberCommands.slice(15).some((c) => c.startsWith('bd note x-1 --file')), 'answer appended to the work bead notes');
    assert.ok(s.detailed.every((c) => c.member === 'backlog-member'), 'every command goes to the backlog member');
    assert.equal(s.events.pauseRequested.length, 1, 'parked once');
    assert.equal(s.events.resumed, 1, 'resumed exactly once, with no operator Resume');
    assert.deepEqual(s.reservations, { releases: 0, reReserves: 0 });
    assert.deepEqual(s.counts, { pulls: 0, pushes: 1 }, 'no pull; one push after applying');
    assert.equal(s.sprintState.pendingDecisions.size, 0);
    assert.ok(s.sprintState.answeredDecisions.has('decision-out-of-process'));
    assert.ok(s.logs.some((l) => /x-dec answered with bd human respond; resuming/.test(l)), JSON.stringify(s.logs));
    assert.equal(activeDecisionWaits().length, 0);
});

test('a failing periodic read is logged once per distinct error and the wait keeps reading', async (t) => {
    const s = startWait(t, 'decision-read-fails');
    const orig = s.wf.fleetApi.executeCommand.bind(s.wf.fleetApi);
    let failing = true;
    s.wf.fleetApi.executeCommand = async (payload) => {
        if (failing && payload.command.startsWith('bd show')) {
            s.memberCommands.push(payload.command);
            return { content: [{ text: 'dolt: database is locked' }], isError: true };
        }
        return orig(payload);
    };
    await flush();
    await elapseIntervals(t, 30); // 6 failing reads
    const failLines = s.logs.filter((l) => /reading the decision bead\(s\) for an answer failed/.test(l));
    assert.equal(failLines.length, 1, JSON.stringify(s.logs));
    assert.deepEqual(s.memberCommands, Array(6).fill(SHOW));
    failing = false;
    s.respondOutOfProcess('a');
    await elapseIntervals(t, READ_POLL_MS / POLL_MS);
    const answered = await s.run;
    assert.equal(answered[0].answer, 'a');
    assert.equal(s.events.resumed, 1);
});

test('an operator stop while a periodic read is in flight rejects at once with CancelledError and runs no further command', async (t) => {
    const s = startWait(t, 'decision-stop-mid-read');
    await flush();
    s.hangNextShow();
    await elapseIntervals(t, READ_POLL_MS / POLL_MS); // the first read is now in flight and hangs
    assert.deepEqual(s.memberCommands, [SHOW]);
    s.wf.requestStop('operator stop during a decision read');
    await assert.rejects(s.run, (err) => err instanceof CancelledError && /operator stop/.test(err.message));
    await elapseIntervals(t, 60);
    assert.deepEqual(s.memberCommands, [SHOW], 'no command after the stop');
    assert.equal(s.events.resumed, 0);
    assert.equal(s.events.pauseRequested.length, 1);
});
