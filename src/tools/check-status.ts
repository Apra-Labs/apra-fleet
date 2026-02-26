import { z } from 'zod';
import { getAllAgents } from '../services/registry.js';
import { getStrategy } from '../services/strategy.js';
import { getFleetProcessCheckCommand } from '../utils/platform.js';
import { formatAgentHost, getAgentOS } from '../utils/agent-helpers.js';

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

      // Check if a fleet-related Claude process is running in this agent's folder
      try {
        const os = getAgentOS(agent);
        const busyCheck = await strategy.execCommand(
          getFleetProcessCheckCommand(os, agent.remoteFolder, agent.sessionId),
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

export async function fleetStatus(): Promise<string> {
  const agents = getAllAgents();

  if (agents.length === 0) {
    return 'No agents registered. Use register_agent to add one.';
  }

  // Query all agents in parallel
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
  const offline = rows.length - online;

  return JSON.stringify({
    summary: { total: rows.length, online, offline },
    agents: rows,
  });
}
