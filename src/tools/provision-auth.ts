import { z } from 'zod';
import { setFleetToken } from '../services/registry.js';
import { getStrategy } from '../services/strategy.js';
import { getSetEnvCommand } from '../utils/platform.js';
import { escapeDoubleQuoted } from '../utils/shell-escape.js';
import { getAgentOrFail, getAgentOS, touchAgent } from '../utils/agent-helpers.js';
import type { Agent } from '../types.js';

export const provisionAuthSchema = z.object({
  agent_id: z.string().describe('The UUID of the target agent'),
  fleet_token: z.string().describe('The CLAUDE_CODE_OAUTH_TOKEN to provision on the remote agent'),
});

export type ProvisionAuthInput = z.infer<typeof provisionAuthSchema>;

export async function provisionAuth(input: ProvisionAuthInput): Promise<string> {
  const agentOrError = getAgentOrFail(input.agent_id);
  if (typeof agentOrError === 'string') return agentOrError;
  const agent = agentOrError as Agent;

  const os = getAgentOS(agent);
  const strategy = getStrategy(agent);
  const commands = getSetEnvCommand(os, 'CLAUDE_CODE_OAUTH_TOKEN', input.fleet_token);

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

  // Verify the token was set
  let verified = false;
  try {
    let verifyCmd: string;
    if (os === 'windows') {
      verifyCmd = 'echo %CLAUDE_CODE_OAUTH_TOKEN%';
    } else {
      verifyCmd = 'echo $CLAUDE_CODE_OAUTH_TOKEN';
    }
    // Need to start a new login shell to pick up the changes
    const shellVerify = os === 'windows'
      ? verifyCmd
      : `bash -l -c '${verifyCmd}'`;
    const verifyResult = await strategy.execCommand(shellVerify, 10000);
    verified = verifyResult.stdout.trim().length > 10;
  } catch {
    // Verification failed but token may still be set for new sessions
  }

  // Quick Claude auth test
  let authWorks = false;
  try {
    const escapedFolder = escapeDoubleQuoted(agent.remoteFolder);
    const escapedToken = escapeDoubleQuoted(input.fleet_token);
    const authTest = await strategy.execCommand(
      `cd "${escapedFolder}" && CLAUDE_CODE_OAUTH_TOKEN="${escapedToken}" claude -p "hello" --output-format json --max-turns 1`,
      60000
    );
    authWorks = authTest.code === 0;
  } catch {
    // Auth test failed
  }

  // Store fleet token
  setFleetToken(input.fleet_token);
  touchAgent(agent.id);

  let result = '';
  if (errors.length === 0) {
    result += `✅ OAuth token provisioned on "${agent.friendlyName}"\n`;
  } else {
    result += `⚠️ Token provisioned with some issues on "${agent.friendlyName}":\n`;
    for (const e of errors) {
      result += `  - ${e}\n`;
    }
  }

  result += `\n  Environment: CLAUDE_CODE_OAUTH_TOKEN set in shell profiles\n`;
  result += `  Verification: ${verified ? 'Token visible in new shell' : 'Token will be available after re-login'}\n`;
  result += `  Auth test: ${authWorks ? 'Claude CLI authenticated successfully' : 'Could not verify — may need to re-login'}\n`;

  return result;
}
