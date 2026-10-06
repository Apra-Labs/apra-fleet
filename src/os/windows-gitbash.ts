import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { LinuxCommands } from './linux.js';
import { wrapPowerShellEncoded } from './windows.js';
import { escapeDoubleQuoted, escapeShellArg, escapeBatchMetachars, escapePowerShellArgInner, sanitizeSessionId } from '../utils/shell-escape.js';
import { isWindowsPosixUname } from '../utils/platform.js';
import { gitBashCandidates } from './git-bash-candidates.js';
import type { ProviderAdapter } from './os-commands.js';

/**
 * Dependencies resolveGitBashPath needs, injectable so its logic is testable
 * on any platform without a real Git-for-Windows install or a real WSL
 * bash.exe on PATH (apra-fleet-7dir.7). Defaults to the real filesystem/env/
 * child_process when omitted -- production callers pass nothing.
 */
export interface ResolveGitBashPathDeps {
  /** Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to fs.existsSync. */
  exists?: (candidatePath: string) => boolean;
  /**
   * Runs `uname -s` through the PATH-resolved bash.exe (if any) and returns
   * its stdout, or undefined if no bash.exe is on PATH / it could not be
   * run. Defaults to a real execFileSync('bash.exe', ['-lc', 'uname -s']).
   */
  probeUname?: () => string | undefined;
}

function defaultProbeUname(): string | undefined {
  try {
    return execFileSync('bash.exe', ['-lc', 'uname -s'], { encoding: 'utf-8', timeout: 5000, windowsHide: true }).toString();
  } catch {
    return undefined;
  }
}

/**
 * Resolve the absolute path to the member's Git-for-Windows bash.exe for a
 * local spawn (LocalStrategy.execCommand -> cleanExec). Candidates come from
 * the SAME list src/services/shell-probe.ts's registration probe uses
 * (src/os/git-bash-candidates.ts), including the user-scope LOCALAPPDATA
 * install location, so the two can never drift apart.
 *
 * If none of the known-location candidates exist on disk, this does NOT
 * silently trust a bare `bash.exe` resolved off PATH -- Windows also ships
 * the WSL launcher under System32/Sysnative/WindowsApps with the identical
 * binary name (the same ambiguity isWslLauncherPath/isWindowsPosixUname
 * exist to eliminate for the registration probe). Instead it runs `uname -s`
 * through whatever bash.exe PATH resolves and only trusts it if that output
 * proves a real MSYS/MinGW/Cygwin bash; otherwise it throws, naming every
 * candidate path it tried.
 */
export function resolveGitBashPath(deps: ResolveGitBashPathDeps = {}): string {
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const candidates = gitBashCandidates(env.LOCALAPPDATA);

  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }

  const probeUname = deps.probeUname ?? defaultProbeUname;
  const unameOutput = probeUname();
  if (unameOutput !== undefined && isWindowsPosixUname(unameOutput)) return 'bash.exe';

  throw new Error(
    `No Git-for-Windows bash.exe found. Tried: ${candidates.join(', ')}` +
      (unameOutput === undefined
        ? ', and no bash.exe on PATH could be run.'
        : `, and the PATH-resolved bash.exe reported "${unameOutput.trim()}" for uname -s (not MSYS/MinGW/Cygwin).`),
  );
}

/**
 * OS commands for a Windows member whose registered shell is Git-for-Windows
 * bash (`shell: 'gitbash'`).
 *
 * Why a subclass of LinuxCommands rather than of WindowsCommands: what the
 * member's shell actually receives is a *bash* command string, so the whole
 * POSIX surface (mkdir -p, cat, printf, sed, node -e, the FLEET_PID subshell
 * wrapper, the CLI prompt builder) is correct as-is and is inherited verbatim
 * from LinuxCommands. Only genuinely Windows-native behaviour is overridden:
 * process listing, process-tree kill, host resource queries, GPU probing,
 * provider install selection, and the credential/SSH-key roots that live under
 * the Windows user profile and need NTFS ACLs (chmod is a no-op on NTFS).
 *
 * src/os/windows.ts (PowerShell) is untouched and stays the implementation for
 * a Windows member with no confirmed gitbash shell.
 *
 * ONE method -- fleetProcessCheck -- reaches back into PowerShell, because
 * there is no dependable bash-native way to read another process's full
 * command line on Windows (Git bash has no pgrep; `ps -W` shows only the exe
 * path; `tasklist` has no command-line column; `wmic` is deprecated and absent
 * from recent Windows builds). It does so through wrapPowerShellEncoded, which
 * exists in windows.ts for exactly this case: it emits a single
 * `powershell -EncodedCommand <base64>` invocation containing no PowerShell
 * syntax and no shell metacharacters, so it is safe to run from bash (see the
 * doc comment on wrapPowerShellEncoded). No other override emits a PowerShell
 * cmdlet.
 */
export class WindowsGitBashCommands extends LinuxCommands {
  /**
   * Normalize a Windows path (C:\Users\x) into the mixed form (C:/Users/x)
   * that MSYS tools and Windows APIs both accept, so it survives being
   * interpolated into a double-quoted bash string where `\` is an escape.
   */
  protected toBashPath(p: string): string {
    return p.replace(/\\/g, '/');
  }

  /** Bash-safe, `~`-expanded form of a member-side path. */
  private quotedPath(p: string): string {
    const t = this.toBashPath(p);
    if (t === '~') return '$HOME';
    if (t.startsWith('~/')) return '$HOME/' + escapeDoubleQuoted(t.slice(2));
    return escapeDoubleQuoted(t);
  }

  // --- Resources ---

  // MSYS exposes /proc/meminfo with real values but /proc/loadavg is always
  // 0.00 on Windows, and neither `uptime` nor `free` exists in Git bash.
  // Report the same memory-load percentage WindowsCommands.cpuLoad reports
  // (dwMemoryLoad), so both Windows shells produce comparable output.

  override cpuLoad(): string {
    return `awk '/^MemTotal:/{t=$2} /^MemFree:/{f=$2} END{if(t>0) printf "cpu:%d%%\\n", (t-f)*100/t}' /proc/meminfo`;
  }

  override memory(): string {
    return `awk '/^MemTotal:/{t=$2} /^MemFree:/{f=$2} END{printf "%d MB / %d MB\\n", (t-f)/1024, t/1024}' /proc/meminfo`;
  }

  override disk(folder: string): string {
    // MSYS df understands drive-letter paths, but only once backslashes are
    // normalized away -- they would otherwise be eaten as bash escapes.
    return `df -h "${this.quotedPath(folder)}"`;
  }

  // --- Process check ---

  override fleetProcessCheck(folder: string, sessionId?: string, processName?: string): string {
    // See the class doc comment: the only override that hops to PowerShell,
    // and it does so as a single bash-safe `powershell -EncodedCommand` call.
    //
    // The script is written here rather than delegated to
    // WindowsCommands.fleetProcessCheck for two reasons, both verified live
    // against PowerShell 5.1 on 2026-08-22: that version joins its statements
    // with '; ', which makes `; elseif` a parse error ("The term 'elseif' is
    // not recognized"), and it reads $_.CommandLine off Get-Process objects,
    // which is always $null on 5.1. Win32_Process is the supported way to get
    // a command line, and single quotes plus .Contains() keep the interpolated
    // values literal (no regex metacharacter surprises).
    const pname = processName ?? 'claude';
    if (!/^[A-Za-z0-9._-]+$/.test(pname)) throw new Error('Invalid process name: ' + pname);
    const psLiteral = (s: string) => escapePowerShellArgInner(s);
    const matches = [`$_.CommandLine.Contains('${psLiteral(folder)}')`];
    if (sessionId) matches.push(`$_.CommandLine.Contains('${psLiteral(sanitizeSessionId(sessionId))}')`);
    const script = [
      // PS 5.1 emits its "Preparing modules for first use" progress records to
      // stderr as CLIXML on a first CIM call; harmless but noisy in logs.
      `$ProgressPreference = 'SilentlyContinue'`,
      `$procs = @(Get-CimInstance Win32_Process -Filter "Name LIKE '${pname}%'" -ErrorAction SilentlyContinue)`,
      `if ($procs.Count -eq 0) {`,
      `  echo 'idle'`,
      `} elseif ($procs | Where-Object { $_.CommandLine -and (${matches.join(' -or ')}) }) {`,
      `  echo 'fleet-busy'`,
      `} else {`,
      `  echo 'other-busy'`,
      `}`,
    ].join('\n');
    return wrapPowerShellEncoded(script);
  }

  // --- Generic agent CLI ---

  override installAgent(provider: ProviderAdapter): string {
    // The member is a Windows host; only the shell differs (apra-fleet-7dir.2.7).
    return provider.installCommand('windows', 'gitbash');
  }

  // --- Auth ---

  override credentialFileWrite(content: string, destPath: string): string {
    // The inherited POSIX write is correct, but its `chmod 600` is a no-op on
    // NTFS -- restrict the file with an ACL the way windows.ts does.
    return `${super.credentialFileWrite(content, destPath)} && icacls "$(cygpath -w "${this.quotedPath(destPath)}")" /inheritance:r /grant:r "$USERNAME:F" >/dev/null`;
  }

  // --- Git credential helper ---

  override gitCredentialHelperWrite(host: string, username: string, token: string, label?: string, scopeUrl?: string): string {
    const credFileName = label ? `.fleet-git-credential-${escapeDoubleQuoted(label)}` : '.fleet-git-credential';
    const credUrl = scopeUrl ? escapeDoubleQuoted(scopeUrl) : `https://${escapeDoubleQuoted(host)}`;
    // A .bat helper (not the POSIX `#!/bin/sh` one LinuxCommands writes):
    // git.exe execs the helper itself, so it must be a native Windows
    // executable at a Windows-form absolute path -- the same shape windows.ts
    // writes and windows-credential-helper.test.ts pins.
    const batch = (s: string) => escapeShellArg(escapeBatchMetachars(s));
    return [
      `_fleet_gc="$HOME/${credFileName}.bat"`,
      `printf '@echo off\\r\\necho protocol=https\\r\\necho host=%s\\r\\necho username=%s\\r\\necho password=%s\\r\\n' ${batch(host)} ${batch(username)} ${batch(token)} > "$_fleet_gc"`,
      `icacls "$(cygpath -w "$_fleet_gc")" /inheritance:r /grant:r "$USERNAME:F" >/dev/null`,
      `git config --global --replace-all "credential.${credUrl}.helper" ""`,
      `git config --global --add "credential.${credUrl}.helper" "$(cygpath -m "$_fleet_gc")"`,
    ].join('; ');
  }

  override gitCredentialHelperRemoveLegacyFile(): string {
    // The Git-Bash helper is a `.bat` (see gitCredentialHelperWrite above), so
    // the legacy unlabeled file carries that suffix too. File only --
    // deliberately no `git config --unset-all`.
    return `rm -f "$HOME/.fleet-git-credential.bat"`;
  }

  override gitCredentialHelperRead(label?: string): { command: string; path: string } {
    // The inherited POSIX read would look for an extensionless helper, but
    // this member's gitCredentialHelperWrite above deploys a native Windows
    // `.bat` (git.exe execs the helper itself). The SHELL is still bash, so
    // the invocation stays POSIX -- only the filename differs.
    const credFileName = label ? `.fleet-git-credential-${escapeDoubleQuoted(label)}` : '.fleet-git-credential';
    const credFile = `$HOME/${credFileName}.bat`;
    return { command: `"${credFile}"`, path: credFile };
  }

  override gitCredentialHelperRemove(host: string, label?: string, scopeUrl?: string): string {
    const credFileName = label ? `.fleet-git-credential-${escapeDoubleQuoted(label)}` : '.fleet-git-credential';
    const credUrl = scopeUrl ? escapeDoubleQuoted(scopeUrl) : `https://${escapeDoubleQuoted(host)}`;
    return `rm -f "$HOME/${credFileName}.bat"; git config --global --unset-all "credential.${credUrl}.helper" 2>/dev/null || true`;
  }

  // --- SSH key deployment ---

  override deploySSHPublicKey(publicKeyLine: string): string[] {
    const escaped = escapeShellArg(publicKeyLine);
    return [
      'mkdir -p ~/.ssh',
      'touch ~/.ssh/authorized_keys',
      `echo ${escaped} >> ~/.ssh/authorized_keys`,
      // chmod cannot express the ACL Windows OpenSSH demands; icacls can.
      'icacls "$(cygpath -w "$HOME/.ssh/authorized_keys")" /inheritance:r /grant:r "$USERNAME:F" >/dev/null',
      // Windows OpenSSH ignores ~/.ssh/authorized_keys for members of the
      // Administrators group (sshd_config: Match Group administrators ->
      // __PROGRAMDATA__/ssh/administrators_authorized_keys). `net session`
      // is the bash-native admin probe; non-admins simply skip this branch.
      `if net session >/dev/null 2>&1; then `
        + `_fleet_ak="$(cygpath -u "\${ProgramData:-C:/ProgramData}")/ssh/administrators_authorized_keys"; `
        + `mkdir -p "$(dirname "$_fleet_ak")"; `
        + `echo ${escaped} >> "$_fleet_ak"; `
        + `icacls "$(cygpath -w "$_fleet_ak")" /inheritance:r /grant:r "SYSTEM:F" /grant:r "Administrators:F" >/dev/null; `
        + `fi`,
    ];
  }

  // --- Local exec ---

  override cleanExec(command: string): { command: string; env?: Record<string, string>; shell?: string } {
    // Not LinuxCommands.getCleanEnv(): that rebuilds a pristine env with
    // `env -i ... bash -l -c 'env -0'` through execSync, which on Windows
    // runs under cmd.exe (no `shell` option passed) and throws -- so a local
    // gitbash dispatch used to inherit the fleet server's env wholesale
    // instead (apra-fleet-7dir.4). Inheriting the parent env is still correct
    // here (its PATH already resolves the provider CLI); only the
    // *_SOURCE_METADATA vars need stripping, same as WindowsCommands and
    // LinuxCommands do for their own members, so filter them out of a copy
    // rather than rebuilding the whole env from scratch.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (k === 'ANTIGRAVITY_SOURCE_METADATA' || k === 'CLAUDE_SOURCE_METADATA'
        || k === 'COPILOT_SOURCE_METADATA' || k === 'CODEX_SOURCE_METADATA') continue;
      env[k] = v;
    }
    return { command, env, shell: resolveGitBashPath() };
  }

  // --- Process management ---

  override killPid(pid: number): string {
    // Every pid this receives is an MSYS pid: the FLEET_PID marker is emitted
    // by bash's `$!` (pidWrapUnix), and every caller -- ssh.ts killRemoteTree,
    // tryKillPid, orphan recovery -- passes that marker value. (LocalStrategy's
    // own timeout kill uses Node's child.pid and taskkill directly on win32;
    // it never runs this string.) An MSYS pid is NOT a Windows pid, so the old
    // `taskkill //PID <msys pid>` missed the tree -- or hit an unrelated
    // Windows process that happened to own that number.
    //
    // Why kill the PROCESS GROUP and not just the Windows tree of the pid's
    // winpid: when MSYS bash forks and execs an MSYS binary (sleep, git, ...),
    // the forked Windows process exits and the exec'd one is left with a dead
    // Windows parent, so `taskkill /T` from the winpid cannot reach it.
    // Membership in the bash process group survives that. Native Windows
    // descendants (node.exe, cmd.exe) are outside the MSYS group, so each
    // group member's winpid is also handed to `taskkill //T` to take its
    // Windows subtree. Bash job control is off in the non-interactive
    // wrapper, so the group is exactly the wrapper invocation; the group of
    // the shell running THIS kill is never targeted, nor pgid <= 1.
    //
    // Stale-pid guard: callers may pass a pid stored by an EARLIER dispatch
    // (execute_prompt pre-kills it), which MSYS may since have recycled. The
    // group is only killed when the pid still has the wrapper's exact shape
    // -- a non-leader whose parent IS its group leader (the `{ ...; } &`
    // subshell of a non-interactive bash). An interactive shell's job is its
    // own group leader, so a recycled pid there falls through to killing
    // just that pid, the same exposure LinuxCommands.killPid has.
    //
    // Pure bash builtins over /proc (no pgrep in Git bash). Doubled slashes
    // stop MSYS from path-mangling taskkill's switches. Best-effort: every
    // step tolerates an already-dead process and the trailing `true` keeps
    // the exit code 0, matching LinuxCommands.killPid.
    const p = Math.trunc(pid);
    return [
      `_fleet_pg=; _fleet_pp=; _fleet_self=; _fleet_w=`,
      `{ read -r _fleet_pg < /proc/${p}/pgid; read -r _fleet_pp < /proc/${p}/ppid; read -r _fleet_self < /proc/$$/pgid; } 2>/dev/null`,
      `if [ -n "$_fleet_pg" ] && [ "$_fleet_pg" -gt 1 ] && [ "$_fleet_pg" != "$_fleet_self" ] && [ "$_fleet_pg" != "${p}" ] && [ "$_fleet_pp" = "$_fleet_pg" ]; then `
        + `for _fleet_d in /proc/[0-9]*; do _fleet_g=; _fleet_x=; { read -r _fleet_g < "$_fleet_d/pgid"; } 2>/dev/null; `
        + `if [ "$_fleet_g" = "$_fleet_pg" ]; then { read -r _fleet_x < "$_fleet_d/winpid"; } 2>/dev/null; [ -n "$_fleet_x" ] && _fleet_w="$_fleet_w //PID $_fleet_x"; fi; done; `
        + `[ -n "$_fleet_w" ] && taskkill //F //T $_fleet_w >/dev/null 2>&1; `
        + `kill -9 -- -"$_fleet_pg" 2>/dev/null; fi`,
      `kill -9 ${p} 2>/dev/null`,
      `true`,
    ].join('; ');
  }

  // --- GPU activity ---

  override gpuProcessCheck(): string {
    // Windows fleet members do not use nvidia-smi -- signal not available.
    return 'exit 1';
  }

  override gpuUtilization(): string {
    return 'echo 0';
  }

  // --- Resource output parsing ---

  override parseMemory(stdout: string): string {
    // memory() already emits the final "<used> MB / <total> MB" string; there
    // is no `free -m` table to parse.
    return stdout.trim().substring(0, 200);
  }
}
