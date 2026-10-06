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
//
// -----------------------------------------------------------------------------
// API GUARD TOKEN: LIVE RE-RESOLUTION (apra-fleet-hwxd)
// -----------------------------------------------------------------------------
// The token guarding the /api surface may come from a PROVIDER
// (deps.resolveToken, e.g. a read-only resolveServiceToken(dataDir,
// { createIfMissing: false })) instead of being pinned at startup. A supervisor
// started before fleet.key existed boots on the private/token fallback; once
// fleet.key appears the provider starts answering with it, and the guard must
// follow without a restart (otherwise the console's /ext/se hop, which bears
// deriveUpstreamCredential(fleetKey, 'se'), 401s for the process lifetime).
//
// Re-resolution is lazy so the steady state costs no file read per request:
// the guard checks the CURRENT token first and only on a failed check
// re-resolves once and retries. The exported `token` getter also re-resolves,
// so the dashboard's token exchange / cookie derivation follows the same
// current token. A wrong credential is still 401 after the retry (fail closed).
//
// The PREVIOUS token after a switch: it stays accepted for a bounded grace
// window (deps.retiredTokenGraceMs, default RETIRED_TOKEN_GRACE_MS) and is
// dropped once that window passes. This keeps an already-connected client
// (a browser holding the old se_token cookie, a sprint child holding the old
// bearer in FLEET_SE_SERVICE_TOKEN) working mid-session, while never accepting
// the stale credential indefinitely once the key is the source. A further
// switch replaces the retired slot, so at most one previous token is honoured.
//
// No token value is ever logged: only the source name and file path.
// =============================================================================

import http from 'node:http';
import { toBeadsSummary } from './beads-identity.mjs';
import { loadOrCreateToken, isAuthorized, requiresAuth } from './auth.mjs';

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
 * Writes the 401 challenge for a guarded route the request did not carry the
 * service token for. A dedicated helper (rather than `sendJson` plus a
 * separate `res.setHeader` call) so the `WWW-Authenticate` header rides the
 * same single `writeHead` call `sendJson` uses -- a test double that only
 * implements `writeHead`/`end` (no `setHeader`) still works.
 * @param {import('http').ServerResponse} res
 */
function sendUnauthorized(res) {
    const body = JSON.stringify({ error: 'unauthorized' });
    res.writeHead(401, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'www-authenticate': 'Bearer',
    });
    res.end(body);
}

/**
 * apra-fleet-hwxd: how long the PREVIOUS api guard token stays accepted after
 * the token provider switches to a new one (see the header section "API GUARD
 * TOKEN: LIVE RE-RESOLUTION"). Bounded so a stale credential is never honoured
 * indefinitely; long enough to cover a typical browser session or sprint run.
 */
/**
 * apra-fleet-ky2l.25: logged once by createSupervisor() when it is given no
 * token source at all, so an entry point that forgets the dep is visible.
 */
export const NO_TOKEN_SOURCE_WARNING = '[supervisor] WARNING: no service token source configured '
    + '(deps.token, deps.resolveToken or deps.dataDir) -- the /api auth guard is DISABLED';

export const RETIRED_TOKEN_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Creates (but does not start) the always-on supervisor. Returns a handle whose
 * `start()`/`stop()` own the full lifecycle; `route()` lets later tasks register
 * additional endpoints against the same error-isolated dispatcher.
 *
 * @param {{
 *   port?: number,
 *   bind?: string,
 *   token?: string,
 *   resolveToken?: () => ({ token: string, source?: string, path?: string }|null),
 *   retiredTokenGraceMs?: number,
 *   nowMs?: () => number,
 *   dataDir?: string,
 *   ledger?: object,
 *   spawner?: object,
 *   watchdog?: object,
 *   dashboard?: object,
 *   beadsIdentity?: { get: () => object|null, refresh: () => Promise<object> },
 *   project?: { projectDir: string, source: string },
 *   toolchain?: object,
 *   backlogMember?: { get: () => { member: object|null, status: string, reason: string|null } },
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
    let port = Number.isInteger(deps.port) ? deps.port : DEFAULT_SERVICE_PORT;
    // apra-fleet-50j6.1.2: loopback-only bind. `bind` is a deps-level seam
    // for tests, not a CLI flag -- production (bin/serve.mjs) never overrides
    // it, so the supervisor is unreachable from any non-loopback interface.
    const bindHost = typeof deps.bind === 'string' && deps.bind.length > 0 ? deps.bind : '127.0.0.1';
    const logger = deps.logger ?? console;
    const log = (...a) => logger.log?.(...a);
    const logError = (...a) => (logger.error ?? logger.log)?.(...a);
    // Optional beads-identity handle (bin/serve.mjs wires the real one);
    // read by GET /api/health below. Not a seam: it has no start()/stop().
    const beadsIdentity = deps.beadsIdentity && typeof deps.beadsIdentity.get === 'function' ? deps.beadsIdentity : null;
    // The beads-identity warning (getWarning() is optional on the handle so
    // an older/test-only { get, refresh } stub still works). Deliberately NOT
    // gated on `!h.get()` any more: an identity that RESOLVED can still be
    // incomplete (missing prefix / sync.remote / git origin), which is fatal
    // to every sprint launched against it, and suppressing the warning purely
    // because a record exists made Health read healthy right up to the first
    // failed launch. The handle decides whether there is anything to say.
    const beadsWarningOf = (h) => (h && typeof h.getWarning === 'function' ? (h.getWarning() || null) : null);
    // apra-fleet-i9ag.19.12: the GET /api/health-facing projection of the
    // startup toolchain report (see the `deps.toolchain` comment below) --
    // `null` when this supervisor holds no report at all (no toolchain dep
    // wired: the inert skeleton, or any test that does not pass one). This is
    // deliberately NOT the raw report object: it omits `configured`/`reason`/
    // `nodeOk`/`bdOk`/`fixLine` (internal-only fields this task's own FILES
    // list never asked Health to expose) and keeps exactly the shape the
    // acceptance criteria names -- { nodePath, nodeVersion, bdPath, bdVersion,
    // source, ok, problems }.
    const toolchainSummaryOf = (tc) => (tc ? {
        nodePath: tc.nodePath,
        nodeVersion: tc.nodeVersion,
        bdPath: tc.bdPath,
        bdVersion: tc.bdVersion,
        source: tc.source,
        ok: tc.ok,
        problems: tc.problems,
    } : null);
    // The SAME sentence and fix line bin/serve.mjs's own startup ERROR line
    // printed for a broken recorded node (`${problems.join(' ')} ${fixLine}`)
    // -- reusing the report's OWN `problems`/`fixLine` fields (never a second,
    // hand-copied literal here), so Health and the startup log can never say
    // two different things about the same failure. Gated on `!ok` exactly
    // like that ERROR line was: `ok` tracks NODE health only
    // (toolchain.mjs's own contract), the one condition serious enough to
    // hard-fail a launch (503) and therefore the one this key exists to
    // surface to an operator who just hit that 503 with no service-log access.
    const toolchainWarningOf = (tc) => (
        tc && tc.ok === false ? [...(tc.problems ?? []), tc.fixLine].filter(Boolean).join(' ') : null
    );
    // The resolved project folder and WHICH of the three sources won it
    // (flag / config / walk-up -- see resolveProjectDir() in
    // ./beads-identity.mjs). Reported on GET /api/health so the console and
    // the operator can both see which project this supervisor actually
    // adopted, including when the answer came from a persisted setting they
    // cannot see in the process's command line. Absent (null) for the inert
    // skeleton and for tests that wire no project dep.
    const project = deps.project && typeof deps.project.projectDir === 'string' ? deps.project : null;
    // apra-fleet-i9ag.19.10: the recorded-toolchain validation report
    // bin/serve.mjs produced ONCE at startup (./toolchain.mjs's
    // validateRecordedToolchain() result: { configured, nodePath, nodeVersion,
    // bdPath, bdVersion, source, reason, ok, nodeOk, bdOk, problems, fixLine }).
    // Held here -- in the same scope GET /api/health below already reads
    // `beadsIdentity`/`project` from -- so the health handler can report it
    // without re-probing node and bd per request, and also exposed on the
    // returned handle (see `get toolchain()` at the bottom of this function).
    // Not a seam: no start()/stop(), and no route reads it YET -- the health
    // payload/dashboard surfacing is apra-fleet-i9ag.19.12's job, whose whole
    // input is this value being available. `null` for the inert skeleton and
    // for every test that wires no toolchain dep.
    const toolchain = deps.toolchain && typeof deps.toolchain === 'object' ? deps.toolchain : null;

    // The shared bearer service token guarding the `/api/` surface and the
    // live-sprint mutating routes (see auth.mjs's requiresAuth). Either
    // supplied directly (deps.token) or loaded/minted from deps.dataDir via
    // auth.mjs's loadOrCreateToken. If NEITHER is supplied, `token` stays
    // null and the per-request guard below is skipped entirely (never
    // fails closed against a token that was never configured) -- this is
    // deliberate back-compat for the many existing unit tests that build a
    // supervisor with no auth concept at all and call handleRequest()
    // directly with header-less mock requests.
    //
    // apra-fleet-hwxd: deps.resolveToken is a token PROVIDER (returns
    // { token, source?, path? } or null) re-consulted lazily -- see the
    // "API GUARD TOKEN: LIVE RE-RESOLUTION" header section. Supplying it
    // (even when its first answer is null) turns the guard ON: with no
    // current token every guarded request fails closed.
    const resolveTokenDep = typeof deps.resolveToken === 'function' ? deps.resolveToken : null;
    const nowMs = typeof deps.nowMs === 'function' ? deps.nowMs : () => Date.now();
    const retiredTokenGraceMs = Number.isFinite(deps.retiredTokenGraceMs) && deps.retiredTokenGraceMs >= 0
        ? deps.retiredTokenGraceMs
        : RETIRED_TOKEN_GRACE_MS;
    const readProvider = () => {
        let r;
        try {
            r = resolveTokenDep();
        } catch (err) {
            // Never the token: only the failure message.
            logError(`[supervisor] api guard token re-resolution failed: ${err && err.message ? err.message : String(err)}`);
            return null;
        }
        return r && typeof r.token === 'string' && r.token.length > 0 ? r : null;
    };
    let token = typeof deps.token === 'string' && deps.token.length > 0 ? deps.token : null;
    if (!token && resolveTokenDep) {
        token = readProvider()?.token ?? null;
    }
    if (!token && typeof deps.dataDir === 'string' && deps.dataDir.length > 0) {
        token = loadOrCreateToken(deps.dataDir).token;
    }
    const guardEnabled = token !== null || resolveTokenDep !== null;
    // apra-fleet-ky2l.25: with no token source at all (no deps.token, no
    // deps.resolveToken provider, no deps.dataDir) the whole /api surface is
    // served unauthenticated. Kept for header-less unit tests, but never
    // silently: exactly one loud line through the injected logger. Names
    // the missing sources only -- there is no token value to leak.
    if (!guardEnabled) {
        logError(NO_TOKEN_SOURCE_WARNING);
    }
    // { token, until } -- the previous token after a switch, honoured until
    // `until` (epoch ms). See the header section for the policy.
    let retired = null;
    /**
     * Re-consult the provider; adopt its answer when it differs from the
     * current token. @returns {boolean} true when the token changed.
     */
    function refreshToken() {
        if (!resolveTokenDep) return false;
        const r = readProvider();
        if (!r || r.token === token) return false;
        retired = token ? { token, until: nowMs() + retiredTokenGraceMs } : null;
        token = r.token;
        log(`[supervisor] api guard token source is now ${r.source ?? 'provider'}${r.path ? ` (${r.path})` : ''}`);
        return true;
    }
    /** Does this request carry the current (or a still-in-grace retired) token? */
    function authorizeRequest(req) {
        if (token && isAuthorized(req, token)) return true;
        if (refreshToken() && isAuthorized(req, token)) return true;
        if (retired) {
            if (nowMs() < retired.until) {
                if (isAuthorized(req, retired.token)) return true;
            } else {
                retired = null;
            }
        }
        return false;
    }
    // Optional backlog-member state handle (src/supervisor/backlog-member.mjs,
    // wired by bin/serve.mjs); surfaced on GET /api/health as `backlogMember`
    // only when wired, so an unwired health answer is unchanged.
    const backlogMember = deps.backlogMember && typeof deps.backlogMember.get === 'function' ? deps.backlogMember : null;
    const backlogMemberSummary = () => {
        const st = backlogMember.get();
        return { status: st.status, name: st.member ? st.member.name : null, reason: st.reason ?? null };
    };

    // Module seams -- inert stubs unless a real collaborator was injected.
    const seams = {
        ledger: deps.ledger ?? makeSeamStub('ledger'),
        spawner: deps.spawner ?? makeSeamStub('spawner'),
        watchdog: deps.watchdog ?? makeSeamStub('watchdog'),
        dashboard: deps.dashboard ?? makeSeamStub('dashboard'),
        // apra-fleet-eft.9.2/9.3: the cross-sprint coordination seams -- the
        // global dolt push mutex (serializes every cross-sprint `bd dolt push`)
        // and the child-id allocator (serial-per-parent id minting). Both are
        // supervisor-owned singletons whose start()/stop() lifecycle (lease
        // sweep timers, state persistence) is driven by the same seam machinery
        // as every other collaborator; their HTTP routes are registered by
        // their own register*Routes() helpers (see bin/serve.mjs).
        doltMutex: deps.doltMutex ?? makeSeamStub('doltMutex'),
        idAllocator: deps.idAllocator ?? makeSeamStub('idAllocator'),
        // docs/dolt-sync-redesign.md Part 3.3: the backstop for the one case
        // settle's own try/finally teardown cannot cover -- an orchestrator
        // process killed mid-settle, leaving a detached ephemeral
        // `dolt sql-server` holding a member's beads data-dir lock.
        doltOrphanSweep: deps.doltOrphanSweep ?? makeSeamStub('doltOrphanSweep'),
    };

    /** @type {Map<string, Function>} keyed by `METHOD path` (exact paths). */
    const routes = new Map();
    const routeKey = (method, path) => `${method.toUpperCase()} ${path}`;

    // Pattern routes carry `:param` segments (e.g. /api/reservations/:sprintId/
    // force-release). They are kept separate from the exact-match Map and only
    // consulted when an exact match misses, so existing exact routes are
    // unaffected. Each `:name` segment matches exactly one non-empty path
    // segment and is surfaced to the handler via ctx.params.
    /** @type {Array<{ method: string, regex: RegExp, paramNames: string[], handler: Function }>} */
    const patternRoutes = [];

    function compilePattern(method, path) {
        const paramNames = [];
        const source = path.split('/').map((seg) => {
            if (seg.startsWith(':')) {
                paramNames.push(seg.slice(1));
                return '([^/]+)';
            }
            // Escape regex metacharacters in literal segments.
            return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }).join('/');
        return { method: method.toUpperCase(), regex: new RegExp(`^${source}$`), paramNames };
    }

    function route(method, path, handler) {
        if (path.includes('/:')) {
            const { method: m, regex, paramNames } = compilePattern(method, path);
            patternRoutes.push({ method: m, regex, paramNames, handler });
            return;
        }
        routes.set(routeKey(method, path), handler);
    }

    function matchPattern(method, path) {
        for (const pr of patternRoutes) {
            if (pr.method !== method) continue;
            const m = pr.regex.exec(path);
            if (!m) continue;
            const params = {};
            pr.paramNames.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
            return { handler: pr.handler, params };
        }
        return null;
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
            // apra-fleet-50j6.1.2: 401 before any route dispatch when this
            // route requires auth and the request does not carry the
            // service token. Runs first so a guarded mutating route (e.g.
            // POST /sprints/:id/live/stop) never reaches its handler/proxy
            // call at all on an unauthorized request.
            if (guardEnabled && requiresAuth(method, path) && !authorizeRequest(req)) {
                sendUnauthorized(res);
                return;
            }
            const handler = routes.get(routeKey(method, path));
            if (handler) {
                await handler(req, res, { url, params: {} });
                return;
            }
            const matched = matchPattern(method, path);
            if (!matched) {
                sendJson(res, 404, { error: `no route for ${method} ${path}` });
                return;
            }
            await matched.handler(req, res, { url, params: matched.params });
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
    //
    // `beads` is the .beads identity this process resolved at startup
    // (src/supervisor/beads-identity.mjs; { dir, prefix, syncRemote,
    // repoRemote }, or null when no beadsIdentity dep was wired -- tests,
    // the inert skeleton -- or when the identity is UNKNOWN: no .beads was
    // found, or its probe failed; then `beadsWarning` carries the reason
    // and the fix). `beadsWarning` is also present alongside a NON-null
    // `beads` when the identity resolved but is INCOMPLETE -- a missing
    // prefix / sync.remote / git origin is fatal to every sprint launched
    // against it. `?refresh=1` re-runs the probes first; a probe failure
    // keeps the last good identity and is reported as `beadsRefreshError`
    // rather than failing the liveness answer.
    route('GET', '/api/health', async (req, res, ctx) => {
        let beadsRefreshError;
        const refresh = ctx && ctx.url ? ctx.url.searchParams.get('refresh') : null;
        if (beadsIdentity && refresh && refresh !== '0' && refresh !== 'false') {
            try {
                await beadsIdentity.refresh();
            } catch (err) {
                beadsRefreshError = err && err.message ? err.message : String(err);
                logError('[supervisor] beads identity refresh failed:', beadsRefreshError);
            }
        }
        sendJson(res, 200, {
            status: 'ok',
            uptimeSeconds: Math.round(process.uptime()),
            pid: process.pid,
            seams: Object.fromEntries(
                Object.entries(seams).map(([k, v]) => [k, v.name ?? 'wired']),
            ),
            beads: beadsIdentity ? toBeadsSummary(beadsIdentity.get()) : null,
            // An ADDITION alongside `beads`/`beadsWarning`, not a rename:
            // `beads` stays the resolved tracker identity (null when unknown),
            // while these two say which FOLDER was adopted and how it was
            // chosen -- a supervisor can have a project folder but no usable
            // beads in it, and the pair has to be able to say exactly that.
            projectDir: project ? project.projectDir : null,
            projectDirSource: project ? project.source : null,
            ...(beadsWarningOf(beadsIdentity) ? { beadsWarning: beadsWarningOf(beadsIdentity) } : {}),
            ...(beadsRefreshError !== undefined ? { beadsRefreshError } : {}),
            // apra-fleet-i9ag.19.12: an ADDITION alongside `beads`/`projectDir`/
            // `projectDirSource` above, never a rename -- `null` when this
            // supervisor holds no startup toolchain report at all (see
            // `deps.toolchain`'s own doc comment). `toolchainWarning` is
            // OMITTED (not present as `null`) whenever there is nothing to
            // warn about, matching `beadsWarning`'s own omit-not-null contract
            // just above.
            toolchain: toolchainSummaryOf(toolchain),
            ...(toolchainWarningOf(toolchain) ? { toolchainWarning: toolchainWarningOf(toolchain) } : {}),
            ...(backlogMember ? { backlogMember: backlogMemberSummary() } : {}),
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
            for (const seam of [seams.doltOrphanSweep, seams.idAllocator, seams.doltMutex, seams.dashboard, seams.watchdog, seams.spawner, seams.ledger]) {
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
        for (const seam of [seams.ledger, seams.spawner, seams.watchdog, seams.dashboard, seams.doltMutex, seams.idAllocator, seams.doltOrphanSweep]) {
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
            server.listen(port, bindHost);
        });

        // port:0 asks the OS to pick a free port; reflect the port it
        // actually bound so callers (and the returned/getter `port` below)
        // see the real value instead of the literal 0 they requested.
        const bound = server.address();
        if (bound && typeof bound === 'object' && Number.isInteger(bound.port)) {
            port = bound.port;
        }

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
        get port() { return port; },
        // apra-fleet-50j6.2.2: exposes the SAME token the per-request guard
        // above checks requests against, so a route handler (dashboard.mjs's
        // GET / cookie-setter) can hand it back out to a trusted, loopback-
        // only client without a second source of truth. `null` when auth was
        // never configured (see the deps.token/deps.dataDir comment above).
        // apra-fleet-hwxd: re-resolves through deps.resolveToken (when wired)
        // so the getter always answers the CURRENT token.
        get token() { refreshToken(); return token; },
        // apra-fleet-i9ag.19.10: the startup recorded-toolchain validation
        // report (see the deps.toolchain comment above), or null when none was
        // wired -- read by apra-fleet-i9ag.19.12's health/dashboard surfacing.
        get toolchain() { return toolchain; },
        /** Resolves once the supervisor has fully shut down. */
        get shutdownRequested() { return shutdownRequested; },
    };
}
