import { z } from 'zod';
import { getAgent } from '../services/registry.js';
import { testConnection, execCommand } from '../services/ssh.js';
import { getClaudeVersionCommand, getCpuLoadCommand, getMemoryCommand, getDiskCommand } from '../utils/platform.js';

export const agentDetailSchema = z.object({
  agent_id: z.string().describe('The UUID of the agent to inspect'),
});

export type AgentDetailInput = z.infer<typeof agentDetailSchema>;

export async function agentDetail(input: AgentDetailInput): Promise<string> {
  const agent = getAgent(input.agent_id);
  if (!agent) {
    return `Agent "${input.agent_id}" not found.`;
  }

  const os = agent.os ?? 'linux';
  let report = `Agent: ${agent.friendlyName} (${agent.id})\n`;
  report += `Host: ${agent.host}:${agent.port} (${os})\n`;
  report += `Folder: ${agent.remoteFolder}\n\n`;

  // -- Connectivity --
  report += `── Connectivity ──\n`;
  const conn = await testConnection(agent);
  if (conn.ok) {
    report += `  SSH: Connected (latency: ${conn.latencyMs}ms)\n`;
    report += `  Auth: ${agent.authType}${agent.keyPath ? ` (${agent.keyPath})` : ''}\n`;
  } else {
    report += `  SSH: FAILED — ${conn.error}\n`;
    report += `  Auth: ${agent.authType}\n`;
    report += `\n⚠️ Cannot retrieve further details — agent is offline.\n`;
    return report;
  }

  // -- Claude CLI --
  report += `\n── Claude CLI ──\n`;
  try {
    const versionResult = await execCommand(agent, getClaudeVersionCommand(os as any), 10000);
    report += `  Version: ${versionResult.stdout.trim()}\n`;
  } catch {
    report += `  Version: unknown (could not run claude --version)\n`;
  }

  // Check auth status
  try {
    let tokenCheckCmd: string;
    if (os === 'windows') {
      tokenCheckCmd = 'echo %CLAUDE_CODE_OAUTH_TOKEN:~0,10%';
    } else {
      tokenCheckCmd = 'echo "${CLAUDE_CODE_OAUTH_TOKEN:0:10}"';
    }
    const tokenResult = await execCommand(agent, tokenCheckCmd, 10000);
    const hasToken = tokenResult.stdout.trim().length > 5;
    report += `  Auth: ${hasToken ? 'OAuth token present' : 'No OAuth token detected'}\n`;
  } catch {
    report += `  Auth: unknown\n`;
  }

  // -- Session --
  report += `\n── Session ──\n`;
  report += `  Session ID: ${agent.sessionId ?? '(none)'}\n`;
  report += `  Last activity: ${agent.lastUsed ?? 'never'}\n`;

  if (agent.sessionId) {
    try {
      const busyCmd = os === 'windows'
        ? `tasklist /FI "IMAGENAME eq claude.exe" /NH`
        : `pgrep -af "claude.*${agent.sessionId}" 2>/dev/null || echo "idle"`;
      const busyResult = await execCommand(agent, busyCmd, 10000);
      const isBusy = os === 'windows'
        ? busyResult.stdout.toLowerCase().includes('claude')
        : !busyResult.stdout.trim().includes('idle');
      report += `  Status: ${isBusy ? 'BUSY (Claude is running)' : 'idle'}\n`;
    } catch {
      report += `  Status: unknown\n`;
    }
  } else {
    report += `  Status: no active session\n`;
  }

  // -- System Resources --
  report += `\n── System Resources ──\n`;

  // CPU
  try {
    const cpuResult = await execCommand(agent, getCpuLoadCommand(os as any), 10000);
    report += `  CPU: ${cpuResult.stdout.trim()}\n`;
  } catch {
    report += `  CPU: unavailable\n`;
  }

  // Memory
  try {
    const memResult = await execCommand(agent, getMemoryCommand(os as any), 10000);
    const memLines = memResult.stdout.trim().split('\n');
    if (os === 'linux') {
      // Parse free -m output
      const memLine = memLines.find(l => l.startsWith('Mem:'));
      if (memLine) {
        const parts = memLine.split(/\s+/);
        const total = parts[1];
        const used = parts[2];
        report += `  Memory: ${used} MB / ${total} MB\n`;
      } else {
        report += `  Memory: ${memResult.stdout.trim()}\n`;
      }
    } else {
      report += `  Memory: ${memResult.stdout.trim().substring(0, 200)}\n`;
    }
  } catch {
    report += `  Memory: unavailable\n`;
  }

  // Disk
  try {
    const diskResult = await execCommand(agent, getDiskCommand(os as any, agent.remoteFolder), 10000);
    const diskLines = diskResult.stdout.trim().split('\n');
    if (os !== 'windows' && diskLines.length >= 2) {
      report += `  Disk: ${diskLines[1].trim()}\n`;
    } else {
      report += `  Disk: ${diskResult.stdout.trim().substring(0, 200)}\n`;
    }
  } catch {
    report += `  Disk: unavailable\n`;
  }

  return report;
}
