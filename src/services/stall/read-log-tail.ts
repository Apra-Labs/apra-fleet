import { getAgent } from '../registry.js';
import { getStrategy } from '../strategy.js';
import { getAgentOS, getAgentShell, isPosixShell } from '../../utils/agent-helpers.js';
import { logLine, logWarn } from '../../utils/log-helpers.js';
import { wrapPowerShellEncoded } from '../../os/windows.js';
import { escapePowerShellArgInner } from '../../utils/shell-escape.js';

/**
 * apra-fleet-uob4: every Windows (non-POSIX) stall command goes through
 * -EncodedCommand. A raw `powershell -c "..."` is re-parsed by the member's
 * outer shell: under powershell.exe (local members, PowerShell-default sshd)
 * `$c`/`$_` were expanded to empty before the inner PowerShell ever ran,
 * turning the script into a parse error. Progress output is silenced so an
 * encoded run does not also emit a `#< CLIXML` progress record on stderr.
 */
export function wrapStallPowerShell(psScript: string): string {
  return wrapPowerShellEncoded(`$ProgressPreference = 'SilentlyContinue'; ${psScript}`);
}

/** Interior of a PowerShell single-quoted literal: `'` doubled to `''`. */
export const psQuote = escapePowerShellArgInner;

/**
 * True when a failed tail read's stderr means "the log file does not exist
 * yet" (benign). A PowerShell parse / command-not-found error is never that,
 * even if its text happens to mention a missing item -- it is a broken
 * command and must surface as a read failure (apra-fleet-uob4).
 *
 * An -EncodedCommand run reports errors as `#< CLIXML` with the message
 * wrapped mid-phrase ("does not _x000D__x000A_</S><S S="Error">exist"), so
 * the XML/line-break markup is flattened to plain spaces before matching.
 */
export function isLogNotYetCreatedStderr(stderr: string): boolean {
  const text = stderr.replace(/_x000D__x000A_/g, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  if (/ParserError|CommandNotFoundException|is not recognized as/i.test(text)) return false;
  return /No such file|cannot access|does not exist|ItemNotFoundException/i.test(text);
}

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

  const os = getAgentOS(agent);
  const shell = getAgentShell(agent);
  const cmd = isPosixShell(os, shell)
    ? `tail -c 512 "${logFilePath}"`
    : wrapStallPowerShell(`Get-Content -Tail 5 -Path '${psQuote(logFilePath)}'`);

  try {
    const strategy = getStrategy(agent);
    const result = await strategy.execCommand(cmd, 5000);

    if (result.code === 0) {
      const lines = result.stdout.split('\n').filter(l => l.trim());
      // apra-fleet-qe83.2.2: scan backwards for the last entry that actually
      // carries a timestamp, mirroring stall-poller.ts's
      // extractClaudeTimestamp -- inspecting only the very last line missed
      // a dated entry sitting one line above a trailing untimestamped record
      // (e.g. an attachment or a last-prompt entry), exactly the shape of
      // the recorded missed stall.
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(lines[i]) as Record<string, unknown>;
          const ts = parsed['timestamp'];
          if (typeof ts === 'string') {
            return { lastTimestamp: ts };
          }
          // Entry with no timestamp (e.g. an attachment/last-prompt record)
          // -- keep scanning backwards rather than giving up on the sample.
        } catch {
          // partial line at start of tail -- skip
        }
      }
      return { lastTimestamp: null };
    }

    // File not yet created — not an error per resilience decision
    if (isLogNotYetCreatedStderr(result.stderr)) {
      return { lastTimestamp: null };
    }

    logWarn('stall_log_read', `readLogTail failed for ${memberId}: code=${result.code} stderr=${result.stderr}`);
    return { lastTimestamp: null, error: `Command failed (code ${result.code}): ${result.stderr}` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { lastTimestamp: null, error: msg };
  }
}
