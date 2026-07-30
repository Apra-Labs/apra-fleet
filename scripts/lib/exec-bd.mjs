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
// shell command line itself. Node's own child_process argument handling is
// what reaches the shell for both `shell: true` code paths (POSIX `/bin/sh
// -c` and Windows `cmd.exe`).

import { execFileSync as nodeExecFileSync } from 'node:child_process';

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
