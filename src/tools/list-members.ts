import { z } from 'zod';
import { getAllAgents } from '../services/registry.js';
import { DEFAULT_ICON } from '../services/icons.js';

export const listMembersSchema = z.object({
  format: z.enum(['compact', 'json']).default('compact').describe('Output format: "compact" (default, few lines) or "json" (structured data for detailed rendering)'),
});

export type ListMembersInput = z.infer<typeof listMembersSchema>;

export async function listMembers(input?: ListMembersInput): Promise<string> {
  const format = input?.format ?? 'compact';
  const agents = getAllAgents();

  if (agents.length === 0) return 'No members registered.';

  if (format === 'json') {
    return JSON.stringify({
      total: agents.length,
      members: agents.map(a => ({
        id: a.id,
        name: a.friendlyName,
        icon: a.icon ?? DEFAULT_ICON,
        type: a.agentType,
        host: a.agentType === 'local' ? '(local)' : `${a.host}:${a.port}`,
        username: a.username ?? undefined,
        os: a.os ?? 'unknown',
        folder: a.workFolder,
        auth: a.agentType === 'local' ? undefined : a.authType,
        session: a.sessionId ?? null,
        created: a.createdAt,
        lastUsed: a.lastUsed ?? 'never',
      })),
    });
  }

  // Compact: 1 line per member with key fields packed together
  let t = `${agents.length} member(s)\n`;
  for (const a of agents) {
    const icon = a.icon ?? DEFAULT_ICON;
    const host = a.agentType === 'local' ? 'local' : `${a.host}:${a.port}`;
    t += `  ${icon} ${a.friendlyName}: ${a.id} | ${host} | ${a.os ?? '?'}`;
    if (a.agentType !== 'local') t += ` | user=${a.username} | auth=${a.authType}`;
    t += '\n';
  }
  return t;
}
