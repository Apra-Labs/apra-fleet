import { z } from 'zod';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { getAgentOrFail, getAgentOS, touchAgent } from '../utils/agent-helpers.js';
import { classifyPromptError, isRetryable, authErrorAdvice } from '../utils/prompt-errors.js';
import { writeStatusline } from '../services/statusline.js';
import { ensureCloudReady } from '../services/cloud/lifecycle.js';
import type { Agent, SSHExecResult } from '../types.js';

export const executePromptSchema = z.object({
  member_id: z.string().describe('The UUID of the target member (worker)'),
  prompt: z.string().describe('The prompt to send to Claude on the remote member'),
  resume: z.boolean().default(true).describe('Resume the previous session if one exists (default: true)'),
  timeout_ms: z.number().default(300000).describe('Timeout in milliseconds (default: 5 minutes)'),
  max_turns: z.number().min(1).max(500).optional().describe('Max turns for claude -p (default: 50)'),
  dangerously_skip_permissions: z.boolean().default(false).describe('Run Claude with --dangerously-skip-permissions so it can execute tools without interactive approval. Only enable for unattended/trusted workloads.'),
  model: z.string().optional().describe('Model to use (e.g. "opus", "sonnet", "haiku", or full model ID). Applies to both new and resumed sessions.'),
});

export type ExecutePromptInput = z.infer<typeof executePromptSchema>;

interface ParsedResponse {
  text: string;
  sessionId?: string;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
}

function parseResponse(result: SSHExecResult): ParsedResponse {
  try {
    const json = JSON.parse(result.stdout);
    return {
      text: json.result ?? result.stdout,
      sessionId: json.session_id,
      totalTokens: json.totalTokens,
      inputTokens: json.inputTokens,
      outputTokens: json.outputTokens,
    };
  } catch {
    return { text: result.stdout };
  }
}

function buildFailureMessage(agentName: string, result: SSHExecResult): string {
  const output = result.stderr || result.stdout;
  const category = classifyPromptError(output);
  return category === 'auth'
    ? authErrorAdvice(agentName)
    : `❌ Claude prompt failed on "${agentName}":\n${output}`;
}

const SERVER_RETRY_DELAY_MS = 5000;

export async function executePrompt(input: ExecutePromptInput): Promise<string> {
  const agentOrError = getAgentOrFail(input.member_id);
  if (typeof agentOrError === 'string') return agentOrError;
  let agent: Agent;
  try {
    agent = await ensureCloudReady(agentOrError as Agent); // auto-start if stopped
  } catch (err: any) {
    return `❌ Failed to execute prompt on "${(agentOrError as Agent).friendlyName}": ${err.message}`;
  }

  const strategy = getStrategy(agent);
  const cmds = getOsCommands(getAgentOS(agent));

  // Base64-encode the prompt to avoid shell escaping issues
  const b64Prompt = Buffer.from(input.prompt).toString('base64');

  const claudeCmd = cmds.buildPromptCommand(
    agent.workFolder,
    b64Prompt,
    input.resume && agent.sessionId ? agent.sessionId : undefined,
    input.dangerously_skip_permissions,
    input.model,
    input.max_turns,
  );

  const timeoutMs = input.timeout_ms ?? 300000;

  // Mark agent as busy in statusline
  writeStatusline(new Map([[agent.id, 'busy']]));

  try {
    let result = await strategy.execCommand(claudeCmd, timeoutMs);
    let parsed = parseResponse(result);

    // Stale session retry — immediate, without session ID
    if (result.code !== 0 && input.resume && agent.sessionId) {
      const retryCmd = cmds.buildPromptCommand(agent.workFolder, b64Prompt, undefined, input.dangerously_skip_permissions, input.model, input.max_turns);
      result = await strategy.execCommand(retryCmd, timeoutMs);
      parsed = parseResponse(result);
    }

    // Server/overloaded error retry — single attempt after delay
    if (result.code !== 0 && isRetryable(classifyPromptError(result.stderr || result.stdout))) {
      await new Promise(r => setTimeout(r, SERVER_RETRY_DELAY_MS));
      const retryCmd = cmds.buildPromptCommand(agent.workFolder, b64Prompt, undefined, input.dangerously_skip_permissions, input.model, input.max_turns);
      result = await strategy.execCommand(retryCmd, timeoutMs);
      parsed = parseResponse(result);
    }

    if (result.code !== 0) {
      return buildFailureMessage(agent.friendlyName, result);
    }

    // Update session ID and last used
    touchAgent(agent.id, parsed.sessionId); // T7: idle manager resets its timer via touchAgent

    writeStatusline();

    let output = `📋 Response from ${agent.friendlyName}:\n\n${parsed.text}`;
    const meta: string[] = [];
    if (parsed.sessionId) meta.push(`session: ${parsed.sessionId}`);
    if (parsed.totalTokens) meta.push(`tokens: ${parsed.inputTokens ?? '?'} in / ${parsed.outputTokens ?? '?'} out / ${parsed.totalTokens} total`);
    if (meta.length) output += `\n\n---\n${meta.join(' | ')}`;
    return output;
  } catch (err: any) {
    writeStatusline(new Map([[agent.id, 'offline']]));
    return `❌ Failed to execute prompt on "${agent.friendlyName}": ${err.message}`;
  }
}
