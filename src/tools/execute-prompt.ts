import { z } from 'zod';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { getAgentOrFail, getAgentOS, touchAgent } from '../utils/agent-helpers.js';
import { classifyPromptError, isRetryable, authErrorAdvice } from '../utils/prompt-errors.js';
import type { Agent, SSHExecResult } from '../types.js';

export const executePromptSchema = z.object({
  agent_id: z.string().describe('The UUID of the target agent'),
  prompt: z.string().describe('The prompt to send to Claude on the remote agent'),
  resume: z.boolean().default(true).describe('Resume the previous session if one exists (default: true)'),
  timeout_ms: z.number().default(300000).describe('Timeout in milliseconds (default: 5 minutes)'),
  dangerously_skip_permissions: z.boolean().default(false).describe('Run Claude with --dangerously-skip-permissions so it can execute tools without interactive approval. Only enable for unattended/trusted workloads.'),
});

export type ExecutePromptInput = z.infer<typeof executePromptSchema>;

function parseResponse(result: SSHExecResult): { text: string; sessionId?: string } {
  try {
    const json = JSON.parse(result.stdout);
    return { text: json.result ?? result.stdout, sessionId: json.session_id };
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
  const agentOrError = getAgentOrFail(input.agent_id);
  if (typeof agentOrError === 'string') return agentOrError;
  const agent = agentOrError as Agent;

  const strategy = getStrategy(agent);
  const cmds = getOsCommands(getAgentOS(agent));

  // Base64-encode the prompt to avoid shell escaping issues
  const b64Prompt = Buffer.from(input.prompt).toString('base64');

  const claudeCmd = cmds.buildPromptCommand(
    agent.workFolder,
    b64Prompt,
    input.resume && agent.sessionId ? agent.sessionId : undefined,
    input.dangerously_skip_permissions,
  );

  const timeoutMs = input.timeout_ms ?? 300000;

  try {
    let result = await strategy.execCommand(claudeCmd, timeoutMs);
    let parsed = parseResponse(result);

    // Stale session retry — immediate, without session ID
    if (result.code !== 0 && input.resume && agent.sessionId) {
      const retryCmd = cmds.buildPromptCommand(agent.workFolder, b64Prompt, undefined, input.dangerously_skip_permissions);
      result = await strategy.execCommand(retryCmd, timeoutMs);
      parsed = parseResponse(result);
    }

    // Server/overloaded error retry — single attempt after delay
    if (result.code !== 0 && isRetryable(classifyPromptError(result.stderr || result.stdout))) {
      await new Promise(r => setTimeout(r, SERVER_RETRY_DELAY_MS));
      const retryCmd = cmds.buildPromptCommand(agent.workFolder, b64Prompt, undefined, input.dangerously_skip_permissions);
      result = await strategy.execCommand(retryCmd, timeoutMs);
      parsed = parseResponse(result);
    }

    if (result.code !== 0) {
      return buildFailureMessage(agent.friendlyName, result);
    }

    // Update session ID and last used
    touchAgent(agent.id, parsed.sessionId);

    let output = `📋 Response from ${agent.friendlyName}:\n\n${parsed.text}`;
    if (parsed.sessionId) {
      output += `\n\n🔗 Session: ${parsed.sessionId}`;
    }
    return output;
  } catch (err: any) {
    return `❌ Failed to execute prompt on "${agent.friendlyName}": ${err.message}`;
  }
}
