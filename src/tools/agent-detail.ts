import { z } from 'zod';
import { getStrategy } from '../services/strategy.js';
import { getClaudeVersionCommand, getCpuLoadCommand, getMemoryCommand, getDiskCommand, getFleetProcessCheckCommand } from '../utils/platform.js';
import { getAgentOrFail, getAgentOS } from '../utils/agent-helpers.js';
import type { Agent } from '../types.js';

export const agentDetailSchema = z.object({
  agent_id: z.string().describe('The UUID of the agent to inspect'),
});

export type AgentDetailInput = z.infer<typeof agentDetailSchema>;

export async function agentDetail(input: AgentDetailInput): Promise<string> {
  const agentOrError = getAgentOrFail(input.agent_id);
  if (typeof agentOrError === 'string') return agentOrError;
  const agent = agentOrError as Agent;

  const os = getAgentOS(agent);
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
    const versionResult = await strategy.execCommand(getClaudeVersionCommand(os), 10000);
    report += `  Version: ${versionResult.stdout.trim()}\n`;
  } catch {
    report += `  Version: unknown (could not run claude --version)\n`;
  }

  // Check auth status — look for credentials file, OAuth token, and API key
  const authMethods: string[] = [];
  try {
    const credCheckCmd = os === 'windows'
      ? 'if exist "%USERPROFILE%\\.claude\\.credentials.json" (echo found) else (echo missing)'
      : 'test -f ~/.claude/.credentials.json && echo found || echo missing';
    const credResult = await strategy.execCommand(credCheckCmd, 10000);
    if (credResult.stdout.trim() === 'found') {
      authMethods.push('OAuth credentials file');
    }
  } catch { /* ignore */ }

  try {
    const apiKeyCheckCmd = os === 'windows'
      ? 'echo %ANTHROPIC_API_KEY:~0,10%'
      : 'bash -l -c \'echo "${ANTHROPIC_API_KEY:0:10}"\'';
    const apiKeyResult = await strategy.execCommand(apiKeyCheckCmd, 10000);
    if (apiKeyResult.stdout.trim().length > 5) {
      authMethods.push('API key (env)');
    }
  } catch { /* ignore */ }

  if (authMethods.length > 0) {
    report += `  Auth: ${authMethods.join(', ')}\n`;
  } else {
    report += `  Auth: No authentication detected\n`;
  }

  // -- Session --
  report += `\n── Session ──\n`;
  report += `  Session ID: ${agent.sessionId ?? '(none)'}\n`;
  report += `  Last activity: ${agent.lastUsed ?? 'never'}\n`;

  try {
    const busyCheck = await strategy.execCommand(
      getFleetProcessCheckCommand(os, agent.remoteFolder, agent.sessionId),
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
    const cpuResult = await strategy.execCommand(getCpuLoadCommand(os), 10000);
    report += `  CPU: ${cpuResult.stdout.trim()}\n`;
  } catch {
    report += `  CPU: unavailable\n`;
  }

  // Memory
  try {
    const memResult = await strategy.execCommand(getMemoryCommand(os), 10000);
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
    const diskResult = await strategy.execCommand(getDiskCommand(os, agent.remoteFolder), 10000);
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
