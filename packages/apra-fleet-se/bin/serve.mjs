#!/usr/bin/env node
// =============================================================================
// `fleet-se serve` -- always-on fleet-sprint supervisor entry point
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
// Every module seam (ledger, spawner, watchdog, dashboard/backlog/launch-form,
// the eft.4.4 sprint/member/backlog API, the id allocator, and the dolt push
// mutex) is wired to its REAL implementation below -- none of them are the
// inert server.mjs stubs anymore (eft.4.8.1).
// =============================================================================

import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createSupervisor, DEFAULT_SERVICE_PORT, readJsonBody, sendJson } from '../src/supervisor/server.mjs';
import { createLedger } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_EVENTS } from '../src/supervisor/history.mjs';
import { createSpawner } from '../src/supervisor/spawner.mjs';
import { createReconciler, registerReservationRoutes } from '../src/supervisor/reconcile.mjs';
import { createReadopter } from '../src/supervisor/readopt.mjs';
import { createLiveProxy, registerLiveRoutes } from '../src/supervisor/proxy.mjs';
import { createHistoryView, registerHistoryViewRoutes } from '../src/supervisor/history-view.mjs';
import { createIdAllocator, registerIdAllocatorRoutes } from '../src/supervisor/id-allocator.mjs';
import { createDoltMutex, registerDoltMutexRoutes } from '../src/supervisor/dolt-mutex.mjs';
// eft.4.8.1: the operator-facing surface -- PID-liveness watchdog (eft.4.3),
// dashboard/backlog/launch-form (eft.6.*), and the six sprint/member/backlog
// operator endpoints (eft.4.4). These were fully implemented and unit-tested
// but never imported/registered here -- this is that wiring.
import { createWatchdog } from '../src/supervisor/watchdog.mjs';
import { createBacklog, registerBacklogRoutes } from '../src/supervisor/backlog.mjs';
// launch-form.mjs (renderLaunchFormHtml/buildLaunchRequestBody) has no
// register*Routes()/create*() seam of its own -- dashboard.mjs's
// renderIndexPageHtml() already imports it directly and falls back to
// renderLaunchFormHtml() whenever no launchFormHtml override is supplied, so
// constructing the real dashboard below (instead of the inert stub) is what
// actually wires the Launch Sprint form onto the page.
import { createDashboard, registerDashboardRoutes } from '../src/supervisor/dashboard.mjs';
import { createSprintController, registerSprintRoutes } from '../src/supervisor/api.mjs';
import { listFleetMembers } from '../src/supervisor/fleet-members.mjs';
import { resolveFleetServerConnection } from './cli.mjs';

const SERVE_USAGE = `
Usage: fleet-se serve [options]

Starts the always-on fleet-sprint supervisor. Runs until POST /api/shutdown or a
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
    // apra-fleet-f34.1: pass this supervisor's OWN listening address so every
    // spawned sprint child's cli.mjs receives --service-url and threads it
    // into runner.js's HTTP-backed dolt-mutex/id-allocator clients (see
    // spawner.mjs's buildSprintArgv/createSpawner doc comments).
    //
    // apra-fleet-k7b.3: onChildExit is this SAME-INSTANCE spawner's own
    // 'exit' listener notification (Node's own exit code/signal, keyed by
    // the launch's runId -- the SAME sprintId createSprintController claims
    // in the ledger BEFORE spawning, apra-fleet-k7b.1). Persist it two
    // places: (1) ledger.recordExit() annotates the still-held reservation
    // in place (does not release it) so the watchdog/dashboard can report
    // e.g. "exited 1 at ..." instead of a bare "pid gone"; (2) history
    // records a CHILD_EXITED audit event so the exit is still visible after
    // the reservation is eventually released. Both are independently best-
    // effort -- a missing/already-released reservation (e.g. a force-release
    // raced the child's own exit) must never crash this listener.
    // apra-fleet-ou7.1: onChildExit also carries logPath (spawner.mjs's own
    // per-sprint raw stdout/stderr log file) through into the CHILD_EXITED
    // history event -- the ledger already has it (recorded at claim() time,
    // see createSprintController's launch()), but history's own copy stays
    // discoverable even after the reservation is eventually released.
    const spawner = createSpawner({
        serviceUrl: `http://localhost:${port}`,
        onChildExit: async ({ runId, exitCode, signal, at, logPath }) => {
            if (!runId) return;
            try {
                await ledger.recordExit(runId, { exitCode, signal, at });
            } catch (err) {
                console.error(`[spawner] ledger.recordExit failed for '${runId}':`, err);
            }
            try {
                await history.record({ sprintId: runId, event: HISTORY_EVENTS.CHILD_EXITED, exitCode, signal, at, logPath });
            } catch (err) {
                console.error(`[spawner] history.record(CHILD_EXITED) failed for '${runId}':`, err);
            }
        },
    });
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

    // eft.4.3: PID-liveness watchdog + four-status classifier. Its
    // resolvePort collaborator maps a sprintId -> the live --viewer-port the
    // spawner allocated for that sprint's still-tracked child pid (undefined
    // once the pid bookkeeping is gone -- classifySprint() already treats an
    // unresolvable port as "cannot verify via HTTP", never as a false
    // "crashed"). This is the one small wiring helper this task needed: every
    // other seam below is a direct construct-and-register of an
    // already-implemented module.
    const resolveSprintPort = (sprintId) => {
        const entry = ledger.get(sprintId);
        if (!entry || entry.childPid == null) return undefined;
        return spawner.getLiveEntry ? spawner.getLiveEntry(entry.childPid)?.port : undefined;
    };
    // apra-fleet-k7b.2: `history` lets the watchdog append a durable
    // FINISHED event (terminalReason/verdict) to sprint-history.json the
    // first time it observes a PID-gone sprint's persisted terminal state,
    // the same collaborator the spawner's CHILD_EXITED wiring above uses.
    const watchdog = createWatchdog({ ledger, resolvePort: resolveSprintPort, history });

    // eft.6.2: the Backlog-last tree (full tracker minus every active
    // sprint's live-expanded scope). Reused both as the dashboard page's
    // Backlog section (below) AND as GET /api/backlog's real listing (see the
    // sprint controller wiring below), so there is exactly one "what does the
    // tracker minus claimed scope look like right now" implementation.
    const backlog = createBacklog({ ledger, watchdog });

    // eft.6.1/6.3: the single-page operator dashboard -- Sprint Stack, then
    // Backlog, then the Launch Sprint form (launch-form.mjs attaches itself
    // via dashboard.mjs's renderIndexPageHtml default; see the import comment
    // above for why no separate launch-form seam is constructed here).
    const dashboard = createDashboard({ ledger, watchdog, backlog });

    const supervisor = createSupervisor({ port, ledger, spawner, watchdog, dashboard, idAllocator, doltMutex });
    registerIdAllocatorRoutes(supervisor, idAllocator, { readJsonBody, sendJson });
    registerDoltMutexRoutes(supervisor, doltMutex, { readJsonBody, sendJson });

    // eft.6.1: GET / -- the Sprint Stack + Backlog + Launch Sprint page.
    registerDashboardRoutes(supervisor, dashboard);

    // supervisor-viewer-parity: GET /api/backlog/tasks -- the flat,
    // filterable data source the dashboard's Backlog tab re-fetches from
    // client-side on every filter change (see backlog.mjs's
    // backlogPanelClientScript()). Additive to GET /api/backlog below (the
    // sprint controller's older nested-tree shape), not a replacement.
    registerBacklogRoutes(supervisor, backlog);

    // eft.4.4: the six operator-facing sprint/member/backlog endpoints.
    // listMembers is fleet-backed (fleet-members.mjs opens a short-lived MCP
    // connection per call -- see its module doc for why the supervisor never
    // holds a standing fleet connection); getBacklog reuses the SAME backlog
    // seam constructed above rather than re-deriving "tracker minus claimed
    // scope" a second way. ledger/spawner/history are the same collaborators
    // every other seam in this file shares.
    const sprintController = createSprintController({
        ledger,
        spawner,
        history,
        listMembers: () => listFleetMembers({ resolveConnection: resolveFleetServerConnection }),
        getBacklog: async () => ({ tree: await backlog.buildTree() }),
    });
    registerSprintRoutes(supervisor, sprintController);

    // eft.5.4: operator force-release of a wedged reservation.
    registerReservationRoutes(supervisor, reconciler);

    // eft.6.5: process-free History view. Always renders a finished sprint's
    // persisted old_runs/<sprintId>.json (falling back to the legacy
    // old_sprints/<sprintId>.json, apra-fleet-eft.37.1) through the SAME HTML
    // template the live viewer serves, fed a frozen state object -- no live process, no
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
