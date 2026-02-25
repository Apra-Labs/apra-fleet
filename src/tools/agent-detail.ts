import { z } from 'zod';
import { getAgent } from '../services/registry.js';
import { getStrategy } from '../services/strategy.js';
import { getClaudeVersionCommand, getCpuLoadCommand, getMemoryCommand, getDiskCommand, getFleetProcessCheckCommand } from '../utils/platform.js';

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
  const isLocal = agent.agentType === 'local';
  const strategy = getStrategy(agent);

  let report = `Agent: ${agent.friendlyName} (${agent.id})\n`;
  report += `Type: ${agent.agentType}\n`;
  if (!isLocal) {
    report += `Host: ${agent.host}:${agent.port} (${os})\n`;
  } else {
    report += `OS: ${os}\n`;
  }
  report += `Folder: ${agent.remoteFolder}\n\n`;

  // -- Connectivity --
  report += `── Connectivity ──\n`;
  const conn = await strategy.testConnection();
  if (conn.ok) {
    if (isLocal) {
      report += `  Status: Connected (local)\n`;
    } else {
      report += `  SSH: Connected (latency: ${conn.latencyMs}ms)\n`;
      report += `  Auth: ${agent.authType}${agent.keyPath ? ` (${agent.keyPath})` : ''}\n`;
    }
  } else {
    report += `  SSH: FAILED — ${conn.error}\n`;
    report += `  Auth: ${agent.authType}\n`;
    report += `\n⚠️ Cannot retrieve further details — agent is offline.\n`;
    return report;
  }

  // -- Claude CLI --
  report += `\n── Claude CLI ──\n`;
  try {
    const versionResult = await strategy.execCommand(getClaudeVersionCommand(os as any), 10000);
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
    const tokenResult = await strategy.execCommand(tokenCheckCmd, 10000);
    const hasToken = tokenResult.stdout.trim().length > 5;
    report += `  Auth: ${hasToken ? 'OAuth token present' : 'No OAuth token detected'}\n`;
  } catch {
    report += `  Auth: unknown\n`;
  }

  // -- Session --
  report += `\n── Session ──\n`;
  report += `  Session ID: ${agent.sessionId ?? '(none)'}\n`;
  report += `  Last activity: ${agent.lastUsed ?? 'never'}\n`;

  try {
    const busyCheck = await strategy.execCommand(
      getFleetProcessCheckCommand(os as any, agent.remoteFolder, agent.sessionId),
      10000,
    );
    const output = busyCheck.stdout.trim().toLowerCase();
    if (output.includes('fleet-busy')) {
      report += `  Status: BUSY (fleet Claude process running in ${agent.remoteFolder})\n`;
    } else if (output.includes('other-busy')) {
      report += `  Status: idle (Claude processes found but none related to this agent)\n`;
    } else {
      report += `  Status: idle\n`;
    }
  } catch {
    report += `  Status: unknown\n`;
  }

  // -- System Resources --
  report += `\n── System Resources ──\n`;

  // CPU
  try {
    const cpuResult = await strategy.execCommand(getCpuLoadCommand(os as any), 10000);
    report += `  CPU: ${cpuResult.stdout.trim()}\n`;
  } catch {
    report += `  CPU: unavailable\n`;
  }

  // Memory
  try {
    const memResult = await strategy.execCommand(getMemoryCommand(os as any), 10000);
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
    const diskResult = await strategy.execCommand(getDiskCommand(os as any, agent.remoteFolder), 10000);
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
