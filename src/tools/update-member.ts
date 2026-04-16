import { z } from 'zod';
import { updateAgent as updateInRegistry, hasDuplicateFolder } from '../services/registry.js';
import { encryptPassword } from '../utils/crypto.js';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { collectOobPassword } from '../services/auth-socket.js';
import { isValidIcon, resolveIcon, DEFAULT_ICON } from '../services/icons.js';
import { writeStatusline } from '../services/statusline.js';
import type { Agent } from '../types.js';

export const updateMemberSchema = z.object({
  ...memberIdentifier,
  friendly_name: z.string()
    .min(1).max(64)
    .regex(/^[a-zA-Z0-9._-]+$/, 'Only letters, numbers, dots, dashes, and underscores')
    .optional()
    .describe('New friendly name'),
  host: z.string()
    .regex(/^[^<>\n\r]+$/, 'host must not contain angle brackets or newlines')
    .optional()
    .describe('New host (remote members only)'),
  port: z.number().optional().describe('New SSH port (remote members only)'),
  username: z.string().optional().describe('New SSH username (remote members only)'),
  auth_type: z.enum(['password', 'key']).optional().describe('New auth method (remote members only)'),
  password: z.string().optional().describe('New SSH password. Omit for secure out-of-band entry — a password prompt will open in a separate terminal window.'),
  rotate_password: z.boolean().optional().describe(
    'Trigger secure out-of-band password re-entry for a member already using password auth. '
    + 'A password prompt will open in a separate terminal window. Ignored if auth_type is not password.'
  ),
  key_path: z.string().optional().describe('Path to SSH private key. Used for both regular SSH connections and cloud instance lifecycle.'),
  work_folder: z.string()
    .regex(/^[^<>\n\r]+$/, 'work_folder must not contain angle brackets or newlines')
    .optional()
    .describe('New working directory on target machine'),
  git_access: z.enum(['read', 'push', 'admin', 'issues', 'full']).optional().describe('Git access level for this member'),
  git_repos: z.array(z.string()).optional().describe('Git repositories this member can access (e.g. ["Apra-Labs/ApraPipes"])'),
  icon: z.string().optional().describe('Override the auto-assigned emoji icon. Use named aliases: blue-circle, green-square, red-circle, etc. (8 colors × 2 shapes: circle, square). Or pass raw emoji.'),
  // Cloud fields
  cloud_region: z.string().optional().describe('AWS region for the cloud instance'),
  cloud_profile: z.string().optional().describe('AWS CLI profile name'),
  cloud_idle_timeout_min: z.number().optional().describe('Minutes of inactivity before auto-stop'),
  cloud_activity_command: z.string().min(1).optional().describe('Custom shell command for workload detection. Must output "busy" or "idle". Pass empty string to clear.'),
  llm_provider: z.enum(['claude', 'gemini', 'codex', 'copilot']).optional().describe('Change the LLM provider for this member.'),
});

export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;

export async function updateMember(input: UpdateMemberInput): Promise<string> {
  const existingOrError = resolveMember(input.member_id, input.member_name);
  if (typeof existingOrError === 'string') return existingOrError;
  const existing = existingOrError as Agent;

  // Check for duplicate folder whenever identity fields (host, port, or work_folder) change.
  // For remote members: fire on any identity-field change (host, port, or folder).
  // For local members: fire only on folder change (host/port are not part of local identity).
  const hostChanged = input.host !== undefined && input.host !== existing.host;
  const portChanged = input.port !== undefined && input.port !== existing.port;
  const folderChanged = input.work_folder !== undefined && input.work_folder !== existing.workFolder;

  const needsUniquenessCheck = existing.agentType === 'remote'
    ? (hostChanged || portChanged || folderChanged)
    : folderChanged;

  if (needsUniquenessCheck) {
    const newHost = input.host ?? existing.host;
    const newPort = input.port ?? existing.port;
    const newFolder = input.work_folder ?? existing.workFolder;
    if (hasDuplicateFolder(existing.agentType, newFolder, newHost, newPort, existing.id)) {
      const scope = existing.agentType === 'local' ? 'this machine' : `host ${newHost}:${newPort}`;
      return `❌ Another member already uses folder "${newFolder}" on ${scope}. Update rejected.`;
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
    if ('fallback' in oob) return oob.fallback ?? 'Error: OOB operation cancelled.';
    preEncryptedPassword = oob.password;
  }

  const updates: Record<string, unknown> = {};
  const warnings: string[] = [];

  if (resolvedIcon) updates.icon = resolvedIcon;
  if (input.friendly_name) updates.friendlyName = input.friendly_name;
  if (input.llm_provider !== undefined) updates.llmProvider = input.llm_provider;
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
  const cloudFields = ['cloud_region', 'cloud_profile', 'cloud_idle_timeout_min', 'cloud_activity_command'] as const;
  const passedCloudFields = cloudFields.filter(f => input[f] !== undefined);

  if (passedCloudFields.length > 0) {
    if (existing.cloud) {
      const updatedCloud = { ...existing.cloud };
      if (input.cloud_region) updatedCloud.region = input.cloud_region;
      if (input.cloud_profile !== undefined) updatedCloud.profile = input.cloud_profile || undefined;
      if (input.cloud_idle_timeout_min) updatedCloud.idleTimeoutMin = input.cloud_idle_timeout_min;
      if (input.cloud_activity_command !== undefined) {
        updatedCloud.activityCommand = input.cloud_activity_command || undefined;
      }
      updates.cloud = updatedCloud;
    } else {
      warnings.push(`Warning: cloud fields (${passedCloudFields.join(', ')}) are ignored for non-cloud members.`);
    }
  }

  const updated = updateInRegistry(existing.id, updates);
  if (!updated) {
    return `Failed to update member "${existing.id}".`;
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

  if (warnings.length > 0) {
    result += '\n';
    for (const w of warnings) {
      result += `⚠️ ${w}\n`;
    }
  }

  return result;
}
