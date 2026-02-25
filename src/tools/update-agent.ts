import { z } from 'zod';
import { getAgent, updateAgent as updateInRegistry } from '../services/registry.js';
import { encryptPassword } from '../utils/crypto.js';

export const updateAgentSchema = z.object({
  agent_id: z.string().describe('The UUID of the agent to update'),
  friendly_name: z.string().optional().describe('New friendly name'),
  host: z.string().optional().describe('New host'),
  port: z.number().optional().describe('New SSH port'),
  username: z.string().optional().describe('New SSH username'),
  auth_type: z.enum(['password', 'key']).optional().describe('New auth method'),
  password: z.string().optional().describe('New SSH password'),
  key_path: z.string().optional().describe('New path to SSH private key'),
  remote_folder: z.string().optional().describe('New working directory on remote'),
});

export type UpdateAgentInput = z.infer<typeof updateAgentSchema>;

export async function updateAgent(input: UpdateAgentInput): Promise<string> {
  const existing = getAgent(input.agent_id);
  if (!existing) {
    return `Agent "${input.agent_id}" not found.`;
  }

  const updates: Record<string, unknown> = {};

  if (input.friendly_name) updates.friendlyName = input.friendly_name;
  if (input.host) updates.host = input.host;
  if (input.port) updates.port = input.port;
  if (input.username) updates.username = input.username;
  if (input.auth_type) updates.authType = input.auth_type;
  if (input.password) updates.encryptedPassword = encryptPassword(input.password);
  if (input.key_path) updates.keyPath = input.key_path;
  if (input.remote_folder) updates.remoteFolder = input.remote_folder;

  const updated = updateInRegistry(input.agent_id, updates);
  if (!updated) {
    return `Failed to update agent "${input.agent_id}".`;
  }

  let result = `✅ Agent "${updated.friendlyName}" updated.\n\n`;
  result += `  ID:      ${updated.id}\n`;
  result += `  Name:    ${updated.friendlyName}\n`;
  result += `  Host:    ${updated.host}:${updated.port}\n`;
  result += `  Folder:  ${updated.remoteFolder}\n`;
  result += `  Auth:    ${updated.authType}\n`;

  return result;
}
