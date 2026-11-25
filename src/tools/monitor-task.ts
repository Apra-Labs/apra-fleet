import { z } from 'zod';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { wrapPowerShellEncoded } from '../os/windows.js';
import { getAgentOS, getAgentShell } from '../utils/agent-helpers.js';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { ensureCloudReady } from '../services/cloud/lifecycle.js';
import { awsProvider } from '../services/cloud/aws.js';
import { getTaskCredentials, getTaskSecretChanges, type TaskSecretChange } from '../services/credential-store.js';
import { parseGpuUtilization } from '../utils/gpu-parser.js';
import type { Agent } from '../types.js';

export const monitorTaskSchema = z.object({
  ...memberIdentifier,
  // Regex prevents path traversal (../etc/passwd) and shell injection (; rm -rf /)
  // Auto-generated IDs ('task-' + Date.now().toString(36)) always match this pattern
  task_id: z.string().regex(/^task-[a-z0-9]{4,20}$/, 'task_id must match pattern task-[a-z0-9]{4,20}').describe('Task ID returned by execute_command with long_running=true'),
  auto_stop: z.boolean().optional().default(false).describe('Stop cloud instance when task completes'),
});

export type MonitorTaskInput = z.infer<typeof monitorTaskSchema>;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The member-side step that stops a long_running task, correct for the
 * member's OS. task.pid records the task WRAPPER itself (bash `$$` of run.sh
 * on POSIX, `$PID` of run.ps1 on Windows -- see generateTaskWrapper /
 * generateTaskWrapperWindows), and the wrapper runs the command as its
 * child inside a crash-retry loop. Killing only the child would hand control
 * back to that loop, which relaunches with the OLD baked-in secret value.
 * So: snapshot the wrapper's direct children, kill the wrapper (ends the
 * retry loop), then kill the snapshotted child trees, which would otherwise
 * be orphaned. taskkill /T is not used: it does not guarantee that order.
 */
export function stopTaskStep(taskId: string, isWindows: boolean): { command: string; description: string } {
  if (isWindows) {
    const pidFile = `$env:USERPROFILE\\.fleet-tasks\\${taskId}\\task.pid`;
    const script = [
      'function Stop-FleetTree($i) { Get-CimInstance Win32_Process -Filter "ParentProcessId=$i" | ForEach-Object { Stop-FleetTree $_.ProcessId }; Stop-Process -Id $i -Force -ErrorAction SilentlyContinue }',
      `if (-not (Test-Path "${pidFile}")) { echo 'no task.pid: the task is not running'; exit 0 }`,
      `$p = [int](Get-Content "${pidFile}" -Raw).Trim()`,
      '$kids = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$p")',
      'Stop-Process -Id $p -Force -ErrorAction SilentlyContinue',
      'foreach ($k in $kids) { Stop-FleetTree $k.ProcessId }',
      'echo stopped',
    ].join('; ');
    return {
      command: wrapPowerShellEncoded(script),
      description: `Stop-Process on the PID in %USERPROFILE%\\.fleet-tasks\\${taskId}\\task.pid (the task wrapper, which ends its retry loop), then on that wrapper's child process trees`,
    };
  }
  const pidFile = `~/.fleet-tasks/${taskId}/task.pid`;
  return {
    command:
      `p=$(cat ${pidFile} 2>/dev/null); if [ -n "$p" ]; then ` +
      `kids=$(pgrep -P "$p" 2>/dev/null); kill -9 "$p" 2>/dev/null; ` +
      `_fleet_kill_tree() { for c in $(pgrep -P "$1" 2>/dev/null); do _fleet_kill_tree "$c"; done; kill -9 "$1" 2>/dev/null; }; ` +
      `for k in $kids; do _fleet_kill_tree "$k"; done; echo stopped; ` +
      `else echo 'no task.pid: the task is not running'; fi`,
    description: `kill of the PID in ${pidFile} (the task wrapper, which ends its retry loop), then of that wrapper's child process trees`,
  };
}

/**
 * The loud warning monitor_task adds when a secret bound to the task changed
 * after launch. Names only the secrets and the kind of change -- never a
 * value or a fingerprint.
 */
export function secretChangeWarning(taskId: string, changes: TaskSecretChange[], isWindows: boolean): string {
  const list = changes.map(c => `${c.name} (${c.change})`).join(', ');
  const step = stopTaskStep(taskId, isWindows);
  const reset = changes.some(c => c.change !== 'rotated')
    ? ' A deleted or expired secret must be set again with credential_store_set before relaunching, or the relaunch cannot resolve its placeholder.'
    : '';
  return `WARNING: secret(s) ${list} changed after task ${taskId} launched. ` +
    'A long_running task resolves each {{secret.NAME}} once at launch, so this task still uses the OLD value and cannot pick up the new one ' +
    '(expect authentication failures). Restart it: ' +
    `1) stop it on the member with execute_command running: ${step.command} -- that is a ${step.description}; ` +
    '2) relaunch the command with execute_command long_running=true.' + reset;
}

export async function monitorTask(input: MonitorTaskInput): Promise<string> {
  const agentOrError = resolveMember(input.member_id, input.member_name);
  if (typeof agentOrError === 'string') return agentOrError;

  let agent: Agent;
  try {
    agent = await ensureCloudReady(agentOrError as Agent);
  } catch (err: any) {
    return `Cannot connect to "${(agentOrError as Agent).friendlyName}": ${err.message}`;
  }

  const strategy = getStrategy(agent);
  const cmds = getOsCommands(getAgentOS(agent), getAgentShell(agent));
  const isWindows = getAgentOS(agent) === 'windows';

  // POSIX (linux/darwin) task dir/commands are byte-identical to before this
  // change. Windows members now get a real task dir too: execute-command.ts's
  // long_running path writes generateTaskWrapperWindows()'s run.ps1 to this
  // same $env:USERPROFILE\.fleet-tasks\<taskId> path and launches it detached
  // via Invoke-CimMethod Win32_Process.Create, so these commands read the
  // same status.json/task.pid/task.log shape that script writes.
  //
  // Shell-agnostic by construction (apra-fleet-7dir.5.2 audit): statusCmd,
  // pidCmd and logCmd below branch on `isWindows` alone -- getAgentShell(agent)
  // is intentionally NOT consulted -- because each Windows branch is already
  // wrapped in wrapPowerShellEncoded, which base64-encodes the whole script
  // into a single `powershell -EncodedCommand <blob>` string. That string is
  // shell-agnostic AS A STRING: whatever shell actually runs it on the member
  // (cmd.exe, PowerShell, or bash.exe for a gitbash member) just execs the
  // literal powershell.exe binary with an opaque base64 argument -- nothing is
  // left for that outer shell to re-tokenize or corrupt, the same reasoning
  // execute-command.ts's long_running Windows launch documents for why it does
  // not branch on isPosixShell either. A gitbash member therefore gets the
  // exact same statusCmd/pidCmd/logCmd string as a powershell5/pwsh7/unset
  // Windows member; only true POSIX members (linux/darwin) get a different,
  // byte-identical-to-before string.
  const taskDir = `~/.fleet-tasks/${input.task_id}`;
  const winTaskDir = `$env:USERPROFILE\\.fleet-tasks\\${input.task_id}`;

  const statusCmd = isWindows
    ? wrapPowerShellEncoded(`if (Test-Path "${winTaskDir}\\status.json") { Get-Content "${winTaskDir}\\status.json" -Raw } else { echo '{}' }`)
    : `cat ${taskDir}/status.json 2>/dev/null || echo '{}'`;

  const pidCmd = isWindows
    ? wrapPowerShellEncoded(`$pidFile = "${winTaskDir}\\task.pid"; if (Test-Path $pidFile) { $p = (Get-Content $pidFile -Raw).Trim() } else { $p = $null }; if ($p -and (Get-Process -Id $p -ErrorAction SilentlyContinue)) { echo alive } else { echo dead }`)
    // Not `cat ... | xargs -r kill -0`: with no pid file xargs -r runs nothing
    // and exits 0, which reported a task that never started as alive.
    : `p=$(cat ${taskDir}/task.pid 2>/dev/null) && [ -n "$p" ] && kill -0 "$p" 2>/dev/null && echo alive || echo dead`;

  const logCmd = isWindows
    ? wrapPowerShellEncoded(`if (Test-Path "${winTaskDir}\\task.log") { Get-Content "${winTaskDir}\\task.log" -Tail 20 } else { echo '' }`)
    : `tail -20 ${taskDir}/task.log 2>/dev/null || echo ''`;

  // Run in parallel: status.json, PID liveness check, GPU util (cloud only), log tail
  const [statusResult, pidResult, gpuResult, logResult] = await Promise.allSettled([
    strategy.execCommand(statusCmd, 10000),
    strategy.execCommand(pidCmd, 10000),
    agent.cloud
      ? strategy.execCommand(cmds.gpuUtilization(), 10000)
      : Promise.resolve({ stdout: '', stderr: '', code: 0 }),
    strategy.execCommand(logCmd, 10000),
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

  // No status.json and no live pid: tell "the task never started" apart from
  // "could not read the task state" with one extra probe of the task dir
  // (only on this path, so a normal poll runs the same three commands).
  // A task that never started reports launch_failed with a reason -- never
  // status unknown with every field null.
  let derivedStatus: string | undefined;
  let reason: string | undefined;
  if (statusData.status === undefined && !pidAlive) {
    if (statusResult.status === 'rejected') {
      reason = `Could not read the task status on the member: ${errMessage(statusResult.reason)}`;
    } else {
      const dirCmd = isWindows
        ? wrapPowerShellEncoded(`if (Test-Path "${winTaskDir}") { echo present } else { echo missing }`)
        : `if [ -d ${taskDir} ]; then echo present; else echo missing; fi`;
      try {
        const probe = (await strategy.execCommand(dirCmd, 10000)).stdout.trim();
        if (probe === 'missing') {
          derivedStatus = 'launch_failed';
          reason = `The task never started: its task directory (${isWindows ? winTaskDir : taskDir}) does not exist on the member. The launch failed or the task id is wrong.`;
        } else if (probe === 'present') {
          derivedStatus = 'launch_failed';
          reason = 'The task never started: its task directory exists but the task wrapper never wrote status.json or task.pid.';
        } else {
          reason = `Could not determine whether the task started (unexpected probe output: ${JSON.stringify(probe.slice(0, 200))}).`;
        }
      } catch (err) {
        reason = `Could not read the task directory on the member: ${errMessage(err)}`;
      }
    }
  }

  let gpuUtilization: number | undefined;
  if (agent.cloud && gpuResult.status === 'fulfilled') {
    gpuUtilization = parseGpuUtilization(gpuResult.value.stdout);
  }

  const rawLogTail = logResult.status === 'fulfilled'
    ? logResult.value.stdout.trim()
    : '';

  const taskCreds = getTaskCredentials(input.task_id);
  const logTail = taskCreds.reduce(
    (out, c) => c.plaintext.length > 0 ? out.replaceAll(c.plaintext, `[REDACTED:${c.name}]`) : out,
    rawLogTail,
  );

  // Secrets bound at launch whose current value differs (read side-effect
  // free: no expired-entry deletion, no member-scope check).
  const secretChanges = getTaskSecretChanges(input.task_id);

  const taskStatus = String(statusData.status ?? derivedStatus ?? 'unknown');
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
    ...(reason !== undefined ? { reason } : {}),
    ...(gpuUtilization !== undefined ? { gpuUtilization } : {}),
    logTail: logTail || null,
    ...(autoStopped ? { autoStopped: true } : {}),
    ...(secretChanges.length > 0
      ? { secretChanges, secretWarning: secretChangeWarning(input.task_id, secretChanges, isWindows) }
      : {}),
  };

  return JSON.stringify(result, null, 2);
}
