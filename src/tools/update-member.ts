import { z } from 'zod';
import { updateAgent as updateInRegistry, hasDuplicateFolder } from '../services/registry.js';
import { encryptPassword } from '../utils/crypto.js';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { collectOobPassword } from '../services/auth-socket.js';
import { credentialResolve } from '../services/credential-store.js';
import { isValidIcon, resolveIcon, DEFAULT_ICON } from '../services/icons.js';
import { writeStatusline } from '../services/statusline.js';
import { logLine } from '../utils/log-helpers.js';
import type { Agent } from '../types.js';
import { CURATED_CHEAP_MODELS, CURATED_STANDARD_MODELS, CURATED_PREMIUM_MODELS } from '../cli/config.js';
import { validateOpenCodeModelTiers } from '../utils/opencode-model-validation.js';
import { provisionAgents } from '../services/agent-provisioner.js';
import { getStrategy } from '../services/strategy.js';

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
  password: z.string().optional().describe('New SSH password. Omit for secure out-of-band entry — a password prompt will open in a separate terminal window. Supports {{secure.NAME}} token — value is resolved from the credential store before use.'),
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
  cloud_activity_command: z.string().optional().describe('Custom shell command for workload detection. Must output "busy" or "idle". Pass empty string to clear.'),
  llm_provider: z.enum(['claude', 'gemini', 'codex', 'copilot', 'agy', 'opencode']).optional().describe('Change the LLM provider for this member.'),
  model_cheap: z.enum(CURATED_CHEAP_MODELS).optional().describe('Change custom cheap model'),
  model_standard: z.enum(CURATED_STANDARD_MODELS).optional().describe('Change custom standard model'),
  model_premium: z.enum(CURATED_PREMIUM_MODELS).optional().describe('Change custom premium model'),
  model_tiers: z.object({
    cheap: z.string().optional(),
    standard: z.string().optional(),
    premium: z.string().optional(),
  }).optional().describe('Per-member model tier map with free-form model IDs (e.g. "ollama/qwen3-coder:30b"). A single model fills all tiers. At least one model required.'),
  unattended: z.preprocess(
    (v) => v === false ? 'false' : v,
    z.enum(['false', 'auto', 'dangerous'])
  ).optional().describe('Permission mode for unattended execution. Pass "false" to reset to interactive prompts; "auto" = auto-approve safe operations; "dangerous" = skip all permission checks.'),
  category: z.string().max(64).optional().describe('Group label for this member (e.g. "doers", "reviewers"). Pass empty string to clear.'),
  tags: z.array(z.string().max(64, 'Each tag must be 64 characters or fewer'))
    .max(10, 'At most 10 tags are allowed')
    .optional()
    .describe('Free-form labels for this member (max 10 tags, each max 64 chars). Empty array clears all tags; non-empty array replaces existing tags.'),
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

  // Resolve {{secure.NAME}} tokens in password field
  let resolvedPassword = input.password;
  if (resolvedPassword) {
    const TOKEN_RE = /\{\{secure\.([a-zA-Z0-9_-]{1,64})\}\}/g;
    let match: RegExpExecArray | null;
    let resolved = resolvedPassword;
    const tokenNames = new Set<string>();
    while ((match = TOKEN_RE.exec(resolvedPassword)) !== null) {
      tokenNames.add(match[1]);
    }
    for (const name of tokenNames) {
      const entry = credentialResolve(name, existing.friendlyName);
      if (!entry) return `❌ Credential "${name}" not found. Run credential_store_set first. Member was NOT updated.`;
      if ('denied' in entry) return `❌ ${entry.denied} Member was NOT updated.`;
      if ('expired' in entry) return `❌ ${entry.expired} Member was NOT updated.`;
      resolved = resolved.replaceAll(`{{secure.${name}}}`, entry.plaintext);
    }
    resolvedPassword = resolved;
  }

  // Out-of-band password collection:
  // - switchingToPassword: changing from key → password auth without inline password
  // - rotatingPassword: explicit secure rotation on a member already using password auth
  let preEncryptedPassword: string | undefined;
  const switchingToPassword = input.auth_type === 'password' && existing.authType !== 'password';
  const rotatingPassword = !!input.rotate_password && existing.authType === 'password';
  if ((switchingToPassword || rotatingPassword) && !resolvedPassword && existing.agentType === 'remote') {
    const oob = await collectOobPassword(existing.friendlyName, 'update_member');
    if ('fallback' in oob) return oob.fallback ?? 'Error: OOB operation cancelled.';
    preEncryptedPassword = oob.password;
  }

  const updates: Record<string, unknown> = {};
  const warnings: string[] = [];

  // --- model_tiers normalization ---
  if (input.model_tiers !== undefined) {
    const values = Object.values(input.model_tiers).filter(Boolean) as string[];
    if (values.length === 0) {
      return '[-] model_tiers was provided but contains no models. Supply at least one model. Member was NOT updated.';
    }
    let normalizedModelTiers: { cheap?: string; standard?: string; premium?: string };
    if (values.length === 1) {
      normalizedModelTiers = { cheap: values[0], standard: values[0], premium: values[0] };
    } else {
      normalizedModelTiers = { ...input.model_tiers };
      const fallback = input.model_tiers.standard ?? input.model_tiers.cheap ?? values[0];
      if (!normalizedModelTiers.cheap) normalizedModelTiers.cheap = fallback;
      if (!normalizedModelTiers.standard) normalizedModelTiers.standard = fallback;
      if (!normalizedModelTiers.premium) normalizedModelTiers.premium = normalizedModelTiers.standard;
    }
    updates.modelTiers = normalizedModelTiers;

    // --- Validate opencode model_tiers against available models ---
    if (updates.modelTiers) {
      const effectiveProvider = (input.llm_provider ?? existing.llmProvider ?? 'claude');
      if (effectiveProvider === 'opencode') {
        const { warnings: tierWarnings } = await validateOpenCodeModelTiers(
          existing,
          updates.modelTiers as { cheap?: string; standard?: string; premium?: string },
        );
        warnings.push(...tierWarnings);
      }
    }
  }

  if (resolvedIcon) updates.icon = resolvedIcon;
  if (input.friendly_name) updates.friendlyName = input.friendly_name;
  if (input.llm_provider !== undefined) updates.llmProvider = input.llm_provider;
  if (input.category !== undefined) updates.category = input.category.trim() || undefined;
  if (input.tags !== undefined) updates.tags = input.tags.length === 0 ? undefined : input.tags;
  if (input.model_cheap !== undefined) updates.modelCheap = input.model_cheap;
  if (input.model_standard !== undefined) updates.modelStandard = input.model_standard;
  if (input.model_premium !== undefined) updates.modelPremium = input.model_premium;
  if (input.unattended !== undefined) updates.unattended = input.unattended === 'false' ? false : input.unattended;
  if (input.host) updates.host = input.host;
  if (input.port) updates.port = input.port;
  if (input.username) updates.username = input.username;
  if (input.auth_type) updates.authType = input.auth_type;
  if (preEncryptedPassword) {
    updates.encryptedPassword = preEncryptedPassword;
  } else if (resolvedPassword) {
    updates.encryptedPassword = encryptPassword(resolvedPassword);
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
  logLine('update_member', `id=${updated.id} name=${updated.friendlyName}`, updated);
  writeStatusline();

  // --- Re-provision role-agent files for remote members ---
  // Cheap (one probe round trip when up to date); also doubles as the manual retry
  // path when a prior registration/update left agent files stale or unprovisioned.
  // Does NOT start a stopped cloud member -- testConnection() failure just skips.
  let agentProvisionResult: { pushed: string[]; skippedReason?: string; warning?: string } | undefined;
  if (updated.agentType === 'remote') {
    const conn = await getStrategy(updated).testConnection();
    if (!conn.ok) {
      warnings.push(`Could not reach member -- agent files not re-provisioned: ${conn.error ?? 'connection failed'}`);
    } else {
      agentProvisionResult = await provisionAgents(updated);
      if (agentProvisionResult.warning) warnings.push(agentProvisionResult.warning);
    }
  }

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
  result += `  Provider: ${updated.llmProvider ?? 'claude'}\n`;
  if (updated.modelCheap) result += `  Model Cheap: ${updated.modelCheap}\n`;
  if (updated.modelStandard) result += `  Model Standard: ${updated.modelStandard}\n`;
  if (updated.modelPremium) result += `  Model Premium: ${updated.modelPremium}\n`;
  if (agentProvisionResult) {
    if (agentProvisionResult.skippedReason) {
      result += `  Agents:  skipped (${agentProvisionResult.skippedReason})\n`;
    } else if (agentProvisionResult.pushed.length > 0) {
      result += `  Agents:  ${agentProvisionResult.pushed.length} file(s) provisioned\n`;
    } else {
      result += `  Agents:  up to date\n`;
    }
  }
  if (updated.modelTiers) {
    const mt = updated.modelTiers;
    result += `  Model Tiers: cheap=${mt.cheap ?? '-'} standard=${mt.standard ?? '-'} premium=${mt.premium ?? '-'}\n`;
  }

  if (warnings.length > 0) {
    result += '\n';
    for (const w of warnings) {
      result += `⚠️ ${w}\n`;
    }
  }

  return result;
}
