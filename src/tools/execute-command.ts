import { z } from 'zod';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { getAgentOrFail, getAgentOS, touchAgent } from '../utils/agent-helpers.js';
import { writeStatusline } from '../services/statusline.js';
import type { Agent } from '../types.js';

export const executeCommandSchema = z.object({
  member_id: z.string().describe('The UUID of the target member (worker)'),
  command: z.string().describe('The shell command to execute'),
  timeout_ms: z.number().default(120000).describe('Timeout in milliseconds (default: 2 minutes)'),
  work_folder: z.string().optional().describe("Directory to cd into before running the command. Defaults to the member's registered work folder."),
});

export type ExecuteCommandInput = z.infer<typeof executeCommandSchema>;

export async function executeCommand(input: ExecuteCommandInput): Promise<string> {
  const agentOrError = getAgentOrFail(input.member_id);
  if (typeof agentOrError === 'string') return agentOrError;
  const agent = agentOrError as Agent;

  const strategy = getStrategy(agent);
  const cmds = getOsCommands(getAgentOS(agent));

  const folder = input.work_folder ?? agent.workFolder;
  const wrapped = cmds.wrapInWorkFolder(folder, input.command);

  // Mark agent as busy in statusline
  writeStatusline(new Map([[agent.id, 'busy']]));

  try {
    const result = await strategy.execCommand(wrapped, input.timeout_ms);
    touchAgent(agent.id);

    const parts: string[] = [];
    if (result.stdout) parts.push(result.stdout);
    if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);
    const output = parts.join('\n') || '(no output)';

    writeStatusline();

    return result.code === 0
      ? `Exit code: 0\n${output}`
      : `Exit code: ${result.code}\n${output}`;
  } catch (err: any) {
    writeStatusline(new Map([[agent.id, 'offline']]));
    return `Failed to execute command on "${agent.friendlyName}": ${err.message}`;
  }
}
