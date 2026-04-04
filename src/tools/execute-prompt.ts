import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { getProvider } from '../providers/index.js';
import { getAgentOS, touchAgent } from '../utils/agent-helpers.js';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { isRetryable, authErrorAdvice } from '../utils/prompt-errors.js';
import { buildAuthEnvPrefix } from '../utils/auth-env.js';
import { writeStatusline } from '../services/statusline.js';
import { ensureCloudReady } from '../services/cloud/lifecycle.js';
import { escapeWindowsArg, escapeDoubleQuoted } from '../os/os-commands.js';
import type { Agent, SSHExecResult } from '../types.js';
import type { AgentStrategy } from '../services/strategy.js';
import type { ProviderAdapter } from '../providers/index.js';

export const executePromptSchema = z.object({
  ...memberIdentifier,
  prompt: z.string().describe('The prompt to send to the LLM on the remote member'),
  resume: z.boolean().default(true).describe('Resume the previous session if one exists (default: true)'),
  timeout_ms: z.number().default(300000).describe('Timeout in milliseconds (default: 5 minutes)'),
  max_turns: z.number().min(1).max(500).optional().describe('Max turns for claude -p (default: 50)'),
  dangerously_skip_permissions: z.boolean().default(false).describe('Run with --dangerously-skip-permissions so the member can execute tools without interactive approval. Only enable for unattended/trusted workloads.'),
  model: z.string().optional().describe('Model tier ("cheap", "standard", "premium") or a specific model ID for power users. Prefer tier names — the server resolves them to the correct model per provider. If omitted, defaults to the standard tier. Applies to both new and resumed sessions.'),
});

export type ExecutePromptInput = z.infer<typeof executePromptSchema>;

function buildFailureMessage(agentName: string, result: SSHExecResult, provider: ProviderAdapter): string {
  const output = result.stderr || result.stdout;
  const category = provider.classifyError(output);
  return category === 'auth'
    ? authErrorAdvice(agentName)
    : `❌ Prompt failed on "${agentName}":\n${output}`;
}

const SERVER_RETRY_DELAY_MS = 5000;
const PROMPT_FILE = '.fleet-task.md';

async function writePromptFile(agent: Agent, strategy: AgentStrategy, content: string): Promise<void> {
  if (agent.agentType === 'local') {
    fs.writeFileSync(path.join(agent.workFolder, PROMPT_FILE), content, 'utf-8');
    return;
  }
  const agentOs = getAgentOS(agent);
  if (agentOs === 'windows') {
    const escapedFolder = escapeWindowsArg(agent.workFolder);
    const psScript = `Set-Location "${escapedFolder}"; Set-Content -Path "${PROMPT_FILE}" -Value '${content.replace(/'/g, "''")}' -NoNewline -Encoding UTF8`;
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    await strategy.execCommand(`powershell -EncodedCommand ${encoded}`);
  } else {
    const b64 = Buffer.from(content).toString('base64');
    const escapedFolder = escapeDoubleQuoted(agent.workFolder);
    await strategy.execCommand(`cd "${escapedFolder}" && echo '${b64}' | base64 -d > ${PROMPT_FILE}`);
  }
}

async function deletePromptFile(agent: Agent, strategy: AgentStrategy): Promise<void> {
  if (agent.agentType === 'local') {
    try { fs.unlinkSync(path.join(agent.workFolder, PROMPT_FILE)); } catch { /* ignore */ }
    return;
  }
  const agentOs = getAgentOS(agent);
  if (agentOs === 'windows') {
    const escapedFolder = escapeWindowsArg(agent.workFolder);
    const psScript = `Set-Location "${escapedFolder}"; Remove-Item "${PROMPT_FILE}" -Force -ErrorAction SilentlyContinue`;
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    await strategy.execCommand(`powershell -EncodedCommand ${encoded}`).catch(() => { /* ignore */ });
  } else {
    const escapedFolder = escapeDoubleQuoted(agent.workFolder);
    await strategy.execCommand(`cd "${escapedFolder}" && rm -f ${PROMPT_FILE}`).catch(() => { /* ignore */ });
  }
}

export async function executePrompt(input: ExecutePromptInput): Promise<string> {
  const agentOrError = resolveMember(input.member_id, input.member_name);
  if (typeof agentOrError === 'string') return agentOrError;
  let agent: Agent;
  try {
    agent = await ensureCloudReady(agentOrError as Agent); // auto-start if stopped
  } catch (err: any) {
    return `❌ Failed to execute prompt on "${(agentOrError as Agent).friendlyName}": ${err.message}`;
  }

  const strategy = getStrategy(agent);
  const cmds = getOsCommands(getAgentOS(agent));
  const provider = getProvider(agent.llmProvider);

  const authPrefix = buildAuthEnvPrefix(agent, getAgentOS(agent));

  const tiers = provider.modelTiers();
  const resolvedModel = input.model
    ? (tiers[input.model as keyof typeof tiers] ?? input.model)
    : tiers.standard;

  const promptOpts = {
    folder: agent.workFolder,
    promptFile: PROMPT_FILE,
    dangerouslySkipPermissions: input.dangerously_skip_permissions,
    model: resolvedModel,
    maxTurns: input.max_turns,
  };

  const claudeCmd = authPrefix + cmds.buildAgentPromptCommand(provider, {
    ...promptOpts,
    sessionId: input.resume && agent.sessionId ? agent.sessionId : undefined,
  });

  const timeoutMs = input.timeout_ms ?? 300000;

  // Write the prompt to .fleet-task.md before execution
  await writePromptFile(agent, strategy, input.prompt);

  // Mark agent as busy in statusline
  writeStatusline(new Map([[agent.id, 'busy']]));

  try {
    let result = await strategy.execCommand(claudeCmd, timeoutMs);
    let parsed = provider.parseResponse(result);

    // Stale session retry — immediate, without session ID
    if (result.code !== 0 && input.resume && agent.sessionId) {
      const retryCmd = authPrefix + cmds.buildAgentPromptCommand(provider, promptOpts);
      result = await strategy.execCommand(retryCmd, timeoutMs);
      parsed = provider.parseResponse(result);
    }

    // Server/overloaded error retry — single attempt after delay
    if (result.code !== 0 && isRetryable(provider.classifyError(result.stderr || result.stdout))) {
      await new Promise(r => setTimeout(r, SERVER_RETRY_DELAY_MS));
      const retryCmd = authPrefix + cmds.buildAgentPromptCommand(provider, promptOpts);
      result = await strategy.execCommand(retryCmd, timeoutMs);
      parsed = provider.parseResponse(result);
    }

    if (result.code !== 0) {
      return buildFailureMessage(agent.friendlyName, result, provider);
    }

    // Update session ID and last used
    touchAgent(agent.id, parsed.sessionId); // T7: idle manager resets its timer via touchAgent

    writeStatusline();

    let output = `📋 Response from ${agent.friendlyName}:\n\n${parsed.result}`;
    if (parsed.usage) output += `\nTokens: input=${parsed.usage.input_tokens} output=${parsed.usage.output_tokens}`;
    if (parsed.sessionId) output += `\n\n---\nsession: ${parsed.sessionId}`;
    return output;
  } catch (err: any) {
    writeStatusline(new Map([[agent.id, 'offline']]));
    return `❌ Failed to execute prompt on "${agent.friendlyName}": ${err.message}`;
  } finally {
    await deletePromptFile(agent, strategy);
  }
}
