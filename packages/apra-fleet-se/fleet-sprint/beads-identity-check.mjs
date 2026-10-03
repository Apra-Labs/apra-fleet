// =============================================================================
// Beads identity precondition: prove which .beads every member will mutate
// BEFORE the sprint issues its first mutating bd command.
//
// fleet-sprint never runs bd itself -- every bd goes to a member and runs in
// that member's workFolder, so bd's own cwd discovery decides which database
// a sprint mutates. Nothing else in the engine verifies that the database a
// member resolves to is the project the supervisor launched the sprint for.
// This module runs the three read-only probes from beads-identity.mjs on the
// backlog member first and then on every other distinct member, and
// compares each answer against the expected identity. The expected identity
// is either the supervisor's (`--expect-beads`, args.expectBeads) or, absent
// that, the backlog member's own probed identity -- in which case only
// the OTHER members are compared and the log says so.
//
// Severity model (deliberate):
//   - MISMATCH is FATAL: a field that resolved on BOTH sides and differs
//     means the member's bd points at a different project. Throws
//     BeadsIdentityError (reason MISMATCH) before any bd mutation.
//   - BD_MISSING is FATAL: the member's shell reports no bd executable at
//     all, so every bd there would fail mid-sprint. Throws before any
//     dispatch, naming the member and the fix.
//   - a beads-reading member with NO beads database, or with a database but
//     no sync.remote while the expectation names one, is SET UP before any
//     dispatch (setupMemberBeads below): `bd config set sync.remote
//     <expected>` + `bd bootstrap`, which clones the database from that
//     remote non-destructively (an existing database is never replaced). The
//     member is then re-probed and must match. When that cannot be done the
//     preflight throws BEADS_SETUP_FAILED naming the member, the cause and
//     the fix -- never a warning followed by dispatches whose `bd show`
//     cannot find the sprint's issues.
//   - an UNRESOLVED probe is a WARNING: a probe that failed, or answered
//     something unparseable/empty, leaves that field out of the comparison.
//     The warning names the member, the field, the probe, the error and the
//     fix, so the operator can repair it; the first real bd on that member
//     surfaces a genuinely broken member exactly as it does today. Every
//     warning is logged with the `[beads-identity] WARNING:` prefix, and
//     collected into the published `beadsIdentity` state (`warnings`, plus
//     a per-member `unresolved` field list) so the viewer can show it.
//
// Every command() call here names its member explicitly (dispatch-safety
// guard) and is issued failSoft + silent, like every other read-only probe in
// this package. Each member is probed at most once per run.
// =============================================================================

import {
    BEADS_IDENTITY_PROBES,
    COMPARED_FIELDS,
    parseBeadsIdentity,
    compareIdentity,
    formatBeadsIdentity,
    normalizeRemoteUrl,
    hasBeadsDatabase,
} from './beads-identity.mjs';
import { BeadsIdentityError, BEADS_IDENTITY_FAILURE_REASONS } from './errors.mjs';
import { syncBefore as doltSyncBefore } from './dolt-sync.mjs';

// Short: three cheap local reads per member. A member that cannot answer
// `bd where` inside a minute is not a member this sprint should mutate.
export const BEADS_IDENTITY_PROBE_TIMEOUT_S = 60;

const LABEL = 'beads-identity';
export const BEADS_IDENTITY_WARNING_PREFIX = '[beads-identity] WARNING: ';

// Which probe each compared field comes from, and the operator-facing fix
// when that field could not be resolved on a member. Generic on purpose: no
// product paths, no host-specific text.
const FIELD_PROBE = Object.freeze({
    prefix: 'where',
    syncRemote: 'syncRemote',
    repoRemote: 'repoRemote',
});

export const BEADS_IDENTITY_FIELD_FIX = Object.freeze({
    prefix: "run 'bd where' in the member's workFolder; ensure bd is installed there and the folder contains the project's .beads",
    syncRemote: "set it on that member with 'bd config set sync.remote <url>' in its workFolder",
    repoRemote: "the member's workFolder is not a git clone with an 'origin' remote; re-register the member with a real clone or add the remote",
});

function outputOf(res) {
    if (res && typeof res === 'object') return typeof res.output === 'string' ? res.output : '';
    return typeof res === 'string' ? res : '';
}

function failureOf(res) {
    if (res && typeof res === 'object' && res.ok === false) return String(res.error || 'command failed');
    return null;
}

// One line (a warning is one log line), capped.
function summarizeRaw(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return '(no output)';
    return t.length > 400 ? `${t.slice(0, 400)}...` : t;
}

/**
 * A per-run prober: runs the three identity probes on a member through the
 * injected command() and memoizes the result so a member is probed once.
 *
 * @param {{ command: Function, timeoutS?: number }} opts
 * @returns {{ probe: (member: string) => Promise<{ identity: object, raw: object, failures: Array<{probe: string, key: string, error: string}> }> }}
 */
export function createBeadsIdentityProber({ command, timeoutS = BEADS_IDENTITY_PROBE_TIMEOUT_S }) {
    if (typeof command !== 'function') {
        throw new TypeError('createBeadsIdentityProber({ command }): command must be a function');
    }
    const cache = new Map();

    async function runProbes(member) {
        const raw = {};
        const failures = [];
        for (const [key, cmd] of Object.entries(BEADS_IDENTITY_PROBES)) {
            let res;
            try {
                res = await command(cmd, { member_name: member, silent: true, failSoft: true, label: LABEL, timeout_s: timeoutS });
            } catch (err) {
                res = { ok: false, output: '', error: err && err.message ? err.message : String(err) };
            }
            const failed = failureOf(res);
            raw[key] = outputOf(res);
            if (failed !== null) failures.push({ probe: cmd, key, error: failed });
        }
        return { identity: parseBeadsIdentity(raw), raw, failures };
    }

    return {
        probe(member) {
            let pending = cache.get(member);
            if (!pending) {
                pending = runProbes(member);
                cache.set(member, pending);
            }
            return pending;
        },
        // Drops the memoized answer so the next probe() re-runs the probes --
        // used after the preflight itself changed the member's beads setup.
        forget(member) {
            cache.delete(member);
        },
    };
}

// Why a probe key resolved to nothing on this member: its recorded failure,
// else the (unparseable or empty) output it did return.
function probeDetail(probed, key) {
    const failure = probed.failures.find((f) => f.key === key);
    if (failure) return summarizeRaw(failure.error);
    const out = String(probed.raw[key] || '').trim();
    if (!out) return 'empty output';
    // `bd config get` answers an unset key with exit 0 and value "": the
    // probe worked, the value is simply not configured.
    if (key === 'syncRemote') return 'sync.remote is unset';
    return `unparseable output: ${summarizeRaw(out)}`;
}

// The member's `bd where` produced no database path: nothing to compare.
function noDatabaseWarning(member, probed) {
    return `member '${member}' reports no beads database in its workFolder ` +
        `('${BEADS_IDENTITY_PROBES.where}' -> ${probeDetail(probed, 'where')}); nothing to compare, the first bd command on it will surface the problem. ` +
        `To fix: ${BEADS_IDENTITY_FIELD_FIX.prefix}.`;
}

// One compared field is empty on the member's side.
function unresolvedFieldWarning(member, field, probed) {
    const key = FIELD_PROBE[field];
    return `member '${member}' could not report ${field} ('${BEADS_IDENTITY_PROBES[key]}' -> ${probeDetail(probed, key)}); not compared. ` +
        `To fix: ${BEADS_IDENTITY_FIELD_FIX[field]}.`;
}

// One compared field is empty on the EXPECTED side (the supplied
// --expect-beads carries no value for it, or the orchestrator it was derived
// from could not report it), so no member can be checked on it.
function unresolvedExpectedWarning(field, expectedFrom, backlogMember) {
    const source = expectedFrom === 'backlog'
        ? `the backlog member '${backlogMember}' it was derived from could not report ${field}`
        : `the supplied expected beads identity carries no ${field}`;
    return `${source}; ${field} is not compared on any member this sprint. ` +
        `To fix: ${BEADS_IDENTITY_FIELD_FIX[field]}${expectedFrom === 'backlog' ? ' (on the backlog member), or launch via the supervisor so --expect-beads is supplied' : ''}.`;
}

function noExpectationWarning(backlogMember, probed) {
    return `no expected beads identity was supplied and the backlog member '${backlogMember}' could not report its beads database ` +
        `('${BEADS_IDENTITY_PROBES.where}' -> ${probeDetail(probed, 'where')}); no cross-member beads identity check will happen this sprint. ` +
        `To restore it: fix the backlog member's beads (${BEADS_IDENTITY_FIELD_FIX.prefix}), or launch via the supervisor so --expect-beads is supplied.`;
}

// The shell reported that no `bd` executable exists (POSIX shells, cmd,
// PowerShell), as opposed to bd running and failing.
const BD_NOT_FOUND_RE = /\bbd: (?:command )?not found|bd: No such file or directory|'bd' is not recognized|The term 'bd' is not recognized|\bexit(?:ed)?(?: with)?(?: code)?:? 127\b/i;

export const BD_MISSING_FIX =
    "install the beads CLI (bd) on that member so 'bd --version' works in its workFolder shell " +
    '(re-running the member fleet install places it in the member fleet bin dir), then rerun the sprint';

/** Throws BD_MISSING when the member's `bd where` probe proved bd is absent. */
export function assertBdPresent(member, probed) {
    const failure = probed.failures.find((f) => f.key === 'where');
    const text = `${failure ? failure.error : ''}\n${probed.raw.where || ''}`;
    if (!failure || !BD_NOT_FOUND_RE.test(text)) return;
    throw new BeadsIdentityError(
        `Beads preflight failed: member '${member}' has no bd CLI ('${BEADS_IDENTITY_PROBES.where}' -> ${summarizeRaw(text)}). ` +
        `Every sprint role on it runs bd, so the sprint stops before any dispatch. To fix: ${BD_MISSING_FIX}.`,
        { reason: BEADS_IDENTITY_FAILURE_REASONS.BD_MISSING, member }
    );
}

// ---------------------------------------------------------------------------
// Member beads set-up (the one self-heal this preflight performs).
//
// A role that reads beads on a member (`bd show <root>`, `bd ready`, ...)
// reads the database bd resolves in THAT member's workFolder. A fresh clone
// with bd installed but no beads database -- or with a database whose
// sync.remote is unset, so no D-pull ever freshens it -- answers "not found"
// for every sprint issue. So before any dispatch the preflight sets the
// member up from the sprint's EXPECTED beads remote (verified against bd
// 1.3 on POSIX and PowerShell):
//
//   both cases:    git ls-files (modified / untracked beads paths, BEFORE any write)
//                  <ensure .beads/config.yaml exists>   (bd config set refuses to write
//                                                   without a workspace; per-shell,
//                                                   never truncates)
//                  <ensure line 'sync.remote: "<expected>"' in .beads/config.local.yaml>
//                                                  (bd's untracked local layer: the
//                                                   durable record, see "target repo")
//                  bd config set sync.remote <expected>
//   no database:   bd bootstrap --dry-run --json   (must plan a clone FROM <expected>;
//                                                   any other plan -- JSONL import,
//                                                   fresh database -- would yield a
//                                                   database with an unrelated history)
//                  bd bootstrap --yes              (clones and wires the dolt remote
//                                                   'origin'; never deletes data)
//   database but
//   no sync.remote: bd dolt remote list --json     (bootstrap does NOT wire 'origin' on an
//                                                   existing database; an 'origin' pointing
//                                                   elsewhere is refused, never rewired)
//                  bd dolt remote add origin <expected>   (only when 'origin' is absent)
//                  pull via DoltSync.syncBefore    (proves the existing database is a
//                                                   clone of <expected> and brings it current)
//   finally (success or failure):
//                  git checkout -- <each tracked beads file the set-up changed>
//                  <git info/exclude each beads path the set-up left untracked>
//
// Target repo: the member's work folder is a clone of the sprint's TARGET
// repository, and a doer's `git add -A` there must never carry the set-up
// into the target PR. bd rewrites tracked beads files during set-up (it
// reflows config.yaml and adds a sync block that would switch sync on for
// every user of the repo, appends to .gitignore, rewrites metadata.json) and
// leaves untracked ones (.beads.gate.lock at the root, config.local.yaml, a
// whole .beads/ when the repo tracks only issues.jsonl). So the tracked files
// it changed are restored from git -- bd keeps working: it reads sync.remote
// from config.local.yaml and the database is untouched -- and the new
// untracked paths go into the member's git info/exclude. Verified with real
// bd 1.3 on a fresh clone of a repo that commits its beads config: `git
// status --porcelain` is empty afterwards, `git add -A` stages nothing, and
// a later checkout/merge of an upstream change to config.yaml still works.
//
// Every step goes through the injected command() with the member named, so
// the runner's command() wrapper (DoltSync.noteMemberCommand) sees the
// `bd config set` / `bd bootstrap` / `bd dolt remote` and drops that member's
// sync.remote memo. The member's VCS credential is ensured first (the clone
// may need auth). The bd command strings are plain `bd ...` with the remote
// passed as one bare word: execute_command establishes the cwd per member
// OS/shell, and the remote is refused unless it is made only of characters
// every supported shell (POSIX, PowerShell, cmd) passes through verbatim --
// no quoting, no shell expansion.
//
// Older-schema remote: bd may auto-apply pending schema migrations to a
// freshly cloned database and leave them uncommitted in the working set, and
// the next D-pull then dies on "local changes would be stomped". A dispatch
// member must not publish a shared-schema migration on its own, so when any
// set-up output (or the re-probe after it) reports that, the preflight stops
// with BEADS_SETUP_FAILED naming the cause and the fix (publish the
// migration once, from the backlog member) instead of leaving the trap for
// the first dispatch.
// ---------------------------------------------------------------------------

// The roles whose contracts run bd on their member. deployer and ci-watcher
// do not; a member mapped ONLY to those is not set up (a missing database
// there stays the warning it was).
export const BEADS_READING_ROLES = Object.freeze([
    'planner',
    'plan-reviewer',
    'doer',
    'reviewer',
    'integ-test-runner',
    'regression-test-runner',
    'harvester',
]);

// A bootstrap clones the whole beads history: allow it far longer than a probe.
export const BEADS_SETUP_TIMEOUT_S = 600;
const SETUP_LABEL = 'beads-setup';

// The work-folder-relative file whose presence makes the folder a beads
// workspace `bd config set` can write to.
export const BEADS_WORKSPACE_CONFIG_FILE = '.beads/config.yaml';
// bd's untracked, machine-local config layer (read over config.yaml). The
// sync remote is recorded HERE, because bd rewrites the (often tracked)
// config.yaml during set-up and the preflight restores that file afterwards.
export const BEADS_LOCAL_CONFIG_FILE = '.beads/config.local.yaml';
export const beadsLocalSyncRemoteLine = (url) => `sync.remote: "${url}"`;

export const BEADS_SETUP_COMMANDS = Object.freeze({
    setSyncRemote: (url) => `bd config set sync.remote ${url}`,
    plan: 'bd bootstrap --dry-run --json',
    bootstrap: 'bd bootstrap --yes',
    remoteList: 'bd dolt remote list --json',
    addOrigin: (url) => `bd dolt remote add origin ${url}`,
    // The pull itself is NOT a command here: every dolt pull/push goes
    // through ./dolt-sync.mjs (DoltSync.syncBefore), which also brings its
    // transient-retry ladder and the reactive VCS-auth self-heal.
});

// Characters a bare word keeps verbatim in POSIX shells, PowerShell and cmd
// (no $, %, backtick, quotes, spaces, ;, &, |, commas, parens, backslashes).
const SHELL_SAFE_REMOTE_RE = /^[A-Za-z0-9][A-Za-z0-9._~:/@+=-]*$/;

// bd's report that it migrated a database's schema locally, or that the
// remote is behind the local bd's schema. Matched against bd's own format
// strings (bd 1.3 source):
//   "Smart gate (%s): auto-applying %d pending deterministic schema %s to a
//    remote-backed database (...). Run `bd dolt push` after."
//   "The database cloned from %s needs %d schema %s (v%d -> v%d)." ...
//   "Re-running `%s` will NOT fix this -- the remote itself is behind."
// (the first reproduced verbatim by a live sprint; neither reproducible here
// without an older-schema remote).
const SCHEMA_MIGRATION_RE = /auto-applying\b[^\n]*\bschema migrations?|schema migrations?[^\n]*\bbd dolt push\b|\bneeds \d+ schema migrations?\b|remote itself is behind|remote[^\n]*\b(?:behind|older)\b[^\n]*\bschema|schema[^\n]*\bremote[^\n]*\b(?:behind|older)\b/i;

export function hasSchemaMigrationReport(text) {
    return SCHEMA_MIGRATION_RE.test(String(text || ''));
}

function setupFix(url) {
    return `in that member's workFolder create an empty '${BEADS_WORKSPACE_CONFIG_FILE}' if there is none, run 'bd config set sync.remote ${url || '<beads remote>'}' ` +
        "then 'bd bootstrap --yes' (the member needs a VCS credential that can read that remote), check 'bd where' reports the project, then rerun the sprint";
}

const SCHEMA_FIX =
    "the shared beads remote is at an older bd schema than the member's bd. Publish the migration once, from the backlog member: " +
    'push its beads database to the beads remote from its workFolder (with a VCS credential that can push that remote), then rerun the sprint';

function setupFailed(member, cause, fix, details) {
    return new BeadsIdentityError(
        `Beads preflight failed: member '${member}' ${cause}. A beads-reading role dispatched there would read a database ` +
        `without this sprint's issues, so the sprint stops before any dispatch. To fix: ${fix}.`,
        { reason: BEADS_IDENTITY_FAILURE_REASONS.BEADS_SETUP_FAILED, member, details }
    );
}

function parseFirstJson(text, open = '{') {
    const t = String(text || '');
    const start = t.indexOf(open);
    if (start < 0) return null;
    try {
        return JSON.parse(t.slice(start));
    } catch {
        return null;
    }
}

// Paths the set-up can create or rewrite in the member's work tree, relative
// to it: `.beads/...` (bd reflows a tracked config.yaml, appends to a tracked
// .gitignore, rewrites metadata.json) and the `.beads.gate.lock` bd leaves at
// the work-folder root. Only lines of git output matching this are acted on.
const BEADS_TREE_PATH_RE = /^\.beads(?:\/[A-Za-z0-9._/-]*)?$|^\.beads\.gate\.lock$/;

export const BEADS_TREE_COMMANDS = Object.freeze({
    // Tracked beads files with work-tree changes.
    modified: 'git ls-files -m -- .beads',
    // Untracked, not ignored; a wholly untracked directory collapses to one entry.
    untracked: 'git ls-files --others --exclude-standard --directory -- .beads .beads.gate.lock',
    restore: (relPath) => `git checkout -- ${relPath}`,
    // The work folder's path below the repository root ('' at the root).
    prefix: 'git rev-parse --show-prefix',
});

function beadsTreePaths(text) {
    return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => BEADS_TREE_PATH_RE.test(l) && !l.split('/').includes('..'));
}

/**
 * Sets up one member's beads from `url` (see the section comment). Throws
 * BeadsIdentityError(BEADS_SETUP_FAILED) on any step that fails; resolves
 * when every step succeeded. Verifying the result is the caller's job (a
 * fresh identity probe).
 *
 * The target repository must never receive the set-up's side effects through
 * a later commit on the member (a doer's `git add -A`): bd rewrites tracked
 * beads files (config.yaml gains the sync remote, .gitignore and
 * metadata.json change) and adds untracked ones. So the beads paths that are
 * modified/untracked are recorded BEFORE the first write, and afterwards --
 * on success AND on failure, since a failed set-up may already have written
 * -- every tracked file the set-up changed is restored (`git checkout --`;
 * the sync remote survives in the untracked config.local.yaml) and every new
 * untracked path is added to the member's git info/exclude
 * (memberShell().ensureGitExcluded). The member's work tree then reports
 * clean and `git add -A` stages nothing from the set-up.
 *
 * @param {{ command: Function, member: string, url: string, hasDb: boolean,
 *   memberShell?: (member: string) => Promise<{ ensureFile: (relPath: string) => string, ensureLine: (relPath: string, line: string) => string, ensureGitExcluded: (entry: string) => string }>,
 *   ensureVcsAuth?: (member: string) => Promise<void>, onAuthFailure?: Function,
 *   pullBeads?: Function, log?: Function, timeoutS?: number }} opts
 *   `memberShell` returns the member's OS/shell command builder (the SE
 *   command primitives); required. `onAuthFailure` is DoltSync's reactive
 *   VCS-auth self-heal for the pull; `pullBeads` replaces
 *   DoltSync.syncBefore (test seam).
 * @returns {Promise<string[]>} the commands issued, in order
 */
export async function setupMemberBeads({ command, member, url, hasDb, memberShell, ensureVcsAuth, onAuthFailure, pullBeads, log = () => {}, timeoutS = BEADS_SETUP_TIMEOUT_S }) {
    if (!SHELL_SAFE_REMOTE_RE.test(url)) {
        throw setupFailed(member,
            `needs its beads set up from the expected beads remote '${url}', which contains characters that cannot be passed verbatim to every member shell`,
            setupFix(url), { step: 'validate', url });
    }
    const issued = [];
    const run = async (cmd) => {
        issued.push(cmd);
        let res;
        try {
            res = await command(cmd, { member_name: member, silent: true, failSoft: true, label: SETUP_LABEL, timeout_s: timeoutS });
        } catch (err) {
            res = { ok: false, output: '', error: err && err.message ? err.message : String(err) };
        }
        const error = failureOf(res);
        return { ok: error === null, output: outputOf(res), error };
    };
    const assertNoMigration = (step, r) => {
        const text = `${r.output}\n${r.error || ''}`;
        if (hasSchemaMigrationReport(text)) {
            throw setupFailed(member,
                `had its beads set up from '${url}', but bd reports a schema migration against that remote ('${step}' -> ${summarizeRaw(text)})`,
                SCHEMA_FIX, { step, url, cause: 'schema-migration' });
        }
    };

    let shell = null;
    try {
        shell = typeof memberShell === 'function' ? await memberShell(member) : null;
    } catch (err) {
        log(`[beads-identity] could not resolve the shell of member '${member}': ${err && err.message ? err.message : err}`);
    }
    if (!shell || typeof shell.ensureFile !== 'function' || typeof shell.ensureLine !== 'function' || typeof shell.ensureGitExcluded !== 'function') {
        throw setupFailed(member, 'needs its beads set up, but no command could be built for its shell', setupFix(url), { step: 'shell', url });
    }

    // What git already reports for the beads paths, before any write.
    const listTree = async () => {
        const modified = await run(BEADS_TREE_COMMANDS.modified);
        const untracked = await run(BEADS_TREE_COMMANDS.untracked);
        if (!modified.ok || !untracked.ok) {
            const bad = !modified.ok ? modified : untracked;
            throw setupFailed(member,
                `needs its beads set up, but its workFolder's git state cannot be read to keep the set-up out of commits (${summarizeRaw(bad.error || bad.output)})`,
                `make sure the member's workFolder is a git clone with git on PATH, or ${setupFix(url)}`, { step: 'tree', url });
        }
        return { modified: new Set(beadsTreePaths(modified.output)), untracked: new Set(beadsTreePaths(untracked.output)) };
    };
    const before = await listTree();
    if (before.modified.size) {
        log(`${BEADS_IDENTITY_WARNING_PREFIX}member '${member}' already has local changes to ${[...before.modified].join(', ')}; ` +
            'the beads set-up may add to them and will not restore them -- review those files before anything on that member is committed.');
    }
    // info/exclude patterns are relative to the repository root, git ls-files
    // paths to the work folder: a work folder below the root needs its prefix.
    const prefixRes = await run(BEADS_TREE_COMMANDS.prefix);
    const rootPrefix = prefixRes.ok ? String(prefixRes.output || '').split(/\r?\n/).map((l) => l.trim()).find((l) => /^[A-Za-z0-9._/-]*\/$/.test(l) && !l.split('/').includes('..')) || '' : null;
    if (rootPrefix === null) {
        throw setupFailed(member,
            `needs its beads set up, but its workFolder's position in its git clone cannot be read (${summarizeRaw(prefixRes.error || prefixRes.output)})`,
            `make sure the member's workFolder is a git clone with git on PATH, or ${setupFix(url)}`, { step: 'tree', url });
    }

    log(`[beads-identity] member '${member}' ${hasDb ? 'has a beads database with no sync.remote' : 'has no beads database in its workFolder'}; setting it up from the expected beads remote ${url}.`);
    if (typeof ensureVcsAuth === 'function') {
        try {
            await ensureVcsAuth(member);
        } catch (err) {
            log(`[beads-identity] could not refresh the VCS credential for member '${member}' before its beads set-up (continuing): ${err && err.message ? err.message : err}`);
        }
    }

    const apply = async () => {
        const runShell = async (build, what) => {
            let cmd = '';
            try {
                cmd = String(build() || '');
            } catch (err) {
                log(`[beads-identity] could not build the command to ${what} for member '${member}': ${err && err.message ? err.message : err}`);
            }
            const r = cmd ? await run(cmd) : { ok: false, error: 'no command for this shell' };
            if (!r.ok) {
                throw setupFailed(member, `could not ${what} in its workFolder (${summarizeRaw(r.error || r.output)})`, setupFix(url), { step: 'workspace', url });
            }
        };
        // bd refuses `config set` without a workspace config file.
        await runShell(() => shell.ensureFile(BEADS_WORKSPACE_CONFIG_FILE), `create '${BEADS_WORKSPACE_CONFIG_FILE}'`);
        // The durable record of the sync remote, in the untracked local layer.
        await runShell(() => shell.ensureLine(BEADS_LOCAL_CONFIG_FILE, beadsLocalSyncRemoteLine(url)), `record the sync remote in '${BEADS_LOCAL_CONFIG_FILE}'`);

        const setCmd = BEADS_SETUP_COMMANDS.setSyncRemote(url);
        const set = await run(setCmd);
        if (!set.ok) {
            throw setupFailed(member, `could not set its sync.remote ('${setCmd}' -> ${summarizeRaw(set.error || set.output)})`, setupFix(url), { step: 'set-sync-remote', url });
        }

        if (!hasDb) {
            const plan = await run(BEADS_SETUP_COMMANDS.plan);
            const planObj = plan.ok ? parseFirstJson(plan.output) : null;
            const planned = planObj && typeof planObj.action === 'string' ? planObj.action : '';
            const plannedRemote = planObj && typeof planObj.sync_remote === 'string' ? planObj.sync_remote : '';
            if (!plan.ok || planned !== 'sync' || normalizeRemoteUrl(plannedRemote) !== normalizeRemoteUrl(url)) {
                const why = !plan.ok
                    ? summarizeRaw(plan.error || plan.output)
                    : "planned action '" + (planned || '(none)') + "'"
                        + (planObj && planObj.reason ? ' (' + summarizeRaw(planObj.reason) + ')' : '')
                        + (plannedRemote ? " from '" + plannedRemote + "'" : '');
                throw setupFailed(member,
                    `has no beads database and 'bd bootstrap' would not clone it from the expected beads remote '${url}' ('${BEADS_SETUP_COMMANDS.plan}' -> ${why}); ` +
                    'any other bootstrap would create a database with an unrelated history',
                    `make sure '${url}' holds the project's beads data and the member's VCS credential can read it, then ${setupFix(url)}`,
                    { step: 'plan', url, plan: planObj });
            }

            const boot = await run(BEADS_SETUP_COMMANDS.bootstrap);
            assertNoMigration(BEADS_SETUP_COMMANDS.bootstrap, boot);
            if (!boot.ok) {
                throw setupFailed(member, `could not bootstrap its beads from '${url}' ('${BEADS_SETUP_COMMANDS.bootstrap}' -> ${summarizeRaw(boot.error || boot.output)})`, setupFix(url), { step: 'bootstrap', url });
            }
            return issued;
        }

        // An existing database: make sure its dolt 'origin' is the expected
        // remote (adding it when absent, refusing a different one), then pull.
        const list = await run(BEADS_SETUP_COMMANDS.remoteList);
        const remotes = list.ok ? parseFirstJson(list.output, '[') : null;
        if (!Array.isArray(remotes)) {
            throw setupFailed(member, `could not list its beads dolt remotes ('${BEADS_SETUP_COMMANDS.remoteList}' -> ${summarizeRaw(list.error || list.output)})`,
                setupFix(url), { step: 'remote-list', url });
        }
        const origin = remotes.find((r) => r && r.name === 'origin');
        if (origin && normalizeRemoteUrl(String(origin.url || '')) !== normalizeRemoteUrl(url)) {
            throw setupFailed(member,
                `has an existing beads database whose dolt remote 'origin' is '${origin.url}', not the expected beads remote '${url}'; it is not rewired automatically`,
                `check which beads project that member's database belongs to; if it is this project, run 'bd dolt remote add origin ${url}' in its workFolder, otherwise move that database aside, then rerun the sprint`,
                { step: 'remote-list', url, origin: origin.url });
        }
        if (!origin) {
            const addCmd = BEADS_SETUP_COMMANDS.addOrigin(url);
            const add = await run(addCmd);
            if (!add.ok) {
                throw setupFailed(member, `could not add the dolt remote 'origin' ('${addCmd}' -> ${summarizeRaw(add.error || add.output)})`, setupFix(url), { step: 'remote-add', url });
            }
        }
        // The pull goes through DoltSync (the single dolt pull/push surface):
        // its retry ladder and reactive VCS-auth self-heal apply. The
        // remote was configured just above, so its pre-gate is answered
        // directly, and the tip fingerprint is skipped -- this first pull
        // must be real.
        let pulled = null;
        let pullError = '';
        try {
            pulled = await (pullBeads || doltSyncBefore)(member, {
                // DoltSync names the member on every command it issues.
                command,
                log,
                fatal: true,
                onAuthFailure,
                checkSyncRemoteConfigured: async () => true,
                remoteTipFingerprint: false,
            });
        } catch (err) {
            pullError = [err && err.message, err && err.doltOutput].filter(Boolean).join('\n') || String(err);
        }
        if (pullError) assertNoMigration('beads pull', { output: '', error: pullError });
        const pullOk = !pullError && pulled && pulled.ok !== false && !pulled.skipped && !pulled.degraded;
        if (!pullOk) {
            const why = pullError || `pull did not run (${summarizeRaw(JSON.stringify(pulled))})`;
            throw setupFailed(member,
                `has an existing beads database that cannot pull from the expected beads remote '${url}' (${summarizeRaw(why)}); ` +
                'it is most likely not a clone of that remote',
                "move that member's existing beads database aside (it is never deleted automatically) so the next sprint clones it from the remote, " +
                `or ${setupFix(url)}`,
                { step: 'pull', url });
        }
    };

    // Keep the set-up's work-tree changes out of every later commit on the
    // member -- after success AND failure (a failed set-up may have written).
    const protect = async () => {
        const after = await listTree();
        const changed = [...after.modified].filter((p) => !before.modified.has(p));
        const added = [...after.untracked].filter((p) => !before.untracked.has(p));
        for (const p of changed) {
            const r = await run(BEADS_TREE_COMMANDS.restore(p));
            if (!r.ok) {
                throw setupFailed(member, `could not restore tracked '${p}' after its beads set-up rewrote it (${summarizeRaw(r.error || r.output)})`,
                    `in that member's workFolder run 'git checkout -- ${p}', then rerun the sprint`, { step: 'protect', url });
            }
        }
        for (const p of added) {
            const entry = `${rootPrefix}${p}`;
            const r = await run(shell.ensureGitExcluded(entry));
            if (!r.ok) {
                throw setupFailed(member, `could not keep its set-up's untracked '${p}' out of commits (${summarizeRaw(r.error || r.output)})`,
                    `add '${entry}' to that member's git info/exclude, then rerun the sprint`, { step: 'protect', url });
            }
        }
        if (changed.length || added.length) {
            log(`[beads-identity] member '${member}': kept the beads set-up out of commits (restored: ${changed.join(', ') || 'none'}; excluded: ${added.join(', ') || 'none'}).`);
        }
    };

    let failure = null;
    try {
        await apply();
    } catch (err) {
        failure = err;
    }
    try {
        await protect();
    } catch (err) {
        if (!failure) failure = err;
        else log(`[beads-identity] member '${member}': ${err && err.message ? err.message : err}`);
    }
    if (failure) throw failure;
    return issued;
}

function assertMatches(member, expected, actual, cmp) {
    if (cmp.ok) return;
    const lines = cmp.mismatches.map((m) => `${m.field}: expected '${m.expected || '(unset)'}', actual '${m.actual || '(unset)'}'`);
    throw new BeadsIdentityError(
        `Beads identity check failed: member '${member}' resolves to a different beads database than expected ` +
        `(${actual.beadsDir}) -- ${lines.join('; ')}. Refusing to mutate beads on it.`,
        { reason: BEADS_IDENTITY_FAILURE_REASONS.MISMATCH, member, mismatches: cmp.mismatches, details: { actual, expected } }
    );
}

/**
 * The precondition itself. Probes the backlog member, then every other
 * distinct member. Throws BeadsIdentityError (reason MISMATCH) before
 * returning when a field that resolved on both sides differs; every probe
 * that could not resolve a field is a logged + published warning instead.
 * A beads-reading member with no database (or no sync.remote while the
 * expectation names one) is set up first and re-verified; failing that it
 * throws BEADS_SETUP_FAILED.
 *
 * @param {{
 *   command: Function, log?: Function, publishState?: Function,
 *   backlogMember: string, members: string[],
 *   expected?: object|null, prober?: object, timeoutS?: number,
 *   setupMembers?: string[], ensureVcsAuth?: (member: string) => Promise<void>,
 *   memberShell?: (member: string) => Promise<object>,
 *   onAuthFailure?: Function, pullBeads?: Function,
 *   setupTimeoutS?: number,
 * }} opts
 *   `setupMembers` names the beads-reading members the preflight may set
 *   up (omitted: every member); `ensureVcsAuth` refreshes a member's VCS
 *   credential before its set-up; `memberShell` resolves the member's
 *   OS/shell command primitives (see setupMemberBeads).
 * @returns {Promise<{
 *   expected: object|null, expectedFrom: 'args'|'backlog'|'none',
 *   members: Record<string, object>, warnings: string[], setUp: string[],
 * }>}
 *   `members[name]` is that member's probed identity record plus
 *   `unresolved: string[]` (the compared fields it could not report). A
 *   member with no beads database at all has NO entry -- only a warning.
 */
export async function verifyBeadsIdentity({ command, log = () => {}, publishState, backlogMember, members, expected = null, prober, timeoutS, setupMembers, memberShell, ensureVcsAuth, onAuthFailure, pullBeads, setupTimeoutS }) {
    if (typeof backlogMember !== 'string' || !backlogMember) {
        throw new TypeError('verifyBeadsIdentity: backlogMember must be a non-empty string');
    }
    const p = prober || createBeadsIdentityProber({ command, timeoutS });
    const ordered = [backlogMember, ...(Array.isArray(members) ? members : [])]
        .filter((m, i, arr) => typeof m === 'string' && m && arr.indexOf(m) === i);

    const warnings = [];
    const warn = (text) => {
        warnings.push(text);
        log(`${BEADS_IDENTITY_WARNING_PREFIX}${text}`);
    };
    const result = { expected: null, expectedFrom: 'args', members: {}, warnings, setUp: [] };
    // Members whose beads the preflight may set up; omitted = every member.
    const setupSet = setupMembers == null ? null : new Set(setupMembers);

    let backlogProbe = await p.probe(backlogMember);
    assertBdPresent(backlogMember, backlogProbe);
    const backlogHasDb = !!backlogProbe.identity.beadsDir;

    let expectedIdentity = expected;
    if (!expectedIdentity) {
        if (backlogHasDb) {
            result.expectedFrom = 'backlog';
            expectedIdentity = { ...backlogProbe.identity };
            log(`[beads-identity] no expected beads identity was supplied; taking the expectation from the backlog member '${backlogMember}'.`);
        } else {
            result.expectedFrom = 'none';
            warn(noExpectationWarning(backlogMember, backlogProbe));
        }
    }
    result.expected = expectedIdentity;

    // Fields the expectation itself lacks: warned once, up front, so the
    // per-member loop below never repeats them for every member.
    const expectedUnresolved = new Set();
    if (expectedIdentity) {
        for (const field of COMPARED_FIELDS) {
            if (!String(expectedIdentity[field] ?? '').trim()) {
                expectedUnresolved.add(field);
                warn(unresolvedExpectedWarning(field, result.expectedFrom, backlogMember));
            }
        }
    }

    // Checks one probed member: warns for what it could not report, throws
    // on a genuine mismatch, records the identity (or nothing at all when
    // it has no database). `compare` is false for the orchestrator when the
    // expectation was taken from it.
    function settle(member, probed, compare) {
        if (!probed.identity.beadsDir) {
            warn(noDatabaseWarning(member, probed));
            return;
        }
        const cmp = expectedIdentity
            ? compareIdentity(expectedIdentity, probed.identity, { skipUnresolved: true })
            : { ok: true, mismatches: [], unresolved: [] };
        const unresolved = [];
        for (const field of COMPARED_FIELDS) {
            if (String(probed.identity[field] ?? '').trim()) continue;
            unresolved.push(field);
            // The orchestrator's own gaps were already reported above as the
            // expectation's gaps when the expectation came from it.
            if (compare || !expectedUnresolved.has(field)) warn(unresolvedFieldWarning(member, field, probed));
        }
        if (compare) assertMatches(member, expectedIdentity, probed.identity, cmp);
        result.members[member] = { ...probed.identity, unresolved };
        log(formatBeadsIdentity(probed.identity, { label: `beads ok: ${member}` }));
    }

    // Sets up a beads-reading member that has no database, or a database
    // with no sync.remote while the expectation names one (see
    // setupMemberBeads), then re-probes it and returns the fresh probe. A
    // member that needs nothing -- or is not a beads reader -- is returned
    // untouched, with no command issued.
    async function ensureSetUp(member, probed) {
        if (setupSet && !setupSet.has(member)) return probed;
        const url = String((expectedIdentity && expectedIdentity.syncRemote) || '').trim();
        const hasDb = hasBeadsDatabase(probed.identity);
        if (hasDb && (String(probed.identity.syncRemote || '').trim() || !url)) return probed;
        // A member that already resolves to a DIFFERENT project (prefix,
        // sync.remote or origin that resolved and differs) is a MISMATCH,
        // exactly as before: nothing is written to it.
        if (expectedIdentity) {
            assertMatches(member, expectedIdentity, probed.identity, compareIdentity(expectedIdentity, probed.identity, { skipUnresolved: true }));
        }
        if (!url) {
            const state = probed.identity.beadsDir
                ? `has a beads workspace but no beads database (${probed.identity.beadsDir})`
                : `reports no beads database in its workFolder ('${BEADS_IDENTITY_PROBES.where}' -> ${probeDetail(probed, 'where')})`;
            throw setupFailed(member,
                `${state} and the sprint has no expected beads remote to set one up from`,
                `launch via the supervisor so --expect-beads carries the beads sync remote (or set sync.remote on the backlog member), or ${setupFix('')}`,
                { step: 'no-remote' });
        }
        await setupMemberBeads({ command, member, url, hasDb, memberShell, ensureVcsAuth, onAuthFailure, pullBeads, log, timeoutS: setupTimeoutS });
        p.forget(member);
        const again = await p.probe(member);
        assertBdPresent(member, again);
        const reprobeText = [...Object.values(again.raw), ...again.failures.map((f) => f.error)].join('\n');
        if (hasSchemaMigrationReport(reprobeText)) {
            throw setupFailed(member, `had its beads set up from '${url}', but bd reports a schema migration against that remote (${summarizeRaw(reprobeText)})`,
                SCHEMA_FIX, { step: 'verify', url, cause: 'schema-migration' });
        }
        if (!hasBeadsDatabase(again.identity)) {
            throw setupFailed(member, `still reports no beads database after its set-up from '${url}' ('${BEADS_IDENTITY_PROBES.where}' -> ${probeDetail(again, 'where')})`,
                setupFix(url), { step: 'verify', url });
        }
        if (normalizeRemoteUrl(again.identity.syncRemote) !== normalizeRemoteUrl(url)) {
            throw setupFailed(member, `reports sync.remote '${again.identity.syncRemote || '(unset)'}' after its set-up, not the expected '${url}'`,
                setupFix(url), { step: 'verify', url });
        }
        const wantPrefix = String(expectedIdentity.prefix || '').trim();
        if (wantPrefix && !String(again.identity.prefix || '').trim()) {
            throw setupFailed(member, `cannot report its beads prefix after its set-up from '${url}' ('${BEADS_IDENTITY_PROBES.where}' -> ${probeDetail(again, 'where')})`,
                setupFix(url), { step: 'verify', url });
        }
        result.setUp.push(member);
        log(`[beads-identity] member '${member}' beads set up from ${url}; re-verifying its identity.`);
        return again;
    }

    // The backlog member is only set up against a SUPPLIED expectation: when
    // the expectation is derived from it there is nothing to set it up from.
    if (expected) backlogProbe = await ensureSetUp(backlogMember, backlogProbe);
    settle(backlogMember, backlogProbe, !!expected);

    for (const member of ordered) {
        if (member === backlogMember) continue;
        let probed = await p.probe(member);
        assertBdPresent(member, probed);
        if (expectedIdentity || !probed.identity.beadsDir) probed = await ensureSetUp(member, probed);
        settle(member, probed, !!expectedIdentity);
    }

    if (typeof publishState === 'function') {
        publishState('beadsIdentity', {
            expected: result.expected,
            expectedFrom: result.expectedFrom,
            members: result.members,
            warnings: [...warnings],
            setUp: [...result.setUp],
        });
    }
    return result;
}
