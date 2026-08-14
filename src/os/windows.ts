import { defaultWindowsPidWrapper } from './windows-wrapper.js';
export { defaultWindowsPidWrapper as pidWrapWindows };
﻿import { execSync } from 'node:child_process';
import type { OsCommands, ProviderAdapter, PromptOptions } from './os-commands.js';
import { escapeWindowsArg, sanitizeSessionId } from './os-commands.js';
import { escapeBatchMetachars } from '../utils/shell-escape.js';

/**
 * Wrap a PowerShell script as a base64 `-EncodedCommand` invocation.
 * Use this for ANY Windows member-bound command instead of sending a raw
 * PowerShell one-liner over strategy.execCommand -- the raw form only works
 * if the member's sshd default shell happens to be PowerShell; on a cmd.exe
 * default it silently produces garbage (apra-fleet-ot2z.10).
 *
 * On PS 5.1, `powershell -EncodedCommand <script>`'s raw exit-code behavior
 * already surfaces most non-terminating cmdlet failures as exit 1 (verified
 * live: Get-Item on a missing path, Set-Content to an unwritable path both
 * already exit 1 with no wrapping at all). The wrapper's actual value here is
 * (a) correctly suppressing exit 1 for a failure the caller genuinely opted
 * out of via an explicit `-ErrorAction SilentlyContinue` on an individual
 * cmdlet (apra-fleet-ot2z.12's real, verified case), and (b) preserving the
 * exit code of a *native* command (e.g. `& "some.bat"`, `icacls ...`) that is
 * the last statement in the script, which would otherwise be masked by the
 * unconditional `exit 0` below. Call sites that intentionally tolerate a
 * failure (e.g. strategy.ts's deleteFiles) pass an explicit `-ErrorAction
 * SilentlyContinue`/`-ErrorAction Stop` on the individual cmdlet, which
 * overrides the global preference for that cmdlet and keeps its original
 * tolerate-missing-path behavior.
 *
 * Before the trailing `exit 0`, `$LASTEXITCODE` is checked and propagated if
 * set and non-zero: without it, a failing native command's exit code would be
 * discarded, since PowerShell's own exit code otherwise falls back to
 * whatever `exit 0` (or `$?` of the last statement, which PowerShell sets to
 * $false whenever *any* error record was written to the error stream during
 * the session -- even one suppressed by -ErrorAction SilentlyContinue on an
 * individual cmdlet) says. That quirk would otherwise turn every
 * intentionally-tolerated failure (e.g. deleteFiles removing an
 * already-gone file) into a false non-zero exit, which is why the fallback
 * stays `exit 0` rather than propagating `$?`.
 */
export function wrapPowerShellEncoded(psScript: string): string {
  const guarded = `$ErrorActionPreference = 'Stop'; try { ${psScript}; if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 0 } catch { Write-Error $_; exit 1 }`;
  const encoded = Buffer.from(guarded, 'utf16le').toString('base64');
  return `powershell -EncodedCommand ${encoded}`;
}

/** Default console title used when a caller explicitly opts out of hiding. */
export const DETACHED_VISIBLE_WINDOW_TITLE = 'Apra Fleet MCP Server -- do not close';

export interface DetachedLaunchOptions {
  /** Absolute path to the executable (resolved in JS -- no ~, $HOME, %VAR%). */
  command: string;
  /** Arguments, passed verbatim; quoted here as needed. */
  args?: string[];
  /** Absolute working directory for the child. */
  cwd: string;
  /** Absolute path of the file that receives the child's stdout AND stderr. */
  logFile: string;
  /**
   * Explicit opt-out of the hidden-window behaviour (SANCTIONED FALLBACK).
   * Defaults to false: hidden is always the default, never a visible window.
   */
  showWindow?: boolean;
  /** Console title for the opt-out visible-window path only. */
  title?: string;
}

export type DetachedLaunchResult =
  | { ok: true; pid: number; command: string }
  | { ok: false; error: string; stderr: string; returnValue?: number; command: string };

/** Injectable executor so callers/tests can run or observe the built command. */
export type DetachedLaunchExecutor = (command: string) => {
  stdout: string;
  stderr?: string;
  status?: number;
};

const LAUNCH_PID_MARKER = 'FLEET_LAUNCH_PID:';

/** Quote a single cmd.exe token; paths must already be JS-resolved. */
function quoteForCmd(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

/** Escape a JS string for embedding inside a PowerShell single-quoted literal. */
function psSingleQuote(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Build the `powershell -EncodedCommand ...` invocation that starts `command`
 * detached, with NO visible console window.
 *
 * Mechanism: `Win32_Process.Create` with a `Win32_ProcessStartup` instance
 * carrying `ShowWindow`. WMI maps that property onto `STARTUPINFO.wShowWindow`
 * and implicitly sets `dwFlags |= STARTF_USESHOWWINDOW` -- there is no separate
 * `dwFlags` property to set, so `ShowWindow = [uint16]$SW_HIDE` (0) is the
 * whole hidden-window contract. `CreateFlags` (e.g. `CREATE_NO_WINDOW`) is
 * deliberately NOT set: verified live, this WMI provider returns
 * ReturnValue=21 (invalid parameter) whenever `CreateFlags` is present at
 * all, and it is not needed -- `ShowWindow` alone already hides the child's
 * console window. No DETACHED_PROCESS on top either: it conflicts, and is
 * unnecessary because a Win32_Process child is parented to WmiPrvSE, so it
 * already outlives the launching process / SSH channel.
 *
 * apra-fleet-5ti7.2 review fix: the CIM cmdlet path (`New-CimInstance` +
 * `Invoke-CimMethod -Arguments @{ ProcessStartupInformation = $startup }`)
 * throws a bare "Type mismatch" (HRESULT 0x80041005) live on a real Windows
 * host -- verified: `New-CimInstance -ClassName Win32_ProcessStartup
 * -ClientOnly` succeeds on its own, and `Invoke-CimMethod ... Create`
 * without `ProcessStartupInformation` also succeeds, but passing the CIM
 * instance as an embedded argument through `Invoke-CimMethod -Arguments`
 * does not; a DCOM `CimSession` variant fails identically. The legacy WMI
 * COM binding (`[wmiclass]'Win32_ProcessStartup'`/`[wmiclass]'Win32_Process'`)
 * does not go through this code path and is what is used below -- also
 * verified live, `ReturnValue=0` with a real PID.
 *
 * The command is always emitted through `wrapPowerShellEncoded` -- a raw
 * interpolated PowerShell string is what cmd.exe quote-stripping destroyed in
 * the ad hoc attempts this helper replaces (apra-fleet-5ti7).
 *
 * Redirection: `Win32_Process.Create` cannot redirect handles, so the child is
 * launched under `cmd.exe /c` with `>> logFile 2>&1` (append, not truncate --
 * matching the POSIX fallbacks' `fs.openSync(logFile, 'a')` and deploy.md's
 * documented `>> fleet.log` form, apra-fleet-5ti7.2 review fix: `>` truncated
 * the log on every relaunch, destroying evidence of why the previous instance
 * died). Consequence, deliberately surfaced rather than hidden: the PID
 * returned is that cmd.exe wrapper, which owns the real child, exits when it
 * exits (so liveness-by-PID holds) and is killed with the child by
 * `taskkill /F /T /PID`.
 *
 * Every path is resolved by the caller in JavaScript; nothing in the emitted
 * script relies on shell expansion (`~`, `$HOME`, backticks, `%VAR%`).
 */
export function buildDetachedHiddenLaunchCommand(opts: DetachedLaunchOptions): string {
  const { command, args = [], cwd, logFile, showWindow = false } = opts;
  const title = opts.title ?? DETACHED_VISIBLE_WINDOW_TITLE;

  const childCommand = [command, ...args].map(quoteForCmd).join(' ');
  // cmd.exe /c "<child> >> "<log>" 2>&1" -- the outer quotes are stripped by
  // cmd.exe itself, which is why the inner tokens stay individually quoted.
  // `>>` appends rather than truncating, matching the POSIX fallbacks' 'a'
  // mode and deploy.md's documented `>> fleet.log` form.
  const cmdLine = `cmd.exe /c "${childCommand} >> ${quoteForCmd(logFile)} 2>&1"`;

  // ShowWindow is still cast to [uint16] -- Win32_ProcessStartup.ShowWindow's
  // CIM type is UInt16 -- even though the legacy [wmiclass] binding below is
  // more forgiving about untyped literals than Invoke-CimMethod was; keeping
  // the explicit cast documents the contract and costs nothing. CreateFlags
  // is omitted entirely: verified live, Win32_Process Create returns
  // ReturnValue=21 (invalid parameter) on this WMI provider whenever
  // CreateFlags=CREATE_NO_WINDOW is present at all -- and it isn't needed for
  // the hidden-window contract anyway: ShowWindow=SW_HIDE alone (with WMI's
  // implicit STARTF_USESHOWWINDOW) already hides the child's console window,
  // per Windows' documented CreateProcess wShowWindow behaviour.
  const startupAssign = showWindow
    ? `$si.ShowWindow = [uint16]$SW_SHOWNORMAL; $si.Title = '${psSingleQuote(title)}'`
    : `$si.ShowWindow = [uint16]$SW_HIDE`;

  const psScript = [
    '$SW_HIDE = 0',
    '$SW_SHOWNORMAL = 1',
    `$logDir = Split-Path -Path '${psSingleQuote(logFile)}' -Parent`,
    'if ($logDir) { New-Item -Path $logDir -ItemType Directory -Force | Out-Null }',
    `$si = ([wmiclass]'Win32_ProcessStartup').CreateInstance()`,
    startupAssign,
    `$created = ([wmiclass]'Win32_Process').Create('${psSingleQuote(cmdLine)}', '${psSingleQuote(cwd)}', $si)`,
    'if ($created.ReturnValue -ne 0) { Write-Error ("Win32_Process Create failed ReturnValue=" + $created.ReturnValue); exit 1 }',
    `Write-Output ('${LAUNCH_PID_MARKER}' + $created.ProcessId)`,
  ].join('; ');

  return wrapPowerShellEncoded(psScript);
}

function defaultDetachedLaunchExecutor(command: string): { stdout: string; stderr?: string; status?: number } {
  // stdio is explicit here (rather than relying on execSync's default) so the
  // child's stderr is captured only, never inherited into our own stderr --
  // execSync's documented default behaviour is to ALSO stream stderr straight
  // to the parent process' stderr even though it's captured for the thrown
  // error too, which otherwise prints a failing PowerShell script's CLIXML
  // wall of text twice (apra-fleet-i8qj.14).
  const stdout = execSync(command, { encoding: 'utf-8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return { stdout, stderr: '', status: 0 };
}

/**
 * Strip a PowerShell CLIXML envelope (the `#< CLIXML` marker followed by the
 * serialized error-stream `<Objs>`/`<S S="Error">` XML that PowerShell emits
 * whenever an error record crosses a non-interactive stderr) down to just the
 * human-readable message(s) it carries. Returns `raw` unchanged if it does
 * not look like CLIXML.
 */
export function stripCliXmlEnvelope(raw: string): string {
  if (!raw || !raw.includes('#< CLIXML')) return raw;
  const messages: string[] = [];
  const re = /<S S="Error">([\s\S]*?)<\/S>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const decoded = m[1].replace(/_x([0-9A-Fa-f]{4})_/g, (_all, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
    messages.push(decoded);
  }
  if (messages.length === 0) return raw;
  return messages.join('').replace(/\r\n/g, '\n').trim();
}

/**
 * Launch a detached, console-window-free background process on Windows.
 *
 * Returns the created PID on success (see the wrapper-PID note on
 * {@link buildDetachedHiddenLaunchCommand}) or a STRUCTURED failure with the
 * raw PowerShell stderr preserved -- it never throws, so callers can branch and
 * nothing is silently swallowed.
 */
export function launchDetachedHidden(
  opts: DetachedLaunchOptions,
  exec: DetachedLaunchExecutor = defaultDetachedLaunchExecutor,
): DetachedLaunchResult {
  const command = buildDetachedHiddenLaunchCommand(opts);

  let stdout = '';
  let stderr = '';
  let status = 0;
  try {
    const res = exec(command);
    stdout = res.stdout ?? '';
    stderr = res.stderr ?? '';
    status = res.status ?? 0;
  } catch (err) {
    const e = err as { stdout?: string | Buffer; stderr?: string | Buffer; status?: number; message?: string };
    stdout = e.stdout ? e.stdout.toString() : '';
    stderr = e.stderr ? e.stderr.toString() : (e.message ?? String(err));
    status = e.status ?? 1;
    if (status === 0) status = 1;
  }

  if (status !== 0) {
    const cleanStderr = stripCliXmlEnvelope(stderr);
    const detail = cleanStderr ? `: ${cleanStderr}` : '';
    return {
      ok: false,
      error: `hidden launch failed with exit code ${status}${detail}`,
      stderr: cleanStderr,
      returnValue: parseCreateReturnValue(stderr),
      command,
    };
  }

  const match = new RegExp(`${LAUNCH_PID_MARKER}\\s*(\\d+)`).exec(stdout);
  const pid = match ? Number(match[1]) : NaN;
  if (!match || !Number.isFinite(pid) || pid <= 0) {
    const cleanStderr = stripCliXmlEnvelope(stderr || stdout);
    return {
      ok: false,
      error: 'hidden launch produced no usable PID',
      stderr: cleanStderr,
      returnValue: parseCreateReturnValue(stderr),
      command,
    };
  }

  return { ok: true, pid, command };
}

/** Pull Win32_Process Create's ReturnValue out of stderr (2=access denied, 9=path not found, 21=invalid parameter). */
function parseCreateReturnValue(stderr: string): number | undefined {
  const m = /ReturnValue=(\d+)/.exec(stderr ?? '');
  return m ? Number(m[1]) : undefined;
}

const CLI_PATH = '$env:Path = "$env:USERPROFILE\\.local\\bin;$env:Path"; \'ANTIGRAVITY_SOURCE_METADATA\',\'GEMINI_SOURCE_METADATA\',\'CLAUDE_SOURCE_METADATA\',\'COPILOT_SOURCE_METADATA\',\'CODEX_SOURCE_METADATA\' | ForEach-Object { Remove-Item "env:$_" -ErrorAction SilentlyContinue }; ';

/**
 * Wrap PowerShell setup commands and a CLI invocation with PID capture.
 * Uses ProcessStartInfo with UseShellExecute=$false so the child process inherits
 * the parent's file handles (including the stdout pipe fleet's Node.js set up).
 * This works in both interactive and headless (GitHub Actions) environments.
 */
const MEMINFO_CMD = [
  'Add-Type -TypeDefinition \'using System;using System.Runtime.InteropServices;public class MI{[DllImport("kernel32.dll")]public static extern bool GlobalMemoryStatusEx(ref MS m);[StructLayout(LayoutKind.Sequential)]public struct MS{public uint dwLength;public uint dwMemoryLoad;public ulong ullTotalPhys;public ulong ullAvailPhys;public ulong ullTotalPageFile;public ulong ullAvailPageFile;public ulong ullTotalVirtual;public ulong ullAvailVirtual;public ulong ullAvailExtendedVirtual;}}\'',
  '$m=New-Object MI+MS',
  '$m.dwLength=[uint32][Runtime.InteropServices.Marshal]::SizeOf($m)',
  '[void][MI]::GlobalMemoryStatusEx([ref]$m)',
].join('; ');

export class WindowsCommands implements OsCommands {
  private cachedEnv: Record<string, string> | null = null;

  private getCleanEnv(): Record<string, string> {
    if (this.cachedEnv) return this.cachedEnv;
    // Session-level vars Windows creates at login but doesn't store in registry
    const sessionVars = [
      'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'COMPUTERNAME',
      'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'PUBLIC', 'ALLUSERSPROFILE',
      'SystemRoot', 'SystemDrive',
      'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
      'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432',
    ];
    const sessionBlock = sessionVars
      .map(v => `$v=[Environment]::GetEnvironmentVariable('${v}','Process');if($v){$a['${v}']=$v}`)
      .join(';');
    const script = [
      "$m=[Environment]::GetEnvironmentVariables('Machine')",
      "$u=[Environment]::GetEnvironmentVariables('User')",
      '$a=@{}',
      'foreach($k in $m.Keys){$a[$k]=$m[$k]}',
      "foreach($k in $u.Keys){if($k -ieq 'Path' -and $a.ContainsKey('Path')){$a['Path']=$a['Path']+';'+$u[$k]}else{$a[$k]=$u[$k]}}",
      sessionBlock,
      '$a|ConvertTo-Json -Compress',
    ].join('; ');
    const result = execSync(script, { encoding: 'utf-8', shell: 'powershell.exe', windowsHide: true });
    this.cachedEnv = JSON.parse(result.trim());
    return this.cachedEnv!;
  }

  // --- Resources ---

  cpuLoad(): string {
    return MEMINFO_CMD + '; Write-Output ("cpu:" + $m.dwMemoryLoad + "%")';
  }

  memory(): string {
    return MEMINFO_CMD + '; Write-Output ([math]::Round(($m.ullTotalPhys - $m.ullAvailPhys)/1MB).ToString() + " MB / " + [math]::Round($m.ullTotalPhys/1MB).ToString() + " MB")';
  }

  disk(folder: string): string {
    const drive = escapeWindowsArg(folder.charAt(0));
    return `$d=[System.IO.DriveInfo]::new('${drive}'); $d.Name + ' ' + [math]::Round($d.AvailableFreeSpace/1GB).ToString() + 'GB free / ' + [math]::Round($d.TotalSize/1GB).ToString() + 'GB'`;
  }

  // --- Process check ---

  fleetProcessCheck(folder: string, sessionId?: string, processName?: string): string {
    const pname = processName ?? 'claude';
    const escapedFolder = escapeWindowsArg(folder.replace(/\\/g, '\\\\'));
    const sessionFilter = sessionId ? ` -or $_.CommandLine -match '${escapeWindowsArg(sanitizeSessionId(sessionId))}'` : '';
    return [
      `$procs = Get-Process ${pname} -ErrorAction SilentlyContinue`,
      `if (-not $procs) { echo 'idle' }`,
      `elseif ($procs | Where-Object { $_.CommandLine -match '${escapedFolder}'${sessionFilter} }) { echo 'fleet-busy' }`,
      `else { echo 'other-busy' }`,
    ].join('; ');
  }

  // --- Generic agent CLI ---

  agentCommand(provider: ProviderAdapter, args: string): string {
    return `${CLI_PATH}${provider.cliCommand(args)}`;
  }

  agentVersion(provider: ProviderAdapter): string {
    return `${CLI_PATH}${provider.versionCommand()}`;
  }

  installAgent(provider: ProviderAdapter): string {
    return provider.installCommand('windows');
  }

  updateAgent(provider: ProviderAdapter): string {
    return `${CLI_PATH}${provider.updateCommand()}`;
  }

  buildAgentPromptCommand(provider: ProviderAdapter, opts: PromptOptions): string {
    const { folder, promptFile, sessionId, resuming, unattended, model, maxTurns, inv, agentName } = opts;
    const escapedFolder = escapeWindowsArg(folder);
    let instruction = `Your task is described in ${promptFile} in the current directory. Read that file first, then execute the task.`;
    if (inv) {
      instruction = `[${inv}] ${instruction}`;
    }
    // Gemini activates a subagent via @<name> prepended to the prompt on EVERY dispatch.
    if (agentName && provider.name === 'gemini') {
      instruction = `@${agentName} ${instruction}`;
    }

    // Setup: working directory + PATH so the CLI executable is resolvable
    const setupCmd = `Set-Location "${escapedFolder}"; ${CLI_PATH}`;

    // Executable extracted from provider (e.g. "claude" from "claude <args>")
    const filePath = provider.cliCommand('').trim();

    // Build argument list (everything that follows the executable)
    let argList = `${provider.headlessInvocation(instruction)} ${provider.jsonOutputFlag()}`;
    // Claude and AGY activate a subagent via --agent <name> flag.
    if (agentName && (provider.name === 'claude' || provider.name === 'agy')) {
      argList = `--agent "${escapeWindowsArg(agentName)}" ${argList}`;
    }
    if (provider.supportsMaxTurns()) {
      argList += ` --max-turns ${maxTurns ?? 50}`;
    }
    if (sessionId && provider.supportsResume()) {
      const rf = provider.resumeFlag(sessionId, resuming);
      if (rf) argList += ` ${rf}`;
    }
    if (unattended === 'auto') {
      const autoFlag = provider.permissionModeAutoFlag();
      if (autoFlag) argList += ` ${autoFlag}`;
    } else if (unattended === 'dangerous') {
      argList += ` ${provider.skipPermissionsFlag()}`;
    } else {
      // apra-fleet-eft.65.1: interactive-session parity for the work folder --
      // grant Edit/Write of a brand-new file in the dispatched agent's own work
      // folder without the broad --dangerously-skip-permissions bypass. Providers
      // without such a surgical flag omit the method, leaving behavior unchanged.
      const editFlag = provider.workspaceEditPermissionFlag?.();
      if (editFlag) argList += ` ${editFlag}`;
    }
    if (model) {
      argList += ` ${provider.modelFlag(escapeWindowsArg(model))}`;
    }

    return provider.wrapWindowsPrompt(setupCmd, filePath, argList, sessionId, model, opts.tier);
  }

  // --- Filesystem ---

  mkdir(folder: string): string {
    return `New-Item -Path "${escapeWindowsArg(folder)}" -ItemType Directory -Force | Out-Null`;
  }

  readTextFile(destPath: string): string {
    return `Get-Content -Path "${escapeWindowsArg(destPath)}" -Raw`;
  }

  writeTextFile(destPath: string, content: string): string {
    const psScript = `$d='${content.replace(/'/g, "''")}'; $p="${escapeWindowsArg(destPath)}"; New-Item -Path (Split-Path -Path $p -Parent) -ItemType Directory -Force | Out-Null; Set-Content -Path $p -Value $d -NoNewline`;
    return wrapPowerShellEncoded(psScript);
  }

  readRemoteJson(destPath: string): string {
    const escapedPath = escapeWindowsArg(destPath);
    return `if (Test-Path "${escapedPath}") { Get-Content -Path "${escapedPath}" -Raw } else { echo '{}' }`;
  }

  deepMergeJson(destPath: string, newObj: Record<string, unknown>): string {
    const escapedPath = escapeWindowsArg(destPath);
    const newJson = JSON.stringify(newObj).replace(/'/g, "''");

    const psScript = `
$p = '${escapedPath}';
$new = '${newJson}' | ConvertFrom-Json;
$current = @{};
if (Test-Path $p) {
  try { $current = Get-Content -Path $p -Raw | ConvertFrom-Json -ErrorAction Stop } catch {}
}
$merged = @{};
if ($current) {
  $current.psobject.properties | ForEach-Object { $merged[$_.Name] = $_.Value }
}
function Merge-Objects($target, $source) {
    $source.psobject.properties | ForEach-Object {
        $key = $_.Name;
        $value = $_.Value;
        if ($target.Contains($key) -and $target[$key] -is [System.Management.Automation.PSCustomObject] -and $value -is [System.Management.Automation.PSCustomObject]) {
            Merge-Objects $target[$key] $value;
        } else {
            $target[$key] = $value;
        }
    }
}
Merge-Objects $merged $new;
New-Item -Path (Split-Path -Path $p -Parent) -ItemType Directory -Force | Out-Null;
$merged | ConvertTo-Json -Depth 99 | Set-Content -Path $p -NoNewline;
    `.trim().replace(/\\r\\n/g, ' ');

    return wrapPowerShellEncoded(psScript);
  }

  // --- Auth ---

  credentialFileCheck(destPath: string): string {
    return `if (Test-Path "${escapeWindowsArg(destPath)}") { echo "found" } else { echo "missing" }`;
  }

  credentialFileWrite(content: string, destPath: string): string {
    const psScript = `$d='${content.replace(/'/g, "''")}'; $p="${escapeWindowsArg(destPath)}"; New-Item -Path (Split-Path -Path $p -Parent) -ItemType Directory -Force | Out-Null; Set-Content -Path $p -Value $d -NoNewline`;
    return wrapPowerShellEncoded(psScript);
  }

  credentialFileRemove(destPath: string): string {
    return `Remove-Item "${escapeWindowsArg(destPath)}" -Force -ErrorAction SilentlyContinue`;
  }

  apiKeyCheck(envVarName?: string): string {
    const varName = envVarName ?? 'ANTHROPIC_API_KEY';
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(varName)) throw new Error('Invalid env var name: ' + varName);
    return `if ($env:${varName}) { $env:${varName}.Substring(0,10) } else { echo "" }`;
  }

  setEnv(name: string, value: string): string[] {
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(name)) throw new Error('Invalid env var name: ' + name);
    const escaped = value.replace(/'/g, "''");
    return [`[Environment]::SetEnvironmentVariable('${name}', '${escaped}', 'User')`];
  }

  unsetEnv(name: string): string[] {
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(name)) throw new Error('Invalid env var name: ' + name);
    return [`[Environment]::SetEnvironmentVariable('${name}', $null, 'User')`];
  }

  envPrefix(name: string, value: string): string {
    const escaped = value.replace(/'/g, "''");
    return `$env:${name}='${escaped}';`;
  }

  // --- Git credential helper ---

  gitCredentialHelperWrite(host: string, username: string, token: string, label?: string, scopeUrl?: string): string {
    const escapedHost = escapeWindowsArg(host).replace(/'/g, "''");
    const escapedUser = escapeWindowsArg(username).replace(/'/g, "''");
    const batchToken = escapeBatchMetachars(token);
    const escapedToken = batchToken.replace(/'/g, "''");
    const credFileName = label ? `.fleet-git-credential-${escapeWindowsArg(label).replace(/'/g, "''")}` : '.fleet-git-credential';
    // scope_url is passed through escapeWindowsArg (single-quote escaped) and embedded in a single-quoted git config arg — safe against injection.
    const credUrl = scopeUrl ? escapeWindowsArg(scopeUrl).replace(/'/g, "''") : `https://${escapedHost}`;
    return [
      `$script = ('@echo off','echo protocol=https','echo host=${escapedHost}','echo username=${escapedUser}','echo password=${escapedToken}') -join [Environment]::NewLine`,
      `Set-Content -Path "$env:USERPROFILE\\${credFileName}.bat" -Value $script -NoNewline`,
      `$gcFile = "$env:USERPROFILE\\${credFileName}.bat"; $u = $env:USERNAME; icacls $gcFile /inheritance:r /grant:r "\${u}:F"`,
      `git config --global --replace-all 'credential.${credUrl}.helper' ''`,
      `$helperPath = "$env:USERPROFILE\\${credFileName}.bat" -replace '\\\\','/'; git config --global --add 'credential.${credUrl}.helper' $helperPath`,
    ].join('; ');
  }

  gitCredentialHelperRemove(host: string, label?: string, scopeUrl?: string): string {
    const escapedHost = escapeWindowsArg(host).replace(/'/g, "''");
    const credFileName = label ? `.fleet-git-credential-${escapeWindowsArg(label).replace(/'/g, "''")}` : '.fleet-git-credential';
    // scope_url is passed through escapeWindowsArg (single-quote escaped) and embedded in a single-quoted git config arg — safe against injection.
    const credUrl = scopeUrl ? escapeWindowsArg(scopeUrl).replace(/'/g, "''") : `https://${escapedHost}`;
    return `Remove-Item "$env:USERPROFILE\\${credFileName}.bat" -Force -ErrorAction SilentlyContinue; git config --global --unset-all 'credential.${credUrl}.helper' 2>$null`;
  }

  // --- SSH key deployment ---

  deploySSHPublicKey(publicKeyLine: string): string[] {
    const escaped = publicKeyLine.replace(/'/g, "''");
    return [
      // Deploy to user's authorized_keys (force UTF-8 no BOM — OpenSSH requires it)
      'New-Item -Path "$env:USERPROFILE\\.ssh" -ItemType Directory -Force | Out-Null',
      `[System.IO.File]::AppendAllText("$env:USERPROFILE\\.ssh\\authorized_keys", '${escaped}' + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))`,
      '$akFile = "$env:USERPROFILE\\.ssh\\authorized_keys"; $u = $env:USERNAME; icacls $akFile /inheritance:r /grant:r "${u}:F"',
      // Windows OpenSSH ignores ~/.ssh/authorized_keys for admin users —
      // sshd_config: Match Group administrators → AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys
      // Only attempt if user is in Administrators group (non-admins can't write to ProgramData\ssh).
      `$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); if ($isAdmin) { $adminKeys = "$env:ProgramData\\ssh\\administrators_authorized_keys"; if (!(Test-Path $adminKeys)) { New-Item -Path $adminKeys -ItemType File -Force | Out-Null }; [System.IO.File]::AppendAllText($adminKeys, '${escaped}' + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false)); icacls $adminKeys /inheritance:r /grant:r "SYSTEM:F" /grant:r "Administrators:F" }`,
    ];
  }

  // --- Local exec ---

  cleanExec(command: string): { command: string; env?: Record<string, string>; shell?: string } {
    return { command, env: this.getCleanEnv(), shell: 'powershell.exe' };
  }

  // --- Shell ---

  wrapInWorkFolder(folder: string, command: string): string {
    return `Set-Location "${escapeWindowsArg(folder)}"; ${command}`;
  }

  wrapPidCapture(command: string): string {
    return `Write-Output "FLEET_PID:$pid"; ${command}`;
  }

  // --- Git ---

  gitCurrentBranch(folder: string): string {
    return `try { git -C "${escapeWindowsArg(folder)}" branch --show-current 2>$null } catch {}`;
  }

  // --- Process management ---

  killPid(pid: number): string {
    return `taskkill /F /T /PID ${pid}`;
  }

  // --- GPU activity ---

  gpuProcessCheck(): string {
    // Windows fleet members don't use nvidia-smi — signal not available (exit 1).
    return 'exit 1';
  }

  gpuUtilization(): string {
    return 'Write-Output "0"';
  }

  // --- Resource output parsing ---

  parseMemory(stdout: string): string {
    return stdout.trim().substring(0, 200);
  }

  parseDisk(stdout: string): string {
    return stdout.trim().substring(0, 200);
  }

  // --- Agent provisioning ---

  hashFilesRecursive(dir: string): string {
    const winDir = dir.replace(/\//g, '\\').replace(/'/g, "''");
    const psScript = `$b = Join-Path $HOME '${winDir}'; if (Test-Path $b) { Get-ChildItem -Path $b -Recurse -File | ForEach-Object { $h = (Get-FileHash -Path $_.FullName -Algorithm SHA256).Hash.ToLower(); $r = $_.FullName.Substring($b.Length + 1).Replace('\\', '/'); "$h  ./$r" } }`;
    return wrapPowerShellEncoded(psScript);
  }
}