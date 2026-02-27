import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import type { Agent } from '../types.js';
import { encryptPassword } from '../utils/crypto.js';
import { detectOS } from '../utils/platform.js';
import { getOsCommands } from '../os/index.js';
import { addAgent, hasDuplicateFolder } from '../services/registry.js';
import { getStrategy } from '../services/strategy.js';

export const registerAgentSchema = z.object({
  friendly_name: z.string()
    .min(1).max(64)
    .regex(/^[a-zA-Z0-9._-]+$/, 'Only letters, numbers, dots, dashes, and underscores')
    .describe('Human-friendly name for this agent (e.g. "web-server")'),
  agent_type: z.enum(['local', 'remote']).default('remote').describe('Agent type: "local" for same machine, "remote" for SSH (default: "remote")'),
  host: z.string().optional().describe('IP address or hostname of the remote machine (required for remote agents)'),
  port: z.number().default(22).describe('SSH port (default: 22, remote agents only)'),
  username: z.string().optional().describe('SSH username (required for remote agents)'),
  auth_type: z.enum(['password', 'key']).optional().describe('Authentication method (required for remote agents)'),
  password: z.string().optional().describe('SSH password (required if auth_type is "password")'),
  key_path: z.string().optional().describe('Path to SSH private key (required if auth_type is "key")'),
  work_folder: z.string().describe('Working directory on the target machine'),
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
  if (hasDuplicateFolder(input.agent_type, input.work_folder, input.host)) {
    const scope = isLocal ? 'this machine' : `host ${input.host}`;
    return `❌ Another agent already uses folder "${input.work_folder}" on ${scope}. Agent was NOT registered.`;
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
    workFolder: input.work_folder,
    createdAt: new Date().toISOString(),
  };

  const strategy = getStrategy(tempAgent);

  // Step 1: Test connectivity
  const connResult = await strategy.testConnection();
  if (!connResult.ok) {
    const target = isLocal ? 'local machine' : `${input.host}:${input.port}`;
    return `❌ Failed to connect to ${target} — ${connResult.error}\nAgent was NOT registered.`;
  }

  // Step 2: Detect OS — run all probes in parallel
  let detectedOS: Agent['os'];
  if (isLocal) {
    const p = process.platform;
    detectedOS = p === 'win32' ? 'windows' : p === 'darwin' ? 'macos' : 'linux';
  } else {
    detectedOS = 'linux';
    try {
      const noop = { stdout: '', stderr: '', code: 1 };
      const [unameResult, verResult, psResult] = await Promise.all([
        strategy.execCommand('uname -s', 10000).catch(() => noop),
        strategy.execCommand('ver', 10000).catch(() => noop),
        strategy.execCommand('echo $env:OS', 10000).catch(() => noop),
      ]);
      detectedOS = detectOS(unameResult.stdout, verResult.stdout + ' ' + psResult.stdout);
    } catch {
      warnings.push('Could not detect OS — defaulting to Linux');
    }
  }
  tempAgent.os = detectedOS;

  // Now we know the OS — get the command builder
  const cmds = getOsCommands(detectedOS);

  // Steps 3-5: Run Claude version, auth check, SCP check, and mkdir in parallel
  let claudeVersion: string | undefined;

  const versionCheck = strategy.execCommand(cmds.claudeVersion(), 15000)
    .then(r => {
      r.code === 0
        ? (claudeVersion = r.stdout.trim())
        : warnings.push(`Claude CLI not found on ${isLocal ? 'this machine' : 'remote machine'} — install it before using execute_prompt`);
    })
    .catch(() => { warnings.push('Could not verify Claude CLI availability'); });

  const authCheck = !isLocal
    ? strategy.execCommand(cmds.claudeCommand('-p "hello" --output-format json --max-turns 1'), 60000)
        .then(r => { r.code !== 0 && warnings.push('Claude CLI auth check failed — you may need to run provision_auth'); })
        .catch(() => { warnings.push('Claude CLI auth check timed out or failed — run provision_auth to set up authentication'); })
    : Promise.resolve();

  const scpCheck = !isLocal
    ? strategy.execCommand(cmds.scpCheck(), 10000)
        .then(r => { tempAgent.scpAvailable = r.code === 0; })
        .catch(() => { tempAgent.scpAvailable = false; })
    : Promise.resolve();

  const mkdirCheck = isLocal
    ? import('node:fs').then(({ mkdirSync }) => {
        mkdirSync(input.work_folder, { recursive: true });
      }).catch(() => { warnings.push(`Could not create folder "${input.work_folder}"`); })
    : strategy.execCommand(cmds.mkdir(input.work_folder), 10000)
        .catch(() => { warnings.push(`Could not create folder "${input.work_folder}"`); });

  await Promise.all([versionCheck, authCheck, scpCheck, mkdirCheck]);

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
  result += `  Folder:  ${tempAgent.workFolder}\n`;
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
