// Cross-platform 'bd' invocation helper (apra-fleet-2cc.1).
//
// Root cause (run-24-adjacent Windows breakage): on Windows the globally
// installed `bd` (npm's @beads/bd) resolves to npm's extensionless POSIX
// shim on PATH -- Windows' CreateProcess cannot exec a shebang script
// directly, so `execFileSync('bd', [...])` (no `{ shell: true }`) throws
// `spawnSync bd ENOENT` even though the exact same invocation works fine
// interactively (the interactive shell resolves the PATHEXT-eligible
// `bd.cmd`/`bd.ps1` shim itself).
//
// SAFETY (apra-fleet-2cc.1 review fix): `execBdSync` below does NOT route
// through `{ shell: true }` on Windows. A 2026-07-30 review found that
// `{ shell: true }` makes Node join `bd` + every arg into ONE shell command
// line WITHOUT quoting -- verified empirically that `&`, `;`, `$()` etc.
// inside an array-passed arg reach cmd.exe as separate tokens/commands, a
// real injection surface for `scripts/sandbox-seed-beads.mjs`'s
// caller-controlled `--prefix` and `pathToFileURL(...)`-derived `--remote`
// values (neither of which `pathToFileURL` percent-encodes). Instead, on
// win32, `resolveWindowsBdScript()` locates the npm-generated `bd.cmd` shim
// on PATH and parses out the underlying `.../bin/bd.js` script it wraps
// (every npm Windows shim, regardless of whether it finds its own bundled
// `node.exe`, ends in `"<js path>" %*` -- see that function's doc comment),
// and `execBdSync` invokes THAT script directly via
// `execFileSync(process.execPath, [scriptPath, ...args])` -- a normal
// argv-array child-process spawn, no shell involved at all, so no shell
// metacharacter in any arg can ever be reinterpreted. This is strictly safer
// than quoting for cmd.exe (notoriously easy to get subtly wrong) and avoids
// Windows' CreateProcess-cannot-exec-a-shebang-script problem at the same
// time, since we bypass the `.cmd` file (and its shebang/PATHEXT dance)
// entirely. On non-Windows platforms `resolveWindowsBdScript()` always
// returns `null` (a real `bd` binary/symlink there already execs fine via a
// plain, shell-less `execFileSync('bd', args)`), so POSIX behavior/safety is
// unchanged from before this fix -- no `{ shell: true }` there either now,
// closing the same injection surface on POSIX too.
//
// If `bd.cmd` cannot be found on PATH or its content does not match the
// expected npm-shim shape (e.g. a future npm shim-generator format change),
// `execBdSync` falls back to the pre-fix `{ shell: true }` invocation so a
// legitimately-installed `bd` still runs rather than hard-failing -- this
// fallback is the ONLY place this module still carries the shell-quoting
// risk described above, and is expected to be rare in practice.
//
// See also: `execBdAsync` (apra-fleet-xuo.2), the async counterpart used by
// `packages/apra-fleet-se/src/supervisor/backlog.mjs` and `scope-
// overlap.mjs`, which additionally validates every arg against an allowlist
// charset (`assertSafeArgs` below) before its own `{ shell: true }` fallback
// path could ever see it -- appropriate there because both of ITS callers
// only ever pass structured bd subcommands/flags/issue-ids, never the kind
// of free-text values (URLs, operator-supplied prefixes) `execBdSync`'s
// callers legitimately need to pass through untouched.

import { execFileSync as nodeExecFileSync, execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const nodeExecFileAsync = promisify(nodeExecFile);

/**
 * Locates the npm-generated `bd.cmd` shim on PATH and extracts the
 * underlying `bin/bd.js` script path it wraps, so callers can invoke that
 * script directly (`execFileSync(process.execPath, [scriptPath, ...args])`)
 * instead of the `.cmd` file itself -- no shell required at all. Returns
 * `null` (never throws) when: not on win32, `bd.cmd` is not found on any
 * PATH entry, or its content does not match npm's shim shape -- callers
 * treat `null` as "fall back to the pre-fix `{ shell: true }` invocation".
 *
 * npm's Windows shim for a bin script always ends with a line invoking the
 * wrapped script via a DOUBLE-QUOTED path ending in `.js`, immediately
 * followed by `%*` (forward every argv on to the script) -- e.g.:
 *   "%_prog%"  "%dp0%\node_modules\@beads\bd\bin\bd.js" %*
 * regardless of which of the shim's own two branches picked `_prog` (its
 * bundled `node.exe` if present, else a bare `node` on PATH) -- so matching
 * on that trailing `"<...>.js"` immediately before `%*` is stable across
 * both branches and does not depend on `_prog`'s value at all.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   platform?: NodeJS.Platform,
 *   existsFn?: (p: string) => boolean,
 *   readFileFn?: (p: string, enc: string) => string,
 * }} [deps] - injectable for tests, so this is testable on any host platform
 *   without depending on a real `bd` install.
 * @returns {string|null}
 */
export function resolveWindowsBdScript(deps = {}) {
    const env = deps.env ?? process.env;
    const platform = deps.platform ?? process.platform;
    const existsFn = deps.existsFn ?? existsSync;
    const readFileFn = deps.readFileFn ?? readFileSync;
    if (platform !== 'win32') return null;

    // Deliberately path.win32, not the bare `path` import: this function
    // models Windows PATH/path semantics (';'-delimited, '\'-separated) even
    // when `platform: 'win32'` is injected on a host actually running
    // POSIX (e.g. these unit tests on macOS/ubuntu CI runners) -- the bare
    // `path` module's `.delimiter`/`.join` follow process.platform, NOT the
    // injected `platform` param, so using it here silently breaks PATH
    // splitting (a Windows PATH entry's drive-letter colon, e.g. 'C:\Users\
    // ...', gets misread as a second POSIX PATH entry split on ':') and path
    // joining (POSIX '/' separators) on any non-Windows host -- exactly the
    // failure this comment fixed (apra-fleet CI regression: 'expected null'
    // on macos-latest/ubuntu-latest, where resolveWindowsBdScript is only
    // ever exercised via this injectable-platform test path).
    const pathDirs = String(env.PATH ?? env.Path ?? '').split(path.win32.delimiter).filter(Boolean);
    for (const dir of pathDirs) {
        const cmdPath = path.win32.join(dir, 'bd.cmd');
        if (!existsFn(cmdPath)) continue;
        let content;
        try {
            content = readFileFn(cmdPath, 'utf-8');
        } catch {
            continue;
        }
        const match = content.match(/"%dp0%\\([^"]+\.js)"\s*%\*/);
        if (!match) continue;
        return path.win32.join(dir, match[1]);
    }
    return null;
}

/**
 * Runs `bd <args>`, safely and cross-platform (see module doc above for the
 * full rationale):
 *   - win32: resolves the real `.../bin/bd.js` script `bd.cmd` wraps
 *     (`resolveWindowsBdScript()`) and invokes it directly via
 *     `execFileSync(process.execPath, [scriptPath, ...args])` -- no shell.
 *   - everywhere else, or if that resolution fails: `execFileSync('bd', args)`
 *     directly (POSIX) / with `{ shell: true }` (the pre-fix Windows
 *     fallback, only reached if `bd.cmd` could not be resolved).
 *
 * @param {string[]} args - argv passed to `bd` (e.g. ['dolt', 'remote', 'list', '--json'])
 * @param {import('node:child_process').ExecFileSyncOptions} [options] - forwarded as-is (cwd, encoding, stdio, ...).
 * @param {typeof nodeExecFileSync} [execFileSyncImpl] - injectable for tests (same signature as `node:child_process`'s `execFileSync`); defaults to the real one.
 * @param {typeof resolveWindowsBdScript} [resolveWindowsBd] - injectable for tests, so the win32-only resolution path is exercisable/deterministic on any host platform.
 * @returns {Buffer|string}
 */
export function execBdSync(args, options = {}, execFileSyncImpl = nodeExecFileSync, resolveWindowsBd = resolveWindowsBdScript) {
    if (!Array.isArray(args)) {
        throw new TypeError('execBdSync requires args to be an array of strings');
    }
    const scriptPath = resolveWindowsBd();
    if (scriptPath) {
        return execFileSyncImpl(process.execPath, [scriptPath, ...args], { ...options, shell: false });
    }
    // Fallback: pre-fix behavior. On POSIX this is what already worked (a
    // real `bd` binary/symlink execs fine without a shell); on win32 this
    // path is only reached when `bd.cmd` could not be resolved above, and
    // still needs `{ shell: true }` to get past Windows' cannot-exec-a-
    // shebang-script limitation -- see the module doc's fallback note for
    // why this one remaining path still carries the quoting risk.
    const needsShell = (process.platform === 'win32');
    return execFileSyncImpl('bd', args, { ...options, shell: needsShell });
}

// execBdAsync's two current callers (backlog.mjs's fetchAllBeadsRaw(),
// scope-overlap.mjs's bdListChildren()) only ever make structured list/query
// invocations: bd subcommands/flags (letters, digits, '-', '--'), issue ids
// (letters/digits/'.'/'_'/'-', same charset runner.js's ISSUE_ID_PATTERN /
// validateIssueId() already enforce at the launch API boundary), and small
// numeric values. This allowlist is scoped to THAT usage, not to 'bd' as a
// whole -- free-text values a different invocation might carry (e.g. `bd
// create --title "..."`, `--reason=...`) would legitimately contain
// characters this pattern rejects, which is exactly why `execBdSync` (used by
// callers that DO pass free text, e.g. sandbox-seed-beads.mjs) does not apply
// this same validation; a shared allowlist tight enough to be a real
// injection backstop cannot also cover arbitrary free text.
const SAFE_ARG_PATTERN = /^[A-Za-z0-9_.\-]+$/;

/**
 * Rejects any arg containing a shell metacharacter before it can ever reach
 * `{ shell: true }`. See `execBdAsync`'s doc comment for why this exists.
 * @param {string[]} args
 */
function assertSafeArgs(args) {
    for (const a of args) {
        if (typeof a !== 'string' || !SAFE_ARG_PATTERN.test(a)) {
            throw new TypeError(`execBdAsync: unsafe bd argument ${JSON.stringify(a)} (must match ${SAFE_ARG_PATTERN})`);
        }
    }
}

/**
 * Async counterpart to `execBdSync`, for the `execFileAsync`-based callers
 * (apra-fleet-xuo.2): `packages/apra-fleet-se/src/supervisor/backlog.mjs`'s
 * `fetchAllBeadsRaw()` and `scope-overlap.mjs`'s `bdListChildren()` previously
 * each hand-rolled `execFileAsync('bd', [...], { shell: true })` directly.
 *
 * Still uses `{ shell: true }` (required on Windows -- as of the Node
 * CVE-2024-27980 fix, `execFile`/`spawn` refuse to invoke a `.bat`/`.cmd`
 * file directly at all without it, throwing `spawn EINVAL`; there is no
 * shell-free way to resolve the npm-installed `bd.cmd` shim). What changes
 * from a bare `execFileAsync('bd', args, { shell: true })` is `assertSafeArgs()`
 * below: every arg is validated against an allowlist charset BEFORE the
 * shell ever sees it, so the metacharacter-injection risk `shell: true`
 * carries (verified empirically: Node does not safely quote array args for
 * `cmd.exe` -- `&`, `;`, `$()`, `()` inside an argument value all reach the
 * shell as separate tokens/commands on Windows even though args are passed
 * as an array) is closed at the helper level instead of depending on every
 * call site remembering to validate its own caller-controlled values (as
 * `scope-overlap.mjs` already did for `parentId` via `validateIssueId()`).
 *
 * @param {string[]} args - argv passed to `bd` (e.g. ['list', '--json', '--limit', '0']); every element must match `SAFE_ARG_PATTERN`.
 * @param {import('node:child_process').ExecFileOptions} [options] - forwarded as-is (cwd, encoding, ...); `shell` is always forced to `true` regardless of what is passed here.
 * @param {typeof nodeExecFileAsync} [execFileAsyncImpl] - injectable for tests (same signature as `promisify(require('node:child_process').execFile)`); defaults to the real one.
 * @returns {Promise<{stdout: string|Buffer, stderr: string|Buffer}>}
 */
export function execBdAsync(args, options = {}, execFileAsyncImpl = nodeExecFileAsync) {
    if (!Array.isArray(args)) {
        throw new TypeError('execBdAsync requires args to be an array of strings');
    }
    assertSafeArgs(args);
    return execFileAsyncImpl('bd', args, { ...options, shell: true });
}
