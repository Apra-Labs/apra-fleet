import path from 'node:path';
import { z } from 'zod';
import { getStrategy } from '../services/strategy.js';
import { touchAgent } from '../utils/agent-helpers.js';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { writeStatusline } from '../services/statusline.js';
import { ensureCloudReady } from '../services/cloud/lifecycle.js';
import { isContainedInWorkFolder } from '../utils/platform.js';
import { LogScope } from '../utils/log-helpers.js';
import type { Agent } from '../types.js';

export const receiveFilesSchema = z.object({
  ...memberIdentifier,
  remote_paths: z.array(z.string()).describe(
    'Paths on the member to download. Relative paths resolved from work_folder. ' +
    'Absolute paths must remain within work_folder — paths outside it are rejected. ' +
    'Always batch multiple files into a single call.'
  ),
  // No boundary restriction — caller controls their own local filesystem
  local_dest_dir: z.string().describe(
    'Required. Local directory to write the downloaded files into.'
  ),
});

export type ReceiveFilesInput = z.infer<typeof receiveFilesSchema>;

export async function receiveFiles(input: ReceiveFilesInput): Promise<string> {
  const agentOrError = resolveMember(input.member_id, input.member_name);
  if (typeof agentOrError === 'string') return agentOrError;
  let agent: Agent;
  try {
    agent = await ensureCloudReady(agentOrError as Agent); // auto-start if stopped
  } catch (err: any) {
    return `Failed to download files from "${(agentOrError as Agent).friendlyName}": ${err.message}`;
  }

  // Path security: verify each remote_path stays within work_folder
  for (const remotePath of input.remote_paths) {
    if (remotePath.includes('\0')) {
      return `⛔ Invalid remote_path: null bytes are not allowed.`;
    }
    if (agent.agentType === 'local') {
      const resolved = path.resolve(agent.workFolder, remotePath);
      const workFolderNorm = path.resolve(agent.workFolder);
      if (resolved !== workFolderNorm && !resolved.startsWith(workFolderNorm + path.sep)) {
        return `remote_path "${remotePath}" resolves outside member work_folder — read blocked`;
      }
    } else {
      if (!isContainedInWorkFolder(agent.workFolder, remotePath)) {
        return `remote_path "${remotePath}" resolves outside member work_folder — read blocked`;
      }
    }
  }

  const strategy = getStrategy(agent);

  const pathSummary = input.remote_paths[0] ?? '';
  const scope = new LogScope('receive_files', `${input.remote_paths.length} file(s) ← ${agent.friendlyName}:${pathSummary}`, agent);

  writeStatusline(new Map([[agent.id, 'busy']]));

  try {
    const result = await strategy.receiveFiles(input.remote_paths, input.local_dest_dir);

    touchAgent(agent.id);

    let output = '';

    if (result.success.length > 0) {
      output += `✅ Successfully downloaded ${result.success.length} file(s) from ${agent.friendlyName}:\n`;
      for (const f of result.success) {
        output += `  - ${f}\n`;
      }
    }

    if (result.failed.length > 0) {
      output += `\n❌ Failed to download ${result.failed.length} file(s):\n`;
      for (const f of result.failed) {
        output += `  - ${f.path}: ${f.error}\n`;
      }
    }

    output += `\nLocal destination: ${input.local_dest_dir}`;

    if (result.failed.length > 0 && result.success.length > 0)
      scope.fail(`${result.success.length} ok, ${result.failed.length} failed`);
    else if (result.failed.length > 0)
      scope.abort(`all ${result.failed.length} file(s) failed`);
    else
      scope.ok(`${result.success.length} file(s)`);

    return output;
  } catch (err: any) {
    writeStatusline(new Map([[agent.id, 'offline']]));
    scope.abort(err.message);
    return `Failed to download files from "${agent.friendlyName}": ${err.message}`;
  }
}
