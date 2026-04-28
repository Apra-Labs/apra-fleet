import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { getProvider } from '../providers/index.js';
import { escapeDoubleQuoted } from '../utils/shell-escape.js';
import { getAgentOS, touchAgent } from '../utils/agent-helpers.js';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { validateCredentials, credentialStatusNote } from '../utils/credential-validation.js';
import { credentialResolve } from '../services/credential-store.js';
import { encryptPassword, decryptPassword } from '../utils/crypto.js';
import { updateAgent } from '../services/registry.js';
import { collectOobApiKey } from '../services/auth-socket.js';
import type { Agent } from '../types.js';
import type { ProviderAdapter } from '../providers/index.js';

export const provisionAuthSchema = z.object({
  ...memberIdentifier,
  api_key: z.string().optional().describe(
    `Your AI provider API key. If omitted, your local OAuth session is copied to the member instead. Supports {{secure.NAME}} token — value is resolved from the credential store before use.`
  ),
});

export type ProvisionAuthInput = z.infer<typeof provisionAuthSchema>;

/**
 * Real auth check via `claude -p "hello"` — makes an actual API call.
 * This is the only reliable validation for both OAuth and API key auth,
 * since `claude auth status` doesn't actually validate API keys.
 * Claude-only: other providers use a version check for verification.
 */
async function verifyWithClaudePrompt(agent: Agent, envPrefix?: string): Promise<boolean> {
  const cmds = getOsCommands(getAgentOS(agent));
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
  const cmds = getOsCommands(getAgentOS(agent));
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
async function provisionOAuthCopy(agent: Agent, provider: ProviderAdapter): Promise<string> {
  const cmds = getOsCommands(getAgentOS(agent));
  const strategy = getStrategy(agent);

  const credentialFiles = provider.oauthCredentialFiles();
  if (!credentialFiles || credentialFiles.length === 0) {
    return `❌ Provider "${provider.name}" does not support OAuth credential copy.`;
  }

  // 1. Copy credential files
  let credStatus: ReturnType<typeof validateCredentials> | null = null;
  for (const file of credentialFiles) {
    try {
      const localPath = file.localPath.replace('~', os.homedir());
      if (fs.existsSync(localPath)) {
        const content = fs.readFileSync(localPath, 'utf-8');
        // Validate credentials before sending
        if (file.localPath.includes('.json')) {
            credStatus = validateCredentials(content);
            if (credStatus?.status === 'expired-no-refresh') {
              return `❌ OAuth token in ${file.localPath} is expired with no refresh token.
`
                + `  Run /login in your ${provider.name} session, then re-run provision_llm_auth.`;
            }
        }
        const result = await strategy.execCommand(cmds.credentialFileWrite(content, file.remotePath), 10000);
        if (result.code !== 0 && result.stderr) {
          return `❌ Failed to write ${file.remotePath} on "${agent.friendlyName}": ${result.stderr}`;
        }
      } else {
        return `❌ Could not find local credential file: ${localPath}`;
      }
    } catch (err: any) {
      return `❌ Failed to copy ${file.localPath} to "${agent.friendlyName}": ${err.message}`;
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
        return `❌ Failed to merge settings on "${agent.friendlyName}": ${result.stderr}`;
      }
    } catch (err: any) {
      return `❌ Failed to merge settings on "${agent.friendlyName}": ${err.message}`;
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
    return `✅ OAuth credentials for ${provider.name} deployed to "${agent.friendlyName}"
`
      + `  Auth: verified with a successful ${provider.name} API call.${suffix}`;
  }

  return `⚠️ ${provider.name} OAuth credentials deployed to "${agent.friendlyName}" but could not verify auth.
`
    + `  Credential files were written — try running a prompt to confirm.${suffix}`;
}


// ---------------------------------------------------------------------------
// Flow B — API Key Override (all providers)
// ---------------------------------------------------------------------------

async function provisionApiKey(agent: Agent, apiKey: string, provider: ProviderAdapter): Promise<string> {
  const cmds = getOsCommands(getAgentOS(agent));
  const strategy = getStrategy(agent);
  const envVarName = provider.authEnvVar;
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
    result += `✅ API key provisioned on "${agent.friendlyName}"
`;
  } else {
    result += `⚠️ API key provisioned with some issues on "${agent.friendlyName}":
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
  result += `  Auth test: ${authWorks ? `${provider.name} CLI authenticated successfully` : 'Could not verify — may need to re-login'}
`;

  return result;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function provisionAuth(input: ProvisionAuthInput): Promise<string> {
  const agentOrError = resolveMember(input.member_id, input.member_name);
  if (typeof agentOrError === 'string') return agentOrError;
  const agent = agentOrError as Agent;

  if (agent.agentType === 'local') {
    return `⏭️ Skipping "${agent.friendlyName}" — local members use this machine's credentials directly.`;
  }

  const strategy = getStrategy(agent);
  const conn = await strategy.testConnection();
  if (!conn.ok) {
    return `❌ Member "${agent.friendlyName}" is offline: ${conn.error}`;
  }

  const provider = getProvider(agent.llmProvider);

  // Flow B: API key is provided directly
  if (input.api_key) {
    const TOKEN_RE = /\{\{secure\.([a-zA-Z0-9_]{1,64})\}\}/g;
    const tokenNames = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = TOKEN_RE.exec(input.api_key)) !== null) tokenNames.add(match[1]);
    let resolvedKey = input.api_key;
    for (const name of tokenNames) {
      const entry = credentialResolve(name, agent.friendlyName);
      if (!entry) return `❌ Credential "${name}" not found. Run credential_store_set first.`;
      if ('denied' in entry) return `❌ ${entry.denied}`;
      if ('expired' in entry) return `❌ ${entry.expired}`;
      resolvedKey = resolvedKey.replaceAll(`{{secure.${name}}}`, entry.plaintext);
    }
    return provisionApiKey(agent, resolvedKey, provider);
  }

  // Flow A: OAuth credentials copy
  if (provider.oauthCredentialFiles()?.length) {
    return provisionOAuthCopy(agent, provider);
  }

  // Fallback: OOB key collection for non-OAuth or non-copyable providers
  const oob = await collectOobApiKey(agent.friendlyName, 'provision_llm_auth', {
    prompt: `Enter API key for ${provider.name} on ${agent.friendlyName}`,
  });
  if ('fallback' in oob) return oob.fallback ?? 'Error: OOB operation cancelled.';
  return provisionApiKey(agent, decryptPassword(oob.password!), provider);
}
