// The supervisor's decision answer route returns once the answer is RECORDED,
// even when the run's resume/apply is slower than the supervisor's proxy
// timeout. Real viewer + real supervisor controller + real createDecisionWait
// over loopback HTTP; only the engine seams (pause/resume, member commands)
// are fakes, deliberately slower than the (lowered) proxy timeout.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createDashboardViewer } from '@apralabs/apra-fleet-workflow/viewer';
import { createDecisionsExtension } from '../fleet-sprint/viewer-extensions.mjs';
import { createDecisionWait } from '../fleet-sprint/decision-wait.mjs';
import { createSprintController, proxyChildAction, ApiError } from '../src/supervisor/api.mjs';
import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME } from '../src/supervisor/history.mjs';
import { createSpawner } from '../src/supervisor/spawner.mjs';

const PROXY_TIMEOUT_MS = 300;
const SLOW_MS = 1200; // well past the proxy timeout
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decisionState(id) {
    const decision = {
        decisionId: id, beadId: 'x-1', decisionBeadId: 'x-dec', question: 'Keep it?',
        options: [{ id: 'a', text: 'Keep' }, { id: 'b', text: 'Drop' }], recommendation: 'a',
        raisedBy: 'doer', cycle: 1, round: 1, notification: {},
    };
    return {
        pendingDecisions: new Map([[id, decision]]),
        doctorBlockedIds: new Map([['x-1', { kind: 'needs-decision', blockedBy: 'x-1', reason: 'awaiting', decisionId: id, cycle: 1, round: 1 }]]),
    };
}

describe('answer route with a slow resume/apply', () => {
    let tmpDir; let server; let controller; let wf;

    before(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-se-slow-answer-'));
        wf = new EventEmitter();
        // The default answer sink: the in-process run that owns the decision.
        server = createDashboardViewer(wf, {
            port: 0, runId: 'slow-answer', name: 'Slow', dashboardExtensions: [createDecisionsExtension()],
            debouncedStatePath: path.join(tmpDir, 'running.json'), debounceMs: 200, stateSnapshotDir: path.join(tmpDir, 'snaps'),
        });
        if (!server.listening) await new Promise((r, j) => { server.once('listening', r); server.once('error', j); });
        const port = server.address().port;
        const ledger = createLedger({ filePath: path.join(tmpDir, LEDGER_FILENAME), now: () => '2026-07-18T00:00:00.000Z' });
        await ledger.start();
        const history = createHistory({ filePath: path.join(tmpDir, HISTORY_FILENAME), now: () => '2026-07-18T00:00:00.000Z' });
        await history.start();
        await ledger.claim('s1', { members: ['a'], issueRoots: ['R'], childPid: 42 });
        controller = createSprintController({
            ledger, history,
            spawner: createSpawner({ basePort: 9100, isPortAvailable: async () => true, dataDir: 'x', fs: { mkdirSync() {}, openSync() { return 1; }, closeSync() {} }, spawn: () => ({ pid: 1, on() {}, unref() {} }) }),
            listMembers: () => ({}), getBacklog: () => ({}),
            resolvePort: (pid) => (pid === 42 ? port : undefined),
            proxyAction: (p, ext, act, payload) => proxyChildAction(p, ext, act, payload, { timeoutMs: PROXY_TIMEOUT_MS }),
        });
    });

    after(async () => {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const waitFor = async (cond, what) => {
        const deadline = Date.now() + 8000;
        while (!cond()) {
            if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
            await sleep(10);
        }
    };

    test('run PAUSED, resume and member commands slower than the proxy timeout: route returns 200 recorded; the answer is applied exactly once afterwards', async () => {
        const id = 'decision-slow-paused';
        const sprintState = decisionState(id);
        const commands = [];
        let release = null;
        const gate = new Promise((r) => { release = r; });
        const wait = createDecisionWait({
            sprintState,
            requestPause: () => {},
            // A slow resume: the pause gate only opens SLOW_MS after the request.
            requestResume: async () => { await sleep(SLOW_MS); release(); },
            command: async (cmd) => {
                if (cmd.startsWith('bd show')) { await gate; return JSON.stringify([{ id: 'x-dec', status: 'open' }]); }
                await sleep(SLOW_MS / 4); // slow member commands too
                commands.push(cmd);
                return cmd.startsWith('node -e') ? '/tmp/staged.txt' : '';
            },
            member: 'm', pollIntervalMs: 20,
            publishState: (namespace, data) => wf.emit('state', { namespace, data }),
        });
        const run = wait.awaitAnswer({ where: 'test', cycle: 1 });
        await waitFor(() => wait.pending().length > 0 && sprintState.decisionWait, 'the wait to start');
        await sleep(500); // let the debounced state reach the child viewer

        const started = Date.now();
        const out = await controller.answerDecision('s1', id, { answer: 'a: keep it' });
        const took = Date.now() - started;
        assert.equal(out.status, 'recorded');
        assert.ok(took < PROXY_TIMEOUT_MS, `route returned in ${took}ms, inside the ${PROXY_TIMEOUT_MS}ms proxy timeout`);
        assert.equal(commands.length, 0, 'nothing applied yet: resume is still in flight');

        const answered = await run;
        assert.equal(answered.length, 1);
        assert.equal(commands.filter((c) => c.startsWith('bd note x-1 --file')).length, 1, 'work-bead note written once');
        assert.equal(commands.filter((c) => c.startsWith('bd human respond x-dec')).length, 1, 'responded once');
        assert.deepEqual(answered[0].released, ['x-1'], 'set-aside released once');
        assert.equal(sprintState.doctorBlockedIds.size, 0);
    });

    test('run RUNNING, apply slower than the proxy timeout: route returns recorded; applyRecordedAnswers later applies exactly once', async () => {
        const id = 'decision-slow-running';
        const sprintState = decisionState(id);
        const commands = [];
        const pushes = [];
        const wait = createDecisionWait({
            sprintState, requestPause: () => {}, requestResume: async () => {},
            command: async (cmd) => {
                await sleep(SLOW_MS / 2);
                commands.push(cmd);
                return cmd.startsWith('node -e') ? '/tmp/staged.txt' : '';
            },
            member: 'm', pushBeads: async () => { pushes.push('push'); },
            publishState: (namespace, data) => wf.emit('state', { namespace, data }),
        });
        wait.publish();
        await sleep(500);

        const started = Date.now();
        const out = await controller.answerDecision('s1', id, { answer: 'b: drop it' });
        assert.equal(out.status, 'recorded');
        assert.ok(Date.now() - started < PROXY_TIMEOUT_MS, 'route returned inside the proxy timeout');
        assert.equal(commands.length, 0);

        const applied = await wait.applyRecordedAnswers();
        assert.equal(applied.length, 1);
        assert.deepEqual(await wait.applyRecordedAnswers(), [], 'a second drain applies nothing');
        assert.equal(commands.filter((c) => c.startsWith('bd note x-1 --file')).length, 1);
        assert.equal(commands.filter((c) => c.startsWith('bd human respond x-dec')).length, 1);
        assert.deepEqual(pushes, ['push']);
        assert.equal(sprintState.doctorBlockedIds.size, 0, 'set-aside released');
    });

    test('an unknown decision id still returns 404 and an empty answer 400, synchronously', async () => {
        await assert.rejects(() => controller.answerDecision('s1', 'decision-nope', { answer: 'a' }), (e) => e instanceof ApiError && e.status === 404);
        await assert.rejects(() => controller.answerDecision('s1', 'decision-slow-paused', { answer: '  ' }), (e) => e instanceof ApiError && e.status === 400);
    });
});
