/**
 * The backlog-role alias layer.
 *
 * `backlog` is the application-level pseudo-role naming the member whose beads
 * clone the sprint runner issues its own `bd`/`git` commands against. Before
 * 0.4.4 that role was spelled `orchestrator`; the old spelling is a deprecated
 * alias, accepted in 0.4.4 and removed in v0.5. This module is the ONE place
 * that knows the old spelling: callers pass an already key-normalized
 * (trim + lowercase) roleMap and get back a roleMap carrying only `backlog`.
 */

export const ROLE_BACKLOG = 'backlog';
export const ROLE_BACKLOG_ALIAS = 'orchestrator';

export const BACKLOG_ALIAS_WARNING =
    'Deprecated: roleMap.orchestrator is a deprecated alias of roleMap.backlog; ' +
    'use roleMap.backlog instead. The orchestrator alias will be removed in v0.5.';

/**
 * @param {object|undefined} normalizedRoleMap - keys already normalized
 * @returns {{ roleMap: object|undefined, warnings: string[] }}
 * @throws {Error} when both keys are present with different member lists
 */
export function resolveBacklogRoleAlias(normalizedRoleMap) {
    if (normalizedRoleMap === undefined) return { roleMap: undefined, warnings: [] };
    const has = (k) => Object.prototype.hasOwnProperty.call(normalizedRoleMap, k);
    if (!has(ROLE_BACKLOG_ALIAS)) return { roleMap: normalizedRoleMap, warnings: [] };

    const aliasValue = normalizedRoleMap[ROLE_BACKLOG_ALIAS];
    const roleMap = { ...normalizedRoleMap };
    delete roleMap[ROLE_BACKLOG_ALIAS];
    if (has(ROLE_BACKLOG)) {
        const a = JSON.stringify(normalizedRoleMap[ROLE_BACKLOG]);
        const b = JSON.stringify(aliasValue);
        if (a !== b) {
            throw new Error(
                `roleMap has both "${ROLE_BACKLOG}" (${a}) and its deprecated alias "${ROLE_BACKLOG_ALIAS}" (${b}) ` +
                `with different member lists. Use roleMap.${ROLE_BACKLOG} only.`
            );
        }
    } else {
        roleMap[ROLE_BACKLOG] = aliasValue;
    }
    return { roleMap, warnings: [BACKLOG_ALIAS_WARNING] };
}
