import { z } from 'zod';
import fs from 'node:fs';
import { removeAgent as removeFromRegistry, getAllAgents } from '../services/registry.js';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { getProvider } from '../providers/index.js';
import { getAgentOS } from '../utils/agent-helpers.js';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { removeKnownHost } from '../services/known-hosts.js';
import { writeStatusline, readMemberStatus } from '../services/statusline.js';
import { cancelCredentialCleanup } from '../services/credential-cleanup.js';
import { githubProvider } from '../services/vcs/github.js';
import { bitbucketProvider } from '../services/vcs/bitbucket.js';
import { azureDevOpsProvider } from '../services/vcs/azure-devops.js';
import type { Agent } from '../types.js';
import type { VcsProviderService } from '../services/vcs/types.js';

const vcsProviders: Record<string, VcsProviderService> = {
  github: githubProvider,
  bitbucket: bitbucketProvider,
  'azure-devops': azureDevOpsProvider,
};

export const removeMemberSchema = z.object({
  ...memberIdentifier,
  force: z.boolean().optional().default(false).describe('Remove even if the member is currently busy'),
});

export type RemoveMemberInput = z.infer<typeof removeMemberSchema>;

export async function removeMember(input: RemoveMemberInput): Promise<string> {
  const agentOrError = resolveMember(input.member_id, input.member_name);
  if (typeof agentOrError === 'string') return agentOrError;
  const agent = agentOrError as Agent;

  // Idle check: block if the member is currently running a task
  const currentStatus = readMemberStatus(agent.id);
  if (currentStatus === 'busy' && !input.force) {
    return `⛔ Member "${agent.friendlyName}" is currently busy. Wait for the task to complete or set force=true to remove anyway.`;
  }

  const strategy = getStrategy(agent);
  const warnings: string[] = [];

  // Cancel any pending credential cleanup timer
  cancelCredentialCleanup(agent.id);

  // Best-effort: clear auth credentials from the member before removing
  // Skip for local members — their credentials belong to the host machine
  if (agent.agentType === 'remote') {
    try {
      const conn = await strategy.testConnection();
      if (conn.ok) {
        const cmds = getOsCommands(getAgentOS(agent));
        const exec = async (cmd: string) => {
          const r = await strategy.execCommand(cmd, 15000);
          return r.stdout;
        };
        const provider = getProvider(agent.llmProvider);

        // Remove credentials files for any provider that uses them
        const credentialFiles = provider.oauthCredentialFiles() ?? [];
        for (const file of credentialFiles) {
          await strategy.execCommand(cmds.credentialFileRemove(file.remotePath), 10000).catch(() => {});
        }

        // Remove the provider's API key env var from shell profiles
        for (const cmd of cmds.unsetEnv(provider.authEnvVar)) {
          await strategy.execCommand(cmd, 10000).catch(() => {});
        }

        // VCS auth revoke: remove git credential helper if a VCS provider is configured
        if (agent.vcsProvider) {
          const vcsService = vcsProviders[agent.vcsProvider];
          if (vcsService) {
            await vcsService.revoke(agent, cmds, exec).catch(() => {});
          }
        }

        // SSH key removal: remove fleet public key from remote authorized_keys
        if (agent.keyPath) {
          const pubKeyPath = `${agent.keyPath}.pub`;
          try {
            const pubKey = fs.readFileSync(pubKeyPath, 'utf-8').trim();
            // Use the key type + base64 portion to match (ignore trailing comment)
            const parts = pubKey.split(/\s+/);
            const keyMatch = parts.slice(0, 2).join(' ');
            // Escape forward slashes for sed delimiter
            const escapedKey = keyMatch.replace(/\//g, '\\/');
            await strategy.execCommand(
              `sed -i '/${escapedKey}/d' ~/.ssh/authorized_keys`,
              10000,
            ).catch(() => {});
          } catch { /* pub key file not found — skip */ }
        }
      } else {
        warnings.push('Member was offline — could not clear auth credentials');
      }
    } catch {
      warnings.push('Could not connect to member — auth credentials may still be present');
    }
  }

  strategy.close();

  // Clean up local key files only if no other member shares this key
  if (agent.keyPath) {
    const sharedKey = getAllAgents().some(a => a.id !== agent.id && a.keyPath === agent.keyPath);
    if (!sharedKey) {
      try { fs.unlinkSync(agent.keyPath); } catch {}
      try { fs.unlinkSync(`${agent.keyPath}.pub`); } catch {}
    }
  }

  // Clean up known_hosts entry
  if (agent.host && agent.port) {
    removeKnownHost(agent.host, agent.port);
  }

  const removed = removeFromRegistry(agent.id);
  writeStatusline();

  if (removed) {
    let result = `✅ Member "${agent.friendlyName}" (${agent.id}) has been removed.\n\nTo refresh the member list in your UI, run /mcp and select Reconnect.`;
    if (warnings.length > 0) {
      result += `\n\n⚠️ Warnings:\n`;
      for (const w of warnings) {
        result += `  - ${w}\n`;
      }
    }
    return result;
  }
  return `Failed to remove member "${agent.id}".`;
}
