import { test, describe } from 'node:test';
import assert from 'node:assert';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME, HISTORY_EVENTS } from '../src/supervisor/history.mjs';
import { createSpawner } from '../src/supervisor/spawner.mjs';
import { createWatchdog, WATCHDOG_STATUS, formatExitDetail } from '../src/supervisor/watchdog.mjs';

// apra-fleet-k7b.7: integration test verifying apra-fleet-k7b.3 (spawner exit
// code/signal/time recorded in ledger and surfaced by the watchdog) end to
// end, against a REAL spawned OS child process (never a fake
// child_process.spawn) -- the same real-process posture
// test/fixtures/spawner/harness.mjs already establishes for the eft.4.2
// orphan-survival tests.
//
// Chain under test:
//   1. Spawn a real child process (test/fixtures/spawner/exit-nonzero.mjs)
//      that exits nonzero almost immediately.
//   2. The spawner's real 'exit' listener fires onChildExit({ runId,
//      exitCode, signal, at, logPath }) -- wired exactly as bin/serve.mjs
//      wires it: ledger.recordExit() annotates the still-held reservation,
//      history.record(CHILD_EXITED) writes the durable audit event.
//   3. Assert the ledger reservation and the history event both carry
//      { exitCode, signal, exitedAt/at }.
//   4. The watchdog's classifySprint() (real makeChildPidProbe(), no PID
//      alive once the real process has exited) reports CRASHED with a
//      `detail` string built by formatExitDetail() -- 'exited 1 at ...' --
//      not the bare 'pid gone' a pre-k7b.3 watchdog would report.
//
// This fails against pre-k7b.3 behaviour (spawner had no onChildExit hook,
// ledger had no recordExit(), watchdog always reported bare 'pid gone') and
// passes after it.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const exitNonzeroPath = path.join(__dirname, 'fixtures/spawner/exit-nonzero.mjs');

async function tmpDir() {
    return fsp.mkdtemp(path.join(os.tmpdir(), 'k7b7-exit-detail-'));
}

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 20 } = {}) {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error('waitFor() timed out');
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
}

describe('apra-fleet-k7b.7: spawner exit code/signal/time recorded in ledger and surfaced by watchdog', () => {
    test('a real nonzero-exit child is recorded in the ledger/history with {exitCode, signal, at} and classified CRASHED with an "exited 1 at ..." detail', async () => {
        const dir = await tmpDir();
        try {
            const ledger = createLedger({ filePath: path.join(dir, LEDGER_FILENAME) });
            await ledger.start();
            const history = createHistory({ filePath: path.join(dir, HISTORY_FILENAME) });
            await history.start();

            const runId = 'k7b7-run-1';

            // Mirrors bin/serve.mjs's real wiring exactly (see its
            // createSpawner({ onChildExit }) doc comment): persist into the
            // ledger (in-place annotation) and history (durable audit event),
            // both best-effort.
            const spawner = createSpawner({
                command: process.execPath,
                cliPath: exitNonzeroPath,
                basePort: 19081,
                onChildExit: async ({ runId: exitedRunId, exitCode, signal, at, logPath }) => {
                    if (!exitedRunId) return;
                    await ledger.recordExit(exitedRunId, { exitCode, signal, at });
                    await history.record({ sprintId: exitedRunId, event: HISTORY_EVENTS.CHILD_EXITED, exitCode, signal, at, logPath });
                },
            });

            // Claim the reservation BEFORE spawning (recordExit() requires an
            // existing reservation to annotate, and the real child may exit
            // before this test gets a chance to record its pid), then record
            // the real childPid once spawnSprint() returns it -- mirroring
            // api.mjs's createSprintController.launch(), which generates the
            // sprintId before spawning (apra-fleet-k7b.1) and claims/sets
            // childPid once the spawned pid is known.
            await ledger.claim(runId, { members: ['alice'], issueRoots: ['apra-fleet-k7b'] });

            const { pid } = await spawner.spawnSprint({
                issue: 'apra-fleet-k7b.7', members: 'alice', branch: 'b1', base: 'main', runId,
            });
            await ledger.setChildPid(runId, pid);

            // Real OS process exit -- wait for the ledger annotation to land
            // (the spawner's real 'exit' event handler runs asynchronously).
            await waitFor(() => ledger.get(runId)?.exitCode !== null && ledger.get(runId)?.exitCode !== undefined);

            const reservation = ledger.get(runId);
            assert.strictEqual(reservation.exitCode, 1, 'ledger must record the real child exit code');
            assert.strictEqual(reservation.signal, null);
            assert.ok(typeof reservation.exitedAt === 'string' && reservation.exitedAt.length > 0, 'ledger must record a real exitedAt timestamp');

            const childExitedEvents = history.list().filter((e) => e.sprintId === runId && e.event === HISTORY_EVENTS.CHILD_EXITED);
            assert.strictEqual(childExitedEvents.length, 1, 'exactly one CHILD_EXITED history event must be recorded');
            assert.strictEqual(childExitedEvents[0].exitCode, 1);
            assert.strictEqual(childExitedEvents[0].signal, null);
            assert.ok(typeof childExitedEvents[0].at === 'string' && childExitedEvents[0].at.length > 0);

            // The watchdog's classifySprint(), driven by the REAL child-pid
            // probe (no PID alive -- the real process has exited) and this
            // sprint's own ledger entry (which now carries exitCode/signal/
            // exitedAt) reports CRASHED (no engine terminal state was ever
            // written by the fixture) with a detail string built from the
            // recorded exit info.
            const watchdog = createWatchdog({
                ledger: { list: () => ledger.list().filter((r) => r.sprintId === runId) },
                hasTerminalState: () => false,
                recordTerminalError: () => {},
            });
            const classification = await watchdog.classifySprint({ sprintId: runId, ...ledger.get(runId) });
            assert.strictEqual(classification.status, WATCHDOG_STATUS.CRASHED);
            assert.strictEqual(classification.childPid, pid);
            assert.match(classification.detail, /^exited 1 at .+/, `expected an "exited 1 at ..." detail, got: ${classification.detail}`);
            assert.notStrictEqual(classification.detail, 'pid gone', 'must not fall back to the bare pre-k7b.3 "pid gone" detail');

            // formatExitDetail() (the function bin/serve.mjs's watchdog log
            // line and defaultRecordTerminalError() both use) agrees.
            assert.strictEqual(formatExitDetail(ledger.get(runId)), classification.detail);
        } finally {
            await fsp.rm(dir, { recursive: true, force: true });
        }
    });
});
