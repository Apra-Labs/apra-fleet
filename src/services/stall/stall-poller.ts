import { getAgent } from '../registry.js';
import { getStrategy, type AgentStrategy } from '../strategy.js';
import { getAgentOS } from '../../utils/agent-helpers.js';
import { logLine, logWarn } from '../../utils/log-helpers.js';
import { getProvider } from '../../providers/index.js';
import { escapeDoubleQuoted } from '../../os/os-commands.js';

export interface PollResult {
  lastTimestamp: string | null;
  error?: string;
  /**
   * apra-fleet-iuc.2: the transcript file's OS last-modified time (epoch ms),
   * fetched independently of the content-timestamp parsing above. This is a
   * format-agnostic, provider-agnostic ground truth for "did anything get
   * written to this file" -- it does not depend on the JSONL shape parsing
   * correctly, so it backstops exactly the class of bug fixed twice already
   * (apra-fleet-6z8.2, apra-fleet-979): a transcript format quirk making the
   * content scan come up empty must not by itself manufacture a false stall,
   * and conversely a frozen file (mtime genuinely not advancing) is the
   * defense-in-depth signal that a session is truly dead even if a terminal
   * event (e.g. max_turns_reached) was itself missed in the content scan.
   * `undefined` only when the stat itself could not be attempted (should not
   * happen); `null` when the file could not be stat'd (not created yet,
   * permission error, etc.) -- treated the same as "no signal" by callers.
   */
  mtimeMs?: number | null;
}

/**
 * Polling for directory-level file activity for provisional sessions where a
 * specific session file is not yet known before spawn (e.g. AGY fresh turns).
 */
export async function pollDirectoryMtimeMs(memberId: string): Promise<number | null> {
  const agent = getAgent(memberId);
  if (!agent) return null;

  const provider = agent.llmProvider ?? 'claude';
  const adapter = getProvider(provider);
  const logDir = adapter.resolveSessionLogDir(agent.workFolder);
  if (!logDir) return null;

  const isWindows = getAgentOS(agent) === 'windows';
  const strategy = getStrategy(agent);

  const escapedWinDir = logDir.replace(/'/g, "''");
  const escapedPosixDir = escapeDoubleQuoted(logDir);

  const cmd = isWindows
    ? `powershell -c "$i = Get-ChildItem -Path '${escapedWinDir}' -Depth 2 -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1; if ($i) { [DateTimeOffset]::new($i.LastWriteTimeUtc, [TimeSpan]::Zero).ToUnixTimeMilliseconds() }"`
    : `find "${escapedPosixDir}" -maxdepth 2 -type f -exec stat -c %Y {} + 2>/dev/null | sort -nr | head -n1`;

  try {
    const result = await strategy.execCommand(cmd, 5000);
    const trimmed = result.stdout.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n <= 0) return null;
    return isWindows ? n : n * 1000;
  } catch {
    return null;
  }
}

/**
 * apra-fleet-iuc.2: fetch the transcript file's own OS mtime, independent of
 * (and in addition to) the content-based timestamp extraction below. Never
 * throws -- any failure (file missing, stat unsupported, parse failure)
 * yields `null`, which callers treat as "no additional signal" rather than
 * "confirmed no activity" (see stall-detector.ts's mtime cross-check).
 */
async function fetchMtimeMs(
  strategy: AgentStrategy,
  logFilePath: string,
  isWindows: boolean
): Promise<number | null> {
  const cmd = isWindows
    ? `powershell -c "$i = Get-Item -LiteralPath '${logFilePath}' -ErrorAction SilentlyContinue; if ($i) { [DateTimeOffset]::new($i.LastWriteTimeUtc, [TimeSpan]::Zero).ToUnixTimeMilliseconds() }"`
    // GNU stat (`-c %Y`) first; BSD/macOS stat (`-f %m`) as a fallback -- both report whole seconds.
    : `stat -c %Y "${logFilePath}" 2>/dev/null || stat -f %m "${logFilePath}" 2>/dev/null`;

  try {
    const result = await strategy.execCommand(cmd, 5000);
    const trimmed = result.stdout.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n <= 0) return null;
    return isWindows ? n : n * 1000;
  } catch {
    return null;
  }
}

/** How many trailing transcript lines each poll samples (apra-fleet-6z8.2). */
const TAIL_LINES = 20;
/** Byte ceiling applied to that sample so a huge tool_result cannot flood the poll. */
const TAIL_BYTES = 65536;

/** Last `"timestamp": "..."` occurrence in the raw tail -- the fallback for a
 *  sample whose only complete-looking entry is still too large to have been
 *  captured whole (apra-fleet-6z8.2).
 *
 *  apra-fleet-979: a tool_result's content is itself JSON-serialized into a
 *  string field (e.g. `"content":"{\"timestamp\":\"...\"}"`), so any
 *  "timestamp" key embedded in that payload appears in the raw text with its
 *  surrounding quotes backslash-escaped (`\"timestamp\"`), never as bare
 *  `"timestamp"`. A genuine top-level transcript-entry timestamp is a direct
 *  key of the JSON-lines object and its quotes are never escaped. The
 *  negative lookbehind on the opening quote excludes the escaped/nested form;
 *  restricting the value to `[^"\\]*` keeps the match from running past an
 *  escaped quote inside a neighboring embedded payload. */
const RAW_TIMESTAMP_RE = /(?<!\\)"timestamp"\s*:\s*"([^"\\]*)"/g;

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
    // apra-fleet-iuc.2: fetch the file's own mtime independently of the
    // content-based read below. Never throws and never affects the
    // content-read's own error handling -- it is purely additive signal that
    // stall-detector.ts cross-checks against the content timestamp.
    const mtimeMs = await fetchMtimeMs(strategy, logFilePath, isWindows);
    const result = await strategy.execCommand(cmd, 5000);

    if (result.code !== 0) {
      if (/No such file|cannot access|not recognized|does not exist|ItemNotFoundException/i.test(result.stderr)) {
        return { lastTimestamp: null, mtimeMs };
      }
      logWarn('stall_log_read', `pollLogFile failed for ${memberId}: code=${result.code} stderr=${result.stderr}`);
      return { lastTimestamp: null, error: `Command failed (code ${result.code}): ${result.stderr}`, mtimeMs };
    }

    const lines = result.stdout.split('\n').filter(l => l.trim());

    const extracted = provider === 'gemini'
      ? extractGeminiTimestamp(memberId, lines)
      : provider === 'agy'
      ? extractAgyTimestamp(memberId, lines, result.stdout)
      : extractClaudeTimestamp(memberId, lines, result.stdout);
    return { ...extracted, mtimeMs };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { lastTimestamp: null, error: msg };
  }
}

/**
 * AGY transcript entries carry a top-level `created_at` ISO 8601 UTC timestamp
 * (e.g. "created_at": "2026-08-05T05:13:28Z").
 */
const RAW_AGY_TIMESTAMP_RE = /(?<!\\)"created_at"\s*:\s*"([^"\\]*)"/g;

function extractAgyTimestamp(memberId: string, lines: string[], rawTail = ''): PollResult {
  let sawParseableEntry = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as Record<string, unknown>;
      sawParseableEntry = true;
      const ts = parsed['created_at'] ?? parsed['timestamp'];
      if (typeof ts === 'string') {
        return { lastTimestamp: ts };
      }
    } catch {
      // partial line at start of tail -- skip
    }
  }

  let lastRaw: string | null = null;
  RAW_AGY_TIMESTAMP_RE.lastIndex = 0;
  for (let m = RAW_AGY_TIMESTAMP_RE.exec(rawTail); m !== null; m = RAW_AGY_TIMESTAMP_RE.exec(rawTail)) {
    lastRaw = m[1];
  }
  if (lastRaw !== null) return { lastTimestamp: lastRaw };

  if (sawParseableEntry) {
    logLine('stall_poll_format_error', JSON.stringify({ memberId, error: 'no entry with created_at in tail' }));
  }
  return { lastTimestamp: null };
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
      // partial line at start of tail -- skip
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
      // partial line -- skip
    }
  }
  return { lastTimestamp: null };
}
