import { z } from 'zod';
import { getAllAgents } from '../services/registry.js';
import { DEFAULT_ICON } from '../services/icons.js';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { getProvider } from '../providers/index.js';
import { getAgentOS } from '../utils/agent-helpers.js';
import type { Agent } from '../types.js';

export const listMembersSchema = z.object({
  format: z.enum(['compact', 'json']).default('compact').describe('Output format: "compact" (default, few lines) or "json" (structured data for detailed rendering)'),
});

export type ListMembersInput = z.infer<typeof listMembersSchema>;

async function getAuthStatus(agent: Agent): Promise<string> {
  if (agent.agentType === 'local') return 'N/A';

  const os = getAgentOS(agent);
  const cmds = getOsCommands(os);
  const strategy = getStrategy(agent);
  const provider = getProvider(agent.llmProvider);

  try {
    const conn = await strategy.testConnection();
    if (!conn.ok) return 'offline';
  } catch {
    return 'offline';
  }

  let oauthFilesExist = false;
  const oauthFiles = provider.oauthCredentialFiles?.();
  if (oauthFiles && oauthFiles.length > 0) {
    try {
      const credResult = await strategy.execCommand(cmds.credentialFileCheck(oauthFiles[0].remotePath), 5000); // 5s timeout
      if (credResult.stdout.trim() === 'found') {
        oauthFilesExist = true;
      }
    } catch { /* ignore */ }
  }

  let apiKeyExists = false;
  if (provider.authEnvVar) {
    try {
      const apiKeyResult = await strategy.execCommand(cmds.apiKeyCheck(provider.authEnvVar), 5000);
      if (apiKeyResult.stdout.trim().length > 5) {
        apiKeyExists = true;
      }
    } catch { /* ignore */ }
  }

  if (apiKeyExists && oauthFilesExist) {
    return "api-key (warn: oauth)";
  }
  if (apiKeyExists) {
    return "api-key";
  }
  if (oauthFilesExist) {
    return "oauth";
  }
  return "none";
}

export async function listMembers(input?: ListMembersInput): Promise<string> {
  const format = input?.format ?? 'compact';
  const agents = getAllAgents();

  if (agents.length === 0) return 'No members registered.';

  const authStatusPromises = agents.map(getAuthStatus);
  const authStatuses = await Promise.all(authStatusPromises);

  if (format === 'json') {
    return JSON.stringify({
      total: agents.length,
      members: agents.map((a, i) => ({
        id: a.id,
        name: a.friendlyName,
        icon: a.icon ?? DEFAULT_ICON,
        type: a.agentType,
        host: a.agentType === 'local' ? '(local)' : `${a.host}:${a.port}`,
        username: a.username ?? undefined,
        os: a.os ?? 'unknown',
        folder: a.workFolder,
        llmProvider: a.llmProvider ?? 'claude',
        llm_auth: authStatuses[i],
        ssh_auth: a.agentType === 'local' ? undefined : a.authType,
        session: a.sessionId ?? null,
        created: a.createdAt,
        lastUsed: a.lastUsed ?? 'never',
      })),
    });
  }

  // Compact: 1 line per member with key fields packed together
  let t = `${agents.length} member(s)\n`;
  for (const [i, a] of agents.entries()) {
    const icon = a.icon ?? DEFAULT_ICON;
    const host = a.agentType === 'local' ? 'local' : `${a.host}:${a.port}`;
    const authStatus = authStatuses[i];
    
    t += `  ${icon} ${a.friendlyName}: ${a.id} | ${host} | ${a.os ?? '?'} | provider=${a.llmProvider ?? 'claude'}`;
    if (a.agentType !== 'local') {
      t += ` | user=${a.username} | ssh=${a.authType}`;
      if (authStatus !== 'offline' && authStatus !== 'N/A') {
        t += ` | llm-auth=${authStatus}`;
      } else if (authStatus === 'offline') {
        t += ` | status=offline`;
      }
    }
    t += '\n';
  }
  return t;
}
