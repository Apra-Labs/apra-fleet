import { z } from 'zod';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { getAgentOrFail, getAgentOS, touchAgent } from '../utils/agent-helpers.js';
import { buildAuthEnvPrefix } from '../utils/auth-env.js';
import { writeStatusline } from '../services/statusline.js';
import { ensureCloudReady } from '../services/cloud/lifecycle.js';
import { generateTaskWrapper } from '../services/cloud/task-wrapper.js';
import type { Agent } from '../types.js';

export const executeCommandSchema = z.object({
  member_id: z.string().describe('The UUID of the target member (worker)'),
  command: z.string().describe('The shell command to execute'),
  timeout_ms: z.number().default(120000).describe('Timeout in milliseconds (default: 2 minutes)'),
  work_folder: z.string().optional().describe("Directory to cd into before running the command. Defaults to the member's registered work folder."),
  long_running: z.boolean().optional().default(false).describe('Run as background task; returns task_id for use with monitor_task'),
  max_retries: z.number().int().min(0).max(10).optional().default(3).describe('Max crash retries (long_running only)'),
  restart_command: z.string().optional().describe('Command for retry runs, e.g. checkpoint resume (long_running only)'),
});

export type ExecuteCommandInput = z.infer<typeof executeCommandSchema>;

export async function executeCommand(input: ExecuteCommandInput): Promise<string> {
  const agentOrError = getAgentOrFail(input.member_id);
  if (typeof agentOrError === 'string') return agentOrError;
  let agent: Agent;
  try {
    agent = await ensureCloudReady(agentOrError as Agent); // auto-start if stopped
  } catch (err: any) {
    return `Failed to execute command on "${(agentOrError as Agent).friendlyName}": ${err.message}`;
  }

  const strategy = getStrategy(agent);
  const cmds = getOsCommands(getAgentOS(agent));

  const folder = input.work_folder ?? agent.workFolder;

  // -- Long-running background task path --
  if (input.long_running) {
    const agentOs = getAgentOS(agent);
    const longRunningOsWarning = agentOs !== 'linux'
      ? `Note: Long-running tasks use a bash wrapper script designed for Linux. The member's OS is ${agentOs}, which may not support this feature.\n`
      : '';

    const taskId = 'task-' + Date.now().toString(36);
    const wrapperScript = generateTaskWrapper({
      taskId,
      command: input.command,
      restartCommand: input.restart_command,
      maxRetries: input.max_retries ?? 3,
      activityIntervalSec: 300,
    });
    const scriptB64 = Buffer.from(wrapperScript).toString('base64');

    // Create task dir, decode + write wrapper script, chmod, launch with nohup
    const launchCmd = cmds.wrapInWorkFolder(
      folder,
      `mkdir -p ~/.fleet-tasks/${taskId} && ` +
      `printf '%s' '${scriptB64}' | base64 -d > ~/.fleet-tasks/${taskId}/run.sh && ` +
      `chmod +x ~/.fleet-tasks/${taskId}/run.sh && ` +
      `nohup bash ~/.fleet-tasks/${taskId}/run.sh > /dev/null 2>&1 & echo $!`,
    );

    writeStatusline(new Map([[agent.id, 'busy']]));
    try {
      await strategy.execCommand(launchCmd, input.timeout_ms);
      touchAgent(agent.id);
      writeStatusline();
      return `${longRunningOsWarning}Task launched: task_id=${taskId}\nUse monitor_task to track progress.`;
    } catch (err: any) {
      writeStatusline(new Map([[agent.id, 'offline']]));
      return `Failed to launch task on "${agent.friendlyName}": ${err.message}`;
    }
  }

  // -- Regular (synchronous) command path --
  const authPrefix = buildAuthEnvPrefix(agent, getAgentOS(agent));
  const wrapped = authPrefix + cmds.wrapInWorkFolder(folder, input.command);

  // Mark agent as busy in statusline
  writeStatusline(new Map([[agent.id, 'busy']]));

  try {
    const result = await strategy.execCommand(wrapped, input.timeout_ms);
    touchAgent(agent.id); // T7: idle manager resets its timer via touchAgent

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
