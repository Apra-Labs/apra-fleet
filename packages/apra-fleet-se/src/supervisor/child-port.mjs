// Shared sprintId -> live child viewer port resolution.
//
// The ledger deliberately does NOT persist ports; the spawner is the live
// pid->port bookkeeping (freshly spawned OR re-adopted across a restart), so
// the port is resolved as ledger.get(sprintId).childPid ->
// spawner.getLiveEntry(pid).port. A finished/crashed child (no live entry)
// resolves to `undefined`.
//
// One implementation, used by both the live-view reverse proxy (proxy.mjs)
// and the dashboard's per-row summary pull (dashboard.mjs) -- never two
// divergent copies.

/**
 * @param {{ get?: (sprintId: string) => { childPid?: number|null }|undefined }|null|undefined} ledger
 * @param {{ getLiveEntry?: (pid: number) => { port?: number }|undefined }|null|undefined} spawner
 * @param {string} sprintId
 * @returns {number|undefined}
 */
export function resolveChildPort(ledger, spawner, sprintId) {
    if (!ledger || typeof ledger.get !== 'function') return undefined;
    const entry = ledger.get(sprintId);
    const pid = entry && entry.childPid;
    if (!Number.isInteger(pid)) return undefined;
    if (!spawner || typeof spawner.getLiveEntry !== 'function') return undefined;
    const live = spawner.getLiveEntry(pid);
    return live && Number.isInteger(live.port) ? live.port : undefined;
}

/**
 * Bind resolveChildPort() to a ledger + spawner pair.
 * @param {{ ledger?: object|null, spawner?: object|null }} deps
 * @returns {(sprintId: string) => number|undefined}
 */
export function createChildPortResolver({ ledger = null, spawner = null } = {}) {
    return (sprintId) => resolveChildPort(ledger, spawner, sprintId);
}
