import { existsSync } from 'node:fs';
import { LinuxCommands } from './linux.js';
import { wrapPowerShellEncoded } from './windows.js';
import { escapeDoubleQuoted, escapeShellArg, escapeBatchMetachars, sanitizeSessionId } from '../utils/shell-escape.js';
import type { ProviderAdapter } from './os-commands.js';

/**
 * Candidate install locations for the Git-for-Windows bash executable, in the
 * order Git for Windows itself installs them. Used only by cleanExec (local
 * spawn); remote members reach bash through their own sshd default shell.
 */
const GIT_BASH_CANDIDATES = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
];

function resolveGitBashPath(): string {
  for (const candidate of GIT_BASH_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  // Last resort: let the OS resolve it from PATH (Git for Windows puts
  // bash.exe on PATH for "Git from the command line" installs).
  return 'bash.exe';
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
    const psLiteral = (s: string) => s.replace(/'/g, "''");
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
    // taskkill /T kills the whole process tree, which is what LinuxCommands
    // hand-rolls with pgrep -P (absent from Git bash). The doubled slashes stop
    // MSYS from path-mangling the switches; taskkill exits non-zero when the
    // pid is already gone, so swallow that the way LinuxCommands does.
    return `taskkill //F //T //PID ${pid} >/dev/null 2>&1; true`;
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
