import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { getProvider } from '../providers/index.js';
import { escapeDoubleQuoted } from '../utils/shell-escape.js';
import { getAgentOrFail, getAgentOS, touchAgent } from '../utils/agent-helpers.js';
import { validateCredentials, credentialStatusNote } from '../utils/credential-validation.js';
import { encryptPassword, decryptPassword } from '../utils/crypto.js';
import { updateAgent } from '../services/registry.js';
import { collectOobApiKey } from '../services/auth-socket.js';
import type { Agent } from '../types.js';
import type { ProviderAdapter } from '../providers/index.js';

export const provisionAuthSchema = z.object({
  member_id: z.string().describe('The UUID of the target member (worker)'),
  api_key: z.string().optional().describe(
    'API key for the member\'s LLM provider (e.g. ANTHROPIC_API_KEY for Claude, GEMINI_API_KEY for Gemini, OPENAI_API_KEY for Codex, COPILOT_GITHUB_TOKEN for Copilot). If provided, deploys this key instead of running OAuth login.'
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
// Flow A — Copy master's OAuth credentials (Claude only)
// ---------------------------------------------------------------------------

function readMasterCredentials(): string | null {
  const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
  try {
    if (fs.existsSync(credPath)) {
      return fs.readFileSync(credPath, 'utf-8').trim();
    }
  } catch { /* ignore */ }
  return null;
}

async function provisionMasterToken(agent: Agent): Promise<string> {
  const cmds = getOsCommands(getAgentOS(agent));
  const strategy = getStrategy(agent);

  const creds = readMasterCredentials();
  if (!creds) {
    return `❌ No OAuth credentials found on this machine (~/.claude/.credentials.json).\n`
      + `  Run /login in your Claude Code session, or use the api_key parameter instead.`;
  }

  const credStatus = validateCredentials(creds);
  if (credStatus?.status === 'expired-no-refresh') {
    return `❌ OAuth token is expired with no refresh token.\n`
      + `  Run /login to get a fresh token, then re-run provision_auth.`;
  }

  // Write credentials file to remote (mkdir + write in one command)
  try {
    const result = await strategy.execCommand(cmds.credentialFileWrite(creds, '~/.claude/.credentials.json'), 10000);
    if (result.code !== 0 && result.stderr) {
      return `❌ Failed to write credentials on "${agent.friendlyName}": ${result.stderr}`;
    }
  } catch (err: any) {
    return `❌ Failed to write credentials on "${agent.friendlyName}": ${err.message}`;
  }

  const authWorks = await verifyWithClaudePrompt(agent);
  touchAgent(agent.id);

  const statusNote = credentialStatusNote(credStatus);
  const suffix = statusNote ? `\n  ${statusNote}\n` : '';

  if (authWorks) {
    return `✅ OAuth credentials deployed to "${agent.friendlyName}"\n`
      + `  Auth: verified with a successful Claude API call\n` + suffix;
  }
  return `⚠️ Credentials deployed to "${agent.friendlyName}" but could not verify auth.\n`
    + `  The credentials file was written — try running a prompt to confirm.\n` + suffix;
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
    result += `✅ API key provisioned on "${agent.friendlyName}"\n`;
  } else {
    result += `⚠️ API key provisioned with some issues on "${agent.friendlyName}":\n`;
    for (const e of errors) {
      result += `  - ${e}\n`;
    }
  }

  result += `\n  Environment: ${envVarName} set in shell profiles and stored in member config\n`;
  result += `  Verification: ${verified ? 'Key visible in new shell' : 'Key will be available after re-login'}\n`;
  result += `  Auth test: ${authWorks ? `${provider.name} CLI authenticated successfully` : 'Could not verify — may need to re-login'}\n`;

  return result;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function provisionAuth(input: ProvisionAuthInput): Promise<string> {
  const agentOrError = getAgentOrFail(input.member_id);
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

  if (input.api_key) {
    return provisionApiKey(agent, input.api_key, provider);
  }

  // Non-Claude providers: collect API key via OOB terminal prompt
  if (!provider.supportsOAuthCopy()) {
    const oob = await collectOobApiKey(agent.friendlyName, 'provision_auth');
    if ('fallback' in oob) return oob.fallback;
    return provisionApiKey(agent, decryptPassword(oob.password), provider);
  }

  return provisionMasterToken(agent);
}
