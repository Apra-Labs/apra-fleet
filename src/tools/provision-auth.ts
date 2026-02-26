import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { escapeDoubleQuoted } from '../utils/shell-escape.js';
import { getAgentOrFail, getAgentOS, touchAgent } from '../utils/agent-helpers.js';
import type { Agent } from '../types.js';

export const provisionAuthSchema = z.object({
  agent_id: z.string().describe('The UUID of the target agent'),
  api_key: z.string().optional().describe(
    'Anthropic API key override. If provided, deploys this key as ANTHROPIC_API_KEY instead of running OAuth login. Use for pay-per-use billing without a Claude subscription.'
  ),
});

export type ProvisionAuthInput = z.infer<typeof provisionAuthSchema>;

/**
 * Real auth check via `claude -p "hello"` — makes an actual API call.
 * This is the only reliable validation for both OAuth and API key auth,
 * since `claude auth status` doesn't actually validate API keys.
 */
async function verifyWithPrompt(agent: Agent, envPrefix?: string): Promise<boolean> {
  const cmds = getOsCommands(getAgentOS(agent));
  const strategy = getStrategy(agent);
  const escapedFolder = escapeDoubleQuoted(agent.remoteFolder);
  const prefix = envPrefix ? `${envPrefix} ` : '';
  const cmd = `cd "${escapedFolder}" && ${prefix}${cmds.claudeCommand('-p "hello" --output-format json --max-turns 1')}`;
  try {
    const result = await strategy.execCommand(cmd, 60000);
    return result.code === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Flow A — Copy master's OAuth credentials (default)
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
      + `  Run "claude auth login" locally first, or use the api_key parameter instead.`;
  }

  // Write credentials file to remote (mkdir + write in one command)
  try {
    const result = await strategy.execCommand(cmds.credentialFileWrite(creds), 10000);
    if (result.code !== 0 && result.stderr) {
      return `❌ Failed to write credentials on "${agent.friendlyName}": ${result.stderr}`;
    }
  } catch (err: any) {
    return `❌ Failed to write credentials on "${agent.friendlyName}": ${err.message}`;
  }

  const authWorks = await verifyWithPrompt(agent);
  touchAgent(agent.id);

  if (authWorks) {
    return `✅ OAuth credentials deployed to "${agent.friendlyName}"\n`
      + `  Auth: verified with a successful Claude API call\n`;
  }
  return `⚠️ Credentials deployed to "${agent.friendlyName}" but could not verify auth.\n`
    + `  The credentials file was written — try running a prompt to confirm.\n`;
}

// ---------------------------------------------------------------------------
// Flow B — API Key Override
// ---------------------------------------------------------------------------

async function provisionApiKey(agent: Agent, apiKey: string): Promise<string> {
  const cmds = getOsCommands(getAgentOS(agent));
  const strategy = getStrategy(agent);
  const commands = cmds.setEnv('ANTHROPIC_API_KEY', apiKey);

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

  // Verify the key was persisted in a new shell
  let verified = false;
  try {
    const verifyResult = await strategy.execCommand(cmds.apiKeyCheck(), 10000);
    verified = verifyResult.stdout.trim().length > 5;
  } catch {
    // May still work after re-login
  }

  // Verify with a real API call
  const envPrefix = cmds.envPrefix('ANTHROPIC_API_KEY', apiKey);
  const authWorks = await verifyWithPrompt(agent, envPrefix);

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

  result += `\n  Environment: ANTHROPIC_API_KEY set in shell profiles\n`;
  result += `  Verification: ${verified ? 'Key visible in new shell' : 'Key will be available after re-login'}\n`;
  result += `  Auth test: ${authWorks ? 'Claude CLI authenticated successfully' : 'Could not verify — may need to re-login'}\n`;

  return result;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function provisionAuth(input: ProvisionAuthInput): Promise<string> {
  const agentOrError = getAgentOrFail(input.agent_id);
  if (typeof agentOrError === 'string') return agentOrError;
  const agent = agentOrError as Agent;

  const strategy = getStrategy(agent);
  const conn = await strategy.testConnection();
  if (!conn.ok) {
    return `❌ Agent "${agent.friendlyName}" is offline: ${conn.error}`;
  }

  if (input.api_key) {
    return provisionApiKey(agent, input.api_key);
  }
  return provisionMasterToken(agent);
}
