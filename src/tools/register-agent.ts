import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import type { Agent } from '../types.js';
import { encryptPassword } from '../utils/crypto.js';
import { detectOS, getClaudeVersionCommand, getClaudeCommand, getScpCheckCommand, getMkdirCommand } from '../utils/platform.js';
import { addAgent, hasDuplicateFolder } from '../services/registry.js';
import { getStrategy } from '../services/strategy.js';

export const registerAgentSchema = z.object({
  friendly_name: z.string().describe('Human-friendly name for this agent (e.g. "web-server")'),
  agent_type: z.enum(['local', 'remote']).default('remote').describe('Agent type: "local" for same machine, "remote" for SSH (default: "remote")'),
  host: z.string().optional().describe('IP address or hostname of the remote machine (required for remote agents)'),
  port: z.number().default(22).describe('SSH port (default: 22, remote agents only)'),
  username: z.string().optional().describe('SSH username (required for remote agents)'),
  auth_type: z.enum(['password', 'key']).optional().describe('Authentication method (required for remote agents)'),
  password: z.string().optional().describe('SSH password (required if auth_type is "password")'),
  key_path: z.string().optional().describe('Path to SSH private key (required if auth_type is "key")'),
  remote_folder: z.string().describe('Working directory on the target machine'),
});

export type RegisterAgentInput = z.infer<typeof registerAgentSchema>;

export async function registerAgent(input: RegisterAgentInput): Promise<string> {
  const warnings: string[] = [];
  const isLocal = input.agent_type === 'local';

  // Validate remote-specific fields
  if (!isLocal) {
    if (!input.host) return '❌ "host" is required for remote agents. Agent was NOT registered.';
    if (!input.username) return '❌ "username" is required for remote agents. Agent was NOT registered.';
    if (!input.auth_type) return '❌ "auth_type" is required for remote agents. Agent was NOT registered.';
  }

  // Duplicate folder check
  if (hasDuplicateFolder(input.agent_type, input.remote_folder, input.host)) {
    const scope = isLocal ? 'this machine' : `host ${input.host}`;
    return `❌ Another agent already uses folder "${input.remote_folder}" on ${scope}. Agent was NOT registered.`;
  }

  // Build a temporary agent object
  const tempAgent: Agent = {
    id: uuid(),
    friendlyName: input.friendly_name,
    agentType: input.agent_type,
    host: isLocal ? undefined : input.host,
    port: isLocal ? undefined : input.port,
    username: isLocal ? undefined : input.username,
    authType: isLocal ? undefined : input.auth_type,
    encryptedPassword: (!isLocal && input.password) ? encryptPassword(input.password) : undefined,
    keyPath: isLocal ? undefined : input.key_path,
    remoteFolder: input.remote_folder,
    createdAt: new Date().toISOString(),
  };

  const strategy = getStrategy(tempAgent);

  // Step 1: Test connectivity
  const connResult = await strategy.testConnection();
  if (!connResult.ok) {
    const target = isLocal ? 'local machine' : `${input.host}:${input.port}`;
    return `❌ Failed to connect to ${target} — ${connResult.error}\nAgent was NOT registered.`;
  }

  // Step 2: Detect OS
  let detectedOS: Agent['os'];
  if (isLocal) {
    // Detect local OS from process.platform
    const p = process.platform;
    detectedOS = p === 'win32' ? 'windows' : p === 'darwin' ? 'macos' : 'linux';
  } else {
    detectedOS = 'linux';
    try {
      const unameResult = await strategy.execCommand('uname -s', 10000);
      const verResult = await strategy.execCommand('cmd /c ver 2>/dev/null || echo ""', 10000).catch(() => ({ stdout: '', stderr: '', code: 1 }));
      detectedOS = detectOS(unameResult.stdout, verResult.stdout);
    } catch {
      warnings.push('Could not detect OS — defaulting to Linux');
    }
  }
  tempAgent.os = detectedOS;

  // Step 3: Verify Claude CLI is installed and get version
  let claudeVersion: string | undefined;
  try {
    const claudeCheck = await strategy.execCommand(getClaudeVersionCommand(detectedOS), 15000);
    if (claudeCheck.code !== 0) {
      warnings.push(`Claude CLI not found on ${isLocal ? 'this machine' : 'remote machine'} — install it before using execute_prompt`);
    } else {
      claudeVersion = claudeCheck.stdout.trim();
    }
  } catch {
    warnings.push('Could not verify Claude CLI availability');
  }

  // Step 4: Quick Claude auth test (remote only — local agents inherit the current session's auth)
  if (!isLocal) {
    try {
      const authCheck = await strategy.execCommand(getClaudeCommand(detectedOS, '-p "hello" --output-format json --max-turns 1'), 60000);
      if (authCheck.code !== 0) {
        warnings.push('Claude CLI auth check failed — you may need to run provision_auth');
      }
    } catch {
      warnings.push('Claude CLI auth check timed out or failed — run provision_auth to set up the OAuth token');
    }
  }

  // Step 5: Check SCP availability (remote only)
  if (!isLocal) {
    try {
      const scpCheck = await strategy.execCommand(getScpCheckCommand(detectedOS), 10000);
      tempAgent.scpAvailable = scpCheck.code === 0;
    } catch {
      tempAgent.scpAvailable = false;
    }
  }

  // Step 6: Create working folder
  try {
    if (isLocal) {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(input.remote_folder, { recursive: true });
    } else {
      await strategy.execCommand(getMkdirCommand(detectedOS, input.remote_folder), 10000);
    }
  } catch {
    warnings.push(`Could not create folder "${input.remote_folder}" — it may already exist or permissions may be needed`);
  }

  // Persist
  addAgent(tempAgent);

  let result = `✅ Agent registered successfully!\n\n`;
  result += `  ID:      ${tempAgent.id}\n`;
  result += `  Name:    ${tempAgent.friendlyName}\n`;
  result += `  Type:    ${tempAgent.agentType}\n`;
  if (!isLocal) {
    result += `  Host:    ${tempAgent.host}:${tempAgent.port}\n`;
  }
  result += `  OS:      ${detectedOS}\n`;
  result += `  Folder:  ${tempAgent.remoteFolder}\n`;
  if (claudeVersion) {
    result += `  Claude:  ${claudeVersion}\n`;
  }
  if (!isLocal) {
    result += `  Auth:    ${tempAgent.authType}\n`;
    result += `  SCP:     ${tempAgent.scpAvailable ? 'available' : 'not available (will use SFTP)'}\n`;
    result += `  Latency: ${connResult.latencyMs}ms\n`;
  }

  if (warnings.length > 0) {
    result += `\n⚠️ Warnings:\n`;
    for (const w of warnings) {
      result += `  - ${w}\n`;
    }
  }

  return result;
}
