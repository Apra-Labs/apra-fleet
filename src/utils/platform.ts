import type { Agent, SSHExecResult } from '../types.js';

export type RemoteOS = 'windows' | 'macos' | 'linux';

export function detectOS(unameOutput: string, verOutput: string): RemoteOS {
  if (verOutput.toLowerCase().includes('windows') || verOutput.toLowerCase().includes('microsoft')) {
    return 'windows';
  }
  const uname = unameOutput.trim().toLowerCase();
  if (uname === 'darwin') return 'macos';
  return 'linux';
}

export function getShellCommand(os: RemoteOS, command: string): string {
  if (os === 'windows') {
    return `cmd /c "${command}"`;
  }
  return command;
}

export function getCpuLoadCommand(os: RemoteOS): string {
  switch (os) {
    case 'linux': return 'uptime';
    case 'macos': return 'sysctl -n vm.loadavg';
    case 'windows': return 'wmic cpu get loadpercentage /value';
  }
}

export function getMemoryCommand(os: RemoteOS): string {
  switch (os) {
    case 'linux': return 'free -m';
    case 'macos': return 'vm_stat && echo "---" && sysctl -n hw.memsize';
    case 'windows': return 'wmic OS get FreePhysicalMemory,TotalVisibleMemorySize /value';
  }
}

export function getDiskCommand(os: RemoteOS, folder: string): string {
  switch (os) {
    case 'linux':
    case 'macos':
      return `df -h "${folder}"`;
    case 'windows': {
      const drive = folder.charAt(0);
      return `wmic logicaldisk where "caption='${drive}:'" get size,freespace,caption /value`;
    }
  }
}

export function getProcessCheckCommand(os: RemoteOS): string {
  switch (os) {
    case 'linux':
    case 'macos':
      return 'pgrep -f "claude" > /dev/null 2>&1 && echo "busy" || echo "idle"';
    case 'windows':
      return 'tasklist /FI "IMAGENAME eq claude.exe" /NH 2>nul | findstr /i "claude" >nul && echo busy || echo idle';
  }
}

export function getClaudeVersionCommand(os: RemoteOS): string {
  return os === 'windows' ? 'claude --version 2>&1' : 'claude --version 2>&1';
}

export function getClaudeCheckCommand(os: RemoteOS): string {
  return os === 'windows' ? 'where claude 2>nul' : 'which claude 2>/dev/null';
}

export function getScpCheckCommand(os: RemoteOS): string {
  return os === 'windows' ? 'where scp 2>nul' : 'which scp 2>/dev/null';
}

export function getMkdirCommand(os: RemoteOS, folder: string): string {
  if (os === 'windows') {
    return `if not exist "${folder}" mkdir "${folder}"`;
  }
  return `mkdir -p "${folder}"`;
}

export function getSetEnvCommand(os: RemoteOS, name: string, value: string): string[] {
  switch (os) {
    case 'linux':
      return [
        `echo 'export ${name}="${value}"' >> ~/.bashrc`,
        `echo 'export ${name}="${value}"' >> ~/.profile`,
        `export ${name}="${value}"`,
      ];
    case 'macos':
      return [
        `echo 'export ${name}="${value}"' >> ~/.bashrc`,
        `echo 'export ${name}="${value}"' >> ~/.zshrc`,
        `echo 'export ${name}="${value}"' >> ~/.profile`,
        `export ${name}="${value}"`,
      ];
    case 'windows':
      return [`setx ${name} "${value}"`];
  }
}

export function getUpdateClaudeCommand(os: RemoteOS): string {
  return 'claude update || npm update -g @anthropic-ai/claude-code';
}
