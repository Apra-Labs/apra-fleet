// Cross-platform 'bd' invocation helper (apra-fleet-2cc.1).
//
// VENDORED COPY (apra-fleet-n4lu.1): this file is a verbatim copy of
// scripts/lib/exec-bd.mjs, duplicated here so packages/apra-fleet-se/src/
// supervisor/{backlog.mjs,scope-overlap.mjs} import it from INSIDE the
// packaged/installed tree instead of via a repo-root-relative four-levels-up
// path reaching into the top-level scripts/lib/ dir. That path does not
// resolve in an installed tree (~/.apra-fleet/workflows/fleet-sprint) -- only
// packages/apra-fleet-se/ is shipped (scripts/ is excluded, see
// PACKAGE_TREE_EXCLUDE_DIRS in scripts/gen-sea-config.mjs / src/cli/
// install.ts), so the import used to fail with ERR_MODULE_NOT_FOUND once
// deployed. scripts/lib/exec-bd.mjs remains the canonical source (still used
// by scripts/sandbox-seed-beads.mjs and scripts/check-sandbox-sync-remote.mjs,
// and covered by tests/exec-bd.test.ts) -- keep this copy in sync with it by
// hand if either changes.
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

// ---------------------------------------------------------------------------
// Configured bd invocation (apra-fleet-i9ag.19.7)
// ---------------------------------------------------------------------------
//
// A service started by launchd or a Windows task does not inherit the login
// PATH, so a bare `bd` (the PATH-lookup behaviour below) or a PATH scan for
// `bd.cmd` (resolveWindowsBdScript()) cannot find anything there -- the same
// root cause src/supervisor/node-runner.mjs's sprint-runner resolver exists
// to fix for `node`. This module accepts the equivalent for `bd`: an
// EXPLICIT, one-time configuration call the supervisor's startup makes once
// it has already validated the recorded toolchain (project-config.mjs's
// `toolchain` block) -- never an implicit environment read here.
//
// configureBdInvocation() is deliberately NOT wired to any caller in this
// change (that is the supervisor-startup task, apra-fleet-i9ag.19.10); this
// module only has to accept and act on the configuration once it is set.
// Until something calls configureBdInvocation(), `resolvedBdInvocation()`
// reports `configured: false` and execBdSync()/execBdAsync() behave EXACTLY
// as they did before this change -- the PATH lookup, the win32 shim
// handling, the shell rules, assertSafeArgs, the maxBuffer ceiling and the
// large-output warning are all untouched for the unconfigured case.
//
// D1 fix (bead reopened after judge of PR #561, verified on fleet-mac1 with
// `env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin`): a configured `bdPath` is
// typically npm's `'#!/usr/bin/env node'` bin script, and a bare configured-
// path invocation on POSIX depends on `env` finding `node` on the CHILD
// PROCESS's PATH -- which a launchd/Windows-task PATH does not have either,
// so the configured fix above was not sufficient by itself. Both
// `execBdSync()`'s configured POSIX branch and `execBdAsync()` now also
// prepend `dirname(configured nodePath)` to that child PATH when a
// `nodePath` is configured (`withConfiguredNodeDirOnPath()`, defined just
// above `execBdSync()`) -- see that function's doc comment for the chosen
// strategy and why.

/** @type {{ bdPath: string|null, nodePath: string|null }} */
let configuredInvocation = { bdPath: null, nodePath: null };

/**
 * Normalizes a candidate path value: a non-empty (after trim) string passes
 * through unchanged (untrimmed -- callers pass an already-validated absolute
 * path, this only guards against blank/non-string junk), anything else
 * (undefined, null, '', whitespace-only, non-string) becomes `null` so the
 * rest of this module has one canonical "not configured" value to check.
 * @param {unknown} value
 * @returns {string|null}
 */
function normalizeConfiguredPath(value) {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/**
 * Explicit, one-time configuration of the bd invocation this module should
 * use, called by the supervisor's startup once it has already validated the
 * recorded toolchain -- this function does no validation of its own beyond
 * "is this a usable string", by design (WHAT TO DO in apra-fleet-i9ag.19.7:
 * explicit configuration, not an implicit environment read).
 *
 * Passing an empty object (or omitting the argument) clears any previously
 * configured invocation, reverting execBdSync()/execBdAsync() to the
 * unconfigured PATH-lookup behaviour -- useful for tests that need isolation
 * between cases.
 *
 * @param {{ bdPath?: string|null, nodePath?: string|null }} [config]
 */
export function configureBdInvocation(config = {}) {
    const { bdPath, nodePath } = config ?? {};
    configuredInvocation = {
        bdPath: normalizeConfiguredPath(bdPath),
        nodePath: normalizeConfiguredPath(nodePath),
    };
}

/**
 * Reports the bd invocation currently in effect, so a health surface does
 * not have to guess: `configured: true` once a non-blank `bdPath` has been
 * set via configureBdInvocation(), `false` otherwise (the PATH-lookup
 * default).
 * @returns {{ bdPath: string|null, nodePath: string|null, configured: boolean }}
 */
export function resolvedBdInvocation() {
    return {
        bdPath: configuredInvocation.bdPath,
        nodePath: configuredInvocation.nodePath,
        configured: configuredInvocation.bdPath !== null,
    };
}

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
 * POSIX-only chosen composition strategy for apra-fleet-i9ag.19.7's D1 fix
 * (see the bead's NOTES: PR #561 judge report, verified on fleet-mac1 with
 * `env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin`): a configured `bdPath` is
 * typically an npm-installed `#!/usr/bin/env node` script, and under a
 * service's PATH (launchd, a Windows task) that PATH may contain no `node`
 * at all -- `env` then fails synchronously with `env: node: No such file or
 * directory` (exit 127) before this module's own shell-less/argv-array
 * invocation ever gets a chance to run `bd` itself.
 *
 * CHOSEN STRATEGY (apra-fleet-i9ag.19.7 AC A2 -- "one strategy, named, not
 * both"): prepend `dirname(configured nodePath)` to the PATH used for the bd
 * child process, rather than invoking bd as `<nodePath> <realpath(bdPath)>`.
 * Chosen because it works identically whether the configured `bdPath` is a
 * shebang script (its `env node` lookup now finds the recorded node) OR a
 * real native binary (AC A4: the PATH addition is inert for a binary that
 * never shells out to `env`) -- without this module having to sniff which
 * kind `bdPath` is. The `<nodePath> <script>` alternative would only work
 * for the script case and would actively break a native-binary `bdPath`
 * (you cannot run a native ELF/Mach-O binary as an argument to `node`).
 * Modeled with `path.posix.*` and a literal `:` delimiter (not the bare
 * `path` module, which follows the host's real `process.platform`) so this
 * composition is correct regardless of the host running the code -- same
 * reasoning as `resolveWindowsBdScript()`'s use of `path.win32.*` above.
 *
 * Applies only where callers invoke it for POSIX: win32's configured-shim
 * case already invokes the resolved `bd.js` with the configured `nodePath`
 * directly (no PATH lookup involved at all), and its non-shim fallback goes
 * through `{ shell: true }` cmd.exe semantics this PATH-based fix does not
 * target -- callers below guard the call accordingly.
 *
 * A no-op (returns `baseEnv` unchanged) when no `nodePath` is configured, so
 * the unconfigured case and a configured-without-nodePath case are both
 * untouched (AC A4 / A5): no `env` key is ever added when this returns its
 * input unchanged, since callers only assign the result when `nodePath` is
 * present.
 *
 * @param {NodeJS.ProcessEnv|undefined} baseEnv - the options.env a caller passed, if any; falls back to `process.env`.
 * @param {string|null} nodePath - the configured nodePath, or null/undefined.
 * @returns {NodeJS.ProcessEnv|undefined}
 */
function withConfiguredNodeDirOnPath(baseEnv, nodePath) {
    if (!nodePath) return baseEnv;
    const env = { ...(baseEnv ?? process.env) };
    const nodeDir = path.posix.dirname(nodePath);
    const currentPath = env.PATH ?? env.Path ?? '';
    env.PATH = currentPath ? `${nodeDir}:${currentPath}` : nodeDir;
    return env;
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
        const scriptName = extractNpmShimScriptName(content);
        if (!scriptName) continue;
        return path.win32.join(dir, scriptName);
    }
    return null;
}

/**
 * Shared regex used by both `resolveWindowsBdScript()` (PATH scan for an
 * unconfigured `bd.cmd`) and `resolveConfiguredWindowsBdScript()` (a specific
 * configured `bdPath`) to pull the wrapped `.../bin/bd.js`-shaped relative
 * path out of an npm-generated Windows shim's content. See
 * `resolveWindowsBdScript()`'s doc comment above for why this shape (a
 * double-quoted path ending in `.js` immediately followed by `%*`) is stable
 * across both of the shim's own branches.
 * @param {string} content
 * @returns {string|null} the matched `<...>.js` relative path, or null if `content` does not match npm's shim shape.
 */
function extractNpmShimScriptName(content) {
    const match = content.match(/"%dp0%\\([^"]+\.js)"\s*%\*/);
    return match ? match[1] : null;
}

/**
 * Resolves the `.../bin/bd.js` script a SPECIFIC configured `bdPath` wraps,
 * when that `bdPath` is an npm-generated Windows `.cmd` shim -- the
 * configured-invocation counterpart to `resolveWindowsBdScript()`'s PATH
 * scan (apra-fleet-i9ag.19.7): rather than searching PATH for `bd.cmd`, this
 * checks the ONE file the supervisor was told about. Reuses the same
 * shim-shape match (`extractNpmShimScriptName()`) so a configured `.cmd`
 * resolves identically to an unconfigured one found on PATH. Returns `null`
 * (never throws) when: not on win32, `bdPath` does not exist, it cannot be
 * read, or its content does not match npm's shim shape -- callers treat
 * `null` as "keep today's documented fallback" (see `execBdSync()`'s doc
 * comment for what that fallback is in the configured case).
 * @param {string} bdPath - the configured bd path (expected to be a `.cmd` shim on win32).
 * @param {{
 *   platform?: NodeJS.Platform,
 *   existsFn?: (p: string) => boolean,
 *   readFileFn?: (p: string, enc: string) => string,
 * }} [deps] - injectable for tests, so this is testable on any host platform.
 * @returns {string|null}
 */
export function resolveConfiguredWindowsBdScript(bdPath, deps = {}) {
    const platform = deps.platform ?? process.platform;
    const existsFn = deps.existsFn ?? existsSync;
    const readFileFn = deps.readFileFn ?? readFileSync;
    if (platform !== 'win32') return null;
    if (typeof bdPath !== 'string' || bdPath.length === 0 || !existsFn(bdPath)) return null;
    let content;
    try {
        content = readFileFn(bdPath, 'utf-8');
    } catch {
        return null;
    }
    const scriptName = extractNpmShimScriptName(content);
    if (!scriptName) return null;
    return path.win32.join(path.win32.dirname(bdPath), scriptName);
}

/**
 * Runs `bd <args>`, safely and cross-platform (see module doc above for the
 * full rationale):
 *   - CONFIGURED (a `bdPath` set via `configureBdInvocation()`): on win32,
 *     when that `bdPath` is itself an npm-shim `.cmd`
 *     (`resolveConfiguredWindowsBdScript()`), resolves the real
 *     `.../bin/bd.js` it wraps and invokes it via
 *     `execFileSync(configuredNodePath, [scriptPath, ...args])` -- the
 *     CONFIGURED `nodePath`, never `process.execPath` (under the installed
 *     SEA binary `process.execPath` is the apra-fleet binary, not node, the
 *     same defect class apra-fleet-i9ag.19 exists to fix). Otherwise (non-
 *     win32, or a `.cmd` whose content does not match npm's shim shape):
 *     invokes the configured `bdPath` directly via `execFileSync`, shell-less
 *     on POSIX and `{ shell: true }` on win32 -- the same documented
 *     unconfigured fallback below, just against the configured path instead
 *     of a bare `'bd'`. On that POSIX shell-less path, when a `nodePath` is
 *     ALSO configured, `dirname(nodePath)` is prepended to the child's PATH
 *     (`withConfiguredNodeDirOnPath()`) so a configured `bdPath` that is a
 *     `#!/usr/bin/env node` script still resolves `node` even when the
 *     process's own PATH has none (apra-fleet-i9ag.19.7 amended AC A1/A2,
 *     PR #561 judge defect D1) -- a no-op when no `nodePath` is configured.
 *   - UNCONFIGURED (no `bdPath` configured -- today's behaviour, byte for
 *     byte): win32 resolves the real `.../bin/bd.js` script `bd.cmd` wraps by
 *     scanning PATH (`resolveWindowsBdScript()`) and invokes it directly via
 *     `execFileSync(process.execPath, [scriptPath, ...args])` -- no shell.
 *     Everywhere else, or if that resolution fails: `execFileSync('bd', args)`
 *     directly (POSIX) / with `{ shell: true }` (the pre-fix Windows
 *     fallback, only reached if `bd.cmd` could not be resolved).
 *
 * @param {string[]} args - argv passed to `bd` (e.g. ['dolt', 'remote', 'list', '--json'])
 * @param {import('node:child_process').ExecFileSyncOptions} [options] - forwarded as-is (cwd, encoding, stdio, ...).
 * @param {typeof nodeExecFileSync} [execFileSyncImpl] - injectable for tests (same signature as `node:child_process`'s `execFileSync`); defaults to the real one.
 * @param {typeof resolveWindowsBdScript} [resolveWindowsBd] - injectable for tests, so the win32-only resolution path is exercisable/deterministic on any host platform.
 * @param {typeof resolveConfiguredWindowsBdScript} [resolveConfiguredWindowsBd] - injectable for tests, same reason, for the CONFIGURED win32 shim-resolution path.
 * @returns {Buffer|string}
 */
export function execBdSync(
    args,
    options = {},
    execFileSyncImpl = nodeExecFileSync,
    resolveWindowsBd = resolveWindowsBdScript,
    resolveConfiguredWindowsBd = resolveConfiguredWindowsBdScript,
) {
    if (!Array.isArray(args)) {
        throw new TypeError('execBdSync requires args to be an array of strings');
    }

    if (configuredInvocation.bdPath) {
        const scriptPath = resolveConfiguredWindowsBd(configuredInvocation.bdPath);
        if (scriptPath) {
            const nodeCmd = configuredInvocation.nodePath ?? process.execPath;
            const out = execFileSyncImpl(nodeCmd, [scriptPath, ...args], { maxBuffer: BD_MAX_BUFFER_BYTES, ...options, shell: false });
            warnIfLargeBdOutput(args, out);
            return out;
        }
        // Configured fallback: the configured bdPath is not a win32 npm-shim
        // `.cmd` (or we are not on win32 at all) -- invoke it directly, same
        // shell rule as the unconfigured fallback just below (a real bd
        // binary/symlink execs fine shell-less on POSIX; a non-shim file on
        // win32 still needs `{ shell: true }` to get past CreateProcess's
        // cannot-exec-a-shebang-script limitation).
        const needsShellConfigured = (process.platform === 'win32');
        const execOptionsConfigured = { maxBuffer: BD_MAX_BUFFER_BYTES, ...options, shell: needsShellConfigured };
        // D1 fix (apra-fleet-i9ag.19.7 amended AC A1): on POSIX, when a
        // nodePath is also configured, prepend its directory to the child's
        // PATH -- see withConfiguredNodeDirOnPath()'s doc comment for why.
        // No-op (no `env` key added at all) when nodePath is not configured,
        // so that case stays byte-for-byte what it already was (AC A4).
        if (!needsShellConfigured && configuredInvocation.nodePath) {
            execOptionsConfigured.env = withConfiguredNodeDirOnPath(options.env, configuredInvocation.nodePath);
        }
        const outConfigured = execFileSyncImpl(configuredInvocation.bdPath, args, execOptionsConfigured);
        warnIfLargeBdOutput(args, outConfigured);
        return outConfigured;
    }

    // Unconfigured (unchanged from before this fix).
    const scriptPath = resolveWindowsBd();
    if (scriptPath) {
        const out = execFileSyncImpl(process.execPath, [scriptPath, ...args], { maxBuffer: BD_MAX_BUFFER_BYTES, ...options, shell: false });
        warnIfLargeBdOutput(args, out);
        return out;
    }
    // Fallback: pre-fix behavior. On POSIX this is what already worked (a
    // real `bd` binary/symlink execs fine without a shell); on win32 this
    // path is only reached when `bd.cmd` could not be resolved above, and
    // still needs `{ shell: true }` to get past Windows' cannot-exec-a-
    // shebang-script limitation -- see the module doc's fallback note for
    // why this one remaining path still carries the quoting risk.
    const needsShell = (process.platform === 'win32');
    const out = execFileSyncImpl('bd', args, { maxBuffer: BD_MAX_BUFFER_BYTES, ...options, shell: needsShell });
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
 * Quotes the `file` value `execBdAsync` hands to a `{ shell: true }`
 * invocation, when (and only when) it contains whitespace.
 *
 * Node's `shell: true` does NOT quote `file`/args for you: on POSIX it joins
 * `file` and every arg with a single literal space and passes the result
 * as one string to `/bin/sh -c '<that string>'`; on win32 it does the same
 * for `cmd.exe /d /s /c "<that string>"`. Neither shell knows where one
 * "word" ends and the next begins except by whitespace, so an unquoted
 * `file` containing a space (a configured absolute `bdPath` under, e.g.,
 * `/Users/Jane Doe/...` on macOS or `C:\Users\Jane Doe\...` on Windows -- the
 * common npm-global-install case) is word-split into multiple shell tokens
 * and fails to resolve, even though the exact same path execs fine when
 * passed as an argv-array `file` without a shell (as `execBdSync`'s
 * configured path already does). `args` themselves never need this:
 * `assertSafeArgs()` above already rejects any arg containing whitespace (or
 * any other shell metacharacter) before this function is ever reached, and
 * the unconfigured `'bd'` literal never contains whitespace either, so this
 * function is a no-op for every previously-existing call shape -- it only
 * changes behaviour for a configured `bdPath` that itself contains a space.
 *
 * @param {string} file
 * @param {NodeJS.Platform} platform
 * @returns {string}
 */
function quoteShellFile(file, platform) {
    if (!/\s/.test(file)) return file;
    if (platform === 'win32') {
        // cmd.exe: wrapping in double quotes keeps embedded spaces together
        // as one token. cmd.exe has no standard way to escape a literal '"'
        // inside a quoted token; a configured absolute path is not expected
        // to contain one (same assumption quoteForWindowsShell() in
        // node-runner.mjs makes for the equivalent node-path case).
        return `"${file}"`;
    }
    // POSIX sh: single quotes suppress all interpretation except of a
    // literal single quote itself, which must be closed, escaped (via an
    // adjacent double-quoted single quote), and reopened.
    return `'${file.replace(/'/g, `'\\''`)}'`;
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
 * CONFIGURED (apra-fleet-i9ag.19.7): when a `bdPath` has been set via
 * `configureBdInvocation()`, that path is used as the file argument in place
 * of the bare `'bd'` literal below -- still through `{ shell: true }`
 * (unconditionally, on every platform, exactly as the unconfigured case
 * always has been: this function's own `.cmd`-resolution constraint above
 * applies regardless of `bdPath`'s origin, so there is no shell-less
 * configured path here the way `execBdSync()` has one). A configured `bdPath`
 * containing whitespace (e.g. an npm-global install under a spaced home
 * directory) is quoted via `quoteShellFile()` before being handed to the
 * shell -- see that function's doc comment for why an unquoted spaced `file`
 * breaks under `shell: true`; the unconfigured `'bd'` literal never contains
 * whitespace, so this is a no-op there.
 *
 * D1 fix (amended AC A1/A2, PR #561 judge report): on a non-win32 platform,
 * when a `nodePath` is ALSO configured, `dirname(nodePath)` is prepended to
 * the child's PATH (`withConfiguredNodeDirOnPath()`, the same strategy
 * `execBdSync()`'s configured POSIX path uses) before the shell is invoked --
 * `{ shell: true }` still just joins `file` + args into one command line and
 * hands it to `/bin/sh -c`, so a configured `bdPath` that is a
 * `#!/usr/bin/env node` script still needs `node` resolvable on ITS PATH to
 * run at all, and a service's inherited PATH may contain none. A no-op (no
 * `env` key added) when no `nodePath` is configured, or on win32 (there the
 * shell exec's a `.cmd` file, not a POSIX shebang script, so this fix does
 * not apply).
 *
 * @param {string[]} args - argv passed to `bd` (e.g. ['list', '--json', '--limit', '0']); every element must match `SAFE_ARG_PATTERN`.
 * @param {import('node:child_process').ExecFileOptions} [options] - forwarded as-is (cwd, encoding, ...); `shell` is always forced to `true` regardless of what is passed here.
 * @param {typeof nodeExecFileAsync} [execFileAsyncImpl] - injectable for tests (same signature as `promisify(require('node:child_process').execFile)`); defaults to the real one.
 * @param {(msg: string) => void} [warn] - injectable warn sink for the large-output line.
 * @param {NodeJS.Platform} [platform] - injectable for tests, so the win32-vs-POSIX shell-quoting branch is exercisable on any host.
 * @returns {Promise<{stdout: string|Buffer, stderr: string|Buffer}>}
 */
export function execBdAsync(args, options = {}, execFileAsyncImpl = nodeExecFileAsync, warn = console.warn, platform = process.platform) {
    // Deliberately NOT an `async function`: both argument-shape rejections
    // below must throw SYNCHRONOUSLY (they are programmer errors, and callers
    // /tests rely on it), so the promise chain only starts once the args are
    // known safe.
    if (!Array.isArray(args)) {
        throw new TypeError('execBdAsync requires args to be an array of strings');
    }
    assertSafeArgs(args);
    // CONFIGURED: use the configured bdPath in place of the bare 'bd' PATH
    // lookup; UNCONFIGURED (bdPath is null): unchanged from before this fix.
    const bdFile = configuredInvocation.bdPath ?? 'bd';
    const shellFile = quoteShellFile(bdFile, platform);
    // maxBuffer first so an explicit caller-supplied value still wins; without
    // it Node's 1MiB default kills the child on a large `bd list` (see the
    // BD_MAX_BUFFER_BYTES block above).
    const asyncOptions = { maxBuffer: BD_MAX_BUFFER_BYTES, ...options, shell: true };
    // D1 fix (apra-fleet-i9ag.19.7 amended AC A1): same POSIX PATH-prepend
    // strategy as execBdSync's configured branch (see
    // withConfiguredNodeDirOnPath()'s doc comment) -- a configured bdPath
    // invoked via `{ shell: true }` still resolves a `#!/usr/bin/env node`
    // shebang through the child's PATH, so it fails the same way without
    // this. Guarded on `configuredInvocation.bdPath` (only meaningful when
    // configured) and `platform !== 'win32'` (win32 goes through cmd.exe
    // semantics this fix does not target); a no-op (no `env` key added)
    // otherwise, so the unconfigured and no-nodePath-configured cases stay
    // byte-for-byte unchanged (AC A4 / A5).
    if (configuredInvocation.bdPath && platform !== 'win32' && configuredInvocation.nodePath) {
        asyncOptions.env = withConfiguredNodeDirOnPath(options.env, configuredInvocation.nodePath);
    }
    return Promise.resolve(execFileAsyncImpl(shellFile, args, asyncOptions))
        .then((res) => {
            warnIfLargeBdOutput(args, res ? res.stdout : null, warn);
            return res;
        });
}
