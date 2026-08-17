import os from 'node:os';
import { z } from 'zod';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { getAgentOS, touchAgent } from '../utils/agent-helpers.js';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { buildAuthEnvPrefix } from '../utils/auth-env.js';
import { writeStatusline } from '../services/statusline.js';
import { ensureCloudReady } from '../services/cloud/lifecycle.js';
import { generateTaskWrapper, generateTaskWrapperWindows } from '../services/cloud/task-wrapper.js';
import { escapeShellArg, escapePowerShellArg, escapeWindowsArg } from '../utils/shell-escape.js';
import { wrapPowerShellEncoded } from '../os/windows.js';
import { credentialResolve, registerTaskCredentials } from '../services/credential-store.js';
import { collectOobConfirm } from '../services/auth-socket.js';
import { LogScope, maskSecrets, truncateForLog, logLine } from '../utils/log-helpers.js';
import { attachMcpDisconnectHandler } from '../services/dispatch-helpers.js';
import { getLogPreviewChars } from '../services/user-config.js';
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

// Matches raw sec:// credential handles that must never reach shell or LLM
const SEC_RE = /sec:\/\/[a-zA-Z0-9_]+/;

/** Cap command output before logging it, to protect the fleet log from huge dumps. */
function capForLog(text: string, maxLines = 50, maxChars = 4000): string {
  let t = text.length > maxChars ? text.slice(0, maxChars) + '\n... [output truncated]' : text;
  const lines = t.split('\n');
  if (lines.length > maxLines) {
    t = lines.slice(0, maxLines).join('\n') + `\n... [+${lines.length - maxLines} more lines]`;
  }
  return t;
}

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
  callingMember: string,
): Promise<{ resolved: string; credentials: ResolvedCredential[] } | { error: string }> {
  // Refuse if raw sec:// handles appear (these should not be passed to commands)
  if (/sec:\/\/[a-zA-Z0-9_]+/.test(command)) {
    return { error: 'Credentials cannot be passed to LLM sessions — use {{secure.NAME}} tokens instead of sec:// handles.' };
  }

  const TOKEN_RE = /\{\{secure\.([a-zA-Z0-9_-]{1,64})\}\}/g;
  const credentials: ResolvedCredential[] = [];
  let resolved = command;
  let match: RegExpExecArray | null;

  // Collect all unique token names first
  const tokenNames = new Set<string>();
  while ((match = TOKEN_RE.exec(command)) !== null) {
    tokenNames.add(match[1]);
  }

  for (const name of tokenNames) {
    const entry = credentialResolve(name, callingMember);
    if (!entry) {
      return { error: `Credential "${name}" not found. Run credential_store_set first.` };
    }
    if ('denied' in entry) return { error: entry.denied };
    if ('expired' in entry) return { error: entry.expired };
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

export interface ExecuteCommandStructured {
  exitCode: number;
  stdout: string;
  stderr: string;
  [key: string]: unknown;
}

export interface ExecuteCommandResult {
  text: string;
  structuredContent?: ExecuteCommandStructured;
}

export async function executeCommand(input: ExecuteCommandInput, extra?: any): Promise<string | ExecuteCommandResult> {
  const agentOrError = resolveMember(input.member_id, input.member_name);
  if (typeof agentOrError === 'string') return agentOrError;
  let agent: Agent;
  try {
    agent = await ensureCloudReady(agentOrError as Agent); // auto-start if stopped
  } catch (err: any) {
    return `Failed to execute command on "${(agentOrError as Agent).friendlyName}": ${err.message}`;
  }

  const strategy = getStrategy(agent);
    const scope = new LogScope('execute_command', truncateForLog(maskSecrets(input.command), getLogPreviewChars()), agent);
    const onPidCaptured = (pid: number) => scope.info(`pid=${pid}`);

  const cmds = getOsCommands(getAgentOS(agent));
  const agentOs = getAgentOS(agent);
    // apra-fleet-d64.1: MCP transport drops must NOT kill the remote process.
    // The remote command is independent of the MCP session and should continue
    // running. The abort handler only logs the disconnection -- tryKillPid is
    // NOT called here. Same pattern as execute-prompt.ts.
    const detachMcpHandler = attachMcpDisconnectHandler(extra?.signal, scope);
  try {


  // -- Block sec:// handles in run_from and restart_command --
  if (input.run_from && SEC_RE.test(input.run_from)) {
    return '❌ Credentials cannot be passed to LLM sessions — use {{secure.NAME}} tokens instead of sec:// handles.';
  }
  if (input.restart_command && SEC_RE.test(input.restart_command)) {
    return '❌ Credentials cannot be passed to LLM sessions — use {{secure.NAME}} tokens instead of sec:// handles.';
  }

  // -- Resolve {{secure.NAME}} tokens --
  const tokenResult = await resolveSecureTokens(input.command, agentOs, agent.friendlyName);
  if ('error' in tokenResult) return `❌ ${tokenResult.error}`;

  const { resolved: resolvedCommand, credentials } = tokenResult;

  // Also resolve tokens in restart_command (H1)
  let resolvedRestartCommand: string | undefined;
  if (input.restart_command) {
    const restartTokenResult = await resolveSecureTokens(input.restart_command, agentOs, agent.friendlyName);
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

    const longRunningOsWarning = (agentOsVal !== 'linux' && agentOsVal !== 'windows')
      ? `Note: Long-running tasks use a bash wrapper script designed for Linux. The member's OS is ${agentOsVal}, which may not support this feature.\n`
      : '';

    const taskId = 'task-' + Date.now().toString(36);
    registerTaskCredentials(taskId, credentials);

    let launchCmd: string;
    if (agentOsVal === 'windows') {
      // Detached spawn via WMI (Invoke-CimMethod Win32_Process.Create): the
      // process is created under the WMI provider host's own session
      // (session 0), independent of the SSH session's job object -- a plain
      // background launch dies with the SSH channel on Windows (verified
      // live), so `nohup ... &`'s POSIX equivalent does not exist here.
      const wrapperScript = generateTaskWrapperWindows({
        taskId,
        command: resolvedCommand,
        restartCommand: resolvedRestartCommand,
        maxRetries: input.max_retries ?? 3,
        activityIntervalSec: 300,
      });
      const scriptB64 = Buffer.from(wrapperScript, 'utf-8').toString('base64');
      const taskDir = `$env:USERPROFILE\\.fleet-tasks\\${taskId}`;
      const runPs1 = `${taskDir}\\run.ps1`;
      const psCommandLine = `powershell -NoProfile -ExecutionPolicy Bypass -File "${runPs1}"`;
      launchCmd = wrapPowerShellEncoded([
        `New-Item -Path "${taskDir}" -ItemType Directory -Force | Out-Null`,
        `[IO.File]::WriteAllBytes("${runPs1}", [Convert]::FromBase64String('${scriptB64}'))`,
        `$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "${escapeWindowsArg(psCommandLine)}"; CurrentDirectory = "${escapeWindowsArg(folder)}" }`,
        `if ($result.ReturnValue -ne 0) { Write-Error "Win32_Process.Create failed with code $($result.ReturnValue)"; exit 1 }`,
        // Deliberately NOT the FLEET_PID: marker -- that label is matched by
        // ssh.ts's onPidCaptured regex, which arms killRemoteTree() to
        // taskkill this PID on inactivity/max-total/abort. $result.ProcessId
        // here is the detached run.ps1 task process itself (WMI-spawned to
        // survive SSH channel teardown), NOT the short-lived launcher/SSH
        // command process -- the process killRemoteTree exists to reap. If
        // this launch channel stalls after this line but before it closes,
        // matching FLEET_PID would kill the very task detachment protects.
        // The task's real PID is durably recorded in task.pid inside its own
        // task dir (written by the wrapper script itself; see
        // generateTaskWrapperWindows in task-wrapper.ts) and read from there
        // by monitor_task -- nothing reads this value off this channel, so
        // it exists solely as human-readable launch confirmation.
        `Write-Output "TASK_PID:$($result.ProcessId)"`,
      ].join('; '));
    } else {
      const wrapperScript = generateTaskWrapper({
        taskId,
        command: resolvedCommand,
        restartCommand: resolvedRestartCommand,
        maxRetries: input.max_retries ?? 3,
        activityIntervalSec: 300,
      });
      const scriptB64 = Buffer.from(wrapperScript).toString('base64');

      // Create task dir, decode + write wrapper script, chmod, launch with nohup
      launchCmd = cmds.wrapInWorkFolder(
        folder,
        `mkdir -p ~/.fleet-tasks/${taskId} && ` +
        `printf '%s' '${scriptB64}' | base64 -d > ~/.fleet-tasks/${taskId}/run.sh && ` +
        `chmod +x ~/.fleet-tasks/${taskId}/run.sh && ` +
        `nohup bash ~/.fleet-tasks/${taskId}/run.sh > /dev/null 2>&1 & echo $!`,
      );
    }

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
  // wrapPidCapture lets a timed-out ssh.ts/strategy.ts execCommand recover a
  // PID to tree-kill (apra-fleet-kwx precedent) -- without it, a command with
  // no PID protocol of its own (unlike a provider launch) leaves the remote
  // process running forever past the timeout, since ssh has no local child
  // handle to fall back on the way LocalStrategy does.
  const wrapped = authPrefix + cmds.wrapPidCapture(cmds.wrapInWorkFolder(folder, resolvedCommand));

  // Mark agent as busy in statusline
  writeStatusline(new Map([[agent.id, 'busy']]));

  try {
    const result = await strategy.execCommand(wrapped, input.timeout_s * 1000, undefined, onPidCaptured);
    touchAgent(agent.id); // T7: idle manager resets its timer via touchAgent

    const parts: string[] = [];
    if (result.stdout) parts.push(result.stdout);
    if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);
    const rawOutput = parts.join('\n') || '(no output)';

    // Redact credential values from output. Structured stdout/stderr are
    // redacted independently (not just the combined display text) so a
    // programmatic caller reading structuredContent never sees a secret that
    // the text channel would have masked.
    const output = credentials.length > 0 ? redactOutput(rawOutput, credentials) : rawOutput;
    const redactedStdout = credentials.length > 0 ? redactOutput(result.stdout ?? '', credentials) : (result.stdout ?? '');
    const redactedStderr = credentials.length > 0 ? redactOutput(result.stderr ?? '', credentials) : (result.stderr ?? '');

    writeStatusline();

    // Log command output under a dedicated tag so `watch` can surface it (the
    // fleet log is watch's source; short-command stdout is otherwise not
    // persisted anywhere). Capped to protect the log from huge outputs.
    if (output && output !== '(no output)') {
      logLine('command_output', capForLog(output), agent, scope.getInv());
    }

    if (result.code !== 0) scope.fail(`exit=${result.code}`);
    else scope.ok(`exit=0`);

    // The `Exit code: N\n<output>` text stays for human/LLM-facing display
    // (agents that dispatch execute_command conversationally read this
    // directly, per the fleet skill's dispatch rules) -- structuredContent is
    // an ADDITIVE machine-readable channel alongside it, not a replacement.
    // Programmatic callers (e.g. FleetWorkflow.command()) should prefer
    // structuredContent.stdout over scraping/stripping the text prefix.
    return {
      text: result.code === 0 ? `Exit code: 0\n${output}` : `Exit code: ${result.code}\n${output}`,
      structuredContent: { exitCode: result.code, stdout: redactedStdout, stderr: redactedStderr },
    };
  } catch (err: any) {
    writeStatusline(new Map([[agent.id, 'offline']]));
    scope.abort(err.message);
    return `Failed to execute command on "${agent.friendlyName}": ${err.message}`;
  }
} finally { detachMcpHandler(); }
}
