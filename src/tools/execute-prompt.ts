import { z } from 'zod';
import { getStrategy } from '../services/strategy.js';
import { escapeDoubleQuoted, sanitizeSessionId } from '../utils/shell-escape.js';
import { getClaudeCommand } from '../utils/platform.js';
import type { RemoteOS } from '../utils/platform.js';
import { getAgentOrFail, getAgentOS, touchAgent } from '../utils/agent-helpers.js';
import type { Agent } from '../types.js';

export const executePromptSchema = z.object({
  agent_id: z.string().describe('The UUID of the target agent'),
  prompt: z.string().describe('The prompt to send to Claude on the remote agent'),
  resume: z.boolean().default(true).describe('Resume the previous session if one exists (default: true)'),
  timeout_ms: z.number().default(300000).describe('Timeout in milliseconds (default: 5 minutes)'),
});

export type ExecutePromptInput = z.infer<typeof executePromptSchema>;

/**
 * Build a Claude CLI command string with proper escaping.
 * Centralizes command construction to avoid duplication and injection.
 */
export function buildClaudeCommand(
  os: RemoteOS,
  folder: string,
  b64Prompt: string,
  sessionId?: string,
): string {
  const escapedFolder = escapeDoubleQuoted(folder);

  let cmd: string;
  if (os === 'windows') {
    const decodeCmd = `powershell -Command "[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64Prompt}'))"`;
    cmd = `cd "${escapedFolder}" && for /f "delims=" %i in ('${decodeCmd}') do ${getClaudeCommand(os, '-p "%i" --output-format json --max-turns 50')}`;
  } else {
    cmd = `cd "${escapedFolder}" && ${getClaudeCommand(os, `-p "$(echo '${b64Prompt}' | base64 -d)" --output-format json --max-turns 50`)}`;
  }

  if (sessionId) {
    const safeSessionId = sanitizeSessionId(sessionId);
    cmd += ` --resume "${safeSessionId}"`;
  }

  return cmd;
}

export async function executePrompt(input: ExecutePromptInput): Promise<string> {
  const agentOrError = getAgentOrFail(input.agent_id);
  if (typeof agentOrError === 'string') return agentOrError;
  const agent = agentOrError as Agent;

  const strategy = getStrategy(agent);
  const os = getAgentOS(agent);

  // Base64-encode the prompt to avoid shell escaping issues
  const b64Prompt = Buffer.from(input.prompt).toString('base64');

  // Build the Claude command with proper escaping
  const claudeCmd = buildClaudeCommand(
    os,
    agent.remoteFolder,
    b64Prompt,
    input.resume && agent.sessionId ? agent.sessionId : undefined,
  );

  try {
    const result = await strategy.execCommand(claudeCmd, input.timeout_ms);

    // Try to parse session_id from JSON output
    let responseText = result.stdout;
    let newSessionId: string | undefined;

    try {
      const jsonResponse = JSON.parse(result.stdout);
      newSessionId = jsonResponse.session_id;
      responseText = jsonResponse.result ?? result.stdout;
    } catch {
      // Output might not be valid JSON — that's fine, use raw stdout
    }

    // If resume failed (stale session), retry without it
    if (result.code !== 0 && input.resume && agent.sessionId) {
      const retryCmd = buildClaudeCommand(os, agent.remoteFolder, b64Prompt);
      const retryResult = await strategy.execCommand(retryCmd, input.timeout_ms);
      responseText = retryResult.stdout;

      try {
        const jsonResponse = JSON.parse(retryResult.stdout);
        newSessionId = jsonResponse.session_id;
        responseText = jsonResponse.result ?? retryResult.stdout;
      } catch {
        // Use raw stdout
      }

      if (retryResult.code !== 0) {
        return `❌ Claude prompt failed on "${agent.friendlyName}":\n${retryResult.stderr || retryResult.stdout}`;
      }
    } else if (result.code !== 0) {
      return `❌ Claude prompt failed on "${agent.friendlyName}":\n${result.stderr || result.stdout}`;
    }

    // Update session ID and last used
    touchAgent(agent.id, newSessionId);

    let output = `📋 Response from ${agent.friendlyName}:\n\n${responseText}`;
    if (newSessionId) {
      output += `\n\n🔗 Session: ${newSessionId}`;
    }
    return output;
  } catch (err: any) {
    return `❌ Failed to execute prompt on "${agent.friendlyName}": ${err.message}`;
  }
}
