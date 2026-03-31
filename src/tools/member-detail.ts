import { z } from 'zod';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { getProvider } from '../providers/index.js';
import { getAgentOrFail, getAgentOS } from '../utils/agent-helpers.js';
import type { Agent } from '../types.js';
import { DEFAULT_ICON } from '../services/icons.js';
import { writeStatusline } from '../services/statusline.js';
import { awsProvider } from '../services/cloud/aws.js';
import { estimateCost, formatUptimeDuration, uptimeHoursFromLaunch } from '../services/cloud/cost.js';

export const memberDetailSchema = z.object({
  member_id: z.string().describe('The UUID of the member (worker) to inspect'),
  format: z.enum(['compact', 'json']).default('compact').describe('Output format: "compact" (default, few lines) or "json" (structured data for detailed rendering)'),
});

export type MemberDetailInput = z.infer<typeof memberDetailSchema>;

export async function memberDetail(input: MemberDetailInput): Promise<string> {
  const agentOrError = getAgentOrFail(input.member_id);
  if (typeof agentOrError === 'string') return agentOrError;
  const agent = agentOrError as Agent;

  const os = getAgentOS(agent);
  const cmds = getOsCommands(os);
  const isLocal = agent.agentType === 'local';
  const strategy = getStrategy(agent);

  const result: Record<string, unknown> = {
    name: agent.friendlyName,
    icon: agent.icon ?? DEFAULT_ICON,
    id: agent.id,
    type: agent.agentType,
    host: isLocal ? '(local)' : `${agent.host}:${agent.port}`,
    username: agent.username ?? undefined,
    os,
    folder: agent.workFolder,
  };

  // -- Cloud Info (parallel with connectivity check) --
  let cloudSection: Record<string, unknown> | undefined;

  if (agent.cloud) {
    const [detailsResult, connResult] = await Promise.allSettled([
      awsProvider.getInstanceDetails(agent.cloud),
      strategy.testConnection(),
    ]);

    if (detailsResult.status === 'fulfilled') {
      const details = detailsResult.value;
      const uptimeHrs = uptimeHoursFromLaunch(details.launchTime);
      cloudSection = {
        instanceId: agent.cloud.instanceId,
        region: agent.cloud.region,
        state: details.state,
        publicIp: details.publicIp,
        instanceType: details.instanceType,
        uptime: details.launchTime ? formatUptimeDuration(uptimeHrs) : undefined,
        estimatedCost: estimateCost(details.instanceType, uptimeHrs),
        idleTimeoutMin: agent.cloud.idleTimeoutMin,
      };
    } else {
      cloudSection = {
        instanceId: agent.cloud.instanceId,
        region: agent.cloud.region,
        error: (detailsResult.reason as Error).message,
        idleTimeoutMin: agent.cloud.idleTimeoutMin,
      };
    }

    // Use connectivity result
    const conn = connResult.status === 'fulfilled' ? connResult.value : { ok: false as const, latencyMs: 0, error: 'check failed' };

    if (conn.ok) {
      result.connectivity = isLocal
        ? { status: 'connected', type: 'local' }
        : { status: 'connected', latencyMs: conn.latencyMs, auth: agent.authType, keyPath: agent.keyPath };
    } else {
      result.connectivity = { status: 'offline', error: conn.error, auth: agent.authType };
      result.offline = true;
      result.cloud = cloudSection;
      writeStatusline(new Map([[agent.id, 'offline']]));
      return JSON.stringify(result);
    }
  } else {
    // Non-cloud: original connectivity check
    const conn = await strategy.testConnection();
    if (conn.ok) {
      result.connectivity = isLocal
        ? { status: 'connected', type: 'local' }
        : { status: 'connected', latencyMs: conn.latencyMs, auth: agent.authType, keyPath: agent.keyPath };
    } else {
      result.connectivity = { status: 'offline', error: conn.error, auth: agent.authType };
      result.offline = true;
      writeStatusline(new Map([[agent.id, 'offline']]));
      return JSON.stringify(result);
    }
  }

  // -- Agent CLI --
  const provider = getProvider(agent.llmProvider);
  const cli: Record<string, unknown> = {};
  try {
    const versionResult = await strategy.execCommand(cmds.agentVersion(provider), 10000);
    cli.version = versionResult.stdout.trim();
  } catch {
    cli.version = 'unknown';
  }

  const authMethods: string[] = [];
  try {
    const credResult = await strategy.execCommand(cmds.credentialFileCheck(), 10000);
    if (credResult.stdout.trim() === 'found') {
      authMethods.push('OAuth credentials file');
    }
  } catch { /* ignore */ }

  try {
    const apiKeyResult = await strategy.execCommand(cmds.apiKeyCheck(), 10000);
    if (apiKeyResult.stdout.trim().length > 5) {
      authMethods.push('API key (env)');
    }
  } catch { /* ignore */ }

  cli.auth = authMethods.length > 0 ? authMethods : 'none';
  result.llmProvider = agent.llmProvider ?? 'claude';
  result.claude = cli;  // kept for backwards compatibility

  // -- Session --
  const session: Record<string, unknown> = {
    id: agent.sessionId ?? null,
    lastActivity: agent.lastUsed ?? 'never',
  };

  try {
    const busyCheck = await strategy.execCommand(
      cmds.fleetProcessCheck(agent.workFolder, agent.sessionId, provider.processName),
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
    const cpuResult = await strategy.execCommand(cmds.cpuLoad(), 10000);
    resources.cpu = cpuResult.stdout.trim();
  } catch {
    resources.cpu = 'unavailable';
  }

  try {
    const memResult = await strategy.execCommand(cmds.memory(), 10000);
    resources.memory = cmds.parseMemory(memResult.stdout);
  } catch {
    resources.memory = 'unavailable';
  }

  try {
    const diskResult = await strategy.execCommand(cmds.disk(agent.workFolder), 10000);
    resources.disk = cmds.parseDisk(diskResult.stdout);
  } catch {
    resources.disk = 'unavailable';
  }

  // GPU utilization for cloud members
  if (agent.cloud) {
    try {
      const gpuResult = await strategy.execCommand(cmds.gpuUtilization(), 10000);
      const gpuStr = gpuResult.stdout.trim();
      if (gpuStr) {
        resources.gpu = gpuStr + '%';
        if (cloudSection) {
          cloudSection.gpuUtilization = parseInt(gpuStr, 10);
        }
      } else {
        resources.gpu = 'N/A';
      }
    } catch {
      resources.gpu = 'unavailable';
    }
  }

  result.resources = resources;

  if (cloudSection) {
    result.cloud = cloudSection;
  }

  // Update statusline with observed state
  const slStatus = session.status === 'busy' ? 'busy' : 'idle';
  writeStatusline(new Map([[agent.id, slStatus]]));

  if (input.format === 'json') {
    return JSON.stringify(result);
  }

  // Compact: pack key info into a few lines
  const connStatus = 'online';
  const authStr = Array.isArray(cli.auth) ? (cli.auth as string[]).join(', ') : String(cli.auth);
  const sessId = agent.sessionId ? agent.sessionId.substring(0, 8) + '...' : 'none';
  const sessStatus = String(session.status ?? 'unknown');

  const icon = agent.icon ?? DEFAULT_ICON;
  const userStr = agent.username ? ` | user=${agent.username}` : '';
  let t = `${icon} ${agent.friendlyName} (${agent.agentType})${userStr} | ${connStatus} | os=${os} | provider=${agent.llmProvider ?? 'claude'} | cli=${cli.version}\n`;
  t += `  auth=${authStr} | session=${sessId} (${sessStatus}) | last=${agent.lastUsed ?? 'never'}\n`;
  t += `  cpu=${resources.cpu} | mem=${resources.memory} | disk=${resources.disk}\n`;

  if (cloudSection) {
    const cs = cloudSection as Record<string, unknown>;
    const state = String(cs.state ?? 'unknown');
    const itype = cs.instanceType ? String(cs.instanceType) : 'unknown';
    const uptime = cs.uptime ? String(cs.uptime) : '-';
    const cost = cs.estimatedCost ? String(cs.estimatedCost) : '?';
    const gpu = resources.gpu ? ` | GPU: ${resources.gpu}` : '';
    t += `  cloud: ${state} | ${itype} | ${uptime} | est. ${cost}${gpu}\n`;
  }

  return t;
}
