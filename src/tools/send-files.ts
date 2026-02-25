import { z } from 'zod';
import { getAgent, updateAgent } from '../services/registry.js';
import { uploadFiles } from '../services/file-transfer.js';

export const sendFilesSchema = z.object({
  agent_id: z.string().describe('The UUID of the target agent'),
  local_paths: z.array(z.string()).describe('Array of local file paths to upload'),
  remote_subfolder: z.string().optional().describe('Optional subfolder within the agent\'s remote folder'),
});

export type SendFilesInput = z.infer<typeof sendFilesSchema>;

export async function sendFiles(input: SendFilesInput): Promise<string> {
  const agent = getAgent(input.agent_id);
  if (!agent) {
    return `Agent "${input.agent_id}" not found.`;
  }

  try {
    const result = await uploadFiles(agent, input.local_paths, input.remote_subfolder);

    updateAgent(agent.id, { lastUsed: new Date().toISOString() });

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
      ? `${agent.remoteFolder}/${input.remote_subfolder}`
      : agent.remoteFolder;
    output += `\nRemote destination: ${remoteDest}`;

    return output;
  } catch (err: any) {
    return `Failed to upload files to "${agent.friendlyName}": ${err.message}`;
  }
}
