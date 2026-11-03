// bd-sync-command.mjs -- the member-bound command string for a `bd dolt pull`
// / `bd dolt push`, built per member OS/shell.
//
// WHY: on a Windows member, bd's embedded Dolt starts one git.exe per remote
// chunk concurrently (bounded only by GOMAXPROCS), and Windows refuses the
// burst with CreateProcess ERROR_NOT_ENOUGH_MEMORY (upstream:
// https://github.com/gastownhall/beads/issues/7082). Running bd with
// GOMAXPROCS=1 serializes those spawns -- 1 is the value evidenced on the
// failing members (precedent: scripts/rekey-beads-memories.mjs defaults
// GOMAXPROCS to 1).
//
// The value is FIXED, never read from the member's environment: honoring an
// operator-set value would need shell variable expansion in a member-bound
// command, which is forbidden (the member's shell may be PowerShell or bash
// and the string is built here, in JS). The assignment is scoped to the one
// command string: execute_command starts a fresh shell process per call, and
// on bash the `NAME=value cmd` form scopes it to that single process.
//
// POSIX (linux/macOS) members are left byte-identical: they have no
// per-process spawn limit of this kind.
//
// Kept in its own module (not dolt-sync.mjs) because dolt-settle.mjs issues
// its own post-resolve `bd dolt pull`/`bd dolt push` and is imported BY
// dolt-sync.mjs -- importing dolt-sync.mjs back would be circular.
//
// ASCII only.

/** GOMAXPROCS for a bd sync process on a Windows member. */
export const WINDOWS_BD_GOMAXPROCS = '1';

/** The POSIX target an unresolved member degrades to (pre-existing behavior). */
export const POSIX_MEMBER_TARGET = Object.freeze({ os: 'linux', shell: '' });

/**
 * Normalize a member target to { os, shell }. Accepts the member_detail shape
 * ({ os, shell }) or a bare OS / Node platform string ('win32' is folded into
 * 'windows' so dolt-settle's platform strings work unchanged).
 *
 * @param {{ os?: string, shell?: string }|string|null|undefined} target
 * @returns {{ os: string, shell: string }}
 */
export function normalizeMemberTarget(target) {
    const raw = typeof target === 'string' ? { os: target, shell: '' } : (target || {});
    let os = String(raw.os || '').trim().toLowerCase();
    if (os === 'win32') os = 'windows';
    const shell = String(raw.shell || '').trim().toLowerCase();
    return { os, shell };
}

/**
 * The command string to issue for a bd sync command on a member.
 *
 *   linux / macOS / unresolved         -> `cmd`, unchanged
 *   windows + gitbash                  -> `GOMAXPROCS=1 cmd`
 *   windows + PowerShell (any other)   -> `$env:GOMAXPROCS='1'; cmd`
 *
 * The PowerShell form is an ASSIGNMENT statement, not an expansion: nothing is
 * read from the member's environment.
 *
 * @param {string} cmd - the logical command, e.g. 'bd dolt pull'
 * @param {{ os?: string, shell?: string }|string|null|undefined} target
 * @returns {string}
 */
export function bdSyncCommandFor(cmd, target) {
    const { os, shell } = normalizeMemberTarget(target);
    if (os !== 'windows') return cmd;
    if (shell === 'gitbash') return `GOMAXPROCS=${WINDOWS_BD_GOMAXPROCS} ${cmd}`;
    return `$env:GOMAXPROCS='${WINDOWS_BD_GOMAXPROCS}'; ${cmd}`;
}
