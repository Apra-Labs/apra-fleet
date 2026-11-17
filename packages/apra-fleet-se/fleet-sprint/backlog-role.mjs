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

/**
 * The ONE backlog-member selector shared by every direct launch (runner.js and
 * bin/cli.mjs). Never throws on an unmapped backlog: it auto-selects and says
 * why, so the caller can report the choice loudly.
 *
 * Order (roleMap already key-normalized and alias-resolved):
 *   1. roleMap.backlog non-empty -> its first entry (explicit).
 *   2. the first member (members order) named in no roleMap value
 *      (no roleMap -> the first member).
 *   3. the first member mapped to doer.
 *   4. the first member.
 *
 * @param {{ roleMap?: object, members: string[] }} input
 * @returns {{ member: string|undefined, explicit: boolean, reason: string }}
 */
export function selectBacklogMember({ roleMap, members } = {}) {
    const list = Array.isArray(members) ? members : [];
    const explicitList = roleMap && Array.isArray(roleMap[ROLE_BACKLOG]) ? roleMap[ROLE_BACKLOG] : [];
    if (explicitList.length > 0) {
        return { member: explicitList[0], explicit: true, reason: 'roleMap.backlog' };
    }
    const mapped = new Set();
    if (roleMap) {
        for (const v of Object.values(roleMap)) {
            if (Array.isArray(v)) for (const m of v) mapped.add(m);
        }
    }
    if (!roleMap || mapped.size === 0) {
        return { member: list[0], explicit: false, reason: 'no roleMap, first member' };
    }
    const generalist = list.find((m) => !mapped.has(m));
    if (generalist !== undefined) {
        return { member: generalist, explicit: false, reason: 'first member not mapped to any role' };
    }
    const doers = Array.isArray(roleMap.doer) ? roleMap.doer : [];
    const doer = list.find((m) => doers.includes(m));
    if (doer !== undefined) {
        return { member: doer, explicit: false, reason: 'every member is role-mapped; first doer-mapped member' };
    }
    return { member: list[0], explicit: false, reason: 'every member is role-mapped and none is a doer; first member' };
}

/** The loud one-line report for an auto-selected backlog member (null when explicit). */
export function formatBacklogSelection(sel) {
    if (!sel || sel.explicit) return null;
    return `backlog: ${sel.member} (auto-selected: ${sel.reason})`;
}
