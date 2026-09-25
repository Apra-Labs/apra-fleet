// =============================================================================
// "Add checkout on <machine>" flow (apra-fleet-vcnl.2)
// =============================================================================
//
// suggestCheckoutName() (DQ-16 naming) and addCheckout() (the five-step,
// individually-idempotent flow of A10) that together let the console put a
// NEW checkout of a project's repo onto a machine that already has a sibling
// member registered on it.
//
// Collaborators, explicitly
// --------------------------
// Same shape as ./projects.mjs: every exported function takes `{db, client}`
// (addCheckout) or plain data (suggestCheckoutName) as its first argument.
// `client` is a fleet MCP client. This module is a peer of ./projects.mjs,
// not a layer on top of it: it imports `getProject` from ./store/projects.mjs
// directly, and imports OWNER_PACKAGE / BEADS_DIR_ENV / ProjectBindError /
// bindMember / parseMemberList from ./projects.mjs itself (read-only -- this
// module never edits that file, so the bind lane and this lane can land
// concurrently without a merge conflict).
//
// Which client methods, and why each one
// ---------------------------------------
//   * `listMembers({format:'json'})` -- the sibling's registry record (type,
//     host, username, llmProvider, shell, ssh_auth) and, later, the target
//     name's own record for the register/bind idempotency probes.
//   * `memberDetail({member_name, format:'json'})` -- the two connection
//     fields listMembers does not carry: `connectivity.keyPath` and
//     `vcsProvider`. Both are best-effort: memberDetail returns them only
//     when the member is reachable, so a copy that comes back empty simply
//     leaves the corresponding register_member field unset rather than
//     failing the step.
//   * `memberGitStatus({member_name, folder})` -- the clone step's own
//     idempotency probe (same tool ../projects.mjs's bind flow uses to cache
//     a git probe, called here with an explicit `folder` instead of the
//     member's registered work folder).
//   * `executeCommand({member_name, command})` -- `git clone` (on the
//     sibling, since the new checkout lands on the SAME machine) and the two
//     `bd` calls (on the newly registered member).
//   * `registerMember(...)` -- step 2. A bare-string MCP tool (no
//     structuredContent), same shape as update_member; failure is read off
//     its leading glyph, mirroring ../projects.mjs's `envWriteFailed`.
//   * `provisionVcsAuth` / `provisionLlmAuth` -- structured results
//     (`structuredContent.ok`); `composePermissions` is bare-string like
//     registerMember. All three are optional (step 5), run only when asked.
//
// code_intel_provider is NOT actually copyable today
// ----------------------------------------------------
// The parent feature's grounding notes list `code_intel_provider` among the
// sibling fields step 2 copies, but neither list_members' nor member_detail's
// JSON payload (src/tools/list-members.ts, src/tools/member-detail.ts)
// exposes Agent.codeIntelProvider today -- this module cannot edit those
// files (out of its scope: it may only add ./checkout.mjs and append routes
// in ./routes/projects.mjs). `siblingConnectionFields()` below still reads a
// `codeIntelProvider`/`code_intel_provider` key defensively, so the day that
// gap is closed this module picks the value up with no further change; until
// then it is simply omitted from the registerMember call.
//
// Every command string is a literal, resolved in JavaScript
// ------------------------------------------------------------
// No `$VAR`, `${VAR}`, `~`, or backtick ever survives into a dispatched
// command string here -- `checkoutDir`/`beadsDir` are absolute paths the
// caller supplies (rejected with 400 otherwise, see `pathValidationError`),
// and `quoteArg` is the ONE helper that quotes an argument containing
// whitespace. See fleet-sprint/shell-command-guard.mjs for the invariant this
// keeps.
// =============================================================================

import { getProject } from './store/projects.mjs';
import {
    OWNER_PACKAGE,
    BEADS_DIR_ENV,
    ProjectBindError,
    bindMember,
    parseMemberList,
} from './projects.mjs';

// -- naming (DQ-16) -----------------------------------------------------------

/**
 * Lowercase, replace every run of non `[a-z0-9-]` with a single `-`, and trim
 * leading/trailing dashes. Applied to each name COMPONENT independently so an
 * unsafe character in one component (e.g. an upper-cased machine name) never
 * bleeds a stray dash into its neighbour.
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeNamePart(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/**
 * Normalise a git remote (URL, scp-like `host:path`, or bare path) to a
 * `host/path` (or bare basename) identity, mirroring src/services/
 * git-status-probe.ts's `originSlugFromUrl` byte for byte -- this package has
 * no compile-time link to that module (a different, MCP-only package
 * boundary), and the clone step's idempotency probe (below) compares this
 * function's output against the SAME slug member_git_status computed
 * server-side, so the two must never drift.
 *
 * @param {string | null | undefined} url
 * @returns {string | null}
 */
export function originSlugFromUrl(url) {
    const raw = (url ?? '').trim();
    if (raw === '') return null;

    // scp-like syntax: [user@]host:path (no scheme). A Windows drive letter
    // ("C:\repos\x") is not a host, so a single-character host is excluded.
    const scp = /^(?:[^@/\\]+@)?([A-Za-z0-9.-]{2,}):(?!\/\/)(.+)$/.exec(raw);
    if (!raw.includes('://') && scp) {
        return normaliseHostPath(scp[1], scp[2]);
    }

    const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/.exec(raw);
    if (scheme) {
        const afterScheme = scheme[2].replace(/^[^@/]*@/, '');
        const slashIdx = afterScheme.indexOf('/');
        const authority = slashIdx === -1 ? afterScheme : afterScheme.slice(0, slashIdx);
        const rest = slashIdx === -1 ? '' : afterScheme.slice(slashIdx + 1);
        const host = authority.replace(/:\d+$/, '');
        if (host === '') return basenameSlug(rest);
        return normaliseHostPath(host, rest);
    }

    return basenameSlug(raw);
}

function normaliseHostPath(host, repoPath) {
    const cleanPath = repoPath.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
    const cleanHost = host.replace(/:\d+$/, '').toLowerCase();
    if (cleanHost === '') return basenameSlug(repoPath);
    const slug = cleanPath === '' ? cleanHost : `${cleanHost}/${cleanPath.toLowerCase()}`;
    return slug === '' ? null : slug;
}

function basenameSlug(candidate) {
    const parts = candidate.replace(/[\\/]+$/, '').split(/[\\/]/);
    const base = (parts[parts.length - 1] ?? '').replace(/\.git$/, '').toLowerCase();
    return base === '' ? null : base;
}

/**
 * Suggest a checkout member name (DQ-16): `<project>-<machine>-<origin-
 * short>[-<roleHint>]`.
 *
 * `machine` is `machineMember` with a leading `<projectId>-` stripped (an
 * exact-prefix match only; a sibling named e.g. "other-lin1" for project
 * "shop" is used as-is). `origin-short` is the last `/`-segment of
 * `originSlug` with a trailing `.git` stripped. Every component is then
 * lowercased and unsafe characters collapsed to `-` (`normalizeNamePart`).
 *
 * This is ONLY a suggestion: the caller (or the request body of
 * `addCheckout`) may override it with its own `name`, and an EXISTING member
 * is never renamed to match it.
 *
 * @param {{ projectId: string, machineMember: string, originSlug?: string | null, roleHint?: string }} input
 * @returns {string}
 */
export function suggestCheckoutName({ projectId, machineMember, originSlug, roleHint } = {}) {
    const prefix = `${projectId}-`;
    const machine = typeof machineMember === 'string' && machineMember.startsWith(prefix)
        ? machineMember.slice(prefix.length)
        : machineMember;

    const segments = String(originSlug ?? '').split('/').filter(Boolean);
    const lastSegment = segments.length > 0 ? segments[segments.length - 1] : '';
    const originShort = lastSegment.replace(/\.git$/i, '');

    return [projectId, machine, originShort, roleHint]
        .map(normalizeNamePart)
        .filter((part) => part.length > 0)
        .join('-');
}

// -- shared helpers -------------------------------------------------------

/**
 * Quote `value` for a member-bound command string ONLY when it contains
 * whitespace or a quote character; otherwise returned verbatim. This is the
 * single quoting helper every command string in this module goes through --
 * see the module header on why nothing here ever leans on the member shell's
 * own expansion.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function quoteArg(value) {
    const str = String(value);
    if (str.length === 0) return '""';
    if (!/[\s"']/.test(str)) return str;
    return `"${str.replace(/"/g, '\\"')}"`;
}

/**
 * The human half of a two-halves (or bare-string) MCP result. Mirrors
 * ../projects.mjs's own `resultText` -- duplicated rather than imported
 * because that module does not export it, and this module may not edit it
 * (see header).
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
 * U+274C CROSS MARK -- built from its code point (ASCII-only file
 * convention), matching ../projects.mjs's own CROSS_MARK.
 */
const CROSS_MARK = String.fromCodePoint(0x274C);

/**
 * Whether a BARE-STRING MCP result (register_member, compose_permissions)
 * reports failure. Mirrors ../projects.mjs's `envWriteFailed` -- these tools
 * carry no structuredContent to branch on, so the leading failure glyph is
 * the only signal.
 *
 * @param {any} res
 * @returns {boolean}
 */
function textActionFailed(res) {
    if (res && res.isError) return true;
    const text = resultText(res).trimStart();
    return text.startsWith(CROSS_MARK) || text.startsWith('[FAIL]') || text.startsWith('[-]');
}

/** A step result: `{status, detail}`, `detail` defaulting to null. */
function stepResult(status, detail = null) {
    return { status, detail };
}

/** `${code}` or `${code}: ${extra}` -- mirrors ProjectBindError's own message shape. */
function codeDetail(code, extra) {
    return extra ? `${code}: ${extra}` : code;
}

/**
 * Unwrap an execute_command result the way ./routes/projects.mjs's
 * `probeBeadsRemote` does: `isError` or a non-zero `structuredContent.
 * exitCode` is a failure, carrying the command's own text as detail.
 *
 * @param {any} res
 * @returns {{ ok: boolean, stdout: string, detail: string | null }}
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

/**
 * The value of `env[key]` when it is a string, else null. `env` may be
 * absent/non-object (an un-probed or legacy record).
 *
 * @param {unknown} env
 * @param {string} key
 * @returns {string | null}
 */
function envStringGet(env, key) {
    if (!env || typeof env !== 'object' || Array.isArray(env)) return null;
    const value = env[key];
    return typeof value === 'string' ? value : null;
}

/**
 * Reject a value that is not an absolute path: empty/non-string, a leading
 * `~`, an embedded `$`, or a path that is neither POSIX-absolute
 * (`/...`), Windows drive-absolute (`C:\...` / `C:/...`), nor a UNC share
 * (`\\server\share`). Mirrors src/utils/work-folder-validation.ts's
 * `isFullyQualifiedPath` (a different, MCP-only package boundary -- see the
 * module header) plus the `$`/`~` checks the parent feature's DQ-16 spec adds
 * on top of it for a member-bound path.
 *
 * @param {unknown} value
 * @param {string} field
 * @returns {string | null} A human-readable reason, or null when valid.
 */
function pathValidationError(value, field) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        return `'${field}' must be a non-empty string`;
    }
    const trimmed = value.trim();
    if (trimmed.startsWith('~')) {
        return `'${field}' must not start with '~' -- resolve it in JavaScript before sending an absolute path`;
    }
    if (trimmed.includes('$')) {
        return `'${field}' must not contain '$' -- resolve any variable in JavaScript before sending a literal path`;
    }
    const isAbsolute = trimmed.startsWith('/')
        || /^[A-Za-z]:[\\/]/.test(trimmed)
        || /^\\\\[^\\/]/.test(trimmed);
    if (!isAbsolute) {
        return `'${field}' must be an absolute path`;
    }
    return null;
}

/**
 * Parse a JSON MCP result's text into an object, or null when it does not
 * parse (a transport-level failure, or a member's own connectivity failure --
 * member_detail still returns SOME JSON in that case, but a non-JSON string
 * result from a wildly different client is tolerated here rather than
 * thrown).
 *
 * @param {any} res
 * @returns {object | null}
 */
function parseJsonResult(res) {
    try {
        const parsed = JSON.parse(resultText(res));
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * `{host, port}` parsed out of a listMembers record's combined `host` field
 * (`"1.2.3.4:22"`, or `"(local)"`/`"(relay)"` for non-remote types -- see
 * src/utils/agent-helpers.ts's `formatAgentHost`, the SAME formatter that
 * produced this string). Only meaningful for `type === 'remote'`.
 *
 * @param {{ type?: string, host?: string }} record
 * @returns {{ host?: string, port?: number }}
 */
function siblingHostPort(record) {
    if (!record || record.type !== 'remote' || typeof record.host !== 'string') return {};
    const idx = record.host.lastIndexOf(':');
    if (idx === -1) return { host: record.host };
    const host = record.host.slice(0, idx);
    const port = Number(record.host.slice(idx + 1));
    return Number.isFinite(port) ? { host, port } : { host };
}

// -- addCheckout: the five-step, individually-idempotent flow (A10) -------

/**
 * Step 1: clone. Probes `checkoutDir` on `siblingMember` via
 * `memberGitStatus`; a checkout already there with the SAME origin slug and
 * no local changes is a no-op (`skipped`); a dirty checkout, or one pointing
 * at a different origin, is refused (`failed 'checkout-dir-conflict'`) and
 * NEVER touched; no checkout there clones it via `executeCommand`.
 */
async function cloneStep({ client }, { siblingMember, originUrl, checkoutDir, originSlug }) {
    let res;
    try {
        res = await client.memberGitStatus({ member_name: siblingMember, folder: checkoutDir });
    } catch (err) {
        return stepResult('failed', `memberGitStatus threw: ${err && err.message ? err.message : String(err)}`);
    }
    const structured = res && res.structuredContent ? res.structuredContent : null;
    const outcome = structured ? structured.outcome : null;

    if (outcome === 'checkout') {
        const checkout = structured.checkout ?? {};
        if (checkout.dirty) {
            return stepResult('failed', codeDetail('checkout-dir-conflict', 'existing checkout at this path has local changes'));
        }
        if (checkout.originSlug !== originSlug) {
            return stepResult('failed', codeDetail('checkout-dir-conflict', `existing checkout origin '${checkout.originSlug}' does not match requested '${originSlug}'`));
        }
        return stepResult('skipped', 'checkout already present with matching origin');
    }

    if (outcome === 'no_checkout') {
        const command = `git clone ${quoteArg(originUrl)} ${quoteArg(checkoutDir)}`;
        let cloneRes;
        try {
            cloneRes = await client.executeCommand({ member_name: siblingMember, command });
        } catch (err) {
            return stepResult('failed', `git clone threw: ${err && err.message ? err.message : String(err)}`);
        }
        const unwrapped = unwrapExec(cloneRes);
        return unwrapped.ok ? stepResult('done') : stepResult('failed', unwrapped.detail || 'git clone failed');
    }

    return stepResult('failed', (structured && structured.error) || `memberGitStatus returned outcome '${outcome}'`);
}

/**
 * Step 2: register. Skips when a member already carries `name` with the
 * SAME host and work folder this call would have registered (idempotent
 * re-run); refuses `failed 'name-taken'` when `name` is taken by a member at
 * a DIFFERENT host/folder; refuses `failed 'sibling-password-auth-
 * unsupported'` when the sibling uses SSH password auth (passwords are never
 * copied). Otherwise registers a new member with connection fields copied
 * from the sibling -- see the module header for exactly which fields, and
 * from which of listMembers/memberDetail, each comes.
 */
async function registerStep({ client }, { name, siblingMember, siblingRecord, checkoutDir, projectId, beadsDir }) {
    const records = parseMemberList(await client.listMembers({ format: 'json' }));
    const expectedHost = siblingRecord.host;
    const existing = records.find((r) => r && r.name === name);
    if (existing) {
        if (existing.host === expectedHost && existing.folder === checkoutDir) {
            return stepResult('skipped', 'member already registered at this host and folder');
        }
        return stepResult('failed', codeDetail('name-taken', `'${name}' is already registered at ${existing.host} : ${existing.folder}`));
    }

    if (siblingRecord.type === 'remote' && siblingRecord.ssh_auth === 'password') {
        return stepResult('failed', 'sibling-password-auth-unsupported');
    }

    let detailRes;
    try {
        detailRes = await client.memberDetail({ member_name: siblingMember, format: 'json' });
    } catch (err) {
        return stepResult('failed', `memberDetail threw: ${err && err.message ? err.message : String(err)}`);
    }
    const siblingDetail = parseJsonResult(detailRes) ?? {};

    const registerInput = {
        friendly_name: name,
        member_type: siblingRecord.type,
        work_folder: checkoutDir,
        llm_provider: siblingRecord.llmProvider,
        owner: { package: OWNER_PACKAGE, ref: projectId },
        env: { [BEADS_DIR_ENV]: beadsDir },
    };
    if (siblingRecord.shell) registerInput.shell = siblingRecord.shell;

    if (siblingRecord.type === 'remote') {
        Object.assign(registerInput, siblingHostPort(siblingRecord));
        if (siblingRecord.username) registerInput.username = siblingRecord.username;
        if (siblingRecord.ssh_auth) registerInput.auth_type = siblingRecord.ssh_auth;
        const keyPath = siblingDetail.connectivity && typeof siblingDetail.connectivity.keyPath === 'string'
            ? siblingDetail.connectivity.keyPath
            : null;
        if (keyPath) registerInput.key_path = keyPath;
    }

    if (siblingDetail.vcsProvider) registerInput.vcs_provider = siblingDetail.vcsProvider;
    // See the module header: neither client method actually exposes this
    // field today. Read defensively so a future fix needs no change here.
    const codeIntel = siblingDetail.codeIntelProvider ?? siblingDetail.code_intel_provider;
    if (codeIntel) registerInput.code_intel_provider = codeIntel;

    let res;
    try {
        res = await client.registerMember(registerInput);
    } catch (err) {
        return stepResult('failed', `registerMember threw: ${err && err.message ? err.message : String(err)}`);
    }
    return textActionFailed(res) ? stepResult('failed', resultText(res) || 'registerMember refused') : stepResult('done');
}

/**
 * Step 3: beads bootstrap. Skipped entirely when the project has no
 * `beads.remote` (a purely local beads dir has nothing to bootstrap from).
 * Otherwise probes `sync.remote` on the NEW member; already equal to
 * `project.beads.remote` skips, else the remote is written and `bd bootstrap`
 * is run non-interactively against it.
 */
async function bootstrapStep({ client }, { name, beadsDir, project }) {
    const remote = project.beads.remote;
    if (!remote) return stepResult('skipped', 'no beads remote');

    const getCommand = `bd -C ${quoteArg(beadsDir)} config get sync.remote`;
    let getRes;
    try {
        getRes = await client.executeCommand({ member_name: name, command: getCommand });
    } catch (err) {
        return stepResult('failed', `bd config get threw: ${err && err.message ? err.message : String(err)}`);
    }
    const getUnwrapped = unwrapExec(getRes);
    if (getUnwrapped.ok && getUnwrapped.stdout.trim() === remote) {
        return stepResult('skipped', 'sync.remote already configured');
    }

    const setCommand = `bd -C ${quoteArg(beadsDir)} config set sync.remote ${quoteArg(remote)}`;
    let setRes;
    try {
        setRes = await client.executeCommand({ member_name: name, command: setCommand });
    } catch (err) {
        return stepResult('failed', `bd config set threw: ${err && err.message ? err.message : String(err)}`);
    }
    const setUnwrapped = unwrapExec(setRes);
    if (!setUnwrapped.ok) return stepResult('failed', setUnwrapped.detail || 'bd config set failed');

    const bootstrapCommand = `bd -C ${quoteArg(beadsDir)} bootstrap --yes`;
    let bootstrapRes;
    try {
        bootstrapRes = await client.executeCommand({ member_name: name, command: bootstrapCommand });
    } catch (err) {
        return stepResult('failed', `bd bootstrap threw: ${err && err.message ? err.message : String(err)}`);
    }
    const bootstrapUnwrapped = unwrapExec(bootstrapRes);
    return bootstrapUnwrapped.ok ? stepResult('done') : stepResult('failed', bootstrapUnwrapped.detail || 'bd bootstrap failed');
}

/**
 * Step 4: bind. Reuses ../projects.mjs's `bindMember` -- but only when it is
 * not ALREADY a no-op: when the new member's own owner tag and `BEADS_DIR`
 * env entry already match this project/dir, bindMember is never called at
 * all, so a re-run of `addCheckout` issues zero of bindMember's own mutating
 * calls (member_owner set, update_member) on top of the ones this step would
 * otherwise repeat.
 */
async function bindStep({ db, client }, { projectId, name, beadsDir }) {
    const records = parseMemberList(await client.listMembers({ format: 'json' }));
    const record = records.find((r) => r && r.name === name);
    const alreadyBound = !!record
        && record.owner && record.owner.package === OWNER_PACKAGE && record.owner.ref === projectId
        && envStringGet(record.env, BEADS_DIR_ENV) === beadsDir;
    if (alreadyBound) return stepResult('skipped', 'already bound');

    try {
        await bindMember({ db, client }, projectId, { member: name, beadsDir });
    } catch (err) {
        if (err instanceof ProjectBindError) return stepResult('failed', codeDetail(err.code, err.detail));
        throw err;
    }
    return stepResult('done');
}

/**
 * One of the three optional step-5 tools. `provisionVcsAuth`/`provisionLlmAuth`
 * carry `structuredContent.ok`; `composePermissions` is bare-string like
 * register_member -- branch on whichever signal the result actually carries.
 */
async function optionalActionStep(promiseFactory, toolLabel) {
    let res;
    try {
        res = await promiseFactory();
    } catch (err) {
        return stepResult('failed', `${toolLabel} threw: ${err && err.message ? err.message : String(err)}`);
    }
    const structured = res && res.structuredContent;
    if (structured && typeof structured.ok === 'boolean') {
        return structured.ok
            ? stepResult('done')
            : stepResult('failed', `${toolLabel} failed: ${resultText(res) || structured.reason || 'unknown reason'}`);
    }
    return textActionFailed(res)
        ? stepResult('failed', `${toolLabel} failed: ${resultText(res) || 'refused'}`)
        : stepResult('done');
}

/**
 * Run the "add checkout on a machine" flow (A10): clone, register, beads
 * bootstrap, bind, then any requested optional provisioning -- each its own
 * step, each individually idempotent. Stops at the first `failed` step;
 * every step after it is reported `not-run` (and issues no client call at
 * all).
 *
 * @param {{db: any, client: object}} deps
 * @param {string} projectId
 * @param {{
 *   siblingMember: string,
 *   originUrl: string,
 *   checkoutDir: string,
 *   name?: string,
 *   roleHint?: string,
 *   beadsDir?: string,
 *   provisionVcs?: boolean,
 *   provisionLlm?: boolean,
 *   composePermissions?: boolean,
 * }} input
 * @returns {Promise<{ name: string, steps: Array<{step: string, status: 'done'|'skipped'|'failed'|'not-run', detail: string|null}> }>}
 * @throws {ProjectBindError} 404 project-not-found / sibling-not-found, 400 invalid-input.
 */
export async function addCheckout({ db, client }, projectId, input = {}) {
    const project = getProject(db, projectId);
    if (!project) throw new ProjectBindError(404, 'project-not-found', `no project '${projectId}'`);

    const { siblingMember, originUrl, checkoutDir } = input;
    if (typeof siblingMember !== 'string' || siblingMember.trim().length === 0) {
        throw new ProjectBindError(400, 'invalid-input', "'siblingMember' must be a non-empty string");
    }
    if (typeof originUrl !== 'string' || originUrl.trim().length === 0) {
        throw new ProjectBindError(400, 'invalid-input', "'originUrl' must be a non-empty string");
    }
    const checkoutDirError = pathValidationError(checkoutDir, 'checkoutDir');
    if (checkoutDirError) throw new ProjectBindError(400, 'invalid-input', checkoutDirError);

    const beadsDir = input.beadsDir ?? project.beads.dir;
    const beadsDirError = pathValidationError(beadsDir, 'beadsDir');
    if (beadsDirError) throw new ProjectBindError(400, 'invalid-input', beadsDirError);

    const records = parseMemberList(await client.listMembers({ format: 'json' }));
    const siblingRecord = records.find((r) => r && r.name === siblingMember);
    if (!siblingRecord) throw new ProjectBindError(404, 'sibling-not-found', `no member '${siblingMember}'`);

    const originSlug = originSlugFromUrl(originUrl);
    const name = typeof input.name === 'string' && input.name.trim().length > 0
        ? input.name
        : suggestCheckoutName({ projectId, machineMember: siblingMember, originSlug, roleHint: input.roleHint });

    const steps = [];
    let failed = false;

    async function runStep(stepName, fn) {
        if (failed) {
            steps.push({ step: stepName, status: 'not-run', detail: null });
            return;
        }
        let result;
        try {
            result = await fn();
        } catch (err) {
            result = stepResult('failed', err && err.message ? err.message : String(err));
        }
        steps.push({ step: stepName, ...result });
        if (result.status === 'failed') failed = true;
    }

    await runStep('clone', () => cloneStep({ client }, { siblingMember, originUrl, checkoutDir, originSlug }));
    await runStep('register', () => registerStep({ client }, { name, siblingMember, siblingRecord, checkoutDir, projectId, beadsDir }));
    await runStep('beads-bootstrap', () => bootstrapStep({ client }, { name, beadsDir, project }));
    await runStep('bind', () => bindStep({ db, client }, { projectId, name, beadsDir }));

    await runStep('provision-vcs-auth', () => (input.provisionVcs
        ? optionalActionStep(() => client.provisionVcsAuth({ member_name: name }), 'provisionVcsAuth')
        : stepResult('skipped', 'not requested')));
    await runStep('provision-llm-auth', () => (input.provisionLlm
        ? optionalActionStep(() => client.provisionLlmAuth({ member_name: name }), 'provisionLlmAuth')
        : stepResult('skipped', 'not requested')));
    await runStep('compose-permissions', () => (input.composePermissions
        ? optionalActionStep(() => client.composePermissions({ member_name: name }), 'composePermissions')
        : stepResult('skipped', 'not requested')));

    return { name, steps };
}
