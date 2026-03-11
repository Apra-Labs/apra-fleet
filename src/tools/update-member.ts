import { z } from 'zod';
import { updateAgent as updateInRegistry, hasDuplicateFolder } from '../services/registry.js';
import { encryptPassword } from '../utils/crypto.js';
import { getAgentOrFail } from '../utils/agent-helpers.js';
import type { Agent } from '../types.js';

export const updateMemberSchema = z.object({
  member_id: z.string().describe('The UUID of the member (worker) to update'),
  friendly_name: z.string()
    .min(1).max(64)
    .regex(/^[a-zA-Z0-9._-]+$/, 'Only letters, numbers, dots, dashes, and underscores')
    .optional()
    .describe('New friendly name'),
  host: z.string().optional().describe('New host (remote members only)'),
  port: z.number().optional().describe('New SSH port (remote members only)'),
  username: z.string().optional().describe('New SSH username (remote members only)'),
  auth_type: z.enum(['password', 'key']).optional().describe('New auth method (remote members only)'),
  password: z.string().optional().describe('New SSH password'),
  key_path: z.string().optional().describe('New path to SSH private key'),
  work_folder: z.string().optional().describe('New working directory on target machine'),
  git_access: z.enum(['read', 'push', 'admin', 'issues', 'full']).optional().describe('Git access level for this member'),
  git_repos: z.array(z.string()).optional().describe('Git repositories this member can access (e.g. ["Apra-Labs/ApraPipes"])'),
});

export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;

export async function updateMember(input: UpdateMemberInput): Promise<string> {
  const existingOrError = getAgentOrFail(input.member_id);
  if (typeof existingOrError === 'string') return existingOrError;
  const existing = existingOrError as Agent;

  // Check for duplicate folder if work_folder is being changed
  if (input.work_folder && input.work_folder !== existing.workFolder) {
    const host = input.host ?? existing.host;
    if (hasDuplicateFolder(existing.agentType, input.work_folder, host, existing.id)) {
      const scope = existing.agentType === 'local' ? 'this machine' : `host ${host}`;
      return `❌ Another member already uses folder "${input.work_folder}" on ${scope}. Update rejected.`;
    }
  }

  const updates: Record<string, unknown> = {};

  if (input.friendly_name) updates.friendlyName = input.friendly_name;
  if (input.host) updates.host = input.host;
  if (input.port) updates.port = input.port;
  if (input.username) updates.username = input.username;
  if (input.auth_type) updates.authType = input.auth_type;
  if (input.password) updates.encryptedPassword = encryptPassword(input.password);
  if (input.key_path) updates.keyPath = input.key_path;
  if (input.work_folder) updates.workFolder = input.work_folder;
  if (input.git_access) updates.gitAccess = input.git_access;
  if (input.git_repos) updates.gitRepos = input.git_repos;

  const updated = updateInRegistry(input.member_id, updates);
  if (!updated) {
    return `Failed to update member "${input.member_id}".`;
  }

  let result = `✅ Member "${updated.friendlyName}" updated.\n\n`;
  result += `  ID:      ${updated.id}\n`;
  result += `  Name:    ${updated.friendlyName}\n`;
  result += `  Type:    ${updated.agentType}\n`;
  if (updated.agentType === 'remote') {
    result += `  Host:    ${updated.host}:${updated.port}\n`;
  }
  result += `  Folder:  ${updated.workFolder}\n`;
  if (updated.authType) {
    result += `  Auth:    ${updated.authType}\n`;
  }

  return result;
}
