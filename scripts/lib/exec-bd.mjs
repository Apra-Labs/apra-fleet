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
// RELEASE-BINARY RESOLUTION (apra-fleet-i9ag.13.4). `apra-fleet install` no
// longer runs `npm install -g @beads/bd`: it downloads the gastownhall/beads
// RELEASE BINARY and extracts it into the fleet bin directory
// (`~/.apra-fleet/bin/bd`, `bd.exe` on Windows), and it deliberately does NOT
// add that directory to PATH and does NOT edit any shell profile -- exactly
// how the `apra-fleet` binary itself is shipped. Two consequences this module
// now handles, via `resolveBdInvocation()` below:
//   1. A bare `bd` on PATH cannot be assumed on ANY platform after a fresh
//      install, so every helper here resolves the installed binary by its
//      ABSOLUTE path under the fleet bin directory first.
//   2. On Windows there is then no npm-generated `bd.cmd` at all, so
//      `resolveWindowsBdScript()` returns null and the pre-existing
//      `{ shell: true }` fallback would have become the NORMAL Windows path
//      -- silently turning the one remaining injection surface documented
//      above into the default. Resolving the real binary and `execFile`-ing
//      it directly keeps the shell-less argv-array spawn on both POSIX and
//      Windows.
// Resolution order (identical in both copies of this file, and asserted by
// the drift guard in tests/exec-bd.test.ts):
//   1. `APRA_FLEET_BD_PATH` -- explicit operator override; if it is set but
//      names nothing on disk that is a LOUD error, not a silent fall-through.
//   2. `<fleet bin dir>/bd` (or `bd.exe`), where the directory is
//      `APRA_FLEET_BIN_DIR` if set, else `<home>/.apra-fleet/bin`.
//   3. A directly-executable `bd` found on PATH (a developer who put one
//      there, or any non-npm install).
//   4. The npm `bd.cmd` shim on Windows (`resolveWindowsBdScript()`), kept
//      working for developers who still have bd from npm.
//   5. Last resort only: bare `bd`, with the legacy `{ shell: true }` on
//      win32. Sources 1-4 are all shell-less argv-array spawns.
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
import os from 'node:os';

const nodeExecFileAsync = promisify(nodeExecFile);

// ---------------------------------------------------------------------------
// Child-process stdout buffer (dolt sync budget review round 2, item 1)
// ---------------------------------------------------------------------------
//
// Node's execFile/execFileSync default `maxBuffer` is 1MiB, and exceeding it
// does not truncate -- it KILLS the child and rejects with
// ERR_CHILD_PROCESS_STDIO_MAXBUFFER. Measured on this repo's tracker:
// `bd list --all --limit 0 --json` (scope-overlap.mjs's launch-overlap guard
// and dashboard.mjs's progress bars) emitted ~2.96MB at 766 issues, i.e. every
// `POST /api/sprints` launch failed; backlog.mjs's open-only fetch was already
// at ~967KB (92% of the default) for 234 open issues -- one moderately sized
// issue from the identical crash.
//
// The bound is therefore set HERE, once, so every caller inherits it rather
// than each call site needing to remember its own. 64MB against a measured
// ~3.9KB average full row is ~16,500 rows of headroom (the tracker peaked at
// 1,522 rows before a cleanup), and an unused buffer costs nothing -- Node
// allocates only what the child actually writes.
//
// A caller may still pass its own `maxBuffer` (it is spread AFTER this
// default, so an explicit value wins); omitting it gets 64MB, never 1MiB.

/** Explicit stdout/stderr ceiling for every `bd` invocation. */
export const BD_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** Warn once an actual `bd` output crosses this, so growth toward the ceiling
 *  above is visible in logs instead of arriving as a silent cliff. */
export const BD_LARGE_OUTPUT_WARN_BYTES = 8 * 1024 * 1024;

/** @param {unknown} out @returns {number} */
function outputByteLength(out) {
    if (out == null) return 0;
    if (Buffer.isBuffer(out)) return out.length;
    if (typeof out === 'string') return Buffer.byteLength(out);
    return 0;
}

/**
 * Emit a warn line when a `bd` invocation's output crosses
 * BD_LARGE_OUTPUT_WARN_BYTES. Never throws; returns the measured byte length.
 * @param {string[]} args
 * @param {unknown} out
 * @param {(msg: string) => void} [warn]
 * @returns {number}
 */
export function warnIfLargeBdOutput(args, out, warn = console.warn) {
    const bytes = outputByteLength(out);
    if (bytes > BD_LARGE_OUTPUT_WARN_BYTES) {
        const mb = (bytes / (1024 * 1024)).toFixed(1);
        const capMb = Math.round(BD_MAX_BUFFER_BYTES / (1024 * 1024));
        try {
            warn(`[exec-bd] WARNING: 'bd ${args.join(' ')}' returned ${mb}MB of output (buffer ceiling is ${capMb}MB). This grows with tracker size; raise BD_MAX_BUFFER_BYTES or narrow the query before it reaches the ceiling.`);
        } catch {
            // A broken logger must never break a bd invocation.
        }
    }
    return bytes;
}

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

// ---------------------------------------------------------------------------
// Release-binary resolution (apra-fleet-i9ag.13.4)
// ---------------------------------------------------------------------------

/** Operator override naming an explicit `bd` executable; wins over every other source. */
export const BD_PATH_ENV_VAR = 'APRA_FLEET_BD_PATH';

/** Override for the fleet bin directory the installed `bd` is looked up in
 *  (mirrors how `APRA_FLEET_DATA_DIR` overrides the fleet data directory). */
export const FLEET_BIN_DIR_ENV_VAR = 'APRA_FLEET_BIN_DIR';

/** The on-disk basename of the beads release binary for a platform. */
export function bdBinaryName(platform) {
    return platform === 'win32' ? 'bd.exe' : 'bd';
}

/**
 * The directory `apra-fleet install` extracts the beads release binary into:
 * `APRA_FLEET_BIN_DIR` when set, else `<home>/.apra-fleet/bin` -- the same
 * BIN_DIR src/cli/config.ts exports and src/cli/install.ts's beads step
 * passes to downloadAndExtractBeads(). The installer never adds it to PATH.
 *
 * Like resolveWindowsBdScript(), this uses path.win32/path.posix explicitly
 * rather than the bare `path` module, so an injected `platform` is honoured
 * on a host actually running the other platform (the bare module follows
 * process.platform, not the injected value).
 *
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, homedir?: () => string }} [deps]
 * @returns {string}
 */
export function resolveFleetBinDir(deps = {}) {
    const env = deps.env ?? process.env;
    const platform = deps.platform ?? process.platform;
    const p = platform === 'win32' ? path.win32 : path.posix;
    const override = env[FLEET_BIN_DIR_ENV_VAR];
    if (override) return override;
    const homedirFn = deps.homedir ?? (() => os.homedir());
    const home = (platform === 'win32' ? env.USERPROFILE : env.HOME) || homedirFn();
    return p.join(home, '.apra-fleet', 'bin');
}

/**
 * @typedef {object} BdInvocation
 * @property {'env'|'fleet-bin'|'path'|'npm-shim'|'fallback'} source - which resolution step won.
 * @property {string} command - the executable to spawn.
 * @property {string[]} prefixArgs - args to prepend before the caller's argv (only the npm-shim path uses this).
 * @property {boolean} shell - always false except on the last-resort win32 fallback.
 */

/**
 * Resolves HOW to invoke `bd` on this machine, in the order documented in the
 * module header. Every source except the last-resort fallback yields a
 * shell-less argv-array spawn, so no shell metacharacter in any caller
 * argument can ever be reinterpreted.
 *
 * Every input is injectable so the whole order is assertable for both win32
 * and POSIX from a single host, with no real bd install anywhere.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   platform?: NodeJS.Platform,
 *   existsFn?: (p: string) => boolean,
 *   readFileFn?: (p: string, enc: string) => string,
 *   homedir?: () => string,
 *   execPath?: string,
 *   resolveWindowsBd?: typeof resolveWindowsBdScript,
 * }} [deps]
 * @returns {BdInvocation}
 */
export function resolveBdInvocation(deps = {}) {
    const env = deps.env ?? process.env;
    const platform = deps.platform ?? process.platform;
    const existsFn = deps.existsFn ?? existsSync;
    const p = platform === 'win32' ? path.win32 : path.posix;
    const binName = bdBinaryName(platform);

    // 1. Explicit operator override. A value that names nothing on disk is a
    //    configuration error: fail loudly rather than silently resolving
    //    something else than what the operator asked for.
    const explicit = env[BD_PATH_ENV_VAR];
    if (explicit) {
        if (!existsFn(explicit)) {
            throw new Error(`${BD_PATH_ENV_VAR} is set to "${explicit}", but no file exists at that path. Point it at the bd executable, or unset it to use the installed binary under the fleet bin directory.`);
        }
        return { source: 'env', command: explicit, prefixArgs: [], shell: false };
    }

    // 2. The binary `apra-fleet install` extracted, addressed by its ABSOLUTE
    //    path -- the installer adds nothing to PATH, so this is the ONLY way a
    //    freshly-installed machine finds bd.
    const installed = p.join(resolveFleetBinDir({ env, platform, homedir: deps.homedir }), binName);
    if (existsFn(installed)) {
        return { source: 'fleet-bin', command: installed, prefixArgs: [], shell: false };
    }

    // 3. A directly-executable `bd` on PATH. The bare basename is returned
    //    (not the matched absolute path) so execFile performs its own normal
    //    PATH lookup -- byte-for-byte the pre-existing POSIX behaviour.
    //    On win32 this deliberately looks for `bd.exe` only: npm's `bd.cmd`
    //    shim is NOT directly executable by CreateProcess and is handled by
    //    step 4 instead.
    const pathDirs = String(env.PATH ?? env.Path ?? '').split(p.delimiter).filter(Boolean);
    for (const dir of pathDirs) {
        if (existsFn(p.join(dir, binName))) {
            return { source: 'path', command: binName, prefixArgs: [], shell: false };
        }
    }

    // 4. A developer's existing npm-installed bd (win32 shim), unchanged.
    const resolveWindowsBd = deps.resolveWindowsBd ?? resolveWindowsBdScript;
    const scriptPath = resolveWindowsBd({ env, platform, existsFn, readFileFn: deps.readFileFn });
    if (scriptPath) {
        return {
            source: 'npm-shim',
            command: deps.execPath ?? process.execPath,
            prefixArgs: [scriptPath],
            shell: false,
        };
    }

    // 5. Nothing resolved. Pre-existing last-resort behaviour, kept so a bd
    //    installed by some means none of the above models still runs rather
    //    than hard-failing. This is the ONLY remaining shell-quoting surface.
    return { source: 'fallback', command: 'bd', prefixArgs: [], shell: platform === 'win32' };
}

/**
 * Runs `bd <args>`, safely and cross-platform, against whichever bd
 * `resolveBdInvocation()` finds (see module doc above for the full rationale
 * and the resolution order). On every source except the last-resort fallback
 * this is a shell-less argv-array spawn on BOTH POSIX and Windows, so a shell
 * metacharacter inside an argument can never be reinterpreted:
 *   - the installed release binary / an operator override / a `bd` on PATH:
 *     `execFileSync(<bd>, args, { shell: false })`.
 *   - a developer's npm `bd.cmd` shim on win32: the real `.../bin/bd.js`
 *     script it wraps, invoked as
 *     `execFileSync(process.execPath, [scriptPath, ...args], { shell: false })`.
 *   - nothing resolved at all: `execFileSync('bd', args)` with the legacy
 *     `{ shell: true }` on win32 only.
 *
 * `shell` is ALWAYS taken from the resolved invocation, never from `options`,
 * so no caller can hand the shell-less path a `{ shell: true }` back.
 *
 * @param {string[]} args - argv passed to `bd` (e.g. ['dolt', 'remote', 'list', '--json'])
 * @param {import('node:child_process').ExecFileSyncOptions} [options] - forwarded as-is (cwd, encoding, stdio, ...); `shell` is ignored.
 * @param {typeof nodeExecFileSync} [execFileSyncImpl] - injectable for tests (same signature as `node:child_process`'s `execFileSync`); defaults to the real one.
 * @param {typeof resolveWindowsBdScript} [resolveWindowsBd] - injectable for tests, so the win32-only npm-shim resolution step is exercisable/deterministic on any host platform.
 * @param {Parameters<typeof resolveBdInvocation>[0] & { resolveBd?: typeof resolveBdInvocation }} [resolveDeps] - injectable env/platform/existsFn (and, for tests, the whole resolver) driving the resolution order.
 * @returns {Buffer|string}
 */
export function execBdSync(args, options = {}, execFileSyncImpl = nodeExecFileSync, resolveWindowsBd = resolveWindowsBdScript, resolveDeps = {}) {
    if (!Array.isArray(args)) {
        throw new TypeError('execBdSync requires args to be an array of strings');
    }
    const resolveBd = resolveDeps.resolveBd ?? resolveBdInvocation;
    const invocation = resolveBd({ ...resolveDeps, resolveWindowsBd });
    const out = execFileSyncImpl(
        invocation.command,
        [...invocation.prefixArgs, ...args],
        { maxBuffer: BD_MAX_BUFFER_BYTES, ...options, shell: invocation.shell },
    );
    warnIfLargeBdOutput(args, out);
    return out;
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
 * Resolution is shared with `execBdSync` via `resolveBdInvocation()`
 * (apra-fleet-i9ag.13.4), so both helpers find the same bd in the same order
 * and neither can drift into looking somewhere the other does not. Every
 * resolved source except the last-resort fallback is a shell-less
 * argv-array spawn on BOTH POSIX and Windows.
 *
 * `{ shell: true }` survives ONLY on that last-resort fallback (nothing
 * resolved and we are on win32), where it is still required: as of the Node
 * CVE-2024-27980 fix, `execFile`/`spawn` refuse to invoke a `.bat`/`.cmd`
 * file directly at all without it, throwing `spawn EINVAL`.
 *
 * `assertSafeArgs()` below is retained UNCONDITIONALLY, not just for that
 * fallback: every arg is validated against an allowlist charset before it can
 * reach any child process, so the metacharacter-injection risk `shell: true`
 * carries (verified empirically: Node does not safely quote array args for
 * `cmd.exe` -- `&`, `;`, `$()`, `()` inside an argument value all reach the
 * shell as separate tokens/commands on Windows even though args are passed
 * as an array) stays closed at the helper level, whichever source resolved,
 * instead of depending on every call site remembering to validate its own
 * caller-controlled values (as `scope-overlap.mjs` already did for `parentId`
 * via `validateIssueId()`). This helper's callers only ever pass structured
 * subcommands/flags/issue-ids, so the allowlist costs them nothing; callers
 * that legitimately pass free text use `execBdSync`, which does not apply it
 * and no longer needs a shell on any resolved source.
 *
 * @param {string[]} args - argv passed to `bd` (e.g. ['list', '--json', '--limit', '0']); every element must match `SAFE_ARG_PATTERN`.
 * @param {import('node:child_process').ExecFileOptions} [options] - forwarded as-is (cwd, encoding, ...); `shell` is ignored (it always comes from the resolved invocation).
 * @param {typeof nodeExecFileAsync} [execFileAsyncImpl] - injectable for tests (same signature as `promisify(require('node:child_process').execFile)`); defaults to the real one.
 * @param {(msg: string) => void} [warn] - injectable warn sink for the large-output line.
 * @param {Parameters<typeof resolveBdInvocation>[0] & { resolveBd?: typeof resolveBdInvocation }} [resolveDeps] - injectable env/platform/existsFn (and, for tests, the whole resolver) driving the resolution order.
 * @returns {Promise<{stdout: string|Buffer, stderr: string|Buffer}>}
 */
export function execBdAsync(args, options = {}, execFileAsyncImpl = nodeExecFileAsync, warn = console.warn, resolveDeps = {}) {
    // Deliberately NOT an `async function`: both argument-shape rejections
    // below must throw SYNCHRONOUSLY (they are programmer errors, and callers
    // /tests rely on it), so the promise chain only starts once the args are
    // known safe. A misconfigured APRA_FLEET_BD_PATH throws synchronously
    // here too, for the same reason: it is a configuration error, not a
    // failed bd run.
    if (!Array.isArray(args)) {
        throw new TypeError('execBdAsync requires args to be an array of strings');
    }
    assertSafeArgs(args);
    const resolveBd = resolveDeps.resolveBd ?? resolveBdInvocation;
    const invocation = resolveBd(resolveDeps);
    // maxBuffer first so an explicit caller-supplied value still wins; without
    // it Node's 1MiB default kills the child on a large `bd list` (see the
    // BD_MAX_BUFFER_BYTES block above).
    return Promise.resolve(execFileAsyncImpl(
        invocation.command,
        [...invocation.prefixArgs, ...args],
        { maxBuffer: BD_MAX_BUFFER_BYTES, ...options, shell: invocation.shell },
    ))
        .then((res) => {
            warnIfLargeBdOutput(args, res ? res.stdout : null, warn);
            return res;
        });
}
