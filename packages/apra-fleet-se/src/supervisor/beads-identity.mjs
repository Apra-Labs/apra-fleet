// =============================================================================
// Supervisor beads identity -- which .beads THIS supervisor process runs
// against, resolved once at startup and displayed everywhere it matters.
// =============================================================================
//
// The supervisor runs `bd` itself in exactly three read-only places
// (backlog.mjs's full-tracker fetch, scope-overlap.mjs's two list calls),
// always in its own process cwd, so bd's walk-up discovery silently decides
// which database those reads hit. Every sprint child it spawns (spawner.mjs)
// inherits that cwd too. Nothing used to show which .beads that was, and a
// supervisor started from the wrong folder would happily serve an empty
// backlog or dispatch sprints against an unrelated tracker.
//
// This module is the supervisor half of the shared contract in
// ../../fleet-sprint/beads-identity.mjs (the pure parse/compare/format
// helpers both sides use):
//   - discoverBeadsDir(): the same walk-up bd performs, done here so serve
//     can WARN loudly at startup when no .beads is reachable (the server
//     still starts, with the identity "unknown" -- see
//     createBeadsIdentityState), and so the sprint children get the project
//     root (not a subfolder) as cwd.
//   - probeBeadsIdentity(): the three read-only probes (`bd where --json`,
//     `bd config get sync.remote --json`, `git remote get-url origin`) run in
//     that cwd and parsed into one { beadsDir, prefix, syncRemote,
//     repoRemote } record. beadsDir comes from bd's OWN answer (bd is
//     git-worktree aware and may resolve a worktree's .beads to the main
//     checkout's database), which is why discovery alone is not the identity.
//   - createBeadsIdentityState(): the resolved record, held for the health
//     route / dashboard header / spawner (`--expect-beads`), re-probeable on
//     demand (GET /api/health?refresh=1).
//
//   - resolveProjectDir(): the PRECEDENCE that decides which folder the above
//     run against -- `--beads-dir`, else the persisted project folder, else
//     the cwd walk-up. See its own comment for the severity asymmetry.
//
// Deliberately still NOT here: setting BEADS_DIR. That remains bd's own
// environment knob and nothing in the supervisor sets it; the resolved folder
// is expressed by chdir'ing into it, exactly as `--beads-dir` always has.
//
// NOTE (history): this header used to say no persisted config file was
// consulted either, and that the operator's cwd or an explicit `--beads-dir`
// was the ONE input. That stopped being true when the supervisor's project
// folder became a persisted setting: a service's working directory is the
// installed engine path, which has no relationship to any user project, so
// resolution could never reach a real project out of the box. The persisted
// folder is read through ./project-config.mjs (the only owner of that file);
// this module only sequences the three sources.
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { execBdAsync } from './lib/exec-bd.mjs';
import { parseBeadsIdentity } from '../../fleet-sprint/beads-identity.mjs';
import { readSupervisorConfig } from './project-config.mjs';

const nodeExecFileAsync = promisify(nodeExecFile);

/** Directory name bd discovers by walking up from its cwd. */
export const BEADS_DIR_NAME = '.beads';

/** bd's redirect file: a .beads holding only this points at the real database. */
export const REDIRECT_FILE = 'redirect';

/** File a real project .beads always holds (bd init) and bd's global-state ~/.beads never does. */
export const PROJECT_DB_MARKER = 'metadata.json';

/**
 * Walks up from `cwd` (inclusive) to the filesystem root looking for the
 * first directory that contains a `.beads` entry -- the same discovery bd
 * performs. Returns `{ beadsDir, repoRoot }` (repoRoot = the directory that
 * holds `.beads`) or `null` when no ancestor has one.
 *
 * `fs` is injectable so a test can drive an in-memory layout on any host
 * without touching real disk; only `existsSync` (and optionally `statSync`)
 * is used.
 * @param {{ cwd?: string, fs?: { existsSync: (p: string) => boolean, statSync?: (p: string) => { isDirectory(): boolean } } }} [opts]
 * @returns {{ beadsDir: string, repoRoot: string }|null}
 */
/**
 * The ONE definition of "this .beads directory holds a project database".
 * bd keeps machine-global state (eventsData, machine-id) in ~/.beads, which
 * must never be mistaken for a project; a real project's .beads always holds
 * metadata.json (written by bd init). Shared by discoverBeadsDir() and
 * project-route.mjs's hasBeadsDb report so the two can never disagree.
 * @param {string} beadsDir - the candidate .beads directory path
 * A .beads holding only a `redirect` file to a directory with metadata.json also
 * qualifies; discoverBeadsDir() then stops at the LOCAL .beads (bd follows the
 * redirect itself) instead of walking into a parent project.
 * @param {{ existsSync: (p: string) => boolean, statSync?: (p: string) => { isDirectory(): boolean }, readFileSync?: (p: string, enc: string) => string }} [fsImpl]
 * @returns {boolean}
 */
export function isProjectBeadsDir(beadsDir, fsImpl = fs) {
    try {
        if (!isDir(beadsDir, fsImpl)) return false;
        if (fsImpl.existsSync(path.join(beadsDir, PROJECT_DB_MARKER))) return true;
        // Redirect-only .beads (bd's supported layout, e.g. a worktree):
        // a `redirect` file whose content is the real .beads. SINGLE HOP only:
        // the target must itself hold metadata.json, so a redirect to another
        // redirect-only .beads (or to itself) is simply not a project and can
        // never recurse. bd resolves a relative target against the PARENT of
        // the .beads dir (verified with bd 1.3.0), not the .beads dir itself.
        const redirectFile = path.join(beadsDir, REDIRECT_FILE);
        if (!fsImpl.existsSync(redirectFile) || typeof fsImpl.readFileSync !== 'function') return false;
        const raw = String(fsImpl.readFileSync(redirectFile, 'utf-8')).trim();
        if (!raw) return false;
        const target = path.resolve(path.dirname(beadsDir), raw);
        return isDir(target, fsImpl) && fsImpl.existsSync(path.join(target, PROJECT_DB_MARKER));
    } catch {
        return false;
    }
}

function isDir(p, fsImpl) {
    return fsImpl.existsSync(p) && (typeof fsImpl.statSync !== 'function' || fsImpl.statSync(p).isDirectory());
}

export function discoverBeadsDir(opts = {}) {
    const fsImpl = opts.fs ?? fs;
    let dir = path.resolve(opts.cwd ?? process.cwd());
    for (;;) {
        const candidate = path.join(dir, BEADS_DIR_NAME);
        if (isProjectBeadsDir(candidate, fsImpl))  return { beadsDir: candidate, repoRoot: dir };
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

/**
 * Resolves an operator-supplied `--beads-dir` value to the directory the
 * supervisor should chdir into before discovery: the value itself, or its
 * parent when it names the `.beads` directory directly. Throws when the
 * path does not exist or is not a directory. Pure apart from the injectable
 * fs, so serve's arg handling is unit-testable.
 * @param {string} value
 * @param {{ fs?: { existsSync: (p: string) => boolean, statSync: (p: string) => { isDirectory(): boolean } } }} [opts]
 * @returns {string} absolute directory path
 */
export function resolveBeadsDirArg(value, opts = {}) {
    const fsImpl = opts.fs ?? fs;
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error('--beads-dir requires a path');
    }
    const resolved = path.resolve(value.trim());
    let isDir = false;
    try {
        isDir = fsImpl.existsSync(resolved) && fsImpl.statSync(resolved).isDirectory();
    } catch {
        isDir = false;
    }
    if (!isDir) {
        throw new Error(`--beads-dir '${resolved}' does not exist or is not a directory`);
    }
    return path.basename(resolved) === BEADS_DIR_NAME ? path.dirname(resolved) : resolved;
}

function textOf(v) {
    if (v == null) return '';
    if (Buffer.isBuffer(v)) return v.toString('utf-8');
    return String(v);
}

/**
 * Runs the three identity probes in `cwd` and parses them into one record
 * (see ../../fleet-sprint/beads-identity.mjs's parseBeadsIdentity()).
 *
 *   - `bd where --json` failing (no reachable database, bd not installed)
 *     throws with a message that names the cwd -- there is no identity to
 *     report and the caller (serve) must not proceed.
 *   - an unset `sync.remote` is NOT an error (bd exits 0 with value ""):
 *     the field is simply ''. A failing `bd config get` is folded to '' too,
 *     since the where-probe above already proved the database is reachable.
 *   - `git remote get-url origin` failing (not a git repo, no origin) folds
 *     to '' for the same reason.
 *
 * `execBd`/`execGit` are injectable (same shapes as execBdAsync / the
 * promisified execFile) so tests never need a real bd or git.
 * @param {{
 *   cwd?: string,
 *   execBd?: (args: string[], options: object) => Promise<{ stdout: string|Buffer }>,
 *   execGit?: (file: string, args: string[], options: object) => Promise<{ stdout: string|Buffer }>,
 * }} [opts]
 * @returns {Promise<{ beadsDir: string, prefix: string, databasePath: string, syncRemote: string, repoRemote: string }>}
 */
export const PROBE_CAUSE_GIT_NOT_FOUND = 'git-not-found';

/** A child-process failure that means "executable not found", not "ran and exited non-zero". */
function isSpawnNotFound(err) {
    return Boolean(err) && (err.code === 'ENOENT' || /\bspawn \S+ ENOENT\b/.test(String(err.message ?? '')));
}

/**
 * How the supervisor was launched, from an EXPLICIT startup signal (serve's
 * --managed-service flag, passed by the installed service registration) --
 * never guessed from the environment.
 */
export const LAUNCH_MODE = Object.freeze({ INSTALLED_SERVICE: 'installed-service', STANDALONE: 'standalone' });

/**
 * The restart step that actually cycles THIS supervisor. 'apra-fleet restart'
 * only covers the installed service; a standalone fleet-se/serve launch is a
 * plain process the operator restarts themselves.
 * @param {string} [launchMode]
 * @returns {string}
 */
export function restartInstruction(launchMode) {
    return launchMode === LAUNCH_MODE.INSTALLED_SERVICE
        ? "run 'apra-fleet restart'"
        : 'restart the supervisor process yourself -- apra-fleet restart does not manage a standalone launch';
}

export async function probeBeadsIdentity(opts = {}) {
    const cwd = path.resolve(opts.cwd ?? process.cwd());
    const execBd = opts.execBd ?? execBdAsync;
    const execGit = opts.execGit ?? nodeExecFileAsync;
    const execOpts = { cwd, encoding: 'utf-8' };

    let where;
    try {
        where = textOf((await execBd(['where', '--json'], execOpts)).stdout);
    } catch (err) {
        const detail = textOf(err && (err.stderr || err.stdout)).trim() || (err && err.message) || String(err);
        if (isSpawnNotFound(err)) {
            throw new Error(`'bd' was not found on the supervisor's PATH (running 'bd where --json' in '${cwd}' failed: ${detail}). `
                + 'Install bd; if it was just installed, restart the supervisor so it picks up the new PATH.');
        }
        throw new Error(`'bd where --json' failed in '${cwd}': ${detail}`);
    }

    let syncRemote = '';
    try {
        syncRemote = textOf((await execBd(['config', 'get', 'sync.remote', '--json'], execOpts)).stdout);
    } catch {
        syncRemote = '';
    }

    let repoRemote = '';
    /** @type {{ repoRemote?: string }} */
    const probeCauses = {};
    try {
        repoRemote = textOf((await execGit('git', ['remote', 'get-url', 'origin'], execOpts)).stdout);
    } catch (err) {
        repoRemote = '';
        // A git that could not even be SPAWNED (not on the supervisor's PATH)
        // is a different problem from a non-zero exit (no origin remote), and
        // must not be reported with the same "git remote add origin" advice.
        if (isSpawnNotFound(err)) probeCauses.repoRemote = PROBE_CAUSE_GIT_NOT_FOUND;
    }

    const identity = parseBeadsIdentity({ where, syncRemote, repoRemote });
    // Non-enumerable so the identity's own shape (display summary, deep
    // equality, JSON) is unchanged; only the message formatters read it.
    Object.defineProperty(identity, 'probeCauses', { value: probeCauses, enumerable: false });
    if (!identity.beadsDir) {
        throw new Error(`'bd where --json' in '${cwd}' returned no .beads path: ${where.trim() || '(empty output)'}`);
    }
    return identity;
}

// The operator-facing warning texts for an UNKNOWN identity. Each one says
// what was found and what to do; the same string goes to the startup log
// (`[supervisor] WARNING: ...`), GET /api/health (`beadsWarning`) and the
// dashboard header. Generic on purpose: no product paths.
const FIX_TAIL = 'then GET /api/health?refresh=1.';

// =============================================================================
// PROJECT-FOLDER USABILITY -- the four fields a folder must resolve before a
// sprint can run against it, and the operator-facing text for each.
// =============================================================================
//
// The fleet-sprint engine's own precondition compares a member's identity
// against the backlog member's on ../../fleet-sprint/beads-identity.mjs's
// COMPARED_FIELDS and treats an INCOMPLETE identity as FATAL
// (isCompleteIdentity() there is the same predicate `missingIdentityFields()`
// below inverts -- the parity is asserted by a test, not restated by hand).
// A folder that cannot produce all four therefore cannot run a sprint at all,
// which is why setting one is refused at SET time rather than discovered at
// launch time by an operator who has already walked away.
//
// Each requirement carries BOTH what is missing and the single command that
// fixes it. Deliberately generic: no product name, no repository layout, no
// path of ours -- these strings are read by an operator pointing this
// supervisor at THEIR project.

/** @type {ReadonlyArray<{ field: string, label: string, fix: string }>} */
export const PROJECT_FOLDER_REQUIREMENTS = Object.freeze([
    Object.freeze({
        field: 'beadsDir',
        label: 'an initialised beads database (.beads)',
        fix: "run 'bd init' in that folder",
    }),
    Object.freeze({
        field: 'prefix',
        label: 'a beads issue prefix',
        fix: "run 'bd init' in that folder so its tracker has a prefix",
    }),
    Object.freeze({
        field: 'syncRemote',
        label: "the beads 'sync.remote' setting",
        fix: "run 'bd config set sync.remote <url>' in that folder",
    }),
    Object.freeze({
        field: 'repoRemote',
        label: "a git 'origin' remote",
        fix: "run 'git remote add origin <url>' in that folder",
    }),
]);

/**
 * Which of PROJECT_FOLDER_REQUIREMENTS an identity record failed to resolve.
 * Empty exactly when isCompleteIdentity() would say true (pinned by a test).
 * @param {object|null} identity
 * @returns {string[]}
 */
export function missingIdentityFields(identity) {
    return PROJECT_FOLDER_REQUIREMENTS
        .filter((req) => !(identity && identity[req.field]))
        .map((req) => req.field);
}

/** @param {string[]} missing */
function requirementsFor(missing, causes = {}, launchMode) {
    return PROJECT_FOLDER_REQUIREMENTS.filter((req) => missing.includes(req.field)).map((req) => {
        if (req.field === 'repoRemote' && causes && causes.repoRemote === PROBE_CAUSE_GIT_NOT_FOUND) {
            return {
                field: req.field,
                label: "the git executable (git was not found on the supervisor's PATH, so the 'origin' remote could not be read)",
                fix: `install git so it is on the supervisor's PATH; if git was just installed, ${restartInstruction(launchMode)} so it picks up the new PATH`,
            };
        }
        return req;
    });
}

/**
 * The SET-time refusal: why this folder cannot be adopted, and how to fix it.
 * `detail` (optional) is the raw probe failure -- 'bd' not on PATH, no
 * reachable database -- kept verbatim so the operator sees the real cause
 * rather than only our summary of it.
 * @param {string} projectDir
 * @param {string[]} missing
 * @param {string|null} [detail]
 * @returns {string}
 */
export function formatUnusableProjectFolderError(projectDir, missing, detail = null, opts = {}) {
    const reqs = requirementsFor(missing, opts.causes, opts.launchMode);
    const what = reqs.map((r) => r.label).join(', ');
    const verb = reqs.length === 1 ? 'is' : 'are';
    return `project folder '${projectDir}' cannot be used by sprints: ${what} ${verb} missing`
        + `${detail ? ` (${detail})` : ''}. To fix: ${reqs.map((r) => r.fix).join('; ')}.`;
}

/**
 * The STARTUP warning for a folder that was already adopted (configured, or
 * walked up to) and whose probe SUCCEEDED but came back incomplete. Never a
 * startup error -- the console must stay reachable so the setting can be
 * corrected -- but loud enough on GET /api/health that the operator is not
 * left to discover it when the first sprint dies on its identity check.
 * @param {string} repoRoot
 * @param {string[]} missing
 * @returns {string}
 */
export function formatIncompleteIdentityWarning(repoRoot, missing, opts = {}) {
    const reqs = requirementsFor(missing, opts.causes, opts.launchMode);
    const what = reqs.map((r) => r.label).join(', ');
    const verb = reqs.length === 1 ? 'is' : 'are';
    return `the beads identity under ${repoRoot} is incomplete: ${what} ${verb} missing. `
        + 'Sprints launched against this project folder will fail their beads identity check. '
        + `To fix: ${reqs.map((r) => r.fix).join('; ')}, then ${restartInstruction(opts.launchMode)} (or ${FIX_TAIL})`;
}

/**
 * Probe `cwd` and report whether it is a project folder a sprint could
 * actually run against. TOTAL: a probe that throws (no bd on PATH, no
 * reachable database) is reported as "everything missing" plus the raw
 * `detail`, never as a rejected promise -- the callers are a request handler
 * and a startup path, and neither may turn an unusable folder into a crash.
 *
 * `execBd`/`execGit` are forwarded to probeBeadsIdentity() so a test can
 * drive every branch with no real bd or git; `probe` itself is injectable for
 * the handful of cases that want to skip the parsing layer entirely.
 * @param {{ cwd?: string, execBd?: Function, execGit?: Function, probe?: Function }} [opts]
 * @returns {Promise<{ ok: boolean, identity: object|null, missing: string[], detail: string|null, error: string|null }>}
 */
export async function checkProjectFolderIdentity(opts = {}) {
    const cwd = path.resolve(opts.cwd ?? process.cwd());
    const probe = opts.probe ?? probeBeadsIdentity;
    let identity = null;
    let detail = null;
    try {
        identity = await probe({ cwd, execBd: opts.execBd, execGit: opts.execGit });
    } catch (err) {
        detail = err && err.message ? err.message : String(err);
    }
    const missing = missingIdentityFields(identity);
    return {
        ok: missing.length === 0,
        identity,
        missing,
        detail,
        error: missing.length === 0 ? null : formatUnusableProjectFolderError(cwd, missing, detail, {
            causes: identity && identity.probeCauses, launchMode: opts.launchMode,
        }),
    };
}

/**
 * The three sources a project folder can come from, in precedence order.
 * Reported on startup and on GET /api/health as `projectDirSource`.
 */
export const PROJECT_DIR_SOURCE = Object.freeze({
    FLAG: 'flag',
    CONFIG: 'config',
    WALK_UP: 'walk-up',
});

/**
 * A persisted project folder that is no longer usable (moved checkout,
 * unmounted volume, reimaged machine). Deliberately a WARNING, never a
 * startup error -- see resolveProjectDir().
 * @param {string} projectDir
 * @param {string} configPath
 * @returns {string}
 */
export function formatStaleConfiguredProjectWarning(projectDir, configPath, opts = {}) {
    return `the configured project folder ${projectDir} does not exist or is not a directory ` +
        `(configured in ${configPath}). ` +
        "Backlog and scope-overlap checks are disabled, and this supervisor has no backlog member, so it cannot launch sprints. " +
        'The cwd walk-up is deliberately NOT used as a fallback here, so this supervisor cannot silently adopt an unrelated tracker. ' +
        "To fix: point the setting at the project folder from the console's project setting " +
        '(or pass --beads-dir <project-or-.beads-path>), then RESTART the supervisor: ' + restartInstruction(opts.launchMode) + ' -- the setting is read ' +
        'only at startup, so GET /api/health?refresh=1 re-probes this same path and cannot pick up a new one.';
}

/**
 * The launch refusal for a supervisor whose project folder is unusable (a
 * configured folder that no longer exists / is not a directory): sprint
 * children run with that folder as their cwd, so spawning one could only fail.
 * @param {string} projectDir
 * @param {{ launchMode?: string }} [opts]
 * @returns {string}
 */
export function formatUnusableLaunchFolderError(projectDir, opts = {}) {
    return `sprint launch refused: the supervisor's project folder ${projectDir} does not exist or is not a directory, ` +
        "so a sprint child cannot be started in it. To fix: point the setting at the project folder from the console's " +
        `project setting (or pass --beads-dir <project-or-.beads-path>), then ${restartInstruction(opts.launchMode)}.`;
}

/**
 * Decide WHICH project folder this supervisor runs against, by precedence:
 *
 *   1. `--beads-dir` (the operator said so on this launch),
 *   2. the persisted `supervisor.config.json` project folder,
 *   3. the cwd walk-up (unchanged legacy behaviour).
 *
 * SEVERITY ASYMMETRY -- deliberate, not an oversight:
 *
 *   An explicit `--beads-dir` that does not exist THROWS (the caller turns
 *   that into a non-zero exit). An operator typed it on this very launch, and
 *   a typo must never be silently ignored in favour of some other folder.
 *
 *   A CONFIGURED folder that does not exist does NOT throw: it comes back
 *   `usable: false` with a warning, and the supervisor starts anyway. A
 *   persisted setting can go stale for reasons the operator is not present to
 *   fix -- a moved checkout, an unmounted volume, a reimaged machine -- and a
 *   supervisor that refuses to boot cannot serve the very console page that
 *   would let them correct it.
 *
 *   An unusable configured folder also does NOT fall through to the walk-up.
 *   Falling back would re-create exactly the bug the persisted setting exists
 *   to fix: the walk-up silently winning from the installed engine tree and
 *   the supervisor serving an unrelated tracker as if it were the project.
 *   A stale setting must fail loudly-but-softly, not resolve to the wrong
 *   thing quietly.
 *
 * Returns `chdir` = the folder the caller should chdir into (null when there
 * is nothing to change to: the walk-up case, or an unusable configured
 * folder), since bd resolves by walking up from the process cwd.
 *
 * `readConfig` and `fs` are injectable so a test can drive every branch
 * without a real data dir or real directories on disk.
 * @param {{
 *   flag?: string,
 *   cwd?: string,
 *   fs?: object,
 *   readConfig?: () => Promise<{ configured: boolean, projectDir: string|null, reason: string|null, path: string }>,
 * }} [opts]
 * @returns {Promise<{ projectDir: string, source: string, chdir: string|null, usable: boolean, warning: string|null, configReason: string|null }>}
 */
export async function resolveProjectDir(opts = {}) {
    const cwd = path.resolve(opts.cwd ?? process.cwd());
    const fsImpl = opts.fs ?? fs;
    const flag = opts.flag;

    // 1. The flag. resolveBeadsDirArg() throws on a nonexistent path -- that
    //    throw IS the typo-is-fatal half of the asymmetry above.
    if (flag !== undefined && flag !== null) {
        const dir = resolveBeadsDirArg(flag, { fs: fsImpl });
        return {
            projectDir: dir,
            source: PROJECT_DIR_SOURCE.FLAG,
            chdir: dir,
            usable: true,
            warning: null,
            configReason: null,
        };
    }

    // 2. The persisted setting. Reading is total (project-config.mjs never
    //    throws), so a malformed config simply behaves as "not configured".
    const readConfig = opts.readConfig ?? (() => readSupervisorConfig({ cwd }));
    const config = await readConfig();
    if (config && config.configured && config.projectDir) {
        const configured = config.projectDir;
        let isDir = false;
        try {
            isDir = fsImpl.existsSync(configured)
                && (!fsImpl.statSync || fsImpl.statSync(configured).isDirectory());
        } catch {
            isDir = false;
        }
        if (!isDir) {
            return {
                projectDir: configured,
                source: PROJECT_DIR_SOURCE.CONFIG,
                chdir: null,
                usable: false,
                warning: formatStaleConfiguredProjectWarning(configured, config.path, { launchMode: opts.launchMode }),
                configReason: null,
            };
        }
        // Accept a `.beads` path as well as a project path, exactly as the
        // flag does, so the two inputs cannot disagree about the same folder.
        const normalized = path.basename(configured) === BEADS_DIR_NAME ? path.dirname(configured) : configured;
        return {
            projectDir: normalized,
            source: PROJECT_DIR_SOURCE.CONFIG,
            chdir: normalized,
            usable: true,
            warning: null,
            configReason: null,
        };
    }

    // 3. The walk-up: byte-identical to the pre-setting behaviour -- no chdir,
    //    resolution happens from the process cwd as it always did.
    return {
        projectDir: cwd,
        source: PROJECT_DIR_SOURCE.WALK_UP,
        chdir: null,
        usable: true,
        warning: null,
        configReason: config ? config.reason : null,
    };
}

/** No `.beads` reachable by walking up from `cwd`. */
export function formatNoBeadsWarning(cwd) {
    return `no beads database found walking up from ${cwd}. ` +
        "Backlog and scope-overlap checks are disabled, and this supervisor has no backlog member, so it cannot launch sprints. " +
        `To fix: restart fleet-se from inside the project folder, or pass --beads-dir <project-or-.beads-path>, ${FIX_TAIL}`;
}

/** A `.beads` was found under `repoRoot` but the identity probe failed. */
export function formatProbeFailedWarning(repoRoot, error) {
    const detail = error && error.message ? error.message : String(error);
    return `could not resolve the beads identity under ${repoRoot}: ${detail}. ` +
        "Backlog and scope-overlap checks may fail and sprints will verify against the backlog member's beads instead. " +
        `To fix: run 'bd where' in ${repoRoot} to see the error, ensure bd is on PATH and the project is initialised (bd init / sync.remote set), ${FIX_TAIL}`;
}

/**
 * Holds the supervisor's resolved identity, or the warning explaining why
 * it is unknown. `refresh()` re-runs the probes (GET /api/health?refresh=1)
 * and REPLACES the held record only on success -- a transient probe failure
 * leaves the last good identity in place and rethrows, so a reader never
 * sees a half-updated record. When there is NO last good identity (startup
 * found no .beads, or its probe failed) a successful refresh recovers it
 * and clears the warning; a failed one refreshes the warning text so the
 * health route and dashboard show the current reason.
 * @param {{
 *   cwd?: string,
 *   probe?: (opts: { cwd: string }) => Promise<object>,
 *   initial?: object|null,
 *   warning?: string|null,
 * }} [deps]
 * @returns {{ get(): object|null, getWarning(): string|null, refresh(): Promise<object>, cwd: string }}
 */
export function createBeadsIdentityState(deps = {}) {
    const cwd = path.resolve(deps.cwd ?? process.cwd());
    const probe = deps.probe ?? probeBeadsIdentity;
    let current = deps.initial ?? null;
    let warning = current ? null : (deps.warning ?? null);
    // An identity that RESOLVED can still be unusable: bd answered, but the
    // record is missing a field the engine's own precondition treats as
    // fatal. That case used to report no warning at all (the old rule was
    // "a record means nothing to say"), so Health looked healthy right up
    // until the first sprint died on its identity check. The warning is
    // therefore DERIVED from the held record rather than only carried from
    // startup, which also means refresh() cannot leave a stale one behind.
    const warningFor = (id) => {
        if (!id) return warning;
        const missing = missingIdentityFields(id);
        return missing.length
            ? formatIncompleteIdentityWarning(cwd, missing, { causes: id.probeCauses, launchMode: deps.launchMode })
            : null;
    };
    return {
        cwd,
        get() { return current; },
        getWarning() { return warningFor(current); },
        async refresh() {
            let next;
            try {
                next = await probe({ cwd });
            } catch (err) {
                if (!current) warning = formatProbeFailedWarning(cwd, err);
                throw err;
            }
            current = next;
            warning = null;
            return next;
        },
    };
}

/**
 * The four display fields the health route, ledger entry and dashboard all
 * carry (never `databasePath` -- a host-local detail).
 * @param {object|null} id
 * @returns {{ dir: string, prefix: string, syncRemote: string, repoRemote: string }|null}
 */
export function toBeadsSummary(id) {
    if (!id) return null;
    return {
        dir: id.beadsDir || '',
        prefix: id.prefix || '',
        syncRemote: id.syncRemote || '',
        repoRemote: id.repoRemote || '',
    };
}
