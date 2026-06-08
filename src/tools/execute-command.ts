import os from 'node:os';
import { z } from 'zod';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { getAgentOS, touchAgent } from '../utils/agent-helpers.js';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { buildAuthEnvPrefix } from '../utils/auth-env.js';
import { writeStatusline } from '../services/statusline.js';
import { ensureCloudReady } from '../services/cloud/lifecycle.js';
import { generateTaskWrapper } from '../services/cloud/task-wrapper.js';
import { resolveSecureTokens, redactOutput, SEC_HANDLE_RE, registerTaskCredentials, collectOobConfirm } from 'blindfold';
import type { ResolvedCredential } from 'blindfold';
import { LogScope, maskSecrets, truncateForLog } from '../utils/log-helpers.js';
import { tryKillPid } from '../utils/pid-helpers.js';
import type { Agent } from '../types.js';

export function resolveTilde(p: string): string {
  if (p === '~' || p.startsWith('~/')) {
    return p.replace('~', os.homedir());
  }
  return p;
}

export const executeCommandSchema = z.object({
  ...memberIdentifier,
  command: z.string().describe('The shell command to execute'),
  timeout_s: z.number().default(120).describe('Timeout in seconds (default: 120s / 2 minutes)'),
  run_from: z.string().optional().describe("Override directory to run from. Defaults to member's registered work folder — rarely needed."),
  long_running: z.boolean().optional().default(false).describe('Run as background task; returns task_id for use with monitor_task'),
  max_retries: z.number().int().min(0).max(10).optional().default(3).describe('Max crash retries (long_running only)'),
  restart_command: z.string().optional().describe('Command for retry runs, e.g. checkpoint resume (long_running only)'),
});

export type ExecuteCommandInput = z.infer<typeof executeCommandSchema>;

// Best-effort heuristic — not a security boundary
const NETWORK_TOOL_RE = /\b(curl|wget|ssh|sftp|scp|rsync|nc|netcat|http|fetch|Invoke-WebRequest|Invoke-RestMethod)\b/i;


export async function executeCommand(input: ExecuteCommandInput, extra?: any): Promise<string> {
  const agentOrError = resolveMember(input.member_id, input.member_name);
  if (typeof agentOrError === 'string') return agentOrError;
  let agent: Agent;
  try {
    agent = await ensureCloudReady(agentOrError as Agent); // auto-start if stopped
  } catch (err: any) {
    return `Failed to execute command on "${(agentOrError as Agent).friendlyName}": ${err.message}`;
  }

  const strategy = getStrategy(agent);
    const scope = new LogScope('execute_command', `${truncateForLog(maskSecrets(input.command))}`, agent);
    const onPidCaptured = (pid: number) => scope.info(`pid=${pid}`);

  const cmds = getOsCommands(getAgentOS(agent));
  const agentOs = getAgentOS(agent);
    const abortHandler = () => {
      scope.abort('cancelled by MCP client');
      tryKillPid(agent, strategy, cmds).catch(() => {});
    };
    extra?.signal?.addEventListener('abort', abortHandler);
  try {


  // -- Block sec:// handles in run_from and restart_command --
  if (input.run_from && SEC_HANDLE_RE.test(input.run_from)) {
    return '❌ Credentials cannot be passed to LLM sessions — use {{secure.NAME}} tokens instead of sec:// handles.';
  }
  if (input.restart_command && SEC_HANDLE_RE.test(input.restart_command)) {
    return '❌ Credentials cannot be passed to LLM sessions — use {{secure.NAME}} tokens instead of sec:// handles.';
  }

  // -- Resolve {{secure.NAME}} tokens --
  const tokenResult = resolveSecureTokens(input.command, { caller: agent.friendlyName, os: agentOs });
  if ('error' in tokenResult) return `❌ ${tokenResult.error}`;

  const { resolved: resolvedCommand, credentials } = tokenResult;

  // Also resolve tokens in restart_command (H1)
  let resolvedRestartCommand: string | undefined;
  if (input.restart_command) {
    const restartTokenResult = resolveSecureTokens(input.restart_command, { caller: agent.friendlyName, os: agentOs });
    if ('error' in restartTokenResult) return `❌ ${restartTokenResult.error}`;
    resolvedRestartCommand = restartTokenResult.resolved;
    // Merge any additional credentials from restart_command (de-dup by name)
    for (const cred of restartTokenResult.credentials) {
      if (!credentials.find(c => c.name === cred.name)) {
        credentials.push(cred);
      }
    }
  }

  // -- Network egress check for credentials with confirm/deny policy --
  if (credentials.length > 0 && NETWORK_TOOL_RE.test(resolvedCommand)) {
    for (const cred of credentials) {
      if (cred.network_policy === 'deny') {
        return `❌ Blocked: credential "${cred.name}" has network_policy=deny and the command contains a network tool.`;
      }
      if (cred.network_policy === 'confirm') {
        const { confirmed, terminalUnavailable } = await collectOobConfirm(cred.name, { command: input.command, memberName: agent.friendlyName });
        if (!confirmed) {
          const reason = terminalUnavailable
            ? 'could not be confirmed (terminal unavailable)'
            : 'was not confirmed';
          return `❌ Network egress for credential "${cred.name}" ${reason}. Command not executed.`;
        }
      }
    }
  }

  const rawFolder = input.run_from ?? agent.workFolder;
  const folder = agent.agentType === 'local' ? resolveTilde(rawFolder) : rawFolder;


  // -- Long-running background task path --
  if (input.long_running) {
    const agentOsVal = getAgentOS(agent);
    const longRunningOsWarning = agentOsVal !== 'linux'
      ? `Note: Long-running tasks use a bash wrapper script designed for Linux. The member's OS is ${agentOsVal}, which may not support this feature.\n`
      : '';

    const taskId = 'task-' + Date.now().toString(36);
    registerTaskCredentials(taskId, credentials);
    const wrapperScript = generateTaskWrapper({
      taskId,
      command: resolvedCommand,
      restartCommand: resolvedRestartCommand,
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
      const launchResult = await strategy.execCommand(launchCmd, input.timeout_s * 1000, undefined, onPidCaptured);
      touchAgent(agent.id);
      writeStatusline();
      // Redact credential values from any output returned by the launch command (H2)
      const launchOutput = credentials.length > 0
        ? redactOutput(launchResult.stdout + launchResult.stderr, credentials)
        : '';
      void launchOutput; // output not surfaced to caller; redaction is a safety measure
      return `${longRunningOsWarning}Task launched: task_id=${taskId}\nUse monitor_task to track progress.`;
    } catch (err: any) {
      writeStatusline(new Map([[agent.id, 'offline']]));
      return `Failed to launch task on "${agent.friendlyName}": ${err.message}`;
    }
  }

  // -- Regular (synchronous) command path --
  const authPrefix = buildAuthEnvPrefix(agent, getAgentOS(agent));
  const wrapped = authPrefix + cmds.wrapInWorkFolder(folder, resolvedCommand);

  // Mark agent as busy in statusline
  writeStatusline(new Map([[agent.id, 'busy']]));

  try {
    const result = await strategy.execCommand(wrapped, input.timeout_s * 1000, undefined, onPidCaptured);
    touchAgent(agent.id); // T7: idle manager resets its timer via touchAgent

    const parts: string[] = [];
    if (result.stdout) parts.push(result.stdout);
    if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);
    const rawOutput = parts.join('\n') || '(no output)';

    // Redact credential values from output
    const output = credentials.length > 0 ? redactOutput(rawOutput, credentials) : rawOutput;

    writeStatusline();

    if (result.code !== 0) scope.fail(`exit=${result.code}`);
    else scope.ok(`exit=0`);

    return result.code === 0
      ? `Exit code: 0\n${output}`
      : `Exit code: ${result.code}\n${output}`;
  } catch (err: any) {
    writeStatusline(new Map([[agent.id, 'offline']]));
    scope.abort(err.message);
    return `Failed to execute command on "${agent.friendlyName}": ${err.message}`;
  }
} finally { extra?.signal?.removeEventListener('abort', abortHandler); }
}
