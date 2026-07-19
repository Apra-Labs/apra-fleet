// =============================================================================
// Auto-sprint supervisor -- process-free History view (apra-fleet-eft.6.5)
// =============================================================================
//
// Renders a finished sprint's persisted terminal state
// (<serviceDataDir>/old_sprints/<sprintId>.json, apra-fleet-eft.2.3) using the
// SAME HTML template the live viewer serves (@apralabs/apra-fleet-workflow's
// viewer/index.mjs HTML_TEMPLATE), fed a FROZEN state object instead of the
// live view's fetch('/state') + EventSource('/events') polling loop. A
// finished sprint has zero running processes, so the page it serves issues
// zero outbound network requests, and Save/Stop (nothing left to save/stop)
// are omitted entirely -- see HTML_TEMPLATE's `opts.history` mode.
//
// This is a SEPARATE surface from the /sprints/:id/live reverse proxy's
// history fallthrough (eft.6.4, src/supervisor/proxy.mjs): that route's
// default renderer is a deliberately minimal compact page so a racing
// live->finished transition is never a dead proxy; this route
// (`GET /sprints/:id/history`) is the operator-facing "History" link and
// always renders the full template, unconditionally, straight from
// old_sprints/.
//
// PATH-TRAVERSAL DISCIPLINE (acceptance criterion)
// -------------------------------------------------
// A sprintId is an opaque identifier (a stable per-sprint id/UUID -- see
// sprint-state-paths.mjs), never a path fragment. Any `:id` value containing
// a path separator or a bare '.'/'..' segment is rejected outright, and the
// resolved file path is verified (defense in depth) to still land directly
// inside old_sprints/ before anything ever touches disk -- the renderer reads
// ONLY from the service data dir's old_sprints/, never an arbitrary repo
// checkout path.
// =============================================================================

import fsp from 'node:fs/promises';
import path from 'node:path';
import { HTML_TEMPLATE } from '@apralabs/apra-fleet-workflow/viewer';
import { getOldSprintsDir, getOldSprintStatePath } from '@apralabs/apra-fleet-workflow/viewer/sprint-state-paths';

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
 * True iff `sprintId` is a bare, single path segment -- never a path
 * fragment. sprintIds are opaque identifiers (a stable per-sprint id/UUID),
 * so a path separator or a '.'/'..' segment can only be a path-traversal
 * attempt against old_sprints/.
 * @param {unknown} sprintId
 * @returns {boolean}
 */
export function isSafeSprintId(sprintId) {
    if (typeof sprintId !== 'string' || sprintId.length === 0) return false;
    if (sprintId === '.' || sprintId === '..') return false;
    if (sprintId.includes('/') || sprintId.includes('\\')) return false;
    return true;
}

/**
 * Resolves a sprintId to its old_sprints/<sprintId>.json path. Throws
 * RangeError for an unsafe sprintId, or for the (should-be-impossible once
 * isSafeSprintId has passed) case where the resolved path still lands outside
 * old_sprints/ -- defense in depth, never trusting a single check alone.
 * @param {string} sprintId
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function resolveOldSprintPath(sprintId, env) {
    if (!isSafeSprintId(sprintId)) {
        throw new RangeError(`refusing to resolve unsafe sprint id: ${JSON.stringify(sprintId)}`);
    }
    const filePath = getOldSprintStatePath(sprintId, env);
    const dir = path.resolve(getOldSprintsDir(env));
    if (path.dirname(path.resolve(filePath)) !== dir) {
        throw new RangeError(`resolved path for sprint id '${sprintId}' escapes old_sprints/`);
    }
    return filePath;
}

/**
 * Loads and parses a finished sprint's persisted terminal state from
 * old_sprints/<sprintId>.json. Returns `null` when no such file exists (the
 * caller answers 404) or its content isn't valid JSON; throws only for a
 * rejected (unsafe) sprintId or a genuine I/O failure other than ENOENT.
 * @param {string} sprintId
 * @param {NodeJS.ProcessEnv} [env]
 * @param {(p: string, enc: string) => Promise<string>} [readFile]
 * @returns {Promise<object|null>}
 */
export async function loadOldSprintState(sprintId, env = process.env, readFile) {
    const read = readFile ?? fsp.readFile;
    const filePath = resolveOldSprintPath(sprintId, env);
    let raw;
    try {
        raw = await read(filePath, 'utf-8');
    } catch (err) {
        if (err && err.code === 'ENOENT') return null;
        throw err;
    }
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

/**
 * Renders the process-free History view for one finished sprint: the SAME
 * HTML_TEMPLATE the live viewer serves, fed the frozen state object directly
 * -- no /events or /state polling, Save/Stop omitted (HTML_TEMPLATE's
 * `opts.history` mode, apra-fleet-eft.6.5).
 * @param {object} state - parsed old_sprints/<sprintId>.json
 * @param {Array} [dashboardExtensions]
 * @returns {string}
 */
export function renderHistoryPageHtml(state, dashboardExtensions = []) {
    return HTML_TEMPLATE(dashboardExtensions, { history: true, state });
}

/**
 * Create the History view seam. Collaborators injected so tests can drive a
 * temp dir / fake fs without touching the real service data dir.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   readFile?: (p: string, enc: string) => Promise<string>,
 *   dashboardExtensions?: Array,
 *   logger?: { log?: Function, error?: Function },
 * }} [deps]
 * @returns {{
 *   name: string,
 *   start(): Promise<void>,
 *   stop(): Promise<void>,
 *   handleGet: Function,
 *   renderForSprint: (sprintId: string) => Promise<string|null>,
 * }}
 */
export function createHistoryView(deps = {}) {
    const env = deps.env ?? process.env;
    const readFile = deps.readFile;
    const dashboardExtensions = deps.dashboardExtensions ?? [];
    const logger = deps.logger ?? console;
    const logError = (...a) => (logger.error ?? logger.log)?.(...a);

    /**
     * Renders one sprint's History page, or `null` when it has no persisted
     * old_sprints/ state (caller answers 404). Throws for an unsafe sprintId
     * -- callers that want a rejection instead of a thrown error (this
     * module's own `handleGet` below) check `isSafeSprintId()` themselves
     * first; the live-proxy's `renderHistory` seam (src/supervisor/proxy.mjs)
     * already treats a throwing renderer as "no history" and answers 404,
     * which is itself a rejection of the path-traversal attempt.
     * @param {string} sprintId
     * @returns {Promise<string|null>}
     */
    async function renderForSprint(sprintId) {
        const state = await loadOldSprintState(sprintId, env, readFile);
        if (state == null) return null;
        return renderHistoryPageHtml(state, dashboardExtensions);
    }

    // GET /sprints/:id/history -- the dedicated "History" link (apra-fleet-eft.6,
    // Plan Part 2.3): always renders from old_sprints/, regardless of whether
    // the sprint is (still) live. Never proxies, never touches a live child
    // port. This is a SEPARATE surface from /sprints/:id/live's history
    // fallthrough (eft.6.4, proxy.mjs) -- both call the same `renderForSprint`
    // rendering logic (bin/serve.mjs wires this seam's `renderForSprint` in as
    // the live proxy's `renderHistory` collaborator too), so the SAME template
    // serves live and history no matter which URL an operator followed.
    async function handleGet(req, res, ctx) {
        const sprintId = ctx?.params?.id;
        if (!sprintId) { sendPlain(res, 400, 'missing sprint id in path'); return; }
        if (!isSafeSprintId(sprintId)) {
            sendPlain(res, 400, `invalid sprint id: ${sprintId}`);
            return;
        }
        let html;
        try {
            html = await renderForSprint(sprintId);
        } catch (err) {
            logError('[history-view] failed to load state for', sprintId, err);
            sendPlain(res, 400, `invalid sprint id: ${sprintId}`);
            return;
        }
        if (html == null) {
            sendPlain(res, 404, `No history for '${sprintId}'.`);
            return;
        }
        const body = Buffer.from(html, 'utf-8');
        res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'content-length': body.length,
        });
        res.end(body);
    }

    return {
        name: 'history-view',
        async start() {},
        async stop() {},
        handleGet,
        renderForSprint,
    };
}

/**
 * Registers `GET /sprints/:id/history` against a supervisor (server.mjs),
 * mirroring the registration pattern of registerLiveRoutes()/
 * registerDashboardRoutes().
 * @param {{ route: (method: string, path: string, handler: Function) => void }} supervisor
 * @param {ReturnType<typeof createHistoryView>} view
 */
export function registerHistoryViewRoutes(supervisor, view) {
    supervisor.route('GET', '/sprints/:id/history', view.handleGet);
}
