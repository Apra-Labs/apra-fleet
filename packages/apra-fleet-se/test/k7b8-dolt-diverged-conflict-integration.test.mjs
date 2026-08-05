import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';
import { WorkflowEngine } from '@apralabs/apra-fleet-workflow/engine';
import { getTerminalRunStatePath } from '@apralabs/apra-fleet-workflow/viewer/run-state-paths';

import { setupMinimal, buildMockFleetApi, mockCmdResult, teardown, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import { createWatchdog, WATCHDOG_STATUS } from '../src/supervisor/watchdog.mjs';
import { createHistory, HISTORY_FILENAME, HISTORY_EVENTS } from '../src/supervisor/history.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, '../fleet-sprint/runner.js');

// =============================================================================
// apra-fleet-k7b.8 -- end-to-end integration coverage for apra-fleet-k7b.4:
// proves a REAL sprint (real FleetWorkflow + WorkflowEngine driving runner.js
// end to end, not a hand-invoked unit call into resolveTerminalReason()/
// captureDoltConflictDump() -- k7b4-beads-sync-conflict-terminal-reason.test.mjs
// already pins those pure helpers in isolation) whose D-push bracket dies on a
// genuinely unmergeable Dolt conflict:
//
//   1. surfaces terminalReason='BEADS_SYNC_CONFLICT' -- not the generic
//      wrapper code (POST_DISPATCH_SYNC_FAILED) or CRASHED -- in the
//      persisted 'terminal' run-state (what bin/serve.mjs's dashboard reads),
//      AND (phase 2 below) once that state is discovered by the REAL
//      supervisor watchdog, in its snapshot and in the durable
//      sprint-history.json audit trail;
//   2. carries a non-empty captured conflict dump (member/operation/
//      doltOutput, apra-fleet-k7b.4's captureDoltConflictDump()) alongside
//      the terminal record, captured BEFORE any later bd invocation could
//      discard the raw rejection text that proved the divergence.
//
// Scenario shape: `bd dolt push` is scripted to ALWAYS fail with real Dolt
// "rejected"/"non-fast-forward" wording (the exact live apra-fleet-bnb
// POST_DISPATCH_SYNC_FAILED incident shape) while `bd dolt pull` (the
// mechanical reconcile step doltPushAfter always attempts once before giving
// up) succeeds -- so the FIRST dispatch's post-dispatch D-push bracket
// (withGitSync's teardown, apra-fleet-6z8.3) exhausts its bounded
// push -> reconcile-pull -> re-push -> retry ladder and throws a
// PostDispatchSyncError WRAPPING the DoltDivergedError one level down in
// `.cause` -- precisely the shape findDoltDivergedCause()/resolveTerminalReason()
// exist to unwrap, and precisely what a bare pre-dispatch-D-pull scenario
// (already covered by mock-sprint-beads-health-gate-diverged.test.mjs, an
// UNWRAPPED DoltDivergedError) does not exercise.
//
// Phase 2 (dashboard-snapshot / sprint-history.json surfacing) reuses the
// REAL watchdog/history modules exactly as k7b6-watchdog-finished-
// integration.test.mjs does -- driving them against a terminal-state file
// seeded with the EXACT terminalReason/conflictDump values phase 1 captured
// (real production data, not a hand-typed fixture), proving the propagation
// chain a real supervisor process runs end to end, without paying for a full
// spawned supervisor + child-process sprint launch (already covered at that
// weight by apra-fleet-f34.3's suite).
// =============================================================================

const DIVERGED_PUSH_STDERR =
    'To file:///fake-remote-k7b8\n' +
    ' ! [rejected]        main -> main (non-fast-forward)\n' +
    'error: failed to push some refs; updates were rejected because the tip of your current branch is behind its remote counterpart';

/**
 * Wraps buildMockFleetApi()'s executeCommand so:
 *  - `bd config get sync.remote --json` always reports a CONFIGURED remote
 *    (isMemberSyncRemoteConfigured's pre-gate must not short-circuit the push
 *    as a benign no-remote skip -- this hermetic tempDir has no real dolt
 *    remote at all);
 *  - `bd dolt pull` always succeeds (the mechanical reconcile step
 *    doltPushAfter attempts once after a rejected push, and every ordinary
 *    pre-dispatch D-pull);
 *  - `bd dolt push` ALWAYS fails with real "[rejected]"/"non-fast-forward"
 *    Dolt wording -- doltPushAfter's own DOLT_DIVERGED_PATTERNS classifier
 *    (runner.js) matches this text and throws DoltDivergedError, never
 *    retrying it as a plain transient failure.
 * Every other command (bd list/show/create/close, git, gh, node probes)
 * delegates to the base mock unchanged.
 */
function buildDivergedPushFleetApi(tempDir, epicBead, dispatched, commandLog, options = {}) {
    const baseApi = buildMockFleetApi(tempDir, epicBead, dispatched, commandLog, options);
    let pushAttempts = 0;
    let pullAttempts = 0;

    const executeCommand = async (opts) => {
        const cmd = opts.command;

        if (cmd === 'bd config get sync.remote --json') {
            commandLog.push(cmd);
            return mockCmdResult(0, JSON.stringify({ value: 'file:///fake-remote-k7b8' }), '');
        }
        if (cmd === 'bd dolt pull') {
            commandLog.push(cmd);
            pullAttempts += 1;
            return mockCmdResult(0, 'already up to date', '');
        }
        if (cmd === 'bd dolt push') {
            commandLog.push(cmd);
            pushAttempts += 1;
            return mockCmdResult(1, '', DIVERGED_PUSH_STDERR);
        }

        return baseApi.executeCommand(opts);
    };

    return {
        executeCommand,
        executePrompt: baseApi.executePrompt,
        _pushAttempts: () => pushAttempts,
        _pullAttempts: () => pullAttempts,
    };
}

/**
 * Phase 1: drives a REAL engine.executeFile(runner.js) run whose D-push
 * bracket dies on a wrapped DoltDivergedError (see buildDivergedPushFleetApi
 * above), and returns the exact 'terminal' run-state payload runner.js's
 * main() typed-abort catch persisted -- the real production data phase 2
 * feeds into the watchdog/history surfacing chain.
 * @returns {Promise<object>} the captured terminal state's `data` payload
 */
async function runDivergedPushScenarioAndCaptureTerminal() {
    const { tempDir, epicBead } = await setupMinimal('k7b8divergedpush', [
        { title: 'Task: k7b8 diverged-push scenario work' },
    ]);
    const dispatched = [];
    const commandLog = [];
    const logs = [];
    const states = [];

    // apra-fleet-eft.60.3's zero-wait knob (see runDevelopLoopScenario's own
    // use of this env var): the post-dispatch sync retry ladder
    // (POST_DISPATCH_SYNC_RETRY_DELAYS_MS = [0, 5000, 15000]) must genuinely
    // run all 3 attempts to exhaust itself and wrap PostDispatchSyncError --
    // this just skips the real sleeps between them so the scenario stays
    // fast; production timing is untouched.
    const priorInstantRetryBackoff = process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF;
    process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF = '1';

    try {
        const mockFleetApi = buildDivergedPushFleetApi(tempDir, epicBead, dispatched, commandLog, {
            planReviewerMode: 'approve-immediately',
            addExtraTaskDuringPlan: false,
        });
        const workflow = new FleetWorkflow(mockFleetApi, { targetRepo: tempDir });
        workflow.on('log', (e) => logs.push(e.msg));
        workflow.on('state', (e) => states.push(e));
        const engine = new WorkflowEngine(workflow);

        let error = null;
        let result = null;
        try {
            result = await engine.executeFile(scriptPath, {
                target_issue: epicBead.id,
                members: ['local'],
                branch: 'auto-sprint/mock-k7b8divergedpush',
                base_branch: 'main',
                goal: 'P1/P2',
                max_cycles: 1,
            }, true);
        } catch (err) {
            error = err;
        }

        // ---- 1. The sprint aborts on the wrapped divergence ----
        assert.ok(error, `expected the diverged D-push to abort the sprint, got a result instead: ${JSON.stringify(result)}`);
        assert.equal(error.code, 'POST_DISPATCH_SYNC_FAILED', `expected a PostDispatchSyncError, got ${error.constructor && error.constructor.name}: ${error.message}`);
        assert.ok(error.cause, 'expected the PostDispatchSyncError to carry a .cause');
        assert.equal(error.cause.code, 'DOLT_DIVERGED', `expected the wrapped cause to be a DoltDivergedError, got: ${error.cause && error.cause.code}`);

        // The scenario's injected push genuinely fired (proving this is real
        // engagement, not a vacuous short-circuit) and the mechanical
        // one-shot reconcile pull ran too.
        assert.ok(mockFleetApi._pushAttempts() >= 2, `expected at least 2 'bd dolt push' attempts (initial + re-push after reconcile) across the retry ladder, got ${mockFleetApi._pushAttempts()}`);
        assert.ok(mockFleetApi._pullAttempts() >= 1, `expected at least 1 'bd dolt pull' reconcile attempt, got ${mockFleetApi._pullAttempts()}`);

        // ---- 2. Persisted 'terminal' run-state: BEADS_SYNC_CONFLICT, not the generic wrapper code or CRASHED ----
        const terminalStates = states.filter((s) => s.namespace === 'terminal');
        assert.ok(terminalStates.length > 0, `expected at least one persisted 'terminal' run-state record, got states: ${JSON.stringify(states)}`);
        const terminal = terminalStates[terminalStates.length - 1].data;
        assert.equal(terminal.terminalReason, 'BEADS_SYNC_CONFLICT', `expected terminalReason='BEADS_SYNC_CONFLICT', got: ${JSON.stringify(terminal)}`);
        assert.notEqual(terminal.terminalReason, 'CRASHED');
        assert.notEqual(terminal.terminalReason, 'POST_DISPATCH_SYNC_FAILED', 'the wrapped generic code must not leak through once a DOLT_DIVERGED cause is present');

        // ---- 3. Non-empty captured conflict dump artifact, carried alongside the terminal record ----
        assert.ok(terminal.conflictDump, `expected a non-null conflictDump on the terminal record, got: ${JSON.stringify(terminal)}`);
        assert.equal(terminal.conflictDump.operation, 'push');
        assert.equal(terminal.conflictDump.member, 'local');
        assert.ok(
            typeof terminal.conflictDump.doltOutput === 'string' && terminal.conflictDump.doltOutput.length > 0,
            `expected a non-empty captured doltOutput dump, got: ${JSON.stringify(terminal.conflictDump)}`,
        );
        assert.match(
            terminal.conflictDump.doltOutput, /rejected|non-fast-forward/i,
            `expected the captured dump to carry the real rejection text, got: ${terminal.conflictDump.doltOutput}`,
        );

        return terminal;
    } finally {
        if (priorInstantRetryBackoff === undefined) {
            delete process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF;
        } else {
            process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF = priorInstantRetryBackoff;
        }
        await teardown(tempDir);
    }
}

describe('apra-fleet-k7b.8: a real sprint whose D-push bracket hits DOLT_DIVERGED surfaces BEADS_SYNC_CONFLICT with a captured conflict dump', () => {
    test('a real sprint run -- PostDispatchSyncError wrapping DoltDivergedError persists terminalReason=BEADS_SYNC_CONFLICT with a non-empty conflictDump, and the REAL supervisor watchdog/history then surface that same reason (with the dump linked) distinctly from CRASHED, in getSnapshot() and sprint-history.json', async () => {
        const terminal = await withScenarioMarkers('k7b8-diverged-push', () => runDivergedPushScenarioAndCaptureTerminal());

        const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'k7b8-watchdog-'));
        const seDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'k7b8-watchdog-se-'));
        try {
            const env = { ...process.env, APRA_FLEET_DATA_DIR: dataDir };
            const runId = `k7b8-run-${process.pid}-${Date.now()}`;

            // The engine's own terminal-state write (old_runs/<runId>.json) --
            // seeded with the EXACT terminalReason/conflictDump phase 1's real
            // runner.js main() typed-abort catch produced, not a hand-typed
            // fixture -- exactly what WorkflowEngine.executeFile() leaves
            // behind on disk for a real supervisor-spawned run.
            const statePath = getTerminalRunStatePath(runId, env);
            fs.mkdirSync(path.dirname(statePath), { recursive: true });
            fs.writeFileSync(statePath, JSON.stringify({
                terminalReason: terminal.terminalReason,
                extensions: { terminal },
            }));

            // A REAL dead OS pid (spawn a trivial child, let it exit+get
            // reaped, then reuse its now-free pid) -- same idiom
            // k7b6-watchdog-finished-integration.test.mjs uses.
            const { spawnSync } = await import('node:child_process');
            const deadChild = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
            const deadPid = deadChild.pid;
            assert.ok(Number.isInteger(deadPid) && deadPid > 0, 'expected spawnSync to report a pid');

            const history = createHistory({ filePath: path.join(seDataDir, HISTORY_FILENAME) });
            await history.start();
            const recordPromises = [];
            const trackingHistory = { record: (entry) => { const p = history.record(entry); recordPromises.push(p); return p; } };
            const ledger = { list: () => [{ sprintId: runId, childPid: deadPid, branch: null }] };
            const watchdog = createWatchdog({ ledger, env, history: trackingHistory, logger: { log: () => {}, error: () => {}, warn: () => {} } });

            const [classification] = await watchdog.classifyAll();
            await Promise.all(recordPromises);

            // 1) classifySprint()'s own return value: FINISHED, not CRASHED,
            // with the BEADS_SYNC_CONFLICT reason and conflictDump both
            // copied verbatim.
            assert.equal(classification.status, WATCHDOG_STATUS.FINISHED, 'a PID-gone sprint with a real persisted BEADS_SYNC_CONFLICT terminal state must classify FINISHED, not CRASHED');
            assert.equal(classification.terminalState.terminalReason, 'BEADS_SYNC_CONFLICT');
            assert.ok(classification.terminalState.extensions.terminal.conflictDump, 'expected the classification to carry the conflict dump linked from the terminal record');
            assert.equal(classification.terminalState.extensions.terminal.conflictDump.doltOutput, terminal.conflictDump.doltOutput);

            // 2) watchdog.getSnapshot() -- the dashboard snapshot bin/serve.mjs's
            // dashboard/API layers actually read.
            const snapshot = watchdog.getSnapshot();
            assert.equal(snapshot.length, 1);
            assert.equal(snapshot[0].sprintId, runId);
            assert.equal(snapshot[0].status, WATCHDOG_STATUS.FINISHED);
            assert.equal(snapshot[0].terminalState.terminalReason, 'BEADS_SYNC_CONFLICT');
            assert.notEqual(snapshot[0].status, WATCHDOG_STATUS.CRASHED);

            // 3) sprint-history.json -- the durable audit trail (real file,
            // real atomic write, read back from disk here, not memory).
            const persisted = JSON.parse(await fsp.readFile(path.join(seDataDir, HISTORY_FILENAME), 'utf-8'));
            const finishedEvents = persisted.events.filter((e) => e.sprintId === runId && e.event === HISTORY_EVENTS.FINISHED);
            assert.equal(finishedEvents.length, 1, `expected exactly one FINISHED sprint-history.json event, got: ${JSON.stringify(persisted.events)}`);
            assert.equal(finishedEvents[0].terminalReason, 'BEADS_SYNC_CONFLICT');
            assert.notEqual(finishedEvents[0].terminalReason, 'CRASHED');
            // No CRASHED-classified event was ever recorded for this run-id.
            assert.equal(persisted.events.filter((e) => e.sprintId === runId && /crash/i.test(e.event)).length, 0);
        } finally {
            await fsp.rm(dataDir, { recursive: true, force: true });
            await fsp.rm(seDataDir, { recursive: true, force: true });
        }
    });
});
