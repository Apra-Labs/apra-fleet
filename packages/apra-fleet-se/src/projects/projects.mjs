// =============================================================================
// Project <-> member binding domain (apra-fleet-vcnl.1.1)
// =============================================================================
//
// bind / unbind / refresh one member against one project, plus the read model
// the project overview screen (design s3.1 "S5" row, wireframe W2) renders.
//
// Collaborators, explicitly
// --------------------------
// Every exported function takes `{db, client}` as its FIRST argument. There is
// no module-level state and no module-level connection: `db` is the open
// supervisor.sqlite handle (`openStore().db`, see ./store/db.mjs) and `client`
// is a fleet MCP client. That keeps this module a pure function of its
// collaborators, so routes/projects.mjs can pass the request-scoped pair and
// tests can pass fakes without a reset hook between cases.
//
// Which client methods, and why each one
// ---------------------------------------
//   * `listMembers({format:'json'})` -- the ONLY source of a member's current
//     `env` map, `type` (local|remote), `owner` tag and `vcsTokenExpiresAt`.
//     We must read it before every env write because update_member's `env` has
//     REPLACE semantics (src/tools/update-member.ts: "Replace this member's
//     env map"), so writing `{BEADS_DIR}` alone would silently drop every
//     other key the operator set. MERGE, never replace.
//   * `memberOwner({action:'set'|'clear', package, ref})` -- the owner tag.
//   * `updateMember({env})` -- the merged env write.
//   * `memberGitStatus({member_name})` -- the git probe whose result is cached
//     in `member_git`.
//
// Branch on `structuredContent.outcome`, never on the summary text
// ----------------------------------------------------------------
// member_owner and member_git_status both return the two-halves MCP result
// (`content[0].text` is prose for a human, `structuredContent` is the machine
// half). Every decision here reads `structuredContent.outcome`. update_member
// is the one exception, and deliberately so: it has NO structuredContent at
// all (it returns a bare string through wrapTool), so `envWriteFailed()` below
// is the single, isolated place that must fall back to inspecting its text --
// see that function's own note.
//
// Why an env write failure does NOT undo the bind
// -----------------------------------------------
// The owner tag is the bind. Once member_owner has taken effect, rolling it
// back because a follow-on env write failed would leave the operator with a
// member that is neither bound nor cleanly unbound, and the owner clear could
// itself fail. So the bind stands, and the failure is surfaced twice instead:
// as a `env-write-failed` entry in the returned `warnings`, and inside the
// cached row's `status_json.warnings` so the health panel shows it on a later
// read that never saw this response. Same for a failed probe
// (`probe-failed`): the row is still written, carrying the error.
//
// What is NOT written on a refusal
// ---------------------------------
// A 409 (member held, or owned by another project) or a 502 from the owner set
// happens BEFORE any store write, so a refused bind leaves `member_git`
// exactly as it was. Only the probe step writes.
// =============================================================================

import { getProject } from './store/projects.mjs';
import {
    upsertMemberGit,
    getMemberGit,
    listMemberGit,
    deleteMemberGit,
} from './store/member-git.mjs';

/**
 * The `owner.package` value this package stamps on every member it binds. The
 * `owner.ref` half is always the project id, so a member's owner tag answers
 * "which fleet-sprint project holds this member" without a second lookup.
 *
 * Reconciled against the workflow-package id (apra-fleet-vcnl.13): three
 * candidates were on the table -- 'fleet-sprint' (this constant today, and
 * the name packages/apra-fleet-se/workflow.json declares), 'se' (the S8 epic
 * text, DQ-28), and 'fleet-supervisor' (design doc s3.1). 'fleet-sprint' wins
 * because it is the id workflow.json actually declares, which is the only
 * source read here rather than guessed. OPEN QUESTION: the S7 registration
 * work (src/registration/**) had not yet landed a manifest id on
 * origin/v0.5_dashboard as of this reconciliation, so there was no second,
 * independently-landed id to cross-check against -- re-verify this constant
 * once S7's manifest lands. test/projects-bind.test.mjs's drift assertion
 * only guards this constant against workflow.json drift, not against a
 * future S7 manifest id that turns out to differ from both.
 */
export const OWNER_PACKAGE = 'fleet-sprint';

/** The env key a bound member gets, pointing at the project's beads dir. */
export const BEADS_DIR_ENV = 'BEADS_DIR';

/**
 * A refusal with the HTTP status the route layer should answer. Carries a
 * machine-readable `code` (the `error` field of the JSON body) plus the
 * originating tool's `text` as `detail`, so the operator sees the fleet
 * server's own words rather than a paraphrase of them.
 */
export class ProjectBindError extends Error {
    /**
     * @param {number} status
     * @param {string} code
     * @param {string} [detail]
     */
    constructor(status, code, detail) {
        super(detail ? `${code}: ${detail}` : code);
        this.name = 'ProjectBindError';
        this.status = status;
        this.code = code;
        this.detail = detail ?? null;
    }

    /** The JSON body for this refusal. */
    toPayload() {
        return this.detail === null
            ? { error: this.code }
            : { error: this.code, detail: this.detail };
    }
}

/** Current time as an ISO string; one seam so tests can read it back exactly. */
function nowIso() {
    return new Date().toISOString();
}

/**
 * The human half of a two-halves MCP result. Skips the onboarding
 * `<apra-fleet-display>` preamble block wrapTool() prepends
 * (src/services/tool-registry.ts), which is why this does not blindly take
 * `content[0]` -- the same correction supervisor/fleet-members.mjs already
 * carries.
 *
 * @param {any} res
 * @returns {string}
 */
function resultText(res) {
    const blocks = Array.isArray(res && res.content) ? res.content : [];
    const block = blocks.find((b) => b && typeof b.text === 'string' && !b.text.startsWith('<apra-fleet-display>'))
        ?? blocks[0];
    return block && typeof block.text === 'string' ? block.text : '';
}

/**
 * Parse `list_members --format json` out of an MCP result into its `members`
 * array. Returns `[]` rather than throwing on an unparseable body: the callers
 * below turn "member absent from the list" into their own 404, which is a
 * better answer than a 500 from a JSON.parse.
 *
 * @param {any} res
 * @returns {object[]}
 */
export function parseMemberList(res) {
    let parsed;
    try {
        parsed = JSON.parse(resultText(res));
    } catch {
        return [];
    }
    if (Array.isArray(parsed)) return parsed;
    return Array.isArray(parsed && parsed.members) ? parsed.members : [];
}

/**
 * Read one member's registry record by friendly name.
 *
 * @param {{ listMembers: Function }} client
 * @param {string} member
 * @returns {Promise<object | null>}
 */
async function readMember(client, member) {
    const res = await client.listMembers({ format: 'json' });
    const found = parseMemberList(res).find((m) => m && m.name === member);
    return found ?? null;
}

/** Whether `owner` is a tag belonging to some OTHER project than `projectId`. */
function isOwnedElsewhere(owner, projectId) {
    if (!owner || typeof owner !== 'object') return false;
    return !(owner.package === OWNER_PACKAGE && owner.ref === projectId);
}

/**
 * Map a member_owner result onto either "it took effect" or a refusal.
 * `member_held` is a 409 the operator can act on (release the sprint holding
 * the member); anything else that did not take effect is a 502, because the
 * fleet server refused for a reason this layer cannot interpret.
 *
 * On a `clear`, `member_not_found` is NOT an error: there is no owner tag left
 * to clear, and refusing would strand the cached row forever with no way to
 * unbind a member that has since been removed from the fleet. It is reported
 * as a warning instead.
 *
 * @param {any} res
 * @param {'set' | 'clear'} action
 * @returns {{ ok: true, warnings: string[] }}
 * @throws {ProjectBindError}
 */
function assertOwnerApplied(res, action) {
    const outcome = res && res.structuredContent ? res.structuredContent.outcome : undefined;
    const text = resultText(res);
    const expected = action === 'set' ? 'set' : 'cleared';
    if (outcome === expected) return { ok: true, warnings: [] };
    if (outcome === 'member_held') {
        throw new ProjectBindError(409, 'member-held', text);
    }
    if (action === 'clear' && outcome === 'member_not_found') {
        return { ok: true, warnings: ['owner-clear-member-missing'] };
    }
    throw new ProjectBindError(502, 'member-owner-failed', text || `member_owner returned outcome '${outcome}'`);
}

/**
 * U+274C CROSS MARK -- the leading character update_member writes ahead of
 * every "Member was NOT updated." refusal. Built from its code point rather
 * than pasted, because this repo forbids writing non-ASCII characters into any
 * file; the comparison below still matches the real character at runtime.
 */
const CROSS_MARK = String.fromCodePoint(0x274C);

/**
 * Whether an update_member result reports a failure.
 *
 * update_member is the ONE fleet tool consulted here with no
 * `structuredContent` to branch on -- it returns a bare summary string
 * (src/tools/update-member.ts returns `string`; wrapTool does not add an
 * outcome or set isError for it). So the only signals available are an MCP
 * transport-level `isError` and the leading failure marker the tool itself
 * writes ahead of every "Member was NOT updated." refusal (CROSS_MARK above).
 *
 * This is not a licence to text-match elsewhere: member_owner and
 * member_git_status both DO carry an outcome, and are branched on it above.
 *
 * @param {any} res
 * @returns {boolean}
 */
function envWriteFailed(res) {
    if (res && res.isError) return true;
    const text = resultText(res).trimStart();
    return text.startsWith(CROSS_MARK) || text.startsWith('[FAIL]') || text.startsWith('[-]');
}

/**
 * Write `env` onto a member, tolerating failure as a warning rather than
 * throwing. Callers pass an ALREADY-MERGED map (see the module header on
 * update_member's replace semantics).
 *
 * @param {{ updateMember: Function }} client
 * @param {string} member
 * @param {Record<string, string>} env
 * @returns {Promise<string[]>} `['env-write-failed']` on failure, else `[]`.
 */
async function writeEnv(client, member, env) {
    try {
        const res = await client.updateMember({ member_name: member, env });
        return envWriteFailed(res) ? ['env-write-failed'] : [];
    } catch {
        return ['env-write-failed'];
    }
}

/**
 * Only the string-valued entries of a member's env map. update_member's schema
 * is `record(string, string)`, so a non-string value read back from the
 * registry would be rejected on the way in -- dropping it here keeps a merge
 * from turning into a failed write.
 *
 * @param {unknown} env
 * @returns {Record<string, string>}
 */
function stringEnv(env) {
    if (!env || typeof env !== 'object' || Array.isArray(env)) return {};
    const out = {};
    for (const [key, value] of Object.entries(env)) {
        if (typeof value === 'string') out[key] = value;
    }
    return out;
}

/**
 * Probe a member's git state and cache it in `member_git`. ALWAYS writes a
 * row -- the three outcomes differ only in what the row holds:
 *
 *   * `checkout`     -- every promoted column filled from `structuredContent.checkout`.
 *   * `no_checkout`   -- a bound member with no checkout: all checkout columns
 *                        null, which is a normal answer (DQ-27), not an error.
 *   * anything else   -- columns null, `status_json` carries the tool's error
 *                        and a `probe-failed` warning rides along.
 *
 * @param {{db: any, client: {memberGitStatus: Function}}} deps
 * @param {string} projectId
 * @param {string} member
 * @param {string[]} [carryWarnings] Warnings from earlier steps, persisted into status_json.
 * @returns {Promise<object>} The upserted row with a `warnings` array attached.
 */
async function probeAndCache({ db, client }, projectId, member, carryWarnings = []) {
    const warnings = [...carryWarnings];
    /** @type {any} */
    let structured;
    try {
        const res = await client.memberGitStatus({ member_name: member });
        structured = (res && res.structuredContent) ? res.structuredContent : { outcome: 'failed', error: resultText(res) || 'member_git_status returned no structuredContent' };
    } catch (err) {
        structured = { outcome: 'failed', error: err && err.message ? err.message : String(err) };
    }

    const outcome = structured.outcome;
    const checkout = outcome === 'checkout' && structured.checkout ? structured.checkout : null;
    if (outcome !== 'checkout' && outcome !== 'no_checkout') {
        warnings.push('probe-failed');
    }

    const row = upsertMemberGit(db, {
        projectId,
        member,
        originSlug: checkout ? (checkout.originSlug ?? null) : null,
        originUrl: checkout ? (checkout.originUrl ?? null) : null,
        checkoutPath: checkout ? (checkout.path ?? null) : null,
        branch: checkout ? (checkout.branch ?? null) : null,
        upstream: checkout ? (checkout.upstream ?? null) : null,
        dirty: checkout ? Boolean(checkout.dirty) : false,
        worktrees: checkout ? (checkout.worktrees ?? null) : null,
        playbooks: checkout ? (checkout.playbooks ?? null) : null,
        bibleCommit: checkout ? (checkout.bibleCommit ?? null) : null,
        statusJson: { ...structured, warnings },
        probedAt: nowIso(),
    });

    return { ...row, warnings };
}

/**
 * Bind `member` to `projectId`: stamp the owner tag, merge BEADS_DIR into the
 * member's env, and cache a fresh git probe. See the module header for the
 * ordering rationale and for why steps 4 and 5 degrade to warnings instead of
 * failing the bind.
 *
 * Idempotent: re-binding a member already bound to THIS project re-runs all
 * three steps (a no-op owner set server-side) and returns the refreshed row,
 * rather than refusing. Re-pointing a member owned by a DIFFERENT project is
 * refused 409 `member-owned-elsewhere` -- one project never silently steals
 * another's member.
 *
 * @param {{db: any, client: object}} deps
 * @param {string} projectId
 * @param {{member: string, beadsDir?: string}} input
 * @returns {Promise<object>} The cached row plus `warnings`.
 * @throws {ProjectBindError} 404 project-not-found / member-not-found,
 *   409 member-owned-elsewhere / member-held, 502 member-owner-failed.
 */
export async function bindMember({ db, client }, projectId, input = {}) {
    const memberName = input.member;
    const project = getProject(db, projectId);
    if (!project) throw new ProjectBindError(404, 'project-not-found', `no project '${projectId}'`);

    const record = await readMember(client, memberName);
    if (!record) throw new ProjectBindError(404, 'member-not-found', `no member '${memberName}'`);
    if (isOwnedElsewhere(record.owner, projectId)) {
        throw new ProjectBindError(
            409,
            'member-owned-elsewhere',
            `member '${memberName}' is owned by ${record.owner.package}@${record.owner.ref}`,
        );
    }

    const ownerRes = await client.memberOwner({
        member_name: memberName,
        action: 'set',
        package: OWNER_PACKAGE,
        ref: projectId,
    });
    const warnings = [...assertOwnerApplied(ownerRes, 'set').warnings];

    // MERGE, never replace: update_member's env has replace semantics. The
    // beadsDir override exists for a project whose beads dir differs per
    // member (a member-local clone); it defaults to the project's own dir.
    const beadsDir = input.beadsDir ?? project.beads.dir;
    warnings.push(...await writeEnv(client, memberName, {
        ...stringEnv(record.env),
        [BEADS_DIR_ENV]: beadsDir,
    }));

    return probeAndCache({ db, client }, projectId, memberName, warnings);
}

/**
 * Unbind `member` from `projectId`: clear the owner tag, remove ONLY the
 * BEADS_DIR key from the member's env (every other key the operator set is
 * kept), and drop the cached row.
 *
 * A held member refuses 409 with the store untouched -- the row is deleted
 * only after the owner clear has taken effect, so a refused unbind never
 * leaves a bound member with no cache row.
 *
 * @param {{db: any, client: object}} deps
 * @param {string} projectId
 * @param {string} member
 * @returns {Promise<{unbound: true, warnings: string[]}>}
 * @throws {ProjectBindError} 404 project-not-found / member-not-bound,
 *   409 member-held, 502 member-owner-failed.
 */
export async function unbindMember({ db, client }, projectId, member) {
    const project = getProject(db, projectId);
    if (!project) throw new ProjectBindError(404, 'project-not-found', `no project '${projectId}'`);
    if (!getMemberGit(db, projectId, member)) {
        throw new ProjectBindError(404, 'member-not-bound', `member '${member}' is not bound to project '${projectId}'`);
    }

    // Read the env BEFORE clearing the owner: the merge below needs the other
    // keys, and reading first keeps a listMembers failure from happening
    // after the owner tag is already gone.
    const record = await readMember(client, member);

    const ownerRes = await client.memberOwner({ member_name: member, action: 'clear' });
    const warnings = [...assertOwnerApplied(ownerRes, 'clear').warnings];

    if (record) {
        const env = stringEnv(record.env);
        delete env[BEADS_DIR_ENV];
        warnings.push(...await writeEnv(client, member, env));
    } else {
        warnings.push('member-not-found');
    }

    deleteMemberGit(db, projectId, member);
    return { unbound: true, warnings };
}

/**
 * Re-probe one already-bound member and refresh its cached row. Probe-and-
 * upsert only: no owner or env write, because the git drawer's refresh button
 * is asking "what does the checkout look like NOW", not "bind this again".
 *
 * @param {{db: any, client: object}} deps
 * @param {string} projectId
 * @param {string} member
 * @returns {Promise<object>} The refreshed row plus `warnings`.
 * @throws {ProjectBindError} 404 project-not-found / member-not-bound.
 */
export async function refreshMember({ db, client }, projectId, member) {
    const project = getProject(db, projectId);
    if (!project) throw new ProjectBindError(404, 'project-not-found', `no project '${projectId}'`);
    if (!getMemberGit(db, projectId, member)) {
        throw new ProjectBindError(404, 'member-not-bound', `member '${member}' is not bound to project '${projectId}'`);
    }
    return probeAndCache({ db, client }, projectId, member);
}

/** The most frequent non-null value in `values`, ties broken by sort order. */
function mostCommon(values) {
    const counts = new Map();
    for (const value of values) {
        if (value === null || value === undefined) continue;
        counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    if (counts.size === 0) return null;
    return [...counts.entries()]
        .sort((a, b) => (b[1] - a[1]) || String(a[0]).localeCompare(String(b[0])))[0][0];
}

/** `warnings` as persisted inside a cached row's status_json, or `[]`. */
function rowWarnings(row) {
    const status = row && row.statusJson;
    if (!status || typeof status !== 'object' || Array.isArray(status)) return [];
    return Array.isArray(status.warnings) ? status.warnings : [];
}

/**
 * One W2 member row: the cached git columns joined with the live registry
 * facts (`where`, `beadsDir`, `vcsTokenExpiresAt`, `owner`) that live on the
 * member, not in the cache.
 *
 * @param {string} member
 * @param {object | null} row A member_git row, or null for a never-probed member.
 * @param {object | undefined} record The listMembers record, when known.
 */
function overviewMember(member, row, record) {
    const env = stringEnv(record && record.env);
    const worktrees = row && Array.isArray(row.worktrees) ? row.worktrees.length : 0;
    return {
        name: member,
        where: record && record.type ? record.type : null,
        branch: row ? (row.branch ?? null) : null,
        dirty: row ? Boolean(row.dirty) : false,
        worktrees,
        beadsDir: env[BEADS_DIR_ENV] ?? null,
        vcsTokenExpiresAt: record && record.vcsTokenExpiresAt ? record.vcsTokenExpiresAt : null,
        owner: record && record.owner ? record.owner : null,
        probedAt: row ? (row.probedAt ?? null) : null,
        warnings: rowWarnings(row),
    };
}

/**
 * The project overview read model (screen S5, wireframe W2).
 *
 * Reads the `member_git` CACHE -- it never probes. The route layer re-probes
 * first when asked (`?refresh=1`), keeping "show me what we know" cheap and
 * making the network round trip an explicit request.
 *
 * Shape: `{project, backlogMember, groups, noCheckout, probedAt}`.
 *   * `groups` -- bound members that HAVE a checkout, grouped by
 *     `member_git.origin_slug` (one card per repo in W2), each carrying the
 *     group's most common `upstream` and the UNION of its members' playbooks.
 *     Sorted by originSlug, members by name.
 *   * `noCheckout` -- bound members whose origin_slug is null: a member with
 *     no checkout yet, or one whose probe failed. The project's backlog member
 *     ALWAYS appears somewhere in the model, landing here when it has no
 *     cached checkout, so the screen can never silently omit the one member
 *     the project cannot function without.
 *   * `probedAt` -- the most recent probe across every cached row, so the
 *     screen can date the whole panel; null when nothing has been probed.
 *
 * @param {{db: any, client: object}} deps
 * @param {string} projectId
 * @returns {Promise<object>}
 * @throws {ProjectBindError} 404 project-not-found.
 */
export async function buildOverview({ db, client }, projectId) {
    const project = getProject(db, projectId);
    if (!project) throw new ProjectBindError(404, 'project-not-found', `no project '${projectId}'`);

    // Best-effort: the cache alone still renders a usable panel, so a
    // listMembers failure degrades the live columns to null instead of 500ing
    // the whole overview.
    /** @type {Map<string, object>} */
    const records = new Map();
    try {
        for (const record of await readMemberList(client)) {
            if (record && typeof record.name === 'string') records.set(record.name, record);
        }
    } catch { /* live columns degrade to null */ }

    const rows = listMemberGit(db, projectId);
    const byMember = new Map(rows.map((row) => [row.member, row]));

    /** @type {Map<string, object[]>} */
    const grouped = new Map();
    const noCheckout = [];
    for (const row of rows) {
        const entry = overviewMember(row.member, row, records.get(row.member));
        if (!row.originSlug) {
            noCheckout.push(entry);
            continue;
        }
        if (!grouped.has(row.originSlug)) grouped.set(row.originSlug, []);
        grouped.get(row.originSlug).push(entry);
    }

    // The backlog member always appears, even when it was never bound/probed.
    if (!byMember.has(project.backlogMember)) {
        noCheckout.push(overviewMember(project.backlogMember, null, records.get(project.backlogMember)));
    }

    const byName = (a, b) => a.name.localeCompare(b.name);
    const groups = [...grouped.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([originSlug, members]) => {
            const slugRows = rows.filter((row) => row.originSlug === originSlug);
            const playbooks = new Set();
            for (const row of slugRows) {
                if (Array.isArray(row.playbooks)) for (const p of row.playbooks) playbooks.add(p);
            }
            return {
                originSlug,
                upstream: mostCommon(slugRows.map((row) => row.upstream ?? null)),
                playbooks: [...playbooks].sort(),
                members: members.sort(byName),
            };
        });

    const probedAtValues = rows.map((row) => row.probedAt).filter((v) => typeof v === 'string' && v.length > 0);
    const probedAt = probedAtValues.length > 0 ? probedAtValues.sort().at(-1) : null;

    return {
        project,
        backlogMember: project.backlogMember,
        groups,
        noCheckout: noCheckout.sort(byName),
        probedAt,
    };
}

/**
 * Every registered member, or `[]` when the client cannot list them. Split out
 * so buildOverview's degradation path and listBoundMembers share one read.
 *
 * @param {{listMembers?: Function}} client
 * @returns {Promise<object[]>}
 */
async function readMemberList(client) {
    if (!client || typeof client.listMembers !== 'function') return [];
    return parseMemberList(await client.listMembers({ format: 'json' }));
}

/**
 * The member names currently bound to a project (i.e. having a cached row) --
 * the set `?refresh=1` re-probes. Reads the store only.
 *
 * @param {any} db
 * @param {string} projectId
 * @returns {string[]}
 */
export function listBoundMembers(db, projectId) {
    return listMemberGit(db, projectId).map((row) => row.member);
}
