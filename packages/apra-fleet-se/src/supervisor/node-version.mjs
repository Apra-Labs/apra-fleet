// =============================================================================
// Shared node/bd version-probe helpers (apra-fleet-i9ag.19.15)
// =============================================================================
//
// Single home for `parseVersionString`, `compareVersions`,
// `quoteForWindowsShell` and `probeVersion` -- previously two hand-copied,
// drift-risk sets of the same four helpers: one in node-runner.mjs
// (apra-fleet-i9ag.15.1), one in toolchain.mjs (apra-fleet-i9ag.19.9, whose
// own file-level doc comment used to document -- and justify -- that
// duplication; see git history for the original rationale). Both call sites
// now import every one of these four from here; neither keeps a local copy.
//
// `MIN_NODE_VERSION` stays declared exactly once, in node-runner.mjs (itself
// a hand-kept mirror of src/cli/fleet-se-prereqs.ts's own constant, which
// this package cannot import -- see node-runner.mjs's own doc comment). This
// module never redeclares or re-imports it: a caller that needs to gate on a
// minimum version (both node-runner.mjs and toolchain.mjs do) passes both
// values straight to `compareVersions()` itself.
//
// PROBEVERSION'S DUAL CONTRACT -- read this before touching probeVersion():
// this is the one helper whose two existing callers do not just share code,
// they have genuinely different timing requirements, and this module
// preserves BOTH exactly rather than picking one:
//   - node-runner.mjs's `resolveSprintRunnerCommand()` is fully SYNCHRONOUS --
//     it spawns via `execFileSync`, and its own test suite calls it
//     un-awaited, asserting synchronous return values and synchronous throws
//     (`assert.throws(() => resolveSprintRunnerCommand(...))`). It always
//     probed once, with no retry, and only ever consumed the parsed version
//     (or `null` on any failure, whatever the cause).
//   - toolchain.mjs's `validateRecordedToolchain()` is ASYNC -- it spawns via
//     `execFileAsync` so node's and bd's probes can run CONCURRENTLY
//     (`Promise.all`, apra-fleet-i9ag.19.20) and retries a probe exactly
//     once, bounded, when it could not COMPLETE (a timeout kill or a
//     transient OS spawn errno, apra-fleet-i9ag.19.18) -- distinguishing that
//     from a probe that ran and genuinely found nothing.
// `probeVersion()` below is deliberately NOT declared `async`: an `async`
// function ALWAYS returns a Promise, which would silently turn
// `resolveSprintRunnerCommand()` into something that returns a Promise
// instead of a plain value/throw -- exactly the regression this dedupe must
// not introduce. Instead it inspects what `exec(...)` itself produces: a
// synchronous `exec` (node-runner.mjs's `execFileSync`-based default) drives
// it through entirely synchronously, with no Promise anywhere in the call
// chain; an `exec` that returns a thenable (toolchain.mjs's
// `execFileAsync`-based default) drives it through a real Promise chain, so
// the mock.timers-driven concurrency/retry-timing tests in
// test/i9ag19-9-toolchain.test.mjs keep observing the exact same sequence of
// `exec()` calls and settle at the exact same wall-clock point as before.
//
// `retry` (in the `options` bag, default `false`) is the only behavioral
// switch a caller opts into:
//   - unset/false (node-runner.mjs's contract): a single attempt; ANY
//     failure (thrown or rejected, whatever it is) collapses to
//     `{ version: null, incomplete: null }`, matching node-runner.mjs's
//     original catch-returns-null semantics exactly -- it only ever read the
//     parsed version, never inspected why a probe failed.
//   - `true` (toolchain.mjs's contract): up to one bounded retry on a
//     timeout (`err.killed === true`) or a transient spawn errno (one of
//     EAGAIN/ENOMEM/EMFILE/ENFILE) -- mirrors toolchain.mjs's original `for`
//     loop's exact retry/give-up decisions and `incomplete` wording contract
//     byte for byte.
//
// This is a pure dedupe, not a redesign: every existing pre-this-task test
// for both `resolveSprintRunnerCommand()` and `validateRecordedToolchain()`
// passes unmodified against this module.
//
// Everything here is a pure function of its arguments -- no filesystem, no
// real `child_process` import -- matching both original copies' contract.
// NOTHING in this file imports from outside packages/apra-fleet-se, matching
// node-runner.mjs's and toolchain.mjs's own standalone-package contract.
// =============================================================================

/**
 * Parses a version string (with or without a leading 'v', tolerant of
 * trailing whitespace/build metadata) into a normalized "major.minor.patch"
 * string. Returns null when no version-like substring is found -- mirrors
 * src/cli/fleet-se-prereqs.ts's parseVersionString().
 * @param {string|Buffer|null|undefined} raw
 * @returns {string|null}
 */
export function parseVersionString(raw) {
    if (raw === null || raw === undefined) return null;
    const match = String(raw).match(/(\d+)\.(\d+)\.(\d+)/);
    if (!match) return null;
    return `${match[1]}.${match[2]}.${match[3]}`;
}

/**
 * Numeric major.minor.patch comparison -- NEVER a string compare (a string
 * compare would treat '22.9.0' as GREATER than '22.16.0', a defect the
 * callers' own acceptance criteria call out explicitly). Mirrors
 * src/cli/fleet-se-prereqs.ts's compareVersions().
 * @param {string} a
 * @param {string} b
 * @returns {number} negative if a < b, positive if a > b, 0 if equal
 */
export function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i += 1) {
        const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (diff !== 0) return diff < 0 ? -1 : 1;
    }
    return 0;
}

/**
 * Quotes a single win32 shell command-line token when it needs it (contains
 * whitespace), so `cmd.exe /d /s /c "<file> <args...>"` -- the literal string
 * Node's child_process builds internally when `shell: true` on Windows --
 * does not get re-split on the space inside a candidate path (e.g. the
 * default `C:\Program Files\nodejs\node.exe`). No-op for a token with no
 * whitespace, and only ever called on the win32 shell path -- POSIX
 * shells/argv arrays never see this. Escapes embedded double quotes by
 * doubling them, cmd.exe's own quoting convention. See node-runner.mjs's git
 * history (apra-fleet-i9ag.15.4) for the full empirical rationale.
 * @param {string} token
 * @returns {string}
 */
export function quoteForWindowsShell(token) {
    if (!/\s/.test(token)) return token;
    return `"${token.replace(/"/g, '""')}"`;
}

/**
 * Transient spawn errno codes worth one bounded retry before concluding a
 * probe genuinely failed -- these mean the OS could not even START the
 * child process (resource exhaustion under load), never that the target
 * binary itself is broken. `ENOENT` (the binary genuinely does not exist) is
 * deliberately NOT included: a missing binary is a genuine finding on the
 * very first attempt, and a retry could never change that. Only consulted
 * when a caller opts into `{ retry: true }`.
 */
const TRANSIENT_SPAWN_ERRNOS = new Set(['EAGAIN', 'ENOMEM', 'EMFILE', 'ENFILE']);

/**
 * Classifies a probe failure as one that could not COMPLETE -- the child was
 * killed BY A TIMEOUT (`err.killed: true`) or the OS itself transiently
 * failed to spawn it (`err.code` one of `TRANSIENT_SPAWN_ERRNOS`) -- versus
 * one that completed and genuinely found nothing (a missing binary/`ENOENT`,
 * a permission error, output with no parseable version) OR one that CRASHED
 * on its own (a child killed by a signal it did NOT receive from a timeout --
 * e.g. SIGSEGV, or SIGKILL from the OOM killer -- still sets `err.signal`,
 * but Node leaves `err.killed` `false` because Node did not initiate that
 * kill). Only used when a caller opts into `{ retry: true }`.
 * @param {unknown} err
 * @returns {string|null} `'timeout'`, a transient errno code, or `null` for
 *   a genuine (non-retryable) failure -- including a crash.
 */
function classifyIncompleteProbe(err) {
    if (!err || typeof err !== 'object') return null;
    if (err.killed === true) return 'timeout';
    if (typeof err.code === 'string' && TRANSIENT_SPAWN_ERRNOS.has(err.code)) return err.code;
    return null;
}

/**
 * Probes `file --version` (well, `file`, `args`), returning the parsed
 * version, or a reason the probe never produced one. `shell: true` on win32
 * only, with `file` quoted first (via `quoteForWindowsShell()`) when it
 * contains whitespace -- mirrors src/cli/fleet-se-prereqs.ts's PROBE_OPTIONS
 * doc comment: both `node` and an explicit override routinely resolve to a
 * `.cmd`/shim on Windows, and Node refuses to spawn one without a shell.
 * Argv is always a fixed-literal array (never a caller-interpolated command
 * string), so routing through a shell here introduces no expansion
 * (CLAUDE.md). This is probe-internal only: the unquoted original path is
 * still what each caller's own public resolver returns to ITS caller.
 *
 * See this module's file-level doc comment for the full sync-vs-async and
 * retry-vs-no-retry contract this function serves for its two callers.
 *
 * @param {(file: string, args: string[], options?: object) => string|Buffer|Promise<string|Buffer>} exec
 * @param {NodeJS.Platform} platform
 * @param {string} file
 * @param {string[]} args
 * @param {{ timeoutMs?: number, retry?: boolean }} [options]
 * @returns {{ version: string|null, incomplete: string|null }
 *   | Promise<{ version: string|null, incomplete: string|null }>}
 *   A plain object when `exec` resolves synchronously (node-runner.mjs's
 *   contract); a genuine Promise of the same shape when `exec` returns a
 *   thenable (toolchain.mjs's contract).
 */
export function probeVersion(exec, platform, file, args, options = {}) {
    const { timeoutMs, retry = false } = options;
    const isWin32Shell = platform === 'win32';
    const probeTarget = isWin32Shell ? quoteForWindowsShell(file) : file;
    const execOptions = { shell: isWin32Shell, timeout: timeoutMs };
    // MAX_ATTEMPTS = 2 when retrying: the original attempt plus exactly one
    // bounded retry -- never a bare retry-until-pass loop. 1 when not
    // retrying at all (node-runner.mjs's contract: a single attempt).
    const maxAttempts = retry ? 2 : 1;

    function onSuccess(raw) {
        return { version: parseVersionString(raw), incomplete: null };
    }

    function onFailure(err, attempt) {
        if (!retry) {
            // node-runner.mjs's original contract: any failure at all, on
            // its one and only attempt, collapses to a plain "not usable" --
            // it never inspected WHY a probe failed.
            return { version: null, incomplete: null };
        }
        const classification = classifyIncompleteProbe(err);
        if (classification && attempt < maxAttempts) {
            // runAttempt and onFailure are mutually recursive by design (a
            // genuine sequential retry, never a batch worth parallelizing);
            // runAttempt is a hoisted function declaration, so this call is
            // safe regardless of declaration order below.
            return runAttempt(attempt + 1);
        }
        return { version: null, incomplete: classification };
    }

    function runAttempt(attempt) {
        let result;
        try {
            result = exec(probeTarget, args, execOptions);
        } catch (err) {
            return onFailure(err, attempt);
        }
        if (result && typeof result.then === 'function') {
            return result.then(onSuccess, (err) => onFailure(err, attempt));
        }
        return onSuccess(result);
    }

    return runAttempt(1);
}
