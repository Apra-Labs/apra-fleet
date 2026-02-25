import { z } from 'zod';
import { getAgent, updateAgent } from '../services/registry.js';
import { getStrategy } from '../services/strategy.js';

export const executePromptSchema = z.object({
  agent_id: z.string().describe('The UUID of the target agent'),
  prompt: z.string().describe('The prompt to send to Claude on the remote agent'),
  resume: z.boolean().default(true).describe('Resume the previous session if one exists (default: true)'),
  timeout_ms: z.number().default(300000).describe('Timeout in milliseconds (default: 5 minutes)'),
});

export type ExecutePromptInput = z.infer<typeof executePromptSchema>;

export async function executePrompt(input: ExecutePromptInput): Promise<string> {
  const agent = getAgent(input.agent_id);
  if (!agent) {
    return `Agent "${input.agent_id}" not found.`;
  }

  const strategy = getStrategy(agent);

  // Base64-encode the prompt to avoid shell escaping issues
  const b64Prompt = Buffer.from(input.prompt).toString('base64');

  // Build the Claude command
  let claudeCmd: string;
  const os = agent.os ?? 'linux';

  if (os === 'windows') {
    // On Windows, use PowerShell to decode base64
    const decodeCmd = `powershell -Command "[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64Prompt}'))"`;
    claudeCmd = `cd "${agent.remoteFolder}" && for /f "delims=" %i in ('${decodeCmd}') do claude -p "%i" --output-format json --max-turns 50`;
  } else {
    // On Unix, use echo + base64 decode piped to xargs or subshell
    claudeCmd = `cd "${agent.remoteFolder}" && claude -p "$(echo '${b64Prompt}' | base64 -d)" --output-format json --max-turns 50`;
  }

  // Add resume flag if applicable
  if (input.resume && agent.sessionId) {
    claudeCmd += ` --resume "${agent.sessionId}"`;
  }

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
      // Remove resume flag and retry
      let retryCmd: string;
      if (os === 'windows') {
        const decodeCmd = `powershell -Command "[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64Prompt}'))"`;
        retryCmd = `cd "${agent.remoteFolder}" && for /f "delims=" %i in ('${decodeCmd}') do claude -p "%i" --output-format json --max-turns 50`;
      } else {
        retryCmd = `cd "${agent.remoteFolder}" && claude -p "$(echo '${b64Prompt}' | base64 -d)" --output-format json --max-turns 50`;
      }

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
    const updates: Record<string, unknown> = { lastUsed: new Date().toISOString() };
    if (newSessionId) {
      updates.sessionId = newSessionId;
    }
    updateAgent(agent.id, updates);

    let output = `📋 Response from ${agent.friendlyName}:\n\n${responseText}`;
    if (newSessionId) {
      output += `\n\n🔗 Session: ${newSessionId}`;
    }
    return output;
  } catch (err: any) {
    return `❌ Failed to execute prompt on "${agent.friendlyName}": ${err.message}`;
  }
}
