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
export function discoverBeadsDir(opts = {}) {
    const fsImpl = opts.fs ?? fs;
    let dir = path.resolve(opts.cwd ?? process.cwd());
    for (;;) {
        const candidate = path.join(dir, BEADS_DIR_NAME);
        let found = false;
        try {
            found = fsImpl.existsSync(candidate)
                && (typeof fsImpl.statSync !== 'function' || fsImpl.statSync(candidate).isDirectory());
        } catch {
            found = false;
        }
        if (found) return { beadsDir: candidate, repoRoot: dir };
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
        throw new Error(`'bd where --json' failed in '${cwd}': ${detail}`);
    }

    let syncRemote = '';
    try {
        syncRemote = textOf((await execBd(['config', 'get', 'sync.remote', '--json'], execOpts)).stdout);
    } catch {
        syncRemote = '';
    }

    let repoRemote = '';
    try {
        repoRemote = textOf((await execGit('git', ['remote', 'get-url', 'origin'], execOpts)).stdout);
    } catch {
        repoRemote = '';
    }

    const identity = parseBeadsIdentity({ where, syncRemote, repoRemote });
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
export function formatStaleConfiguredProjectWarning(projectDir, configPath) {
    return `the configured project folder ${projectDir} does not exist or is not a directory ` +
        `(configured in ${configPath}). ` +
        "Backlog and scope-overlap checks are disabled and sprints will verify against the orchestrator member's beads instead. " +
        'The cwd walk-up is deliberately NOT used as a fallback here, so this supervisor cannot silently adopt an unrelated tracker. ' +
        `To fix: point the setting at the project folder from the console's project setting (or pass --beads-dir <project-or-.beads-path>), ${FIX_TAIL}`;
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
                warning: formatStaleConfiguredProjectWarning(configured, config.path),
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
        "Backlog and scope-overlap checks are disabled and sprints will verify against the orchestrator member's beads instead. " +
        `To fix: restart fleet-se from inside the project folder, or pass --beads-dir <project-or-.beads-path>, ${FIX_TAIL}`;
}

/** A `.beads` was found under `repoRoot` but the identity probe failed. */
export function formatProbeFailedWarning(repoRoot, error) {
    const detail = error && error.message ? error.message : String(error);
    return `could not resolve the beads identity under ${repoRoot}: ${detail}. ` +
        "Backlog and scope-overlap checks may fail and sprints will verify against the orchestrator member's beads instead. " +
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
    return {
        cwd,
        get() { return current; },
        getWarning() { return current ? null : warning; },
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
