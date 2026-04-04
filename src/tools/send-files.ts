import path from 'node:path';
import { z } from 'zod';
import { getStrategy } from '../services/strategy.js';
import { touchAgent } from '../utils/agent-helpers.js';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { writeStatusline } from '../services/statusline.js';
import { ensureCloudReady } from '../services/cloud/lifecycle.js';
import type { Agent } from '../types.js';

export const sendFilesSchema = z.object({
  ...memberIdentifier,
  local_paths: z.array(z.string()).describe('Array of local file paths to upload'),
  destination_path: z.string().optional().describe(
    'Destination path on the member. Relative paths are resolved from work_folder. ' +
    'Absolute paths must remain within work_folder — paths outside it are rejected.'
  ),
});

export type SendFilesInput = z.infer<typeof sendFilesSchema>;

export async function sendFiles(input: SendFilesInput): Promise<string> {
  const agentOrError = resolveMember(input.member_id, input.member_name);
  if (typeof agentOrError === 'string') return agentOrError;
  let agent: Agent;
  try {
    agent = await ensureCloudReady(agentOrError as Agent); // auto-start if stopped
  } catch (err: any) {
    return `Failed to upload files to "${(agentOrError as Agent).friendlyName}": ${err.message}`;
  }

  // Path security: verify destination_path stays within work_folder
  let resolvedPath: string | undefined;
  if (input.destination_path) {
    if (agent.agentType === 'local') {
      const resolved = path.resolve(agent.workFolder, input.destination_path);
      const workFolderNorm = path.resolve(agent.workFolder);
      if (resolved !== workFolderNorm && !resolved.startsWith(workFolderNorm + path.sep)) {
        return 'destination_path resolves outside member work_folder — write blocked';
      }
      resolvedPath = resolved;
    } else {
      const workFolderPosix = agent.workFolder.replace(/\\/g, '/');
      const normalizedWorkFolder = workFolderPosix.replace(/\/$/, '');
      const resolved = path.posix.resolve(workFolderPosix, input.destination_path.replace(/\\/g, '/'));
      if (resolved !== normalizedWorkFolder && !resolved.startsWith(normalizedWorkFolder + '/')) {
        return 'destination_path resolves outside member work_folder — write blocked';
      }
      resolvedPath = resolved;
    }
  }

  const strategy = getStrategy(agent);

  writeStatusline(new Map([[agent.id, 'busy']]));

  try {
    const result = await strategy.transferFiles(input.local_paths, input.destination_path);

    touchAgent(agent.id); // T7: idle manager resets its timer via touchAgent

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

    const dest = resolvedPath ?? agent.workFolder;
    output += `\nDestination: ${dest}`;

    return output;
  } catch (err: any) {
    writeStatusline(new Map([[agent.id, 'offline']]));
    return `Failed to upload files to "${agent.friendlyName}": ${err.message}`;
  }
}
