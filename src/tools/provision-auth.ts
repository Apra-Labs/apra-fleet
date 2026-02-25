import { z } from 'zod';
import { getAgent, updateAgent, setFleetToken } from '../services/registry.js';
import { execCommand } from '../services/ssh.js';
import { getSetEnvCommand } from '../utils/platform.js';

export const provisionAuthSchema = z.object({
  agent_id: z.string().describe('The UUID of the target agent'),
  fleet_token: z.string().describe('The CLAUDE_CODE_OAUTH_TOKEN to provision on the remote agent'),
});

export type ProvisionAuthInput = z.infer<typeof provisionAuthSchema>;

export async function provisionAuth(input: ProvisionAuthInput): Promise<string> {
  const agent = getAgent(input.agent_id);
  if (!agent) {
    return `Agent "${input.agent_id}" not found.`;
  }

  const os = agent.os ?? 'linux';
  const commands = getSetEnvCommand(os, 'CLAUDE_CODE_OAUTH_TOKEN', input.fleet_token);

  const errors: string[] = [];

  for (const cmd of commands) {
    try {
      const result = await execCommand(agent, cmd, 15000);
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
    const verifyResult = await execCommand(agent, shellVerify, 10000);
    verified = verifyResult.stdout.trim().length > 10;
  } catch {
    // Verification failed but token may still be set for new sessions
  }

  // Quick Claude auth test
  let authWorks = false;
  try {
    const authTest = await execCommand(
      agent,
      `cd "${agent.remoteFolder}" && CLAUDE_CODE_OAUTH_TOKEN="${input.fleet_token}" claude -p "hello" --output-format json --max-turns 1`,
      60000
    );
    authWorks = authTest.code === 0;
  } catch {
    // Auth test failed
  }

  // Store fleet token
  setFleetToken(input.fleet_token);
  updateAgent(agent.id, { lastUsed: new Date().toISOString() });

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
