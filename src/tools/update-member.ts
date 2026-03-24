import { z } from 'zod';
import { updateAgent as updateInRegistry, hasDuplicateFolder } from '../services/registry.js';
import { encryptPassword } from '../utils/crypto.js';
import { getAgentOrFail } from '../utils/agent-helpers.js';
import { collectOobPassword } from '../services/auth-socket.js';
import { isValidIcon, resolveIcon, DEFAULT_ICON } from '../services/icons.js';
import { writeStatusline } from '../services/statusline.js';
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
  password: z.string().optional().describe('New SSH password. Omit for secure out-of-band entry — a password prompt will open in a separate terminal window.'),
  rotate_password: z.boolean().optional().describe(
    'Trigger secure out-of-band password re-entry for a member already using password auth. '
    + 'A password prompt will open in a separate terminal window. Ignored if auth_type is not password.'
  ),
  key_path: z.string().optional().describe('New path to SSH private key'),
  work_folder: z.string().optional().describe('New working directory on target machine'),
  git_access: z.enum(['read', 'push', 'admin', 'issues', 'full']).optional().describe('Git access level for this member'),
  git_repos: z.array(z.string()).optional().describe('Git repositories this member can access (e.g. ["Apra-Labs/ApraPipes"])'),
  icon: z.string().optional().describe('Override the auto-assigned emoji icon. Use named aliases: blue-circle, green-square, red-circle, etc. (8 colors × 2 shapes: circle, square). Or pass raw emoji.'),
  // Cloud fields
  cloud_region: z.string().optional().describe('AWS region for the cloud instance'),
  cloud_profile: z.string().optional().describe('AWS CLI profile name'),
  cloud_idle_timeout_min: z.number().optional().describe('Minutes of inactivity before auto-stop'),
  cloud_ssh_key_path: z.string().optional().describe('Path to SSH private key for cloud lifecycle. Also updates the member key_path.'),
  cloud_activity_command: z.string().min(1).optional().describe('Custom shell command for workload detection. Must output "busy" or "idle". Pass empty string to clear.'),
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

  // Resolve named alias (e.g. "blue-circle" → "🔵") before validation
  const resolvedIcon = input.icon !== undefined ? resolveIcon(input.icon) : undefined;

  // Validate icon if provided
  if (resolvedIcon !== undefined && !isValidIcon(resolvedIcon)) {
    return `❌ Invalid icon "${input.icon}". Use a named alias (e.g., blue-circle, red-square, green-square) or a valid emoji.`;
  }

  // Out-of-band password collection:
  // - switchingToPassword: changing from key → password auth without inline password
  // - rotatingPassword: explicit secure rotation on a member already using password auth
  let preEncryptedPassword: string | undefined;
  const switchingToPassword = input.auth_type === 'password' && existing.authType !== 'password';
  const rotatingPassword = !!input.rotate_password && existing.authType === 'password';
  if ((switchingToPassword || rotatingPassword) && !input.password && existing.agentType === 'remote') {
    const oob = await collectOobPassword(existing.friendlyName, 'update_member');
    if ('fallback' in oob) return oob.fallback;
    preEncryptedPassword = oob.password;
  }

  const updates: Record<string, unknown> = {};

  if (resolvedIcon) updates.icon = resolvedIcon;
  if (input.friendly_name) updates.friendlyName = input.friendly_name;
  if (input.host) updates.host = input.host;
  if (input.port) updates.port = input.port;
  if (input.username) updates.username = input.username;
  if (input.auth_type) updates.authType = input.auth_type;
  if (preEncryptedPassword) {
    updates.encryptedPassword = preEncryptedPassword;
  } else if (input.password) {
    updates.encryptedPassword = encryptPassword(input.password);
  }
  if (input.key_path) updates.keyPath = input.key_path;
  if (input.work_folder) updates.workFolder = input.work_folder;
  if (input.git_access) updates.gitAccess = input.git_access;
  if (input.git_repos) updates.gitRepos = input.git_repos;

  // Cloud field updates: merge into existing cloud config
  if (input.cloud_ssh_key_path || input.cloud_region || input.cloud_profile !== undefined || input.cloud_idle_timeout_min || input.cloud_activity_command !== undefined) {
    if (existing.cloud) {
      const updatedCloud = { ...existing.cloud };
      if (input.cloud_region) updatedCloud.region = input.cloud_region;
      if (input.cloud_profile !== undefined) updatedCloud.profile = input.cloud_profile || undefined;
      if (input.cloud_idle_timeout_min) updatedCloud.idleTimeoutMin = input.cloud_idle_timeout_min;
      if (input.cloud_ssh_key_path) {
        updatedCloud.sshKeyPath = input.cloud_ssh_key_path;
        updates.keyPath = input.cloud_ssh_key_path; // keep top-level keyPath in sync (F4)
      }
      if (input.cloud_activity_command !== undefined) {
        updatedCloud.activityCommand = input.cloud_activity_command || undefined;
      }
      updates.cloud = updatedCloud;
    }
  }

  const updated = updateInRegistry(input.member_id, updates);
  if (!updated) {
    return `Failed to update member "${input.member_id}".`;
  }
  writeStatusline();

  let result = `✅ Member "${updated.friendlyName}" updated.\n\n`;
  result += `  Icon:    ${updated.icon ?? DEFAULT_ICON}\n`;
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
