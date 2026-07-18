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
import { createSupervisor, DEFAULT_SERVICE_PORT } from '../src/supervisor/server.mjs';
import { createLedger } from '../src/supervisor/ledger.mjs';
import { createHistory } from '../src/supervisor/history.mjs';
import { createReconciler, registerReservationRoutes } from '../src/supervisor/reconcile.mjs';

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
    const reconciler = createReconciler({ ledger, history });

    const supervisor = createSupervisor({ port, ledger });

    // eft.5.4: operator force-release of a wedged reservation.
    registerReservationRoutes(supervisor, reconciler);

    // Explicit signals are the out-of-band way to stop cleanly, complementing
    // the in-band POST /api/shutdown route.
    const onSignal = (sig) => {
        console.log(`[supervisor] received ${sig}`);
        supervisor.stop(`signal:${sig}`).catch((err) => console.error(err));
    };
    process.once('SIGINT', () => onSignal('SIGINT'));
    process.once('SIGTERM', () => onSignal('SIGTERM'));

    await supervisor.start();

    // Restart reconciliation (eft.5.4, pairs with eft.4.5 re-adoption): the
    // ledger seam has now loaded from disk. Start the history log, then
    // PID-probe every reloaded entry -- dead children release both axes and are
    // marked aborted-by-restart; live children are retained for re-adoption.
    await history.start();
    await reconciler.reconcile();

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
