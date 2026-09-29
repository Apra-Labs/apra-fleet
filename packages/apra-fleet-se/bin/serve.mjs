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
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createSupervisor, DEFAULT_SERVICE_PORT, readJsonBody, sendJson } from '../src/supervisor/server.mjs';
import { resolveServiceToken } from '../src/supervisor/auth.mjs';
import { createLedger, defaultDataDir } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_EVENTS } from '../src/supervisor/history.mjs';
import { createSpawner } from '../src/supervisor/spawner.mjs';
import { createReconciler, registerReservationRoutes, killPid } from '../src/supervisor/reconcile.mjs';
import { createReadopter } from '../src/supervisor/readopt.mjs';
import { createLiveProxy, registerLiveRoutes } from '../src/supervisor/proxy.mjs';
import { createHistoryView, registerHistoryViewRoutes, createFinishedRunsIndex } from '../src/supervisor/history-view.mjs';
import { createLogView, registerLogViewRoutes } from '../src/supervisor/log-view.mjs';
import { installSelfLogTee, createSelfLogView, registerSelfLogRoutes } from '../src/supervisor/self-log.mjs';
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
import { createSprintController, registerSprintRoutes, defaultMemberOverlapGuard, ApiError } from '../src/supervisor/api.mjs';
import { createScopeGuard, formatScopeConflict } from '../src/supervisor/scope-overlap.mjs';
import { listFleetMembers, executeFleetCommand } from '../src/supervisor/fleet-members.mjs';
import { createDoltOrphanSweep, normalizeMsysPathForPlatform } from '../src/supervisor/dolt-orphan-sweep.mjs';
import { resolveFleetServerConnection } from './cli.mjs';
import {
    discoverBeadsDir, probeBeadsIdentity, createBeadsIdentityState,
    formatNoBeadsWarning, formatProbeFailedWarning,
    resolveProjectDir, formatStaleConfiguredProjectWarning, PROJECT_DIR_SOURCE,
} from '../src/supervisor/beads-identity.mjs';
import { supervisorConfigPath } from '../src/supervisor/project-config.mjs';
import { validateRecordedToolchain } from '../src/supervisor/toolchain.mjs';
import { configureBdInvocation } from '../src/supervisor/lib/exec-bd.mjs';
import { formatBeadsIdentity, serializeExpectedIdentity } from '../fleet-sprint/beads-identity.mjs';
import { buildManifest, SPRINTS_UI_PATH } from '../src/registration/manifest.mjs';
import { startRegistrationConvergence } from '../src/registration/register.mjs';
import { registerHoldsRoute } from '../src/registration/holds.mjs';
import { registerOwnerRefsRoute } from '../src/registration/owner-refs.mjs';
import { registerUiRoutes } from '../src/registration/ui-placeholder.mjs';
import { createProjectsPageHandler } from '../src/registration/project-page.mjs';
import { registerProjectFolderRoutes } from '../src/supervisor/project-route.mjs';
import { openStore, NodeSqliteUnavailableError } from '../src/projects/store/db.mjs';
import { registerProjectRoutes } from '../src/projects/routes/projects.mjs';
import { StreamableHttpTransport } from '@apralabs/apra-fleet-client/transport';
import { McpClient } from '@apralabs/apra-fleet-client/client';
import { ApraFleet } from '@apralabs/apra-fleet-client';

const SERVE_USAGE = `
Usage: fleet-se serve [options]

Starts the always-on fleet-sprint supervisor. Runs until POST /api/shutdown or a
termination signal (Ctrl-C / SIGTERM).

Options:
      --port <port>         HTTP service port for the supervisor API. Default: ${DEFAULT_SERVICE_PORT}.
      --beads-dir <path>    Project folder (or its .beads dir) whose beads tracker
                            this supervisor runs against. A path that does not
                            exist is an error.
                            Not passed, the folder is resolved in this order:
                              1. this flag;
                              2. the project folder persisted in the
                                 supervisor's own config file, under the data
                                 dir below -- this is what a service-started
                                 supervisor uses, since its working directory is
                                 the installed engine path rather than any
                                 project. A persisted folder that no longer
                                 exists is NOT a startup error: the supervisor
                                 starts, WARNs naming that path and the fix, and
                                 does not fall back to step 3 (so it can never
                                 silently adopt an unrelated tracker);
                              3. walking up from the current directory, exactly
                                 like bd does.
                            No beads database found: the supervisor still starts,
                            logs a WARNING and reports beads as unknown until
                            GET /api/health?refresh=1 finds one. The resolved
                            folder and which of the three sources it came from
                            are logged once at startup and reported on
                            GET /api/health.
  -h, --help                Show this help message.

Environment:
  FLEET_SE_DATA_DIR                 Service data dir (ledger/history/logs).
  FLEET_SE_SWEEP_OWNER_DATA_DIR     Scope the dolt-orphan-sweep to ephemeral
                                    dolt sql-servers whose --data-dir is under
                                    this path, so an isolated supervisor
                                    instance never kills another instance's
                                    server. Unset = machine-wide (default).
`.trim();

/**
 * apra-fleet-k06.1: compose BOTH launch-time overlap guards api.mjs's own
 * header comment (eft.5.2/eft.5.3) already describes as meant to run
 * together, as a standalone/exported factory so the composition itself --
 * not just each guard in isolation -- is directly unit-testable without
 * booting the real supervisor process (serveMain constructs its real
 * defaultMemberOverlapGuard/createScopeGuard collaborators and passes them
 * here; a test can inject fakes/stubs of the SAME shape instead).
 *
 * Member axis runs FIRST, preserving its exact pre-existing
 * behavior/message/status (409, field 'members') for every case it already
 * covered. The issue-scope axis runs second, over the SAME ledger; a
 * conflict throws the same ApiError(409, ...) shape the member guard uses
 * (field 'issue', a formatScopeConflict() message naming the conflicting
 * sprint(s) and overlapping bead ids) rather than an unhandled 500 --
 * registerSprintRoutes' onApiError only translates ApiError instances into a
 * clean JSON error response. Either guard failing rejects the whole launch; a
 * launch overlapping on neither axis still succeeds.
 *
 * @param {{
 *   memberOverlapGuard: (ctx: { members: string[], issueRoots: string[] }) => Promise<void>|void,
 *   scopeGuard: { checkLaunch: (issueRoots: string[]) => Promise<{ ok: boolean, conflicts: Array<{sprintId: string, overlappingIds: string[]}> }> },
 * }} deps
 * @returns {(ctx: { members: string[], issueRoots: string[] }) => Promise<void>}
 */
export function composeBeforeLaunch({ memberOverlapGuard, scopeGuard }) {
    return async ({ members, issueRoots }) => {
        await memberOverlapGuard({ members, issueRoots });
        const scopeResult = await scopeGuard.checkLaunch(issueRoots);
        if (!scopeResult.ok) {
            throw new ApiError(409, formatScopeConflict(scopeResult.conflicts), 'issue');
        }
    };
}

/**
 * apra-fleet-g6ap.3.1: the /api/projects* fallback registered instead of
 * registerProjectRoutes() (src/projects/routes/projects.mjs) when the
 * projects store failed to open with NodeSqliteUnavailableError (an old Node
 * runtime -- see src/projects/store/db.mjs). Answers every /api/projects*
 * path with 503 {error: 'store-unavailable', detail}, matching the parent
 * feature's contract (apra-fleet-g6ap.3's description) -- never a silent
 * empty list, which would wrongly read as "no projects exist" rather than
 * "projects are unknown right now".
 *
 * Extracted as its own export -- same rationale as composeBeforeLaunch()
 * above -- so the fallback itself is directly unit-testable (a supervisor
 * built the way serve.mjs builds it, minus the real store) without needing
 * to force a real NodeSqliteUnavailableError out of openStore().
 *
 * @param {{ route: (method: string, path: string, handler: Function) => void }} supervisor
 * @param {string} detail Human-readable reason the store is unavailable
 *   (typically the NodeSqliteUnavailableError's own message).
 */
export function registerProjectsStoreUnavailableRoutes(supervisor, detail) {
    const projectsUnavailable = async (req, res) => sendJson(res, 503, { error: 'store-unavailable', detail });
    supervisor.route('GET', '/api/projects', projectsUnavailable);
    supervisor.route('POST', '/api/projects', projectsUnavailable);
    supervisor.route('GET', '/api/projects/:id', projectsUnavailable);
    supervisor.route('PUT', '/api/projects/:id', projectsUnavailable);
    supervisor.route('DELETE', '/api/projects/:id', projectsUnavailable);
}

/**
 * apra-fleet-g6ap.10 (test coverage: apra-fleet-g6ap.12): opens the projects
 * store, discriminating EXACTLY NodeSqliteUnavailableError (an old Node
 * runtime -- the caller degrades to registerProjectsStoreUnavailableRoutes()
 * above) from any other failure (e.g. a corrupt store), which RETHROWS so
 * supervisor startup fails loudly instead of silently answering a friendly
 * 503 for a problem that is not "old Node runtime".
 *
 * Extracted as its own export -- same rationale as composeBeforeLaunch() and
 * registerProjectsStoreUnavailableRoutes() above -- purely so tests can
 * inject a replacement `openStoreFn` and pin the discrimination itself
 * without needing to force a real NodeSqliteUnavailableError (or a real
 * corrupt store) out of the actual openStore(). serveMain() below calls this
 * with no argument (the real openStore) -- the instanceof discrimination is
 * unchanged from the original inline try/catch it replaces.
 *
 * @param {() => any} [openStoreFn] Defaults to the real openStore().
 * @returns {{ store: any, error: import('../src/projects/store/db.mjs').NodeSqliteUnavailableError|null }}
 */
export function openProjectStoreOrDegrade(openStoreFn = openStore) {
    try {
        return { store: openStoreFn(), error: null };
    } catch (err) {
        if (err instanceof NodeSqliteUnavailableError) {
            return { store: null, error: err };
        }
        throw err;
    }
}

export function parseServeArgs(argv) {
    try {
        return parseArgs({
            args: argv,
            options: {
                port: { type: 'string' },
                'beads-dir': { type: 'string' },
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

    // Installed before anything else logs: every console.log/warn/error from
    // this point on (including the seam-construction comments' own
    // console.error calls below) is timestamped (local time, not UTC) and
    // teed to <dataDir>/logs/supervisor.log, in addition to still reaching
    // the original console (an interactive run or a shell redirect is
    // unaffected). This is the supervisor's own equivalent of spawner.mjs's
    // per-sprint-child raw log; a dashboard link to GET /supervisor/log is
    // registered further down, once `supervisor` exists.
    const selfLog = installSelfLogTee();
    process.once('exit', () => selfLog.stop());

    let port = DEFAULT_SERVICE_PORT;
    if (values.port !== undefined) {
        port = Number(values.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            console.error(`Error: --port must be a valid TCP port number, got "${values.port}".`);
            return { exitCode: 1 };
        }
    }

    // Which .beads this supervisor runs against -- resolved ONCE, up front,
    // BEFORE any seam is built or the port is bound, so a supervisor started
    // from the wrong folder says so loudly instead of silently serving an
    // empty backlog or dispatching sprints at an unrelated tracker. Every bd
    // the supervisor itself runs (backlog/scope-overlap) resolves by walking
    // up from process.cwd(), so a resolved project folder is honored by
    // chdir'ing there (nothing sets BEADS_DIR); the sprint children below then
    // get repoRoot as their cwd and the resolved identity as --expect-beads.
    //
    // PRECEDENCE (resolveProjectDir() in ../src/supervisor/beads-identity.mjs
    // owns it): `--beads-dir`, else the project folder PERSISTED in
    // supervisor.config.json (read only through
    // ../src/supervisor/project-config.mjs), else the cwd walk-up. The
    // persisted step is why this is no longer "nothing is persisted": a
    // service's working directory is the installed engine path, which has no
    // relationship to any user project, so flag-or-cwd alone could never reach
    // a real project's beads DB out of the box. Exactly one startup line below
    // reports which of the three sources won.
    //
    // Severity, and its deliberate ASYMMETRY:
    //   - a `--beads-dir` that does not exist is an operator typo on THIS
    //     launch and still a startup ERROR (non-zero exit, message unchanged);
    //   - a CONFIGURED folder that does not exist is NOT a startup error. A
    //     persisted setting goes stale for reasons the operator is not present
    //     to fix (moved checkout, unmounted volume, reimaged machine), and a
    //     supervisor that refuses to boot cannot serve the console page that
    //     would let them correct it. It degrades to the SAME warning path as
    //     everything below, naming the offending path and the fix -- and
    //     deliberately does NOT fall back to the walk-up, which would
    //     re-create the original bug (the installed engine tree silently
    //     winning and an unrelated tracker being served as the project).
    //   - no .beads reachable from cwd, or a failing identity probe, is an
    //     environment condition: a WARNING (with the fix), the identity stays
    //     "unknown" (health `beads: null` + `beadsWarning`, amber dashboard
    //     header, no --expect-beads handed to sprints -- the engine then
    //     verifies members against the orchestrator's own beads), and GET
    //     /api/health?refresh=1 can recover it without a restart.
    let project;
    try {
        project = await resolveProjectDir({ flag: values['beads-dir'], cwd: process.cwd() });
    } catch (err) {
        // Only the flag branch throws -- the typo-is-fatal half above.
        console.error(`Error: ${err && err.message ? err.message : err}`);
        return { exitCode: 1 };
    }
    if (project.chdir) {
        try {
            process.chdir(project.chdir);
        } catch (err) {
            if (project.source === PROJECT_DIR_SOURCE.FLAG) {
                console.error(`Error: ${err && err.message ? err.message : err}`);
                return { exitCode: 1 };
            }
            // A configured folder that vanished between the stat and the chdir
            // takes the same staleness-tolerant path as a missing one.
            project = {
                ...project,
                chdir: null,
                usable: false,
                warning: formatStaleConfiguredProjectWarning(project.projectDir, supervisorConfigPath()),
            };
        }
    }
    // An unusable configured folder must not run the walk-up at all (see the
    // asymmetry comment above), so the discovery is skipped and its warning
    // stands in for the no-beads one.
    const discovered = project.usable ? discoverBeadsDir({ cwd: process.cwd() }) : null;
    const repoRoot = discovered ? discovered.repoRoot : (project.usable ? process.cwd() : project.projectDir);

    // WALK-UP REPORTS WHAT IT FOUND, not where it started. The walk-up
    // branch of resolveProjectDir() can only answer with the cwd -- it does
    // no discovery of its own -- but the folder this supervisor actually
    // adopted is the ancestor that holds `.beads`, which is also the cwd
    // handed to every sprint child. Reporting the cwd instead made health
    // and GET /api/project name a directory that is merely INSIDE the
    // project, which reads as the wrong project whenever the supervisor was
    // started from a subfolder. The flag and config sources already report
    // the folder itself, so this is also what makes the three agree.
    if (project.source === PROJECT_DIR_SOURCE.WALK_UP && discovered) {
        project = { ...project, projectDir: discovered.repoRoot };
    }
    console.log(`[supervisor] project folder: ${project.projectDir} (source: ${project.source})`);

    // THE RECORDED TOOLCHAIN (apra-fleet-i9ag.19.10) -- re-probed HERE, in the
    // same up-front startup block that just resolved the project folder:
    // BEFORE any seam is constructed and BEFORE the port is bound, and before
    // the beads-identity probe a few lines down runs the FIRST `bd` of this
    // process's life (that probe goes through ../src/supervisor/lib/exec-bd.mjs
    // too, so configuring the bd invocation after it would leave exactly the
    // service case this lane exists to fix -- no login PATH -- unable to find
    // bd for its own identity probe).
    //
    // WHY re-probe at all: the absolute node/bd paths recorded at install time
    // (supervisor.config.json's `toolchain` block) go stale for reasons the
    // operator is not present to fix -- a version manager removed that
    // release, the checkout moved, the machine was reimaged. Recording is
    // worthless unless a stale recording is LOUD, and unless the values that
    // survive validation actually reach the two places that need them: the
    // sprint runner (createSpawner's configuredNodePath, below) and bd
    // (configureBdInvocation, just below).
    //
    // SEVERITY, and the SAME deliberate asymmetry the persisted project
    // folder above already documents: a bad recording is LOUD but NEVER
    // fatal. A supervisor that refuses to start cannot serve the console page
    // an operator would use to correct the setting, so this block never
    // returns a non-zero exit code and never skips the listen -- loud and
    // still serving; never silent, and never dead.
    //
    // NODE vs BD is read off `nodeOk`/`bdOk` (machine-readable, per
    // ../src/supervisor/toolchain.mjs) -- never by substring-matching the
    // module's prose. A broken node is an ERROR (node-runner.mjs's CONFIGURED
    // tier hard-fails every launch over it); a broken bd is a WARNING
    // (exec-bd.mjs degrades to a PATH lookup instead). The problem wording
    // and the single fix line are the module's, restated nowhere here.
    const toolchain = await validateRecordedToolchain();
    if (!toolchain.configured) {
        // An older install that predates the recording, or a foreground
        // `node bin/serve.mjs` dev run. Informational ONLY: no error, no
        // warning state, and node/bd resolution below stays exactly what it
        // is today (FLEET_SE_NODE / current runtime / PATH, and a bare `bd`).
        console.log(
            `[supervisor] toolchain: not recorded (${toolchain.reason ?? 'no toolchain block'}); `
            + 'resolving node and bd as before (FLEET_SE_NODE, this runtime, then PATH).',
        );
    } else if (toolchain.problems.length === 0) {
        console.log(
            `[supervisor] toolchain: node ${toolchain.nodePath} (v${toolchain.nodeVersion}), `
            + `bd ${toolchain.bdPath} (v${toolchain.bdVersion}) (source: ${toolchain.source})`,
        );
    } else if (!toolchain.nodeOk) {
        console.error(`[supervisor] ERROR: ${toolchain.problems.join(' ')} ${toolchain.fixLine}`);
    } else {
        // Node validated; only bd is broken. Report node once (sprints WILL
        // launch with it) and warn about bd separately, so the operator is
        // never left guessing which of the two went bad.
        console.log(
            `[supervisor] toolchain: node ${toolchain.nodePath} (v${toolchain.nodeVersion}) `
            + `(source: ${toolchain.source})`,
        );
        console.warn(
            `[supervisor] WARNING: ${toolchain.problems.join(' ')} `
            + `bd falls back to a PATH lookup until this is fixed. ${toolchain.fixLine}`,
        );
    }

    // bd: configured EXACTLY ONCE, and ONLY with values that PASSED
    // validation -- a broken recording must never become a broken bd
    // invocation, because exec-bd.mjs does no validation of its own (by
    // design) and a configured-but-dead bdPath would turn every backlog /
    // scope-overlap / identity call into a hard failure where today's PATH
    // lookup still works. An unvalidated value is therefore simply OMITTED:
    // with no bdPath the module reports `configured: false` and behaves
    // exactly as it does today. nodePath here is bd's win32-shim interpreter
    // only, so it too is passed only when node validated (exec-bd falls back
    // to process.execPath otherwise). Nothing recorded -> `{}` -> a no-op.
    configureBdInvocation({
        ...(toolchain.bdOk ? { bdPath: toolchain.bdPath } : {}),
        ...(toolchain.nodeOk ? { nodePath: toolchain.nodePath } : {}),
    });

    let beadsIdentityRecord = null;
    let beadsWarning = null;
    if (!discovered) {
        beadsWarning = project.warning ?? formatNoBeadsWarning(process.cwd());
    } else {
        try {
            beadsIdentityRecord = await probeBeadsIdentity({ cwd: repoRoot });
        } catch (err) {
            beadsWarning = formatProbeFailedWarning(repoRoot, err);
        }
    }
    const beadsIdentity = createBeadsIdentityState({ cwd: repoRoot, initial: beadsIdentityRecord, warning: beadsWarning });
    if (beadsIdentityRecord) {
        console.log(`[supervisor] ${formatBeadsIdentity(beadsIdentityRecord, { label: 'supervisor' })}`);
    }
    // Read the warning back off the STATE rather than the local above: a
    // probe that succeeded can still have produced an INCOMPLETE identity
    // (no prefix, no sync.remote, no git origin), which the engine's own
    // precondition treats as fatal to every sprint. createBeadsIdentityState
    // derives that case's warning itself, so exactly one place decides
    // whether there is something to say and the startup log, GET
    // /api/health's `beadsWarning` and the dashboard header cannot disagree.
    const startupBeadsWarning = beadsIdentity.getWarning();
    if (startupBeadsWarning) {
        console.warn(`[supervisor] WARNING: ${startupBeadsWarning}`);
    }

    // apra-fleet-50j6.1.2 / apra-fleet-ky2l.1.2 (DQ-20): resolve the shared
    // bearer service token that guards the `/api/` surface and the
    // live-sprint mutating routes (see auth.mjs). Prefers the shared
    // ~/.apra-fleet/fleet.key (the same key src/services/jwt.ts signs JWTs
    // with) over the private/token file minted under this supervisor's own
    // data root (FLEET_SE_DATA_DIR, or ~/.apra-fleet-se) -- the latter is a
    // fallback only, kept so a restarted supervisor with no fleet.key still
    // reuses the same token across restarts. The resolved source is logged
    // once at startup; the token value itself is never logged.
    const dataDir = defaultDataDir();
    const { token: serviceToken, source: serviceTokenSource } = resolveServiceToken(dataDir);
    console.log(`[supervisor] service token source: ${serviceTokenSource}`);

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
    // places: (1) history records a CHILD_EXITED audit event so the exit is
    // still visible after the reservation is eventually released; (2)
    // ledger.recordExit() annotates the still-held reservation in place (does
    // not release it) so the watchdog/dashboard can report e.g. "exited 1 at
    // ..." instead of a bare "pid gone". Both are independently best-effort --
    // a missing/already-released reservation (e.g. a force-release raced the
    // child's own exit) must never crash this listener.
    //
    // apra-fleet-xuo.6.1 -- ORDER IS LOAD-BEARING, history FIRST, ledger
    // SECOND. Both ledger.mjs and history.mjs commit their in-memory view only
    // after their atomic persist (tmp write + rename), and every observer (the
    // dashboard/log-view, and the ou7.3/k7b.7 integration tests) polls the
    // LEDGER's exitCode as the "this child has exited" readiness signal and
    // then immediately reads history. Recording the ledger first opened a
    // window one whole history-persist wide in which the ledger already showed
    // an exitCode while history still had zero CHILD_EXITED events for that
    // sprint -- the ledger/history mismatch of apra-fleet-xuo.6. Writing
    // history first makes "the ledger shows an exitCode" imply "history
    // already carries CHILD_EXITED" for every reader. Do not swap these back.
    //
    // apra-fleet-ou7.1: onChildExit also carries logPath (spawner.mjs's own
    // per-sprint raw stdout/stderr log file) through into the CHILD_EXITED
    // history event -- the ledger already has it (recorded at claim() time,
    // see createSprintController's launch()), but history's own copy stays
    // discoverable even after the reservation is eventually released.
    const spawner = createSpawner({
        serviceUrl: `http://localhost:${port}`,
        // Sprint children run from the project root (the folder holding the
        // discovered .beads, not whatever subfolder the operator started in)
        // and carry the resolved identity so the engine can verify every
        // member's own `bd where` against it (see beads-identity.mjs). Read
        // at each spawn (not captured at startup) so an identity recovered
        // by GET /api/health?refresh=1 reaches later sprints; while it is
        // unknown, --expect-beads is omitted and the engine falls back to
        // the orchestrator member's own identity.
        cwd: repoRoot,
        expectBeads: () => {
            const id = beadsIdentity.get();
            return id ? serializeExpectedIdentity(id) : undefined;
        },
        // apra-fleet-50j6.2.1/50j6.1.2: thread this supervisor's own token
        // through so a spawned child's coordination HTTP client (dolt-mutex,
        // id-allocator) authenticates against the SAME guard server.mjs now
        // enforces (see createSupervisor({ token }) below).
        serviceToken,
        // apra-fleet-i9ag.19.10: the RECORDED node path, handed to
        // node-runner.mjs's CONFIGURED tier (via spawner.mjs) so a
        // service-started supervisor whose PATH never saw a login shell can
        // still launch sprints.
        //
        // Deliberately the recorded value REGARDLESS of whether it validated
        // above -- the opposite of the bd rule right next to the validation
        // block, and not an oversight. The CONFIGURED tier treats an
        // unusable recorded path as a HARD error naming that exact path
        // (answered as POST /api/sprints 503, api.mjs's
        // runnerResolutionApiError), which is the honest outcome: withholding
        // it here would let resolution fall through to a PATH lookup, which
        // on the very host that needed the recording either fails with a
        // vaguer message or -- worse -- silently succeeds with a DIFFERENT
        // node than the one the operator recorded. bd can fall back silently
        // because its fallback still works; node's cannot.
        configuredNodePath: toolchain.nodePath ?? undefined,
        onChildExit: async ({ runId, exitCode, signal, at, logPath }) => {
            if (!runId) return;
            try {
                await history.record({ sprintId: runId, event: HISTORY_EVENTS.CHILD_EXITED, exitCode, signal, at, logPath });
            } catch (err) {
                console.error(`[spawner] history.record(CHILD_EXITED) failed for '${runId}':`, err);
            }
            try {
                await ledger.recordExit(runId, { exitCode, signal, at });
            } catch (err) {
                console.error(`[spawner] ledger.recordExit failed for '${runId}':`, err);
            }
        },
    });
    // apra-fleet-3i3.1: the real kill-signal implementation is only wired in
    // HERE -- createReconciler()'s own default is a safe no-op (see
    // reconcile.mjs's module doc) so nothing outside this production entry
    // point can accidentally send a real signal to an arbitrary pid.
    const reconciler = createReconciler({ ledger, history, killPid });
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

    // (apra-fleet-i9ag.5.1) Resolve the apra-fleet server connection once here
    // for the dashboard's header "Console" back-link (this origin, or nothing
    // when unresolved). Gated on the same fleet-key requirement registration
    // has: with no fleet.key present there is no point attempting a connection.
    // Resolution failures are swallowed -- the dashboard link is cosmetic.
    //
    // (apra-fleet-i9ag.12.2) This value is NO LONGER shared with
    // workflow-package registration. Registration now runs a convergence loop
    // that re-resolves the token, the connection and the origin on every pass,
    // because on a fresh machine all three are null/unusable at this point in
    // startup and a one-shot observation can never see them appear. The two can
    // therefore legitimately differ: the link shows where the server was at
    // startup, registration tracks where it actually is. Anything that needs the
    // LIVE origin must re-resolve, not read this constant.
    let fleetServerConnection = null;
    if (serviceTokenSource === 'fleet-key') {
        try {
            fleetServerConnection = await resolveFleetServerConnection();
        } catch {
            // Cosmetic link only -- see above.
        }
    }
    // `connection.url` is the MCP endpoint (e.g. 'http://127.0.0.1:PORT/mcp')
    // -- new URL(...).origin strips the path down to scheme://host:port,
    // never a hardcoded host/port and never a value built by shell expansion.
    const consoleOrigin = (fleetServerConnection && fleetServerConnection.mode === 'http'
        && typeof fleetServerConnection.url === 'string' && fleetServerConnection.url !== '')
        ? new URL(fleetServerConnection.url).origin
        : null;

    // eft.6.1/6.3: the single-page operator dashboard -- Sprint Stack, then
    // Backlog, then the Launch Sprint form (launch-form.mjs attaches itself
    // via dashboard.mjs's renderIndexPageHtml default; see the import comment
    // above for why no separate launch-form seam is constructed here).
    // apra-fleet-i9ag.4: finished-sprints list (old runs this supervisor has
    // a sprint-history.json event for), newest first, with verdict/PR.
    const finishedRuns = createFinishedRunsIndex({ history });
    const dashboard = createDashboard({ ledger, watchdog, backlog, beadsIdentity, consoleOrigin, finishedRuns });

    // docs/dolt-sync-redesign.md Part 3.3: kill any orphaned ephemeral
    // `dolt sql-server` a mid-settle orchestrator death left behind on a
    // member (settle's own finally covers every other path). Both
    // collaborators use the same short-lived-MCP-connection pattern as
    // listFleetMembers -- the supervisor never holds a standing fleet
    // transport.
    // apra-fleet-5co8.33: `FLEET_SE_SWEEP_OWNER_DATA_DIR` is the deps-level
    // scope seam for that sweep. Unset (production default) the probe/kill
    // command stays machine-wide -- it must be, because the ephemeral server's
    // `--data-dir` belongs to the MEMBER (dolt-settle.mjs reads it from
    // `bd dolt status` there), so a remote member's data dir has no relation to
    // this supervisor's own FLEET_SE_DATA_DIR and deriving a prefix from the
    // latter would silently make the sweep a no-op everywhere. Set (an isolated
    // instance -- e.g. regression-test-playbook.md's sandbox supervisor, whose
    // HOME and members all live under one root) it constrains candidates to
    // processes whose `--data-dir` is under that root, so this instance can
    // never kill another live supervisor's ephemeral server.
    const sweepOwnerDataDir = process.env.FLEET_SE_SWEEP_OWNER_DATA_DIR
        ? path.resolve(normalizeMsysPathForPlatform(process.env.FLEET_SE_SWEEP_OWNER_DATA_DIR))
        : null;
    if (sweepOwnerDataDir) {
        console.log(`[dolt-orphan-sweep] owner-scoped to data dirs under '${sweepOwnerDataDir}' (FLEET_SE_SWEEP_OWNER_DATA_DIR).`);
        // apra-fleet-5co8.36: a confident scope claim above is worse than
        // useless if the resolved prefix does not actually exist -- that is
        // exactly what an un-normalized MSYS path used to produce. Warn
        // loudly rather than let the sweep silently match nothing.
        if (!fs.existsSync(sweepOwnerDataDir)) {
            console.warn(`[dolt-orphan-sweep] WARNING: FLEET_SE_SWEEP_OWNER_DATA_DIR resolved to '${sweepOwnerDataDir}', which does not exist on disk -- the owner-scoped sweep will match no process and silently degrade to matching nothing.`);
        }
    }
    const doltOrphanSweep = createDoltOrphanSweep({
        listMembers: () => listFleetMembers({ resolveConnection: resolveFleetServerConnection }),
        execCommand: ({ member, command }) => executeFleetCommand({ member, command, resolveConnection: resolveFleetServerConnection }),
        ownerDataDirPrefix: sweepOwnerDataDir,
    });

    const supervisor = createSupervisor({
        port, token: serviceToken, ledger, spawner, watchdog, dashboard, idAllocator,
        doltMutex, doltOrphanSweep, beadsIdentity,
        // The project-folder resolution decided at the top of serveMain, so
        // GET /api/health can report the folder AND which source won it.
        project: { projectDir: project.projectDir, source: project.source },
        // apra-fleet-i9ag.19.10: the startup toolchain validation report,
        // handed in so the health handler can reach it without re-probing
        // (the health/dashboard SURFACING itself is apra-fleet-i9ag.19.12;
        // this only makes the value available). Deliberately the report as
        // validated at startup -- one voice, the same object the startup log
        // above spoke from, so health and the log can never disagree.
        toolchain,
    });
    registerIdAllocatorRoutes(supervisor, idAllocator, { readJsonBody, sendJson });
    registerDoltMutexRoutes(supervisor, doltMutex, { readJsonBody, sendJson });

    // apra-fleet-i9ag.17.2.1: guarded GET/POST /api/project -- read/write the
    // supervisor's persisted project folder for the console Projects page
    // (apra-fleet-i9ag.17.2.2). `project`/`dataDir` are the SAME values GET
    // /api/health already reports (this route registers no second copy of
    // the startup resolution above); `flagActive` mirrors that resolution's
    // own precedence decision rather than re-deriving it from the raw flag.
    registerProjectFolderRoutes(supervisor, {
        projectDir: project.projectDir,
        source: project.source,
        flagActive: project.source === PROJECT_DIR_SOURCE.FLAG,
        dataDir,
        readJsonBody,
        sendJson,
    });

    // eft.6.1: GET / -- the Sprint Stack + Backlog + Launch Sprint page.
    // (apra-fleet-i9ag.3.3) Also mounted at the manifest's Sprints nav path
    // (registration/manifest.mjs's SPRINTS_UI_PATH -- the single source for
    // that path, read here rather than hand-copied) so the shell's Sprints
    // nav entry embeds this same real dashboard instead of the /ui
    // placeholder registerUiRoutes() answers everything else with.
    registerDashboardRoutes(supervisor, dashboard, { extraIndexPaths: [SPRINTS_UI_PATH] });

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
    const listMembersForLaunch = () => listFleetMembers({ resolveConnection: resolveFleetServerConnection });

    // apra-fleet-k06.1: compose BOTH launch-time overlap guards api.mjs's own
    // header comment (eft.5.2/eft.5.3) already describes as meant to run
    // together. Before this, createSprintController() below was constructed
    // with no `beforeLaunch` override, so it silently fell back to
    // defaultMemberOverlapGuard ALONE -- the issue-scope guard
    // (createScopeGuard, live-expanded subtree overlap) was exercised only by
    // its own unit tests, never wired into the real POST /api/sprints path.
    // Two sprints with disjoint member sets but overlapping/nested issue
    // scopes (e.g. one targets an epic, another one of that epic's children)
    // could both launch and dispatch against the same beads concurrently.
    // See composeBeforeLaunch() above for the composition itself (ordering,
    // error shape) -- extracted as its own export so the composition is
    // directly unit-testable without booting this whole process.
    const memberOverlapGuard = defaultMemberOverlapGuard(ledger, listMembersForLaunch);
    const scopeGuard = createScopeGuard({ ledger });
    const beforeLaunch = composeBeforeLaunch({ memberOverlapGuard, scopeGuard });

    const sprintController = createSprintController({
        ledger,
        spawner,
        history,
        listMembers: listMembersForLaunch,
        getBacklog: async () => ({ tree: await backlog.buildTree() }),
        beforeLaunch,
        beadsIdentity,
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
    // (apra-fleet-i9ag.3.8) renderHistory is called with the live proxy's own
    // per-request resolveMountPrefix() result as its second argument
    // (proxy.mjs's serveHistory()) -- forwarded into renderForSprint() so the
    // finished-sprint page carries the same mount-aware back-link the rest of
    // this dashboard's pages do, instead of silently dropping it here.
    const liveProxy = createLiveProxy({
        ledger, spawner,
        renderHistory: (sprintId, mountPrefix) => historyView.renderForSprint(sprintId, mountPrefix),
    });
    registerLiveRoutes(supervisor, liveProxy);
    registerHistoryViewRoutes(supervisor, historyView);

    // apra-fleet-ou7.2: raw per-sprint stdout/stderr log, present for a live
    // sprint AND for an ended one (finished/crashed) -- exactly where the
    // live SSE viewer above is gone. Looks the sprint's recorded logPath up
    // by id (ledger first, then history for a released reservation); never
    // builds a path from the request's :id itself.
    const logView = createLogView({ ledger, history });
    registerLogViewRoutes(supervisor, logView);

    // GET /supervisor/log -- the supervisor's OWN stdout/stderr (see
    // installSelfLogTee() above), linked from the dashboard header.
    const selfLogView = createSelfLogView({ logPath: selfLog.logPath });
    registerSelfLogRoutes(supervisor, selfLogView);

    // apra-fleet-g6ap.2.2: GET /api/members/:id/holds and GET /api/owner-refs
    // -- the two routes the apra-fleet server consults (with the derived 'se'
    // credential, see supervisor/auth.mjs) before releasing/reassigning a
    // member or validating an owner ref against this package's projects.
    // holds only needs the ledger (already constructed above); owner-refs
    // needs the projects store opened -- openProjectStoreOrDegrade() above
    // catches EXACTLY NodeSqliteUnavailableError (an old Node runtime) so
    // GET /api/owner-refs degrades to 503 store-unavailable rather than
    // taking the whole supervisor down; any other open failure (a corrupt
    // store) still fails loudly (rethrown). `projectStore` is closed on
    // shutdown, below.
    const { store: projectStore, error: projectStoreOpenError } = openProjectStoreOrDegrade();
    if (projectStoreOpenError) {
        console.warn(`[supervisor] WARNING: ${projectStoreOpenError.message} GET /api/owner-refs and /api/projects* will answer 503 store-unavailable.`);
    }
    registerHoldsRoute(supervisor, { ledger });
    registerOwnerRefsRoute(supervisor, { store: projectStore });

    // apra-fleet-g6ap.3.1: mount the /api/projects CRUD routes (registered
    // module, src/projects/routes/projects.mjs -- untouched by this task) --
    // reusing the SAME projectStore handle opened above -- plus the /ui
    // placeholder. registerProjectRoutes() itself throws if handed a
    // store/client of the wrong shape, so when the store failed to open
    // (NodeSqliteUnavailableError only, caught above) every /api/projects*
    // path is answered by a local 503 store-unavailable fallback instead of
    // calling it at all; a real client is still built either way since the
    // client is independent of the store.
    //
    // `client` is a REAL ApraFleet instance (not a narrow wrapper) so the
    // concurrent project-domain sprint's bind/overview routes can reuse it
    // once merged -- built from the SAME apra-fleet HTTP singleton
    // resolveFleetServerConnection() resolves elsewhere in this file. When
    // no singleton is reachable yet, a minimal executeCommand-only stand-in
    // degrades every DQ-12 beads.remote probe to a loud isError result
    // instead of crashing supervisor startup; project CRUD that never
    // touches beads.remote is unaffected either way.
    let projectsClient;
    let projectsTransport = null;
    try {
        const projectsConnection = await resolveFleetServerConnection();
        if (projectsConnection && projectsConnection.mode === 'http') {
            projectsTransport = new StreamableHttpTransport(projectsConnection.url);
            await projectsTransport.start();
            projectsClient = new ApraFleet(new McpClient(projectsTransport));
        } else {
            console.warn(`[projects] WARNING: no reachable apra-fleet HTTP singleton (${projectsConnection && projectsConnection.reason}); beads.remote probes will fail until one is reachable and the supervisor is restarted.`);
            projectsClient = { executeCommand: async () => ({ isError: true, content: [{ text: 'apra-fleet HTTP singleton not reachable' }] }) };
        }
    } catch (err) {
        console.warn(`[projects] WARNING: could not connect to the apra-fleet server; beads.remote probes will fail: ${err && err.message ? err.message : err}`);
        projectsClient = { executeCommand: async () => ({ isError: true, content: [{ text: `apra-fleet server connection failed: ${err && err.message ? err.message : err}` }] }) };
    }

    if (projectStore) {
        registerProjectRoutes(supervisor, { store: projectStore, client: projectsClient });
    } else {
        registerProjectsStoreUnavailableRoutes(supervisor, projectStoreOpenError ? projectStoreOpenError.message : 'store unavailable');
    }

    // apra-fleet-g6ap.3.1 / apra-fleet-i9ag.17.2.2: /ui placeholder -- outside
    // the /api guard, swapped for a real static-file handler for exactly
    // PROJECTS_UI_PATH (createProjectsPageHandler() delegates every other
    // manifest-declared path back to the unchanged placeholder). A later
    // UI-bundle sprint can still replace this ONE call site again for the
    // remaining paths without touching server.mjs's routing table.
    registerUiRoutes(supervisor, {
        staticHandler: createProjectsPageHandler({ token: supervisor.token }),
    });

    // Explicit signals are the out-of-band way to stop cleanly, complementing
    // the in-band POST /api/shutdown route.
    const onSignal = (sig) => {
        console.log(`[supervisor] received ${sig}`);
        supervisor.stop(`signal:${sig}`).catch((err) => console.error(err));
    };
    process.once('SIGINT', () => onSignal('SIGINT'));
    process.once('SIGTERM', () => onSignal('SIGTERM'));

    await supervisor.start();

    // apra-fleet-g6ap.2.1: register this supervisor as workflow package 'se'
    // with the apra-fleet server, so its shell can proxy /ext/se/* and show
    // this package's nav/panels. Registration REQUIRES a fleet.key-sourced
    // token -- the apra-fleet server's /api/ guard
    // (src/console/server.ts's requiresConsoleGuard) only accepts the raw
    // fleet key on the bearer path, never the private/token fallback -- and a
    // reachable apra-fleet HTTP singleton. Either missing is an expected,
    // loudly-logged WAIT -- never a supervisor startup failure, and (since
    // apra-fleet-i9ag.12.2) never a permanent skip either. The whole loop runs
    // unawaited in the background so startup is not blocked on it.
    // unregister() runs once shutdown completes, below -- covers both the
    // signal path (onSignal -> supervisor.stop()) and the in-band
    // POST /api/shutdown path (server.mjs's own route also calls stop()),
    // since both resolve the SAME supervisor.shutdownRequested promise.
    //
    // (apra-fleet-i9ag.12.2) CONVERGENCE, not a one-shot check. This block used
    // to be a three-way if/else that logged "skipping workflow-package
    // registration" and gave up for the life of the process when (a) the token
    // was not fleet.key-sourced, (b) connection resolution threw, or (c) the
    // connection was not a usable http url. On a fresh machine those are
    // STAGES, not errors -- the machine passes (a) -> (c) -> registerable -- so
    // skipping once left Sprints missing from the console until a manual
    // supervisor restart.
    //
    // The values resolved at startup (serviceToken/serviceTokenSource,
    // fleetServerConnection, consoleOrigin) are deliberately NOT passed in:
    // each is a point-in-time observation that the loop must take again itself.
    // In particular consoleOrigin above is null on a fresh machine, and reusing
    // it could never yield a valid serverUrl. See startRegistrationConvergence()
    // in src/registration/register.mjs for the full why-re-resolve rationale
    // (including why an absent fleet.key pins the token source, and why the
    // registry must be posted to the server's ORIGIN and not its MCP endpoint).
    //
    // The dashboard's "Console" back-link still uses the startup-time
    // consoleOrigin: the dashboard is constructed once, and that link is
    // cosmetic. That is the pre-existing behaviour and is unchanged here.
    const registrationConvergence = startRegistrationConvergence({
        resolveToken: () => resolveServiceToken(dataDir),
        resolveConnection: () => resolveFleetServerConnection(),
        buildManifest: () => buildManifest({ baseUrl: `http://127.0.0.1:${supervisor.port}` }),
        shutdownRequested: supervisor.shutdownRequested,
    });
    registrationConvergence.done.catch((err) => {
        console.error(
            '[registration] convergence loop failed unexpectedly (it should catch its own errors):',
            err,
        );
    });

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

    // apra-fleet-g6ap.2.1: best-effort, time-bounded unregister from the
    // apra-fleet server's registry, after the supervisor's own teardown
    // (ledger/history/watchdog/etc, all inside supervisor.stop()) has already
    // completed -- see the comment above register()'s call site for why this
    // one hook covers both the signal and /api/shutdown stop paths.
    // (apra-fleet-i9ag.12.2) Whichever registration instance the convergence
    // loop finally CONSTRUCTED is the one to unregister -- the loop builds a
    // fresh one per pass (the token is fixed at construction), so there is no
    // single startup-time instance to reach for. Null when the loop never got
    // past its preconditions, in which case nothing was ever registered.
    // stop() also releases the loop if it is mid-backoff, so a shutdown racing
    // an un-converged supervisor does not wait out the remaining interval.
    registrationConvergence.stop();
    const registration = registrationConvergence.currentRegistration();
    if (registration) {
        await registration.unregister();
    }
    // apra-fleet-g6ap.2.2: close the projects store handle opened above,
    // after the supervisor's own teardown has completed -- same "hook onto
    // shutdownRequested" reasoning as unregister() above.
    if (projectStore) {
        try { projectStore.close(); } catch (err) { console.error('[supervisor] projectStore.close() failed:', err); }
    }
    // apra-fleet-g6ap.3.1: tear down the projects fleet client's transport
    // (only constructed when an HTTP singleton was actually reachable at
    // startup -- see projectsTransport above), same best-effort teardown
    // pattern as fleet-members.mjs's own short-lived connections.
    if (projectsTransport) {
        try { projectsTransport.stop(); } catch (err) { console.error('[supervisor] projectsTransport.stop() failed:', err); }
    }
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
