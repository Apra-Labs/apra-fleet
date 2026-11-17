// A sprint paused awaiting a decision resumes on its own after an operator
// answers with `bd human respond` in a SEPARATE process -- real bd end to end.
//
// Real pieces: a hermetic beads sandbox (createBeadsFixture: real `bd init`
// template plus import), the REAL engine (FleetWorkflow: pause gate,
// requestPause/requestResume, requestStop), the REAL cli.mjs reservation
// wiring (wirePauseReservations, with counting release/re-reserve seams), the
// REAL decision filing (recordPendingDecision -> a `decision` bead labelled
// `human`) and the REAL createDecisionWait. The fleet API's executeCommand()
// runs every member command for real in the sandbox (the backlog member's
// beads folder), with the member's temp dir pointed inside the sandbox.
//
// The answer is recorded out of process: a child `bd human respond` run while
// the run is parked -- never recordDecisionAnswer, never an operator Resume.
// The decision bead read cadence is shortened through
// APRA_FLEET_DECISION_READ_POLL_MS so the test runs in seconds.
//
// Falsifiability: without the pause-exempt periodic decision bead read in
// fleet-sprint/decision-wait.mjs (holdUntilReleased) nothing reads the bead
// while the run is paused, so the run stays parked and this test fails at its
// "still paused-awaiting-decision" timeout (checked locally once by reverting
// the fix).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';
import { wirePauseReservations } from '../bin/cli.mjs';
import { createDecisionWait, answerFromComments, PAUSED_AWAITING_DECISION } from '../fleet-sprint/decision-wait.mjs';
import { recordPendingDecision } from '../fleet-sprint/decisions.mjs';
import { createBeadsFixture } from './helpers/beads-fixture.mjs';
import { bdChildEnv } from './helpers/bd-replay.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';
import { TEST_CONCURRENCY } from './helpers/test-concurrency.mjs';

const READ_POLL_MS = 400;
const MEMBER = 'backlog-member';
const ANSWER = 'b: drop the attributes for the local emulator only';
const QUESTION = 'Keep the session cookie attributes (a) or drop them for the local emulator (b)?';

/** Runs `cmd` for real in `cwd`; resolves { err, stdout, stderr } (never rejects). */
function run(cmd, cwd, env) {
    return new Promise((resolve) => {
        exec(cmd, { cwd, env, windowsHide: true }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
    });
}

/** Polls `cond` every 50ms until it is truthy or `ms` elapses; returns whether it held. */
async function waitFor(cond, ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (await cond()) return true;
        await new Promise((r) => setTimeout(r, 50));
    }
    return !!(await cond());
}

test('a paused sprint resumes and applies an answer recorded by a separate bd human respond process (real bd)', async () => {
    const budget = scaledTimeout(20_000, { concurrency: TEST_CONCURRENCY });
    const fx = await createBeadsFixture();
    const priorReadPoll = process.env.APRA_FLEET_DECISION_READ_POLL_MS;
    process.env.APRA_FLEET_DECISION_READ_POLL_MS = String(READ_POLL_MS);
    let wf = null;
    try {
        // The member's temp dir lives inside the sandbox, so staged bd bodies
        // can be checked for cleanup and never land outside it.
        const memberTmp = path.join(fx.dir, 'member-tmp');
        fs.mkdirSync(memberTmp);
        const memberEnv = { ...bdChildEnv(), TMPDIR: memberTmp, TEMP: memberTmp, TMP: memberTmp };
        const bd = async (args) => {
            const r = await run(`bd ${args}`, fx.dir, memberEnv);
            if (r.err) throw new Error(`bd ${args} failed: ${r.err.message}\n${r.stderr}`);
            return r.stdout;
        };
        const workId = (await bd('create "Decide the cookie handling" -t task -p 2 --silent')).trim().split(/\s+/).pop();
        assert.match(workId, /\S/, 'the work bead was created');

        // Every member command, for real, in the sandbox; recorded with
        // whether the run was paused when it was issued.
        const commands = [];
        const fleetApi = {
            async executePrompt() { throw new Error('no agent dispatch expected'); },
            async executeCommand(payload) {
                assert.equal(payload.member_name, MEMBER, 'every command goes to the backlog member');
                commands.push({ command: payload.command, paused: wf._paused });
                const r = await run(payload.command, fx.dir, memberEnv);
                return { content: [{ text: r.err ? `${r.stdout}${r.stderr}` : r.stdout }], isError: !!r.err };
            },
        };
        wf = new FleetWorkflow(fleetApi);
        const reservations = { releases: 0, reReserves: 0 };
        wirePauseReservations({
            workflow: wf,
            releaseForPause: async () => { reservations.releases += 1; },
            reReserve: async () => { reservations.reReserves += 1; return { reacquired: [] }; },
        });
        const events = { pauseRequested: 0, resumed: 0 };
        wf.on('pause:requested', () => { events.pauseRequested += 1; });
        wf.on('resumed', () => { events.resumed += 1; });
        const sync = { pulls: 0, pushes: 0 };
        const logs = [];
        const sprintState = {};
        let wait = null;
        let waitStart = -1;

        const runPromise = wf.runWithContext({}, async (ctx) => {
            const record = await recordPendingDecision({
                sprintState, raisedBy: 'doer', cycle: 1, command: ctx.command, member: MEMBER,
                decision: {
                    beadId: workId, question: QUESTION, recommendation: 'a',
                    options: [{ id: 'a', text: 'Keep the attributes' }, { id: 'b', text: 'Drop them locally' }],
                },
                log: (m) => logs.push(m),
            });
            assert.ok(record && record.decisionBeadId, `the decision bead was filed: ${JSON.stringify(logs)}`);
            wait = createDecisionWait({
                sprintState, requestPause: ctx.requestPause, requestResume: ctx.requestResume,
                command: ctx.command, stopSignal: ctx.stopSignal, member: MEMBER,
                pullBeads: async () => { sync.pulls += 1; }, pushBeads: async () => { sync.pushes += 1; },
                log: (m) => logs.push(m),
            });
            waitStart = commands.length;
            return wait.awaitAnswer({ where: 'test', cycle: 1 });
        });
        runPromise.catch(() => {});

        // Parked (the pause engaged).
        const parked = await waitFor(
            () => sprintState.decisionWait && sprintState.decisionWait.state === PAUSED_AWAITING_DECISION && wf._paused,
            budget,
        );
        assert.ok(parked, `the run reached ${PAUSED_AWAITING_DECISION}: ${JSON.stringify(logs)}`);
        const [decision] = [...sprintState.pendingDecisions.values()];
        const decisionBeadId = decision.decisionBeadId;
        assert.equal(events.resumed, 0, 'not resumed before the answer');

        // Out of process: an operator answers with bd human respond. A
        // concurrent read may briefly hold the database, so retry a few times.
        let responded = null;
        for (let i = 0; i < 5 && !(responded && !responded.err); i++) {
            responded = await run(`bd human respond ${decisionBeadId} -r "${ANSWER}"`, fx.dir, memberEnv);
            if (responded.err) await new Promise((r) => setTimeout(r, 200));
        }
        assert.ok(!responded.err, `bd human respond failed: ${responded.err && responded.err.message}\n${responded.stderr}`);
        assert.equal(wait.hasQueuedAnswers(), false, 'no in-process answer is queued');

        let raceTimer = null;
        const settled = await Promise.race([
            runPromise.then(() => true, () => true),
            new Promise((r) => { raceTimer = setTimeout(() => r(false), budget); }),
        ]);
        clearTimeout(raceTimer);
        if (!settled) {
            wf.requestStop('test timeout');
            await runPromise.catch(() => {});
            assert.fail(`still ${PAUSED_AWAITING_DECISION} ${budget}ms after an out-of-process bd human respond: nothing picked the answer up`);
        }
        const answered = await runPromise;

        // (1) resumed once, on its own, and applied the answer.
        assert.equal(answered.length, 1);
        assert.equal(answered[0].answer, ANSWER);
        assert.equal(answered[0].via, 'bd human respond');
        assert.equal(events.pauseRequested, 1, 'parked once');
        assert.equal(events.resumed, 1, 'resumed once, by the wait itself (the test issued no Resume)');

        // (2) the work bead notes carry the answer; the decision moved.
        const work = JSON.parse(await bd(`show ${workId} --json`));
        const notes = (Array.isArray(work) ? work[0] : work).notes || '';
        assert.ok(notes.includes(ANSWER), `the answer is in ${workId}'s notes: ${notes}`);
        assert.equal(sprintState.pendingDecisions.size, 0, 'no decision pending');
        assert.ok(sprintState.answeredDecisions.has(decision.decisionId), 'the decision is in answeredDecisions');
        assert.equal(answerFromComments(JSON.parse(await bd(`comments ${decisionBeadId} --json`))), ANSWER);

        // (3) while waiting: only the periodic decision bead reads -- no
        // release, re-reserve, resync, pull or extra pause/resume.
        const waiting = commands.slice(waitStart).filter((c) => c.paused).map((c) => c.command);
        assert.ok(waiting.length >= 1);
        assert.deepEqual(waiting, Array(waiting.length).fill(`bd show ${decisionBeadId} --json`), JSON.stringify(waiting));
        assert.deepEqual(reservations, { releases: 0, reReserves: 0 });
        assert.equal(sync.pulls, 0, 'no beads pull');
        assert.equal(sync.pushes, 1, 'one push, after applying the answer');
        const afterResume = commands.slice(waitStart).filter((c) => !c.paused).map((c) => c.command);
        assert.equal(afterResume[0], `bd show ${decisionBeadId} --json`, 'the gated read runs first on the resume');
        assert.equal(afterResume[1], `bd comments ${decisionBeadId} --json`, 'then the answer is read from the closed bead');
        assert.ok(!commands.some((c) => /^bd human respond/.test(c.command)), 'the run never responded itself');
        assert.ok(!commands.some((c) => /^bd (dolt|sync)\b/.test(c.command)), 'no beads sync command');

        // (5) staged bodies were removed: nothing left in the member temp dir.
        assert.deepEqual(fs.readdirSync(memberTmp), [], 'no staged body left behind');
    } finally {
        if (wf) wf.requestStop('test teardown');
        if (priorReadPoll === undefined) delete process.env.APRA_FLEET_DECISION_READ_POLL_MS;
        else process.env.APRA_FLEET_DECISION_READ_POLL_MS = priorReadPoll;
        await fx.cleanup();
    }
});
