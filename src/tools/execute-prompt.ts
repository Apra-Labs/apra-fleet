import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
import { ensureCloudReady } from '../services/cloud/lifecycle.js';
import { getStallDetector, resolveSessionLogPath, resolveSessionLogDir } from '../services/stall/index.js';
import { escapeWindowsArg, escapeDoubleQuoted } from '../os/os-commands.js';
import { resolveTilde } from './execute-command.js';
import { clearStoredPid } from '../utils/agent-helpers.js';
import { tryKillPid } from '../utils/pid-helpers.js';
import { LogScope, maskSecrets, truncateForLog } from '../utils/log-helpers.js';
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

const SECURE_TOKEN_RE = /\{\{secure\.[a-zA-Z0-9_]{1,64}\}\}/;

export const inFlightAgents = new Set<string>();

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
  const stallDetector = getStallDetector();
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
  });

  const tmpDir = agent.agentType === 'local' ? os.tmpdir() : '/tmp';
  const resolvedWorkFolder = resolveTilde(agent.workFolder);
  const promptFilePath = agent.agentType === 'local'
    ? path.join(resolvedWorkFolder, promptFileName)
    : `${resolvedWorkFolder}/${promptFileName}`;

  const strategy = getStrategy(agent);
  const cmds = getOsCommands(getAgentOS(agent));
  const provider = getProvider(agent.llmProvider);

  const authPrefix = buildAuthEnvPrefix(agent, getAgentOS(agent));

  const tiers = provider.modelTiers();
  const resolvedModel = input.model
    ? (tiers[input.model as keyof typeof tiers] ?? input.model)
    : tiers.standard;

  const deprecationWarning = input.dangerously_skip_permissions
    ? '⚠️ DEPRECATION: dangerously_skip_permissions is deprecated and ignored. Use update_member(unattended="dangerous") instead.\n\n'
    : '';

  const promptOpts = {
    folder: resolvedWorkFolder,
    promptFile: promptFileName,
    unattended: agent.unattended,
    model: resolvedModel,
    maxTurns: input.max_turns,
  };

  const claudeCmd = authPrefix + cmds.buildAgentPromptCommand(provider, {
    ...promptOpts,
    sessionId: input.resume && agent.sessionId ? agent.sessionId : undefined,
  });

  const timeoutMs = (input.timeout_s ?? 300) * 1000;
  const maxTotalMs = input.max_total_s !== undefined ? input.max_total_s * 1000 : undefined;

  // Kill any leftover session from a previous (possibly zombie) execute_prompt call
  await tryKillPid(agent, strategy, cmds);

  // Write the prompt to the unique prompt file before execution
  await writePromptFile(agent, strategy, promptFilePath, input.prompt);

  const scope = new LogScope('execute_prompt', `[${resolvedModel}] resume=${input.resume} timeout=${input.timeout_s ?? 300}s ${truncateForLog(maskSecrets(input.prompt))}`, agent);
  
  const onPidCaptured = (pid: number) => {
    scope.info(`pid=${pid}`);
    const logDir = resolveSessionLogDir(agent.llmProvider ?? 'claude', agent.workFolder);
    if (logDir) {
      try {
        const watcher = fs.watch(logDir, { persistent: false }, (event: string, filename: string | null) => {
          if (filename?.endsWith('.jsonl')) {
            const logPath = path.join(logDir, filename);
            const sessionId = filename.replace('.jsonl', '');
            stallDetector.update(agent.id, {
              sessionId,
              logFilePath: logPath,
              provisional: false,
            });
            scope.info(`stall log resolved via dir-watch: sessionId=${sessionId}`);
            watcher.close();
          }
        });
      } catch {
        // log dir may not exist yet — provisional entry stays until session ends
      }
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
    let result = await strategy.execCommand(claudeCmd, timeoutMs, maxTotalMs, onPidCaptured);
    let parsed = provider.parseResponse(result);
    if (parsed.usage) _epUsage = parsed.usage;

    // Stale session retry — immediate, without session ID
    if (result.code !== 0 && input.resume && agent.sessionId) {
      scope.info(`[${resolvedModel}] retrying — stale session`);
      await tryKillPid(agent, strategy, cmds);
      const retryCmd = authPrefix + cmds.buildAgentPromptCommand(provider, promptOpts);
      result = await strategy.execCommand(retryCmd, timeoutMs, maxTotalMs, onPidCaptured);
      parsed = provider.parseResponse(result);
      if (parsed.usage) _epUsage = parsed.usage;
    }

    // Server/overloaded error retry — single attempt after delay
    if (result.code !== 0 && isRetryable(provider.classifyError(result.stderr || result.stdout))) {
      scope.info(`[${resolvedModel}] retrying — server overloaded`);
      await tryKillPid(agent, strategy, cmds);
      await new Promise(r => setTimeout(r, SERVER_RETRY_DELAY_MS));
      const retryCmd = authPrefix + cmds.buildAgentPromptCommand(provider, promptOpts);
      result = await strategy.execCommand(retryCmd, timeoutMs, maxTotalMs, onPidCaptured);
      parsed = provider.parseResponse(result);
      if (parsed.usage) _epUsage = parsed.usage;
    }

    _epExitCode = result.code;
    if (result.code !== 0) {
      return buildFailureMessage(agent.friendlyName, result, provider);
    }

    // Update session ID and last used
    touchAgent(agent.id, parsed.sessionId);
    if (parsed.sessionId) {
      stallDetector.update(agent.id, {
        sessionId: parsed.sessionId,
        logFilePath: resolveSessionLogPath(agent.llmProvider ?? 'claude', parsed.sessionId, agent.workFolder),
        provisional: false,
      });
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
    // Explicitly set idle (or offline for connection failures) — never rely on persisted busy state clearing itself
    writeStatusline(new Map([[agent.id, _epOffline ? 'offline' : 'idle']]));
    inFlightAgents.delete(agent.id);
    stallDetector.remove(agent.id);
    await deletePromptFile(agent, strategy, promptFilePath);
  }
}
