#!/usr/bin/env node
// =============================================================================
// `fleet-se serve` -- always-on auto-sprint supervisor entry point
// =============================================================================
//
// Boots the supervisor HTTP API (see ../src/supervisor/server.mjs) and keeps
// the process alive INDEFINITELY. The process exits ONLY when:
//   * a client POSTs /api/shutdown, or
//   * the operator sends SIGINT / SIGTERM.
// It never exits because a sprint finished or a child crashed (process model B:
// sprints run as detached, IPC-less children of bin/cli.mjs, spawned later by
// the eft.4.2 spawner seam).
//
// This skeleton wires only the lifecycle-owned endpoints; the ledger, spawner,
// watchdog and dashboard seams are inert stubs here and get replaced by their
// respective eft tasks without changing this entry point.
// =============================================================================

import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createSupervisor, DEFAULT_SERVICE_PORT, readJsonBody, sendJson } from '../src/supervisor/server.mjs';
import { createLedger } from '../src/supervisor/ledger.mjs';
import { createHistory } from '../src/supervisor/history.mjs';
import { createSpawner } from '../src/supervisor/spawner.mjs';
import { createReconciler, registerReservationRoutes } from '../src/supervisor/reconcile.mjs';
import { createReadopter } from '../src/supervisor/readopt.mjs';
import { createLiveProxy, registerLiveRoutes } from '../src/supervisor/proxy.mjs';
import { createHistoryView, registerHistoryViewRoutes } from '../src/supervisor/history-view.mjs';
import { createIdAllocator, registerIdAllocatorRoutes } from '../src/supervisor/id-allocator.mjs';
import { createDoltMutex, registerDoltMutexRoutes } from '../src/supervisor/dolt-mutex.mjs';

const SERVE_USAGE = `
Usage: fleet-se serve [options]

Starts the always-on auto-sprint supervisor. Runs until POST /api/shutdown or a
termination signal (Ctrl-C / SIGTERM).

Options:
      --port <port>   HTTP service port for the supervisor API. Default: ${DEFAULT_SERVICE_PORT}.
  -h, --help          Show this help message.
`.trim();

export function parseServeArgs(argv) {
    try {
        return parseArgs({
            args: argv,
            options: {
                port: { type: 'string' },
                help: { type: 'boolean', short: 'h' },
            },
            strict: true,
            allowPositionals: false,
        });
    } catch (err) {
        throw new Error(`Invalid command-line arguments: ${err.message}\n\n${SERVE_USAGE}`);
    }
}

export async function serveMain(argv = process.argv.slice(2)) {
    const { values } = parseServeArgs(argv);

    if (values.help) {
        console.log(SERVE_USAGE);
        return { exitCode: 0 };
    }

    let port = DEFAULT_SERVICE_PORT;
    if (values.port !== undefined) {
        port = Number(values.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            console.error(`Error: --port must be a valid TCP port number, got "${values.port}".`);
            return { exitCode: 1 };
        }
    }

    // The durable reservation ledger (eft.5.1) and its terminal-event history
    // (eft.5.4) are the restart-surviving source of truth. Wire them as real
    // collaborators so a restarted supervisor reconciles against on-disk state.
    const ledger = createLedger();
    const history = createHistory();
    const spawner = createSpawner();
    const reconciler = createReconciler({ ledger, history });
    // eft.4.5: re-adopts still-live children by PID at startup (see below),
    // registering their recovered --viewer-port with the spawner seam so
    // they are tracked/watchdog-monitored/HTTP-proxyable exactly like a
    // freshly-spawned child.
    const readopter = createReadopter({ ledger, spawner, reconciler });

    // eft.9.3: the supervisor-owned global child-id allocator. Its start()/stop()
    // (load persisted high-water marks + the abandoned-reservation sweep) is
    // driven by the seam machinery; its HTTP routes let detached sprint children
    // mint collision-free child ids under a shared parent (constraint C.4).
    const idAllocator = createIdAllocator();

    // eft.9.2: the supervisor-owned global dolt push mutex -- a LOAD-BEARING v1
    // requirement (PoC constraints C.2/C.3). Every cross-sprint `bd dolt push`
    // serializes through this ONE instance so two sprints never push at the same
    // time; its lease-sweep start()/stop() is driven by the seam machinery, and
    // its HTTP routes let independent detached sprint children acquire/release
    // over the supervisor port. Without this wiring a child's acquire() would
    // POST to an unregistered route (404) and wedge the D-push bracket.
    const doltMutex = createDoltMutex();

    const supervisor = createSupervisor({ port, ledger, spawner, idAllocator, doltMutex });
    registerIdAllocatorRoutes(supervisor, idAllocator, { readJsonBody, sendJson });
    registerDoltMutexRoutes(supervisor, doltMutex, { readJsonBody, sendJson });

    // eft.5.4: operator force-release of a wedged reservation.
    registerReservationRoutes(supervisor, reconciler);

    // eft.6.5: process-free History view. Always renders a finished sprint's
    // persisted old_sprints/<sprintId>.json through the SAME HTML template the
    // live viewer serves, fed a frozen state object -- no live process, no
    // /state or /events polling, Save/Stop hidden. Constructed before the live
    // proxy below so its renderForSprint() can be wired in as that proxy's
    // history-fallthrough renderer too (see next block).
    const historyView = createHistoryView();

    // eft.6.4: live-detail reverse proxy at /sprints/:id/live. Resolves each
    // sprint's child --viewer-port from the ledger's childPid + the spawner's
    // live pid->port bookkeeping, proxies HTTP + SSE through the supervisor
    // port, and falls through to the historical view (eft.6.5's full
    // template-based renderer, not just a minimal placeholder) once a sprint
    // finishes -- so the SAME template serves live and history at the SAME
    // URL. A dedicated /sprints/:id/history link (registered below) reaches
    // the identical rendering regardless of whether the sprint is still live.
    const liveProxy = createLiveProxy({ ledger, spawner, renderHistory: (sprintId) => historyView.renderForSprint(sprintId) });
    registerLiveRoutes(supervisor, liveProxy);
    registerHistoryViewRoutes(supervisor, historyView);

    // Explicit signals are the out-of-band way to stop cleanly, complementing
    // the in-band POST /api/shutdown route.
    const onSignal = (sig) => {
        console.log(`[supervisor] received ${sig}`);
        supervisor.stop(`signal:${sig}`).catch((err) => console.error(err));
    };
    process.once('SIGINT', () => onSignal('SIGINT'));
    process.once('SIGTERM', () => onSignal('SIGTERM'));

    await supervisor.start();

    // Restart reconciliation (eft.5.4) + re-adoption (eft.4.5): the ledger
    // seam has now loaded from disk. Start the history log, then PID-probe
    // every reloaded entry -- dead children release both axes and are marked
    // aborted-by-restart; live children are retained AND re-adopted (their
    // --viewer-port recovered from the live process's own command line and
    // registered with the spawner seam) so they resume being tracked,
    // watchdog-monitored, and HTTP-reachable exactly like a freshly-spawned
    // child.
    await history.start();
    await readopter.readopt();

    // Keep the process alive until an explicit shutdown resolves. Awaiting this
    // is what makes `fleet-se serve` "always-on" -- nothing else drives exit.
    await supervisor.shutdownRequested;
    return { exitCode: 0 };
}

function isMainModule() {
    try {
        return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
    } catch {
        return false;
    }
}

if (isMainModule()) {
    serveMain().then(
        ({ exitCode }) => process.exit(exitCode),
        (err) => { console.error(err); process.exit(1); },
    );
}
