// =============================================================================
// Auto-sprint supervisor -- live-detail reverse proxy (apra-fleet-eft.6.4,
// Plan Part 2.3)
// =============================================================================
//
// Serves each sprint's LIVE detail view at `/sprints/:id/live` on the SUPERVISOR
// port, reverse-proxied to that sprint's detached child viewer (the per-sprint
// dashboard the eft.4.2 spawner launched on its own `--viewer-port`). The child
// viewer serves `/` (HTML), `/events` (Server-Sent Events), `/state` (JSON), and
// `/stop`/`/save_logs` (POST) -- see packages/apra-fleet-workflow/src/viewer/
// index.mjs.
//
// WHY PROXY INSTEAD OF LINKING THE CHILD PORT DIRECTLY
// ----------------------------------------------------
// Bare child-port links (`http://host:8083/`) leak the supervisor's internal
// port allocation, break the moment the operator is on a different host, and
// would need a firewall hole punched per sprint. So the ONLY externally visible
// surface is the supervisor's own port, and every child endpoint is reached
// through the `/sprints/:id/live` path prefix. The child viewer's own client
// script calls its endpoints via absolute app-paths (`new EventSource('/events')`,
// `fetch('/state?...')`, `fetch('/stop')`); those are rewritten in the served
// HTML to the live prefix so the browser's follow-up requests re-enter this
// proxy rather than hitting the supervisor root (which has no such routes) or a
// bare child port. No child port ever appears in the served HTML.
//
// SSE PASSTHROUGH DISCIPLINE (acceptance criterion)
// -------------------------------------------------
// `/sprints/:id/live/events` streams the child's SSE feed with NO buffering and
// NO compression: `accept-encoding` is stripped upstream so the child never
// gzips a stream, hop-by-hop headers (incl. `transfer-encoding`) are dropped so
// we re-chunk cleanly, and every upstream data chunk is written straight to the
// client as it arrives (events reach the browser incrementally, never buffered
// to completion). A client disconnect (`res`/`req` 'close') destroys the
// upstream request, which the child observes as its own `req` closing and drops
// the SSE subscriber -- disconnect propagates end to end.
//
// HISTORY FALLTHROUGH (acceptance criterion)
// ------------------------------------------
// When a sprint has finished there is no live child to proxy to. Rather than
// 404 or serve a dead proxy, the SAME `/sprints/:id/live` URL falls through to a
// read-only historical view rendered from the sprint's persisted terminal state
// (old_sprints/<sprintId>.json). The full history rendering is eft.6.5's job, so
// the renderer is injectable (`renderHistory`); the default here reads the
// terminal-state file and renders a compact read-only page (no `/events`, no
// `/stop`) so the fallthrough is never a dead socket.
// =============================================================================

import http from 'node:http';
import fsp from 'node:fs/promises';
import { escapeHtml } from '@apralabs/apra-fleet-workflow/viewer/html-utils';
import { getOldSprintStatePath } from '@apralabs/apra-fleet-workflow/viewer/sprint-state-paths';

/** Hop-by-hop headers that must never be forwarded verbatim across a proxy. */
const HOP_BY_HOP = Object.freeze([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

/**
 * Supervisor-relative live-view path prefix for one sprint. Matches the link the
 * index dashboard renders (dashboard.mjs), so the rewritten child-endpoint URLs
 * line up exactly with the document URL the browser is viewing.
 * @param {string} sprintId
 * @returns {string}
 */
export function livePrefixFor(sprintId) {
    return '/sprints/' + encodeURIComponent(sprintId) + '/live';
}

/**
 * Rewrites the child viewer's served HTML so its absolute app-path client calls
 * re-enter this proxy under the live prefix. Targets the child's known call
 * sites verbatim (single-quoted literals in viewer/index.mjs): `'/events'`,
 * `'/state?`, `'/stop'`, `'/save_logs'`. String (not regex) replacement keeps it
 * unambiguous and metachar-safe.
 * @param {string} html
 * @param {string} prefix - e.g. `/sprints/my-sprint/live`
 * @returns {string}
 */
export function rewriteChildHtml(html, prefix) {
    if (typeof html !== 'string') return html;
    return html
        .split("'/events'").join("'" + prefix + "/events'")
        .split("'/state?").join("'" + prefix + "/state?")
        .split("'/stop'").join("'" + prefix + "/stop'")
        .split("'/save_logs'").join("'" + prefix + "/save_logs'");
}

/** Copy request headers for the upstream call, dropping host/encoding/hop-by-hop. */
function upstreamRequestHeaders(req) {
    const headers = { ...req.headers };
    delete headers.host;
    // SSE passthrough must stay uncompressed and unbuffered -- never let the
    // child gzip a stream we need to flush event-by-event.
    delete headers['accept-encoding'];
    for (const h of HOP_BY_HOP) delete headers[h];
    return headers;
}

/** Copy upstream response headers for the client, dropping encoding/hop-by-hop. */
function downstreamResponseHeaders(upstreamHeaders) {
    const out = { ...upstreamHeaders };
    delete out['content-encoding'];
    for (const h of HOP_BY_HOP) delete out[h];
    return out;
}

/** Writes a small text response with an explicit content-length. */
function sendPlain(res, status, text) {
    const body = Buffer.from(String(text), 'utf-8');
    res.writeHead(status, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': body.length,
    });
    res.end(body);
}

/**
 * Streams a child endpoint straight through to the client with no buffering.
 * Used for `/events` (SSE), `/state`, `/stop`, `/save_logs`. Each upstream chunk
 * is written to the client as it arrives; a client disconnect destroys the
 * upstream request so the child sees the subscription drop.
 */
function proxyStream({ host, port, childPath, req, res, logError }) {
    let settled = false;
    const upstream = http.request(
        { host, port, path: childPath, method: req.method || 'GET', headers: upstreamRequestHeaders(req) },
        (up) => {
            settled = true;
            res.writeHead(up.statusCode || 502, downstreamResponseHeaders(up.headers));
            // Flush headers immediately so an SSE client's connection opens
            // before the first event, not only once data starts flowing.
            if (typeof res.flushHeaders === 'function') res.flushHeaders();
            up.on('data', (chunk) => { res.write(chunk); });
            up.on('end', () => { try { res.end(); } catch { /* already gone */ } });
            up.on('error', (err) => {
                logError?.('[proxy] upstream response stream error:', err);
                try { res.end(); } catch { /* already gone */ }
            });
        },
    );
    upstream.on('error', (err) => {
        logError?.('[proxy] upstream connect error:', err);
        if (settled) { try { res.end(); } catch { /* gone */ } return; }
        settled = true;
        if (!res.headersSent) { try { res.writeHead(502); } catch { /* gone */ } }
        try { res.end(); } catch { /* gone */ }
    });
    // Propagate a client disconnect to the child so its SSE subscriber is
    // dropped. Only a PREMATURE close (client went away before we finished the
    // response) should abort the upstream -- the 'close' that fires on normal
    // completion must NOT, or it would tear down an already-finished request.
    res.on('close', () => {
        if (res.writableEnded) return;
        try { upstream.destroy(); } catch { /* gone */ }
    });
    // Forward any request body (POST /stop, /save_logs) then finish the request.
    req.pipe(upstream);
    return upstream;
}

/**
 * Proxies the child's `/` HTML, buffering it just long enough to rewrite the
 * client-endpoint URLs to the live prefix (the ONE endpoint that needs a body
 * transform -- everything else streams). A pre-response connection failure
 * invokes `onConnectError` so the base handler can fall through to history.
 */
function proxyHtml({ host, port, req, res, prefix, logError, onConnectError }) {
    let settled = false;
    const fail = (err) => {
        if (settled) return;
        settled = true;
        logError?.('[proxy] html upstream error:', err);
        if (onConnectError) { onConnectError(err); return; }
        if (!res.headersSent) { try { res.writeHead(502); } catch { /* gone */ } }
        try { res.end(); } catch { /* gone */ }
    };
    const upstream = http.request(
        { host, port, path: '/', method: 'GET', headers: upstreamRequestHeaders(req) },
        (up) => {
            const chunks = [];
            up.on('data', (c) => chunks.push(c));
            up.on('end', () => {
                if (settled) return;
                settled = true;
                const html = rewriteChildHtml(Buffer.concat(chunks).toString('utf-8'), prefix);
                const body = Buffer.from(html, 'utf-8');
                if (res.headersSent) { try { res.end(); } catch { /* gone */ } return; }
                res.writeHead(up.statusCode || 200, {
                    'content-type': 'text/html; charset=utf-8',
                    'content-length': body.length,
                });
                res.end(body);
            });
            up.on('error', fail);
        },
    );
    upstream.on('error', fail);
    res.on('close', () => { try { upstream.destroy(); } catch { /* gone */ } });
    upstream.end();
    return upstream;
}

/**
 * Default read-only historical view renderer. Reads the sprint's persisted
 * terminal state (old_sprints/<sprintId>.json) and renders a compact read-only
 * page. Returns `null` when no terminal state exists (caller answers 404).
 * eft.6.5 replaces this with the full History-view rendering; kept minimal here
 * so the fallthrough is never a dead proxy and never a 404 for a finished sprint.
 * @param {string} sprintId
 * @param {NodeJS.ProcessEnv} env
 * @param {(p: string, enc: string) => Promise<string>} [readFile]
 * @returns {Promise<string|null>}
 */
export async function defaultRenderHistory(sprintId, env, readFile) {
    const read = readFile ?? fsp.readFile;
    const filePath = getOldSprintStatePath(sprintId, env);
    let raw;
    try {
        raw = await read(filePath, 'utf-8');
    } catch (err) {
        if (err && err.code === 'ENOENT') return null;
        throw err;
    }
    let state = null;
    try { state = JSON.parse(raw); } catch { state = null; }
    return renderReadOnlyHistoryHtml(sprintId, state);
}

/**
 * Renders the compact read-only historical page for a finished sprint. Contains
 * NO `/events` (SSE) or `/stop` controls -- it is a static, process-free view,
 * so nothing here re-enters the proxy or targets a now-dead child port.
 * @param {string} sprintId
 * @param {object|null} state - parsed old_sprints/<sprintId>.json, if available
 * @returns {string}
 */
export function renderReadOnlyHistoryHtml(sprintId, state) {
    const id = escapeHtml(sprintId);
    const s = state && typeof state === 'object' ? state : {};
    const reason = s.terminalReason ? escapeHtml(String(s.terminalReason)) : 'unknown';
    const startedAt = s.startedAt ? escapeHtml(String(s.startedAt)) : 'unknown';
    const endedAt = s.endedAt ? escapeHtml(String(s.endedAt)) : 'unknown';
    const status = s.status ? escapeHtml(String(s.status)) : 'unknown';
    return (
        '<!DOCTYPE html>\n' +
        '<html lang="en">\n' +
        '<head>\n' +
        '<meta charset="utf-8"/>\n' +
        '<title>Sprint ' + id + ' -- historical (read-only)</title>\n' +
        '<style>body{background:#18181b;color:#e4e4e7;font-family:system-ui,sans-serif;margin:24px;}' +
        'a{color:#60a5fa;}.tag{color:#a1a1aa;}</style>\n' +
        '</head>\n' +
        '<body data-view="history" data-sprint-id="' + id + '">\n' +
        '<p><a href="/">&larr; Back to supervisor</a></p>\n' +
        '<h1>Sprint ' + id + '</h1>\n' +
        '<p><strong>Historical, read-only view.</strong> This sprint has finished; ' +
        'its live process is gone, so there is nothing to stream.</p>\n' +
        '<ul>\n' +
        '<li><span class="tag">Status:</span> ' + status + '</li>\n' +
        '<li><span class="tag">Terminal reason:</span> ' + reason + '</li>\n' +
        '<li><span class="tag">Started:</span> ' + startedAt + '</li>\n' +
        '<li><span class="tag">Ended:</span> ' + endedAt + '</li>\n' +
        '</ul>\n' +
        '</body>\n' +
        '</html>\n'
    );
}

/**
 * Create the live-view reverse proxy. Collaborators are injected so tests can
 * drive a fake child server and a fixed history renderer.
 *
 * @param {{
 *   ledger?: { get: (sprintId: string) => ({ childPid: number|null }|undefined) },
 *   spawner?: { getLiveEntry: (pid: number) => ({ port: number }|undefined) },
 *   resolvePort?: (sprintId: string) => number|undefined,
 *   renderHistory?: (sprintId: string) => Promise<string|null>|string|null,
 *   host?: string,
 *   env?: NodeJS.ProcessEnv,
 *   readFile?: (p: string, enc: string) => Promise<string>,
 *   logger?: { log?: Function, error?: Function },
 * }} [deps]
 * @returns {{
 *   name: string,
 *   resolvePort: (sprintId: string) => number|undefined,
 *   handleBase: Function,
 *   handleEvents: Function,
 *   handleState: Function,
 *   handleStop: Function,
 *   handleSaveLogs: Function,
 * }}
 */
export function createLiveProxy(deps = {}) {
    const ledger = deps.ledger ?? null;
    const spawner = deps.spawner ?? null;
    const host = deps.host ?? '127.0.0.1';
    const env = deps.env ?? process.env;
    const logger = deps.logger ?? console;
    const logError = (...a) => (logger.error ?? logger.log)?.(...a);

    // Default port resolution: sprintId -> ledger childPid -> spawner live port.
    // The ledger deliberately does NOT persist ports; the spawner is the live
    // pid->port bookkeeping (freshly spawned OR re-adopted across a restart), so
    // a finished/crashed child (no live entry) resolves to `undefined` and the
    // request falls through to history.
    function defaultResolvePort(sprintId) {
        if (!ledger || typeof ledger.get !== 'function') return undefined;
        const entry = ledger.get(sprintId);
        const pid = entry && entry.childPid;
        if (!Number.isInteger(pid)) return undefined;
        if (!spawner || typeof spawner.getLiveEntry !== 'function') return undefined;
        const live = spawner.getLiveEntry(pid);
        return live && Number.isInteger(live.port) ? live.port : undefined;
    }
    const resolvePort = deps.resolvePort ?? defaultResolvePort;

    const renderHistory = deps.renderHistory
        ?? ((sprintId) => defaultRenderHistory(sprintId, env, deps.readFile));

    /** Resolve a live port, isolating any injected-resolver failure as "no live". */
    function safeResolvePort(sprintId) {
        try {
            return resolvePort(sprintId);
        } catch (err) {
            logError('[proxy] resolvePort failed for', sprintId, err);
            return undefined;
        }
    }

    /** Render + send the read-only historical view; 404 when no history exists. */
    async function serveHistory(sprintId, res) {
        let html = null;
        try {
            html = await renderHistory(sprintId);
        } catch (err) {
            logError('[proxy] history render failed for', sprintId, err);
        }
        if (html == null) {
            sendPlain(res, 404, `No live sprint or history for '${sprintId}'.`);
            return;
        }
        const body = Buffer.from(html, 'utf-8');
        res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'content-length': body.length,
        });
        res.end(body);
    }

    // GET /sprints/:id/live -- the live HTML, or the history fallthrough.
    async function handleBase(req, res, ctx) {
        const sprintId = ctx?.params?.id;
        if (!sprintId) { sendPlain(res, 400, 'missing sprint id in path'); return; }
        const port = safeResolvePort(sprintId);
        if (!Number.isInteger(port)) {
            await serveHistory(sprintId, res);
            return;
        }
        proxyHtml({
            host, port, req, res,
            prefix: livePrefixFor(sprintId),
            logError,
            // A live entry existed but the child is unreachable (raced with exit):
            // fall through to history rather than serve a dead proxy.
            onConnectError: () => { serveHistory(sprintId, res).catch((e) => logError(e)); },
        });
    }

    // Subpath handlers proxy their fixed child endpoint. A request arriving after
    // the child is gone answers cleanly (no dead socket); the read-only history
    // page makes no such calls, so this only happens if a sprint ends mid-view.
    function makeSubpath(childPathFor) {
        return async (req, res, ctx) => {
            const sprintId = ctx?.params?.id;
            if (!sprintId) { sendPlain(res, 400, 'missing sprint id in path'); return; }
            const port = safeResolvePort(sprintId);
            if (!Number.isInteger(port)) {
                sendPlain(res, 404, `sprint '${sprintId}' is no longer live`);
                return;
            }
            proxyStream({ host, port, childPath: childPathFor(ctx?.url), req, res, logError });
        };
    }

    const handleEvents = makeSubpath(() => '/events');
    const handleState = makeSubpath((url) => '/state' + (url && url.search ? url.search : ''));
    const handleStop = makeSubpath(() => '/stop');
    const handleSaveLogs = makeSubpath(() => '/save_logs');

    return {
        name: 'live-proxy',
        resolvePort: safeResolvePort,
        serveHistory,
        handleBase,
        handleEvents,
        handleState,
        handleStop,
        handleSaveLogs,
    };
}

/**
 * Register the live-view routes against a supervisor (server.mjs), mirroring the
 * registration pattern of registerReservationRoutes()/registerDashboardRoutes().
 * @param {{ route: (method: string, path: string, handler: Function) => void }} supervisor
 * @param {ReturnType<typeof createLiveProxy>} proxy
 */
export function registerLiveRoutes(supervisor, proxy) {
    supervisor.route('GET', '/sprints/:id/live', proxy.handleBase);
    supervisor.route('GET', '/sprints/:id/live/events', proxy.handleEvents);
    supervisor.route('GET', '/sprints/:id/live/state', proxy.handleState);
    supervisor.route('POST', '/sprints/:id/live/stop', proxy.handleStop);
    supervisor.route('POST', '/sprints/:id/live/save_logs', proxy.handleSaveLogs);
}
