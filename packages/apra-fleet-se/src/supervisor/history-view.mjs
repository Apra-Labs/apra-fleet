// =============================================================================
// Auto-sprint supervisor -- process-free History view (apra-fleet-eft.6.5)
// =============================================================================
//
// Renders a finished sprint's persisted terminal state
// (<serviceDataDir>/old_runs/<sprintId>.json, apra-fleet-eft.2.3; falling
// back to the legacy <serviceDataDir>/old_sprints/<sprintId>.json for sprints
// that finished before the apra-fleet-eft.37.1 rename) using the SAME HTML
// template the live viewer serves (@apralabs/apra-fleet-workflow's
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
// old_runs/ (merged with the legacy old_sprints/, apra-fleet-eft.37.1).
//
// PATH-TRAVERSAL DISCIPLINE (acceptance criterion)
// -------------------------------------------------
// A sprintId is an opaque identifier (a stable per-sprint id/UUID -- see
// @apralabs/apra-fleet-workflow/viewer/run-state-paths), never a path
// fragment. Any `:id` value containing a path separator or a bare '.'/'..'
// segment is rejected outright, and the resolved file path is verified
// (defense in depth) to still land directly inside old_runs/ or the legacy
// old_sprints/ before anything ever touches disk -- the renderer reads ONLY
// from the service data dir's old_runs/ or old_sprints/, never an arbitrary
// repo checkout path.
// =============================================================================

import fsp from 'node:fs/promises';
import path from 'node:path';
import { HTML_TEMPLATE } from '@apralabs/apra-fleet-workflow/viewer';
import { getOldRunsDir, getTerminalRunStatePath } from '@apralabs/apra-fleet-workflow/viewer/run-state-paths';
import { getFleetDataDir } from '@apralabs/apra-fleet-client/server-resolution';
// (apra-fleet-i9ag.3.8) SAME supervisor-side back-link the live proxy injects
// into the live-proxied child HTML (apra-fleet-i9ag.5.2/3.6) -- reused here so
// the finished-sprint page reached through /sprints/:id/live's history
// fallthrough (proxy.mjs's serveHistory(), wired to this module's
// renderForSprint() below) carries the SAME mount-aware, target="_top"
// back-link, without teaching @apralabs/apra-fleet-workflow's generic
// HTML_TEMPLATE anything about the supervisor dashboard (docs/generic-engine-
// boundary.md) -- the injection happens IN THIS SUPERVISOR-ONLY module,
// against the already-rendered HTML string, exactly like proxy.mjs does for
// the live view.
import { injectLiveViewBackLink, renderLiveViewBackLinkHtml } from './proxy.mjs';
// (apra-fleet-i9ag.16.1) LAUNCH_FAILED is the one history event kind this
// module synthesizes a finished-runs row for -- a sprint whose child died in
// its launch window before ever writing a terminal state file (see
// history.mjs's HISTORY_EVENTS doc comment / watchdog.mjs's classifySprint()).
import { HISTORY_EVENTS } from './history.mjs';
// (apra-fleet-i9ag.3.9) The DEDICATED History route (`GET /sprints/:id/history`,
// `handleGet` below) is entered directly, so nothing threads a mount prefix
// into it the way bin/serve.mjs threads the live proxy's own resolved value
// into the `/sprints/:id/live` history fallthrough. It therefore resolves the
// console's per-request mount path itself, exactly as registerDashboardRoutes
// (dashboard.mjs) and the live proxy's handleBase (proxy.mjs) do -- otherwise
// the back-link injected below is always rooted at '/' and a click from inside
// the console's /ext/<id> iframe leaves the mount point behind.
import { resolveMountPrefix } from './mount-prefix.mjs';

/**
 * BOUNDARY-COMPAT (apra-fleet-eft.37.1/37.2): the legacy pre-rename terminal
 * state directory. old_runs/ is the canonical write target for every fresh
 * run; this legacy directory is resolved read-only, purely so history for
 * sprints that finished BEFORE the rename still renders. Remove once no
 * legacy old_sprints/ files remain to serve.
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function getLegacyOldSprintsDir(env) {
    return path.join(getFleetDataDir(env), 'old_sprints');
}

/**
 * Writes a small text response with an explicit content-length. Exported
 * (apra-fleet-ou7.2) so the sibling GET /sprints/:id/log route (api.mjs)
 * reuses this SAME plain-text response helper instead of a second copy.
 */
export function sendPlain(res, status, text) {
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
 * attempt against old_runs/ or old_sprints/.
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
 * Resolves a sprintId to its terminal state path, merging the canonical
 * old_runs/<sprintId>.json with the legacy old_sprints/<sprintId>.json
 * (apra-fleet-eft.37.1: getTerminalRunStatePath resolves old_runs/ first,
 * falling back read-only to old_sprints/ for sprints that finished before the
 * rename). Throws RangeError for an unsafe sprintId, or for the
 * (should-be-impossible once isSafeSprintId has passed) case where the
 * resolved path still lands outside one of those two directories -- defense
 * in depth, never trusting a single check alone.
 * @param {string} sprintId
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function resolveOldSprintPath(sprintId, env) {
    if (!isSafeSprintId(sprintId)) {
        throw new RangeError(`refusing to resolve unsafe sprint id: ${JSON.stringify(sprintId)}`);
    }
    const filePath = getTerminalRunStatePath(sprintId, env);
    const resolvedDir = path.dirname(path.resolve(filePath));
    const runsDir = path.resolve(getOldRunsDir(env));
    const legacyDir = path.resolve(getLegacyOldSprintsDir(env));
    if (resolvedDir !== runsDir && resolvedDir !== legacyDir) {
        throw new RangeError(`resolved path for sprint id '${sprintId}' escapes old_runs/ or old_sprints/`);
    }
    return filePath;
}

/**
 * BOUNDARY-COMPAT (apra-fleet-eft.37.3): before the M2 boundary refactor,
 * core minted top-level `state.verdict`/`state.prUrl` by name; persisted
 * old_runs/old_sprints files written before this release still have that
 * shape. Core now stores the workflow script's own return value WHOLESALE
 * and opaquely as `state.result` (docs/workflow-core-boundary-
 * refactoring.md M2), which is what both the generic Result strip and this
 * package's own verdict-badge/PR-link extension (auto-sprint/
 * viewer-extensions.mjs's `renderResultExtrasHtml`) read. Backfilling
 * `state.result` here -- the se-owned reader shim -- is what lets a
 * pre-rename file's verdict/PR still render in the History view without
 * core ever having to know about this legacy shape. A file that already has
 * a `result` object (post-M2) is left untouched: legacy top-level fields
 * never override an already-opaque result. Remove one release after no
 * legacy verdict/prUrl-shaped files remain to serve.
 * @param {object} state
 * @returns {object}
 */
function backfillLegacyResult(state) {
    if (!state || typeof state !== 'object') return state;
    if (state.result && typeof state.result === 'object') return state;
    if (state.verdict === undefined && state.prUrl === undefined) return state;
    return {
        ...state,
        result: { verdict: state.verdict ?? null, prUrl: state.prUrl ?? null },
    };
}

/**
 * Loads and parses a finished sprint's persisted terminal state from
 * old_runs/<sprintId>.json (or the legacy old_sprints/<sprintId>.json).
 * Returns `null` when no such file exists (the caller answers 404) or its
 * content isn't valid JSON; throws only for a
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
        return backfillLegacyResult(JSON.parse(raw));
    } catch {
        return null;
    }
}

/**
 * Renders the process-free History view for one finished sprint: the SAME
 * HTML_TEMPLATE the live viewer serves, fed the frozen state object directly
 * -- no /events or /state polling, Save/Stop omitted (HTML_TEMPLATE's
 * `opts.history` mode, apra-fleet-eft.6.5).
 * @param {object} state - parsed old_runs/<sprintId>.json (or legacy old_sprints/)
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
 *   renderForSprint: (sprintId: string, mountPrefix?: string) => Promise<string|null>,
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
     * old_runs/ (or legacy old_sprints/) state (caller answers 404). Throws
     * for an unsafe sprintId -- callers that want a rejection instead of a thrown error (this
     * module's own `handleGet` below) check `isSafeSprintId()` themselves
     * first; the live-proxy's `renderHistory` seam (src/supervisor/proxy.mjs)
     * already treats a throwing renderer as "no history" and answers 404,
     * which is itself a rejection of the path-traversal attempt.
     *
     * `mountPrefix` (apra-fleet-i9ag.3.8) is `resolveMountPrefix(req)`'s
     * per-request result (or `''`/omitted for serve-direct), threaded through
     * from whichever caller resolved it -- bin/serve.mjs forwards the live
     * proxy's own resolved value into this seam so the page reached via
     * `/sprints/:id/live`'s history fallthrough carries a back-link that
     * resolves under the console's `/ext/<id>` mount point instead of the
     * console root when embedded, and this module's own `handleGet`
     * (apra-fleet-i9ag.3.9) resolves it from its own `req` so the dedicated
     * `/sprints/:id/history` route behaves identically.
     * @param {string} sprintId
     * @param {string} [mountPrefix]
     * @returns {Promise<string|null>}
     */
    async function renderForSprint(sprintId, mountPrefix) {
        const state = await loadOldSprintState(sprintId, env, readFile);
        if (state == null) return null;
        const html = renderHistoryPageHtml(state, dashboardExtensions);
        return injectLiveViewBackLink(html, renderLiveViewBackLinkHtml(mountPrefix ?? '', sprintId));
    }

    // GET /sprints/:id/history -- the dedicated "History" link (apra-fleet-eft.6,
    // Plan Part 2.3): always renders from old_runs/ (merged with the legacy
    // old_sprints/, apra-fleet-eft.37.1), regardless of whether
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
            // (apra-fleet-i9ag.3.9) Resolved PER REQUEST from this route's own
            // `req`, same as dashboard.mjs's GET / handler and proxy.mjs's
            // handleBase: one rendered page answers both the direct-on-port
            // hit and the console's /ext/<id> iframe hop. A hostile or
            // malformed header fails closed to '' in resolveMountPrefix(),
            // which is exactly the serve-direct render.
            html = await renderForSprint(sprintId, resolveMountPrefix(req));
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

/** Default cap on how many finished runs the dashboard History list shows. */
export const DEFAULT_FINISHED_RUNS_LIMIT = 50;

/** First non-empty string among `values`, else null. */
function firstText(...values) {
    for (const v of values) {
        if (typeof v === 'string' && v.trim().length > 0) return v;
    }
    return null;
}

/**
 * apra-fleet-i9ag.16.7: WHY a run ended, pulled out of the same parsed
 * terminal state file the rest of this summary comes from -- so the dashboard
 * can show an operator the reason on a Finished Sprints card / Sprint Stack
 * row instead of a bare verdict badge. Before this, a finished run's `reason`
 * was hard-coded `null` in createFinishedRunsIndex()'s list() below and only
 * the launch-failed synthesis path ever carried one, which is why the ABORTED
 * card the final M1 acceptance run hit had no reason to render at all.
 *
 * Composed from a LABEL and a DETAIL, joined `label: detail` when both exist
 * and differ, because the two real producers each populate a different half:
 *
 *   * fleet-sprint's fatal-diagnostics guard (fleet-sprint/fatal-diagnostics.mjs)
 *     writes `extensions.terminal = { verdict: 'ABORTED', terminalReason:
 *     <'uncaughtException'|'unhandledRejection'>, lastError: { message, ... } }`
 *     -- the label alone ('uncaughtException') says nothing useful, the
 *     lastError message is the part an operator needs.
 *   * runner.js's typed-abort path writes `extensions.terminal =
 *     { verdict: 'ABORTED', terminalReason: <code/name>, message: <err.message> }`.
 *   * the engine's own run-end handler (apra-fleet-workflow viewer index.mjs)
 *     writes top-level `terminalReason` (an error message, or the bare run
 *     status when the run ended without one), and a FAIL verdict's own
 *     explanation lives in the workflow result's `notes`.
 *
 * Never throws on an unexpected shape -- every access is guarded, and an
 * absent reason is `null` (the render layer then omits the line entirely).
 * @param {unknown} state - a parsed terminal run-state file
 * @returns {string|null}
 */
export function summarizeTerminalReason(state) {
    const s = (state && typeof state === 'object') ? state : {};
    const terminal = (s.extensions && typeof s.extensions.terminal === 'object' && s.extensions.terminal)
        ? s.extensions.terminal
        : {};
    const lastError = (terminal.lastError && typeof terminal.lastError === 'object')
        ? terminal.lastError
        : ((s.lastError && typeof s.lastError === 'object') ? s.lastError : {});
    const result = (s.result && typeof s.result === 'object') ? s.result : {};
    // The child's OWN terminal record wins over the engine's generic run-end
    // one: `extensions.terminal` is written at the moment the sprint decided
    // it was over and names the specific cause, while top-level
    // `terminalReason` degrades to the bare run status when the run ended
    // without a thrown error.
    const label = firstText(terminal.terminalReason, s.terminalReason);
    const detail = firstText(terminal.message, lastError.message, result.notes);
    if (label && detail && detail !== label) return label + ': ' + detail;
    return label || detail;
}

/**
 * Pulls the dashboard-facing summary out of one parsed terminal state file.
 * Verdict/PR come from the opaque `result` (post-M2, or backfilled from the
 * legacy top-level fields by backfillLegacyResult()), with the engine's own
 * `extensions.terminal.verdict` as a verdict fallback -- the SAME field the
 * watchdog copies into sprint-history.json's FINISHED event. A prUrl is only
 * kept when it is an http(s) URL, so a malformed/hostile value can never
 * become a `javascript:` href on the dashboard.
 *
 * (apra-fleet-i9ag.16.7) `reason` is summarizeTerminalReason()'s answer for
 * this same state. It is part of THIS summary (rather than being bolted on by
 * list() below) because list() caches summaries per file by mtime+size -- a
 * reason computed outside the cached object would be recomputed on every poll
 * and, worse, could drift from the cached verdict it explains.
 * @param {string} sprintId - the file's basename (the id GET /sprints/:id/history resolves)
 * @param {object} state
 * @param {number} mtimeMs
 * @returns {{ sprintId: string, verdict: string|null, prUrl: string|null, endedAt: string|null, goal: string|null, workflowName: string|null, reason: string|null }}
 */
export function summarizeFinishedRun(sprintId, state, mtimeMs = 0) {
    const s = backfillLegacyResult(state) || {};
    const result = s.result && typeof s.result === 'object' ? s.result : {};
    const terminalVerdict = s.extensions && s.extensions.terminal ? s.extensions.terminal.verdict : null;
    const rawVerdict = result.verdict ?? terminalVerdict ?? null;
    const verdict = typeof rawVerdict === 'string' && rawVerdict.length > 0 ? rawVerdict : null;
    const prUrl = typeof result.prUrl === 'string' && /^https?:\/\//i.test(result.prUrl) ? result.prUrl : null;
    const endedAt = typeof s.endedAt === 'string' && s.endedAt.length > 0
        ? s.endedAt
        : (mtimeMs > 0 ? new Date(mtimeMs).toISOString() : null);
    const goal = s.args && typeof s.args === 'object' && typeof s.args.goal === 'string' ? s.args.goal : null;
    return {
        sprintId,
        verdict,
        prUrl,
        endedAt,
        goal,
        workflowName: typeof s.workflowName === 'string' ? s.workflowName : null,
        reason: summarizeTerminalReason(s),
    };
}

/**
 * The finished-sprints index behind the dashboard's History list
 * (apra-fleet-i9ag.4): every persisted terminal run under old_runs/ (plus the
 * legacy old_sprints/), newest first, each summarized by
 * summarizeFinishedRun(). File-backed rows get GET /sprints/:id/history links
 * that resolve, `status: 'finished'`, `hasTerminalState: true`, and
 * (apra-fleet-i9ag.16.7) the `reason` summarizeTerminalReason() read out of
 * their own terminal state file -- no longer a hard-coded null.
 *
 * old_runs/ lives in the shared fleet data dir, so other workflows' runs land
 * there too. When a `history` collaborator (history.mjs's sprint-history log)
 * is injected, the list is narrowed to run ids this supervisor has recorded a
 * terminal event for; without one every terminal run is listed.
 *
 * apra-fleet-i9ag.16.1: when a `history` collaborator IS injected, a sprint
 * that died in its launch window (a LAUNCH_FAILED event, history.mjs's
 * HISTORY_EVENTS) with NO terminal state file also gets a synthesized row --
 * `{ sprintId, verdict: null, prUrl: null, endedAt: <event's `at`>, goal:
 * null, workflowName: null, status: 'launch-failed', reason: <event's
 * reason>, hasTerminalState: false }` -- merged and deduped by sprintId with
 * the file-backed row always winning when both exist. With no `history`
 * collaborator injected, no launch-failed rows are ever synthesized.
 *
 * Parsed summaries are cached per file keyed by mtime+size, so a dashboard
 * poll re-reads only files that changed since the last call.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   history?: { list: () => Array<{ sprintId: string, event?: string, verdict?: string|null, reason?: string|null, at?: string }> }|null,
 *   limit?: number,
 *   fs?: { readdir: Function, stat: Function, readFile: Function },
 *   logger?: { log?: Function, error?: Function },
 * }} [deps]
 * @returns {{ list: () => Promise<Array<ReturnType<typeof summarizeFinishedRun> & { status: string, reason: string|null, hasTerminalState: boolean }>> }}
 */
export function createFinishedRunsIndex(deps = {}) {
    const env = deps.env ?? process.env;
    const history = deps.history && typeof deps.history.list === 'function' ? deps.history : null;
    const limit = Number.isInteger(deps.limit) && deps.limit > 0 ? deps.limit : DEFAULT_FINISHED_RUNS_LIMIT;
    const fs = deps.fs ?? fsp;
    const logger = deps.logger ?? console;
    const logError = (...a) => (logger.error ?? logger.log)?.(...a);
    /** @type {Map<string, { key: string, summary: object }>} */
    const cache = new Map();

    async function scanDir(dir) {
        let names;
        try {
            names = await fs.readdir(dir);
        } catch (err) {
            if (err && err.code === 'ENOENT') return [];
            throw err;
        }
        const out = [];
        for (const name of names) {
            if (!name.endsWith('.json')) continue;
            const sprintId = name.slice(0, -'.json'.length);
            if (!isSafeSprintId(sprintId)) continue;
            const filePath = path.join(dir, name);
            try {
                const st = await fs.stat(filePath);
                if (!st.isFile()) continue;
                out.push({ sprintId, filePath, mtimeMs: st.mtimeMs, size: st.size });
            } catch {
                // Raced away between readdir and stat -- skip.
            }
        }
        return out;
    }

    async function list() {
        // old_runs/ wins over the legacy dir for the same id, mirroring
        // getTerminalRunStatePath()'s own resolution order.
        const byId = new Map();
        for (const dir of [getOldRunsDir(env), getLegacyOldSprintsDir(env)]) {
            for (const f of await scanDir(dir)) {
                if (!byId.has(f.sprintId)) byId.set(f.sprintId, f);
            }
        }
        let historyVerdicts = null;
        if (history) {
            historyVerdicts = new Map();
            for (const e of history.list()) {
                if (!e || typeof e.sprintId !== 'string') continue;
                const prior = historyVerdicts.get(e.sprintId) ?? null;
                historyVerdicts.set(e.sprintId, e.verdict ?? prior);
            }
        }
        const filteredFiles = [...byId.values()]
            .filter((f) => !historyVerdicts || historyVerdicts.has(f.sprintId))
            .sort((a, b) => b.mtimeMs - a.mtimeMs);
        // Only the newest `limit` files are ever parsed -- a long-lived data
        // dir with hundreds of old runs costs one stat each, not one full
        // JSON parse each.
        const files = filteredFiles.slice(0, limit);
        // Ids that actually produced a usable file-backed summary -- NOT the
        // same as `byId`'s keys (apra-fleet-i9ag.15.4): a terminal state file
        // can exist on disk (so `byId.has(sprintId)` is true) yet still fail
        // JSON.parse below, in which case the file-backed row is dropped and
        // this id must remain a candidate for LAUNCH_FAILED synthesis, not be
        // treated as "already covered by a file". Gating synthesis on THIS
        // set instead of on `byId` is exactly the fix.
        //
        // apra-fleet-i9ag.15.7: pre-seeded with every id excluded from `files`
        // PURELY by the newest-`limit` slice above (never even attempted to
        // parse) -- a perfectly good terminal state file exists for these on
        // disk, it is only outside the display window, which is a completely
        // different reason from "this id's file WAS attempted and failed to
        // parse" (i9ag.15.4's case, left un-seeded here so it remains
        // eligible for synthesis below). Without this, an id whose file sorts
        // outside the window but which also carries a LAUNCH_FAILED event
        // would get a spurious synthesized duplicate even though its file is
        // fine -- it is simply not being shown this poll.
        const producedIds = new Set(filteredFiles.slice(limit).map((f) => f.sprintId));
        const summaries = [];
        for (const f of files) {
            const key = f.mtimeMs + ':' + f.size;
            const hit = cache.get(f.filePath);
            if (hit && hit.key === key) { summaries.push(hit.summary); producedIds.add(f.sprintId); continue; }
            let state;
            try {
                state = JSON.parse(await fs.readFile(f.filePath, 'utf-8'));
            } catch (err) {
                logError('[history-view] skipping unreadable terminal state', f.filePath, err && err.message);
                continue;
            }
            const summary = summarizeFinishedRun(f.sprintId, state, f.mtimeMs);
            cache.set(f.filePath, { key, summary });
            summaries.push(summary);
            producedIds.add(f.sprintId);
        }
        // Every file-backed row (has a terminal state file, however stale)
        // gets the SAME three constant fields so consumers branch on one
        // explicit `status` instead of inferring "launch-failed" from an
        // absent verdict.
        //
        // apra-fleet-i9ag.16.7: `reason` is no longer a hard-coded null here.
        // It is whatever summarizeFinishedRun() read out of this run's own
        // terminal state file (summarizeTerminalReason()) -- the reason a
        // failed/aborted run's Finished Sprints card and Sprint Stack row can
        // now show. A clean run typically carries one too (its run status);
        // the render layer only surfaces it for a run that ended badly, so
        // populating it unconditionally here adds no noise to the page.
        const rows = summaries.map((s) => {
            const withVerdict = s.verdict || !historyVerdicts ? s : { ...s, verdict: historyVerdicts.get(s.sprintId) ?? null };
            return { ...withVerdict, status: 'finished', reason: withVerdict.reason ?? null, hasTerminalState: true };
        });

        // apra-fleet-i9ag.16.1: a sprint that died in its launch window NEVER
        // writes a terminal state file, so it never appears in `byId` above --
        // without this, the operator sees nothing at all for a failed launch,
        // even though the watchdog's own history log already carries a
        // LAUNCH_FAILED event for it. Only possible when a history
        // collaborator is injected (without one this whole block is skipped,
        // so the no-history behaviour is byte-for-byte what it was before this
        // change). Gated on `producedIds` (apra-fleet-i9ag.15.4), NOT on
        // `byId`: a file-backed row always wins over a synthesized one for the
        // same id when the file actually parsed, but a terminal state file
        // that exists yet fails JSON.parse produces no row at all in the loop
        // above, so `byId.has(sprintId)` alone would wrongly suppress
        // synthesis too -- the exact "operator sees nothing" outcome this
        // block exists to eliminate, just reached through a narrower door.
        if (history) {
            const launchFailedBySprintId = new Map();
            for (const e of history.list()) {
                if (!e || typeof e.sprintId !== 'string') continue;
                if (e.event !== HISTORY_EVENTS.LAUNCH_FAILED) continue;
                if (producedIds.has(e.sprintId)) continue;
                // history.list() is insertion order -- the last LAUNCH_FAILED
                // event recorded for a given sprintId wins.
                launchFailedBySprintId.set(e.sprintId, e);
            }
            for (const e of launchFailedBySprintId.values()) {
                rows.push({
                    sprintId: e.sprintId,
                    verdict: null,
                    prUrl: null,
                    endedAt: typeof e.at === 'string' && e.at.length > 0 ? e.at : null,
                    goal: null,
                    workflowName: null,
                    status: 'launch-failed',
                    reason: typeof e.reason === 'string' && e.reason.length > 0 ? e.reason : null,
                    hasTerminalState: false,
                });
            }
        }

        // Newest first by the run's own endedAt (summarizeFinishedRun() falls
        // back to the file mtime when absent); ISO-8601 strings sort lexically.
        rows.sort((a, b) => String(b.endedAt ?? '').localeCompare(String(a.endedAt ?? '')));
        return rows.slice(0, limit);
    }

    return { list };
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
