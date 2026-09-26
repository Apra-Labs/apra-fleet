import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { createWatchdog, WATCHDOG_STATUS } from '../src/supervisor/watchdog.mjs';
import { createHistory, HISTORY_FILENAME, HISTORY_EVENTS } from '../src/supervisor/history.mjs';
import { createReconciler } from '../src/supervisor/reconcile.mjs';
import { createReadopter } from '../src/supervisor/readopt.mjs';
import { getTerminalRunStatePath } from '@apralabs/apra-fleet-workflow/viewer/run-state-paths';

// =============================================================================
// apra-fleet-k7b.6 -- integration test for apra-fleet-k7b.2: proves, against
// REAL modules (real watchdog/history/reconciler/readopter instances, a REAL
// dead OS pid, and REAL terminal-state files on disk under a temp
// APRA_FLEET_DATA_DIR), that a PID-gone sprint whose engine wrote a terminal
// state is classified FINISHED -- not the pre-k7b.2 generic CRASHED -- and
// that the engine's own terminalReason/verdict is copied VERBATIM into three
// separate surfaces: the watchdog's own timestamped log line, the durable
// sprint-history.json event, and watchdog.getSnapshot() (the classification
// result bin/serve.mjs's dashboard/API layers read from). It also proves the
// legacy branch-keyed terminal-state fallback still resolves, and that the
// four supervisor modules k7b.2 touched (watchdog, reconcile, readopt --
// proxy is exhaustively covered by unit tests already, see
// k7b2-watchdog-finished-terminal-state.test.mjs's withTimestamps suite) emit
// ISO-8601-timestamp-prefixed log lines by default (no logger override --
// exactly how bin/serve.mjs wires them).
//
// This is deliberately NOT a re-test of defaultHasTerminalState()/
// formatFinishedDetail()/withTimestamps() in isolation (apra-fleet-k7b.2's
// own unit suite already does that with injected fakes) -- it drives the
// REAL classifySprint() -> defaultRecordFinished() -> history.record() ->
// disk-file chain end to end, the same chain a real supervisor process runs,
// so a regression in how those pieces are WIRED TOGETHER (not just each
// piece alone) is caught. Pre-k7b.2 code had no defaultHasTerminalState()/
// formatFinishedDetail()/defaultRecordFinished()/withTimestamps() exports at
// all (a PID-gone sprint was only ever reported as bare CRASHED), so this
// suite could not even import successfully against that code, let alone pass.
// =============================================================================

async function tmpDataDir(prefix) {
    return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** A REAL dead OS pid: spawn a trivial child and let it exit+get reaped, then
 * reuse its now-free pid number -- the same idiom test/sprint-lock.test.mjs
 * uses for "a pid that is certainly dead". */
function realDeadPid() {
    const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    assert.ok(Number.isInteger(child.pid) && child.pid > 0, 'expected spawnSync to report a pid');
    return child.pid;
}

/** Captures every log call made through a withTimestamps-wrapped logger, so
 * assertions can inspect the EXACT line (including the ISO prefix) the real
 * module would have written to the supervisor's process log. */
function capturingLogger() {
    const lines = [];
    return {
        lines,
        log: (...a) => lines.push(a.join(' ')),
        error: (...a) => lines.push(a.join(' ')),
        warn: (...a) => lines.push(a.join(' ')),
    };
}

const ISO_PREFIX_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;

describe('apra-fleet-k7b.6: watchdog classifies FINISHED with engine terminalReason and timestamped log lines', () => {
    test('PID gone + engine terminal state found BY RUN-ID => FINISHED, terminalReason/verdict copied verbatim into the watchdog log line, sprint-history.json, and getSnapshot()', async () => {
        const dataDir = await tmpDataDir('k7b6-runid-');
        const seDataDir = await tmpDataDir('k7b6-runid-se-');
        try {
            const env = { ...process.env, APRA_FLEET_DATA_DIR: dataDir };
            const runId = `k7b6-run-${process.pid}-${Date.now()}`;

            // The engine's own terminal-state write (old_runs/<runId>.json),
            // exactly as WorkflowEngine.executeFile() leaves behind on a real
            // terminal outcome -- e.g. SPRINT_STALLED with a reviewer verdict.
            const statePath = getTerminalRunStatePath(runId, env);
            fs.mkdirSync(path.dirname(statePath), { recursive: true });
            fs.writeFileSync(statePath, JSON.stringify({
                terminalReason: 'SPRINT_STALLED',
                extensions: { terminal: { verdict: 'needs-changes' } },
            }));

            const deadPid = realDeadPid();

            const history = createHistory({ filePath: path.join(seDataDir, HISTORY_FILENAME) });
            await history.start();
            // Track every record() promise so the test can deterministically
            // await the real (fire-and-forget from the watchdog's own
            // perspective) disk persist before asserting on it -- without this
            // the sprint-history.json read below would race the write.
            const recordPromises = [];
            const trackingHistory = { record: (entry) => { const p = history.record(entry); recordPromises.push(p); return p; } };

            const logger = capturingLogger();
            const ledger = { list: () => [{ sprintId: runId, childPid: deadPid, branch: null }] };

            // No isChildAlive/hasTerminalState overrides: this drives the REAL
            // default PID probe (makeChildPidProbe()/isPidAlive) and the REAL
            // defaultHasTerminalState() against `env` -- the exact same
            // collaborators bin/serve.mjs wires (env aside, which bin/serve.mjs
            // takes from process.env; a temp dir here is the only difference).
            const watchdog = createWatchdog({ ledger, env, history: trackingHistory, logger });

            const [classification] = await watchdog.classifyAll();
            await Promise.all(recordPromises);

            // 1) classifySprint()'s own return value.
            assert.equal(classification.status, WATCHDOG_STATUS.FINISHED, 'a PID-gone sprint with a real persisted terminal state must classify FINISHED, not CRASHED');
            assert.equal(classification.terminalState.terminalReason, 'SPRINT_STALLED');
            assert.equal(classification.terminalState.extensions.terminal.verdict, 'needs-changes');

            // 2) watchdog.getSnapshot() -- what bin/serve.mjs's dashboard/API
            // layers actually read to report a sprint's classification.
            const snapshot = watchdog.getSnapshot();
            assert.equal(snapshot.length, 1);
            assert.equal(snapshot[0].sprintId, runId);
            assert.equal(snapshot[0].status, WATCHDOG_STATUS.FINISHED);
            assert.equal(snapshot[0].terminalState.terminalReason, 'SPRINT_STALLED');
            assert.equal(snapshot[0].terminalState.extensions.terminal.verdict, 'needs-changes');

            // 3) the watchdog's own log line: ISO-8601-timestamp-prefixed (this
            // module's `logger` param defaults through withTimestamps(), and
            // this test never overrides that), copying terminalReason/verdict
            // VERBATIM -- never the pre-k7b.2 generic CRASHED wording.
            const finishedLines = logger.lines.filter((l) => l.includes('[watchdog] FINISHED'));
            assert.equal(finishedLines.length, 1, `expected exactly one FINISHED watchdog line, got: ${JSON.stringify(logger.lines)}`);
            assert.match(finishedLines[0], ISO_PREFIX_RE, 'the serve-log watchdog line must be prefixed with an ISO-8601 timestamp');
            assert.ok(finishedLines[0].includes(runId));
            assert.ok(finishedLines[0].includes('terminalReason=SPRINT_STALLED'));
            assert.ok(finishedLines[0].includes('verdict=needs-changes'));
            assert.ok(!finishedLines[0].toLowerCase().includes('crashed'), 'a FINISHED sprint must never be reported with CRASHED-sounding language');

            // 4) sprint-history.json -- the durable audit trail (real file,
            // real atomic write, read back from disk here, not from memory).
            const persisted = JSON.parse(await fsp.readFile(path.join(seDataDir, HISTORY_FILENAME), 'utf-8'));
            const finishedEvents = persisted.events.filter((e) => e.sprintId === runId && e.event === HISTORY_EVENTS.FINISHED);
            assert.equal(finishedEvents.length, 1);
            assert.equal(finishedEvents[0].terminalReason, 'SPRINT_STALLED');
            assert.equal(finishedEvents[0].verdict, 'needs-changes');

            // Re-ticking the watchdog must NOT append a second FINISHED history
            // event nor a second log line for the same still-reserved sprint.
            const logLinesBefore = logger.lines.length;
            await watchdog.classifyAll();
            assert.equal(logger.lines.length, logLinesBefore, 'a repeat tick for a sprint already recorded FINISHED must not log again');
        } finally {
            await fsp.rm(dataDir, { recursive: true, force: true });
            await fsp.rm(seDataDir, { recursive: true, force: true });
        }
    });

    test('PID gone + engine terminal state found ONLY by the LEGACY BRANCH key (pre-k7b.1 reservation) => FINISHED via the fallback path', async () => {
        const dataDir = await tmpDataDir('k7b6-branch-');
        const seDataDir = await tmpDataDir('k7b6-branch-se-');
        try {
            const env = { ...process.env, APRA_FLEET_DATA_DIR: dataDir };
            // A run-id-mismatched sprint: the reservation's sprintId is NOT the
            // key the terminal state was ever written under -- simulating a
            // reservation claimed before apra-fleet-k7b.1's run-id plumbing
            // shipped, where the only lookup key available is the
            // reservation's OWN recorded `branch` (ledger.mjs's
            // Reservation.branch).
            const sprintId = `k7b6-mismatched-run-${process.pid}-${Date.now()}`;
            const branch = `feat/k7b6-legacy-branch-${process.pid}`;
            const statePath = getTerminalRunStatePath(branch, env);
            fs.mkdirSync(path.dirname(statePath), { recursive: true });
            fs.writeFileSync(statePath, JSON.stringify({ terminalReason: 'DONE' }));

            // Confirm the run-id key genuinely has nothing under it -- the
            // fallback must be doing the real work here, not a coincidental hit.
            assert.equal(fs.existsSync(getTerminalRunStatePath(sprintId, env)), false);

            const deadPid = realDeadPid();
            const history = createHistory({ filePath: path.join(seDataDir, HISTORY_FILENAME) });
            await history.start();
            const recordPromises = [];
            const trackingHistory = { record: (entry) => { const p = history.record(entry); recordPromises.push(p); return p; } };
            const logger = capturingLogger();
            const ledger = { list: () => [{ sprintId, childPid: deadPid, branch }] };

            const watchdog = createWatchdog({ ledger, env, history: trackingHistory, logger });
            const [classification] = await watchdog.classifyAll();
            await Promise.all(recordPromises);

            assert.equal(classification.status, WATCHDOG_STATUS.FINISHED, 'the legacy branch-keyed terminal state must still resolve FINISHED via the fallback path');
            assert.equal(classification.terminalState.terminalReason, 'DONE');

            const persisted = JSON.parse(await fsp.readFile(path.join(seDataDir, HISTORY_FILENAME), 'utf-8'));
            const finishedEvents = persisted.events.filter((e) => e.sprintId === sprintId && e.event === HISTORY_EVENTS.FINISHED);
            assert.equal(finishedEvents.length, 1);
            assert.equal(finishedEvents[0].terminalReason, 'DONE');

            const finishedLines = logger.lines.filter((l) => l.includes('[watchdog] FINISHED'));
            assert.equal(finishedLines.length, 1);
            assert.match(finishedLines[0], ISO_PREFIX_RE);
        } finally {
            await fsp.rm(dataDir, { recursive: true, force: true });
            await fsp.rm(seDataDir, { recursive: true, force: true });
        }
    });

    test('supervisor log lines from reconcile.mjs and readopt.mjs (the other two apra-fleet-k7b.2-timestamped modules exercised by a restart pass) carry ISO-8601 timestamps', async () => {
        const logger = capturingLogger();
        const history = { record: async (entry) => entry };
        // An empty restart pass (no ledger entries at all) still logs its
        // summary line unconditionally in both reconcile.mjs and readopt.mjs
        // -- real modules, real (trivial) control flow, no fs/process needed.
        const ledger = { list: () => [], get: () => undefined, release: async () => true };
        const spawner = { adopt: () => {} };
        const reconciler = createReconciler({ ledger, history, logger });
        const readopter = createReadopter({ ledger, spawner, reconciler, logger });

        await readopter.readopt();

        const reconcileLines = logger.lines.filter((l) => l.includes('[reconcile]'));
        const readoptLines = logger.lines.filter((l) => l.includes('[readopt]'));
        assert.equal(reconcileLines.length, 1, `expected exactly one [reconcile] summary line, got: ${JSON.stringify(logger.lines)}`);
        assert.equal(readoptLines.length, 1, `expected exactly one [readopt] summary line, got: ${JSON.stringify(logger.lines)}`);
        assert.match(reconcileLines[0], ISO_PREFIX_RE, 'reconcile.mjs log lines must carry an ISO-8601 timestamp prefix');
        assert.match(readoptLines[0], ISO_PREFIX_RE, 'readopt.mjs log lines must carry an ISO-8601 timestamp prefix');
    });
});
