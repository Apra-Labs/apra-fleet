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
// apra-fleet PR#416 review (finding 4): hard ceiling on the effective stall
// threshold. Without it, a single absurd `input.timeout` in a tool_use block
// (the model writes that value into its own transcript, so it is untrusted
// input) disables stall detection for that entire duration -- a 86_400_000ms
// declaration would silence the watchdog for a day. 30 minutes sits
// comfortably above the largest real case that motivated the feature
// (900_000ms + grace = 960_000ms). Override with STALL_MAX_THRESHOLD_MS.
const MAX_STALL_THRESHOLD_MS = 1_800_000;
// apra-fleet-25yl.3: ceiling for the per-entry ADAPTIVE PROBE cadence (see
// the gate in _poll()). Without a ceiling, the 9000s production default
// threshold yields a 30-minute probe gap and a busy status up to 30 minutes
// stale. This bounds ONLY the live probe interval -- the shared setInterval
// loop's own cadence is unchanged by this feature.
const MAX_STALL_PROBE_INTERVAL_MS = 300_000;

/**
 * Resolve the per-tick effective stall threshold.
 *
 * `baselineMs` is orchestrator-authored (timeout_s / the generic
 * STALL_THRESHOLD_MS default) and is TRUSTED: it must never be capped by
 * MAX_STALL_THRESHOLD_MS, however large it is configured.
 *
 * A pending tool_use's own declared `input.timeout` is a useful hint that a
 * long-running call is legitimately in flight, but it is model-authored --
 * read straight out of the transcript's own tool_use.input.timeout -- and
 * must not be trusted as a raw control parameter:
 *
 *  - FLOOR: a small (or seconds-denominated -- `timeout: 30`) value would
 *    otherwise push the effective threshold BELOW the trusted baseline and
 *    make the watchdog fire earlier than it does with no declaration at all.
 *    The floor also neutralizes the seconds-vs-milliseconds unit ambiguity in
 *    `extractPendingToolTimeoutMs`.
 *  - CEILING: an enormous value would otherwise disable detection entirely.
 *    The ceiling bounds ONLY the untrusted pending-tool-timeout contribution,
 *    never the trusted baseline.
 *
 * Non-finite / NaN / negative / null / undefined inputs all degrade to the
 * baseline, which is the safe answer for an uninterpretable declaration.
 */
export function computeEffectiveThresholdMs(
  baselineMs: number,
  pendingToolTimeoutMs: number | null | undefined,
): number {
  const maxMs = parseInt(process.env['STALL_MAX_THRESHOLD_MS'] ?? String(MAX_STALL_THRESHOLD_MS));
  const ceilingMs = Number.isFinite(maxMs) ? maxMs : MAX_STALL_THRESHOLD_MS;
  const base = Number.isFinite(baselineMs) ? baselineMs : DEFAULT_STALL_THRESHOLD_MS;
  // No usable declaration -> the trusted baseline stands untouched, uncapped.
  // (Note this is deliberately NOT `(pendingToolTimeoutMs ?? 0) + GRACE`: that
  // form would silently raise the threshold to the grace period alone
  // whenever the baseline is configured below it, changing behavior for the
  // very common "no declared timeout" case.)
  if (typeof pendingToolTimeoutMs !== 'number' || !Number.isFinite(pendingToolTimeoutMs)) {
    return base;
  }
  // The untrusted pending-tool-timeout contribution is clamped into
  // [0, ceilingMs] BEFORE competing against the trusted baseline, so the
  // ceiling can never suppress a baseline that legitimately sits at or above
  // it.
  return Math.max(base, Math.min(pendingToolTimeoutMs + TOOL_TIMEOUT_GRACE_MS, ceilingMs));
}

/**
 * Which clamp (if any) actually determined the effective threshold, for
 * observability in the stall_detected log.
 *
 * Mirrors computeEffectiveThresholdMs's shape --
 * effective = max(base, min(raw, ceiling)) -- so it must report which term of
 * that max() won, not merely compare the final result against the raw
 * (uncapped) pending contribution. Comparing against raw alone is what made
 * the pre-fix version lie: once the trusted baseline can exceed the ceiling,
 * `effective < raw` no longer implies the ceiling determined the result --
 * the baseline can still be the one that won, even though the ceiling
 * capped the untrusted contribution internally along the way.
 *
 *  - 'floor': the trusted baseline is >= the (possibly ceiling-capped)
 *    pending contribution, so the baseline determined effectiveThresholdMs.
 *    This holds even at the knife-edge where the baseline happens to equal
 *    the raw (uncapped) pending value -- the ceiling still capped the
 *    pending contribution internally; it merely didn't end up mattering.
 *  - 'ceiling': the ceiling genuinely capped the pending contribution
 *    (min(raw, ceiling) < raw) AND that capped value still exceeds the
 *    baseline, so the ceiling determined effectiveThresholdMs.
 *  - null: no usable declaration, or the pending contribution passed
 *    through unclamped and still exceeded the baseline (effective === raw)
 *    -- neither clamp changed the outcome.
 */
export function describeClamp(
  baselineMs: number,
  pendingToolTimeoutMs: number | null | undefined,
  effectiveThresholdMs: number,
): 'floor' | 'ceiling' | null {
  // No usable declaration -> the baseline was used as-is; nothing was clamped.
  if (typeof pendingToolTimeoutMs !== 'number' || !Number.isFinite(pendingToolTimeoutMs)) return null;
  const maxMs = parseInt(process.env['STALL_MAX_THRESHOLD_MS'] ?? String(MAX_STALL_THRESHOLD_MS));
  const ceilingMs = Number.isFinite(maxMs) ? maxMs : MAX_STALL_THRESHOLD_MS;
  const base = Number.isFinite(baselineMs) ? baselineMs : DEFAULT_STALL_THRESHOLD_MS;
  const raw = pendingToolTimeoutMs + TOOL_TIMEOUT_GRACE_MS;
  const cappedPending = Math.min(raw, ceilingMs);
  if (base >= cappedPending) return 'floor';
  if (cappedPending < raw) return 'ceiling';
  return null;
}

export interface StallEntry {
  sessionId: string | null;
  logFilePath: string | null;
  lastActivityAt: number;
  consecutiveIdleCycles: number;
  consecutiveReadFailures: number;
  memberId: string;
  memberName: string;
  provisional: boolean;
  /**
   * apra-fleet-25yl.1: per-dispatch trusted baseline threshold (typically
   * derived from the orchestrator's own timeout_s), overriding the
   * process-wide STALL_THRESHOLD_MS default for this entry only. When unset,
   * falls back to the env/default baseline -- behaviour for callers that set
   * nothing is unchanged.
   */
  thresholdMs?: number;
  /**
   * apra-fleet-25yl.3: wall-clock time (Date.now()) of the last tick on
   * which a LIVE probe (pollLogFile / pollDirectoryActivity) was actually
   * issued for this entry, as opposed to a tick that was gated out by the
   * adaptive cadence check in _poll(). `undefined` means "never probed
   * yet" -- the gate always treats that as due, so a freshly added entry is
   * probed on its very first tick regardless of its threshold.
   */
  lastPolledAt?: number;
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
    // apra-fleet-25yl.1: env/default baseline is now only the FALLBACK for
    // entries that carry no per-dispatch thresholdMs of their own -- resolved
    // per entry below, not once per tick.
    const fallbackThresholdMs = parseInt(process.env['STALL_THRESHOLD_MS'] ?? String(DEFAULT_STALL_THRESHOLD_MS));
    // apra-fleet-25yl.3 AMENDMENT: the adaptive probe cadence's FLOOR is the
    // loop's own tick interval -- the same resolved value start()'s
    // setInterval uses (STALL_POLL_INTERVAL_MS ?? DEFAULT_POLL_INTERVAL_MS) --
    // not an independent constant. A separate, smaller floor would make
    // short-threshold entries poll MORE often than today's fixed cadence,
    // the opposite of this feature's goal. Resolved once per tick, mirroring
    // the other STALL_* env overrides above, so an env override of the tick
    // interval moves the floor with it.
    const parsedTickIntervalMs = parseInt(process.env['STALL_POLL_INTERVAL_MS'] ?? String(DEFAULT_POLL_INTERVAL_MS));
    const tickIntervalMs = Number.isFinite(parsedTickIntervalMs) ? parsedTickIntervalMs : DEFAULT_POLL_INTERVAL_MS;

    for (const [memberId, entry] of this.stallCheckList.entries()) {
      const stallThresholdMs = entry.thresholdMs ?? fallbackThresholdMs;

      // apra-fleet-25yl.3: adaptive per-entry probe cadence. An entry with a
      // large effective threshold (e.g. a long timeout_s dispatch) does not
      // need a LIVE probe on every tick; gate the live probe call itself
      // (pollLogFile / pollDirectoryActivity, issued just below in each
      // branch) on clamp(tickIntervalMs, stallThresholdMs/5, 300_000ms):
      // never less often than the loop's own tick (the floor), and never
      // more than 5 minutes apart even for the largest trusted threshold
      // (the ceiling). This gates ONLY the live probe -- the shared
      // setInterval loop and its cadence/unref behaviour are untouched. A
      // skipped tick is simply not evidence in either direction: it must
      // never increment consecutiveIdleCycles/consecutiveReadFailures, and
      // must never itself be read as activity or as a stall. Detection stays
      // bounded to roughly one probe interval past the entry's threshold
      // because the stall check further down only runs on ticks that DO
      // probe -- it is never evaluated against stale data on a skipped tick.
      //
      // apra-fleet-25yl.4: the floor (tickIntervalMs) MUST win over the
      // ceiling (MAX_STALL_PROBE_INTERVAL_MS) -- the invariant that the probe
      // interval never falls below the loop's own tick interval is
      // non-negotiable, since a value below it would make the gate fire on
      // every tick, defeating the point of the cadence. Clamping
      // stallThresholdMs/5 to the ceiling FIRST, then flooring the result at
      // tickIntervalMs, gives exactly that precedence: when
      // STALL_POLL_INTERVAL_MS is overridden above the 300_000ms ceiling, the
      // tick interval still wins. (The old min(ceiling, max(tick, s/5)) order
      // let the ceiling win instead, yielding a probe interval BELOW the tick
      // interval whenever the tick interval itself exceeded the ceiling.)
      // Behaviourally identical to the old formula whenever tickIntervalMs
      // <= MAX_STALL_PROBE_INTERVAL_MS (the normal case).
      const probeIntervalMs = Math.max(
        tickIntervalMs,
        Math.min(MAX_STALL_PROBE_INTERVAL_MS, stallThresholdMs / 5),
      );
      const dueForProbe = entry.lastPolledAt === undefined || (now - entry.lastPolledAt) >= probeIntervalMs;
      if (!dueForProbe) {
        if (!entry.stallReported) {
          writeStatusline(new Map([[memberId, `busy(${fmtElapsed(now - entry.lastActivityAt)})`]]));
        }
        continue;
      }
      entry.lastPolledAt = now;

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
        // Uncapped trusted floor, untrusted contribution capped into
        // [0, ceiling] -- see computeEffectiveThresholdMs.
        const provisionalEffectiveThresholdMs = computeEffectiveThresholdMs(
          stallThresholdMs,
          provisionalPendingToolTimeoutMs,
        );
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
            clamped: describeClamp(stallThresholdMs, provisionalPendingToolTimeoutMs, provisionalEffectiveThresholdMs),
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
      // Uncapped trusted floor, untrusted contribution capped into
      // [0, ceiling] -- see computeEffectiveThresholdMs.
      const effectiveThresholdMs = computeEffectiveThresholdMs(stallThresholdMs, pendingToolTimeoutMs);

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
          clamped: describeClamp(stallThresholdMs, pendingToolTimeoutMs, effectiveThresholdMs),
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
