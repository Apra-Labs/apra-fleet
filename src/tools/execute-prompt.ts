import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { getProvider } from '../providers/index.js';
import { getAgentOS, touchAgent } from '../utils/agent-helpers.js';
import { updateAgent } from '../services/registry.js';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { isRetryable, authErrorAdvice } from '../utils/prompt-errors.js';
import { buildAuthEnvPrefix } from '../utils/auth-env.js';
import { writeStatusline } from '../services/statusline.js';
import { getModelOverride } from '../services/user-config.js';
import { ensureCloudReady } from '../services/cloud/lifecycle.js';
import { getStallDetector, resolveSessionLogPath } from '../services/stall/index.js';
import { provisionAgents, remoteAgentsDir } from '../services/agent-provisioner.js';
import { escapeWindowsArg, escapeDoubleQuoted } from '../os/os-commands.js';
import { resolveTilde } from './execute-command.js';
import { clearStoredPid } from '../utils/agent-helpers.js';
import { tryKillPid } from '../utils/pid-helpers.js';
import { LogScope, maskSecrets, truncateForLog } from '../utils/log-helpers.js';
import { getLogPreviewChars } from '../services/user-config.js';
import type { Agent, SSHExecResult } from '../types.js';
import type { AgentStrategy } from '../services/strategy.js';
import type { ProviderAdapter } from '../providers/index.js';

export const executePromptSchema = z.object({
  ...memberIdentifier,
  prompt: z.string().describe('The prompt to send to the LLM on the remote member'),
  resume: z.boolean().default(true).describe('Resume the previous session if one exists (default: true)'),
  timeout_s: z.number().default(300).describe('Inactivity timeout in seconds — the command is killed after this many seconds without any stdout/stderr output (default: 300s / 5 minutes)'),
  max_total_s: z.number().optional().describe('Hard ceiling in seconds — the command is killed after this total elapsed time regardless of activity. If omitted, there is no total time limit.'),
  max_turns: z.number().min(1).max(500).optional().describe('Max turns for claude -p (default: 50)'),
  dangerously_skip_permissions: z.boolean().default(false).describe('DEPRECATED: use update_member(unattended="dangerous") instead. This field is ignored and will be removed in a future version.'),
  model: z.string().optional().describe('Model tier ("cheap", "standard", "premium") or a specific model ID for power users. Prefer tier names — the server resolves them to the correct model per provider. If omitted, defaults to the standard tier. Applies to both new and resumed sessions.'),
});

export type ExecutePromptInput = z.infer<typeof executePromptSchema>;

function buildFailureMessage(agentName: string, result: SSHExecResult, provider: ProviderAdapter): string {
  const output = result.stderr || result.stdout;
  const category = provider.classifyError(output);
  return category === 'auth'
    ? authErrorAdvice(agentName)
    : `❌ Prompt failed on "${agentName}":
${output}`;
}

const SERVER_RETRY_DELAY_MS = 5000;

async function writePromptFile(agent: Agent, strategy: AgentStrategy, promptFilePath: string, content: string): Promise<void> {
  if (agent.agentType === 'local') {
    fs.writeFileSync(promptFilePath, content, 'utf-8');
    return;
  }
  const agentOs = getAgentOS(agent);
  const promptFileName = path.basename(promptFilePath);
  const remoteDir = path.dirname(promptFilePath);

  if (agentOs === 'windows') {
    const escapedFolder = escapeWindowsArg(remoteDir);
    const psScript = `New-Item -Path '${escapedFolder}' -ItemType Directory -Force | Out-Null; Set-Location "${escapedFolder}"; Set-Content -Path "${promptFileName}" -Value '${content.replace(/'/g, "''")}' -NoNewline -Encoding UTF8`;
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    await strategy.execCommand(`powershell -EncodedCommand ${encoded}`);
  } else {
    const b64 = Buffer.from(content).toString('base64');
    const escapedFolder = escapeDoubleQuoted(remoteDir);
    await strategy.execCommand(`mkdir -p "${escapedFolder}" && cd "${escapedFolder}" && echo '${b64}' | base64 -d > ${promptFileName}`);
  }
}

async function deletePromptFile(agent: Agent, strategy: AgentStrategy, promptFilePath: string): Promise<void> {
  if (agent.agentType === 'local') {
    try { fs.unlinkSync(promptFilePath); } catch { /* ignore */ }
    return;
  }
  const agentOs = getAgentOS(agent);
  const promptFileName = path.basename(promptFilePath);
  const remoteDir = path.dirname(promptFilePath);

  if (agentOs === 'windows') {
    const escapedFolder = escapeWindowsArg(remoteDir);
    const psScript = `Set-Location "${escapedFolder}"; Remove-Item "${promptFileName}" -Force -ErrorAction SilentlyContinue`;
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    await strategy.execCommand(`powershell -EncodedCommand ${encoded}`).catch(() => { /* ignore */ });
  } else {
    const escapedFolder = escapeDoubleQuoted(remoteDir);
    await strategy.execCommand(`cd "${escapedFolder}" && rm -f ${promptFileName}`).catch(() => { /* ignore */ });
  }
}

export function resolveModelForTier(agent: Agent, tier: string, provider: ProviderAdapter): string {
  const memberTiers = agent.modelTiers;
  if (memberTiers) {
    const t = tier as keyof typeof memberTiers;
    return memberTiers[t] ?? memberTiers.standard ?? memberTiers.cheap ?? Object.values(memberTiers).filter(Boolean)[0] as string;
  }
  return provider.modelForTier(tier as 'cheap' | 'mid' | 'premium');
}

const SECURE_TOKEN_RE = /\{\{secure\.[a-zA-Z0-9_-]{1,64}\}\}/;

export const inFlightAgents = new Set<string>();

// Member ids whose remote agent files (planner.md, doer.md, _shared/, schemas/, ...)
// have already been probed/refreshed this server process uptime -- the #336
// provisioner is a real SSH round trip, so we pay that cost once per member per
// run rather than on every dispatch. Local members share the operator's home dir
// and never need this; providers with no remote agents dir (codex, copilot) are
// cheap to check and also skipped.
export const provisionedRemoteAgents = new Set<string>();

/**
 * Bring a remote member's agent files current before dispatch (the 0.3.4->0.3.5
 * upgrade path: #336 only provisions on register_member/update_member, so an
 * already-registered member stays stale until this runs). Never throws --
 * provisioning failures must not block the prompt dispatch.
 */
async function ensureAgentFilesProvisioned(agent: Agent): Promise<void> {
  if (agent.agentType === 'local') return;
  if (provisionedRemoteAgents.has(agent.id)) return;
  provisionedRemoteAgents.add(agent.id);

  if (remoteAgentsDir(agent.llmProvider ?? 'claude') === null) return;

  try {
    const result = await provisionAgents(agent);
    if (result.warning) {
      // Probe or upload failed -- do not trust the cache, retry on next dispatch.
      provisionedRemoteAgents.delete(agent.id);
    }
  } catch {
    // warn-and-continue, same as register_member/update_member's wire-in, but
    // a transient failure must not permanently poison the cache.
    provisionedRemoteAgents.delete(agent.id);
  }
}

// All exit paths from executePrompt clear busy state via the finally block (inFlightAgents.delete + writeStatusline):
// (a) normal success: result.code === 0 → finally sets idle and removes agent from inFlight
// (b) non-zero exit from execCommand: result.code !== 0 → finally sets idle and removes agent from inFlight
// (c) exception in try block (auth, network, crash) → catch records error type; finally sets offline or idle
// (d) AbortSignal/MCP client cancellation → abortHandler kills PID, execCommand resolves, finally clears
// (e) stale session retry → retried without session ID; finally clears on success or failure
// (f) server overload retry → retried after delay; finally clears on success or failure
// (g) early returns before inFlightAgents.add: busy state never entered

export async function executePrompt(input: ExecutePromptInput, extra?: any): Promise<string> {
  if (SECURE_TOKEN_RE.test(input.prompt)) {
    return 'error: execute_prompt prompt contains {{secure.NAME}} token. Secrets must never be passed to LLM prompts. Use execute_command with {{secure.NAME}} instead.';
  }

  const promptFileName = `.fleet-task.md`;

  const agentOrError = resolveMember(input.member_id, input.member_name);
  if (typeof agentOrError === 'string') return agentOrError;
  let agent: Agent;
  try {
    agent = await ensureCloudReady(agentOrError as Agent); // auto-start if stopped
  } catch (err: any) {
    return `❌ Failed to execute prompt on "${(agentOrError as Agent).friendlyName}": ${err.message}`;
  }

  if (inFlightAgents.has(agent.id)) {
    return `❌ execute_prompt is already running for "${agent.friendlyName}". Wait for the current call to finish before sending another.`;
  }
  inFlightAgents.add(agent.id);

  await ensureAgentFilesProvisioned(agent);
  const stallDetector = getStallDetector();
  let clearedByStall = false;
  stallDetector.add(agent.id, {
    sessionId: null,
    logFilePath: null,
    lastActivityAt: Date.now(),
    consecutiveIdleCycles: 0,
    consecutiveReadFailures: 0,
    memberId: agent.id,
    memberName: agent.friendlyName,
    provisional: true,
    stallReported: false,
    onStall: () => {
      // Stall detector already wrote 'unknown' to the statusline before calling here.
      // Our job: clear in-process state so the member can accept new calls.
      // clearedByStall prevents the eventually-resolving finally block from clobbering
      // a new execute_prompt that may have already claimed the member.
      inFlightAgents.delete(agent.id);
      clearedByStall = true;
    },
  });

  const tmpDir = agent.agentType === 'local' ? os.tmpdir() : '/tmp';
  const resolvedWorkFolder = agent.agentType === 'local' ? resolveTilde(agent.workFolder) : agent.workFolder;
  const promptFilePath = agent.agentType === 'local'
    ? path.join(resolvedWorkFolder, promptFileName)
    : `${resolvedWorkFolder}/${promptFileName}`;

  const strategy = getStrategy(agent);
  const cmds = getOsCommands(getAgentOS(agent));
  const provider = getProvider(agent.llmProvider);

  const authPrefix = buildAuthEnvPrefix(agent, getAgentOS(agent));

  const tiers = provider.modelTiers();
  let resolvedModel = input.model || 'standard';
  let resolvedTier: 'cheap' | 'standard' | 'premium' | undefined;
  if (resolvedModel === 'cheap') {
    resolvedTier = 'cheap';
    resolvedModel = agent.modelTiers
      ? resolveModelForTier(agent, 'cheap', provider)
      : agent.modelCheap || getModelOverride(provider.name, 'cheap') || tiers.cheap;
  } else if (resolvedModel === 'standard') {
    resolvedTier = 'standard';
    resolvedModel = agent.modelTiers
      ? resolveModelForTier(agent, 'standard', provider)
      : agent.modelStandard || getModelOverride(provider.name, 'standard') || tiers.standard;
  } else if (resolvedModel === 'premium') {
    resolvedTier = 'premium';
    resolvedModel = agent.modelTiers
      ? resolveModelForTier(agent, 'premium', provider)
      : agent.modelPremium || getModelOverride(provider.name, 'premium') || tiers.premium;
  } else {
    resolvedModel = tiers[resolvedModel as keyof typeof tiers] ?? resolvedModel;
  }

  const deprecationWarning = input.dangerously_skip_permissions
    ? '⚠️ DEPRECATION: dangerously_skip_permissions is deprecated and ignored. Use update_member(unattended="dangerous") instead.\n\n'
    : '';

  const scope = new LogScope('execute_prompt', `[${resolvedModel}] resume=${input.resume} timeout=${input.timeout_s ?? 300}s ${truncateForLog(maskSecrets(input.prompt), getLogPreviewChars())}`, agent);

  const resuming = !!(input.resume && agent.sessionId && provider.supportsResume());
  const mintedId = (provider.name === 'claude' || provider.name === 'gemini' || provider.name === 'agy')
    ? (resuming ? agent.sessionId! : uuid())
    : (resuming ? agent.sessionId : undefined);

  const promptOpts = {
    folder: resolvedWorkFolder,
    promptFile: promptFileName,
    sessionId: mintedId,
    resuming,
    unattended: agent.unattended,
    model: resolvedModel,
    tier: resolvedTier,
    maxTurns: input.max_turns,
    inv: scope.getInv(),
  };

  const claudeCmd = authPrefix + cmds.buildAgentPromptCommand(provider, promptOpts);

  const timeoutMs = (input.timeout_s ?? 300) * 1000;
  const maxTotalMs = input.max_total_s !== undefined ? input.max_total_s * 1000 : undefined;

  // Kill any leftover session from a previous (possibly zombie) execute_prompt call
  await tryKillPid(agent, strategy, cmds);

  // Write the prompt to the unique prompt file before execution
  await writePromptFile(agent, strategy, promptFilePath, input.prompt);

  const onPidCaptured = (pid: number) => {
    scope.info(`pid=${pid}`);
    if (mintedId) {
      try {
        const logPath = resolveSessionLogPath(agent.llmProvider ?? 'claude', mintedId, agent.workFolder);
        stallDetector.update(agent.id, {
          sessionId: mintedId,
          logFilePath: logPath,
          provisional: false,
        });
      } catch { /* copilot/codex: no log path resolution */ }
    }
  };

  const abortHandler = () => {
    scope.abort('cancelled by MCP client');
    tryKillPid(agent, strategy, cmds).catch(() => {});
  };
  extra?.signal?.addEventListener('abort', abortHandler);


  // Mark agent as busy in statusline
  writeStatusline(new Map([[agent.id, 'busy']]));

  let _epExitCode: number | 'error' = 'error';
  let _epError: string | undefined;
  let _epUsage: { input_tokens: number; output_tokens: number } | undefined;
  let _epOffline = false;
  try {
    let result = await strategy.execCommand(claudeCmd, timeoutMs, maxTotalMs, onPidCaptured, extra?.signal);
    let parsed = provider.parseResponse(result);
    if (parsed.usage) _epUsage = parsed.usage;

    // Stale session retry — fresh session ID, no resume
    if (result.code !== 0 && input.resume && agent.sessionId) {
      scope.info(`[${resolvedModel}] retrying — stale session`);
      await tryKillPid(agent, strategy, cmds);
      const freshOpts = { ...promptOpts, sessionId: (provider.name === 'claude' || provider.name === 'gemini' || provider.name === 'agy') ? uuid() : undefined, resuming: false };
      const retryCmd = authPrefix + cmds.buildAgentPromptCommand(provider, freshOpts);
      result = await strategy.execCommand(retryCmd, timeoutMs, maxTotalMs, onPidCaptured, extra?.signal);
      parsed = provider.parseResponse(result);
      if (parsed.usage) _epUsage = parsed.usage;
    }

    // Server/overloaded error retry — single attempt after delay
    if (result.code !== 0 && isRetryable(provider.classifyError(result.stderr || result.stdout))) {
      scope.info(`[${resolvedModel}] retrying — server overloaded`);
      await tryKillPid(agent, strategy, cmds);
      await new Promise(r => setTimeout(r, SERVER_RETRY_DELAY_MS));
      const freshOpts = { ...promptOpts, sessionId: (provider.name === 'claude' || provider.name === 'gemini' || provider.name === 'agy') ? uuid() : undefined, resuming: false };
      const retryCmd = authPrefix + cmds.buildAgentPromptCommand(provider, freshOpts);
      result = await strategy.execCommand(retryCmd, timeoutMs, maxTotalMs, onPidCaptured, extra?.signal);
      parsed = provider.parseResponse(result);
      if (parsed.usage) _epUsage = parsed.usage;
    }

    _epExitCode = result.code;
    if (result.code !== 0) {
      return buildFailureMessage(agent.friendlyName, result, provider);
    }

    // Session-id assertion: returned id must match the one we minted/resumed
    if (mintedId && parsed.sessionId && parsed.sessionId !== mintedId) {
      scope.info(`session-id mismatch: expected=${mintedId} got=${parsed.sessionId} -- not persisting`);
      touchAgent(agent.id, undefined);
    } else {
      touchAgent(agent.id, mintedId ?? parsed.sessionId);
    }
    if (mintedId) {
      try {
        stallDetector.update(agent.id, {
          sessionId: mintedId,
          logFilePath: resolveSessionLogPath(agent.llmProvider ?? 'claude', mintedId, agent.workFolder),
          provisional: false,
        });
      } catch { /* copilot/codex: no log path resolution */ }
    }
    clearStoredPid(agent.id);

    if (parsed.usage) {
      const prev = agent.tokenUsage ?? { input: 0, output: 0 };
      updateAgent(agent.id, {
        tokenUsage: {
          input: prev.input + parsed.usage.input_tokens,
          output: prev.output + parsed.usage.output_tokens,
        },
      });
    }

    let output = `${deprecationWarning}📋 Response from ${agent.friendlyName}:

${parsed.result}`;
    if (parsed.usage) output += `
Tokens: input=${parsed.usage.input_tokens} output=${parsed.usage.output_tokens}`;
    if (parsed.sessionId) output += `

---
session: ${parsed.sessionId}`;
    return output;
  } catch (err: any) {
    // Only mark offline for genuine SSH/network connection failures, not for cancellations
    _epOffline = !!(err.message && /ssh|network|econnrefused|ehostunreach|connection timed out/i.test(err.message));
    _epError = err.message;
    return `❌ Failed to execute prompt on "${agent.friendlyName}": ${err.message}`;
  } finally {
    extra?.signal?.removeEventListener('abort', abortHandler);
    const _epTok = _epUsage ? ` in=${_epUsage.input_tokens} out=${_epUsage.output_tokens}` : '';
    if (_epExitCode === 'error') scope.abort(`${_epError ?? 'exception'}${_epTok}`);
    else if (_epExitCode !== 0) scope.fail(`exit=${_epExitCode}${_epTok}`);
    else scope.ok(`exit=0${_epTok}`);
    // Skip if stall detector already cleared state — a new execute_prompt may have
    // claimed inFlightAgents and set busy again; clobbering it here would be wrong.
    if (!clearedByStall) {
      writeStatusline(new Map([[agent.id, _epOffline ? 'offline' : 'idle']]));
      inFlightAgents.delete(agent.id);
    }
    stallDetector.remove(agent.id);
    await deletePromptFile(agent, strategy, promptFilePath);
  }
}
