import { getAgent } from '../registry.js';
import { getStrategy } from '../strategy.js';
import { getAgentOS } from '../../utils/agent-helpers.js';
import { logLine, logWarn } from '../../utils/log-helpers.js';

export interface PollResult {
  lastTimestamp: string | null;
  error?: string;
}

export async function pollLogFile(memberId: string, logFilePath: string): Promise<PollResult> {
  const agent = getAgent(memberId);
  if (!agent) {
    return { lastTimestamp: null, error: `Agent ${memberId} not found` };
  }

  const isWindows = getAgentOS(agent) === 'windows';
  const provider = agent.llmProvider ?? 'claude';

  const cmd = isWindows
    ? `powershell -c "Get-Content -Tail 20 -Path '${logFilePath}'"`
    : `tail -c 500 "${logFilePath}"`;

  try {
    const strategy = getStrategy(agent);
    const result = await strategy.execCommand(cmd, 5000);

    if (result.code !== 0) {
      if (/No such file|cannot access|not recognized|does not exist|ItemNotFoundException/i.test(result.stderr)) {
        return { lastTimestamp: null };
      }
      logWarn('stall_log_read', `pollLogFile failed for ${memberId}: code=${result.code} stderr=${result.stderr}`);
      return { lastTimestamp: null, error: `Command failed (code ${result.code}): ${result.stderr}` };
    }

    const lines = result.stdout.split('\n').filter(l => l.trim());

    if (provider === 'gemini') {
      return extractGeminiTimestamp(memberId, lines);
    }
    return extractClaudeTimestamp(memberId, lines);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { lastTimestamp: null, error: msg };
  }
}

function extractClaudeTimestamp(memberId: string, lines: string[]): PollResult {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as Record<string, unknown>;
      if (parsed['type'] === 'assistant') {
        const ts = parsed['timestamp'];
        if (typeof ts === 'string') {
          return { lastTimestamp: ts };
        }
        logLine('stall_poll_format_error', JSON.stringify({ memberId, error: 'assistant entry missing timestamp' }));
        return { lastTimestamp: null };
      }
    } catch {
      // partial line at start of tail — skip
    }
  }
  return { lastTimestamp: null };
}

function extractGeminiTimestamp(memberId: string, lines: string[]): PollResult {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as Record<string, unknown>;
      const set = parsed['$set'] as Record<string, unknown> | undefined;
      if (set !== undefined) {
        const ts = set['lastUpdated'];
        if (typeof ts === 'string') {
          return { lastTimestamp: ts };
        }
        logLine('stall_poll_format_error', JSON.stringify({ memberId, error: '$set entry missing lastUpdated' }));
        return { lastTimestamp: null };
      }
    } catch {
      // partial line — skip
    }
  }
  return { lastTimestamp: null };
}
