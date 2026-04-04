import { z } from 'zod';
import fs from 'node:fs';
import { removeAgent as removeFromRegistry } from '../services/registry.js';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { getProvider } from '../providers/index.js';
import { getAgentOS } from '../utils/agent-helpers.js';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { removeKnownHost } from '../services/known-hosts.js';
import { writeStatusline } from '../services/statusline.js';
import type { Agent } from '../types.js';

export const removeMemberSchema = z.object({
  ...memberIdentifier,
});

export type RemoveMemberInput = z.infer<typeof removeMemberSchema>;

export async function removeMember(input: RemoveMemberInput): Promise<string> {
  const agentOrError = resolveMember(input.member_id, input.member_name);
  if (typeof agentOrError === 'string') return agentOrError;
  const agent = agentOrError as Agent;

  const strategy = getStrategy(agent);
  const warnings: string[] = [];

  // Best-effort: clear auth credentials from the member before removing
  // Skip for local members — their credentials belong to the host machine
  if (agent.agentType === 'remote') {
    try {
      const conn = await strategy.testConnection();
      if (conn.ok) {
        const cmds = getOsCommands(getAgentOS(agent));
        const provider = getProvider(agent.llmProvider);

        // Remove credentials file (only for providers that use one, e.g. Claude OAuth)
        if (provider.supportsOAuthCopy()) {
          await strategy.execCommand(cmds.credentialFileRemove(), 10000).catch(() => {});
        }

        // Remove the provider's API key env var from shell profiles
        for (const cmd of cmds.unsetEnv(provider.authEnvVar)) {
          await strategy.execCommand(cmd, 10000).catch(() => {});
        }
      } else {
        warnings.push('Member was offline — could not clear auth credentials');
      }
    } catch {
      warnings.push('Could not connect to member — auth credentials may still be present');
    }
  }

  strategy.close();

  // Clean up local key files (before registry removal loses the reference)
  if (agent.keyPath) {
    try { fs.unlinkSync(agent.keyPath); } catch {}
    try { fs.unlinkSync(`${agent.keyPath}.pub`); } catch {}
  }

  // Clean up known_hosts entry
  if (agent.host && agent.port) {
    removeKnownHost(agent.host, agent.port);
  }

  const removed = removeFromRegistry(agent.id);
  writeStatusline();

  if (removed) {
    let result = `✅ Member "${agent.friendlyName}" (${agent.id}) has been removed.`;
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
