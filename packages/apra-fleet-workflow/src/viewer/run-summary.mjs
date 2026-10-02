// Generic, extension-agnostic run progress summary served at
// GET /state?summary=1 (see createDashboardViewer in ./index.mjs).
//
// The summary is a small, fixed-shape object kept in memory as
// `state.summary`. Its CORE fields mirror top-level run state and are
// refreshed whenever that state changes (every broadcast, which every
// lifecycle handler -- 'end', pause events, phase transitions -- already
// performs); refreshing them never calls any extension hook. Its
// `extensions` map holds, per published namespace, whatever the dashboard
// extension registered for that namespace returns from its optional
// `summarize(data)` hook -- computed ONCE per publish of that namespace,
// never per request. Core knows nothing about any extension's data shape.

export const SUMMARY_VERSION = 1;

/**
 * Builds the initial summary object for a run.
 * @param {string} runId
 */
export function createRunSummary(runId) {
    return {
        summaryVersion: SUMMARY_VERSION,
        runId,
        status: 'running',
        phase: null,
        pause: { status: 'none', reason: null, since: null, phase: null, group: null, resumeAt: null },
        terminalReason: null,
        updatedAt: null,
        endedAt: null,
        stats: { totalCost: 0, totalTokens: 0 },
        extensions: {}
    };
}

/**
 * Copies the core fields from the live run state into `summary` in place.
 * O(1); never calls any extension hook.
 * @param {object} summary - the object built by createRunSummary()
 * @param {object} state - the viewer's live state object
 * @param {string|null} phaseTitle - title of the current phase, or null
 */
export function refreshSummaryCore(summary, state, phaseTitle) {
    summary.status = state.status;
    summary.phase = phaseTitle ?? null;
    const p = state.pause || {};
    summary.pause = {
        status: p.status || 'none',
        reason: p.reason ?? null,
        since: p.since ?? null,
        phase: p.phase ?? null,
        group: p.group ?? null,
        resumeAt: p.resumeAt ?? null
    };
    summary.terminalReason = state.terminalReason ?? null;
    summary.updatedAt = state.updatedAt ?? null;
    summary.endedAt = state.endedAt ?? null;
    summary.stats = {
        totalCost: state.stats?.totalCost ?? 0,
        totalTokens: state.stats?.totalTokens ?? 0
    };
}

/**
 * Recomputes the summary entry for one published namespace. Calls
 * `summarize(data)` only on the extension whose id equals `namespace` AND
 * which defines a summarize function; any other namespace gets no entry.
 * A throwing summarize() is caught and logged, and the previous entry for
 * that namespace is kept.
 * @param {object} summary
 * @param {Array} extensions - dashboard extensions
 * @param {string} namespace
 * @param {*} data - the published data for that namespace
 * @param {string} publishedAt - ISO timestamp stamped by core
 * @param {{warn: Function}} [logger]
 */
export function applyExtensionSummary(summary, extensions, namespace, data, publishedAt, logger = console) {
    const ext = (extensions || []).find((e) => e && e.id === namespace);
    if (!ext || typeof ext.summarize !== 'function') return;
    let result;
    try {
        result = ext.summarize(data);
    } catch (e) {
        logger.warn(`[Viewer] Warning: summarize() for namespace '${namespace}' threw: ${e && e.message ? e.message : e}`);
        return;
    }
    const body = (result && typeof result === 'object' && !Array.isArray(result)) ? result : {};
    summary.extensions[namespace] = { publishedAt, ...body };
}
