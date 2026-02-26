import { z } from 'zod';
import { getAllAgents } from '../services/registry.js';

export const listAgentsSchema = z.object({});

export async function listAgents(): Promise<string> {
  const agents = getAllAgents();

  if (agents.length === 0) {
    return JSON.stringify({ total: 0, agents: [] });
  }

  return JSON.stringify({
    total: agents.length,
    agents: agents.map(a => ({
      id: a.id,
      name: a.friendlyName,
      type: a.agentType,
      host: a.agentType === 'local' ? '(local)' : `${a.host}:${a.port}`,
      os: a.os ?? 'unknown',
      folder: a.remoteFolder,
      auth: a.agentType === 'local' ? undefined : a.authType,
      session: a.sessionId ?? null,
      created: a.createdAt,
      lastUsed: a.lastUsed ?? 'never',
    })),
  });
}
