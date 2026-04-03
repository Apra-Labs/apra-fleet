import { z } from 'zod';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { executeCommand } from './execute-command.js';
import { sendFiles } from './send-files.js';
import { escapeShellArg } from '../utils/shell-escape.js';

export const updateTaskTokensSchema = z.object({
  member_id: z.string().describe('The UUID of the fleet member that owns the progress.json'),
  progress_json: z.string().describe('Absolute path to progress.json on the member (e.g. /home/user/project/progress.json)'),
  task_id: z.string().describe('The task ID to update (matches tasks[i].id in progress.json)'),
  role: z.enum(['doer', 'reviewer']).describe('Which role accumulated the tokens'),
  input_tokens: z.number().int().min(0).describe('Input tokens to add'),
  output_tokens: z.number().int().min(0).describe('Output tokens to add'),
});

export type UpdateTaskTokensInput = z.infer<typeof updateTaskTokensSchema>;

interface TokenCounts { input: number; output: number }
interface TaskTokens { doer: TokenCounts; reviewer: TokenCounts }

function initTokens(): TaskTokens {
  return { doer: { input: 0, output: 0 }, reviewer: { input: 0, output: 0 } };
}

export async function updateTaskTokens(input: UpdateTaskTokensInput): Promise<string> {
  // 1. Read current progress.json from the member
  const catResult = await executeCommand({
    member_id: input.member_id,
    command: `cat ${escapeShellArg(input.progress_json)}`,
    timeout_ms: 30000,
  });

  if (!catResult.startsWith('Exit code: 0')) {
    return `Failed to read progress.json from member: ${catResult}`;
  }

  const jsonText = catResult.replace(/^Exit code: 0\n/, '');

  let progress: any;
  try {
    progress = JSON.parse(jsonText);
  } catch (err: any) {
    return `Failed to parse progress.json: ${err.message}`;
  }

  // 2. Find the task and accumulate tokens
  if (!Array.isArray(progress.tasks)) {
    return `Invalid progress.json: missing tasks array`;
  }

  const task = progress.tasks.find((t: any) => String(t.id) === String(input.task_id));
  if (!task) {
    return `Task "${input.task_id}" not found in progress.json`;
  }

  if (!task.tokens || typeof task.tokens !== 'object') {
    task.tokens = initTokens();
  }
  if (!task.tokens[input.role] || typeof task.tokens[input.role] !== 'object') {
    task.tokens[input.role] = { input: 0, output: 0 };
  }

  task.tokens[input.role].input += input.input_tokens;
  task.tokens[input.role].output += input.output_tokens;

  // 3. Write updated JSON to a temp file named progress.json so send_files preserves the basename
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-tokens-'));
  const tmpFile = path.join(tmpDir, 'progress.json');
  fs.writeFileSync(tmpFile, JSON.stringify(progress, null, 2));

  // 4. Push updated progress.json back to the member
  const sendResult = await sendFiles({
    member_id: input.member_id,
    local_paths: [tmpFile],
    remote_subfolder: path.dirname(input.progress_json).replace(/^\//, '') || undefined,
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });

  if (!sendResult.includes('Successfully uploaded')) {
    return `Failed to upload updated progress.json: ${sendResult}`;
  }

  // 5. Commit the updated progress.json on the member
  const commitResult = await executeCommand({
    member_id: input.member_id,
    command: `git add ${escapeShellArg(input.progress_json)} && git commit -m "chore: update token counts for task ${escapeShellArg(input.task_id)}"`,
    timeout_ms: 30000,
  });

  const committed = commitResult.includes('Exit code: 0');

  return [
    `Token counts updated for task ${input.task_id} (role: ${input.role}):`,
    `  ${input.role}.input  += ${input.input_tokens} → ${task.tokens[input.role].input}`,
    `  ${input.role}.output += ${input.output_tokens} → ${task.tokens[input.role].output}`,
    committed ? 'Committed to git on member.' : `Git commit result: ${commitResult}`,
  ].join('\n');
}
