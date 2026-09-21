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
//     can hard-fail BEFORE binding its port when no .beads is reachable, and
//     so the sprint children get the project root (not a subfolder) as cwd.
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
// Deliberately NOT here: setting BEADS_DIR, or any persisted config file.
// The operator's cwd (or an explicit `--beads-dir`) is the one input.
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { execBdAsync } from './lib/exec-bd.mjs';
import { parseBeadsIdentity } from '../../fleet-sprint/beads-identity.mjs';

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

/**
 * Holds the supervisor's resolved identity. `refresh()` re-runs the probes
 * (GET /api/health?refresh=1) and REPLACES the held record only on success --
 * a transient probe failure leaves the last good identity in place and
 * rethrows, so a reader never sees a half-updated record.
 * @param {{
 *   cwd?: string,
 *   probe?: (opts: { cwd: string }) => Promise<object>,
 *   initial?: object|null,
 * }} [deps]
 * @returns {{ get(): object|null, refresh(): Promise<object>, cwd: string }}
 */
export function createBeadsIdentityState(deps = {}) {
    const cwd = path.resolve(deps.cwd ?? process.cwd());
    const probe = deps.probe ?? probeBeadsIdentity;
    let current = deps.initial ?? null;
    return {
        cwd,
        get() { return current; },
        async refresh() {
            const next = await probe({ cwd });
            current = next;
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
