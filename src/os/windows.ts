import { execSync } from 'node:child_process';
import type { OsCommands } from './os-commands.js';
import { escapeWindowsArg, sanitizeSessionId } from './os-commands.js';

const CLAUDE_PATH = '$env:Path = "$env:USERPROFILE\\.local\\bin;$env:Path"; ';

// kernel32 GlobalMemoryStatusEx — works without admin, no WMI needed
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
    const result = execSync(script, { encoding: 'utf-8', shell: 'powershell.exe' });
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

  fleetProcessCheck(folder: string, sessionId?: string): string {
    const escapedFolder = escapeWindowsArg(folder.replace(/\\/g, '\\\\'));
    const sessionFilter = sessionId ? ` -or $_.CommandLine -match '${escapeWindowsArg(sanitizeSessionId(sessionId))}'` : '';
    return [
      `$procs = Get-Process claude -ErrorAction SilentlyContinue`,
      `if (-not $procs) { echo 'idle' }`,
      `elseif ($procs | Where-Object { $_.CommandLine -match '${escapedFolder}'${sessionFilter} }) { echo 'fleet-busy' }`,
      `else { echo 'other-busy' }`,
    ].join('; ');
  }

  // --- Claude CLI ---

  claudeCommand(args: string): string {
    return `${CLAUDE_PATH}claude ${args}`;
  }

  claudeVersion(): string {
    return this.claudeCommand('--version 2>&1');
  }

  claudeCheck(): string {
    return 'Get-Command claude -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source';
  }

  installClaude(): string {
    return 'irm https://claude.ai/install.ps1 | iex';
  }

  updateClaude(): string {
    return this.claudeCommand('update');
  }

  // --- Filesystem ---

  mkdir(folder: string): string {
    return `New-Item -Path "${escapeWindowsArg(folder)}" -ItemType Directory -Force | Out-Null`;
  }

  // --- Auth ---

  credentialFileCheck(): string {
    return 'if (Test-Path "$env:USERPROFILE\\.claude\\.credentials.json") { echo "found" } else { echo "missing" }';
  }

  credentialFileWrite(json: string): string {
    const psScript = `$d='${json.replace(/'/g, "''")}'; New-Item -Path "$env:USERPROFILE\\.claude" -ItemType Directory -Force | Out-Null; Set-Content -Path "$env:USERPROFILE\\.claude\\.credentials.json" -Value $d -NoNewline`;
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    return `powershell -EncodedCommand ${encoded}`;
  }

  credentialFileRemove(): string {
    return 'Remove-Item "$env:USERPROFILE\\.claude\\.credentials.json" -Force -ErrorAction SilentlyContinue';
  }

  apiKeyCheck(): string {
    return 'if ($env:ANTHROPIC_API_KEY) { $env:ANTHROPIC_API_KEY.Substring(0,10) } else { echo "" }';
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

  gitCredentialHelperWrite(host: string, username: string, token: string): string {
    const escaped = token.replace(/'/g, "''");
    return [
      `$script = @'`,
      `@echo off`,
      `echo protocol=https`,
      `echo host=${host}`,
      `echo username=${username}`,
      `echo password=${escaped}`,
      `'@`,
      `Set-Content -Path "$env:USERPROFILE\\.fleet-git-credential.bat" -Value $script -NoNewline`,
      `git config --global credential.helper "$env:USERPROFILE\\.fleet-git-credential.bat"`,
    ].join('; ');
  }

  gitCredentialHelperRemove(): string {
    return 'Remove-Item "$env:USERPROFILE\\.fleet-git-credential.bat" -Force -ErrorAction SilentlyContinue; git config --global --unset credential.helper 2>$null';
  }

  // --- SSH key deployment ---

  deploySSHPublicKey(publicKeyLine: string): string[] {
    const escaped = publicKeyLine.replace(/'/g, "''");
    return [
      'New-Item -Path "$env:USERPROFILE\\.ssh" -ItemType Directory -Force | Out-Null',
      `Add-Content -Path "$env:USERPROFILE\\.ssh\\authorized_keys" -Value '${escaped}'`,
      'icacls "$env:USERPROFILE\\.ssh\\authorized_keys" /inheritance:r /grant:r "$env:USERNAME:F"',
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

  // --- Prompt building ---

  buildPromptCommand(folder: string, b64Prompt: string, sessionId?: string, dangerouslySkipPermissions?: boolean, model?: string): string {
    const escapedFolder = escapeWindowsArg(folder);
    let resume = '';
    if (sessionId) {
      resume = ` --resume "${sanitizeSessionId(sessionId)}"`;
    }
    const skipPerms = dangerouslySkipPermissions ? ' --dangerously-skip-permissions' : '';
    const modelFlag = model ? ` --model "${escapeWindowsArg(model)}"` : '';
    return `Set-Location "${escapedFolder}"; $p=[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64Prompt}')); ${CLAUDE_PATH}claude -p $p --output-format json --max-turns 50${resume}${skipPerms}${modelFlag}`;
  }

  // --- Resource output parsing ---

  parseMemory(stdout: string): string {
    return stdout.trim().substring(0, 200);
  }

  parseDisk(stdout: string): string {
    return stdout.trim().substring(0, 200);
  }
}
