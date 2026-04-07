import { z } from 'zod';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { getProvider } from '../providers/index.js';
import { getAgentOS } from '../utils/agent-helpers.js';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { updateAgent } from '../services/registry.js';
import type { Agent } from '../types.js';
import { DEFAULT_ICON } from '../services/icons.js';
import { writeStatusline } from '../services/statusline.js';
import { awsProvider } from '../services/cloud/aws.js';
import { estimateCost, formatUptimeDuration, uptimeHoursFromLaunch } from '../services/cloud/cost.js';
import { serverVersion } from '../version.js';

export const memberDetailSchema = z.object({
  ...memberIdentifier,
  format: z.enum(['compact', 'json']).default('compact').describe('Output format: "compact" (default, few lines) or "json" (structured data for detailed rendering)'),
});

export type MemberDetailInput = z.infer<typeof memberDetailSchema>;

export async function memberDetail(input: MemberDetailInput): Promise<string> {
  const agentOrError = resolveMember(input.member_id, input.member_name);
  if (typeof agentOrError === 'string') return agentOrError;
  const agent = agentOrError as Agent;

  const os = getAgentOS(agent);
  const cmds = getOsCommands(os);
  const isLocal = agent.agentType === 'local';
  const strategy = getStrategy(agent);

  const result: Record<string, unknown> = {
    server_version: serverVersion,
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
    // Strip provider prefix: "Claude Code 2.1.92" → "2.1.92"
    const vMatch = String(cli.version).match(/(\d+\.\d+\.\d+.*)$/);
    if (vMatch) cli.version = vMatch[1];
  } catch {
    cli.version = 'unknown';
  }

  let oauthFilesExist = false;
  const oauthFiles = provider.oauthCredentialFiles?.();
  if (oauthFiles && oauthFiles.length > 0) {
    try {
      // Check for the first file, assuming if it's there, the others are too.
      const credResult = await strategy.execCommand(cmds.credentialFileCheck(oauthFiles[0].remotePath), 10000);
      if (credResult.stdout.trim() === 'found') {
        oauthFilesExist = true;
      }
    } catch { /* ignore */ }
  }

  let apiKeyExists = false;
  if (provider.authEnvVar) {
    try {
      const apiKeyResult = await strategy.execCommand(cmds.apiKeyCheck(provider.authEnvVar), 10000);
      if (apiKeyResult.stdout.trim().length > 5) {
        apiKeyExists = true;
      }
    } catch { /* ignore */ }
  }

  if (apiKeyExists && oauthFilesExist) {
    cli.auth = 'api-key (WARNING: OAuth also present — API key takes precedence)';
  } else if (apiKeyExists) {
    cli.auth = 'api-key';
  } else if (oauthFilesExist) {
    cli.auth = 'oauth';
  } else {
    cli.auth = 'none';
  }
  result.llmProvider = agent.llmProvider ?? 'claude';
  result.llm_cli = cli;
  if (agent.tokenUsage) {
    result.tokenUsage = agent.tokenUsage;
  }

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
      session.status = `idle (unrelated ${provider.name} processes running)`;
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

  let branch: string | undefined;
  try {
    const branchResult = await strategy.execCommand(cmds.gitCurrentBranch(agent.workFolder), 10000);
    const branchName = branchResult.stdout.trim();
    if (branchName) {
      branch = branchName;
      updateAgent(agent.id, { lastBranch: branch });
    }
  } catch { /* not a git repo — ignore */ }

  if (branch) {
    result.branch = branch;
  }

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
  const tokenStr = agent.tokenUsage ? ` | tokens=in:${agent.tokenUsage.input} out:${agent.tokenUsage.output}` : '';
  t += `  auth=${authStr} | session=${sessId} (${sessStatus}) | last=${agent.lastUsed ?? 'never'}${tokenStr}\n`;
  const branchStr = branch ? ` | branch=${branch}` : '';
  t += `  cpu=${resources.cpu} | mem=${resources.memory} | disk=${resources.disk}${branchStr}\n`;

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



