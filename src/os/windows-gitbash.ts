import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { LinuxCommands, posixLegacyHelperUnset } from './linux.js';
import { wrapPowerShellEncoded, fleetProcessCheckPs } from './windows.js';
import { escapeDoubleQuoted, escapeShellArg, escapeBatchMetachars } from '../utils/shell-escape.js';
import { isWindowsPosixUname } from '../utils/platform.js';
import { gitBashCandidates } from './git-bash-candidates.js';
import { gitCredentialHelperStem } from './os-commands.js';
import { assertAuthorizedKeyMatch } from './ssh-key-match.js';
import { boundChildEnv, describeBoundedEnv } from './child-env-bound.js';
import { defaultIsFile, envValue, searchWindowsPath } from './windows-executable.js';
import { logWarn } from '../utils/log-helpers.js';
import type { ProviderAdapter, PromptOptions } from './os-commands.js';
import { withGoMaxProcsDefault, GO_MAXPROCS_DEFAULT_GITBASH } from './go-concurrency.js';

/**
 * Dependencies resolveGitBashPath needs, injectable so its logic is testable
 * on any platform without a real Git-for-Windows install or a real WSL
 * bash.exe on PATH (apra-fleet-7dir.7). Defaults to the real filesystem/env/
 * child_process when omitted -- production callers pass nothing.
 */
export interface ResolveGitBashPathDeps {
  /** Defaults to process.env. Its PATH / PATHEXT drive the PATH fallback. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to fs.existsSync. Checks the well-known candidates only. */
  exists?: (candidatePath: string) => boolean;
  /**
   * True when p is an existing regular file; used by the PATH-only search of
   * the fallback. Defaults to an fs.statSync check.
   */
  isFile?: (p: string) => boolean;
  /**
   * Runs `uname -s` through the given ABSOLUTE bash.exe path (the first one
   * the PATH-only search found) and returns its stdout, or undefined if it
   * could not be run. Defaults to a real execFileSync(bashPath, ['-lc', 'uname -s']).
   */
  probeUname?: (bashPath: string) => string | undefined;
}

function defaultProbeUname(bashPath: string): string | undefined {
  try {
    return execFileSync(bashPath, ['-lc', 'uname -s'], { encoding: 'utf-8', timeout: 5000, windowsHide: true }).toString();
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
 * silently trust a bash.exe found on PATH -- Windows also ships the WSL
 * launcher under System32/Sysnative/WindowsApps with the identical binary
 * name (the same ambiguity isWslLauncherPath/isWindowsPosixUname exist to
 * eliminate for the registration probe). It searches ONLY absolute PATH
 * entries (src/os/windows-executable.ts -- never the cwd, which for
 * LocalStrategy is the member work folder), runs `uname -s` through that
 * absolute path, and returns the absolute path only if the output proves a
 * real MSYS/MinGW/Cygwin bash; otherwise it throws, naming every candidate
 * path it tried. It never returns a bare program name.
 */
export function resolveGitBashPath(deps: ResolveGitBashPathDeps = {}): string {
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const candidates = gitBashCandidates(env.LOCALAPPDATA);

  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }

  const { found: pathBash } = searchWindowsPath('bash.exe', {
    pathValue: envValue(env, 'PATH'),
    pathext: envValue(env, 'PATHEXT'),
    isFile: deps.isFile ?? defaultIsFile,
  });
  const probeUname = deps.probeUname ?? defaultProbeUname;
  const unameOutput = pathBash === undefined ? undefined : probeUname(pathBash);
  if (pathBash !== undefined && unameOutput !== undefined && isWindowsPosixUname(unameOutput)) return pathBash;

  throw new Error(
    `No Git-for-Windows bash.exe found. Tried: ${candidates.join(', ')}` +
      (pathBash === undefined
        ? ', and no bash.exe was found in any absolute PATH entry.'
        : unameOutput === undefined
          ? `, and the PATH bash.exe at ${pathBash} could not be run.`
          : `, and the PATH bash.exe at ${pathBash} reported "${unameOutput.trim()}" for uname -s (not MSYS/MinGW/Cygwin).`),
  );
}

/**
 * The Git Bash FLEET_PID wrapper: pidWrapUnix's shape, but the marker carries
 * the WINDOWS pid of the backgrounded subshell, read from MSYS's
 * /proc/<msys-pid>/winpid, instead of bash's `$!`.
 *
 * `$!` is an MSYS pid, a namespace of its own: taskkill (killPid below) and
 * every other Windows API read it as an unrelated Windows pid, so a timeout
 * kill either missed the command or hit some other process. The winpid of the
 * `{ cmd; } &` subshell is the Windows root of the command's tree. Verified on
 * Git for Windows (GNU bash 5.2.37 x86_64-pc-msys) with a single native
 * command: winpid -> bash.exe (fork stub) -> node.exe, where the MSYS pid
 * matched none of them.
 *
 * `read` is a builtin, so no extra fork delays the marker. When the winpid
 * cannot be read (the subshell already exited) NO marker is emitted -- falling
 * back to the MSYS pid would reintroduce the wrong-process kill; with no pid
 * captured the timeout kill is simply skipped, same as a command that never
 * printed one. `wait` keeps the MSYS pid: it is bash's job id.
 */
export function pidWrapGitBash(cmd: string): string {
  return `{ ${cmd}; } & _fleet_pid=$!; _fleet_wpid=; { read -r _fleet_wpid < "/proc/$_fleet_pid/winpid"; } 2>/dev/null; `
    + `if [ -n "$_fleet_wpid" ]; then printf 'FLEET_PID:%s\\n' "$_fleet_wpid"; fi; wait "$_fleet_pid"; exit $?`;
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
    // The script is the one WindowsCommands runs (fleetProcessCheckPs: the
    // Win32_Process read, the single if/elseif/else statement PS 5.1 needs,
    // and the fleet-marker plus owner match), joined with newlines here.
    if (processName === '') return "echo 'idle'";
    return wrapPowerShellEncoded(fleetProcessCheckPs(folder, sessionId, processName ?? 'claude').join('\n'));
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

  override credentialFileInstall(stagedPath: string, destPath: string): string {
    // Same NTFS ACL follow-up as credentialFileWrite above.
    return `${super.credentialFileInstall(stagedPath, destPath)} && icacls "$(cygpath -w "${this.quotedPath(destPath)}")" /inheritance:r /grant:r "$USERNAME:F" >/dev/null`;
  }

  // --- Git credential helper ---

  override gitCredentialHelperWrite(host: string, username: string, token: string, label?: string, _scopeUrl?: string, memberId?: string): string {
    // A .bat helper (not the POSIX `#!/bin/sh` one LinuxCommands writes):
    // git.exe execs the helper itself, so it must be a native Windows
    // executable at a Windows-form absolute path -- the same shape windows.ts
    // writes and windows-credential-helper.test.ts pins. Per member AND label,
    // registered nowhere in git config (see gitCredentialEnvPrefix).
    const batch = (s: string) => escapeShellArg(escapeBatchMetachars(s));
    return [
      `_fleet_gc="$HOME/${gitCredentialHelperStem(label, memberId)}.bat"`,
      `printf '@echo off\\r\\necho protocol=https\\r\\necho host=%s\\r\\necho username=%s\\r\\necho password=%s\\r\\n' ${batch(host)} ${batch(username)} ${batch(token)} > "$_fleet_gc"`,
      `icacls "$(cygpath -w "$_fleet_gc")" /inheritance:r /grant:r "$USERNAME:F" >/dev/null`,
    ].join('; ');
  }

  override gitCredentialHelperRemoveLegacyFile(): string {
    // The Git-Bash helper is a `.bat` (see gitCredentialHelperWrite above), so
    // the legacy unlabeled file carries that suffix too. File only --
    // deliberately no `git config --unset-all`.
    return `rm -f "$HOME/.fleet-git-credential.bat"`;
  }

  override gitCredentialHelperRead(label?: string, memberId?: string): { command: string; path: string } {
    // The inherited POSIX read would look for an extensionless helper, but
    // this member's gitCredentialHelperWrite above deploys a native Windows
    // `.bat` (git.exe execs the helper itself). The SHELL is still bash, so
    // the invocation stays POSIX -- only the filename differs.
    const credFile = `$HOME/${gitCredentialHelperStem(label, memberId)}.bat`;
    return { command: `"${credFile}"`, path: credFile };
  }

  override gitCredentialHelperRemove(_host: string, label?: string, _scopeUrl?: string, memberId?: string): string {
    return `rm -f "$HOME/${gitCredentialHelperStem(label, memberId)}.bat"`;
  }

  override gitCredentialHelperRemoveLegacyGlobal(host: string, label?: string, scopeUrl?: string): string {
    const stem = gitCredentialHelperStem(label);
    const key = escapeShellArg(`credential.${scopeUrl ?? `https://${host}`}.helper`);
    // The legacy release stored `cygpath -m` of the .bat path as the value.
    return `rm -f "$HOME/${stem}.bat"; ` + posixLegacyHelperUnset(key, `"$(cygpath -m "$HOME")/${stem}.bat"`);
  }

  /** git.exe needs the Windows-form (forward-slash) path of the .bat helper. */
  protected override gitHelperHomeCommand(): string {
    return `cygpath -m "$HOME"`;
  }

  protected override gitHelperSuffix(): string {
    return '.bat';
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

  override removeSSHPublicKey(keyMatch: string, memberHome: string): string {
    assertAuthorizedKeyMatch(keyMatch);
    // A local gitbash member's home comes from os.homedir() (C:\Users\x);
    // a probed one is already POSIX (/c/Users/x). Bash accepts C:/Users/x.
    const home = memberHome.replace(/\\/g, '/').replace(/\/+$/, '');
    // Rewrite in place (not mv): the files carry the explicit ACLs deploy set
    // with icacls, and a renamed temp file would carry the directory's instead.
    const install = 'cat "$_fleet_tmp" > "$_fleet_ak" && rm -f "$_fleet_tmp"';
    return `_fleet_ak=${escapeShellArg(`${home}/.ssh/authorized_keys`)}; `
      + `${this.filterAuthorizedKeysPosix(keyMatch, install)}; `
      // Same admin probe and file deploySSHPublicKey uses.
      + `if net session >/dev/null 2>&1; then `
      + `_fleet_ak="$(cygpath -u "\${ProgramData:-C:/ProgramData}")/ssh/administrators_authorized_keys"; `
      + `${this.filterAuthorizedKeysPosix(keyMatch, install)}; `
      + `fi`;
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
    // The inherited fleet-server env is passed on to bd -> dolt -> git, so
    // bound it (deduped PATH, size cap) -- see child-env-bound.ts and
    // docs/troubleshooting.md ("Not enough memory resources").
    const bounded = boundChildEnv(env, { sep: process.platform === 'win32' ? ';' : ':' });
    if (bounded.report.dropped.length || bounded.report.overCap) logWarn('clean_env', describeBoundedEnv(bounded.report));
    // GOMAXPROCS default for bd/dolt on Windows (only when unset) -- see go-concurrency.ts.
    return { command, env: withGoMaxProcsDefault(bounded.env), shell: resolveGitBashPath() };
  }

  // --- Remote agent launch / execute_command (GOMAXPROCS default) ---
  //
  // A remote Git Bash member's env is only known to its own shell, so the
  // GOMAXPROCS default (only when the member has none) is a Git Bash statement
  // prefixed to the launch and execute_command wrappers -- see
  // go-concurrency.ts. LinuxCommands (linux/macOS) is unchanged.

  override buildAgentPromptCommand(provider: ProviderAdapter, opts: PromptOptions): string {
    return `${GO_MAXPROCS_DEFAULT_GITBASH}${super.buildAgentPromptCommand(provider, opts)}`;
  }

  override wrapInWorkFolder(folder: string, command: string): string {
    return `${GO_MAXPROCS_DEFAULT_GITBASH}${super.wrapInWorkFolder(folder, command)}`;
  }

  // --- Process management ---

  /**
   * Both FLEET_PID emit paths (wrapPidCapture and buildAgentPromptCommand)
   * go through this hook, so both carry the Windows pid killPid needs -- see
   * pidWrapGitBash. killPid itself still takes a Windows pid unchanged: a
   * local member's timeout kills via Node's child.pid, already a Windows pid.
   */
  protected override pidWrap(command: string): string {
    return pidWrapGitBash(command);
  }

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
