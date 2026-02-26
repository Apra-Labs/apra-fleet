import type { OsCommands } from './os-commands.js';
import { escapeDoubleQuoted, escapeWindowsArg, sanitizeSessionId } from './os-commands.js';

const CLAUDE_PATH = '$env:Path = "$env:USERPROFILE\\.local\\bin;$env:Path"; ';

// kernel32 GlobalMemoryStatusEx — works without admin, no WMI needed
const MEMINFO_CMD = [
  'Add-Type -TypeDefinition \'using System;using System.Runtime.InteropServices;public class MI{[DllImport("kernel32.dll")]public static extern bool GlobalMemoryStatusEx(ref MS m);[StructLayout(LayoutKind.Sequential)]public struct MS{public uint dwLength;public uint dwMemoryLoad;public ulong ullTotalPhys;public ulong ullAvailPhys;public ulong ullTotalPageFile;public ulong ullAvailPageFile;public ulong ullTotalVirtual;public ulong ullAvailVirtual;public ulong ullAvailExtendedVirtual;}}\'',
  '$m=New-Object MI+MS',
  '$m.dwLength=[uint32][Runtime.InteropServices.Marshal]::SizeOf($m)',
  '[void][MI]::GlobalMemoryStatusEx([ref]$m)',
].join('; ');

export class WindowsCommands implements OsCommands {
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
    return 'where claude 2>nul';
  }

  installClaude(): string {
    return 'powershell -Command "irm https://claude.ai/install.ps1 | iex"';
  }

  updateClaude(): string {
    return this.claudeCommand('update');
  }

  // --- Filesystem ---

  mkdir(folder: string): string {
    return `if not exist "${escapeWindowsArg(folder)}" mkdir "${escapeWindowsArg(folder)}"`;
  }

  scpCheck(): string {
    return 'where scp 2>nul';
  }

  // --- Auth ---

  credentialFileCheck(): string {
    return 'if exist "%USERPROFILE%\\.claude\\.credentials.json" (echo found) else (echo missing)';
  }

  credentialFileWrite(json: string): string {
    const escaped = escapeDoubleQuoted(json).replace(/'/g, "''");
    return `powershell -Command "Set-Content -Path \\"$env:USERPROFILE\\.claude\\.credentials.json\\" -Value '${escaped}' -NoNewline"`;
  }

  credentialFileRemove(): string {
    return 'del "%USERPROFILE%\\.claude\\.credentials.json" 2>nul';
  }

  apiKeyCheck(): string {
    return 'echo %ANTHROPIC_API_KEY:~0,10%';
  }

  setEnv(name: string, value: string): string[] {
    return [`setx ${name} "${escapeWindowsArg(value)}"`];
  }

  unsetEnv(name: string): string[] {
    return [`reg delete "HKCU\\Environment" /v ${name} /f 2>nul & setx ${name} ""`];
  }

  envPrefix(name: string, value: string): string {
    return `set "${name}=${escapeDoubleQuoted(value)}" &&`;
  }

  // --- Shell ---

  shellWrap(command: string): string {
    return `cmd /c "${command}"`;
  }

  // --- Prompt building ---

  buildPromptCommand(folder: string, b64Prompt: string, sessionId?: string): string {
    const escapedFolder = escapeDoubleQuoted(folder);
    const decodeCmd = `powershell -Command "[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64Prompt}'))"`;
    let cmd = `cd "${escapedFolder}" && for /f "delims=" %i in ('${decodeCmd}') do ${this.claudeCommand('-p "%i" --output-format json --max-turns 50')}`;
    if (sessionId) {
      cmd += ` --resume "${sanitizeSessionId(sessionId)}"`;
    }
    return cmd;
  }

  // --- Resource output parsing ---

  parseMemory(stdout: string): string {
    return stdout.trim().substring(0, 200);
  }

  parseDisk(stdout: string): string {
    return stdout.trim().substring(0, 200);
  }
}
