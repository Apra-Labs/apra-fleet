import { z } from 'zod';
import { getStrategy } from '../services/strategy.js';
import { getClaudeVersionCommand, getCpuLoadCommand, getMemoryCommand, getDiskCommand, getFleetProcessCheckCommand } from '../utils/platform.js';
import { getAgentOrFail, getAgentOS } from '../utils/agent-helpers.js';
import type { Agent } from '../types.js';

export const agentDetailSchema = z.object({
  agent_id: z.string().describe('The UUID of the agent to inspect'),
  format: z.enum(['compact', 'json']).default('compact').describe('Output format: "compact" (default, few lines) or "json" (structured data for detailed rendering)'),
});

export type AgentDetailInput = z.infer<typeof agentDetailSchema>;

export async function agentDetail(input: AgentDetailInput): Promise<string> {
  const agentOrError = getAgentOrFail(input.agent_id);
  if (typeof agentOrError === 'string') return agentOrError;
  const agent = agentOrError as Agent;

  const os = getAgentOS(agent);
  const isLocal = agent.agentType === 'local';
  const strategy = getStrategy(agent);

  const result: Record<string, unknown> = {
    name: agent.friendlyName,
    id: agent.id,
    type: agent.agentType,
    host: isLocal ? '(local)' : `${agent.host}:${agent.port}`,
    os,
    folder: agent.remoteFolder,
  };

  // -- Connectivity --
  const conn = await strategy.testConnection();
  if (conn.ok) {
    result.connectivity = isLocal
      ? { status: 'connected', type: 'local' }
      : { status: 'connected', latencyMs: conn.latencyMs, auth: agent.authType, keyPath: agent.keyPath };
  } else {
    result.connectivity = { status: 'offline', error: conn.error, auth: agent.authType };
    result.offline = true;
    return JSON.stringify(result);
  }

  // -- Claude CLI --
  const cli: Record<string, unknown> = {};
  try {
    const versionResult = await strategy.execCommand(getClaudeVersionCommand(os), 10000);
    cli.version = versionResult.stdout.trim();
  } catch {
    cli.version = 'unknown';
  }

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

  cli.auth = authMethods.length > 0 ? authMethods : 'none';
  result.claude = cli;

  // -- Session --
  const session: Record<string, unknown> = {
    id: agent.sessionId ?? null,
    lastActivity: agent.lastUsed ?? 'never',
  };

  try {
    const busyCheck = await strategy.execCommand(
      getFleetProcessCheckCommand(os, agent.remoteFolder, agent.sessionId),
      10000,
    );
    const output = busyCheck.stdout.trim().toLowerCase();
    if (output.includes('fleet-busy')) {
      session.status = 'busy';
    } else if (output.includes('other-busy')) {
      session.status = 'idle (unrelated Claude processes running)';
    } else {
      session.status = 'idle';
    }
  } catch {
    session.status = 'unknown';
  }
  result.session = session;

  // -- System Resources --
  const resources: Record<string, string> = {};

  try {
    const cpuResult = await strategy.execCommand(getCpuLoadCommand(os), 10000);
    resources.cpu = cpuResult.stdout.trim();
  } catch {
    resources.cpu = 'unavailable';
  }

  try {
    const memResult = await strategy.execCommand(getMemoryCommand(os), 10000);
    const memLines = memResult.stdout.trim().split('\n');
    if (os === 'linux') {
      const memLine = memLines.find(l => l.startsWith('Mem:'));
      if (memLine) {
        const parts = memLine.split(/\s+/);
        resources.memory = `${parts[2]} MB / ${parts[1]} MB`;
      } else {
        resources.memory = memResult.stdout.trim();
      }
    } else {
      resources.memory = memResult.stdout.trim().substring(0, 200);
    }
  } catch {
    resources.memory = 'unavailable';
  }

  try {
    const diskResult = await strategy.execCommand(getDiskCommand(os, agent.remoteFolder), 10000);
    const diskLines = diskResult.stdout.trim().split('\n');
    if (os !== 'windows' && diskLines.length >= 2) {
      resources.disk = diskLines[1].trim();
    } else {
      resources.disk = diskResult.stdout.trim().substring(0, 200);
    }
  } catch {
    resources.disk = 'unavailable';
  }
  result.resources = resources;

  if (input.format === 'json') {
    return JSON.stringify(result);
  }

  // Compact: pack key info into a few lines
  const connStatus = conn.ok ? 'online' : 'OFFLINE';
  const authStr = Array.isArray(cli.auth) ? (cli.auth as string[]).join(', ') : String(cli.auth);
  const sessId = agent.sessionId ? agent.sessionId.substring(0, 8) + '...' : 'none';
  const sessStatus = String(session.status ?? 'unknown');

  let t = `${agent.friendlyName} (${agent.agentType}) | ${connStatus} | os=${os} | claude=${cli.version}\n`;
  t += `  auth=${authStr} | session=${sessId} (${sessStatus}) | last=${agent.lastUsed ?? 'never'}\n`;
  t += `  cpu=${resources.cpu} | mem=${resources.memory} | disk=${resources.disk}\n`;
  return t;
}
