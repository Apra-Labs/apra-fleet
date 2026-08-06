import { updateAgent } from '../registry.js';
import { logLine, logWarn, LogScope } from '../../utils/log-helpers.js';
import { pollLogFile } from './stall-poller.js';
import { toLocalISOString, fmtElapsed } from './time-utils.js';
import { writeStatusline } from '../statusline.js';

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_STALL_THRESHOLD_MS = 120_000;

export interface StallEntry {
  sessionId: string | null;
  logFilePath: string | null;
  lastActivityAt: number;
  consecutiveIdleCycles: number;
  consecutiveReadFailures: number;
  memberId: string;
  memberName: string;
  provisional: boolean;
  stallReported: boolean;
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
        // Provisional: if logFilePath is available, check mtime to see if log writes have started
        if (entry.logFilePath) {
          try {
            const pollResult = await pollLogFile(memberId, entry.logFilePath);
            if (pollResult.mtimeMs && pollResult.mtimeMs > entry.lastActivityAt) {
              entry.lastActivityAt = pollResult.mtimeMs;
              entry.provisional = false;
            }
          } catch { /* best effort */ }
        }

        // Baseline timeout check for provisional entries
        if (now - entry.lastActivityAt > stallThresholdMs && !entry.stallReported) {
          const idleSecs = Math.floor((now - entry.lastActivityAt) / 1000);
          scope.warn(JSON.stringify({
            event: 'stall_detected',
            memberId,
            memberName: entry.memberName,
            idleSecs,
            provisional: true,
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

      const { lastTimestamp, mtimeMs, error } = await pollLogFile(memberId, entry.logFilePath);

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

      if (now - entry.lastActivityAt > stallThresholdMs && !entry.stallReported) {
        const idleSecs = Math.floor((now - entry.lastActivityAt) / 1000);
        scope.warn(JSON.stringify({
          event: 'stall_detected',
          memberId,
          memberName: entry.memberName,
          idleSecs,
          provisional: false,
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
