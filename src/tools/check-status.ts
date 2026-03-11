import { z } from 'zod';
import { getAllAgents } from '../services/registry.js';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { formatAgentHost, getAgentOS } from '../utils/agent-helpers.js';
import { serverVersion } from '../version.js';

export const fleetStatusSchema = z.object({
  format: z.enum(['compact', 'json']).default('compact').describe('Output format: "compact" (default, few lines) or "json" (structured data for detailed rendering)'),
});

interface AgentStatusRow {
  name: string;
  host: string;
  status: 'online' | 'OFFLINE';
  busy: string;
  session: string;
  lastActivity: string;
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
    name: agent.friendlyName,
    host: hostLabel,
    status: 'OFFLINE',
    busy: '-',
    session: agent.sessionId ? agent.sessionId.substring(0, 8) + '...' : '(none)',
    lastActivity: formatTimeAgo(agent.lastUsed),
  };

  const strategy = getStrategy(agent);

  try {
    const conn = await Promise.race([
      strategy.testConnection(),
      new Promise<{ ok: false; latencyMs: number; error: string }>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 10000)
      ),
    ]);

    if (conn.ok) {
      row.status = 'online';

      // Check if a fleet-related Claude process is running in this member's folder
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
      name: agents[i].friendlyName,
      host: hostLabel,
      status: 'OFFLINE' as const,
      busy: '-',
      session: agents[i].sessionId?.substring(0, 8) + '...' || '(none)',
      lastActivity: formatTimeAgo(agents[i].lastUsed),
    };
  });

  const online = rows.filter(r => r.status === 'online').length;

  if (format === 'json') {
    return JSON.stringify({ version: serverVersion, summary: { total: rows.length, online, offline: rows.length - online }, members: rows });
  }

  // Compact: 1 summary line + 1 line per member, multiple fields per line
  let t = `Fleet ${serverVersion}: ${online}/${rows.length} online | `;
  t += rows.map(r => {
    const st = r.status === 'online' ? r.busy : 'OFF';
    return `${r.name}(${st})`;
  }).join(', ');
  t += '\n';
  for (const r of rows) {
    t += `  ${r.name}: ${r.host} | session=${r.session} | ${r.lastActivity}\n`;
  }
  return t;
}
