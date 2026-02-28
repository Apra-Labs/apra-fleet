import { z } from 'zod';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { getAgentOrFail, getAgentOS, touchAgent } from '../utils/agent-helpers.js';
import type { Agent } from '../types.js';

export const executeCommandSchema = z.object({
  agent_id: z.string().describe('The UUID of the target agent'),
  command: z.string().describe('The shell command to execute'),
  timeout_ms: z.number().default(120000).describe('Timeout in milliseconds (default: 2 minutes)'),
  work_folder: z.string().optional().describe("Directory to cd into before running the command. Defaults to the agent's registered work folder."),
});

export type ExecuteCommandInput = z.infer<typeof executeCommandSchema>;

export async function executeCommand(input: ExecuteCommandInput): Promise<string> {
  const agentOrError = getAgentOrFail(input.agent_id);
  if (typeof agentOrError === 'string') return agentOrError;
  const agent = agentOrError as Agent;

  const strategy = getStrategy(agent);
  const cmds = getOsCommands(getAgentOS(agent));

  const folder = input.work_folder ?? agent.workFolder;
  const wrapped = cmds.wrapInWorkFolder(folder, input.command);

  try {
    const result = await strategy.execCommand(wrapped, input.timeout_ms);
    touchAgent(agent.id);

    const parts: string[] = [];
    if (result.stdout) parts.push(result.stdout);
    if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);
    const output = parts.join('\n') || '(no output)';

    return result.code === 0
      ? `Exit code: 0\n${output}`
      : `Exit code: ${result.code}\n${output}`;
  } catch (err: any) {
    return `Failed to execute command on "${agent.friendlyName}": ${err.message}`;
  }
}
