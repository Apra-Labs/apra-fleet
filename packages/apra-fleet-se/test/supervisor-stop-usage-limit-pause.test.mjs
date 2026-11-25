// POST /stop (the supervisor's stopSprint) on a sprint paused on a usage limit
// ends the run within a bounded time. Real FleetWorkflow + real
// createDashboardViewer (the child side) running a script that enters the
// usage-limit wait with a ONE-HOUR resumeAt, and the real supervisor
// controller (createSprintController, real ledger/history, resolvePort
// pointing at the viewer) calling stopSprint.
//
// GUARDS: the controller's handling of a stop during the wait. Reverted, the
// wait sleeps the full hour, the run never reaches its terminal state and the bounded
// wait below fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentDispatchError, FleetWorkflow } from '@apralabs/apra-fleet-workflow';
import { createDashboardViewer } from '@apralabs/apra-fleet-workflow/viewer';
import { WorkflowEngine } from '@apralabs/apra-fleet-workflow/engine';
import { createUsageLimitPauseController } from '../fleet-sprint/usage-limit-controller.mjs';
import { dispatchRole } from '../fleet-sprint/dispatch-role.mjs';
import { createSprintController, proxyChildAction } from '../src/supervisor/api.mjs';
import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME } from '../src/supervisor/history.mjs';
import { createSpawner } from '../src/supervisor/spawner.mjs';
import { createRecordingCtx, ROLE_CALL_OPTS } from './helpers/dispatch-role-harness.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';
import { TEST_CONCURRENCY } from './helpers/test-concurrency.mjs';

const HOUR_MS = 60 * 60 * 1000;
const STOP_BOUND_MS = 10000;
const SETUP_MS = scaledTimeout(5000, { concurrency: TEST_CONCURRENCY });

function waitFor(cond, ms, what) {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const poll = setInterval(() => {
            if (cond()) { clearInterval(poll); resolve(Date.now() - started); return; }
            if (Date.now() - started > ms) { clearInterval(poll); reject(new Error(`not within ${ms}ms: ${what}`)); }
        }, 10);
    });
}

// Tracks long (>= 30 min) timers: the usage-limit wait is the only thing in this
// test that sets one, and none may be left uncleared once the run has ended.
function trackLongTimers() {
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const live = new Set();
    globalThis.setTimeout = (fn, ms, ...rest) => {
        if (typeof ms === 'number' && ms >= HOUR_MS / 2) {
            const t = realSet(() => { live.delete(t); fn(...rest); }, ms);
            live.add(t);
            return t;
        }
        return realSet(fn, ms, ...rest);
    };
    globalThis.clearTimeout = (t) => { live.delete(t); return realClear(t); };
    return { live, restore() { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; } };
}

test('stopSprint on a sprint paused on a usage limit (one-hour wait) ends the run (terminal status cancelled) within the bound', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-se-stop-usage-'));
    const statePath = path.join(tmpDir, 'running.json');
    let server;
    let longTimers = null;
    try {
        const wf = new FleetWorkflow({
            async executePrompt() { return { content: [{ text: 'ok' }] }; },
            async executeCommand(payload) { return { content: [{ text: payload.command }], isError: false }; },
        });
        wf.setPauseGuard(() => true);
        const pauseRequests = [];
        wf.on('pause:requested', (p) => pauseRequests.push(p));
        let endEvent = null;
        wf.on('end', (res) => { endEvent = res; });

        server = createDashboardViewer(wf, {
            port: 0, runId: 'stop-usage', name: 'StopUsage',
            debouncedStatePath: statePath, debounceMs: 200, stateSnapshotDir: path.join(tmpDir, 'snaps'),
        });
        if (!server.listening) await new Promise((r, j) => { server.once('listening', r); server.once('error', j); });
        const port = server.address().port;

        const ledger = createLedger({ filePath: path.join(tmpDir, LEDGER_FILENAME), now: () => '2026-07-18T00:00:00.000Z' });
        await ledger.start();
        const history = createHistory({ filePath: path.join(tmpDir, HISTORY_FILENAME), now: () => '2026-07-18T00:00:00.000Z' });
        await history.start();
        await ledger.claim('s1', { members: ['a'], issueRoots: ['R'], childPid: 42 });
        const controller = createSprintController({
            ledger, history,
            spawner: createSpawner({ basePort: 9100, isPortAvailable: async () => true, dataDir: 'x', fs: { mkdirSync() {}, openSync() { return 1; }, closeSync() {} }, spawn: () => ({ pid: 1, on() {}, unref() {} }) }),
            listMembers: () => ({}), getBacklog: () => ({}),
            resolvePort: (pid) => (pid === 42 ? port : undefined),
            hasTerminalState: () => null,
            proxyAction: (p, ext, act, payload) => proxyChildAction(p, ext, act, payload, {}),
        });

        longTimers = trackLongTimers();
        const probes = [];
        const limit = new AgentDispatchError('hit your usage limit', {
            details: { reason: 'usage_limit', usageLimit: { resumeAt: new Date(Date.now() + HOUR_MS).toISOString(), resumeAtSource: 'parsed' } },
        });
        // The real engine runs the script, so the terminal 'end' event (and the
        // status the viewer persists) is the engine's own: a cooperative stop is
        // 'cancelled' (the engine has no 'stopped' run status).
        const scriptPath = path.join(tmpDir, 'script.mjs');
        fs.writeFileSync(scriptPath, 'export default (context) => globalThis.__usageStopTestMain(context);\n');
        globalThis.__usageStopTestMain = async (context) => {
            const { ctx } = createRecordingCtx({ responses: [limit, { verdict: 'APPROVED', notes: 'n/a' }] });
            ctx.onUsageLimit = createUsageLimitPauseController({
                requestPause: context.requestPause,
                requestResume: context.requestResume,
                agent: async (prompt, opts) => { probes.push(opts.label); return 'ok'; },
                log: ctx.log,
            });
            return dispatchRole(ctx, 'reviewer', { ...ROLE_CALL_OPTS.reviewer });
        };
        const runSettled = new WorkflowEngine(wf).executeFile(scriptPath, {}).then(() => 'ok', (e) => e);

        await waitFor(() => wf._paused && pauseRequests.length === 1, SETUP_MS, 'the usage-limit pause');

        const stoppedAt = Date.now();
        const out = await controller.stopSprint('s1');
        assert.equal(out.status, 'stopping');
        await waitFor(() => endEvent !== null, STOP_BOUND_MS, 'the run to end after stopSprint');
        assert.ok(Date.now() - stoppedAt < STOP_BOUND_MS);
        assert.equal(endEvent.status, 'cancelled');
        await runSettled;
        assert.equal(probes.length, 0, 'no probe dispatch after a stop');
        assert.equal(pauseRequests.length, 1, 'no second pause');

        // The persisted terminal run state (written by the viewer on end).
        await waitFor(() => {
            try { return JSON.parse(fs.readFileSync(statePath, 'utf8')).status === 'cancelled'; } catch { return false; }
        }, SETUP_MS, 'the persisted run state to read cancelled');

        await new Promise((resolve) => server.close(resolve));
        server = null;
        assert.equal(longTimers.live.size, 0, 'no long usage-limit wait timer left pending');
    } finally {
        if (server) await new Promise((resolve) => server.close(resolve));
        if (longTimers) longTimers.restore();
        delete globalThis.__usageStopTestMain;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
