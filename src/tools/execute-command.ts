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
import { escapeShellArg, escapePowerShellArg } from '../utils/shell-escape.js';
import { credentialResolve } from '../services/credential-store.js';
import { collectOobConfirm } from '../services/auth-socket.js';
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
  timeout_ms: z.number().default(120000).describe('Timeout in milliseconds (default: 2 minutes)'),
  run_from: z.string().optional().describe("Override directory to run from. Defaults to member's registered work folder — rarely needed."),
  long_running: z.boolean().optional().default(false).describe('Run as background task; returns task_id for use with monitor_task'),
  max_retries: z.number().int().min(0).max(10).optional().default(3).describe('Max crash retries (long_running only)'),
  restart_command: z.string().optional().describe('Command for retry runs, e.g. checkpoint resume (long_running only)'),
});

export type ExecuteCommandInput = z.infer<typeof executeCommandSchema>;

// Network tools that trigger the "confirm" egress check
const NETWORK_TOOL_RE = /\b(curl|wget|ssh|sftp|scp|rsync|nc|netcat|http|fetch|Invoke-WebRequest|Invoke-RestMethod)\b/i;

interface ResolvedCredential {
  name: string;
  plaintext: string;
  network_policy: 'allow' | 'confirm' | 'deny';
}

/**
 * Scan a command string for {{secure.NAME}} tokens, resolve each from the
 * credential store, and return the substituted command plus metadata for
 * output redaction and egress checks.
 *
 * Returns an error string if any token cannot be resolved or is blocked.
 */
async function resolveSecureTokens(
  command: string,
  agentOs: 'windows' | 'macos' | 'linux',
): Promise<{ resolved: string; credentials: ResolvedCredential[] } | { error: string }> {
  // Refuse if raw sec:// handles appear (these should not be passed to commands)
  if (/sec:\/\/[a-zA-Z0-9_]+/.test(command)) {
    return { error: 'Credentials cannot be passed to LLM sessions — use {{secure.NAME}} tokens instead of sec:// handles.' };
  }

  const TOKEN_RE = /\{\{secure\.([a-zA-Z0-9_]{1,64})\}\}/g;
  const credentials: ResolvedCredential[] = [];
  let resolved = command;
  let match: RegExpExecArray | null;

  // Collect all unique token names first
  const tokenNames = new Set<string>();
  while ((match = TOKEN_RE.exec(command)) !== null) {
    tokenNames.add(match[1]);
  }

  for (const name of tokenNames) {
    const entry = credentialResolve(name);
    if (!entry) {
      return { error: `Credential "${name}" not found. Run credential_store_set first.` };
    }
    credentials.push({ name, plaintext: entry.plaintext, network_policy: entry.meta.network_policy });
  }

  // Substitute tokens with shell-escaped values.
  // Windows members run under PowerShell (confirmed by WindowsCommands.cleanExec),
  // so use single-quote escaping — internal single quotes are doubled ('').
  // This is safer than cmd.exe double-quote + ^ escaping which is unreliable in PS.
  for (const cred of credentials) {
    const escaped = agentOs === 'windows'
      ? escapePowerShellArg(cred.plaintext)
      : escapeShellArg(cred.plaintext);
    resolved = resolved.replaceAll(`{{secure.${cred.name}}}`, escaped);
  }

  return { resolved, credentials };
}

/**
 * Replace occurrences of credential plaintext values in output with [REDACTED:NAME].
 */
function redactOutput(output: string, credentials: ResolvedCredential[]): string {
  let redacted = output;
  for (const cred of credentials) {
    if (cred.plaintext.length > 0) {
      redacted = redacted.replaceAll(cred.plaintext, `[REDACTED:${cred.name}]`);
    }
  }
  return redacted;
}

export async function executeCommand(input: ExecuteCommandInput): Promise<string> {
  const agentOrError = resolveMember(input.member_id, input.member_name);
  if (typeof agentOrError === 'string') return agentOrError;
  let agent: Agent;
  try {
    agent = await ensureCloudReady(agentOrError as Agent); // auto-start if stopped
  } catch (err: any) {
    return `Failed to execute command on "${(agentOrError as Agent).friendlyName}": ${err.message}`;
  }

  const strategy = getStrategy(agent);
  const cmds = getOsCommands(getAgentOS(agent));
  const agentOs = getAgentOS(agent);

  // -- Block sec:// handles in run_from and restart_command --
  const SEC_RE = /sec:\/\/[a-zA-Z0-9_]+/;
  if (input.run_from && SEC_RE.test(input.run_from)) {
    return '❌ Credentials cannot be passed to LLM sessions — use {{secure.NAME}} tokens instead of sec:// handles.';
  }
  if (input.restart_command && SEC_RE.test(input.restart_command)) {
    return '❌ Credentials cannot be passed to LLM sessions — use {{secure.NAME}} tokens instead of sec:// handles.';
  }

  // -- Resolve {{secure.NAME}} tokens --
  const tokenResult = await resolveSecureTokens(input.command, agentOs);
  if ('error' in tokenResult) return `❌ ${tokenResult.error}`;

  const { resolved: resolvedCommand, credentials } = tokenResult;

  // -- Network egress check for credentials with confirm/deny policy --
  if (credentials.length > 0 && NETWORK_TOOL_RE.test(resolvedCommand)) {
    for (const cred of credentials) {
      if (cred.network_policy === 'deny') {
        return `❌ Blocked: credential "${cred.name}" has network_policy=deny and the command contains a network tool.`;
      }
      if (cred.network_policy === 'confirm') {
        const { confirmed, terminalUnavailable } = await collectOobConfirm(cred.name);
        if (!confirmed) {
          const reason = terminalUnavailable
            ? 'could not be confirmed (terminal unavailable)'
            : 'was not confirmed';
          return `❌ Network egress for credential "${cred.name}" ${reason}. Command not executed.`;
        }
      }
    }
  }

  const folder = resolveTilde(input.run_from ?? agent.workFolder);

  // -- Long-running background task path --
  if (input.long_running) {
    const agentOsVal = getAgentOS(agent);
    const longRunningOsWarning = agentOsVal !== 'linux'
      ? `Note: Long-running tasks use a bash wrapper script designed for Linux. The member's OS is ${agentOsVal}, which may not support this feature.\n`
      : '';

    const taskId = 'task-' + Date.now().toString(36);
    const wrapperScript = generateTaskWrapper({
      taskId,
      command: resolvedCommand,
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
  const wrapped = authPrefix + cmds.wrapInWorkFolder(folder, resolvedCommand);

  // Mark agent as busy in statusline
  writeStatusline(new Map([[agent.id, 'busy']]));

  try {
    const result = await strategy.execCommand(wrapped, input.timeout_ms);
    touchAgent(agent.id); // T7: idle manager resets its timer via touchAgent

    const parts: string[] = [];
    if (result.stdout) parts.push(result.stdout);
    if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);
    const rawOutput = parts.join('\n') || '(no output)';

    // Redact credential values from output
    const output = credentials.length > 0 ? redactOutput(rawOutput, credentials) : rawOutput;

    writeStatusline();

    return result.code === 0
      ? `Exit code: 0\n${output}`
      : `Exit code: ${result.code}\n${output}`;
  } catch (err: any) {
    writeStatusline(new Map([[agent.id, 'offline']]));
    return `Failed to execute command on "${agent.friendlyName}": ${err.message}`;
  }
}
