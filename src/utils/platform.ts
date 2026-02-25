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

/**
 * Generate a command that checks whether a Claude process is running
 * for a specific fleet agent. Returns multi-line output:
 *   - "fleet-busy" if a Claude process is found working in the agent's folder or session
 *   - "other-busy" if Claude processes exist but none match the agent's folder/session
 *   - "idle" if no Claude processes are running at all
 */
export function getFleetProcessCheckCommand(os: RemoteOS, folder: string, sessionId?: string): string {
  if (os === 'windows') {
    // Windows: check tasklist for claude.exe, then use wmic to inspect command lines
    // wmic gives us the full command line so we can match the folder
    const escapedFolder = folder.replace(/\\/g, '\\\\');
    const folderMatch = `findstr /i /c:"${escapedFolder}"`;
    const sessionMatch = sessionId ? ` | findstr /c:"${sessionId}"` : '';
    return [
      `wmic process where "name='claude.exe'" get CommandLine /format:list 2>nul`,
      `| ${folderMatch}${sessionMatch} >nul 2>nul`,
      `&& echo fleet-busy`,
      `|| (tasklist /FI "IMAGENAME eq claude.exe" /NH 2>nul | findstr /i "claude" >nul && echo other-busy || echo idle)`,
    ].join(' ');
  }

  // Unix (Linux/macOS): use ps to get full command lines of claude processes,
  // then grep for the agent's folder or session ID
  const folderPattern = folder.replace(/"/g, '\\"');
  const fleetMatch = sessionId
    ? `grep -E "(${folderPattern}|${sessionId})"`
    : `grep "${folderPattern}"`;

  return `CLAUDE_PIDS=$(pgrep -f "claude" 2>/dev/null); `
    + `if [ -z "$CLAUDE_PIDS" ]; then echo "idle"; `
    + `else CMDLINES=$(ps -o args= -p $CLAUDE_PIDS 2>/dev/null); `
    + `if echo "$CMDLINES" | ${fleetMatch} > /dev/null 2>&1; then echo "fleet-busy"; `
    + `else echo "other-busy"; fi; fi`;
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

export function getUnsetEnvCommand(os: RemoteOS, name: string): string[] {
  switch (os) {
    case 'linux':
      return [
        `sed -i '/export ${name}=/d' ~/.bashrc 2>/dev/null || true`,
        `sed -i '/export ${name}=/d' ~/.profile 2>/dev/null || true`,
        `unset ${name}`,
      ];
    case 'macos':
      return [
        `sed -i '' '/export ${name}=/d' ~/.bashrc 2>/dev/null || true`,
        `sed -i '' '/export ${name}=/d' ~/.zshrc 2>/dev/null || true`,
        `sed -i '' '/export ${name}=/d' ~/.profile 2>/dev/null || true`,
        `unset ${name}`,
      ];
    case 'windows':
      return [`reg delete "HKCU\\Environment" /v ${name} /f 2>nul & setx ${name} ""`];
  }
}

export function getUpdateClaudeCommand(os: RemoteOS): string {
  return 'claude update || npm update -g @anthropic-ai/claude-code';
}
