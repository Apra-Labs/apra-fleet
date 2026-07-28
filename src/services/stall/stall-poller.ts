import { getAgent } from '../registry.js';
import { getStrategy } from '../strategy.js';
import { getAgentOS } from '../../utils/agent-helpers.js';
import { logLine, logWarn } from '../../utils/log-helpers.js';

export interface PollResult {
  lastTimestamp: string | null;
  error?: string;
}

/** How many trailing transcript lines each poll samples (apra-fleet-6z8.2). */
const TAIL_LINES = 20;
/** Byte ceiling applied to that sample so a huge tool_result cannot flood the poll. */
const TAIL_BYTES = 65536;

/** Last `"timestamp": "..."` occurrence in the raw tail -- the fallback for a
 *  sample whose only complete-looking entry is still too large to have been
 *  captured whole (apra-fleet-6z8.2). */
const RAW_TIMESTAMP_RE = /"timestamp"\s*:\s*"([^"]+)"/g;

export async function pollLogFile(memberId: string, logFilePath: string): Promise<PollResult> {
  const agent = getAgent(memberId);
  if (!agent) {
    return { lastTimestamp: null, error: `Agent ${memberId} not found` };
  }

  const isWindows = getAgentOS(agent) === 'windows';
  const provider = agent.llmProvider ?? 'claude';

  // apra-fleet-6z8.2: the tail window must be wide enough that a parseable
  // entry is reliably present. 500 bytes is thinner than a single tool_result
  // payload on a bd/git-heavy turn, so the sample routinely landed inside one
  // truncated entry and yielded nothing at all. Take the last TAIL_LINES
  // complete lines, then cap the bytes so a pathological transcript cannot
  // stream megabytes over SSH every poll (the byte cap is applied from the END,
  // so the final line stays complete; only the leading fragment is lost, and
  // the parser already skips that).
  const cmd = isWindows
    ? `powershell -c "Get-Content -Tail ${TAIL_LINES} -Path '${logFilePath}'"`
    : `tail -n ${TAIL_LINES} "${logFilePath}" | tail -c ${TAIL_BYTES}`;

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
    return extractClaudeTimestamp(memberId, lines, result.stdout);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { lastTimestamp: null, error: msg };
  }
}

/**
 * apra-fleet-6z8.2: track the most recent entry of ANY type, not only
 * type==='assistant'.
 *
 * Every Claude transcript entry carries a `timestamp`, and ANY newly appended
 * line -- a user turn, a tool call, a tool_result -- is legitimate evidence of
 * progress. Restricting the scan to assistant entries made the poll return null
 * on almost every tick of a bd/git-tool-heavy turn (the common Planner/doer
 * shape), and stall-detector.ts treats null as "log not created yet, do NOT
 * count as a stall cycle" and `continue`s BEFORE the threshold check ever runs.
 * Live-confirmed 2026-07-27: lastActivityAt stayed pinned at the stall_add
 * timestamp across all 8 ticks of a 241s window (>> the 120s threshold) because
 * every poll returned null -- so a genuinely wedged turn was exactly as
 * invisible as a healthy one.
 */
function extractClaudeTimestamp(memberId: string, lines: string[], rawTail = ''): PollResult {
  let sawParseableEntry = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as Record<string, unknown>;
      sawParseableEntry = true;
      const ts = parsed['timestamp'];
      if (typeof ts === 'string') {
        return { lastTimestamp: ts };
      }
      // Entry with no timestamp (e.g. a summary/meta record) -- keep scanning
      // backwards rather than giving up on the whole sample.
    } catch {
      // partial line at start of tail — skip
    }
  }

  // Nothing parsed whole (a single tool_result larger than the sampled window).
  // Recover the last timestamp textually rather than reporting "no activity".
  let lastRaw: string | null = null;
  RAW_TIMESTAMP_RE.lastIndex = 0;
  for (let m = RAW_TIMESTAMP_RE.exec(rawTail); m !== null; m = RAW_TIMESTAMP_RE.exec(rawTail)) {
    lastRaw = m[1];
  }
  if (lastRaw !== null) return { lastTimestamp: lastRaw };

  if (sawParseableEntry) {
    logLine('stall_poll_format_error', JSON.stringify({ memberId, error: 'no entry with a timestamp in tail' }));
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
