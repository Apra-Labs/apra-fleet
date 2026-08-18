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
    // Claude and AGY activate a subagent via --agent <name> flag.
    const nameFlag = agentName ? provider.agentNameFlag(agentName) : '';
    if (nameFlag.startsWith('@')) {
      instruction = `${nameFlag}${instruction}`;
    }

    // Setup: working directory + PATH so the CLI executable is resolvable
    const setupCmd = `Set-Location "${escapedFolder}"; ${CLI_PATH}`;

    // Executable extracted from provider (e.g. "claude" from "claude <args>")
    const filePath = provider.cliCommand('').trim();

    // Build argument list (everything that follows the executable)
    let argList = `${provider.headlessInvocation(instruction)} ${provider.jsonOutputFlag()}`;
    if (nameFlag && !nameFlag.startsWith('@')) {
      argList = `${nameFlag} ${argList}`;
    }
    if (provider.supportsMaxTurns()) {
      argList += ` --max-turns ${maxTurns ?? 50}`;
    }
    if (sessionId && provider.supportsResume()) {
      const rf = provider.resumeFlag(sessionId, resuming);
      if (rf) argList += ` ${rf}`;
    }
    // Delegate unattended-mode flag resolution entirely to the provider --
    // each provider's own auto/dangerous fallback and warning semantics (e.g.
    // AGY has no true auto and falls back to its dangerous flag; OpenCode has
    // no true dangerous and falls back to --auto) must not be re-derived here,
    // or this path silently diverges from the POSIX buildPromptCommand() path.
    const permFlag = provider.resolvePermissionFlag(unattended);
    if (permFlag) argList += ` ${permFlag}`;
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