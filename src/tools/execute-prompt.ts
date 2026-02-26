import { z } from 'zod';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { getAgentOrFail, getAgentOS, touchAgent } from '../utils/agent-helpers.js';
import type { Agent } from '../types.js';

export const executePromptSchema = z.object({
  agent_id: z.string().describe('The UUID of the target agent'),
  prompt: z.string().describe('The prompt to send to Claude on the remote agent'),
  resume: z.boolean().default(true).describe('Resume the previous session if one exists (default: true)'),
  timeout_ms: z.number().default(300000).describe('Timeout in milliseconds (default: 5 minutes)'),
});

export type ExecutePromptInput = z.infer<typeof executePromptSchema>;

export async function executePrompt(input: ExecutePromptInput): Promise<string> {
  const agentOrError = getAgentOrFail(input.agent_id);
  if (typeof agentOrError === 'string') return agentOrError;
  const agent = agentOrError as Agent;

  const strategy = getStrategy(agent);
  const cmds = getOsCommands(getAgentOS(agent));

  // Base64-encode the prompt to avoid shell escaping issues
  const b64Prompt = Buffer.from(input.prompt).toString('base64');

  const claudeCmd = cmds.buildPromptCommand(
    agent.remoteFolder,
    b64Prompt,
    input.resume && agent.sessionId ? agent.sessionId : undefined,
  );

  const timeoutMs = input.timeout_ms ?? 300000;

  try {
    const result = await strategy.execCommand(claudeCmd, timeoutMs);

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
      const retryCmd = cmds.buildPromptCommand(agent.remoteFolder, b64Prompt);
      const retryResult = await strategy.execCommand(retryCmd, timeoutMs);
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
