// Cross-platform 'bd' invocation helper (apra-fleet-2cc.1).
//
// Root cause (run-24-adjacent Windows breakage): on Windows the globally
// installed `bd` (npm's @beads/bd) resolves to npm's extensionless POSIX
// shim on PATH -- Windows' CreateProcess cannot exec a shebang script
// directly, so `execFileSync('bd', [...])` (no `{ shell: true }`) throws
// `spawnSync bd ENOENT` even though the exact same invocation works fine
// interactively (the interactive shell resolves the PATHEXT-eligible
// `bd.cmd`/`bd.ps1` shim itself). Routing every `bd` invocation through the
// platform shell (`shell: true`) is the same fix already applied to
// `packages/apra-fleet-se/src/supervisor/backlog.mjs` and
// `scope-overlap.mjs`'s `execFileAsync('bd', ..., { shell: true })` calls --
// this module is the single shared helper so `scripts/sandbox-seed-beads.mjs`
// and `scripts/check-sandbox-sync-remote.mjs` do not each hand-roll their own
// copy of the same platform quirk.
//
// Safety: every caller passes `args` as an array, never a pre-built shell
// string -- this helper never concatenates caller-supplied values into a
// shell command line itself. However, Node does NOT safely quote array args
// for `cmd.exe` when `shell: true` is set (verified empirically -- `&`, `;`,
// `$()`, and `()` inside an argument value all reach the shell as separate
// tokens/commands on Windows even though args are passed as an array), so
// `execBdAsync` below (apra-fleet-xuo.2) additionally validates every arg
// against an allowlist charset before the shell ever sees it.

// See also: `execBdAsync` (apra-fleet-xuo.2), the async counterpart to
// `execBdSync` used by `packages/apra-fleet-se/src/supervisor/backlog.mjs`
// and `scope-overlap.mjs`, which previously each hand-rolled their own
// `execFileAsync('bd', ..., { shell: true })` call.

import { execFileSync as nodeExecFileSync, execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const nodeExecFileAsync = promisify(nodeExecFile);

/**
 * Runs `bd <args>` via `execFileSync`, always with `{ shell: true }` so the
 * invocation resolves correctly on Windows (see module doc above) and is
 * unchanged in behavior on Linux/macOS (a real `bd` binary/symlink there
 * already execs fine either way).
 *
 * @param {string[]} args - argv passed to `bd` (e.g. ['dolt', 'remote', 'list', '--json'])
 * @param {import('node:child_process').ExecFileSyncOptions} [options] - forwarded as-is (cwd, encoding, stdio, ...); `shell` is always forced to `true` regardless of what is passed here.
 * @param {typeof nodeExecFileSync} [execFileSyncImpl] - injectable for tests (same signature as `node:child_process`'s `execFileSync`); defaults to the real one.
 * @returns {Buffer|string}
 */
export function execBdSync(args, options = {}, execFileSyncImpl = nodeExecFileSync) {
    if (!Array.isArray(args)) {
        throw new TypeError('execBdSync requires args to be an array of strings');
    }
    return execFileSyncImpl('bd', args, { ...options, shell: true });
}

// Argv values 'bd' invocations legitimately need: bd subcommands/flags
// (letters, digits, '-', '--'), issue ids (letters/digits/'.'/'_'/'-', same
// charset runner.js's ISSUE_ID_PATTERN / validateIssueId() already enforce at
// the launch API boundary), and small numeric/flag values. Nothing 'bd' ever
// legitimately needs contains a shell metacharacter, so this allowlist is not
// a functional restriction -- it is a hard backstop against exactly the
// injection class this helper exists to close off.
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
