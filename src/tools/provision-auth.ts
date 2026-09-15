import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { getProvider } from '../providers/index.js';
import { escapeDoubleQuoted } from '../utils/shell-escape.js';
import { getAgentOS, getAgentShell, touchAgent } from '../utils/agent-helpers.js';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { validateCredentials, credentialStatusNote } from '../utils/credential-validation.js';
import { credentialResolve } from '../services/credential-store.js';
import { encryptPassword, decryptPassword } from '../utils/crypto.js';
import { updateAgent } from '../services/registry.js';
import { collectOobApiKey } from '../services/auth-socket.js';
import { logLine } from '../utils/log-helpers.js';
import { invalidatePreflightCache } from '../services/preflight-check.js';
import type { Agent } from '../types.js';
import type { ProviderAdapter } from '../providers/index.js';

export const provisionAuthSchema = z.object({
  ...memberIdentifier,
  api_key: z.string().optional().describe(
    `Your AI provider API key. If omitted, your local OAuth session is copied to the member instead. Supports {{secure.NAME}} token -- value is resolved from the credential store before use.`
  ),
});

export type ProvisionAuthInput = z.infer<typeof provisionAuthSchema>;

/**
 * Machine-readable reason code for every distinct outcome provision_llm_auth
 * previously expressed only as prose (apra-fleet-3swo.7.2). A programmatic
 * caller branches on `structuredContent.reason`; the human summary in `text`
 * stays the human-facing form and only its ASCII decoration changed.
 */
export type ProvisionAuthReason =
  /** Credentials deployed and verified. */
  | 'ok'
  /** Deployed, but the post-deploy auth verification did not confirm. ok=true. */
  | 'deployed_unverified'
  /** API key deployed, but one or more shell-profile writes reported errors. ok=true. */
  | 'deployed_with_errors'
  /** Local members use this machine's own session; nothing to provision. ok=true. */
  | 'skipped_local_member'
  /** No member matched member_id/member_name. */
  | 'member_not_found'
  /** The member is unreachable. */
  | 'member_offline'
  /** A {{secure.NAME}} token in api_key names no stored credential. */
  | 'secure_credential_not_found'
  /** A {{secure.NAME}} token resolved to a credential this member may not use. */
  | 'secure_credential_denied'
  /** A {{secure.NAME}} token resolved to an expired credential. */
  | 'secure_credential_expired'
  /** This provider exposes no OAuth credential files to copy. */
  | 'oauth_not_supported'
  /** The local OAuth token is expired and carries no refresh token. */
  | 'oauth_token_expired_no_refresh'
  /** A local credential file named by the provider does not exist. */
  | 'oauth_credential_file_missing'
  /** Writing a credential file onto the member failed. */
  | 'oauth_credential_write_failed'
  /** Merging provider settings on the member failed. */
  | 'oauth_settings_merge_failed'
  /** Reading/copying a local credential file threw. */
  | 'oauth_copy_failed'
  /** Out-of-band API-key collection was cancelled or returned no key. */
  | 'oob_cancelled';

interface ProvisionAuthFields {
  /** True when credentials were deployed (verified or not). */
  ok: boolean;
  /** Machine-readable outcome code. Branch on this, never on `text`. */
  reason: ProvisionAuthReason;
  /**
   * The resolved ProviderAdapter's own name (src/providers/index.ts registers
   * claude, codex, copilot, agy, opencode and none -- there is no gemini
   * adapter), or null when no member/provider could be resolved.
   */
  provider: string | null;
  /**
   * What was deployed, never the secret itself: the environment-variable name
   * for the API-key flow (e.g. ANTHROPIC_API_KEY) or 'oauth' for the
   * credential-file copy flow. Null when nothing was deployed.
   */
  credentialLabel: string | null;
  /**
   * Credential expiry as an ISO timestamp, or null meaning "no expiry tracked
   * -> OK" (the same reading checkVcsTokenExpiry applies server-side).
   * Populated only when the copied OAuth credential file exposes one; the
   * ProviderAdapter interface has no expiry hook, so a provider whose
   * credential file carries no expiry always reports null.
   */
  expiresAt: string | null;
  /** True when the post-deploy auth check actually confirmed working auth. */
  verified: boolean;
  /** Registry id of the resolved member, or null. */
  memberId: string | null;
  /** Friendly name of the resolved member, or null. */
  memberName: string | null;
}

export interface ProvisionAuthStructured extends ProvisionAuthFields {
  [key: string]: unknown;
}

export interface ProvisionAuthResult {
  text: string;
  structuredContent: ProvisionAuthStructured;
}

const OK_REASONS: ProvisionAuthReason[] = ['ok', 'deployed_unverified', 'deployed_with_errors', 'skipped_local_member'];

/**
 * Resolve a provider's display name for the structured payload without ever
 * throwing (apra-fleet-3swo.9). getProvider() throws a TypeError for any
 * llmProvider value outside the six registered adapters, and only defaults
 * to claude when the value is null/undefined -- so a registry entry carrying
 * a retired or hand-edited provider string would otherwise turn the
 * local-member skip and offline early-returns below into a thrown MCP
 * protocol error (wrapTool has no try/catch) instead of their intended clean
 * message. Falls back to the raw stored value, or null when there is none.
 */
function safeProviderName(llmProvider: Agent['llmProvider']): string | null {
  try {
    return getProvider(llmProvider).name;
  } catch {
    return llmProvider ?? null;
  }
}

function authResult(
  text: string,
  fields: Partial<ProvisionAuthFields> & { reason: ProvisionAuthReason },
): ProvisionAuthResult {
  return {
    text,
    structuredContent: {
      ok: fields.ok ?? OK_REASONS.includes(fields.reason),
      reason: fields.reason,
      provider: fields.provider ?? null,
      credentialLabel: fields.credentialLabel ?? null,
      expiresAt: fields.expiresAt ?? null,
      verified: fields.verified ?? false,
      memberId: fields.memberId ?? null,
      memberName: fields.memberName ?? null,
    },
  };
}

/**
 * Credential-file expiry, normalized to ISO, or null when the file exposes
 * none. Mirrors validateCredentials()'s own (Claude-shaped) parse rather than
 * inventing a second convention; any provider whose credential JSON has no
 * such field simply yields null, which reads as "no expiry tracked -> OK".
 */
function extractCredentialExpiresAt(json: string): string | null {
  try {
    const parsed = JSON.parse(json);
    const raw = parsed?.claudeAiOauth?.expiresAt;
    if (raw === undefined || raw === null) return null;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
}

/**
 * Real auth check via `claude -p "hello"` -- makes an actual API call.
 * This is the only reliable validation for both OAuth and API key auth,
 * since `claude auth status` doesn't actually validate API keys.
 * Claude-only: other providers use a version check for verification.
 */
async function verifyWithClaudePrompt(agent: Agent, envPrefix?: string): Promise<boolean> {
  const cmds = getOsCommands(getAgentOS(agent), getAgentShell(agent));
  const provider = getProvider('claude');
  const strategy = getStrategy(agent);
  const escapedFolder = escapeDoubleQuoted(agent.workFolder);
  const prefix = envPrefix ? `${envPrefix} ` : '';
  const cmd = `cd "${escapedFolder}" && ${prefix}${cmds.agentCommand(provider, '-p "hello" --output-format json --max-turns 1')}`;
  try {
    const result = await strategy.execCommand(cmd, 60000);
    return result.code === 0;
  } catch {
    return false;
  }
}

/**
 * Version-based CLI check with optional env prefix.
 * Used to verify non-Claude providers after API key provisioning.
 */
async function verifyWithVersion(agent: Agent, provider: ProviderAdapter, envPrefix?: string): Promise<boolean> {
  const cmds = getOsCommands(getAgentOS(agent), getAgentShell(agent));
  const strategy = getStrategy(agent);
  const prefix = envPrefix ? `${envPrefix} ` : '';
  const cmd = `${prefix}${cmds.agentVersion(provider)}`;
  try {
    const result = await strategy.execCommand(cmd, 30000);
    return result.code === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Flow A: Copy OAuth credentials using the provider interface
// ---------------------------------------------------------------------------
async function provisionOAuthCopy(agent: Agent, provider: ProviderAdapter): Promise<ProvisionAuthResult> {
  const cmds = getOsCommands(getAgentOS(agent), getAgentShell(agent));
  const strategy = getStrategy(agent);
  // Identity fields every return path below shares. `credentialLabel: 'oauth'`
  // names the FLOW, never the secret -- no plaintext credential is ever placed
  // in the structured payload.
  const who = { provider: provider.name, memberId: agent.id, memberName: agent.friendlyName };

  const credentialFiles = provider.oauthCredentialFiles();
  if (!credentialFiles || credentialFiles.length === 0) {
    return authResult(`[FAIL] Provider "${provider.name}" does not support OAuth credential copy.`,
      { ...who, reason: 'oauth_not_supported' });
  }

  // 1. Copy credential files
  let credStatus: ReturnType<typeof validateCredentials> | null = null;
  let expiresAt: string | null = null;
  for (const file of credentialFiles) {
    try {
      const localPath = file.localPath.replace('~', os.homedir());
      if (fs.existsSync(localPath)) {
        const content = fs.readFileSync(localPath, 'utf-8');
        // Validate credentials before sending
        if (file.localPath.includes('.json')) {
            credStatus = validateCredentials(content);
            expiresAt = extractCredentialExpiresAt(content) ?? expiresAt;
            if (credStatus?.status === 'expired-no-refresh') {
              return authResult(`[FAIL] OAuth token in ${file.localPath} is expired with no refresh token.
`
                + `  Run /login in your ${provider.name} session, then re-run provision_llm_auth.`,
                { ...who, reason: 'oauth_token_expired_no_refresh', expiresAt });
            }
        }
        const result = await strategy.execCommand(cmds.credentialFileWrite(content, file.remotePath), 10000);
        if (result.code !== 0 && result.stderr) {
          return authResult(`[FAIL] Failed to write ${file.remotePath} on "${agent.friendlyName}": ${result.stderr}`,
            { ...who, reason: 'oauth_credential_write_failed', expiresAt });
        }
      } else {
        return authResult(`[FAIL] Could not find local credential file: ${localPath}`,
          { ...who, reason: 'oauth_credential_file_missing' });
      }
    } catch (err: any) {
      return authResult(`[FAIL] Failed to copy ${file.localPath} to "${agent.friendlyName}": ${err.message}`,
        { ...who, reason: 'oauth_copy_failed', expiresAt });
    }
  }

  // 2. Merge settings
  const mergeObj = provider.oauthSettingsMerge();
  if (mergeObj) {
    const settingsFile = credentialFiles.find(f => f.remotePath.includes('settings.json'));
    const remoteSettingsPath = settingsFile ? settingsFile.remotePath : `${provider.credentialPath.replace(/\/$/, '')}/settings.json`;
    try {
      const result = await strategy.execCommand(cmds.deepMergeJson(remoteSettingsPath, mergeObj), 10000);
      if (result.code !== 0 && result.stderr) {
        return authResult(`[FAIL] Failed to merge settings on "${agent.friendlyName}": ${result.stderr}`,
          { ...who, reason: 'oauth_settings_merge_failed', expiresAt });
      }
    } catch (err: any) {
      return authResult(`[FAIL] Failed to merge settings on "${agent.friendlyName}": ${err.message}`,
        { ...who, reason: 'oauth_settings_merge_failed', expiresAt });
    }
  }

  // 3. Unset env vars
  const varsToUnset = provider.oauthEnvVarsToUnset() ?? [];
  for (const envVar of varsToUnset) {
    const unsetCmds = cmds.unsetEnv(envVar);
    for (const cmd of unsetCmds) {
      // Best effort, fire and forget
      await strategy.execCommand(cmd, 15000).catch(() => {});
    }
  }

  // 4. Verify auth
  const authWorks = provider.name === 'claude'
    ? await verifyWithClaudePrompt(agent)
    : await verifyWithVersion(agent, provider);

  touchAgent(agent.id);

  const statusNote = credentialStatusNote(credStatus);
  const suffix = statusNote ? `\n  ${statusNote}` : '';

  if (authWorks) {
    return authResult(`[OK] OAuth credentials for ${provider.name} deployed to "${agent.friendlyName}"
`
      + `  Auth: verified with a successful ${provider.name} API call.${suffix}`,
      { ...who, reason: 'ok', credentialLabel: 'oauth', expiresAt, verified: true });
  }

  return authResult(`[WARN] ${provider.name} OAuth credentials deployed to "${agent.friendlyName}" but could not verify auth.
`
    + `  Credential files were written -- try running a prompt to confirm.${suffix}`,
    { ...who, reason: 'deployed_unverified', credentialLabel: 'oauth', expiresAt, verified: false });
}


// ---------------------------------------------------------------------------
// Flow B -- API Key Override (all providers)
// ---------------------------------------------------------------------------

async function provisionApiKey(agent: Agent, apiKey: string, provider: ProviderAdapter): Promise<ProvisionAuthResult> {
  const cmds = getOsCommands(getAgentOS(agent), getAgentShell(agent));
  const strategy = getStrategy(agent);
  const envVarName = provider.authEnvVarForToken(apiKey);
  const commands = cmds.setEnv(envVarName, apiKey);

  const errors: string[] = [];
  for (const cmd of commands) {
    try {
      const result = await strategy.execCommand(cmd, 15000);
      if (result.code !== 0 && result.stderr) {
        errors.push(`Command "${cmd.substring(0, 40)}..." stderr: ${result.stderr}`);
      }
    } catch (err: any) {
      errors.push(`Command failed: ${err.message}`);
    }
  }

  // Store encrypted API key in the agent's registry entry
  updateAgent(agent.id, {
    encryptedEnvVars: { ...agent.encryptedEnvVars, [envVarName]: encryptPassword(apiKey) },
  });

  // Verify the key was persisted in a new shell
  let verified = false;
  try {
    const verifyResult = await strategy.execCommand(cmds.apiKeyCheck(envVarName), 10000);
    verified = verifyResult.stdout.trim().length > 5;
  } catch {
    // May still work after re-login
  }

  // Verify with a real CLI call
  const envPrefix = cmds.envPrefix(envVarName, apiKey);
  const authWorks = provider.name === 'claude'
    ? await verifyWithClaudePrompt(agent, envPrefix)
    : await verifyWithVersion(agent, provider, envPrefix);

  touchAgent(agent.id);

  let result = '';
  if (errors.length === 0) {
    result += `[OK] API key provisioned on "${agent.friendlyName}"
`;
  } else {
    result += `[WARN] API key provisioned with some issues on "${agent.friendlyName}":
`;
    for (const e of errors) {
      result += `  - ${e}
`;
    }
  }

  result += `
  Environment: ${envVarName} set in shell profiles and stored in member config
`;
  result += `  Verification: ${verified ? 'Key visible in new shell' : 'Key will be available after re-login'}
`;
  result += `  Auth test: ${authWorks ? `${provider.name} CLI authenticated successfully` : 'Could not verify -- may need to re-login'}
`;

  // credentialLabel is the env var the key was deployed under (e.g.
  // ANTHROPIC_API_KEY) -- a name, never the key itself. An API key carries no
  // expiry the server can observe, so expiresAt stays null ("no expiry
  // tracked -> OK").
  return authResult(result, {
    provider: provider.name,
    memberId: agent.id,
    memberName: agent.friendlyName,
    reason: errors.length === 0 ? 'ok' : 'deployed_with_errors',
    credentialLabel: envVarName,
    expiresAt: null,
    verified: authWorks,
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function provisionAuth(input: ProvisionAuthInput): Promise<ProvisionAuthResult> {
  const agentOrError = resolveMember(input.member_id, input.member_name);
  if (typeof agentOrError === 'string') {
    return authResult(agentOrError, {
      reason: 'member_not_found',
      memberId: input.member_id ?? null,
      memberName: input.member_name ?? null,
    });
  }
  const agent = agentOrError as Agent;
  const who = { memberId: agent.id, memberName: agent.friendlyName };

  if (agent.agentType === 'local') {
    return authResult(`[SKIP] Skipping "${agent.friendlyName}" -- local members use this machine's credentials directly.`,
      { ...who, reason: 'skipped_local_member', provider: safeProviderName(agent.llmProvider) });
  }

  const strategy = getStrategy(agent);
  const conn = await strategy.testConnection();
  if (!conn.ok) {
    return authResult(`[FAIL] Member "${agent.friendlyName}" is offline: ${conn.error}`,
      { ...who, reason: 'member_offline', provider: safeProviderName(agent.llmProvider) });
  }

  // getProvider() defaults to claude ONLY when llmProvider is null/undefined;
  // every registered adapter (claude, codex, copilot, agy, opencode, none)
  // reports its own `name` into the structured payload below, so nothing here
  // assumes Claude-specific credential fields.
  const provider = getProvider(agent.llmProvider);

  // Every success path logs and invalidates the preflight cache; the
  // `ok` discriminator replaces the old "does the text start with the failure
  // emoji" test, which was the only signal before apra-fleet-3swo.7.2.
  const onSuccess = (result: ProvisionAuthResult): ProvisionAuthResult => {
    if (result.structuredContent.ok) {
      logLine('provision_llm_auth', `provider=${provider.name}`, agent);
      invalidatePreflightCache(agent.id);
    }
    return result;
  };

  // Flow B: API key is provided directly
  if (input.api_key) {
    const TOKEN_RE = /\{\{secure\.([a-zA-Z0-9_-]{1,64})\}\}/g;
    const tokenNames = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = TOKEN_RE.exec(input.api_key)) !== null) tokenNames.add(match[1]);
    let resolvedKey = input.api_key;
    for (const name of tokenNames) {
      const entry = credentialResolve(name, agent.friendlyName);
      const secureFailure = { ...who, provider: provider.name };
      if (!entry) {
        return authResult(`[FAIL] Credential "${name}" not found. Run credential_store_set first.`,
          { ...secureFailure, reason: 'secure_credential_not_found' });
      }
      if ('denied' in entry) {
        return authResult(`[FAIL] ${entry.denied}`, { ...secureFailure, reason: 'secure_credential_denied' });
      }
      if ('expired' in entry) {
        return authResult(`[FAIL] ${entry.expired}`, { ...secureFailure, reason: 'secure_credential_expired' });
      }
      resolvedKey = resolvedKey.replaceAll(`{{secure.${name}}}`, entry.plaintext);
    }
    return onSuccess(await provisionApiKey(agent, resolvedKey, provider));
  }

  // Flow A: OAuth credentials copy
  if (provider.oauthCredentialFiles()?.length) {
    return onSuccess(await provisionOAuthCopy(agent, provider));
  }

  // Fallback: OOB key collection for non-OAuth or non-copyable providers
  const oob = await collectOobApiKey(agent.friendlyName, 'provision_llm_auth', {
    prompt: `Enter API key for ${provider.name} on ${agent.friendlyName}`,
  });
  if ('fallback' in oob) {
    return authResult(oob.fallback ?? 'Error: OOB operation cancelled.',
      { ...who, provider: provider.name, reason: 'oob_cancelled' });
  }
  return onSuccess(await provisionApiKey(agent, decryptPassword(oob.password!), provider));
}
