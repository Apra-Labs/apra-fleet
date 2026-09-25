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
//     `provisionVcsAuth`/`provisionLlmAuth` each have their own idempotency
//     probe first (a fresh `listMembers` read of the new member's own record:
//     a non-expired `vcsTokenExpiresAt` for VCS, an already-authenticated
//     `llm_auth` status for LLM), so a re-run with the same request body
//     reports them `skipped` too, matching the other four steps
//     (apra-fleet-vcnl.5). `composePermissions` has NO such probe: neither
//     `listMembers` nor `memberDetail` (nor anything `composePermissions`
//     itself returns) exposes any "already composed" signal for a member
//     today -- unlike the code_intel_provider gap noted below, there is no
//     field name to read defensively once one exists, since
//     src/tools/compose-permissions.ts never persists composition state onto
//     the registry (no `updateAgent` call). This step still issues a real
//     call on every request until that signal exists.
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
// and `quoteArg` is the ONE helper every interpolated value goes through.
// See fleet-sprint/shell-command-guard.mjs for the invariant this keeps.
//
// The quoting policy, stated once
// --------------------------------
// TWO layers, and both are deliberate (this is hardening, not a fix for a
// reachable escalation: these routes sit behind the bearer token on
// 127.0.0.1 and the same caller already holds execute_command).
//
//   1. REJECT at the edge. Every caller-supplied value that reaches a
//      command string -- `checkoutDir`, `beadsDir`, `originUrl` -- is
//      screened by `shellMetaCharError` and refused with HTTP 400 naming the
//      field and the offending character. See SHELL_METACHAR_RE for the set.
//   2. QUOTE unconditionally. `quoteArg` NEVER returns a value verbatim; a
//      value with no metacharacter at all still comes back quoted, so no
//      future call site can grow an unquoted path by forgetting the screen.
//
// `quoteArg` also branches on the TARGET MEMBER's registered shell rather
// than assuming POSIX: POSIX gets single quotes with the `'\''` break-out,
// PowerShell gets single quotes with `''` doubling. The former backslash-
// escaped double quote was POSIX-specific and mis-escapes on a PowerShell
// member (docs/cross-shell-command-construction.md). The predicate is
// `isPosixMemberShell` below, a local mirror of src/utils/agent-helpers.ts's
// isPosixShell -- this package has no compile-time link to that module, so it
// is mirrored, not imported, and must not drift from it.
//
// ./health.mjs imports `quoteArg`, `isPosixMemberShell` and
// `shellMetaCharError` from HERE rather than keeping a second copy: the
// helper exists once. That edge is safe -- this module has no import path
// back to ./health.mjs.
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
 * The shell metacharacters a member-bound value may never carry. Everything
 * here is either shell syntax (`;`, `&`, `|`, redirection, subshells,
 * command substitution, a newline) or expansion the shell performs on an
 * UNquoted word (globs, brace expansion, history `!`, `#`, `~`). Rejecting
 * them at the edge is layer 1 of the policy in the module header; `quoteArg`
 * quoting unconditionally is layer 2.
 *
 * NOT listed, deliberately: whitespace and quote characters. Those are
 * legitimate in a path (`/home/o'brien/my repo`) and `quoteArg` renders them
 * safely for either shell, so refusing them would be gratuitous.
 *
 * Spelled as a Set of single characters rather than a regex character class
 * on purpose: a class literal would have to put `$`, `(` and a backtick side
 * by side, which fleet-sprint/shell-command-guard.mjs's own line scanner
 * reads as a dispatched `$(` -- a false positive that would then need an
 * allow directive claiming a deliberate shell expansion this module does not
 * have. The backtick comes from its code point, matching CROSS_MARK below
 * and this repo's ASCII-only file convention.
 */
const SHELL_METACHARS = new Set([
    ';', '&', '|', String.fromCharCode(0x60), '$', '(', ')', '<', '>',
    '*', '?', '[', ']', '{', '}', '!', '#', '~', '\n', '\r',
]);

/**
 * The first character of `value` that is a shell metacharacter, or null.
 *
 * @param {string} value
 * @returns {string | null}
 */
function firstShellMetaChar(value) {
    for (const ch of value) {
        if (SHELL_METACHARS.has(ch)) return ch;
    }
    return null;
}

/**
 * A human-readable reason when `value` carries a shell metacharacter, else
 * null. The reason names BOTH the field and the offending character (JSON-
 * escaped, so a newline reads as `"\n"` rather than wrapping the message).
 *
 * @param {unknown} value
 * @param {string} field
 * @returns {string | null}
 */
export function shellMetaCharError(value, field) {
    if (typeof value !== 'string') return null;
    const offender = firstShellMetaChar(value);
    if (offender === null) return null;
    return `'${field}' must not contain the shell metacharacter ${JSON.stringify(offender)} `
        + '-- resolve or remove it in JavaScript before sending a literal value to a member';
}

/**
 * Whether a listMembers record's member speaks a POSIX shell.
 *
 * MIRRORS src/utils/agent-helpers.ts's
 * `isPosixShell(getAgentOS(agent), getAgentShell(agent))` -- any non-Windows
 * OS, or a Windows member registered as Git-for-Windows bash; a Windows
 * member with no shell recorded, or pwsh7/powershell5, is PowerShell. The
 * `os ?? 'linux'` default is getAgentOS's own. This package has NO compile-
 * time link to that module (a different, MCP-only package boundary -- see
 * the module header), so the predicate is mirrored rather than imported and
 * MUST NOT DRIFT from it.
 *
 * @param {{ os?: unknown, shell?: unknown } | null | undefined} record
 * @returns {boolean}
 */
export function isPosixMemberShell(record) {
    const os = record && typeof record.os === 'string' ? record.os : 'linux';
    const shell = record && typeof record.shell === 'string' ? record.shell : undefined;
    return os !== 'windows' || shell === 'gitbash';
}

/**
 * Quote `value` for a command string bound to `member`. NEVER returns a value
 * verbatim (layer 2 of the module header's policy), and branches the quoting
 * style on the target member's registered shell:
 *
 *   * POSIX  -- single quotes, with `'` broken out as `'\''`. Nothing inside
 *     single quotes is expanded, so `$`, a backtick and `;` are all inert.
 *   * PowerShell -- single quotes, with `'` doubled as `''`. A PowerShell
 *     single-quoted string is literal too, and the POSIX backslash-escaped
 *     double quote this helper used to emit mis-escapes there.
 *
 * The empty string keeps its existing empty-quoted spelling (`""` on POSIX,
 * `''` on PowerShell) so an empty argument still reaches the member as one
 * present-but-empty word.
 *
 * @param {unknown} value
 * @param {{ os?: unknown, shell?: unknown } | null} [member] the TARGET member's listMembers record.
 * @returns {string}
 */
export function quoteArg(value, member = null) {
    const str = String(value);
    const posix = isPosixMemberShell(member);
    if (str.length === 0) return posix ? '""' : "''";
    return posix
        ? `'${str.split("'").join("'\\''")}'`
        : `'${str.split("'").join("''")}'`;
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
 * `~`, an embedded `$`, any OTHER shell metacharacter (see
 * `shellMetaCharError`), or a path that is neither POSIX-absolute (`/...`),
 * Windows drive-absolute (`C:\...` / `C:/...`), nor a UNC share
 * (`\\server\share`). Mirrors src/utils/work-folder-validation.ts's
 * `isFullyQualifiedPath` (a different, MCP-only package boundary -- see the
 * module header) plus the `$`/`~` checks the parent feature's DQ-16 spec adds
 * on top of it for a member-bound path.
 *
 * The leading-`~` and embedded-`$` cases keep their own, more specific
 * messages (they are the two the DQ-16 spec calls out by name) and are
 * therefore checked BEFORE the general metacharacter screen, which would
 * otherwise swallow them.
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
    const metaError = shellMetaCharError(trimmed, field);
    if (metaError) return metaError;
    const isAbsolute = trimmed.startsWith('/')
        || /^[A-Za-z]:[\\/]/.test(trimmed)
        || /^\\\\[^\\/]/.test(trimmed);
    if (!isAbsolute) {
        return `'${field}' must be an absolute path`;
    }
    return null;
}

/**
 * Reject an `originUrl` that is empty or carries a shell metacharacter. It
 * reaches the member as `git clone <originUrl> ...`, and until this screen
 * existed NOTHING validated it. No deliberate remote spelling needs any
 * character in SHELL_METACHAR_RE: the three shapes
 * `git@host:owner/repo.git`, `https://host/owner/repo.git` and
 * `ssh://git@host:22/owner/repo` are all made of characters this allows.
 *
 * @param {unknown} value
 * @returns {string | null} A human-readable reason, or null when valid.
 */
function originUrlValidationError(value) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        return "'originUrl' must be a non-empty string";
    }
    return shellMetaCharError(value.trim(), 'originUrl');
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
 *
 * `targetRecord` is the SIBLING's own listMembers record -- the `git clone`
 * runs on the sibling machine, so its registered os/shell is what `quoteArg`
 * must quote for.
 */
async function cloneStep({ client }, { siblingMember, originUrl, checkoutDir, originSlug, targetRecord }) {
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
        const command = `git clone ${quoteArg(originUrl, targetRecord)} ${quoteArg(checkoutDir, targetRecord)}`;
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
 *
 * `targetRecord` is again the SIBLING's record: the new member is a second
 * registry entry for the SAME machine, registered above with the sibling's
 * own `shell`, so the sibling's os/shell is what `quoteArg` must quote for
 * here too -- and reading it from the sibling avoids a second listMembers
 * round trip purely to learn a value that cannot differ.
 */
async function bootstrapStep({ client }, { name, beadsDir, project, targetRecord }) {
    const remote = project.beads.remote;
    if (!remote) return stepResult('skipped', 'no beads remote');

    const getCommand = `bd -C ${quoteArg(beadsDir, targetRecord)} config get sync.remote`;
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

    const setCommand = `bd -C ${quoteArg(beadsDir, targetRecord)} config set sync.remote ${quoteArg(remote, targetRecord)}`;
    let setRes;
    try {
        setRes = await client.executeCommand({ member_name: name, command: setCommand });
    } catch (err) {
        return stepResult('failed', `bd config set threw: ${err && err.message ? err.message : String(err)}`);
    }
    const setUnwrapped = unwrapExec(setRes);
    if (!setUnwrapped.ok) return stepResult('failed', setUnwrapped.detail || 'bd config set failed');

    const bootstrapCommand = `bd -C ${quoteArg(beadsDir, targetRecord)} bootstrap --yes`;
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
 * The new member's OWN `listMembers` record by name -- the idempotency-probe
 * input for the two optional step-5 actions that have one (see the module
 * header, apra-fleet-vcnl.5). Returns null when the member is not (yet)
 * found, so every caller below falls back to actually running its step
 * rather than misreading absence-of-evidence as already-provisioned.
 *
 * @param {{ client: object }} deps
 * @param {string} name
 * @returns {Promise<object | null>}
 */
async function fetchMemberRecord({ client }, name) {
    const records = parseMemberList(await client.listMembers({ format: 'json' }));
    return records.find((r) => r && r.name === name) ?? null;
}

/**
 * Whether `record.vcsTokenExpiresAt` (the same field `provisionVcsAuth`
 * itself sets, read back via `listMembers`) is a timestamp still in the
 * future -- the clone step's sibling has no equivalent field to fall back
 * on, so an absent/unparseable value is simply "no evidence of a valid
 * token" rather than an error.
 *
 * @param {{ vcsTokenExpiresAt?: unknown } | null} record
 * @returns {boolean}
 */
function hasNonExpiredVcsToken(record) {
    const raw = record && typeof record.vcsTokenExpiresAt === 'string' ? record.vcsTokenExpiresAt : null;
    if (!raw) return false;
    const expiresAt = Date.parse(raw);
    return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

/**
 * Whether `record.llm_auth` (list_members' own live credential-file/env-var
 * probe -- see src/tools/list-members.ts's `getAuthStatus`) already reports
 * a working credential. `'none'`, `'offline'`, and `'N/A'` are all "no
 * evidence of prior provisioning", not a probe failure.
 *
 * @param {{ llm_auth?: unknown } | null} record
 * @returns {boolean}
 */
function hasLlmAuthAlready(record) {
    const status = record && typeof record.llm_auth === 'string' ? record.llm_auth : '';
    return status === 'api-key' || status === 'oauth' || status === 'api-key (warn: oauth)';
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
 * Step 5a (optional): VCS auth provisioning, probed first. Skips when the
 * new member's own `listMembers` record already carries a non-expired
 * `vcsTokenExpiresAt` (apra-fleet-vcnl.5); otherwise runs `provisionVcsAuth`
 * as before.
 */
async function vcsAuthStep({ client }, { name }) {
    const record = await fetchMemberRecord({ client }, name);
    if (hasNonExpiredVcsToken(record)) {
        return stepResult('skipped', `vcs token already valid until ${record.vcsTokenExpiresAt}`);
    }
    return optionalActionStep(() => client.provisionVcsAuth({ member_name: name }), 'provisionVcsAuth');
}

/**
 * Step 5b (optional): LLM auth provisioning, probed first. Skips when the
 * new member's own `listMembers` record already reports a working
 * credential via `llm_auth` (apra-fleet-vcnl.5); otherwise runs
 * `provisionLlmAuth` as before.
 */
async function llmAuthStep({ client }, { name }) {
    const record = await fetchMemberRecord({ client }, name);
    if (hasLlmAuthAlready(record)) {
        return stepResult('skipped', `llm auth already present (${record.llm_auth})`);
    }
    return optionalActionStep(() => client.provisionLlmAuth({ member_name: name }), 'provisionLlmAuth');
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
    const originUrlError = originUrlValidationError(originUrl);
    if (originUrlError) throw new ProjectBindError(400, 'invalid-input', originUrlError);
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

    // Both command-building steps quote for the SIBLING's registered shell:
    // the clone runs on the sibling, and the new member is a second registry
    // entry for that same machine (see each step's own note).
    const targetRecord = siblingRecord;

    await runStep('clone', () => cloneStep({ client }, { siblingMember, originUrl, checkoutDir, originSlug, targetRecord }));
    await runStep('register', () => registerStep({ client }, { name, siblingMember, siblingRecord, checkoutDir, projectId, beadsDir }));
    await runStep('beads-bootstrap', () => bootstrapStep({ client }, { name, beadsDir, project, targetRecord }));
    await runStep('bind', () => bindStep({ db, client }, { projectId, name, beadsDir }));

    await runStep('provision-vcs-auth', () => (input.provisionVcs
        ? vcsAuthStep({ client }, { name })
        : stepResult('skipped', 'not requested')));
    await runStep('provision-llm-auth', () => (input.provisionLlm
        ? llmAuthStep({ client }, { name })
        : stepResult('skipped', 'not requested')));
    // No pre-check here: composePermissions has no "already composed" signal
    // to probe -- see the module header (apra-fleet-vcnl.5).
    await runStep('compose-permissions', () => (input.composePermissions
        ? optionalActionStep(() => client.composePermissions({ member_name: name }), 'composePermissions')
        : stepResult('skipped', 'not requested')));

    return { name, steps };
}
