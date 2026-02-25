import { z } from 'zod';
import { getAllAgents } from '../services/registry.js';

export const listAgentsSchema = z.object({});

export async function listAgents(): Promise<string> {
  const agents = getAllAgents();

  if (agents.length === 0) {
    return 'No agents registered. Use register_agent to add one.';
  }

  let result = `Fleet: ${agents.length} agent(s)\n\n`;

  for (const agent of agents) {
    result += `┌─ ${agent.friendlyName}\n`;
    result += `│  ID:       ${agent.id}\n`;
    result += `│  Host:     ${agent.host}:${agent.port}\n`;
    result += `│  OS:       ${agent.os ?? 'unknown'}\n`;
    result += `│  Folder:   ${agent.remoteFolder}\n`;
    result += `│  Auth:     ${agent.authType}\n`;
    result += `│  Session:  ${agent.sessionId ?? '(none)'}\n`;
    result += `│  Created:  ${agent.createdAt}\n`;
    result += `│  Last used: ${agent.lastUsed ?? 'never'}\n`;
    result += `└──────────────────────\n\n`;
  }

  return result;
}
