import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { CancelledError } from '@apralabs/apra-fleet-workflow';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import {
    invalidateSyncRemoteCache, clearLastSyncedTip, clearTipProbeFailures,
} from '../fleet-sprint/dolt-sync.mjs';
import {
    createDecisionWait, activeDecisionWaits, answerFromComments, decisionPollIntervalMs, formatDecisionAnswerNote,
    decisionReadPollIntervalMs, DECISION_READ_POLL_INTERVAL_MS_DEFAULT,
    DECISION_POLL_INTERVAL_MS_DEFAULT, PAUSED_AWAITING_DECISION, DECISION_PAUSE_SOURCE,
} from '../fleet-sprint/decision-wait.mjs';

// =============================================================================
// The run parks once awaiting an operator decision instead of throwing
// StalledSprintError, and resumes on the answer without a relaunch:
// recordDecisionAnswer() (the dashboard / supervisor answer route) resumes it
// at once; a `bd human respond` made elsewhere is picked up by the periodic
// pause-exempt decision bead read (decision-wait-long-wait.test.mjs) or, as
// here, by an operator Resume. An operator stop during the pause ends the run.
// =============================================================================

const check = (cond, msg) => assert.ok(cond, msg);

const QUESTION = 'Should the session cookie keep its attributes (option a) or drop them for the local emulator (option b)?';
const OPTIONS = [
    { id: 'a', text: 'Keep the attributes and upgrade the emulator.' },
    { id: 'b', text: 'Drop the attributes locally only.' },
];
const RECOMMENDATION = 'a, it matches production.';
const decisionFor = (beadId) => ({ beadId, question: QUESTION, options: OPTIONS, recommendation: RECOMMENDATION });

// --- pure helpers ------------------------------------------------------------

test('unit: answerFromComments takes the last bd human respond comment', () => {
    assert.equal(answerFromComments([{ text: 'Response: a' }, { text: 'chatter' }, { text: 'Response: b, with care' }]), 'b, with care');
    assert.equal(answerFromComments([{ text: 'just a note' }]), 'just a note');
    assert.equal(answerFromComments([]), '');
    assert.equal(answerFromComments(null), '');
});

test('unit: the poll interval defaults to 60s and honours a positive APRA_FLEET_DECISION_POLL_MS only', () => {
    assert.equal(DECISION_POLL_INTERVAL_MS_DEFAULT, 60_000);
    assert.equal(decisionPollIntervalMs({}), 60_000);
    assert.equal(decisionPollIntervalMs({ APRA_FLEET_DECISION_POLL_MS: '250' }), 250);
    for (const bad of ['0', '-5', 'abc', '1.5', '']) {
        assert.equal(decisionPollIntervalMs({ APRA_FLEET_DECISION_POLL_MS: bad }), 60_000, `ignores ${JSON.stringify(bad)}`);
    }
});

test('unit: the decision bead read interval defaults to 5 minutes and honours a positive APRA_FLEET_DECISION_READ_POLL_MS only', () => {
    assert.equal(DECISION_READ_POLL_INTERVAL_MS_DEFAULT, 300_000);
    assert.equal(decisionReadPollIntervalMs({}), 300_000);
    assert.equal(decisionReadPollIntervalMs({ APRA_FLEET_DECISION_READ_POLL_MS: '2000' }), 2000);
    for (const bad of ['0', '-5', 'abc', '1.5', '']) {
        assert.equal(decisionReadPollIntervalMs({ APRA_FLEET_DECISION_READ_POLL_MS: bad }), 300_000, `ignores ${JSON.stringify(bad)}`);
    }
});

test('unit: the answer note carries the answer, the question and every option', () => {
    const note = formatDecisionAnswerNote({ ...decisionFor('x-1'), decisionBeadId: 'x-9' }, 'a: upgrade', 'bd human respond');
    for (const part of ['a: upgrade', QUESTION, ...OPTIONS.map((o) => o.text), RECOMMENDATION, 'x-9']) check(note.includes(part), part);
});

// A fake engine for createDecisionWait: requestPause/requestResume plus a
// command() that blocks while "paused", like the real pause gate, and that a
// stop rejects with a CancelledError. operatorResume() is a resume from
// outside the wait (the dashboard Resume button); waiting() counts the calls
// blocked at the gate.
function fakeEngine({ shows = [], resumeFailures = 0 } = {}) {
    const rec = { commands: [], pauses: [], resumes: [], published: [] };
    let paused = false;
    let waiters = [];
    let failuresLeft = resumeFailures;
    const gate = async () => {
        while (paused) await new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    };
    const engine = {
        rec,
        requestPause: (reason, opts) => { rec.pauses.push({ reason, ...opts }); paused = true; },
        requestResume: async (reason) => {
            if (failuresLeft > 0) { failuresLeft -= 1; throw new Error('member taken by another sprint'); }
            rec.resumes.push(reason);
            paused = false;
            const w = waiters; waiters = [];
            for (const x of w) x.resolve();
        },
        operatorResume: () => {
            paused = false;
            const w = waiters; waiters = [];
            for (const x of w) x.resolve();
        },
        waiting: () => waiters.length,
        stop: () => {
            paused = false;
            const w = waiters; waiters = [];
            for (const x of w) x.reject(new CancelledError('stopped'));
        },
        command: async (cmd) => {
            await gate();
            rec.commands.push(cmd);
            if (cmd.startsWith('bd show')) return JSON.stringify(shows.length > 1 ? shows.shift() : shows[0] || []);
            if (cmd.startsWith('bd comments')) return JSON.stringify([{ text: 'Response: a, go' }]);
            if (cmd.startsWith('node -e')) return '/tmp/staged.txt';
            return '';
        },
        publishState: (ns, data) => rec.published.push({ ns, data }),
    };
    return engine;
}

/** Resolves once `cond()` holds (polled on short timers); fails after `ms`. */
async function until(cond, what, ms = 5_000) {
    const deadline = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 2));
    }
}

function sprintStateWithDecision({ decisionBeadId = 'x-dec' } = {}) {
    const decision = {
        decisionId: 'decision-1-x-1', beadId: 'x-1', ...decisionFor('x-1'), decisionBeadId,
        raisedBy: 'doer', cycle: 1, round: 1, notification: {},
    };
    return {
        pendingDecisions: new Map([[decision.decisionId, decision]]),
        doctorBlockedIds: new Map([
            ['x-1', { kind: 'needs-decision', blockedBy: 'x-1', reason: `awaiting: ${QUESTION}`, decisionId: decision.decisionId, cycle: 1, round: 1 }],
            ['x-2', { kind: 'dependent', blockedBy: 'x-1', reason: 'dep', decisionId: decision.decisionId, cycle: 1, round: 1 }],
            ['y-1', { kind: 'blocked', blockedBy: 'y-1', reason: 'doer BLOCKED', cycle: 1, round: 1 }],
        ]),
    };
}

test('unit: awaitAnswer parks once (typed source); a bd human respond answer is picked up on the next operator resume and releases only that decision', async () => {
    const engine = fakeEngine({ shows: [[{ id: 'x-dec', status: 'open' }], [{ id: 'x-dec', status: 'open' }], [{ id: 'x-dec', status: 'closed' }]] });
    const sprintState = sprintStateWithDecision();
    const pulls = [];
    const logs = [];
    const wait = createDecisionWait({
        sprintState, requestPause: engine.requestPause, requestResume: engine.requestResume, command: engine.command,
        member: 'm', pullBeads: async (m) => pulls.push(m), publishState: engine.publishState, pollIntervalMs: 5, log: (m) => logs.push(m),
    });
    assert.equal(wait.hasPending(), true, 'a decision still holding its bead aside is pending (mixed with a non-decision set-aside)');
    const p = wait.awaitAnswer({ where: 'test', cycle: 1 });
    await until(() => engine.waiting() === 1, 'the read to block at the pause gate');
    assert.equal(engine.rec.commands.length, 0, 'nothing ran on the member while parked');
    // An operator Resume before anyone answered: the read runs, the clone is
    // pulled and read once more, nothing is answered, and the run is parked
    // again after one interval.
    engine.operatorResume();
    await until(() => engine.rec.pauses.length === 2 && engine.waiting() === 1, 're-parking after the empty release');
    assert.equal(pulls.length, 1, 'the empty release pulled the beads clone once');
    assert.equal(logs.filter((m) => m.includes('with no decision answered yet')).length, 1);
    // The operator answered elsewhere (bd human respond) and resumes.
    engine.operatorResume();
    const answered = await p;
    assert.equal(answered.length, 1);
    assert.equal(answered[0].answer, 'a, go');
    assert.equal(answered[0].via, 'bd human respond');
    assert.deepEqual(answered[0].released.sort(), ['x-1', 'x-2']);
    assert.equal(engine.rec.pauses[0].source, DECISION_PAUSE_SOURCE);
    assert.equal(engine.rec.resumes.length, 0, 'the wait itself never resumed: there was no in-process answer');
    check(engine.rec.commands.some((c) => c.startsWith('bd note x-1 --file')), 'the answer is appended to the work bead notes');
    check(!engine.rec.commands.some((c) => c.startsWith('bd human respond')), 'an operator-answered bead is not responded to again');
    assert.equal(sprintState.pendingDecisions.size, 0);
    assert.equal(sprintState.doctorBlockedIds.has('y-1'), true, 'a non-decision set-aside is kept');
    assert.equal(sprintState.answeredDecisions.get('decision-1-x-1').answer, 'a, go');
    assert.equal(wait.hasPending(), false);
    assert.deepEqual(engine.rec.published.map((p2) => p2.data.state), [PAUSED_AWAITING_DECISION, 'running']);
    assert.equal(sprintState.decisionWait, null);
    assert.equal(activeDecisionWaits().length, 0, 'no live wait left registered');
});

test('unit: a stop while paused rejects the wait with CancelledError at once, with no poll read', async () => {
    const engine = fakeEngine({ shows: [[{ id: 'x-dec', status: 'open' }]] });
    const sprintState = sprintStateWithDecision();
    const wait = createDecisionWait({
        sprintState, requestPause: engine.requestPause, requestResume: engine.requestResume, command: engine.command,
        member: 'm', pollIntervalMs: 60_000,
    });
    const p = wait.awaitAnswer({ where: 'test' });
    await new Promise((r) => setImmediate(r));
    assert.equal(activeDecisionWaits().length, 1, 'registered while paused');
    const started = Date.now();
    engine.stop();
    await assert.rejects(p, (err) => err instanceof CancelledError);
    check(Date.now() - started < 5_000, 'the stop does not wait out the interval');
    assert.equal(engine.rec.commands.length, 0, 'nothing ran after the stop');
    assert.equal(activeDecisionWaits().length, 0);
    assert.equal(sprintState.pendingDecisions.size, 1, 'the decision stays pending');
});

test('unit: a failed resume keeps the run parked, is retried every interval while the answer is queued, and is logged once per distinct error', async () => {
    const engine = fakeEngine({ shows: [[{ id: 'x-dec', status: 'open' }]], resumeFailures: 2 });
    const logs = [];
    const wait = createDecisionWait({
        sprintState: sprintStateWithDecision(), requestPause: engine.requestPause, requestResume: engine.requestResume,
        command: engine.command, member: 'm', pollIntervalMs: 5, log: (m) => logs.push(m),
    });
    const p = wait.awaitAnswer({ where: 'test' });
    await until(() => engine.waiting() === 1, 'the read to block at the pause gate');
    const rec = await wait.recordDecisionAnswer('decision-1-x-1', 'a');
    const answered = await p;
    assert.equal(rec.status, 'recorded');
    assert.equal(answered[0].answer, 'a');
    assert.equal(answered.length, 1);
    assert.equal(engine.rec.resumes.length, 1, 'resumed exactly once, after two failed attempts');
    assert.equal(engine.rec.pauses.length, 1, 'parked once');
    assert.equal(logs.filter((m) => m.includes('resume failed, staying paused')).length, 1, 'the same failure is logged once');
});

test('unit: recordDecisionAnswer during the wait wakes it at once and answers through bd human respond', async () => {
    const engine = fakeEngine({ shows: [[{ id: 'x-dec', status: 'open' }]] });
    const sprintState = sprintStateWithDecision();
    const wait = createDecisionWait({
        sprintState, requestPause: engine.requestPause, requestResume: engine.requestResume, command: engine.command,
        member: 'm', pollIntervalMs: 60_000,
    });
    const p = wait.awaitAnswer({ where: 'test' });
    await new Promise((r) => setImmediate(r));
    const [live] = activeDecisionWaits();
    assert.equal(live.pending()[0].decisionId, 'decision-1-x-1');
    const started = Date.now();
    const rec = await live.recordDecisionAnswer('decision-1-x-1', 'b, locally only');
    const answered = await p;
    check(Date.now() - started < 5_000, 'woken without waiting out the interval');
    assert.equal(rec.status, 'recorded');
    assert.equal(answered[0].answer, 'b, locally only');
    assert.equal(answered[0].via, 'recordDecisionAnswer');
    check(engine.rec.commands.some((c) => /^bd human respond x-dec --file "/.test(c)), 'answered with the same command an operator runs');
    check(engine.rec.commands.some((c) => c.startsWith('bd note x-1 --file')), 'answer appended to the work bead');
    await assert.rejects(() => wait.recordDecisionAnswer('decision-1-x-1', 'again'), /no pending decision/);
    await assert.rejects(() => wait.recordDecisionAnswer('nope', 'x'), /no pending decision/);
});

test('unit: recordDecisionAnswer outside a wait only records; applyRecordedAnswers applies once and pushes once; an empty answer is refused', async () => {
    const engine = fakeEngine();
    const sprintState = sprintStateWithDecision();
    const pushes = [];
    const wait = createDecisionWait({
        sprintState, requestPause: engine.requestPause, requestResume: engine.requestResume, command: engine.command,
        member: 'm', pushBeads: async (m) => pushes.push(m),
    });
    await assert.rejects(() => wait.recordDecisionAnswer('decision-1-x-1', '  '), /empty/);
    const rec = await wait.recordDecisionAnswer('decision-1-x-1', 'a');
    assert.equal(rec.status, 'recorded');
    assert.equal(engine.rec.commands.length, 0, 'recording issues no member command');
    assert.deepEqual(pushes, [], 'recording pushes nothing');
    assert.equal(wait.hasQueuedAnswers(), true);
    await assert.rejects(() => wait.recordDecisionAnswer('decision-1-x-1', 'b'), /already recorded/);
    const applied = await wait.applyRecordedAnswers();
    assert.deepEqual(applied[0].released.sort(), ['x-1', 'x-2']);
    assert.deepEqual(pushes, ['m']);
    assert.deepEqual(await wait.applyRecordedAnswers(), [], 'applied exactly once');
    assert.equal(engine.rec.commands.filter((c) => c.startsWith('bd human respond')).length, 1);
    assert.equal(engine.rec.pauses.length, 0, 'no pause needed');
});

test('unit: a decision whose decision bead could not be filed never holds the run -- no pause, no endless wait, and recordDecisionAnswer refuses it', { timeout: 30_000 }, async () => {
    const engine = fakeEngine({ shows: [[{ id: 'x-1', status: 'open' }]] });
    const sprintState = sprintStateWithDecision({ decisionBeadId: null });
    const wait = createDecisionWait({
        sprintState, requestPause: engine.requestPause, requestResume: engine.requestResume, command: engine.command,
        member: 'm', pollIntervalMs: 5,
    });
    assert.equal(wait.hasPending(), false, 'nothing can answer it, so it does not hold the run');
    assert.deepEqual(wait.unfiled().map((d) => d.decisionId), ['decision-1-x-1'], 'it is reported as unfiled');
    assert.deepEqual(await wait.awaitAnswer({ where: 'test', cycle: 1 }), [], 'awaitAnswer returns at once');
    assert.equal(engine.rec.pauses.length, 0, 'no pause was requested');
    assert.equal(engine.rec.commands.length, 0, 'no poll read');
    await assert.rejects(() => wait.recordDecisionAnswer('decision-1-x-1', 'a'), /has no decision bead/);
    assert.equal(sprintState.doctorBlockedIds.get('x-1').kind, 'needs-decision', 'the bead stays set aside');
    assert.equal(sprintState.pendingDecisions.size, 1);
});

// --- mock sprints ------------------------------------------------------------

let priorPoll;
before(() => {
    priorPoll = process.env.APRA_FLEET_DECISION_POLL_MS;
    // Long enough for a test's `bd human respond` (real bd in record mode)
    // to land before the first poll, short enough to keep the suite fast.
    process.env.APRA_FLEET_DECISION_POLL_MS = '1500';
});
after(() => {
    if (priorPoll === undefined) delete process.env.APRA_FLEET_DECISION_POLL_MS;
    else process.env.APRA_FLEET_DECISION_POLL_MS = priorPoll;
});

const resetSyncMemo = () => {
    invalidateSyncRemoteCache();
    clearLastSyncedTip();
    clearTipProbeFailures();
};
const assignedIds = (opts) => {
    const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};
const doerDispatches = (scenario) => scenario.dispatched.filter((d) => d.agent === 'doer');
const approve = async () => ({
    content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }],
});

const DECIDE = 'Task: decide the cookie handling';
const OTHER = 'Task: unrelated work';

// One scenario shape: the doer asks for a decision on DECIDE in its first
// dispatch and closes it in a later one (recording what its notes said);
// OTHER closes at once. `answer(workflow, ctx, data)` runs when the run
// pauses awaiting the decision.
async function decisionScenario(tag, answer, { onCommand } = {}) {
    const seen = { pauses: [], states: [], resumed: 0, notesAtRedispatch: null, decisionBeadId: null, comments: null };
    const scenario = await runDevelopLoopScenario(tag, {
        members: ['local'],
        ...(onCommand ? { onCommand } : {}),
        taskSpecs: [DECIDE, OTHER].map((title) => ({ title })),
        maxCycles: 2,
        beforeSprint: async ({ runCmd: rc, tempDir: td, tasks }) => {
            const id = (title) => tasks.find((x) => x.title === title).id;
            await rc(`bd update ${id(DECIDE)} --set-metadata streak=lane-d --set-metadata streakOrder=1`, td);
            await rc(`bd update ${id(OTHER)} --set-metadata streak=lane-o --set-metadata streakOrder=1`, td);
        },
        onWorkflow: async (workflow, ctx) => {
            workflow.on('state', (e) => { if (e.namespace === 'decisions') seen.states.push(e.data); });
            workflow.on('resumed', () => { seen.resumed += 1; });
            workflow.on('pause:requested', (e) => {
                seen.pauses.push(e);
                if (e.source !== 'needs_decision' || seen.pauses.length > 1) return;
                const data = seen.states.filter((d) => d.state === PAUSED_AWAITING_DECISION).pop();
                seen.decisionBeadId = data.pending[0].decisionBeadId;
                answer(workflow, ctx, data).catch((err) => { seen.answerError = err; });
            });
        },
        doerHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
            const ids = assignedIds(opts);
            const list = JSON.parse((await rc('bd list --json', td)).stdout || '[]');
            const decide = list.find((b) => b.title === DECIDE);
            if (decide && ids.includes(decide.id)) {
                const shown = JSON.parse((await rc(`bd show ${decide.id} --json`, td)).stdout || '[]');
                const notes = (Array.isArray(shown) ? shown[0] : shown).notes || '';
                if (!notes.includes('OPERATOR DECISION')) {
                    return { content: [{ text: JSON.stringify({
                        status: 'NEEDS-DECISION', closedIds: [], notes: 'An operator must choose.', decision: decisionFor(decide.id),
                    }) }] };
                }
                seen.notesAtRedispatch = notes;
                if (seen.decisionBeadId) {
                    seen.comments = JSON.parse((await rc(`bd comments ${seen.decisionBeadId} --json`, td)).stdout || '[]');
                }
            }
            for (const x of ids) await rc(`bd close ${x}`, td);
            return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'Done.' }) }] };
        },
        reviewerHandler: approve,
    });
    return { scenario, seen };
}

test('mock sprint: the only remaining bead awaits a decision -- the run pauses (no StalledSprintError), bd human respond plus an operator Resume resumes it and the bead is dispatched with the answer in its notes', async () => {
    resetSyncMemo();
    await withScenarioMarkers('decision wait answered by bd human respond', async () => {
        const ANSWER = 'a: keep the attributes and upgrade the emulator';
        const { scenario, seen } = await decisionScenario('dwait-respond', async (_workflow, { runCmd: rc, tempDir: td }, data) => {
            await rc(`bd human respond ${data.pending[0].decisionBeadId} -r "${ANSWER}"`, td);
            // Answered outside the run; the operator resumes it at once (the
            // dashboard Resume button) rather than waiting for the periodic
            // decision bead read, which still works.
            await _workflow.requestResume('operator Resume after bd human respond');
        });
        const x = scenario.tasks.find((t) => t.title === DECIDE).id;
        check(!seen.answerError, `answering failed: ${seen.answerError && seen.answerError.message}`);

        // (1) paused-awaiting-decision, never StalledSprintError.
        check(seen.states.some((d) => d.state === PAUSED_AWAITING_DECISION && d.pending[0].beadId === x), 'reached paused-awaiting-decision');
        assert.equal(seen.pauses.filter((p) => p.source === 'needs_decision').length, 1, 'parked once, answered on the first resume');
        check(!scenario.error || scenario.error.code !== 'SPRINT_STALLED', `never stalled: ${scenario.error && scenario.error.message}`);
        assert.equal(scenario.error, null, `the run completes: ${scenario.error && scenario.error.message}`);

        // (2) resumed without a relaunch; the bead dispatched again with the
        // answer in its notes, and closed.
        check(seen.resumed >= 1, 'the run resumed');
        const onX = doerDispatches(scenario).filter((d) => assignedIds(d).includes(x));
        assert.equal(onX.length, 2, 'dispatched once before the decision and once after the answer');
        check(seen.notesAtRedispatch && seen.notesAtRedispatch.includes(ANSWER), `the answer is in the notes at re-dispatch: ${seen.notesAtRedispatch}`);
        check(seen.notesAtRedispatch.includes(QUESTION), 'the original request is still there (appended, not replaced)');
        assert.equal(scenario.finalBeadsById.get(x).status, 'closed');
        check(seen.states.some((d) => d.state === 'running' && d.pending.length === 0), 'the decisions state returns to running');

        const decisionBead = scenario.finalBeadsById.get(seen.decisionBeadId);
        assert.equal(decisionBead.status, 'closed');
        assert.equal(decisionBead.close_reason, 'Responded');
        assert.equal(answerFromComments(seen.comments), ANSWER);
    });
});

test('mock sprint: recordDecisionAnswer produces the same bead state as bd human respond and resumes the run', async () => {
    resetSyncMemo();
    await withScenarioMarkers('decision wait answered by recordDecisionAnswer', async () => {
        const ANSWER = 'b: drop the attributes locally only';
        const { scenario, seen } = await decisionScenario('dwait-record', async (_workflow, _ctx, data) => {
            // The pause engages on the next gate arrival; answer from a fresh
            // tick so the wait is registered.
            await new Promise((r) => setImmediate(r));
            const live = activeDecisionWaits().find((w) => w.pending().some((d) => d.decisionId === data.pending[0].decisionId));
            await live.recordDecisionAnswer(data.pending[0].decisionId, ANSWER);
        });
        const x = scenario.tasks.find((t) => t.title === DECIDE).id;
        check(!seen.answerError, `answering failed: ${seen.answerError && seen.answerError.message}`);
        assert.equal(scenario.error, null, `the run completes: ${scenario.error && scenario.error.message}`);
        const decisionBead = scenario.finalBeadsById.get(seen.decisionBeadId);
        // Same state as the bd human respond scenario above.
        assert.equal(decisionBead.status, 'closed');
        assert.equal(decisionBead.close_reason, 'Responded');
        assert.equal(answerFromComments(seen.comments), ANSWER);
        check(seen.comments.some((c) => c.text === `Response: ${ANSWER}`), 'the same "Response: ..." comment bd human respond writes');
        check(seen.notesAtRedispatch.includes(ANSWER), 'the answer is in the work bead notes at re-dispatch');
        assert.equal(doerDispatches(scenario).filter((d) => assignedIds(d).includes(x)).length, 2);
        assert.equal(scenario.finalBeadsById.get(x).status, 'closed');
    });
});

test('mock sprint: a stop request during the decision pause ends the run cleanly', async () => {
    resetSyncMemo();
    await withScenarioMarkers('decision wait stopped', async () => {
        const { scenario, seen } = await decisionScenario('dwait-stop', async (workflow) => {
            workflow.requestStop('operator stop during the decision pause');
        });
        const x = scenario.tasks.find((t) => t.title === DECIDE).id;
        check(seen.states.some((d) => d.state === PAUSED_AWAITING_DECISION), 'it was paused awaiting the decision');
        check(scenario.error instanceof CancelledError || (scenario.error && scenario.error.name === 'CancelledError'),
            `ends with the cooperative cancellation: ${scenario.error && scenario.error.name}`);
        check(scenario.error.code !== 'SPRINT_STALLED', 'not a stall');
        assert.equal(doerDispatches(scenario).filter((d) => assignedIds(d).includes(x)).length, 1, 'no dispatch after the stop');
        assert.notEqual(scenario.finalBeadsById.get(x).status, 'closed', 'the bead stays open for a later run');
        assert.equal(scenario.finalBeadsById.get(seen.decisionBeadId).status, 'deferred', 'the decision stays pending for the operator');
        assert.equal(activeDecisionWaits().length, 0, 'the wait is gone');
    });
});

test('mock sprint: when the decision bead cannot be filed, the stall still throws StalledSprintError naming the decision with its full question (no endless pause)', { timeout: 180_000 }, async () => {
    resetSyncMemo();
    await withScenarioMarkers('decision bead create fails -> stall', async () => {
        const { scenario, seen } = await decisionScenario('dwait-unfiled', async (workflow) => {
            // Reaching this is the regression: stop so the test fails fast
            // instead of hanging on a wait nothing can answer.
            workflow.requestStop('test: paused on an unfiled decision');
        }, {
            onCommand: async ({ command }) => {
                if (command.includes('bd create') && command.includes('-t decision')) throw new Error('simulated bd create failure');
                return undefined;
            },
        });
        const x = scenario.tasks.find((t) => t.title === DECIDE).id;
        assert.equal(seen.pauses.filter((p) => p.source === 'needs_decision').length, 0, 'never paused awaiting the unfiled decision');
        check(!seen.states.some((d) => d.state === PAUSED_AWAITING_DECISION), 'never reached paused-awaiting-decision');
        check(scenario.error && scenario.error.code === 'SPRINT_STALLED', `throws StalledSprintError: ${scenario.error && (scenario.error.code || scenario.error.message)}`);
        check(scenario.error.message.includes(x), 'the stall names the work bead');
        check(scenario.error.message.includes(QUESTION), 'the stall carries the full question');
        check(scenario.error.message.includes('could NOT be filed'), `the stall says the decision bead could not be filed: ${scenario.error.message}`);
        assert.equal(doerDispatches(scenario).filter((d) => assignedIds(d).includes(x)).length, 1, 'not re-dispatched');
    });
});
