import { z } from 'zod';
import { getAllAgents } from '../services/registry.js';
import { getStrategy } from '../services/strategy.js';
import { getProcessCheckCommand } from '../utils/platform.js';

export const fleetStatusSchema = z.object({});

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
  const hostLabel = agent.agentType === 'local' ? '(local)' : `${agent.host}:${agent.port}`;

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

      // Check if Claude is running
      try {
        const os = (agent.os ?? 'linux') as 'linux' | 'macos' | 'windows';
        const busyCheck = await strategy.execCommand(getProcessCheckCommand(os), 10000);
        row.busy = busyCheck.stdout.trim().toLowerCase().includes('busy') ? 'BUSY' : 'idle';
      } catch {
        row.busy = 'unknown';
      }
    }
  } catch {
    row.status = 'OFFLINE';
  }

  return row;
}

export async function fleetStatus(): Promise<string> {
  const agents = getAllAgents();

  if (agents.length === 0) {
    return 'No agents registered. Use register_agent to add one.';
  }

  // Query all agents in parallel
  const results = await Promise.allSettled(agents.map(a => checkAgent(a)));

  const rows: AgentStatusRow[] = results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    const hostLabel = agents[i].agentType === 'local' ? '(local)' : `${agents[i].host}:${agents[i].port}`;
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
  const offline = rows.length - online;

  // Build table
  const nameW = Math.max(12, ...rows.map(r => r.name.length));
  const hostW = Math.max(15, ...rows.map(r => r.host.length));
  const statusW = 7;
  const busyW = 7;
  const sessW = 12;
  const actW = 14;

  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));

  let table = `Fleet Status (${rows.length} agents, ${online} online, ${offline} offline)\n\n`;
  table += `| ${pad('Name', nameW)} | ${pad('Host', hostW)} | ${pad('Status', statusW)} | ${pad('Busy?', busyW)} | ${pad('Session', sessW)} | ${pad('Last Activity', actW)} |\n`;
  table += `| ${'-'.repeat(nameW)} | ${'-'.repeat(hostW)} | ${'-'.repeat(statusW)} | ${'-'.repeat(busyW)} | ${'-'.repeat(sessW)} | ${'-'.repeat(actW)} |\n`;

  for (const row of rows) {
    table += `| ${pad(row.name, nameW)} | ${pad(row.host, hostW)} | ${pad(row.status, statusW)} | ${pad(row.busy, busyW)} | ${pad(row.session, sessW)} | ${pad(row.lastActivity, actW)} |\n`;
  }

  return table;
}
