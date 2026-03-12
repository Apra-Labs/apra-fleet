import { z } from 'zod';
import { getStrategy } from '../services/strategy.js';
import { getAgentOrFail, touchAgent } from '../utils/agent-helpers.js';
import { writeStatusline } from '../services/statusline.js';
import type { Agent } from '../types.js';

export const sendFilesSchema = z.object({
  member_id: z.string().describe('The UUID of the target member (worker)'),
  local_paths: z.array(z.string()).describe('Array of local file paths to upload'),
  remote_subfolder: z.string().optional().describe('Optional subfolder within the member\'s remote folder'),
});

export type SendFilesInput = z.infer<typeof sendFilesSchema>;

export async function sendFiles(input: SendFilesInput): Promise<string> {
  const agentOrError = getAgentOrFail(input.member_id);
  if (typeof agentOrError === 'string') return agentOrError;
  const agent = agentOrError as Agent;

  const strategy = getStrategy(agent);

  writeStatusline(new Map([[agent.id, 'busy']]));

  try {
    const result = await strategy.transferFiles(input.local_paths, input.remote_subfolder);

    touchAgent(agent.id);

    let output = '';

    if (result.success.length > 0) {
      output += `✅ Successfully uploaded ${result.success.length} file(s) to ${agent.friendlyName}:\n`;
      for (const f of result.success) {
        output += `  - ${f}\n`;
      }
    }

    if (result.failed.length > 0) {
      output += `\n❌ Failed to upload ${result.failed.length} file(s):\n`;
      for (const f of result.failed) {
        output += `  - ${f.path}: ${f.error}\n`;
      }
    }

    const remoteDest = input.remote_subfolder
      ? `${agent.workFolder}/${input.remote_subfolder}`
      : agent.workFolder;
    output += `\nRemote destination: ${remoteDest}`;

    return output;
  } catch (err: any) {
    writeStatusline(new Map([[agent.id, 'offline']]));
    return `Failed to upload files to "${agent.friendlyName}": ${err.message}`;
  }
}
