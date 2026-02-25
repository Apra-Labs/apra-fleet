import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import type { Agent } from '../types.js';
import { encryptPassword } from '../utils/crypto.js';
import { detectOS, getClaudeCheckCommand, getScpCheckCommand, getMkdirCommand } from '../utils/platform.js';
import { addAgent } from '../services/registry.js';
import { execCommand, testConnection, closeConnection } from '../services/ssh.js';

export const registerAgentSchema = z.object({
  friendly_name: z.string().describe('Human-friendly name for this agent (e.g. "web-server")'),
  host: z.string().describe('IP address or hostname of the remote machine'),
  port: z.number().default(22).describe('SSH port (default: 22)'),
  username: z.string().describe('SSH username'),
  auth_type: z.enum(['password', 'key']).describe('Authentication method'),
  password: z.string().optional().describe('SSH password (required if auth_type is "password")'),
  key_path: z.string().optional().describe('Path to SSH private key (required if auth_type is "key")'),
  remote_folder: z.string().describe('Working directory on the remote machine'),
});

export type RegisterAgentInput = z.infer<typeof registerAgentSchema>;

export async function registerAgent(input: RegisterAgentInput): Promise<string> {
  const warnings: string[] = [];

  // Build a temporary agent object for SSH testing
  const tempAgent: Agent = {
    id: uuid(),
    friendlyName: input.friendly_name,
    host: input.host,
    port: input.port,
    username: input.username,
    authType: input.auth_type,
    encryptedPassword: input.password ? encryptPassword(input.password) : undefined,
    keyPath: input.key_path,
    remoteFolder: input.remote_folder,
    createdAt: new Date().toISOString(),
  };

  // Step 1: Test SSH connectivity
  const connResult = await testConnection(tempAgent);
  if (!connResult.ok) {
    return `❌ Failed to connect to ${input.host}:${input.port} — ${connResult.error}\nAgent was NOT registered.`;
  }

  // Step 2: Detect remote OS
  let detectedOS: Agent['os'] = 'linux';
  try {
    const unameResult = await execCommand(tempAgent, 'uname -s', 10000);
    const verResult = await execCommand(tempAgent, 'cmd /c ver 2>/dev/null || echo ""', 10000).catch(() => ({ stdout: '', stderr: '', code: 1 }));
    detectedOS = detectOS(unameResult.stdout, verResult.stdout);
  } catch {
    warnings.push('Could not detect OS — defaulting to Linux');
  }
  tempAgent.os = detectedOS;

  // Step 3: Check if Claude CLI exists
  try {
    const claudeCheck = await execCommand(tempAgent, getClaudeCheckCommand(detectedOS), 10000);
    if (claudeCheck.code !== 0) {
      warnings.push('Claude CLI not found on remote machine — install it before using execute_prompt');
    }
  } catch {
    warnings.push('Could not verify Claude CLI availability');
  }

  // Step 4: Quick Claude auth test
  try {
    const authCheck = await execCommand(tempAgent, 'claude -p "hello" --output-format json --max-turns 1', 60000);
    if (authCheck.code !== 0) {
      warnings.push('Claude CLI auth check failed — you may need to run provision_auth');
    }
  } catch {
    warnings.push('Could not verify Claude authentication');
  }

  // Step 5: Check SCP availability
  try {
    const scpCheck = await execCommand(tempAgent, getScpCheckCommand(detectedOS), 10000);
    tempAgent.scpAvailable = scpCheck.code === 0;
  } catch {
    tempAgent.scpAvailable = false;
  }

  // Step 6: Create remote folder
  try {
    await execCommand(tempAgent, getMkdirCommand(detectedOS, input.remote_folder), 10000);
  } catch {
    warnings.push(`Could not create remote folder "${input.remote_folder}" — it may already exist or permissions may be needed`);
  }

  // Persist
  addAgent(tempAgent);

  let result = `✅ Agent registered successfully!\n\n`;
  result += `  ID:      ${tempAgent.id}\n`;
  result += `  Name:    ${tempAgent.friendlyName}\n`;
  result += `  Host:    ${tempAgent.host}:${tempAgent.port}\n`;
  result += `  OS:      ${detectedOS}\n`;
  result += `  Folder:  ${tempAgent.remoteFolder}\n`;
  result += `  Auth:    ${tempAgent.authType}\n`;
  result += `  SCP:     ${tempAgent.scpAvailable ? 'available' : 'not available (will use SFTP)'}\n`;
  result += `  Latency: ${connResult.latencyMs}ms\n`;

  if (warnings.length > 0) {
    result += `\n⚠️ Warnings:\n`;
    for (const w of warnings) {
      result += `  - ${w}\n`;
    }
  }

  return result;
}
