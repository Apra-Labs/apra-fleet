import { updateAgent } from '../registry.js';
import { logLine, logWarn, LogScope } from '../../utils/log-helpers.js';
import { pollLogFile, pollDirectoryActivity } from './stall-poller.js';
import { toLocalISOString, fmtElapsed } from './time-utils.js';
import { writeStatusline } from '../statusline.js';

const DEFAULT_POLL_INTERVAL_MS = 30_000;
// apra-fleet: was 120_000. Raised to 150_000 -- Claude Code's own default
// Bash-tool timeout is also 120_000ms, so the old value collided with (and
// often lost to) that clock on any turn whose last tool_use declared no
// explicit timeout of its own. This is the "no declared timeout" fallback
// only; see TOOL_TIMEOUT_GRACE_MS below for the (usually much larger)
// effective threshold used when the pending tool_use DOES declare one.
const DEFAULT_STALL_THRESHOLD_MS = 150_000;
// apra-fleet: grace added on top of a pending tool_use's own declared
// `input.timeout` before treating it as stalled. Two real fleet-win-dev1
// stalls (apra-fleet-ivxi/u1qw/69pp) were killed while their last tool_use
// carried an explicit 600000ms/900000ms budget -- the fleet's watchdog must
// never fire before the tool's own timeout would have. The margin covers
// polling cadence (DEFAULT_POLL_INTERVAL_MS) plus time for Claude Code to
// write the resulting tool_result/error after its own timeout fires.
const TOOL_TIMEOUT_GRACE_MS = 60_000;

export interface StallEntry {
  sessionId: string | null;
  logFilePath: string | null;
  lastActivityAt: number;
  consecutiveIdleCycles: number;
  consecutiveReadFailures: number;
  memberId: string;
  memberName: string;
  provisional: boolean;
  /** A genuine stall has been detected AND reported/killed -- suppresses
   *  re-reporting and re-killing. Reset when activity resumes. */
  stallReported: boolean;
  /**
   * SF-19: separate latch for the "no activity signal is available for this
   * member/provider" warning. It exists ONLY to keep that warning from
   * repeating every tick, and must never be conflated with `stallReported`:
   * a single transient no-signal tick (a flaky home-dir probe, a momentary
   * network blip) previously set `stallReported: true`, which permanently
   * disarmed the genuine-kill check below for the rest of the dispatch even
   * once a real signal became available again.
   */
  noSignalReported?: boolean;
  // Called once when stall is confirmed — clears busy state from outside the hung execCommand
  onStall?: () => void;
}

export class StallDetector {
  readonly stallCheckList: Map<string, StallEntry> = new Map();
  private pollInterval: NodeJS.Timeout | null = null;

  add(memberId: string, entry: StallEntry): void {
    if (this.stallCheckList.has(memberId)) {
      logWarn('stall_detector', `Overwriting existing entry for member ${memberId}`);
    }
    logLine('stall_add', `member=${entry.memberName} provisional=${entry.provisional} total=${this.stallCheckList.size + 1}`);
    this.stallCheckList.set(memberId, entry);
  }

  update(memberId: string, partial: Partial<StallEntry>): void {
    const existing = this.stallCheckList.get(memberId);
    if (!existing) {
      logWarn('stall_detector', `Cannot update non-existent entry for member ${memberId}`);
      return;
    }
    this.stallCheckList.set(memberId, { ...existing, ...partial });
  }

  remove(memberId: string): void {
    logLine('stall_remove', `memberId=${memberId} remaining=${this.stallCheckList.size - 1}`);
    this.stallCheckList.delete(memberId);
  }

  getEntry(memberId: string): StallEntry | undefined {
    return this.stallCheckList.get(memberId);
  }

  start(): void {
    if (this.pollInterval !== null) {
      logWarn('stall_detector', 'Already started');
      return;
    }
    const intervalMs = parseInt(process.env['STALL_POLL_INTERVAL_MS'] ?? String(DEFAULT_POLL_INTERVAL_MS));
    this.pollInterval = setInterval(() => void this._poll(), intervalMs);
    this.pollInterval.unref();
    logLine('stall_detector', 'StallDetector started');
  }

  stop(): void {
    if (this.pollInterval !== null) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.stallCheckList.clear();
    logLine('stall_detector', 'StallDetector stopped');
  }

  async _poll(): Promise<void> {
    if (this.stallCheckList.size === 0) return;

    const scope = new LogScope('stall_poll_tick', JSON.stringify({
      activeWatched: this.stallCheckList.size,
      provisional: [...this.stallCheckList.values()].filter(e => e.provisional).length,
      members: [...this.stallCheckList.values()].map(e => e.memberName),
    }));

    const now = Date.now();
    const stallThresholdMs = parseInt(process.env['STALL_THRESHOLD_MS'] ?? String(DEFAULT_STALL_THRESHOLD_MS));

    for (const [memberId, entry] of this.stallCheckList.entries()) {
      if (entry.provisional) {
        // Provisional: if logFilePath is available, check mtime; if logFilePath is null, poll directory activity
        let signalAvailable = true;
        // apra-fleet-ivxi.8: mirrors the non-provisional path's
        // effectiveThresholdMs computation (below, line ~202) -- a
        // provisional entry can carry a pending tool_use whose own declared
        // timeout must override the generic baseline threshold too, or it
        // can be killed mid-budget before ever leaving the provisional state.
        let provisionalPendingToolTimeoutMs: number | null | undefined;
        if (entry.logFilePath) {
          try {
            const pollResult = await pollLogFile(memberId, entry.logFilePath);
            provisionalPendingToolTimeoutMs = pollResult.pendingToolTimeoutMs;
            if (pollResult.mtimeMs && pollResult.mtimeMs > entry.lastActivityAt) {
              entry.lastActivityAt = pollResult.mtimeMs;
              entry.provisional = false;
            }
          } catch { /* best effort */ }
        } else {
          // apra-fleet issue #390 / apra-fleet-igoe: default to "a signal is
          // available" so any unexpected failure of the poller itself keeps the
          // pre-existing (kill-capable) behavior. Only an explicit
          // signalAvailable:false -- the provider genuinely has no pollable log
          // directory, or the member's home dir could not be resolved -- opts
          // this entry out of the baseline-timeout kill below.
          try {
            const activity = await pollDirectoryActivity(memberId);
            signalAvailable = activity?.signalAvailable !== false;
            if (activity?.mtimeMs && activity.mtimeMs > entry.lastActivityAt) {
              entry.lastActivityAt = activity.mtimeMs;
            }
          } catch { /* best effort */ }
        }

        // apra-fleet issue #390 / apra-fleet-igoe: with NO activity-signal
        // mechanism at all, "we never saw progress" is the absence of evidence,
        // not evidence of a stall -- lastActivityAt is simply frozen at dispatch
        // start and crosses the threshold for every dispatch longer than it,
        // healthy or not. Killing on that is a pure false positive (it fired for
        // EVERY codex/copilot/none dispatch, local or remote, past 120s). Warn
        // once instead; other ceilings (e.g. execute_prompt's max_total_s /
        // timeout_s) still bound such a dispatch.
        // SF-19: latch the warning on `noSignalReported`, NOT on
        // `stallReported`. Using the latter meant one transient no-signal tick
        // permanently suppressed the genuine-kill check further down, silently
        // forfeiting real stall protection for the remainder of the dispatch.
        if (!signalAvailable) {
          if (now - entry.lastActivityAt > stallThresholdMs && !entry.noSignalReported) {
            this.update(memberId, { noSignalReported: true });
            logWarn('stall_no_signal', JSON.stringify({
              memberId,
              memberName: entry.memberName,
              idleSecs: Math.floor((now - entry.lastActivityAt) / 1000),
              note: 'no stall signal available for this member/provider -- not killing; relying on dispatch timeouts',
            }));
          }
          writeStatusline(new Map([[memberId, `busy(${fmtElapsed(now - entry.lastActivityAt)})`]]));
          continue;
        }

        // Baseline timeout check for provisional entries. Same override as
        // the non-provisional path: a pending tool_use's own declared
        // timeout, when present, replaces the generic baseline threshold for
        // this tick's stall check.
        const provisionalEffectiveThresholdMs = provisionalPendingToolTimeoutMs
          ? provisionalPendingToolTimeoutMs + TOOL_TIMEOUT_GRACE_MS
          : stallThresholdMs;
        if (now - entry.lastActivityAt > provisionalEffectiveThresholdMs && !entry.stallReported) {
          const idleSecs = Math.floor((now - entry.lastActivityAt) / 1000);
          scope.warn(JSON.stringify({
            event: 'stall_detected',
            memberId,
            memberName: entry.memberName,
            idleSecs,
            provisional: true,
            pendingToolTimeoutMs: provisionalPendingToolTimeoutMs ?? null,
            effectiveThresholdMs: provisionalEffectiveThresholdMs,
            lastActivityAt: toLocalISOString(entry.lastActivityAt),
          }));
          writeStatusline(new Map([[memberId, 'unknown']]));
          this.update(memberId, { stallReported: true });
          entry.onStall?.();
        } else if (!entry.stallReported) {
          writeStatusline(new Map([[memberId, `busy(${fmtElapsed(now - entry.lastActivityAt)})`]]));
        }
        continue;
      }

      if (!entry.logFilePath) continue;

      scope.info(JSON.stringify({
        event: 'stall_poll',
        memberId,
        logPath: entry.logFilePath,
        lastActivityAt: entry.lastActivityAt,
      }));

      const { lastTimestamp, mtimeMs, error, pendingToolTimeoutMs } = await pollLogFile(memberId, entry.logFilePath);

      // apra-fleet: a pending tool_use's own declared timeout, when present,
      // overrides the generic idle threshold for THIS tick's stall check --
      // it is a hard, model-declared budget for a call already known to be
      // long-running (900000ms in one confirmed stall, 600000ms in another),
      // and the fleet watchdog must not fire before that budget elapses.
      const effectiveThresholdMs = pendingToolTimeoutMs
        ? pendingToolTimeoutMs + TOOL_TIMEOUT_GRACE_MS
        : stallThresholdMs;

      if (error) {
        const newFailures = entry.consecutiveReadFailures + 1;
        this.update(memberId, { consecutiveReadFailures: newFailures });
        if (newFailures >= 3) {
          logWarn('stall_read_failures', JSON.stringify({ memberId, error, consecutiveReadFailures: newFailures }));
        }
        // Do NOT count as stall cycle per resilience decision
        continue;
      }

      // apra-fleet-iuc.2: the file's own OS mtime is a format-agnostic
      // corroborating signal for "did this transcript advance," independent
      // of whether the content scan above could parse a timestamp out of it.
      // `mtimeMs` is `undefined`/`null` for every existing caller that mocks
      // pollLogFile without it, so this is a pure superset of the prior
      // behavior -- it can only turn a would-be false stall into recognized
      // activity, never the reverse.
      const mtimeAdvancedTo = (mtimeMs !== undefined && mtimeMs !== null && mtimeMs > entry.lastActivityAt)
        ? mtimeMs
        : null;

      if (lastTimestamp === null) {
        if (mtimeAdvancedTo !== null) {
          // apra-fleet-iuc.2: content parsing found nothing usable (unknown
          // format, mid-write truncation, etc.) but the file was genuinely
          // rewritten since our baseline -- that IS activity. Backstops
          // exactly the class of content-parsing gap fixed twice before
          // (apra-fleet-6z8.2, apra-fleet-979) without waiting for a third.
          this.update(memberId, {
            lastActivityAt: mtimeAdvancedTo,
            consecutiveIdleCycles: 0,
            consecutiveReadFailures: 0,
            stallReported: false,
          });
          writeStatusline(new Map([[memberId, `busy(${fmtElapsed(now - mtimeAdvancedTo)})`]]));
        }
        // Otherwise: file not yet created / no signal at all — do NOT count as stall cycle
        continue;
      }

      const ts = new Date(lastTimestamp).getTime();
      const contentAdvancedTo = (!isNaN(ts) && ts > entry.lastActivityAt) ? ts : null;
      if (contentAdvancedTo !== null || mtimeAdvancedTo !== null) {
        // Activity advanced — update and reset counters, then reflect fresh elapsed in statusline
        const advancedTo = Math.max(contentAdvancedTo ?? 0, mtimeAdvancedTo ?? 0);
        this.update(memberId, {
          lastActivityAt: advancedTo,
          consecutiveIdleCycles: 0,
          consecutiveReadFailures: 0,
          stallReported: false,
        });
        if (contentAdvancedTo !== null) {
          updateAgent(memberId, { lastLlmActivityAt: lastTimestamp });
        }
        writeStatusline(new Map([[memberId, `busy(${fmtElapsed(now - advancedTo)})`]]));
        continue;
      }

      // No new activity per EITHER signal — increment idle cycle counter and
      // check stall threshold. Requiring both the content scan and the
      // filesystem's own mtime to agree the transcript is frozen is what
      // makes this threshold check genuinely mtime-corroborated, not just a
      // content-parsing artifact.
      const newIdleCycles = entry.consecutiveIdleCycles + 1;
      this.update(memberId, {
        consecutiveIdleCycles: newIdleCycles,
        consecutiveReadFailures: 0,
      });

      if (now - entry.lastActivityAt > effectiveThresholdMs && !entry.stallReported) {
        const idleSecs = Math.floor((now - entry.lastActivityAt) / 1000);
        scope.warn(JSON.stringify({
          event: 'stall_detected',
          memberId,
          memberName: entry.memberName,
          idleSecs,
          provisional: false,
          pendingToolTimeoutMs: pendingToolTimeoutMs ?? null,
          effectiveThresholdMs,
          lastActivityAt: toLocalISOString(entry.lastActivityAt),
        }));
        writeStatusline(new Map([[memberId, 'unknown']]));
        this.update(memberId, { stallReported: true });
        entry.onStall?.();
      } else if (!entry.stallReported) {
        // Show steadily increasing elapsed time so PM can gauge staleness
        writeStatusline(new Map([[memberId, `busy(${fmtElapsed(now - entry.lastActivityAt)})`]]));
      }
    }
  }
}

// Singleton instance
let instance: StallDetector | null = null;

export function getStallDetector(): StallDetector {
  if (!instance) {
    instance = new StallDetector();
  }
  return instance;
}
