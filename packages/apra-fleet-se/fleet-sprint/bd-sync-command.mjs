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

/**
 * Stalled-transfer abort for the git HTTP(S) transport bd's Dolt shells out
 * to: git aborts a transfer that moves fewer than LIMIT bytes/s for TIME
 * seconds ("Operation too slow", classified transient). A slow transfer that
 * keeps moving is untouched, so the heartbeat wrapper (withSyncHeartbeat)
 * only ever keeps a PROGRESSING transfer alive. SSH remotes are not covered
 * by these variables (a stalled ssh transfer still runs to the total limit).
 */
export const GIT_STALL_ABORT_ENV = Object.freeze([
    Object.freeze(['GIT_HTTP_LOW_SPEED_LIMIT', '1000']),
    Object.freeze(['GIT_HTTP_LOW_SPEED_TIME', '300']),
]);

/** The env every bd sync command carries on `os`, in emission order
 *  (GOMAXPROCS last on Windows). */
function bdSyncEnvFor(os) {
    const env = [...NON_INTERACTIVE_GIT_ENV, ...GIT_STALL_ABORT_ENV];
    if (os === 'windows') env.push(['GOMAXPROCS', WINDOWS_BD_GOMAXPROCS]);
    return env;
}

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
 *   linux / macOS          -> `GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never <stall env> cmd`
 *   windows + gitbash      -> `GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never <stall env> GOMAXPROCS=1 cmd`
 *   windows + PowerShell   -> `$env:GIT_TERMINAL_PROMPT='0'; $env:GCM_INTERACTIVE='never'; <stall env>; $env:GOMAXPROCS='1'; cmd`
 *     (any other shell)
 *   (<stall env> = GIT_STALL_ABORT_ENV in the same form)
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
    const env = bdSyncEnvFor(os);
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
    let rest = unwrapSyncHeartbeat(cmdStr.trim());
    // Bounded: each pass strictly shortens `rest`.
    for (;;) {
        const m = POSIX_ENV_PREFIX_RE.exec(rest) || PWSH_ENV_PREFIX_RE.exec(rest);
        if (!m) return rest;
        rest = rest.slice(m[0].length).trimStart();
    }
}

// ---------------------------------------------------------------------------
// Heartbeat wrapper for a long, silent bd sync
// ---------------------------------------------------------------------------
//
// execute_command's timeout_s is an OUTPUT-SILENCE timeout, and `bd dolt push`
// prints nothing while it uploads. A push that has to send a large table-file
// archive to a git-transport remote can legitimately run longer than that
// silence limit, so it used to be killed mid-upload and retried from zero.
//
// withSyncHeartbeat() wraps the member-bound bd sync command so a heartbeat
// line is printed every `intervalS` seconds while bd runs, for at most `capS`
// seconds. Past the cap the heartbeat stops and the server's existing
// silence timeout ends the command as before; the orchestrator then reports
// it as the typed total-time-limit error (dolt-sync.mjs). bd's own stdout,
// stderr and exit code pass through (classification reads them). Heartbeat
// lines start with SYNC_HEARTBEAT_PREFIX and are stripped before anything is
// classified or returned (stripSyncHeartbeat).
//
//   linux / macOS / Windows Git Bash -> POSIX sh: bd in the background, a
//     heartbeat subshell beside it, `wait` for bd's exit code. Script-local
//     shell variables only; nothing is read from the member's environment.
//   Windows PowerShell -> Start-Process with stdout/stderr redirected to temp
//     files, polled with WaitForExit(intervalS); the captured output is
//     written out after bd exits, then `exit` with bd's exit code.
//   unresolved OS -> null (no wrapper can be built; the caller issues the
//     bare command under the plain silence timeout).

/** Every heartbeat line starts with this. Free of wording the dolt failure
 *  tables match (timeout, remote, auth, rejected). */
export const SYNC_HEARTBEAT_PREFIX = '[beads-sync heartbeat]';

const SAFE_TOKEN_RE = /^[A-Za-z0-9._-]+$/;

function wholeSeconds(n) {
    return String(Math.max(1, Math.floor(Number(n) || 1)));
}

/**
 * Wrap a bd sync command with the heartbeat (see the notes above).
 *
 * @param {string} cmd - the logical command, e.g. 'bd dolt push'
 * @param {{ os?: string, shell?: string }|string|null|undefined} target
 * @param {{ intervalS: number, capS: number }} opts
 * @returns {string|null} the wrapped member-bound string, or null when no
 *   wrapper can be built (unresolved OS, or an unexpected command shape)
 */
export function withSyncHeartbeat(cmd, target, { intervalS, capS }) {
    const { os, shell } = normalizeMemberTarget(target);
    if (!os) return null;
    const tokens = String(cmd || '').trim().split(/\s+/);
    if (!tokens[0] || !tokens.every((t) => SAFE_TOKEN_RE.test(t))) return null;
    const interval = wholeSeconds(intervalS);
    const cap = wholeSeconds(capS);
    if (os === 'windows' && shell !== 'gitbash') {
        const env = bdSyncEnvFor(os);
        const [exe, ...args] = tokens;
        const argList = args.length > 0 ? ` -ArgumentList @(${args.map((a) => `'${a}'`).join(',')})` : '';
        return [
            // Same prefix form as bdSyncCommandFor (unwrapSyncHeartbeat relies on it).
            env.map(([name, value]) => `$env:${name}='${value}'; `).join('') + `$bdSyncExe = (Get-Command '${exe}' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source;`,
            `if (-not $bdSyncExe) { [Console]::Error.WriteLine("${exe} : The term '${exe}' is not recognized as the name of a cmdlet, function, script file, or operable program."); exit 1 };`,
            `$bdSyncOut = [IO.Path]::GetTempFileName(); $bdSyncErr = [IO.Path]::GetTempFileName();`,
            `$bdSyncProc = Start-Process -FilePath $bdSyncExe${argList} -WorkingDirectory (Get-Location).ProviderPath -NoNewWindow -PassThru -RedirectStandardOutput $bdSyncOut -RedirectStandardError $bdSyncErr;`,
            // Reading Handle keeps ExitCode available after the process exits.
            `$null = $bdSyncProc.Handle; $bdSyncS = 0;`,
            `while (-not $bdSyncProc.WaitForExit(${interval}000)) { $bdSyncS += ${interval}; if ($bdSyncS -le ${cap}) { [Console]::Out.WriteLine('${SYNC_HEARTBEAT_PREFIX} ' + $bdSyncS + 's'); [Console]::Out.Flush() } };`,
            `[Console]::Out.Write([IO.File]::ReadAllText($bdSyncOut)); [Console]::Error.Write([IO.File]::ReadAllText($bdSyncErr));`,
            `Remove-Item -LiteralPath $bdSyncOut, $bdSyncErr -Force -ErrorAction SilentlyContinue;`,
            `exit $bdSyncProc.ExitCode`,
        ].join(' ');
    }
    const issued = bdSyncCommandFor(tokens.join(' '), { os, shell });
    // The heartbeat's sleep has its stdio detached, so a heartbeat subshell
    // killed mid-sleep leaves nothing holding the command's output open.
    return '{ ' + issued + ' & bdsync_pid=$!; '
        + '( bdsync_s=0; while [ "$bdsync_s" -lt ' + cap + ' ]; do sleep ' + interval + ' </dev/null >/dev/null 2>&1; '
        + 'bdsync_s=$((bdsync_s+' + interval + ')); echo "' + SYNC_HEARTBEAT_PREFIX + ' ${bdsync_s}s"; done ) & bdsync_hb=$!; '
        + 'wait "$bdsync_pid"; bdsync_rc=$?; kill "$bdsync_hb" 2>/dev/null; (exit "$bdsync_rc"); }';
}

const POSIX_HEARTBEAT_RE = /^\{ ([\s\S]*?) & bdsync_pid=\$!; /;
const PWSH_HEARTBEAT_RE = /^((?:\$env:[A-Za-z_][A-Za-z0-9_]*='[^']*'; )*)\$bdSyncExe = \(Get-Command '([^']+)' -CommandType Application[\s\S]*?Start-Process -FilePath \$bdSyncExe(?: -ArgumentList @\(([^)]*)\))? /;

/**
 * The command inside a withSyncHeartbeat() wrapper -- exactly what
 * bdSyncCommandFor() returns for the same command and target -- or the input
 * unchanged when it is not a wrapped command. logicalBdCommand() calls this
 * first, so a wrapped D-pull is still a D-pull to every classifier.
 *
 * @param {string} cmdStr
 * @returns {string}
 */
export function unwrapSyncHeartbeat(cmdStr) {
    if (typeof cmdStr !== 'string' || !cmdStr.includes(SYNC_HEARTBEAT_PREFIX)) return cmdStr;
    const posix = POSIX_HEARTBEAT_RE.exec(cmdStr);
    if (posix) return posix[1].trim();
    const pwsh = PWSH_HEARTBEAT_RE.exec(cmdStr);
    if (pwsh) {
        const args = (pwsh[3] || '').split(',').map((a) => a.trim().replace(/^'|'$/g, '')).filter(Boolean);
        return pwsh[1] + [pwsh[2], ...args].join(' ');
    }
    return cmdStr;
}

/**
 * Remove heartbeat lines from a wrapped sync command's output or error text.
 * @param {string|null|undefined} text
 * @returns {string|null|undefined} the text without heartbeat lines (non-strings unchanged)
 */
export function stripSyncHeartbeat(text) {
    if (typeof text !== 'string' || !text.includes(SYNC_HEARTBEAT_PREFIX)) return text;
    // Only the heartbeat token (and its own line end) goes: a partial bd line
    // the heartbeat landed in the middle of is kept whole.
    return text.replace(HEARTBEAT_TOKEN_RE, '');
}

const HEARTBEAT_TOKEN_RE = new RegExp(`${SYNC_HEARTBEAT_PREFIX.replace(/[[\]]/g, '\\$&')} \\d+s(?:\\r?\\n)?`, 'g');
