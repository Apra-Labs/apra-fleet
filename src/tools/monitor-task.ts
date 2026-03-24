import { z } from 'zod';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { getAgentOrFail, getAgentOS } from '../utils/agent-helpers.js';
import { ensureCloudReady } from '../services/cloud/lifecycle.js';
import { awsProvider } from '../services/cloud/aws.js';
import { parseGpuUtilization } from '../utils/gpu-parser.js';
import type { Agent } from '../types.js';

export const monitorTaskSchema = z.object({
  member_id: z.string().describe('UUID of the fleet member running the task'),
  // Regex prevents path traversal (../etc/passwd) and shell injection (; rm -rf /)
  // Auto-generated IDs ('task-' + Date.now().toString(36)) always match this pattern
  task_id: z.string().regex(/^task-[a-z0-9]{4,20}$/, 'task_id must match pattern task-[a-z0-9]{4,20}').describe('Task ID returned by execute_command with long_running=true'),
  auto_stop: z.boolean().optional().default(false).describe('Stop cloud instance when task completes'),
});

export type MonitorTaskInput = z.infer<typeof monitorTaskSchema>;

export async function monitorTask(input: MonitorTaskInput): Promise<string> {
  const agentOrError = getAgentOrFail(input.member_id);
  if (typeof agentOrError === 'string') return agentOrError;

  let agent: Agent;
  try {
    agent = await ensureCloudReady(agentOrError as Agent);
  } catch (err: any) {
    return `Cannot connect to "${(agentOrError as Agent).friendlyName}": ${err.message}`;
  }

  const strategy = getStrategy(agent);
  const cmds = getOsCommands(getAgentOS(agent));
  const taskDir = `~/.fleet-tasks/${input.task_id}`;

  // Run in parallel: status.json, PID liveness check, GPU util (cloud only), log tail
  const [statusResult, pidResult, gpuResult, logResult] = await Promise.allSettled([
    strategy.execCommand(`cat ${taskDir}/status.json 2>/dev/null || echo '{}'`, 10000),
    strategy.execCommand(
      `cat ${taskDir}/task.pid 2>/dev/null | xargs -r kill -0 2>/dev/null && echo alive || echo dead`,
      10000,
    ),
    agent.cloud
      ? strategy.execCommand(cmds.gpuUtilization(), 10000)
      : Promise.resolve({ stdout: '', stderr: '', code: 0 }),
    strategy.execCommand(`tail -20 ${taskDir}/task.log 2>/dev/null || echo ''`, 10000),
  ]);

  // Parse status.json
  let statusData: Record<string, unknown> = {};
  if (statusResult.status === 'fulfilled') {
    try {
      statusData = JSON.parse(statusResult.value.stdout.trim() || '{}');
    } catch {
      statusData = {};
    }
  }

  const pidAlive = pidResult.status === 'fulfilled'
    ? pidResult.value.stdout.trim() === 'alive'
    : false;

  let gpuUtilization: number | undefined;
  if (agent.cloud && gpuResult.status === 'fulfilled') {
    gpuUtilization = parseGpuUtilization(gpuResult.value.stdout);
  }

  const logTail = logResult.status === 'fulfilled'
    ? logResult.value.stdout.trim()
    : '';

  const taskStatus = String(statusData.status ?? 'unknown');
  const isCompleted = taskStatus === 'completed' || taskStatus === 'failed';

  // auto_stop: stop cloud instance if task is done
  let autoStopped = false;
  if (input.auto_stop && isCompleted && agent.cloud) {
    try {
      await awsProvider.stopInstance(agent.cloud);
      autoStopped = true;
    } catch {
      // best-effort — don't fail monitor if stop fails
    }
  }

  const result: Record<string, unknown> = {
    taskId: input.task_id,
    status: taskStatus,
    exitCode: statusData.exitCode ?? null,
    retries: statusData.retries ?? 0,
    started: statusData.started ?? null,
    updated: statusData.updated ?? null,
    pidAlive,
    ...(gpuUtilization !== undefined ? { gpuUtilization } : {}),
    logTail: logTail || null,
    ...(autoStopped ? { autoStopped: true } : {}),
  };

  return JSON.stringify(result, null, 2);
}
