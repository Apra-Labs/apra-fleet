import { z } from 'zod';
import { getAllAgents } from '../services/registry.js';

export const listAgentsSchema = z.object({
  format: z.enum(['compact', 'json']).default('compact').describe('Output format: "compact" (default, few lines) or "json" (structured data for detailed rendering)'),
});

export type ListAgentsInput = z.infer<typeof listAgentsSchema>;

export async function listAgents(input?: ListAgentsInput): Promise<string> {
  const format = input?.format ?? 'compact';
  const agents = getAllAgents();

  if (agents.length === 0) return 'No agents registered.';

  if (format === 'json') {
    return JSON.stringify({
      total: agents.length,
      agents: agents.map(a => ({
        id: a.id,
        name: a.friendlyName,
        type: a.agentType,
        host: a.agentType === 'local' ? '(local)' : `${a.host}:${a.port}`,
        username: a.username ?? undefined,
        os: a.os ?? 'unknown',
        folder: a.remoteFolder,
        auth: a.agentType === 'local' ? undefined : a.authType,
        session: a.sessionId ?? null,
        created: a.createdAt,
        lastUsed: a.lastUsed ?? 'never',
      })),
    });
  }

  // Compact: 1 line per agent with key fields packed together
  let t = `${agents.length} agent(s)\n`;
  for (const a of agents) {
    const host = a.agentType === 'local' ? 'local' : `${a.host}:${a.port}`;
    t += `  ${a.friendlyName}: ${a.id} | ${host} | ${a.os ?? '?'}`;
    if (a.agentType !== 'local') t += ` | user=${a.username} | auth=${a.authType}`;
    t += '\n';
  }
  return t;
}
