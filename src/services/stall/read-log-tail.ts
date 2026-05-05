import { getAgent } from '../registry.js';
import { getStrategy } from '../strategy.js';
import { getAgentOS } from '../../utils/agent-helpers.js';
import { logLine, logWarn } from '../../utils/log-helpers.js';

export interface ReadLogResult {
  lastTimestamp: string | null;
  error?: string;
}

export async function readLogTail(memberId: string, logFilePath: string): Promise<ReadLogResult> {
  const agent = getAgent(memberId);
  if (!agent) {
    return { lastTimestamp: null, error: `Agent ${memberId} not found` };
  }

  logLine('stall_log_read', JSON.stringify({ event: 'stall_log_read', memberId, logFilePath }));

  const isWindows = getAgentOS(agent) === 'windows';
  const cmd = isWindows
    ? `powershell -c "Get-Content -Tail 5 -Path '${logFilePath}'"`
    : `tail -c 512 "${logFilePath}"`;

  try {
    const strategy = getStrategy(agent);
    const result = await strategy.execCommand(cmd, 5000);

    if (result.code === 0) {
      const lines = result.stdout.split('\n').filter(l => l.trim());
      const lastLine = lines[lines.length - 1];
      if (!lastLine) return { lastTimestamp: null };
      try {
        const parsed = JSON.parse(lastLine) as Record<string, unknown>;
        const ts = parsed['timestamp'];
        return { lastTimestamp: typeof ts === 'string' ? ts : null };
      } catch {
        return { lastTimestamp: null };
      }
    }

    // File not yet created — not an error per resilience decision
    if (/No such file|cannot access|not recognized|does not exist|ItemNotFoundException/i.test(result.stderr)) {
      return { lastTimestamp: null };
    }

    logWarn('stall_log_read', `readLogTail failed for ${memberId}: code=${result.code} stderr=${result.stderr}`);
    return { lastTimestamp: null, error: `Command failed (code ${result.code}): ${result.stderr}` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { lastTimestamp: null, error: msg };
  }
}
