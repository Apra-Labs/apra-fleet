import { spawn } from 'node:child_process';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import type { Agent } from '../types.js';
import type { CloudConfig } from '../services/cloud/types.js';
import { encryptPassword, decryptPassword } from '../utils/crypto.js';
import { detectOS } from '../utils/platform.js';
import { getOsCommands } from '../os/index.js';
import { getProvider } from '../providers/index.js';
import { addAgent, getAllAgents, hasDuplicateFolder } from '../services/registry.js';
import { credentialResolve, credentialSet } from '../services/credential-store.js';
import { getStrategy } from '../services/strategy.js';
import { assignIcon } from '../services/icons.js';
import { writeStatusline } from '../services/statusline.js';
import { awsProvider } from '../services/cloud/aws.js';
import { collectOobPassword, collectOobApiKey } from '../services/auth-socket.js';
import { classifySshError } from '../utils/ssh-error-messages.js';
import { logLine } from '../utils/log-helpers.js';
import { CURATED_CHEAP_MODELS, CURATED_STANDARD_MODELS, CURATED_PREMIUM_MODELS } from '../cli/config.js';
import { writeAgyWorkspaceOverlays } from '../cli/install.js';
import { validateOpenCodeModelTiers } from '../utils/opencode-model-validation.js';
import { checkRunningInstance } from '../services/singleton.js';

export const registerMemberSchema = z.object({
  friendly_name: z.string()
    .min(1).max(64)
    .regex(/^[a-zA-Z0-9._-]+$/, 'Only letters, numbers, dots, dashes, and underscores')
    .describe('Human-friendly name for this member (worker) (e.g. "web-server")'),
  member_type: z.enum(['local', 'remote']).default('remote').describe('Member type: "local" for same machine, "remote" for SSH (default: "remote")'),
  host: z.string().regex(/^[^<>\n\r]+$/, 'host must not contain angle brackets or newlines').optional().describe('IP address or hostname of the remote machine (required for non-cloud remote members; optional for cloud members — auto-resolved from AWS when running)'),
  port: z.number().default(22).describe('SSH port (default: 22, remote members only)'),
  username: z.string().optional().describe('SSH username (required for remote members). Spaces are allowed (e.g. "tester tester" on Windows) — passed directly to SSH, never shell-interpolated.'),
  auth_type: z.enum(['password', 'key']).optional().describe('Authentication method (required for non-cloud remote members; cloud members default to "key")'),
  password: z.string().optional().describe('SSH password. Omit for secure out-of-band entry — a password prompt will open in a separate terminal window. Supports {{secure.NAME}} token — value is resolved from the credential store before use.'),
  key_path: z.string().optional().describe('Path to SSH private key. Used for both regular SSH connections and cloud instance lifecycle.'),
  work_folder: z.string().regex(/^[^<>\n\r]+$/, 'work_folder must not contain angle brackets or newlines').describe('Working directory on the target machine'),
  git_access: z.enum(['read', 'push', 'admin', 'issues', 'full']).optional().describe('Git access level for this member'),
  git_repos: z.array(z.string()).optional().describe('Git repositories this member can access (e.g. ["Apra-Labs/ApraPipes"])'),
  // Cloud fields
  cloud_provider: z.enum(['aws'], {
    errorMap: () => ({ message: "Only 'aws' is supported as a cloud provider. GCP and Azure support is planned." }),
  }).optional().describe('Cloud provider (e.g. "aws"). When set, cloud_instance_id and key_path are required.'),
  cloud_instance_id: z.string().regex(/^i-[0-9a-f]{8,17}$/, 'cloud_instance_id must match pattern i-[0-9a-f]{8,17} (e.g. "i-0abc123def456789a")').optional().describe('EC2 instance ID (e.g. "i-0abc123def456789a"). Required when cloud_provider is set.'),
  cloud_region: z.string().regex(/^[a-z]{2}-[a-z]+-\d+$/, 'cloud_region must be a valid AWS region (e.g. "us-east-1")').optional().default('us-east-1').describe('AWS region (default: "us-east-1")'),
  cloud_profile: z.string().optional().describe('AWS CLI profile name (e.g. "apra")'),
  cloud_idle_timeout_min: z.number().min(1, 'cloud_idle_timeout_min must be at least 1 minute').max(1440, 'cloud_idle_timeout_min must be at most 1440 minutes (24 hours)').optional().default(30).describe('Minutes of inactivity before auto-stop (default: 30)'),
  cloud_activity_command: z.string().min(1).optional().describe('Custom shell command for workload detection. Must output "busy" or "idle" on stdout. Checked after GPU, before process check. Useful for CPU-intensive tasks, downloads, or any non-GPU workload.'),
  llm_provider: z.enum(['claude', 'gemini', 'codex', 'copilot', 'agy', 'opencode', 'none']).optional().default('claude').describe('LLM provider for this member (default: "claude"). Determines which CLI is used for execute_prompt, provision_llm_auth, and update_llm_cli. Use "none" for a plain command executor with no LLM at all -- execute_prompt is rejected for these members; use execute_command instead.'),
  model_cheap: z.enum(CURATED_CHEAP_MODELS).optional().describe('Custom cheap model choice from a curated list'),
  model_standard: z.enum(CURATED_STANDARD_MODELS).optional().describe('Custom standard model choice from a curated list'),
  model_premium: z.enum(CURATED_PREMIUM_MODELS).optional().describe('Custom premium model choice from a curated list'),
  unattended: z.preprocess(
    (v) => v === false ? 'false' : v,
    z.enum(['false', 'auto', 'dangerous'])
  ).optional().describe('Permission mode for unattended execution. Omit or pass "false" for interactive prompts (default); "auto" = auto-approve safe operations; "dangerous" = skip all permission checks.'),
  category: z.string().max(64).optional().describe('Optional group label for this member (e.g. "doers", "reviewers", "cloud"). Used to group devices in fleet status output.'),
  tags: z.array(z.string().max(64, 'Each tag must be 64 characters or fewer'))
    .max(10, 'At most 10 tags are allowed')
    .optional()
    .describe('Optional list of free-form labels for this member (max 10 tags, each max 64 chars). Used for filtering and grouping.'),
  model_tiers: z.object({
    cheap: z.string().optional(),
    standard: z.string().optional(),
    premium: z.string().optional(),
  }).optional().describe('Per-member model tier map. Keys: cheap, standard, premium. Values: model IDs (e.g. "ollama/qwen3-coder:30b"). A single model fills all tiers. At least one model recommended for opencode members.'),
});

export type RegisterMemberInput = z.infer<typeof registerMemberSchema>;

// --- Interactive-session bootstrap: injectable deps + explicit gate ---
//
// The local-Claude bootstrap below does a REAL HTTP GET (via checkRunningInstance)
// and, if a fleet server happens to be running on the machine, writes
// settings.local.json and spawns a REAL `claude` process. That is correct
// behavior in production but dangerous to run unconditionally from unit tests
// (a dev machine with `apra-fleet start` running in the background would have
// tests silently spawn real claude processes). Two safeguards:
//
// 1. Dependency injection: bootstrapDeps.checkRunningInstance / .spawn default to
//    the real implementations but can be swapped for fakes in tests.
// 2. Explicit gate: in NODE_ENV=test (set globally by tests/setup.ts), the whole
//    block is skipped UNLESS APRA_FLEET_ENABLE_INTERACTIVE_BOOTSTRAP=1 is also
//    set -- an explicit, opt-in escape hatch for tests that specifically want to
//    exercise this path (and are expected to inject fakes via
//    __setInteractiveBootstrapDeps when they do).
export interface InteractiveBootstrapDeps {
  checkRunningInstance: typeof checkRunningInstance;
  spawn: typeof spawn;
  getProvider: typeof getProvider;
}

const realInteractiveBootstrapDeps: InteractiveBootstrapDeps = { checkRunningInstance, spawn, getProvider };
let interactiveBootstrapDeps: InteractiveBootstrapDeps = realInteractiveBootstrapDeps;

/** Test-only: inject fakes for the interactive-session bootstrap's HTTP check and process spawn. */
export function __setInteractiveBootstrapDeps(overrides: Partial<InteractiveBootstrapDeps>): void {
  interactiveBootstrapDeps = { ...realInteractiveBootstrapDeps, ...overrides };
}

/** Test-only: restore the real (non-mocked) bootstrap dependencies. */
export function __resetInteractiveBootstrapDeps(): void {
  interactiveBootstrapDeps = realInteractiveBootstrapDeps;
}

function interactiveBootstrapEnabled(): boolean {
  if (process.env.NODE_ENV !== 'test') return true;
  return process.env.APRA_FLEET_ENABLE_INTERACTIVE_BOOTSTRAP === '1';
}

export async function registerMember(input: RegisterMemberInput): Promise<string> {
  const warnings: string[] = [];
  const isLocal = input.member_type === 'local';
  const isCloud = !!input.cloud_provider;

  // --- Validate required fields ---
  if (isCloud) {
    if (!input.cloud_instance_id) return '❌ "cloud_instance_id" is required when cloud_provider is set. Member was NOT registered.';
    if (!input.key_path) return '❌ "key_path" is required when cloud_provider is set. Member was NOT registered.';
    if (!input.username) return '❌ "username" is required for cloud members. Member was NOT registered.';
  } else if (!isLocal) {
    if (!input.host) return '❌ "host" is required for remote members. Member was NOT registered.';
    if (!input.username) return '❌ "username" is required for remote members. Member was NOT registered.';
    if (!input.auth_type) return '❌ "auth_type" is required for remote members. Member was NOT registered.';
  }

  // Resolve {{secure.NAME}} tokens in password field
  let resolvedPassword = input.password;
  if (resolvedPassword) {
    const TOKEN_RE = /\{\{secure\.([a-zA-Z0-9_-]{1,64})\}\}/g;
    let match: RegExpExecArray | null;
    let resolved = resolvedPassword;
    const tokenNames = new Set<string>();
    while ((match = TOKEN_RE.exec(resolvedPassword)) !== null) {
      tokenNames.add(match[1]);
    }
    for (const name of tokenNames) {
      const entry = credentialResolve(name, input.friendly_name);
      if (entry && 'denied' in entry) return `❌ ${entry.denied} Member was NOT registered.`;
      if (entry && 'expired' in entry) return `❌ ${entry.expired} Member was NOT registered.`;
      if (entry) {
        resolved = resolved.replaceAll(`{{secure.${name}}}`, entry.plaintext);
        continue;
      }
      // Credential not found — auto-create via OOB
      const oob = await collectOobApiKey(name, 'register_member', { askPersist: true });
      if ('fallback' in oob) return oob.fallback ?? 'Error: OOB operation cancelled.';
      if (!oob.password) return `❌ No credential received for "${name}". Member was NOT registered.`;
      const plaintext = decryptPassword(oob.password);
      credentialSet(name, plaintext, !!oob.persist, 'deny');
      resolved = resolved.replaceAll(`{{secure.${name}}}`, plaintext);
    }
    resolvedPassword = resolved;
  }

  // Out-of-band password collection for remote password auth without inline password
  let preEncryptedPassword: string | undefined;
  if (!isLocal && input.auth_type === 'password' && !input.password) {
    const oob = await collectOobPassword(input.friendly_name, 'register_member', {
      prompt: `  Enter SSH password for ${input.username}@${input.host}: `,
    });
    if ('fallback' in oob) return oob.fallback ?? 'Error: OOB operation cancelled.';
    preEncryptedPassword = oob.password;
  }

  // --- model_tiers validation ---
  let normalizedModelTiers: { cheap?: string; standard?: string; premium?: string } | undefined;
  if (input.model_tiers) {
    const values = Object.values(input.model_tiers).filter(Boolean) as string[];
    if (values.length === 0) {
      return '[-] model_tiers was provided but contains no models. Supply at least one model. Member was NOT registered.';
    }
    if (values.length === 1) {
      normalizedModelTiers = { cheap: values[0], standard: values[0], premium: values[0] };
    } else {
      normalizedModelTiers = { ...input.model_tiers };
      const fallback = input.model_tiers.standard ?? input.model_tiers.cheap ?? values[0];
      if (!normalizedModelTiers.cheap) normalizedModelTiers.cheap = fallback;
      if (!normalizedModelTiers.standard) normalizedModelTiers.standard = fallback;
      if (!normalizedModelTiers.premium) normalizedModelTiers.premium = normalizedModelTiers.standard;
    }
  } else if ((input.llm_provider ?? 'claude') === 'opencode') {
    warnings.push('No model_tiers provided for opencode member -- adapter defaults will be used. Consider setting model_tiers for correct model resolution.');
  }

  // --- Duplicate folder check ---
  if (hasDuplicateFolder(input.member_type, input.work_folder, input.host, input.port)) {
    const scope = isLocal ? 'this machine' : `host ${input.host}:${input.port}`;
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
    authType: isLocal ? undefined : (input.auth_type ?? (isCloud ? 'key' : undefined)),
    encryptedPassword: preEncryptedPassword ?? ((!isLocal && resolvedPassword) ? encryptPassword(resolvedPassword) : undefined),
    keyPath: isLocal ? undefined : input.key_path,
    workFolder: input.work_folder,
    createdAt: new Date().toISOString(),
    gitAccess: input.git_access,
    gitRepos: input.git_repos,
    cloud: cloudConfig,
    llmProvider: input.llm_provider ?? 'claude',
    modelCheap: input.model_cheap,
    modelStandard: input.model_standard,
    modelPremium: input.model_premium,
    unattended: (input.unattended === 'false' ? false : input.unattended) ?? false,
    modelTiers: normalizedModelTiers,
    category: input.category,
    tags: input.tags,
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
        return `❌ Failed to connect to ${target} — ${classifySshError(connResult.error ?? '')}\nMember was NOT registered.`;
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
    const provider = getProvider(input.llm_provider ?? 'claude');
    const providerName = provider.name;
    // No-LLM members (apra-fleet-us9.14) have no CLI to verify or authenticate --
    // NoneProvider.versionCommand() throws by design (see providers/none.ts), so
    // this must be skipped entirely rather than merely tolerating a rejection.
    const isNoLlm = providerName === 'none';

    const versionCheck = isNoLlm ? Promise.resolve() : strategy.execCommand(cmds.agentVersion(provider), 15000)
      .then(r => {
        r.code === 0
          ? (claudeVersion = r.stdout.trim())
          : warnings.push(`${providerName} CLI not found on ${isLocal ? 'this machine' : 'remote machine'} — install it before using execute_prompt`);
      })
      .catch(() => { warnings.push(`Could not verify ${providerName} CLI availability`); });

    const authCheck = isNoLlm ? Promise.resolve() : (!isLocal
      ? strategy.execCommand(cmds.agentVersion(provider), 60000)
          .then(r => { r.code !== 0 && warnings.push(`${providerName} CLI not available — you may need to run provision_llm_auth`); })
          .catch(() => { warnings.push(`${providerName} CLI check timed out or failed — run provision_llm_auth to set up authentication`); })
      : Promise.resolve());

    const mkdirCheck = isLocal
      ? import('node:fs').then(({ mkdirSync }) => {
          mkdirSync(input.work_folder, { recursive: true });
        }).catch(() => { warnings.push(`Could not create folder "${input.work_folder}"`); })
      : strategy.execCommand(cmds.mkdir(input.work_folder), 10000)
          .catch(() => { warnings.push(`Could not create folder "${input.work_folder}"`); });

    await Promise.all([versionCheck, authCheck, mkdirCheck]);

    // --- Validate opencode model_tiers against available models ---
    if (!skipSshOps && (input.llm_provider ?? 'claude') === 'opencode' && normalizedModelTiers) {
      const { warnings: tierWarnings } = await validateOpenCodeModelTiers(tempAgent, normalizedModelTiers);
      warnings.push(...tierWarnings);
    }
  } else {
    tempAgent.os = detectedOS;
    if (isCloud && (input.llm_provider ?? 'claude') !== 'none') {
      warnings.push(`${input.llm_provider ?? 'claude'} CLI and auth not verified — run provision_llm_auth after the instance starts.`);
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
  logLine('register_member', `id=${tempAgent.id} name=${tempAgent.friendlyName} type=${tempAgent.agentType}`, tempAgent);
  writeStatusline();

  // Block global apra-fleet MCP + skills inside local agy member workspaces
  if (isLocal && (input.llm_provider ?? 'claude') === 'agy') {
    writeAgyWorkspaceOverlays(input.work_folder);
  }

  // Interactive session bootstrap for local Claude members
  const name = input.friendly_name;
  const memberProvider = input.llm_provider ?? 'claude';
  if (isLocal && memberProvider === 'claude' && interactiveBootstrapEnabled()) {
    // HIGH-1: Verify fleet server is running before spawning.
    // Resolve the ACTUAL running instance (server.json, singleton-managed) instead of
    // assuming DEFAULT_PORT -- this respects APRA_FLEET_PORT and EADDRINUSE fallback.
    const instance = await interactiveBootstrapDeps.checkRunningInstance();
    if (!instance.running) {
      return `❌ Fleet server not running. Start it first with apra-fleet start, then re-run register_member.`;
    }
    const mcpUrl = instance.url; // e.g. http://127.0.0.1:<actual-port>/mcp

    // Mint through the pluggable issuer: workspace_id is the hard security
    // boundary (docs/hub-spoke-master-plan.md section 3); the local dev-mode
    // issuer derives it from this install's identity (one machine == one
    // workspace). A hub-era issuer swaps in behind the same interface.
    const { getTokenIssuer } = await import('../services/token-issuer.js');
    const issuer = getTokenIssuer();
    const token = issuer.issue({
      member_id: tempAgent.id,
      role: 'doer',
      work_folder: input.work_folder,
    });

    // Registration uses the provider's OWN native mechanism (apra-fleet-fnz.1,
    // docs/member-onboarding-journey.md section 3/4 Journey A) rather than
    // hand-writing a config file -- this is also what makes the mechanism
    // provider-agnostic (AGY/OpenCode implement the same interface method with
    // their own native paths) and avoids fighting compose_permissions' own
    // writes to the same provider config (apra-fleet-2xs.1).
    const memberProviderAdapter = interactiveBootstrapDeps.getProvider(tempAgent.llmProvider);
    if (memberProviderAdapter.registerMcpEndpoint) {
      try {
        await memberProviderAdapter.registerMcpEndpoint({
          // Identity is keyed on the member UUID everywhere -- the URL fallback
          // param carries the UUID, matching the JWT's member_id claim.
          url: mcpUrl + '?member=' + tempAgent.id,
          token,
          workFolder: input.work_folder,
          scope: 'project',
        });
      } catch (e: any) {
        warnings.push(`Could not register MCP endpoint: ${e.message}`);
      }
    } else {
      warnings.push(`Provider "${memberProviderAdapter.name}" has no registerMcpEndpoint() -- interactive session bootstrap skipped.`);
    }

    // CRITICAL-2: Kill existing claude process for this member before re-spawning
    const { sessionRegistry } = await import('../services/session-registry.js');
    const existingSession = sessionRegistry.get(issuer.workspaceId(), tempAgent.id);
    if (existingSession?.pid) {
      try {
        process.kill(existingSession.pid);
        logLine('register_member', `Killed existing claude pid=${existingSession.pid} for member ${name}`);
      } catch {
        // Process already gone -- ignore
      }
    }

    try {
      const proc = interactiveBootstrapDeps.spawn('claude', ['--dangerously-load-development-channels'], { cwd: input.work_folder, detached: true, stdio: 'ignore', shell: true });
      proc.unref();
      if (proc.pid) {
        sessionRegistry.register({
          member_id: tempAgent.id,
          workspace_id: issuer.workspaceId(),
          role: 'doer',
          work_folder: input.work_folder,
          server: null,
          pid: proc.pid,
          status: 'idle',
        });
      }
      logLine('register_member', `Launched claude for member ${name}, pid ${proc.pid}`);
    } catch (e: any) {
      warnings.push(`Could not launch claude: ${e.message}`);
    }
  }

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
  result += `  Provider: ${tempAgent.llmProvider ?? 'claude'}\n`;
  if (tempAgent.category) {
    result += `  Category: ${tempAgent.category}\n`;
  }
  if (tempAgent.tags && tempAgent.tags.length > 0) {
    result += `  Tags:     ${tempAgent.tags.join(', ')}\n`;
  }
  if (tempAgent.modelCheap) result += `  Model Cheap: ${tempAgent.modelCheap}\n`;
  if (tempAgent.modelStandard) result += `  Model Standard: ${tempAgent.modelStandard}\n`;
  if (tempAgent.modelPremium) result += `  Model Premium: ${tempAgent.modelPremium}\n`;
  if (tempAgent.modelTiers) {
    const mt = tempAgent.modelTiers;
    result += `  Model Tiers: cheap=${mt.cheap ?? '-'} standard=${mt.standard ?? '-'} premium=${mt.premium ?? '-'}\n`;
  }
  if (claudeVersion) {
    result += `  CLI:     ${claudeVersion}\n`;
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

