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
import { escapeWindowsArg, escapeDoubleQuoted } from '../os/os-commands.js';
import { resolveTilde } from './execute-command.js';
import { clearStoredPid } from '../utils/agent-helpers.js';
import { tryKillPid } from '../utils/pid-helpers.js';
import { LogScope, maskSecrets, truncateForLog } from '../utils/log-helpers.js';
import { getLogPreviewChars } from '../services/user-config.js';
import { validateSubstitutionKeys, applySubstitutions } from '../services/substitution-engine.js';
import { sessionRegistry } from '../services/session-registry.js';
import { getTokenIssuer } from '../services/token-issuer.js';
import { sendMessage } from './send-message.js';
import { registerPending } from '../services/pending-responses.js';
import type { Agent, SSHExecResult } from '../types.js';
import type { AgentStrategy } from '../services/strategy.js';
import type { ProviderAdapter } from '../providers/index.js';

export interface ExecutePromptStructured {
  isError?: boolean;
  reason?: 'busy' | 'dispatch_failed' | 'nonzero_exit';
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
  sessionId?: string;
  [key: string]: unknown;
}

export interface ExecutePromptResult {
  text: string;
  structuredContent?: ExecutePromptStructured;
}

export const executePromptSchema = z.object({
  ...memberIdentifier,
  prompt: z.string().describe('The prompt to send to the LLM on the remote member'),
  resume: z.boolean().default(true).describe('Resume the previous session if one exists (default: true)'),
  timeout_s: z.number().default(300).describe('Inactivity timeout in seconds -- the command is killed after this many seconds without any stdout/stderr output (default: 300s / 5 minutes)'),
  max_total_s: z.number().optional().describe('Hard ceiling in seconds -- the command is killed after this total elapsed time regardless of activity. If omitted, there is no total time limit.'),
  max_turns: z.number().min(1).max(500).optional().describe('Max turns for claude -p (default: 50)'),
  model: z.string().optional().describe('Model tier ("cheap", "standard", "premium") or a specific model ID for power users. Prefer tier names -- the server resolves them to the correct model per provider. If omitted, defaults to the standard tier. Applies to both new and resumed sessions.'),
  substitutions: z.record(z.string(), z.string()).optional().describe(
    'Optional map of token name to replacement value. ' +
    'When provided, every occurrence of {{name}} in the prompt is replaced before the prompt is staged on the member. ' +
    'Keys must match [A-Za-z_][A-Za-z0-9_]*. Missing tokens cause the call to fail with no CLI invoked. ' +
    'Extra keys are silently ignored. Values are never logged.'
  ),
  agent: z.string().optional().describe(
    'Optional agent name to activate. ' +
    'For Claude: invokes claude --agent <name>. ' +
    'For Gemini: prepends @<name> to the prompt on every dispatch. ' +
    'For AGY: prepends @<name> to the prompt on every dispatch (same as Gemini). ' +
    'Substitution runs before the @<name> prepend. ' +
    'Agent file must exist at the provider-specific path on the member: ' +
    'Claude: <workFolder>/.claude/agents/<name>.md or ~/.claude/agents/<name>.md; ' +
    'Gemini: <workFolder>/.gemini/agents/<name>.md or ~/.gemini/agents/<name>.md; ' +
    'AGY: <workFolder>/.gemini/antigravity-cli/agents/<name>.md or ~/.gemini/antigravity-cli/agents/<name>.md -- ' +
    'the call is rejected with a clear error if neither is present.'
  ),
}).strict();

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

// All exit paths from executePrompt clear busy state via the finally block (inFlightAgents.delete + writeStatusline):
// (a) normal success: result.code === 0 -> finally sets idle and removes agent from inFlight
// (b) non-zero exit from execCommand: result.code !== 0 -> finally sets idle and removes agent from inFlight
// (c) exception in try block (auth, network, crash) -> catch records error type; finally sets offline or idle
// (d) AbortSignal/MCP client cancellation -> abortHandler kills PID, execCommand resolves, finally clears
// (e) stale session retry -> retried without session ID; finally clears on success or failure
// (f) server overload retry -> retried after delay; finally clears on success or failure
// (g) early returns before inFlightAgents.add: busy state never entered

/**
 * Interactive routing (apra-fleet-2xs.8): pushes the prompt to a connected
 * member's live session via send_message and waits for that member to call
 * respond_to_message with the matching reply_to. No subprocess, no SSH, no
 * prompt file, no stall detector on a log file -- the session is a
 * long-lived interactive process, not something this call spawns or owns.
 */
async function executePromptInteractive(
  agent: Agent,
  renderedPrompt: string,
  input: ExecutePromptInput,
  workspaceId: string,
  heuristicWarningSuffix: string,
): Promise<string> {
  const timeoutS = input.timeout_s ?? 300;
  const scope = new LogScope('execute_prompt', `[interactive] timeout=${timeoutS}s ${truncateForLog(maskSecrets(input.prompt))}`, agent);

  const sendResult = await sendMessage({ member_id: agent.id, content: renderedPrompt }, workspaceId);
  const parsed = JSON.parse(sendResult);
  if (parsed.error) {
    scope.abort(`send failed: ${parsed.error}`);
    return `❌ Failed to deliver prompt to "${agent.friendlyName}" (interactive session): ${parsed.error}`;
  }

  try {
    const response = await registerPending(parsed.msgid, timeoutS * 1000);
    scope.ok('interactive response received');
    let output = `📋 Response from ${agent.friendlyName}:\n\n${response}`;
    if (heuristicWarningSuffix) output += heuristicWarningSuffix;
    return output;
  } catch (err: any) {
    scope.abort(`interactive timeout: ${err.message}`);
    return `❌ Timed out waiting for "${agent.friendlyName}" to respond (interactive session, ${timeoutS}s). The prompt was delivered; the member may still respond late, but this call has given up waiting.`;
  }
}

export async function executePrompt(input: ExecutePromptInput, extra?: any): Promise<string | ExecutePromptResult> {
  if (SECURE_TOKEN_RE.test(input.prompt)) {
    return 'error: execute_prompt prompt contains {{secure.NAME}} token. Secrets must never be passed to LLM prompts. Use execute_command with {{secure.NAME}} instead.';
  }

  // Validate substitution keys before any I/O or member resolution.
  if (input.substitutions !== undefined) {
    const keyCheck = validateSubstitutionKeys('execute_prompt', input.substitutions);
    if (!keyCheck.ok) return keyCheck.error;
  }

  // Apply substitutions to the prompt string (or emit heuristic warning when omitted).
  let renderedPrompt = input.prompt;
  let heuristicWarningSuffix = '';

  if (input.substitutions !== undefined) {
    const result = applySubstitutions('execute_prompt', [{ label: 'prompt', content: input.prompt }], input.substitutions);
    if (!result.ok) return result.error;
    renderedPrompt = result.outputs[0];
  } else {
    const warnResult = applySubstitutions('execute_prompt', [{ label: 'prompt', content: input.prompt }], undefined);
    if (warnResult.ok && warnResult.warning) {
      heuristicWarningSuffix = `\n\n[WARN] ${warnResult.warning}`;
    }
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
    return {
      text: `❌ execute_prompt is already running for "${agent.friendlyName}". Wait for the current call to finish before sending another.`,
      structuredContent: { isError: true, reason: 'busy' },
    };
  }

  // No-LLM members (apra-fleet-us9.14) are plain command executors -- neither
  // execute_prompt mode applies (there is no LLM to prompt in either a
  // subprocess or an interactive session). Rejected here, before any busy
  // state is entered, rather than relying on NoneProvider's methods to throw
  // deeper in either dispatch path.
  if (agent.llmProvider === 'none') {
    return `❌ "${agent.friendlyName}" has no LLM provider (llm_provider: "none") -- it is a plain command executor. Use execute_command instead.`;
  }

  // Interactive routing (apra-fleet-2xs.8/us9.8, docs/cloud-fleet-architecture.md
  // section 6): if this member has a live MCP session connected right now,
  // route via send_message + wait-for-response instead of spawning a
  // subprocess. Decided tier-2-locally against THIS machine's session
  // registry only (never caller/hub-side state, per apra-fleet-2xs.8's own
  // scope note) -- so behavior is unaffected by whether execute_prompt is
  // invoked directly (Phase 1) or relayed through a future hub. Falls
  // through to the unchanged subprocess/SSH path below for every member
  // without a live session (the common case today, and always for members
  // that never opt into an interactive session).
  //
  // Gated to Claude only (apra-fleet-us9.9's survey,
  // docs/interactive-injection-provider-survey.md): mode (b) -- server-push
  // mid-session prompt injection -- is POC-proven on Claude alone via the
  // provider-branded `notifications/claude/channel` capability.
  // Gemini/Codex are confirmed [FAIL] (no equivalent push mechanism);
  // Copilot/AGY/OpenCode are [TBD], not confirmed. A non-Claude member CAN
  // still have a live sessionRegistry entry (registerMcpEndpoint gives it
  // basic MCP tool access, apra-fleet-fnz.1-3) without that meaning it can
  // receive or act on this push -- routing to it anyway would silently
  // spend the full timeout_s waiting for a response that can never arrive.
  const isClaudeMember = (agent.llmProvider ?? 'claude') === 'claude';
  const workspaceId = getTokenIssuer().workspaceId();
  const interactiveSession = isClaudeMember ? sessionRegistry.get(workspaceId, agent.id) : undefined;
  if (interactiveSession?.server) {
    inFlightAgents.add(agent.id);
    writeStatusline(new Map([[agent.id, 'busy']]));
    try {
      return await executePromptInteractive(agent, renderedPrompt, input, workspaceId, heuristicWarningSuffix);
    } finally {
      inFlightAgents.delete(agent.id);
      writeStatusline(new Map([[agent.id, 'idle']]));
    }
  }

  inFlightAgents.add(agent.id);
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
    agentName: input.agent,
  };

  const claudeCmd = authPrefix + cmds.buildAgentPromptCommand(provider, promptOpts);

  const timeoutMs = (input.timeout_s ?? 300) * 1000;
  const maxTotalMs = input.max_total_s !== undefined ? input.max_total_s * 1000 : undefined;

  // Agent file validation -- verify named agent exists before any CLI invocation
  if (input.agent) {
    const provName = provider.name;
    // AGY uses ~/.gemini/antigravity-cli/ as its config root, not ~/.agy/
    const agentRelDir = provName === 'agy' ? '.gemini/antigravity-cli/agents' : `.${provName}/agents`;
    let agentFound = false;
    if (agent.agentType === 'local') {
      const projPath = path.join(resolvedWorkFolder, agentRelDir, `${input.agent}.md`);
      const userPath = path.join(os.homedir(), agentRelDir, `${input.agent}.md`);
      agentFound = fs.existsSync(projPath) || fs.existsSync(userPath);
      if (!agentFound) {
        inFlightAgents.delete(agent.id);
        stallDetector.remove(agent.id);
        writeStatusline(new Map([[agent.id, 'idle']]));
        return `execute_prompt: agent "${input.agent}" not found.\n\nExpected at:\n  ${projPath.replace(/\\/g, '/')}\n  ${userPath.replace(/\\/g, '/')}`;
      }
    } else {
      const ef = escapeDoubleQuoted;
      const projCheck = `${ef(resolvedWorkFolder)}/${agentRelDir}/${ef(input.agent)}.md`;
      const userCheck = `$HOME/${agentRelDir}/${ef(input.agent)}.md`;
      const checkResult = await strategy.execCommand(`test -f "${projCheck}" || test -f "${userCheck}"`, 10000);
      if (checkResult.code !== 0) {
        inFlightAgents.delete(agent.id);
        stallDetector.remove(agent.id);
        writeStatusline(new Map([[agent.id, 'idle']]));
        return `execute_prompt: agent "${input.agent}" not found on "${agent.friendlyName}".\n\nExpected at:\n  ${resolvedWorkFolder}/${agentRelDir}/${input.agent}.md\n  ~/${agentRelDir}/${input.agent}.md`;
      }
    }
  }

  // Kill any leftover session from a previous (possibly zombie) execute_prompt call
  await tryKillPid(agent, strategy, cmds);

  // Write the rendered prompt (with substitutions applied) to the prompt file before execution
  await writePromptFile(agent, strategy, promptFilePath, renderedPrompt);

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

    // Stale session retry -- fresh session ID, no resume
    if (result.code !== 0 && input.resume && agent.sessionId) {
      scope.info(`[${resolvedModel}] retrying -- stale session`);
      await tryKillPid(agent, strategy, cmds);
      const freshOpts = { ...promptOpts, sessionId: (provider.name === 'claude' || provider.name === 'gemini' || provider.name === 'agy') ? uuid() : undefined, resuming: false };
      const retryCmd = authPrefix + cmds.buildAgentPromptCommand(provider, freshOpts);
      result = await strategy.execCommand(retryCmd, timeoutMs, maxTotalMs, onPidCaptured, extra?.signal);
      parsed = provider.parseResponse(result);
      if (parsed.usage) _epUsage = parsed.usage;
    }

    // Server/overloaded error retry -- single attempt after delay
    if (result.code !== 0 && isRetryable(provider.classifyError(result.stderr || result.stdout))) {
      scope.info(`[${resolvedModel}] retrying -- server overloaded`);
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
      return {
        text: buildFailureMessage(agent.friendlyName, result, provider),
        structuredContent: { isError: true, reason: 'nonzero_exit' },
      };
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

    let output = `📋 Response from ${agent.friendlyName}:

${parsed.result}`;
    if (parsed.usage) output += `
Tokens: input=${parsed.usage.input_tokens} output=${parsed.usage.output_tokens}`;
    if (parsed.sessionId) output += `

---
session: ${parsed.sessionId}`;
    if (heuristicWarningSuffix) output += heuristicWarningSuffix;
    return {
      text: output,
      structuredContent: {
        ...(_epUsage ? { usage: { input_tokens: _epUsage.input_tokens, output_tokens: _epUsage.output_tokens, total_tokens: _epUsage.input_tokens + _epUsage.output_tokens } } : {}),
        ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
      },
    };
  } catch (err: any) {
    // Only mark offline for genuine SSH/network connection failures, not for cancellations
    _epOffline = !!(err.message && /ssh|network|econnrefused|ehostunreach|connection timed out/i.test(err.message));
    _epError = err.message;
    return {
      text: `❌ Failed to execute prompt on "${agent.friendlyName}": ${err.message}`,
      structuredContent: { isError: true, reason: 'dispatch_failed' },
    };
  } finally {
    extra?.signal?.removeEventListener('abort', abortHandler);
    const _epTok = _epUsage ? ` in=${_epUsage.input_tokens} out=${_epUsage.output_tokens}` : '';
    if (_epExitCode === 'error') scope.abort(`${_epError ?? 'exception'}${_epTok}`);
    else if (_epExitCode !== 0) scope.fail(`exit=${_epExitCode}${_epTok}`);
    else scope.ok(`exit=0${_epTok}`);
    // Skip if stall detector already cleared state -- a new execute_prompt may have
    // claimed inFlightAgents and set busy again; clobbering it here would be wrong.
    if (!clearedByStall) {
      writeStatusline(new Map([[agent.id, _epOffline ? 'offline' : 'idle']]));
      inFlightAgents.delete(agent.id);
    }
    stallDetector.remove(agent.id);
    await deletePromptFile(agent, strategy, promptFilePath);
  }
}
