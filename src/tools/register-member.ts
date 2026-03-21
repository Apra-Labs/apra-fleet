import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import type { Agent } from '../types.js';
import type { CloudConfig } from '../services/cloud/types.js';
import { encryptPassword } from '../utils/crypto.js';
import { detectOS } from '../utils/platform.js';
import { getOsCommands } from '../os/index.js';
import { addAgent, getAllAgents, hasDuplicateFolder } from '../services/registry.js';
import { getStrategy } from '../services/strategy.js';
import { assignIcon } from '../services/icons.js';
import { writeStatusline } from '../services/statusline.js';
import { awsProvider } from '../services/cloud/aws.js';
import { ensureAuthSocket, createPendingAuth, getPendingPassword, hasPendingAuth, waitForPassword, launchAuthTerminal } from '../services/auth-socket.js';

export const registerMemberSchema = z.object({
  friendly_name: z.string()
    .min(1).max(64)
    .regex(/^[a-zA-Z0-9._-]+$/, 'Only letters, numbers, dots, dashes, and underscores')
    .describe('Human-friendly name for this member (worker) (e.g. "web-server")'),
  member_type: z.enum(['local', 'remote']).default('remote').describe('Member type: "local" for same machine, "remote" for SSH (default: "remote")'),
  host: z.string().optional().describe('IP address or hostname of the remote machine (required for non-cloud remote members; optional for cloud members — auto-resolved from AWS when running)'),
  port: z.number().default(22).describe('SSH port (default: 22, remote members only)'),
  username: z.string().optional().describe('SSH username (required for remote members)'),
  auth_type: z.enum(['password', 'key']).optional().describe('Authentication method (required for non-cloud remote members; cloud members default to "key")'),
  password: z.string().optional().describe('SSH password. Omit for secure out-of-band entry — a password prompt will open in a separate terminal window.'),
  key_path: z.string().optional().describe('Path to SSH private key (required if auth_type is "key" for non-cloud members)'),
  work_folder: z.string().describe('Working directory on the target machine'),
  git_access: z.enum(['read', 'push', 'admin', 'issues', 'full']).optional().describe('Git access level for this member'),
  git_repos: z.array(z.string()).optional().describe('Git repositories this member can access (e.g. ["Apra-Labs/ApraPipes"])'),
  // Cloud fields
  cloud_provider: z.enum(['aws'], {
    errorMap: () => ({ message: "Only 'aws' is supported as a cloud provider. GCP and Azure support is planned." }),
  }).optional().describe('Cloud provider (e.g. "aws"). When set, cloud_instance_id and cloud_ssh_key_path are required.'),
  cloud_instance_id: z.string().regex(/^i-[0-9a-f]{8,17}$/, 'cloud_instance_id must match pattern i-[0-9a-f]{8,17} (e.g. "i-0abc123def456789a")').optional().describe('EC2 instance ID (e.g. "i-0abc123def456789a"). Required when cloud_provider is set.'),
  cloud_region: z.string().regex(/^[a-z]{2}-[a-z]+-\d+$/, 'cloud_region must be a valid AWS region (e.g. "us-east-1")').optional().default('us-east-1').describe('AWS region (default: "us-east-1")'),
  cloud_profile: z.string().optional().describe('AWS CLI profile name (e.g. "apra")'),
  cloud_idle_timeout_min: z.number().min(1, 'cloud_idle_timeout_min must be at least 1 minute').max(1440, 'cloud_idle_timeout_min must be at most 1440 minutes (24 hours)').optional().default(30).describe('Minutes of inactivity before auto-stop (default: 30)'),
  cloud_ssh_key_path: z.string().min(1, 'cloud_ssh_key_path must not be empty').optional().describe('Path to SSH private key on this machine. Required when cloud_provider is set. Also sets the member key_path for SSH connections (F4).'),
  cloud_activity_command: z.string().min(1).optional().describe('Custom shell command for workload detection. Must output "busy" or "idle" on stdout. Checked after GPU, before process check. Useful for CPU-intensive tasks, downloads, or any non-GPU workload.'),
});

export type RegisterMemberInput = z.infer<typeof registerMemberSchema>;

export async function registerMember(input: RegisterMemberInput): Promise<string> {
  const warnings: string[] = [];
  const isLocal = input.member_type === 'local';
  const isCloud = !!input.cloud_provider;

  // --- Validate required fields ---
  if (isCloud) {
    if (!input.cloud_instance_id) return '❌ "cloud_instance_id" is required when cloud_provider is set. Member was NOT registered.';
    if (!input.cloud_ssh_key_path) return '❌ "cloud_ssh_key_path" is required when cloud_provider is set. Member was NOT registered.';
    if (!input.username) return '❌ "username" is required for cloud members. Member was NOT registered.';
  } else if (!isLocal) {
    if (!input.host) return '❌ "host" is required for remote members. Member was NOT registered.';
    if (!input.username) return '❌ "username" is required for remote members. Member was NOT registered.';
    if (!input.auth_type) return '❌ "auth_type" is required for remote members. Member was NOT registered.';
  }

  // Out-of-band password collection for remote password auth without inline password
  let preEncryptedPassword: string | undefined;
  if (!isLocal && !isCloud && input.auth_type === 'password' && !input.password) {
    if (hasPendingAuth(input.friendly_name)) {
      // Previous fallback or retry — check if password already arrived
      const encPw = getPendingPassword(input.friendly_name);
      if (encPw) {
        preEncryptedPassword = encPw;
      } else {
        try {
          preEncryptedPassword = await waitForPassword(input.friendly_name);
        } catch {
          return `❌ Password entry timed out for "${input.friendly_name}". Call register_member again to retry.`;
        }
      }
    } else {
      await ensureAuthSocket();
      createPendingAuth(input.friendly_name);
      const result = launchAuthTerminal(input.friendly_name);

      if (result.startsWith('fallback:')) {
        // Headless — can't block, user needs to see manual instructions
        const manualMsg = result.slice('fallback:'.length);
        return `🔐 ${manualMsg}\n\nOnce the user has entered the password, call register_member again with the same parameters (without password).`;
      }

      // Terminal launched — block until password arrives
      try {
        preEncryptedPassword = await waitForPassword(input.friendly_name);
      } catch {
        return `❌ Password entry timed out for "${input.friendly_name}". Call register_member again to retry.`;
      }
    }
  }

  // --- Duplicate folder check ---
  if (hasDuplicateFolder(input.member_type, input.work_folder, input.host)) {
    const scope = isLocal ? 'this machine' : `host ${input.host}`;
    return `❌ Another member already uses folder "${input.work_folder}" on ${scope}. Member was NOT registered.`;
  }

  // --- Cloud: get instance state and resolve host ---
  let resolvedHost = input.host;
  let skipSshOps = false;

  if (isCloud) {
    const cloudConfigForCheck: CloudConfig = {
      provider: 'aws',
      instanceId: input.cloud_instance_id!,
      region: input.cloud_region ?? 'us-east-1',
      profile: input.cloud_profile,
      idleTimeoutMin: input.cloud_idle_timeout_min ?? 30,
      sshKeyPath: input.cloud_ssh_key_path!,
    };

    try {
      const instanceState = await awsProvider.getInstanceState(cloudConfigForCheck);
      if (instanceState === 'terminated') {
        return `❌ EC2 instance ${cloudConfigForCheck.instanceId} is terminated and cannot be used. Member was NOT registered.`;
      }
      if (instanceState === 'running') {
        // Auto-resolve host from AWS if not provided
        if (!resolvedHost) {
          try {
            resolvedHost = await awsProvider.getPublicIp(cloudConfigForCheck);
          } catch {
            warnings.push('Instance is running but could not get public IP — provide host manually via update_member after registration.');
          }
        }
      } else {
        // stopped / stopping / pending — skip SSH ops
        skipSshOps = true;
        warnings.push(`Instance is "${instanceState}" — skipping connectivity check. Run execute_command after the instance starts to verify SSH access.`);
      }
    } catch (e) {
      const msg = (e as Error).message;
      warnings.push(`Could not verify instance state: ${msg}. Proceeding with registration.`);
      skipSshOps = true;
    }
  }

  // --- Build cloud config ---
  const cloudConfig: CloudConfig | undefined = isCloud ? {
    provider: 'aws',
    instanceId: input.cloud_instance_id!,
    region: input.cloud_region ?? 'us-east-1',
    profile: input.cloud_profile,
    idleTimeoutMin: input.cloud_idle_timeout_min ?? 30,
    sshKeyPath: input.cloud_ssh_key_path!,
    ...(input.cloud_activity_command ? { activityCommand: input.cloud_activity_command } : {}),
  } : undefined;

  // --- Build tempAgent ---
  const tempAgent: Agent = {
    id: uuid(),
    friendlyName: input.friendly_name,
    agentType: input.member_type,
    host: isLocal ? undefined : (resolvedHost ?? ''),
    port: isLocal ? undefined : input.port,
    username: isLocal ? undefined : input.username,
    authType: isLocal ? undefined : (isCloud ? 'key' : input.auth_type),
    encryptedPassword: preEncryptedPassword ?? ((!isLocal && !isCloud && input.password) ? encryptPassword(input.password) : undefined),
    keyPath: isLocal ? undefined : (isCloud ? input.cloud_ssh_key_path : input.key_path),
    workFolder: input.work_folder,
    createdAt: new Date().toISOString(),
    gitAccess: input.git_access,
    gitRepos: input.git_repos,
    cloud: cloudConfig,
  };

  // --- SSH-dependent steps (skipped for stopped cloud instances) ---
  let detectedOS: Agent['os'] = isCloud ? 'linux' : undefined;
  let claudeVersion: string | undefined;
  let connResult: { ok: boolean; latencyMs?: number; error?: string } = { ok: true };

  if (!skipSshOps) {
    const strategy = getStrategy(tempAgent);

    // Step 1: Test connectivity
    connResult = await strategy.testConnection();
    if (!connResult.ok) {
      const target = isLocal ? 'local machine' : `${resolvedHost}:${input.port}`;
      if (isCloud) {
        warnings.push(`SSH connectivity check failed: ${connResult.error}. Update host via update_member when the instance starts.`);
      } else {
        return `❌ Failed to connect to ${target} — ${connResult.error}\nMember was NOT registered.`;
      }
    }

    // Step 2: Detect OS
    if (isLocal) {
      const p = process.platform;
      detectedOS = p === 'win32' ? 'windows' : p === 'darwin' ? 'macos' : 'linux';
    } else if (!isCloud) {
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
    } else {
      // Cloud + running: assume linux (GPU instances are Linux)
      detectedOS = 'linux';
    }
    tempAgent.os = detectedOS;

    const cmds = getOsCommands(detectedOS);

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

    const mkdirCheck = isLocal
      ? import('node:fs').then(({ mkdirSync }) => {
          mkdirSync(input.work_folder, { recursive: true });
        }).catch(() => { warnings.push(`Could not create folder "${input.work_folder}"`); })
      : strategy.execCommand(cmds.mkdir(input.work_folder), 10000)
          .catch(() => { warnings.push(`Could not create folder "${input.work_folder}"`); });

    await Promise.all([versionCheck, authCheck, mkdirCheck]);
  } else {
    tempAgent.os = detectedOS;
    if (isCloud) {
      warnings.push('Claude CLI and auth not verified — run provision_auth after the instance starts.');
    }
  }

  // OS support warning for cloud members: cloud features are designed for Linux
  if (isCloud && tempAgent.os !== 'linux') {
    const osLabel = tempAgent.os ?? 'unknown';
    warnings.push(`Cloud features (GPU detection, task wrapper, activity monitoring) are designed for Linux. Some features may not work on ${osLabel}.`);
  }

  // Auto-assign icon
  tempAgent.icon = assignIcon(getAllAgents().map(a => a.icon).filter(Boolean) as string[]);

  // Persist
  addAgent(tempAgent);
  writeStatusline();

  let result = `✅ Member registered successfully!\n\n`;
  result += `  Icon:    ${tempAgent.icon}\n`;
  result += `  ID:      ${tempAgent.id}\n`;
  result += `  Name:    ${tempAgent.friendlyName}\n`;
  result += `  Type:    ${tempAgent.agentType}${isCloud ? ' (cloud)' : ''}\n`;
  if (!isLocal) {
    result += `  Host:    ${tempAgent.host || '(pending — set when instance starts)'}:${tempAgent.port}\n`;
  }
  result += `  OS:      ${detectedOS}\n`;
  result += `  Folder:  ${tempAgent.workFolder}\n`;
  if (claudeVersion) {
    result += `  Claude:  ${claudeVersion}\n`;
  }
  if (!isLocal) {
    result += `  Auth:    ${tempAgent.authType}\n`;
    if (connResult.latencyMs !== undefined) {
      result += `  Latency: ${connResult.latencyMs}ms\n`;
    }
  }
  if (isCloud && cloudConfig) {
    result += `  Cloud:   ${cloudConfig.provider} / ${cloudConfig.instanceId} / ${cloudConfig.region}\n`;
    result += `  Idle:    ${cloudConfig.idleTimeoutMin}min\n`;
  }

  if (warnings.length > 0) {
    result += `\n⚠️ Warnings:\n`;
    for (const w of warnings) {
      result += `  - ${w}\n`;
    }
  }

  return result;
}
