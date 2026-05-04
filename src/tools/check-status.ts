import { z } from 'zod';
import { getAllAgents } from '../services/registry.js';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { getProvider } from '../providers/index.js';
import { formatAgentHost, getAgentOS } from '../utils/agent-helpers.js';
import { serverVersion } from '../version.js';
import { DEFAULT_ICON } from '../services/icons.js';
import { writeStatusline } from '../services/statusline.js';
import { awsProvider } from '../services/cloud/aws.js';
import { estimateCost, hourlyRate, formatUptimeDuration, uptimeHoursFromLaunch, costWarning } from '../services/cloud/cost.js';
import { parseGpuUtilization } from '../utils/gpu-parser.js';
import { getUpdateNotice } from '../services/update-check.js';

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
  branch?: string;
  cloudInfo?: CloudInfo;
  tokenUsage?: { input: number; output: number };
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
    branch: agent.lastBranch,
    tokenUsage: agent.tokenUsage,
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
      const provider = getProvider(agent.llmProvider);

      // Run fleet process check and GPU utilization in parallel
      const [busyResult, gpuResult] = await Promise.allSettled([
        strategy.execCommand(cmds.fleetProcessCheck(agent.workFolder, agent.sessionId, provider.processName), 10000),
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
        const gpuNum = parseGpuUtilization(gpuResult.value.stdout);
        if (gpuNum !== undefined) {
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
        const provider = getProvider(agent.llmProvider);
        const busyCheck = await strategy.execCommand(
          cmds.fleetProcessCheck(agent.workFolder, agent.sessionId, provider.processName),
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

  const updateNotice = getUpdateNotice();

  if (format === 'json') {
    const rowsWithCategory = rows.map((r, i) => ({ ...r, category: agents[i].category ?? null }));
    const payload: Record<string, unknown> = {
      version: serverVersion,
      summary: { total: rows.length, online, offline: rows.length - online },
      members: rowsWithCategory,
    };
    if (updateNotice) {
      const m = updateNotice.match(/apra-fleet (v[\d.]+) is available \(installed: (v[\d.]+)/);
      if (m) payload.updateAvailable = { latest: m[1], installed: m[2] };
    }
    return JSON.stringify(payload);
  }

  // Group rows by category
  const grouped = new Map<string, Array<{ row: AgentStatusRow; agent: ReturnType<typeof getAllAgents>[number] }>>();
  for (let i = 0; i < rows.length; i++) {
    const key = agents[i].category?.trim() || '(uncategorized)';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push({ row: rows[i], agent: agents[i] });
  }

  // Compact: 1 summary line + 1 line per member, multiple fields per line
  let t = updateNotice ? `${updateNotice}\n` : '';
  t += `Fleet ${serverVersion}: ${online}/${rows.length} online`;
  for (const [category, members] of grouped) {
    const chips = members.map(({ row: r }) => {
      const st = r.status === 'online' ? r.busy : (r.busy === 'OFF(cloud)' ? 'OFF(cloud)' : 'OFF');
      return `${r.icon} ${r.name}(${st})`;
    }).join(', ');
    t += ` | [${category}]: ${chips}`;
  }
  t += '\n';

  // Detail lines grouped by category
  for (const [category, members] of grouped) {
    t += `\n[${category}]\n`;
    for (const { row: r } of members) {
      const branchStr = r.branch ? ` | branch=${r.branch}` : '';
      const tokenStr = (r.tokenUsage && (r.tokenUsage.input > 0 || r.tokenUsage.output > 0))
        ? ` | tokens=in:${r.tokenUsage.input} out:${r.tokenUsage.output}` : '';
      let line = `  ${r.icon} ${r.name}: ${r.host} | session=${r.session} | ${r.lastActivity}${branchStr}${tokenStr}`;
      if (r.cloudInfo) {
        const ci = r.cloudInfo;
        const uptimeHrs = uptimeHoursFromLaunch(ci.launchTime);
        const uptime = ci.launchTime ? formatUptimeDuration(uptimeHrs) : '-';
        const cost = estimateCost(ci.instanceType, uptimeHrs);
        const rate = hourlyRate(ci.instanceType);
        const warn = costWarning(ci.instanceType, uptimeHrs);
        const gpuStr = ci.gpuUtil !== undefined ? ` GPU:${ci.gpuUtil}%` : '';
        const typeStr = ci.instanceType ? ` ${ci.instanceType}` : '';
        const warnStr = warn ? ' ⚠' : '';
        line += ` | [cloud:${ci.state}${typeStr} ${uptime} ${cost} @${rate}${gpuStr}${warnStr}]`;
      }
      t += line + '\n';
    }
  }
  return t;
}
