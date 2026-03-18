import { z } from 'zod';
import { getAllAgents } from '../services/registry.js';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { formatAgentHost, getAgentOS } from '../utils/agent-helpers.js';
import { serverVersion } from '../version.js';
import { DEFAULT_ICON } from '../services/icons.js';
import { writeStatusline } from '../services/statusline.js';
import { awsProvider } from '../services/cloud/aws.js';
import { estimateCost, formatUptimeDuration, uptimeHoursFromLaunch } from '../services/cloud/cost.js';

export const fleetStatusSchema = z.object({
  format: z.enum(['compact', 'json']).default('compact').describe('Output format: "compact" (default, few lines) or "json" (structured data for detailed rendering)'),
});

interface CloudInfo {
  state: string;
  instanceType?: string;
  launchTime?: string;
  gpuUtil?: number;
}

interface AgentStatusRow {
  icon: string;
  name: string;
  host: string;
  status: 'online' | 'OFFLINE';
  busy: string;
  session: string;
  lastActivity: string;
  cloudInfo?: CloudInfo;
}

function formatTimeAgo(isoDate?: string): string {
  if (!isoDate) return 'never';
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

async function checkAgent(agent: ReturnType<typeof getAllAgents>[number]): Promise<AgentStatusRow> {
  const hostLabel = formatAgentHost(agent);

  const row: AgentStatusRow = {
    icon: agent.icon ?? DEFAULT_ICON,
    name: agent.friendlyName,
    host: hostLabel,
    status: 'OFFLINE',
    busy: '-',
    session: agent.sessionId ? agent.sessionId.substring(0, 8) + '...' : '(none)',
    lastActivity: formatTimeAgo(agent.lastUsed),
  };

  const strategy = getStrategy(agent);

  // For cloud members: fetch instance details in parallel with SSH connection test
  if (agent.cloud) {
    const [detailsResult, connResult] = await Promise.allSettled([
      awsProvider.getInstanceDetails(agent.cloud),
      Promise.race([
        strategy.testConnection(),
        new Promise<{ ok: false; latencyMs: number; error: string }>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 10000)
        ),
      ]),
    ]);

    // Process cloud details
    if (detailsResult.status === 'fulfilled') {
      const details = detailsResult.value;
      row.cloudInfo = {
        state: details.state,
        instanceType: details.instanceType,
        launchTime: details.launchTime,
      };

      // If cloud is not running/pending, mark as off and skip SSH entirely
      if (details.state !== 'running' && details.state !== 'pending') {
        row.status = 'OFFLINE';
        row.busy = 'OFF(cloud)';
        return row;
      }
    }

    // Process SSH connection result
    if (connResult.status === 'fulfilled' && connResult.value.ok) {
      row.status = 'online';

      const cmds = getOsCommands(getAgentOS(agent));

      // Run fleet process check and GPU utilization in parallel
      const [busyResult, gpuResult] = await Promise.allSettled([
        strategy.execCommand(cmds.fleetProcessCheck(agent.workFolder, agent.sessionId), 10000),
        strategy.execCommand(cmds.gpuUtilization(), 10000),
      ]);

      if (busyResult.status === 'fulfilled') {
        const output = busyResult.value.stdout.trim().toLowerCase();
        if (output.includes('fleet-busy')) {
          row.busy = 'BUSY';
        } else if (output.includes('other-busy')) {
          row.busy = 'idle*';
        } else {
          row.busy = 'idle';
        }
      } else {
        row.busy = 'unknown';
      }

      if (gpuResult.status === 'fulfilled' && row.cloudInfo) {
        const gpuStr = gpuResult.value.stdout.trim();
        const gpuNum = parseInt(gpuStr, 10);
        if (!isNaN(gpuNum)) {
          row.cloudInfo.gpuUtil = gpuNum;
        }
      }
    }

    return row;
  }

  // Non-cloud members: original logic
  try {
    const conn = await Promise.race([
      strategy.testConnection(),
      new Promise<{ ok: false; latencyMs: number; error: string }>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 10000)
      ),
    ]);

    if (conn.ok) {
      row.status = 'online';

      try {
        const cmds = getOsCommands(getAgentOS(agent));
        const busyCheck = await strategy.execCommand(
          cmds.fleetProcessCheck(agent.workFolder, agent.sessionId),
          10000,
        );
        const output = busyCheck.stdout.trim().toLowerCase();
        if (output.includes('fleet-busy')) {
          row.busy = 'BUSY';
        } else if (output.includes('other-busy')) {
          row.busy = 'idle*';
        } else {
          row.busy = 'idle';
        }
      } catch {
        row.busy = 'unknown';
      }
    }
  } catch {
    row.status = 'OFFLINE';
  }

  return row;
}

export type FleetStatusInput = z.infer<typeof fleetStatusSchema>;

export async function fleetStatus(input?: FleetStatusInput): Promise<string> {
  const format = input?.format ?? 'compact';
  const agents = getAllAgents();

  if (agents.length === 0) {
    return 'No members registered. Use register_member to add one.';
  }

  // Query all members in parallel
  const results = await Promise.allSettled(agents.map(a => checkAgent(a)));

  const rows: AgentStatusRow[] = results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    const hostLabel = formatAgentHost(agents[i]);
    return {
      icon: agents[i].icon ?? DEFAULT_ICON,
      name: agents[i].friendlyName,
      host: hostLabel,
      status: 'OFFLINE' as const,
      busy: '-',
      session: agents[i].sessionId ? agents[i].sessionId.substring(0, 8) + '...' : '(none)',
      lastActivity: formatTimeAgo(agents[i].lastUsed),
    };
  });

  // Count cloud-stopped members as offline for the summary
  const online = rows.filter(r => r.status === 'online').length;

  // Update statusline with actual connectivity state from this check
  const statusOverrides = new Map<string, string>();
  for (let i = 0; i < agents.length; i++) {
    const row = rows[i];
    if (row.status === 'OFFLINE') {
      statusOverrides.set(agents[i].id, 'offline');
    } else if (row.busy === 'BUSY') {
      statusOverrides.set(agents[i].id, 'busy');
    } else {
      statusOverrides.set(agents[i].id, 'idle');
    }
  }
  writeStatusline(statusOverrides);

  if (format === 'json') {
    return JSON.stringify({ version: serverVersion, summary: { total: rows.length, online, offline: rows.length - online }, members: rows });
  }

  // Compact: 1 summary line + 1 line per member, multiple fields per line
  let t = `Fleet ${serverVersion}: ${online}/${rows.length} online | `;
  t += rows.map(r => {
    const st = r.status === 'online' ? r.busy : (r.busy === 'OFF(cloud)' ? 'OFF(cloud)' : 'OFF');
    return `${r.icon} ${r.name}(${st})`;
  }).join(', ');
  t += '\n';
  for (const r of rows) {
    let line = `  ${r.icon} ${r.name}: ${r.host} | session=${r.session} | ${r.lastActivity}`;
    if (r.cloudInfo) {
      const ci = r.cloudInfo;
      const uptimeHrs = uptimeHoursFromLaunch(ci.launchTime);
      const uptime = ci.launchTime ? formatUptimeDuration(uptimeHrs) : '-';
      const cost = estimateCost(ci.instanceType, uptimeHrs);
      const gpuStr = ci.gpuUtil !== undefined ? ` GPU:${ci.gpuUtil}%` : '';
      const typeStr = ci.instanceType ? ` ${ci.instanceType}` : '';
      line += ` | [cloud:${ci.state}${typeStr} ${uptime} ${cost}${gpuStr}]`;
    }
    t += line + '\n';
  }
  return t;
}
