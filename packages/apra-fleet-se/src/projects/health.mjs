// =============================================================================
// Health panel checks and their aggregate (apra-fleet-vcnl.3)
// =============================================================================
//
// runHealth({db, client}, projectId) -> {project, checks, worst} (screen S5
// health panel, doc s3.1). Each of the eight checks below is its own
// exported, deliberately near-pure function: it takes ALREADY-FETCHED inputs
// (the project row, a member_git row, a listMembers/memberDetail record, an
// already-unwrapped command result) and returns either a single check object
// `{id, level: 'OK'|'WARN'|'FAIL', scope, message}` or `null` when the check
// has nothing to report for its input (memberDirty/staleProbe/vcsExpiry only
// ever report an ANOMALY -- a clean/fresh/token-less member contributes no
// row at all, matching the design doc's "WARN per member whose ..." /
// "members with no VCS token are not reported" wording). `runHealth` is the
// ONLY function here that does I/O: it gathers every check's inputs (probing
// the fleet client, reading the store) and calls the checks synchronously.
//
// `scope` is `'project'`, `'group:<originSlug>'`, or `'member:<name>'` --
// the S5 panel groups checks by this to render project/group/member rows.
//
// Collaborators, explicitly
// --------------------------
// Peer of ./projects.mjs, same as ./checkout.mjs: imports `getProject` from
// ./store/projects.mjs and `ProjectBindError` / `parseMemberList` /
// `BEADS_DIR_ENV` from ./projects.mjs (read-only). Imports `probeBeadsRemote`
// from ./routes/projects.mjs per this task's own instruction (reuse, don't
// re-implement the refs/dolt/data probe) -- this DOES form a module cycle
// with ./routes/git.mjs (which imports `runHealth` from here, and is called
// from ./routes/projects.mjs's `registerProjectRoutes`), but the cycle is
// benign: every binding involved is a hoisted function declaration that is
// never invoked during any of the three modules' own top-level evaluation,
// only later, once all three have finished loading.
//
// `buildGroups`, `dirtyCounts`, `bibleIsDirty`, `KB_CANONICAL_PATH`,
// `parseJsonResult` and `envStringGet` are exported ADDITIONALLY (beyond the
// eight checks + runHealth this task's acceptance criteria names) so
// ./routes/git.mjs's git-drawer endpoint can share the SAME grouping/dirty-
// bible logic `groupHasCodeMember`/`bibleInSync` use, rather than
// re-deriving "which members share an originSlug" a second, driftable way.
// =============================================================================

import { getProject } from './store/projects.mjs';
import { listMemberGit } from './store/member-git.mjs';
import { ProjectBindError, parseMemberList, BEADS_DIR_ENV } from './projects.mjs';
import { probeBeadsRemote } from './routes/projects.mjs';

/** The knowledge-bank export path member_git.status_json's dirtyFiles names when the bible has local changes. */
export const KB_CANONICAL_PATH = '.fleet/kb-canonical.json';

const WARN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // vcsExpiry: warn inside 7 days of expiry
const STALE_WINDOW_MS = 24 * 60 * 60 * 1000; // staleProbe: warn once a cached probe is older than this

// -- small, self-contained helpers (mirrors ./checkout.mjs's own copies) --

/** The human half of a two-halves (or bare-string) MCP result. */
function resultText(res) {
    const blocks = Array.isArray(res && res.content) ? res.content : [];
    const block = blocks.find((b) => b && typeof b.text === 'string' && !b.text.startsWith('<apra-fleet-display>'))
        ?? blocks[0];
    return block && typeof block.text === 'string' ? block.text : '';
}

/** Parse a JSON MCP result's text into an object, or null when it does not parse. */
export function parseJsonResult(res) {
    try {
        const parsed = JSON.parse(resultText(res));
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

/** The value of `env[key]` when it is a string, else null. */
export function envStringGet(env, key) {
    if (!env || typeof env !== 'object' || Array.isArray(env)) return null;
    const value = env[key];
    return typeof value === 'string' ? value : null;
}

/** Quote `value` for a member-bound command string only when it needs it (see ./checkout.mjs's own copy). */
function quoteArg(value) {
    const str = String(value);
    if (str.length === 0) return '""';
    if (!/[\s"']/.test(str)) return str;
    return `"${str.replace(/"/g, '\\"')}"`;
}

/**
 * Unwrap an execute_command result the way ./routes/projects.mjs's
 * `probeBeadsRemote` does: `isError` or a non-zero `structuredContent.
 * exitCode` is a failure, carrying the command's own text as detail.
 */
function unwrapExec(res) {
    const text = res && res.content && res.content[0] ? res.content[0].text : '';
    if (res && res.isError) {
        return { ok: false, stdout: '', detail: text || 'unknown error' };
    }
    const exitCode = res && res.structuredContent && typeof res.structuredContent.exitCode === 'number'
        ? res.structuredContent.exitCode
        : 0;
    const stdout = res && res.structuredContent && typeof res.structuredContent.stdout === 'string'
        ? res.structuredContent.stdout
        : text;
    if (exitCode !== 0) {
        return { ok: false, stdout, detail: text || `exited ${exitCode}` };
    }
    return { ok: true, stdout, detail: null };
}

/** Run `command` on `member`, never throwing -- a transport failure degrades to `{ok: false}`. */
async function safeExec(client, member, command) {
    try {
        return unwrapExec(await client.executeCommand({ member_name: member, command }));
    } catch (err) {
        return { ok: false, stdout: '', detail: err && err.message ? err.message : String(err) };
    }
}

/** The last few non-empty lines of a command's output/detail, for a WARN message. */
function outputTail(execResult, maxLines = 5) {
    const text = (execResult && (execResult.detail || execResult.stdout)) || '';
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    return lines.length > 0 ? lines.slice(-maxLines).join(' | ') : '(no output)';
}

/**
 * Group bound members (member_git rows) by `originSlug`, skipping members
 * with no checkout. Mirrors ./projects.mjs's `buildOverview` grouping, but
 * computed independently here: health checks are meant to be unit-testable
 * from raw rows without going through the overview read model (which also
 * lacks the `unreservable` field `groupHasCodeMember` needs).
 *
 * @param {object[]} rows member_git rows (see ./store/member-git.mjs).
 * @param {Map<string, object>} [byName] listMembers record keyed by member name.
 * @returns {Array<{ originSlug: string, members: Array<{ name: string, row: object, record: object|null }> }>}
 */
export function buildGroups(rows, byName = new Map()) {
    const map = new Map();
    for (const row of rows) {
        if (!row.originSlug) continue;
        if (!map.has(row.originSlug)) map.set(row.originSlug, []);
        map.get(row.originSlug).push({ name: row.member, row, record: byName.get(row.member) ?? null });
    }
    return [...map.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([originSlug, members]) => ({
            originSlug,
            members: members.sort((a, b) => a.name.localeCompare(b.name)),
        }));
}

/** `{modified, untracked, unmerged}` counts from a checkout's `dirtyFiles` (porcelain v2 XY codes). */
export function dirtyCounts(dirtyFiles) {
    const counts = { modified: 0, untracked: 0, unmerged: 0 };
    for (const f of Array.isArray(dirtyFiles) ? dirtyFiles : []) {
        if (!f || typeof f.code !== 'string') continue;
        const code = f.code.toLowerCase();
        if (code === '??') counts.untracked += 1;
        else if (code === 'uu') counts.unmerged += 1;
        else counts.modified += 1;
    }
    return counts;
}

/** Whether a member_git row's cached checkout lists the kb-canonical export as locally dirty. */
export function bibleIsDirty(row) {
    const dirtyFiles = row && row.statusJson && row.statusJson.checkout && Array.isArray(row.statusJson.checkout.dirtyFiles)
        ? row.statusJson.checkout.dirtyFiles
        : [];
    return dirtyFiles.some((f) => f && f.path === KB_CANONICAL_PATH);
}

// -- the eight checks -------------------------------------------------------

/**
 * Check 1: doltDataReachable. No `project.beads.remote` -> WARN (nothing to
 * probe); `probeResult.ok` -> OK; otherwise FAIL with the probe's own error.
 *
 * @param {{ project: object, probeResult: { ok: boolean, error?: string } | null }} input
 */
export function doltDataReachable({ project, probeResult }) {
    if (!project.beads.remote) {
        return { id: 'doltDataReachable', level: 'WARN', scope: 'project', message: 'no beads remote' };
    }
    if (probeResult && probeResult.ok) {
        return { id: 'doltDataReachable', level: 'OK', scope: 'project', message: `refs/dolt/data reachable at ${project.beads.remote}` };
    }
    const detail = probeResult && probeResult.error ? probeResult.error : 'probe failed';
    return { id: 'doltDataReachable', level: 'FAIL', scope: 'project', message: `refs/dolt/data unreachable at ${project.beads.remote}: ${detail}` };
}

/**
 * Check 2: backlogCloneStatus. `bd -C <project.beads.dir> dolt status` on the
 * backlog member -> OK on a zero exit, else WARN carrying the output tail.
 *
 * @param {{ project: object, execResult: { ok: boolean, stdout: string, detail: string|null } | null }} input
 */
export function backlogCloneStatus({ project, execResult }) {
    if (execResult && execResult.ok) {
        return { id: 'backlogCloneStatus', level: 'OK', scope: 'project', message: `bd dolt status clean on ${project.backlogMember}` };
    }
    return { id: 'backlogCloneStatus', level: 'WARN', scope: 'project', message: `bd dolt status non-zero on ${project.backlogMember}: ${outputTail(execResult)}` };
}

/**
 * Check 3: groupHasCodeMember. A checkout group needs at least one bound
 * member, other than the project's backlog member, that is not
 * `unreservable` -- else the group has nobody to do code work in it.
 *
 * @param {{ group: { originSlug: string, members: Array<{name:string, record: object|null}> }, backlogMember: string }} input
 */
export function groupHasCodeMember({ group, backlogMember }) {
    const codeMember = group.members.find((m) => m.name !== backlogMember && !(m.record && m.record.unreservable));
    if (codeMember) {
        return { id: 'groupHasCodeMember', level: 'OK', scope: `group:${group.originSlug}`, message: `${group.originSlug} has a code member: ${codeMember.name}` };
    }
    return { id: 'groupHasCodeMember', level: 'WARN', scope: `group:${group.originSlug}`, message: `${group.originSlug} has no member for code roles` };
}

/**
 * Check 4: bibleInSync. A single-member group trivially passes. Otherwise
 * every member's `bibleCommit` must agree, and none may have the
 * kb-canonical export locally dirty -- else WARN naming the offending
 * members.
 *
 * @param {{ group: { originSlug: string, members: Array<{name:string, row:object}> } }} input
 */
export function bibleInSync({ group }) {
    const { members, originSlug } = group;
    if (members.length <= 1) {
        return { id: 'bibleInSync', level: 'OK', scope: `group:${originSlug}`, message: `${originSlug}: single member, nothing to compare` };
    }

    const commits = new Set(members.map((m) => m.row.bibleCommit ?? null));
    const dirtyMembers = members.filter((m) => bibleIsDirty(m.row)).map((m) => m.name);

    if (commits.size <= 1 && dirtyMembers.length === 0) {
        return { id: 'bibleInSync', level: 'OK', scope: `group:${originSlug}`, message: `${originSlug}: bible in sync across ${members.map((m) => m.name).join(', ')}` };
    }

    const reasons = [];
    if (commits.size > 1) reasons.push(`differing bible commits across ${members.map((m) => m.name).join(', ')}`);
    if (dirtyMembers.length > 0) reasons.push(`${KB_CANONICAL_PATH} dirty on ${dirtyMembers.join(', ')}`);
    return { id: 'bibleInSync', level: 'WARN', scope: `group:${originSlug}`, message: `${originSlug}: ${reasons.join('; ')}` };
}

/**
 * Check 5: beadsDirSyncRemote (s4.5 rule 3). Returns null when the project
 * has no beads remote at all (check 1 already covers that gap at project
 * scope). Otherwise: no `BEADS_DIR` on the member -> WARN; the exec probe
 * itself failing (including a thrown transport error) -> FAIL; a mismatched
 * remote -> FAIL naming both; matching -> OK.
 *
 * @param {{ member: string, beadsDir: string|null, execResult: {ok:boolean, stdout:string, detail:string|null}|null, expectedRemote: string|null|undefined }} input
 */
export function beadsDirSyncRemote({ member, beadsDir, execResult, expectedRemote }) {
    if (!expectedRemote) return null;
    if (!beadsDir) {
        return { id: 'beadsDirSyncRemote', level: 'WARN', scope: `member:${member}`, message: `${member} has no BEADS_DIR configured` };
    }
    if (!execResult || !execResult.ok) {
        const detail = execResult && execResult.detail ? `: ${execResult.detail}` : '';
        return { id: 'beadsDirSyncRemote', level: 'FAIL', scope: `member:${member}`, message: `${member}: sync.remote probe failed${detail}` };
    }
    const actual = execResult.stdout.trim();
    if (actual === expectedRemote) {
        return { id: 'beadsDirSyncRemote', level: 'OK', scope: `member:${member}`, message: `${member}: sync.remote matches ${expectedRemote}` };
    }
    return { id: 'beadsDirSyncRemote', level: 'FAIL', scope: `member:${member}`, message: `${member}: sync.remote '${actual}' does not match project remote '${expectedRemote}'` };
}

/**
 * Check 6: memberDirty. Reports only when the member's cached checkout is
 * dirty -- a clean member contributes no check at all.
 *
 * @param {{ member: string, row: object|null }} input
 */
export function memberDirty({ member, row }) {
    if (!row || !row.dirty) return null;
    return { id: 'memberDirty', level: 'WARN', scope: `member:${member}`, message: `${member} has uncommitted changes` };
}

/**
 * Check 7: vcsExpiry. Members with no `vcsTokenExpiresAt` are not reported
 * at all. Already expired -> FAIL; expiring within 7 days -> WARN; otherwise
 * OK.
 *
 * @param {{ member: string, vcsTokenExpiresAt: string|null|undefined, now?: Date }} input
 */
export function vcsExpiry({ member, vcsTokenExpiresAt, now = new Date() }) {
    if (!vcsTokenExpiresAt) return null;
    const expires = new Date(vcsTokenExpiresAt);
    if (Number.isNaN(expires.getTime())) return null;
    const msLeft = expires.getTime() - now.getTime();
    if (msLeft < 0) {
        return { id: 'vcsExpiry', level: 'FAIL', scope: `member:${member}`, message: `${member}: VCS token expired at ${vcsTokenExpiresAt}` };
    }
    if (msLeft <= WARN_WINDOW_MS) {
        const days = Math.max(0, Math.ceil(msLeft / (24 * 60 * 60 * 1000)));
        return { id: 'vcsExpiry', level: 'WARN', scope: `member:${member}`, message: `${member}: VCS token expires in ${days} day(s) (${vcsTokenExpiresAt})` };
    }
    return { id: 'vcsExpiry', level: 'OK', scope: `member:${member}`, message: `${member}: VCS token valid until ${vcsTokenExpiresAt}` };
}

/**
 * Check 8: staleProbe (risk 2 -- the cache is best-effort). No `probedAt` at
 * all, or one older than 24h -> WARN; a fresh probe contributes no check.
 *
 * @param {{ member: string, probedAt: string|null|undefined, now?: Date }} input
 */
export function staleProbe({ member, probedAt, now = new Date() }) {
    if (!probedAt) {
        return { id: 'staleProbe', level: 'WARN', scope: `member:${member}`, message: `${member}: never probed` };
    }
    const probedDate = new Date(probedAt);
    if (Number.isNaN(probedDate.getTime())) {
        return { id: 'staleProbe', level: 'WARN', scope: `member:${member}`, message: `${member}: probe timestamp unreadable` };
    }
    const ageMs = now.getTime() - probedDate.getTime();
    if (ageMs > STALE_WINDOW_MS) {
        const hours = Math.round(ageMs / (60 * 60 * 1000));
        return { id: 'staleProbe', level: 'WARN', scope: `member:${member}`, message: `${member}: last probed ${hours}h ago` };
    }
    return null;
}

/** OK < WARN < FAIL. */
const LEVEL_RANK = { OK: 0, WARN: 1, FAIL: 2 };

/** The most severe level across `checks`, or 'OK' when `checks` is empty. */
function worstLevel(checks) {
    let worst = 'OK';
    for (const check of checks) {
        if (LEVEL_RANK[check.level] > LEVEL_RANK[worst]) worst = check.level;
    }
    return worst;
}

/**
 * Gather every check's inputs and run the eight checks above. A failing
 * client call (a probe/exec that throws, or listMembers being unreachable)
 * degrades ONLY the check(s) that needed it -- never the whole response --
 * by turning the failure into that check's own FAIL/WARN level rather than
 * propagating.
 *
 * @param {{db: any, client: object}} deps
 * @param {string} projectId
 * @returns {Promise<{ project: object, checks: Array<{id:string, level:string, scope:string, message:string}>, worst: string }>}
 * @throws {ProjectBindError} 404 project-not-found.
 */
export async function runHealth({ db, client }, projectId) {
    const project = getProject(db, projectId);
    if (!project) throw new ProjectBindError(404, 'project-not-found', `no project '${projectId}'`);

    const rows = listMemberGit(db, projectId);

    let records = [];
    try {
        records = parseMemberList(await client.listMembers({ format: 'json' }));
    } catch { /* live columns (unreservable, vcsTokenExpiresAt, env) degrade to absent below */ }
    const byName = new Map(records.filter((r) => r && typeof r.name === 'string').map((r) => [r.name, r]));

    const groups = buildGroups(rows, byName);
    const checks = [];

    // 1. doltDataReachable
    let probeResult = null;
    if (project.beads.remote) {
        try {
            probeResult = await probeBeadsRemote(client, project.backlogMember, project.beads.remote);
        } catch (err) {
            probeResult = { ok: false, error: err && err.message ? err.message : String(err) };
        }
    }
    checks.push(doltDataReachable({ project, probeResult }));

    // 2. backlogCloneStatus
    const cloneExec = await safeExec(client, project.backlogMember, `bd -C ${quoteArg(project.beads.dir)} dolt status`);
    checks.push(backlogCloneStatus({ project, execResult: cloneExec }));

    // 3 & 4: per checkout group
    for (const group of groups) {
        checks.push(groupHasCodeMember({ group, backlogMember: project.backlogMember }));
        checks.push(bibleInSync({ group }));
    }

    // 5, 6, 7, 8: per bound member
    for (const row of rows) {
        const record = byName.get(row.member) ?? null;
        const beadsDir = envStringGet(record && record.env, BEADS_DIR_ENV);

        if (project.beads.remote) {
            const execResult = beadsDir
                ? await safeExec(client, row.member, `bd -C ${quoteArg(beadsDir)} config get sync.remote`)
                : null;
            const check = beadsDirSyncRemote({ member: row.member, beadsDir, execResult, expectedRemote: project.beads.remote });
            if (check) checks.push(check);
        }

        const dirty = memberDirty({ member: row.member, row });
        if (dirty) checks.push(dirty);

        const expiry = vcsExpiry({ member: row.member, vcsTokenExpiresAt: record ? record.vcsTokenExpiresAt : null });
        if (expiry) checks.push(expiry);

        const stale = staleProbe({ member: row.member, probedAt: row.probedAt });
        if (stale) checks.push(stale);
    }

    return { project, checks, worst: worstLevel(checks) };
}
