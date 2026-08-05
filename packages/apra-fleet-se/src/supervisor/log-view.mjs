// =============================================================================
// Auto-sprint supervisor -- raw per-sprint log serving (apra-fleet-ou7.2)
// =============================================================================
//
// Serves `GET /sprints/:id/log`: the raw stdout/stderr file the spawner tees
// a sprint child's process output to for its whole lifetime (apra-fleet-
// ou7.1, spawner.mjs's resolveSprintLogPath()). This is the ONE remaining
// way to see what a sprint's child actually printed once it is CRASHED or
// FINISHED -- exactly where the live SSE viewer (src/supervisor/proxy.mjs)
// is gone, since that proxy only reaches a still-running child's port.
//
// PATH-TRAVERSAL DISCIPLINE (acceptance criterion)
// -------------------------------------------------
// A sprint's logPath is a STORED value, recorded once at claim() time by the
// SAME resolveSprintLogPath() call that already sanitizes its runId
// component against traversal (spawner.mjs's own doc comment: no '/', '\\',
// or '..' can survive that sanitization). This route looks a sprint's
// logPath up by `:id` as a pure MAP KEY -- `ledger.get(id).logPath`, falling
// back to the durable history log's own recorded logPath for a sprint whose
// reservation has since been released -- `:id` is NEVER concatenated into a
// filesystem path here. A path-traversal payload in `:id` can, at most, fail
// to match any reservation/history entry and 404; it can never reach outside
// the logs/ directory. `isSafeSprintId()` (reused from history-view.mjs,
// never reimplemented) is still applied first, purely for defense in depth
// and to answer an obviously-malformed id with a clean 400 instead of a
// silent 404.
// =============================================================================

import fsp from 'node:fs/promises';
import { isSafeSprintId, sendPlain } from './history-view.mjs';

/**
 * Resolve a sprint's recorded raw log file path: the live/still-reserved
 * ledger entry first (covers a running sprint AND any ended sprint whose
 * reservation has not yet been released -- the common case, since finishing
 * does not itself release a reservation), falling back to the durable
 * history log's most recent recorded logPath for a sprint whose reservation
 * HAS since been released (apra-fleet-eft.5.4 restart-abort, or an operator
 * force-release). Returns `null` when neither source has one -- a sprint
 * launched before apra-fleet-ou7.1 shipped never recorded a logPath at all.
 * @param {{ ledger: { get: (id: string) => { logPath?: string|null }|undefined }, history?: { forSprint: (id: string) => Array<{ logPath?: string|null }> } }} deps
 * @param {string} sprintId
 * @returns {string|null}
 */
export function resolveLogPath({ ledger, history }, sprintId) {
    const reservation = ledger.get(sprintId);
    if (reservation && reservation.logPath) return reservation.logPath;
    if (history && typeof history.forSprint === 'function') {
        const events = history.forSprint(sprintId);
        for (let i = events.length - 1; i >= 0; i--) {
            if (events[i].logPath) return events[i].logPath;
        }
    }
    return null;
}

/**
 * Returns the last `lineCount` non-empty-file lines of `text` (newline-
 * delimited), preserving order. `lineCount` <= 0 or non-integer returns
 * `text` unchanged (full file) -- callers only pass a validated positive
 * integer here in practice (see `handleGet`'s `?tail=` parsing), but this
 * stays defensive on its own.
 * @param {string} text
 * @param {number} lineCount
 * @returns {string}
 */
export function tailLines(text, lineCount) {
    if (!Number.isInteger(lineCount) || lineCount <= 0) return text;
    // A log file's own trailing newline would otherwise count as one more
    // (empty) "line" and get picked instead of real content -- strip it
    // before splitting, then restore it on the result, matching the ordinary
    // POSIX tail command's own line-count behavior.
    const hadTrailingNewline = text.endsWith('\n');
    const body = hadTrailingNewline ? text.slice(0, -1) : text;
    const lines = body.split('\n');
    const picked = lines.slice(Math.max(0, lines.length - lineCount)).join('\n');
    return hadTrailingNewline ? `${picked}\n` : picked;
}

/**
 * Create the raw-log view seam. Collaborators injected so tests can drive a
 * fake ledger/history/fs without touching the real service data dir.
 *
 * @param {{
 *   ledger: { get: (id: string) => { logPath?: string|null }|undefined },
 *   history?: { forSprint: (id: string) => Array<object> },
 *   readFile?: (p: string, enc: string) => Promise<string>,
 *   logger?: { log?: Function, error?: Function },
 * }} [deps]
 * @returns {{
 *   name: string,
 *   start(): Promise<void>,
 *   stop(): Promise<void>,
 *   handleGet: Function,
 *   resolveLogPath: (sprintId: string) => string|null,
 * }}
 */
export function createLogView(deps = {}) {
    const ledger = deps.ledger;
    if (!ledger || typeof ledger.get !== 'function') {
        throw new TypeError('createLogView requires a ledger with a get() method');
    }
    const history = deps.history ?? null;
    const readFile = deps.readFile ?? fsp.readFile;
    const logger = deps.logger ?? console;
    const logError = (...a) => (logger.error ?? logger.log)?.(...a);

    // GET /sprints/:id/log -- the raw per-sprint log file, present whether the
    // sprint is still live, CRASHED, or FINISHED (apra-fleet-ou7.2, Plan Part
    // 2.3). Optional `?tail=<N>` returns only the last N lines instead of the
    // full file; no other streaming/tailing UI (per the bead's own scope note).
    async function handleGet(req, res, ctx) {
        const sprintId = ctx?.params?.id;
        if (!sprintId) { sendPlain(res, 400, 'missing sprint id in path'); return; }
        if (!isSafeSprintId(sprintId)) {
            sendPlain(res, 400, `invalid sprint id: ${sprintId}`);
            return;
        }
        const logPath = resolveLogPath({ ledger, history }, sprintId);
        if (!logPath) {
            sendPlain(res, 404, `No log recorded for sprint '${sprintId}' (a sprint launched before apra-fleet-ou7.1 shipped never recorded one).`);
            return;
        }
        let content;
        try {
            content = await readFile(logPath, 'utf-8');
        } catch (err) {
            if (err && err.code === 'ENOENT') {
                sendPlain(res, 404, `Log file for sprint '${sprintId}' is recorded but missing on disk.`);
                return;
            }
            logError(`[log-view] failed to read log for '${sprintId}':`, err);
            sendPlain(res, 500, `failed to read log for sprint '${sprintId}'`);
            return;
        }
        const tailParam = ctx?.url?.searchParams?.get('tail');
        const tailN = tailParam != null ? Number(tailParam) : NaN;
        const body = Number.isInteger(tailN) && tailN > 0 ? tailLines(content, tailN) : content;
        sendPlain(res, 200, body);
    }

    return {
        name: 'log-view',
        async start() {},
        async stop() {},
        handleGet,
        resolveLogPath: (sprintId) => resolveLogPath({ ledger, history }, sprintId),
    };
}

/**
 * Registers `GET /sprints/:id/log` against a supervisor (server.mjs),
 * mirroring registerHistoryViewRoutes()'s registration pattern.
 * @param {{ route: (method: string, path: string, handler: Function) => void }} supervisor
 * @param {ReturnType<typeof createLogView>} view
 */
export function registerLogViewRoutes(supervisor, view) {
    supervisor.route('GET', '/sprints/:id/log', view.handleGet);
}
