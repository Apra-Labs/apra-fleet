// =============================================================================
// Auto-sprint supervisor -- HTTP server skeleton (Plan Part 2.1, process model B)
// =============================================================================
//
// This module stands up the always-on `fleet-se serve` supervisor process.
// Per the confirmed design (process model B, fork()/IPC explicitly rejected):
//
//   * A single long-lived process owns the reservation ledger and an HTTP API.
//   * It spawns the existing bin/cli.mjs per sprint as a DETACHED child
//     (spawn({ detached: true, stdio: 'ignore' })) -- there is deliberately NO
//     parent-child IPC channel; children are independently-surviving orphans.
//     A crashed sprint can never take down a sibling or this supervisor.
//   * The supervisor runs INDEFINITELY. It exits ONLY on POST /api/shutdown or
//     an explicit signal (SIGINT/SIGTERM) -- never because a sprint finished,
//     and never because a child crashed.
//
// -----------------------------------------------------------------------------
// MODULE SEAMS (this is the boundary other eft.4 / eft.5 / eft.6 tasks plug in)
// -----------------------------------------------------------------------------
// `createSupervisor()` accepts four collaborators by dependency injection. This
// skeleton ships inert default stubs for each so `fleet-se serve` boots and
// stays up on its own; later tasks replace the stubs with real implementations
// without touching this file's lifecycle/HTTP-bootstrap logic:
//
//   ledger    -- the persisted reservation ledger of live sprints (eft.5). The
//                durable source of truth a restarted supervisor re-adopts from.
//   spawner   -- the detached child-per-sprint spawner (eft.4.2): allocates a
//                per-sprint --viewer-port and launches bin/cli.mjs detached.
//   watchdog  -- the PID-liveness watchdog + four-status classifier (eft.4.3):
//                running-healthy / running-unresponsive / crashed / finished.
//   dashboard -- the operator dashboard / static+proxy HTTP surface (eft.6).
//
// Each seam is a plain object; this skeleton only calls each collaborator's
// optional `start()` / `stop()` lifecycle hooks (if present) so wiring later
// implementations in is a drop-in. The richer HTTP endpoints (GET /api/members,
// /api/backlog, POST /api/sprints, etc.) are added by eft.4.4 by registering
// routes via `supervisor.route()`; this skeleton implements only the two the
// lifecycle itself owns: POST /api/shutdown and GET /api/health.
// =============================================================================

import http from 'node:http';

/** Default HTTP service port for the always-on supervisor. */
export const DEFAULT_SERVICE_PORT = 8787;

/**
 * An inert seam stub. Later eft tasks pass real implementations; until then the
 * supervisor boots against these no-ops so `fleet-se serve` is independently
 * runnable. Named so logs/introspection make the "not yet wired" state obvious.
 * @param {string} name
 * @returns {{ name: string, start(): Promise<void>, stop(): Promise<void> }}
 */
export function makeSeamStub(name) {
    return {
        name: `${name}:stub`,
        async start() {},
        async stop() {},
    };
}

/**
 * Reads and JSON-parses a request body with a hard size cap so a hostile or
 * buggy client cannot exhaust memory. Returns `undefined` for an empty body.
 * @param {import('http').IncomingMessage} req
 * @param {{ maxBytes?: number }} [opts]
 * @returns {Promise<any>}
 */
export function readJsonBody(req, opts = {}) {
    const maxBytes = opts.maxBytes ?? 1_000_000;
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
                reject(new Error(`request body exceeds ${maxBytes} byte limit`));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf-8').trim();
            if (raw.length === 0) {
                resolve(undefined);
                return;
            }
            try {
                resolve(JSON.parse(raw));
            } catch (err) {
                reject(new Error(`invalid JSON request body: ${err.message}`));
            }
        });
        req.on('error', reject);
    });
}

/**
 * Writes a JSON response. Centralized so every handler (and the error-isolation
 * wrapper) emits a consistent shape.
 * @param {import('http').ServerResponse} res
 * @param {number} status
 * @param {any} payload
 */
export function sendJson(res, status, payload) {
    const body = JSON.stringify(payload ?? {});
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
    });
    res.end(body);
}

/**
 * Creates (but does not start) the always-on supervisor. Returns a handle whose
 * `start()`/`stop()` own the full lifecycle; `route()` lets later tasks register
 * additional endpoints against the same error-isolated dispatcher.
 *
 * @param {{
 *   port?: number,
 *   ledger?: object,
 *   spawner?: object,
 *   watchdog?: object,
 *   dashboard?: object,
 *   logger?: { log?: Function, error?: Function },
 *   createServer?: (handler: (req: any, res: any) => void) => import('http').Server,
 * }} [deps]
 * @returns {{
 *   route(method: string, path: string, handler: Function): void,
 *   start(): Promise<{ port: number }>,
 *   stop(reason?: string): Promise<void>,
 *   handleRequest(req: any, res: any): Promise<void>,
 *   server: import('http').Server,
 *   seams: { ledger: object, spawner: object, watchdog: object, dashboard: object },
 *   port: number,
 * }}
 */
export function createSupervisor(deps = {}) {
    const port = Number.isInteger(deps.port) ? deps.port : DEFAULT_SERVICE_PORT;
    const logger = deps.logger ?? console;
    const log = (...a) => logger.log?.(...a);
    const logError = (...a) => (logger.error ?? logger.log)?.(...a);

    // Module seams -- inert stubs unless a real collaborator was injected.
    const seams = {
        ledger: deps.ledger ?? makeSeamStub('ledger'),
        spawner: deps.spawner ?? makeSeamStub('spawner'),
        watchdog: deps.watchdog ?? makeSeamStub('watchdog'),
        dashboard: deps.dashboard ?? makeSeamStub('dashboard'),
    };

    /** @type {Map<string, Function>} keyed by `METHOD path`. */
    const routes = new Map();
    const routeKey = (method, path) => `${method.toUpperCase()} ${path}`;

    function route(method, path, handler) {
        routes.set(routeKey(method, path), handler);
    }

    let server;
    let shutdownResolve;
    // Promise that resolves once shutdown has been requested (via /api/shutdown
    // or a signal) AND the HTTP server + seams are torn down. `start()` returns
    // only the listening info; callers keep the process alive by awaiting the
    // server, so the process exits solely on explicit shutdown -- never because
    // a sprint finished or a child crashed.
    const shutdownRequested = new Promise((resolve) => {
        shutdownResolve = resolve;
    });

    /**
     * The single request dispatcher. CRITICAL (acceptance criterion): an
     * unhandled error inside ANY one request handler is caught here and turned
     * into a 500 -- it must NEVER propagate out and exit the supervisor.
     */
    async function handleRequest(req, res) {
        const method = (req.method || 'GET').toUpperCase();
        const url = new URL(req.url || '/', `http://localhost:${port}`);
        const path = url.pathname;

        try {
            const handler = routes.get(routeKey(method, path));
            if (!handler) {
                sendJson(res, 404, { error: `no route for ${method} ${path}` });
                return;
            }
            await handler(req, res, { url });
        } catch (err) {
            // Isolate the failure: log it, answer 500 if we still can, and
            // keep the process alive.
            logError(`[supervisor] request ${method} ${path} failed:`, err && err.stack ? err.stack : err);
            if (!res.headersSent) {
                sendJson(res, 500, { error: 'internal supervisor error' });
            } else {
                try { res.end(); } catch { /* already gone */ }
            }
        }
    }

    // -- Lifecycle-owned endpoints ------------------------------------------

    // GET /api/health -- liveness probe; confirms the supervisor is up and
    // reports which seams are still inert stubs.
    route('GET', '/api/health', async (req, res) => {
        sendJson(res, 200, {
            status: 'ok',
            uptimeSeconds: Math.round(process.uptime()),
            pid: process.pid,
            seams: Object.fromEntries(
                Object.entries(seams).map(([k, v]) => [k, v.name ?? 'wired']),
            ),
        });
    });

    // POST /api/shutdown -- the ONLY clean, in-band way to stop the supervisor.
    route('POST', '/api/shutdown', async (req, res) => {
        sendJson(res, 200, { status: 'shutting-down' });
        // Defer the actual teardown until after this response flushes so the
        // caller always gets an answer.
        setImmediate(() => { stop('http:/api/shutdown').catch((e) => logError(e)); });
    });

    let stopping = null;
    /**
     * Idempotent teardown: close the HTTP server and stop every seam, then
     * resolve `shutdownRequested`. Safe to call more than once.
     * @param {string} [reason]
     */
    function stop(reason = 'explicit') {
        if (stopping) return stopping;
        stopping = (async () => {
            log(`[supervisor] shutting down (${reason})`);
            await new Promise((resolve) => {
                if (!server || !server.listening) { resolve(); return; }
                server.close(() => resolve());
            });
            // Stop seams in reverse of a natural start order; isolate each so
            // one failing seam cannot block the others' teardown.
            for (const seam of [seams.dashboard, seams.watchdog, seams.spawner, seams.ledger]) {
                try { await seam.stop?.(); } catch (err) { logError(`[supervisor] seam ${seam.name ?? ''} stop failed:`, err); }
            }
            shutdownResolve();
        })();
        return stopping;
    }

    /**
     * Bind the HTTP server and start every seam. Resolves once listening.
     * @returns {Promise<{ port: number }>}
     */
    async function start() {
        // Start seams first so the API never serves before its collaborators
        // are ready. Stubs are no-ops.
        for (const seam of [seams.ledger, seams.spawner, seams.watchdog, seams.dashboard]) {
            await seam.start?.();
        }

        const factory = deps.createServer ?? ((h) => http.createServer(h));
        server = factory((req, res) => { handleRequest(req, res); });

        await new Promise((resolve, reject) => {
            const onError = (err) => {
                server.removeListener('listening', onListening);
                reject(err);
            };
            const onListening = () => {
                server.removeListener('error', onError);
                resolve();
            };
            server.once('error', onError);
            server.once('listening', onListening);
            server.listen(port);
        });

        // After bootstrap, a later server-level 'error' must not crash the
        // process; log and keep serving.
        server.on('error', (err) => logError('[supervisor] server error:', err));

        log(`[supervisor] listening on http://localhost:${port} (pid ${process.pid})`);
        return { port };
    }

    return {
        route,
        start,
        stop,
        handleRequest,
        get server() { return server; },
        seams,
        port,
        /** Resolves once the supervisor has fully shut down. */
        get shutdownRequested() { return shutdownRequested; },
    };
}
