// Fetches the orchestrator-computed every-depth sprint scope for the planner
// and plan-reviewer prompts. Advisory only: a failure logs a WARN and yields
// null so the dispatch proceeds without the SPRINT SCOPE MEMBERSHIP block.

/**
 * @param {{
 *   bdListScoped?: (args: string) => Promise<object[]>,
 *   invalidateAllBeadsCache?: () => void,
 *   log: (msg: string) => void,
 *   invalidate?: boolean,
 *   label?: string,
 * }} opts
 * @returns {Promise<Array<{id: string, issue_type?: string, status?: string, parent?: string, title?: string}>|null>}
 */
export async function fetchScopeSnapshot({ bdListScoped, invalidateAllBeadsCache, log, invalidate = false, label = 'dispatch' }) {
    if (typeof bdListScoped !== 'function') return null;
    try {
        if (invalidate && typeof invalidateAllBeadsCache === 'function') invalidateAllBeadsCache();
        const beads = await bdListScoped('');
        return (Array.isArray(beads) ? beads : [])
            .filter((b) => b && b.id)
            .map((b) => ({ id: b.id, issue_type: b.issue_type, status: b.status, parent: b.parent, title: b.title }));
    } catch (err) {
        log(`[fleet-sprint] WARN: sprint scope snapshot for ${label} FAILED (${err && err.message}) -- dispatching without the SPRINT SCOPE MEMBERSHIP block.`);
        return null;
    }
}
