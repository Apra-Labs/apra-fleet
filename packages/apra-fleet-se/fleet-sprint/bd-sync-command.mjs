// bd-sync-command.mjs -- the member-bound command string for a `bd dolt pull`
// / `bd dolt push`, built per member OS/shell.
//
// TWO environment concerns, both set as plain ASSIGNMENTS built here in JS
// (never via shell variable expansion -- the member's shell may be PowerShell
// or bash), scoped to the one command string: execute_command starts a fresh
// shell process per call, and on bash the `NAME=value cmd` form scopes the
// assignment to that single process.
//
// 1. NON-INTERACTIVE CREDENTIALS (every resolved member, every OS): bd's
//    embedded Dolt shells out to git for the remote, and a git credential
//    helper that can prompt (a terminal prompt, or a credential manager
//    dialog) would otherwise wait for an answer nobody gives -- the sync then
//    hangs until its step timeout and the failure surfaces as a timeout
//    instead of a credential problem. GIT_TERMINAL_PROMPT=0 makes git refuse
//    a terminal prompt and GCM_INTERACTIVE=never makes a Git Credential
//    Manager refuse to open a dialog, so a missing credential fails FAST with
//    git's own credential text, which classifyFailure files as 'auth'. The
//    same pair the ls-remote tip probe already carries (se-posix.mjs /
//    se-windows.mjs).
//
// 2. GOMAXPROCS (Windows members only): bd's embedded Dolt starts one git.exe
//    per remote chunk concurrently (bounded only by GOMAXPROCS), and Windows
//    refuses the burst with CreateProcess ERROR_NOT_ENOUGH_MEMORY (upstream:
//    https://github.com/gastownhall/beads/issues/7082). Running bd with
//    GOMAXPROCS=1 serializes those spawns -- 1 is the value evidenced on the
//    failing members (precedent: scripts/rekey-beads-memories.mjs defaults
//    GOMAXPROCS to 1). The value is FIXED, never read from the member's
//    environment: honoring an operator-set value would need shell expansion.
//
// POSIX (linux/macOS) output is therefore NOT the bare command any more: it
// carries the two credential assignments as a `NAME=value` prefix. A target
// whose OS is unknown (empty) still gets the bare command, because the bare
// command is the only form every shell runs. Classifiers that decide "is this
// a bd command / a D-pull" must look at logicalBdCommand(), never at the raw
// wire string.
//
// Kept in its own module (not dolt-sync.mjs) because dolt-settle.mjs issues
// its own post-resolve `bd dolt pull`/`bd dolt push` and is imported BY
// dolt-sync.mjs -- importing dolt-sync.mjs back would be circular.
//
// ASCII only.

/** GOMAXPROCS for a bd sync process on a Windows member. */
export const WINDOWS_BD_GOMAXPROCS = '1';

/**
 * The non-interactive git credential environment every bd sync command
 * carries, in emission order. Fixed values: nothing is read from the member.
 */
export const NON_INTERACTIVE_GIT_ENV = Object.freeze([
    Object.freeze(['GIT_TERMINAL_PROMPT', '0']),
    Object.freeze(['GCM_INTERACTIVE', 'never']),
]);

/** The POSIX target (a resolved linux member with no recorded shell). */
export const POSIX_MEMBER_TARGET = Object.freeze({ os: 'linux', shell: '' });

/**
 * The target of a member whose OS could not be resolved at all. Its bd sync
 * commands stay bare: a bare command is the only form every shell runs.
 */
export const UNRESOLVED_MEMBER_TARGET = Object.freeze({ os: '', shell: '' });

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
 *   linux / macOS          -> `GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never cmd`
 *   windows + gitbash      -> `GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never GOMAXPROCS=1 cmd`
 *   windows + PowerShell   -> `$env:GIT_TERMINAL_PROMPT='0'; $env:GCM_INTERACTIVE='never'; $env:GOMAXPROCS='1'; cmd`
 *     (any other shell)
 *   unresolved (empty OS)  -> `cmd`, unchanged
 *
 * The PowerShell form is ASSIGNMENT statements with single-quoted values, not
 * an expansion: nothing is read from the member's environment.
 *
 * @param {string} cmd - the logical command, e.g. 'bd dolt pull'
 * @param {{ os?: string, shell?: string }|string|null|undefined} target
 * @returns {string}
 */
export function bdSyncCommandFor(cmd, target) {
    const { os, shell } = normalizeMemberTarget(target);
    if (!os) return cmd;
    const env = NON_INTERACTIVE_GIT_ENV.slice();
    if (os === 'windows') env.push(['GOMAXPROCS', WINDOWS_BD_GOMAXPROCS]);
    if (os === 'windows' && shell !== 'gitbash') {
        return `${env.map(([name, value]) => `$env:${name}='${value}'; `).join('')}${cmd}`;
    }
    return `${env.map(([name, value]) => `${name}=${value} `).join('')}${cmd}`;
}

// One leading env-assignment prefix, in either form bdSyncCommandFor emits:
//   POSIX/gitbash:  NAME=value<space>          (value unquoted or quoted)
//   PowerShell:     $env:NAME='value';<space>  (or "value", or bare value)
// Anchored at the start; applied repeatedly so stacked assignments strip too.
const POSIX_ENV_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|[^\s;'"]*)\s+/;
const PWSH_ENV_PREFIX_RE = /^\$env:[A-Za-z_][A-Za-z0-9_]*\s*=\s*(?:'[^']*'|"[^"]*"|[^\s;'"]*)\s*;\s*/i;

/**
 * The LOGICAL command behind a member-bound wire string: strips the leading
 * environment-assignment prefix(es) bdSyncCommandFor adds (e.g.
 * `GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never bd dolt pull` and
 * `$env:GIT_TERMINAL_PROMPT='0'; $env:GCM_INTERACTIVE='never'; $env:GOMAXPROCS='1'; bd dolt pull`
 * both become `bd dolt pull`). Anything else is returned trimmed but otherwise
 * unchanged. Classifiers that decide "is this a bd command, and does it
 * mutate beads" must look at this, never at the raw wire string -- a prefixed
 * D-pull is still a D-pull.
 *
 * @param {string} cmdStr
 * @returns {string} the trimmed logical command ('' for a non-string)
 */
export function logicalBdCommand(cmdStr) {
    if (typeof cmdStr !== 'string') return '';
    let rest = cmdStr.trim();
    // Bounded: each pass strictly shortens `rest`.
    for (;;) {
        const m = POSIX_ENV_PREFIX_RE.exec(rest) || PWSH_ENV_PREFIX_RE.exec(rest);
        if (!m) return rest;
        rest = rest.slice(m[0].length).trimStart();
    }
}
