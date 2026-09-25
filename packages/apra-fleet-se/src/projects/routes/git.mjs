// =============================================================================
// /api/projects git + health route module (apra-fleet-vcnl.3)
// =============================================================================
//
// `registerGitRoutes(supervisor, {store, client})` serves the health-panel
// and git-drawer endpoints (screen S5 health panel, screen S10 / wireframe
// W3):
//
//   * GET /api/projects/:id/health -> ../health.mjs's `runHealth` result.
//   * GET /api/projects/:id/members/:member/git -> the S10 drawer model,
//     built here from the member_git cache (?refresh=1 re-probes via
//     ../projects.mjs's `refreshMember` first).
//
// Same collaborators as registerProjectRoutes
// --------------------------------------------
// `store` is an OPEN supervisor.sqlite handle (`{db, ...}` from
// ../store/db.mjs's `openStore()`) and `client` is a fleet MCP client. This
// module does not open, migrate, or close the connection. Deps are validated
// by the caller, not re-validated here: `registerProjectRoutes` has already
// thrown on a bad store/client before it reaches this call.
//
// `guardClient`/`withBindErrors` below are its OWN copies of the same-named
// helpers in ../routes/projects.mjs -- this module is a standalone function,
// not nested inside `registerProjectRoutes`, so it does not share that
// function's closures. Duplicated on purpose rather than exported from
// ../routes/projects.mjs: this task's own scope forbids editing that file.
//
// The git-drawer model reuses ../health.mjs's `buildGroups`/`dirtyCounts`/
// `bibleIsDirty` -- the SAME grouping/dirty-bible logic `groupHasCodeMember`/
// `bibleInSync` use, so "does this member's origin match its group" never
// answers a different question than the health panel's own grouping does.
// =============================================================================

import { getProject } from '../store/projects.mjs';
import { getMemberGit, listMemberGit } from '../store/member-git.mjs';
import { ProjectBindError, parseMemberList, refreshMember } from '../projects.mjs';
import { runHealth, buildGroups, dirtyCounts, bibleIsDirty, parseJsonResult } from '../health.mjs';
import { sendJson } from '../../supervisor/server.mjs';

/**
 * The first of `methods` the client does not implement, or null when it
 * implements all of them. Mirrors ../routes/projects.mjs's own
 * `missingClientMethod` (duplicated -- see module header).
 *
 * @param {object} client
 * @param {string[]} methods
 * @returns {string | null}
 */
function missingClientMethod(client, methods) {
    for (const method of methods) {
        if (typeof client?.[method] !== 'function') return method;
    }
    return null;
}

/**
 * The S10 git-drawer model for one bound member. Reads the member_git cache
 * (re-probing first via `refreshMember` when `refresh` is set); a member with
 * no checkout answers `{checkout: null, message: 'no git checkout', ...}`
 * carrying only the identity/VCS fields (W3: "only the VCS line").
 *
 * `matchesGroup` answers "is this member's checkout part of a REAL group" --
 * true when at least one OTHER bound member shares its `originSlug` (the
 * SAME `buildGroups` grouping `groupHasCodeMember`/`bibleInSync` use), false
 * for a lone/singleton checkout. Projects have no separate "canonical repo"
 * field of their own (see ../store/projects.mjs's row shape) to compare
 * against instead.
 *
 * @param {{db: any, client: object}} deps
 * @param {string} projectId
 * @param {string} member
 * @param {{refresh?: boolean}} [opts]
 * @returns {Promise<object>}
 * @throws {ProjectBindError} 404 project-not-found / member-not-bound.
 */
async function buildGitDrawer({ db, client }, projectId, member, { refresh = false } = {}) {
    const project = getProject(db, projectId);
    if (!project) throw new ProjectBindError(404, 'project-not-found', `no project '${projectId}'`);

    if (refresh) {
        // Throws its own 404 member-not-bound when there is nothing to refresh --
        // the getMemberGit check right below is then guaranteed to find the row
        // it just wrote.
        await refreshMember({ db, client }, projectId, member);
    }

    const row = getMemberGit(db, projectId, member);
    if (!row) throw new ProjectBindError(404, 'member-not-bound', `member '${member}' is not bound to project '${projectId}'`);

    // Best-effort: member_detail is the only client surface carrying
    // vcsProvider (list_members' JSON does not -- see ../checkout.mjs's own
    // header note on this same gap), so a member that cannot be reached still
    // renders the drawer with a null vcs/where/workFolder rather than 500ing.
    let detail = null;
    try {
        detail = parseJsonResult(await client.memberDetail({ member_name: member, format: 'json' }));
    } catch { /* degrades to null below */ }

    const where = detail && typeof detail.type === 'string' ? detail.type : null;
    const workFolder = detail && typeof detail.folder === 'string' ? detail.folder : null;
    const vcs = {
        provider: detail && detail.vcsProvider ? detail.vcsProvider : null,
        expiresAt: detail && detail.vcsTokenExpiresAt ? detail.vcsTokenExpiresAt : null,
    };

    if (!row.originSlug) {
        return { member, where, checkout: null, message: 'no git checkout', workFolder, vcs };
    }

    const rows = listMemberGit(db, projectId);
    const groups = buildGroups(rows);
    const matchesGroup = groups.some((g) => g.originSlug === row.originSlug && g.members.length > 1);

    const checkout = row.statusJson && row.statusJson.checkout ? row.statusJson.checkout : null;

    // registeredAs: which member (if any) has this worktree path as its OWN
    // registered work folder. Best-effort against list_members -- an
    // unreachable registry just leaves every worktree's registeredAs null.
    let records = [];
    try {
        records = parseMemberList(await client.listMembers({ format: 'json' }));
    } catch { /* registeredAs degrades to null below */ }
    const folderToName = new Map(
        records.filter((r) => r && typeof r.folder === 'string').map((r) => [r.folder, r.name]),
    );

    const worktrees = (Array.isArray(row.worktrees) ? row.worktrees : []).map((wt) => ({
        path: wt.path,
        branch: wt.branch ?? null,
        head: wt.head ?? null,
        detached: Boolean(wt.detached),
        registeredAs: folderToName.get(wt.path) ?? null,
    }));

    return {
        member,
        where,
        group: row.originSlug,
        originUrl: row.originUrl,
        originSlug: row.originSlug,
        matchesGroup,
        branch: row.branch,
        upstream: row.upstream,
        ahead: checkout && typeof checkout.ahead === 'number' ? checkout.ahead : null,
        behind: checkout && typeof checkout.behind === 'number' ? checkout.behind : null,
        dirty: Boolean(row.dirty),
        dirtyCounts: dirtyCounts(checkout ? checkout.dirtyFiles : []),
        playbooks: Array.isArray(row.playbooks) ? row.playbooks : [],
        worktrees,
        bible: { commit: row.bibleCommit ?? null, dirty: bibleIsDirty(row) },
        vcs,
        probedAt: row.probedAt ?? null,
    };
}

/**
 * Register the project health / git-drawer endpoints against a supervisor
 * (../../supervisor/server.mjs's `route()` table).
 *
 * @param {{ route: (method: string, path: string, handler: Function) => void }} supervisor
 * @param {{ store: { db: any }, client: object }} [deps]
 * @returns {void}
 */
export function registerGitRoutes(supervisor, deps = {}) {
    const { store, client } = deps;
    const db = store.db;

    /** 501s and returns true when `client` lacks any of `methods`. Mirrors ../routes/projects.mjs's own `guardClient`. */
    function guardClient(res, methods) {
        const method = missingClientMethod(client, methods);
        if (method === null) return false;
        sendJson(res, 501, { error: 'client-missing-method', method });
        return true;
    }

    /** Run `fn`, mapping a ProjectBindError onto its own status/payload. Mirrors ../routes/projects.mjs's own `withBindErrors`. */
    async function withBindErrors(res, fn) {
        try {
            await fn();
        } catch (err) {
            if (err instanceof ProjectBindError) {
                sendJson(res, err.status, err.toPayload());
                return;
            }
            throw err;
        }
    }

    // -- GET /api/projects/:id/health : the S5 health panel -------------------
    supervisor.route('GET', '/api/projects/:id/health', async (req, res, ctx) => {
        if (guardClient(res, ['listMembers', 'executeCommand'])) return;
        await withBindErrors(res, async () => {
            sendJson(res, 200, await runHealth({ db, client }, ctx.params.id));
        });
    });

    // -- GET /api/projects/:id/members/:member/git : the S10 / W3 drawer ------
    supervisor.route('GET', '/api/projects/:id/members/:member/git', async (req, res, ctx) => {
        const wantsRefresh = ctx.url && ctx.url.searchParams.get('refresh') === '1';
        const methods = ['listMembers', 'memberDetail'];
        if (wantsRefresh) methods.push('memberGitStatus');
        if (guardClient(res, methods)) return;
        await withBindErrors(res, async () => {
            const result = await buildGitDrawer({ db, client }, ctx.params.id, ctx.params.member, { refresh: wantsRefresh });
            sendJson(res, 200, result);
        });
    });
}
