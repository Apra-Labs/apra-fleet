import { z } from 'zod';
import { getAllAgents } from '../services/registry.js';
import { DEFAULT_ICON } from '../services/icons.js';
import { serverVersion } from '../version.js';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { getProvider } from '../providers/index.js';
import { getAgentOS, groupByCategory, formatAgentHost } from '../utils/agent-helpers.js';
import type { Agent } from '../types.js';
import { syncCloudCache } from '../services/cloud-sync.js';

export const listMembersSchema = z.object({
  format: z.enum(['compact', 'json']).default('compact').describe('Output format: "compact" (default, few lines) or "json" (structured data for detailed rendering)'),
  tags: z.array(z.string()).optional().describe('Filter members by tags (AND semantics): only return members that have ALL specified tags. Omit to return all members.'),
});

export type ListMembersInput = z.infer<typeof listMembersSchema>;

async function getAuthStatus(agent: Agent): Promise<string> {
  // Relay agents authenticate via the hub machine JWT, not per-command SSH
  // auth/credential-file checks below (which assume RemoteStrategy) --
  // there's no equivalent status to report yet (apra-fleet-jfn).
  if (agent.agentType === 'local' || agent.agentType === 'relay') return 'N/A';

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
  const filterTags = input?.tags;
  let agents = getAllAgents();

  if (filterTags && filterTags.length > 0) {
    agents = agents.filter(a => filterTags.every(tag => a.tags?.includes(tag)));
  }

  if (agents.length === 0) return 'No members registered.';

  const authStatusPromises = agents.map(getAuthStatus);
  const authStatuses = await Promise.all(authStatusPromises);

  // SaaS-connected devices (apra-fleet-aho) additionally surface the
  // cloud workspace's own member/project list -- a fleet-dashboard
  // "workspace member" is a distinct concept from this file's local
  // SSH/relay Agent registry above, so it's reported as its own section
  // rather than merged into `agents`. A standalone (no hub-credentials.json)
  // instance gets `status: 'not-connected'` and this adds nothing to the
  // output, so existing standalone behavior/tests are unaffected.
  const cloudSync = await syncCloudCache();

  if (format === 'json') {
    return JSON.stringify({
      server_version: serverVersion,
      total: agents.length,
      cloud: cloudSync.status === 'not-connected' ? undefined : {
        status: cloudSync.status,
        members: cloudSync.status === 'synced' ? cloudSync.cache.members : cloudSync.status === 'offline' ? (cloudSync.cache?.members ?? []) : [],
        projects: cloudSync.status === 'synced' ? cloudSync.cache.projects : cloudSync.status === 'offline' ? (cloudSync.cache?.projects ?? []) : [],
        lastSyncedAt: cloudSync.status === 'synced' ? cloudSync.cache.lastSyncedAt : cloudSync.status === 'offline' ? (cloudSync.cache?.lastSyncedAt ?? null) : null,
      },
      members: agents.map((a, i) => ({
        id: a.id,
        name: a.friendlyName,
        icon: a.icon ?? DEFAULT_ICON,
        type: a.agentType,
        host: formatAgentHost(a),
        username: a.username ?? undefined,
        os: a.os ?? 'unknown',
        folder: a.workFolder,
        llmProvider: a.llmProvider ?? 'claude',
        llm_auth: authStatuses[i],
        ssh_auth: a.agentType === 'remote' ? a.authType : undefined,
        session: a.sessionId ?? null,
        created: a.createdAt,
        lastUsed: a.lastUsed ?? 'never',
        category: a.category ?? null,
        tags: a.tags ?? null,
      })),
    });
  }

  // Compact: group members by category, one group per row block
  const combined = agents.map((agent, i) => ({ agent, authStatus: authStatuses[i] }));
  const { grouped, sortedKeys } = groupByCategory(combined, ({ agent: a }) => a.category?.trim());

  let t = '';
  if (cloudSync.status === 'synced') {
    t += `[cloud] ${cloudSync.cache.members.length} workspace member(s), ${cloudSync.cache.projects.length} project(s)\n`;
  } else if (cloudSync.status === 'offline') {
    t += `[cloud] fleet-dashboard unreachable -- showing last synced data (${cloudSync.cache?.members.length ?? 0} member(s), ${cloudSync.cache?.projects.length ?? 0} project(s))\n`;
  } else if (cloudSync.status === 'credential-expired') {
    t += `[cloud] credential expired or revoked -- run \`apra-fleet join <member-jwt>\` again\n`;
  }
  t += `${agents.length} member(s)\n`;
  for (const category of sortedKeys) {
    const members = grouped.get(category)!;
    t += `\n[${category}]\n`;
    for (const { agent: a, authStatus } of members) {
      const icon = a.icon ?? DEFAULT_ICON;
      const host = a.agentType === 'local' ? 'local' : a.agentType === 'relay' ? 'relay' : `${a.host}:${a.port}`;
      t += `  ${icon} ${a.friendlyName}: ${a.id} | ${host} | ${a.os ?? '?'} | provider=${a.llmProvider ?? 'claude'}`;
      if (a.agentType === 'remote') {
        t += ` | user=${a.username} | ssh=${a.authType}`;
        if (authStatus !== 'offline' && authStatus !== 'N/A') {
          t += ` | llm-auth=${authStatus}`;
        } else if (authStatus === 'offline') {
          t += ` | status=offline`;
        }
      }
      if (a.tags && a.tags.length > 0) {
        t += ` | tags=[${a.tags.join(', ')}]`;
      }
      t += '\n';
    }
  }
  return t;
}
