// =============================================================================
// kb_maintainer selection: ONE member per repository receives every KB write
// for that repository. Computed once at sprint setup, logged one line per
// repository, and exposed to later phases (the write-routing step) through
// the selector object runner.js stores on the sprint context.
//
// Repository membership: a member belongs to repository X when its work
// folder's `origin` remote, normalized with beads-identity's
// normalizeRemoteUrl (the engine's one canonical remote-URL form), is X. A
// member whose work folder is not a repository (no origin could be read) can
// never be a maintainer; it is recorded in nonRepoMembers so the write-routing
// step can drop its captures with a warning instead of guessing a repository.
//
// Selection order, per repository (each repository in the sprint is the
// normalized origin of at least one member):
//   (a) explicit -- a member listed under roleMap.kb_maintainer whose work
//       folder is a checkout of that repository (listed order);
//   (b) role-less -- the first member named in NO dispatched roleMap value
//       (members order) whose work folder is a checkout of that repository;
//   (c) access -- any other member with access to the repository: a
//       role-mapped member whose work folder is a checkout of it (members
//       order). A member whose checkout is a DIFFERENT repository is not
//       eligible even if it is registered with access to this one: a KB
//       write made as that member lands in its own work folder's KB, i.e.
//       the other repository's.
// Candidates are tried in that order; the first one whose availability probe
// (a cheap read-only kb_stats call AS the member, through memberCall)
// succeeds is the maintainer. Each skipped candidate is logged as a
// replacement, naming the next eligible member and the probe error.
//
// A member mapped to roleMap.orchestrator is NEVER a maintainer under any rule
// (explicit included): the orchestrator may be a shared member that cannot sit
// on every sprint's branch. If it is the only member with a checkout of a
// repository, that repository gets no maintainer and a loud WARNING is logged.
//
// kb_maintainer is NOT a dispatched role: no agent() call ever targets it,
// and runner.js leaves it out of the role-mapped "specialist" set so naming a
// member as maintainer does not take it out of the generalist pool.
//
// Every dependency is injected (resolveMember / probeOrigin / probeMember),
// so this module issues no fleet call of its own and is unit-testable without
// a fleet server. Best-effort like KB priming: a resolution or origin probe
// that fails is logged and the member is treated as having no repository; a
// sprint never fails because no maintainer could be chosen.
// =============================================================================

import { normalizeRemoteUrl } from './beads-identity.mjs';

/** roleMap key naming explicit maintainers. Not a dispatched role. */
export const ROLE_KB_MAINTAINER = 'kb_maintainer';

/** Which rule chose a repository's maintainer (logged verbatim). */
export const KB_MAINTAINER_RULES = Object.freeze({
    EXPLICIT: 'explicit',
    ROLELESS: 'role-less',
    ACCESS: 'access',
});

const LOG_PREFIX = '[kb-maintainer]';

function errText(err) {
    return err && err.message ? err.message : String(err);
}

/**
 * Members named in any roleMap value EXCEPT kb_maintainer (which is not a
 * dispatched role, so it does not make a member role-mapped).
 * @param {object|undefined} roleMap normalized roleMap
 * @returns {Set<string>}
 */
export function roleMappedMembers(roleMap) {
    const out = new Set();
    if (!roleMap || typeof roleMap !== 'object') return out;
    for (const [role, list] of Object.entries(roleMap)) {
        if (role === ROLE_KB_MAINTAINER || !Array.isArray(list)) continue;
        for (const m of list) out.add(m);
    }
    return out;
}

/** Members named under roleMap.orchestrator. */
export function orchestratorMembers(roleMap) {
    const list = roleMap && typeof roleMap === 'object' ? roleMap.orchestrator : undefined;
    return new Set(Array.isArray(list) ? list : []);
}

/**
 * Pure ordering of maintainer candidates for one repository.
 * @param {{ repo: string, members: string[], repoOf: Map<string,string>, roleMap?: object }} opts
 * @returns {Array<{ member: string, rule: string }>}
 */
export function orderMaintainerCandidates({ repo, members, repoOf, roleMap }) {
    const orch = orchestratorMembers(roleMap);
    const inRepo = (m) => repoOf.get(m) === repo && !orch.has(m);
    const explicit = (roleMap && Array.isArray(roleMap[ROLE_KB_MAINTAINER])) ? roleMap[ROLE_KB_MAINTAINER] : [];
    const mapped = roleMappedMembers(roleMap);
    const seen = new Set();
    const out = [];
    const add = (member, rule) => {
        if (seen.has(member)) return;
        seen.add(member);
        out.push({ member, rule });
    };
    for (const m of explicit) if (inRepo(m)) add(m, KB_MAINTAINER_RULES.EXPLICIT);
    for (const m of members) if (inRepo(m) && !mapped.has(m)) add(m, KB_MAINTAINER_RULES.ROLELESS);
    for (const m of members) if (inRepo(m)) add(m, KB_MAINTAINER_RULES.ACCESS);
    return out;
}

/**
 * The one selection line logged per repository.
 * @param {{ repo: string, member: string|null, rule: string|null }} sel
 */
export function formatSelectionLine(sel) {
    if (!sel.member && sel.orchestratorOnly) {
        return `${LOG_PREFIX} WARNING: repository ${sel.repo}: no maintainer selected -- the only member with a checkout of the repository is the orchestrator, which is never a maintainer; KB writes for it have no target this sprint`;
    }
    if (!sel.member) {
        return `${LOG_PREFIX} repository ${sel.repo}: no available maintainer (every eligible member failed its probe); KB writes for it have no target this sprint`;
    }
    return `${LOG_PREFIX} repository ${sel.repo}: maintainer '${sel.member}' (rule: ${sel.rule})`;
}

/**
 * @param {{
 *   members: string[],
 *   roleMap?: object,
 *   resolveMember?: (name: string) => Promise<{id: string, name: string, type?: string}|null>,
 *   probeOrigin?: (name: string) => Promise<string>,
 *   probeMember?: (record: object) => Promise<any>,
 *   log?: Function,
 * }} opts
 */
export function createKbMaintainerSelector(opts = {}) {
    const { members = [], roleMap, resolveMember, probeOrigin, probeMember, log = () => {} } = opts;
    const active = typeof resolveMember === 'function' && typeof probeOrigin === 'function' && typeof probeMember === 'function' && members.length > 0;

    /** normalized repo url -> { repo, member, record, rule, replaced: [{member, rule, error}] } */
    const byRepo = new Map();
    /** member name -> normalized repo url */
    const repoOf = new Map();
    /** member name -> raw origin url as read */
    const rawOriginOf = new Map();
    /** members whose work folder is not a repository (or could not be shown to be one) */
    const nonRepoMembers = new Set();
    /** member name -> record ({id, name, type}) */
    const records = new Map();
    let selected = null;

    async function resolveAll() {
        for (const member of members) {
            let record = null;
            try {
                record = await resolveMember(member);
            } catch (err) {
                log(`${LOG_PREFIX} could not resolve member '${member}': ${errText(err)} -- not eligible as a maintainer`);
            }
            if (!record || !record.id) {
                nonRepoMembers.add(member);
                continue;
            }
            records.set(member, record);
            let origin = '';
            try {
                origin = String(await probeOrigin(member) || '').trim();
            } catch (err) {
                log(`${LOG_PREFIX} could not read the origin remote of member '${member}': ${errText(err)}`);
            }
            const repo = normalizeRemoteUrl(origin);
            if (!repo) {
                nonRepoMembers.add(member);
                log(`${LOG_PREFIX} member '${member}': work folder is not a repository -- never a maintainer; its KB captures will be dropped with a warning`);
                continue;
            }
            repoOf.set(member, repo);
            rawOriginOf.set(member, origin);
        }
    }

    async function chooseFor(repo) {
        const candidates = orderMaintainerCandidates({ repo, members, repoOf, roleMap });
        const replaced = [];
        for (let i = 0; i < candidates.length; i++) {
            const { member, rule } = candidates[i];
            try {
                await probeMember(records.get(member));
            } catch (err) {
                const next = candidates[i + 1];
                replaced.push({ member, rule, error: errText(err) });
                const replacement = next ? "'" + next.member + "' (rule: " + next.rule + ')' : 'no remaining eligible member';
                log(`${LOG_PREFIX} repository ${repo}: maintainer candidate '${member}' (rule: ${rule}) is unavailable (${errText(err)}); replaced by ${replacement}`);
                continue;
            }
            return { repo, member, record: records.get(member), rule, replaced };
        }
        const orch = orchestratorMembers(roleMap);
        const orchestratorOnly = candidates.length === 0 && members.some((m) => repoOf.get(m) === repo && orch.has(m));
        return { repo, member: null, record: null, rule: null, replaced, orchestratorOnly };
    }

    function warnUnusableExplicit() {
        const explicit = (roleMap && Array.isArray(roleMap[ROLE_KB_MAINTAINER])) ? roleMap[ROLE_KB_MAINTAINER] : [];
        const orch = orchestratorMembers(roleMap);
        for (const m of explicit) {
            if (orch.has(m)) {
                log(`${LOG_PREFIX} WARNING: roleMap.${ROLE_KB_MAINTAINER} names '${m}', which is the orchestrator member -- ignored (the orchestrator is never a maintainer)`);
            } else if (!members.includes(m)) {
                log(`${LOG_PREFIX} WARNING: roleMap.${ROLE_KB_MAINTAINER} names '${m}', which is not a sprint member -- ignored`);
            } else if (!repoOf.has(m)) {
                log(`${LOG_PREFIX} WARNING: roleMap.${ROLE_KB_MAINTAINER} names '${m}', whose work folder is not a repository -- ignored`);
            }
        }
    }

    return {
        /** Compute the selection once; later calls return the same result. */
        async selectAll() {
            if (selected) return selected;
            selected = (async () => {
                if (!active) {
                    log(`${LOG_PREFIX} selection skipped: no member access available (KB writes have no maintainer this sprint)`);
                    return byRepo;
                }
                await resolveAll();
                warnUnusableExplicit();
                const repos = [];
                for (const m of members) {
                    const r = repoOf.get(m);
                    if (r && !repos.includes(r)) repos.push(r);
                }
                for (const repo of repos) {
                    const sel = await chooseFor(repo);
                    byRepo.set(repo, sel);
                    log(formatSelectionLine(sel));
                }
                return byRepo;
            })();
            return selected;
        },
        /** The maintainer selection for a repository URL (any remote form), or null. */
        getKbMaintainer(repoUrl) {
            const sel = byRepo.get(normalizeRemoteUrl(repoUrl));
            return sel && sel.member ? sel : null;
        },
        /** The maintainer selection for the repository `member` belongs to, or null. */
        maintainerForMember(member) {
            const repo = repoOf.get(member);
            return repo ? this.getKbMaintainer(repo) : null;
        },
        /** Normalized repository URL of a member's work folder, or null. */
        repoOf(member) {
            return repoOf.get(member) || null;
        },
        /** True when the member's work folder is not a repository (its captures are dropped). */
        isNonRepoMember(member) {
            return nonRepoMembers.has(member);
        },
        /** Snapshot: repo -> { member, rule, replaced }. */
        maintainers() {
            return new Map([...byRepo].map(([repo, sel]) => [repo, { member: sel.member, rule: sel.rule, replaced: sel.replaced.slice() }]));
        },
        nonRepoMembers() {
            return [...nonRepoMembers];
        },
    };
}

/**
 * member name -> {id, name, type} through the orchestrator's member_detail
 * (format:'json' is required: the compact renderer carries no id/type).
 * Returns null when the member has no id (e.g. not registered).
 * @param {(name: string, args: object) => Promise<any>} callTool
 */
export function createMemberDetailResolver(callTool) {
    return async (member) => {
        const res = await callTool('member_detail', { member_name: member, format: 'json' });
        let d = null;
        if (res && Array.isArray(res.content) && res.content[0] && typeof res.content[0].text === 'string') {
            try { d = JSON.parse(res.content[0].text); } catch { d = null; }
        } else if (res && typeof res === 'object') {
            d = res;
        }
        if (d && d.member && typeof d.member === 'object') d = { ...d.member, ...d };
        const id = d && d.id;
        if (typeof id !== 'string' || id.length === 0) return null;
        return { id, name: member, type: typeof d.type === 'string' ? d.type : undefined };
    };
}
