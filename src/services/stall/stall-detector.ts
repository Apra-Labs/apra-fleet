import { updateAgent } from '../registry.js';
import { logLine, logWarn } from '../../utils/log-helpers.js';
import { pollLogFile } from './stall-poller.js';
import { toLocalISOString } from './time-utils.js';

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
    logLine('stall_poll_tick', JSON.stringify({
      activeWatched: this.stallCheckList.size,
      provisional: [...this.stallCheckList.values()].filter(e => e.provisional).length,
      members: [...this.stallCheckList.values()].map(e => e.memberName),
    }));

    const now = Date.now();
    const stallThresholdMs = parseInt(process.env['STALL_THRESHOLD_MS'] ?? String(DEFAULT_STALL_THRESHOLD_MS));

    for (const [memberId, entry] of this.stallCheckList.entries()) {
      if (entry.provisional) {
        // Provisional: skip log reading, but still detect stalls via baseline timeout
        if (now - entry.lastActivityAt > stallThresholdMs && !entry.stallReported) {
          const idleSecs = Math.floor((now - entry.lastActivityAt) / 1000);
          logLine('stall_detected', JSON.stringify({
            event: 'stall_detected',
            memberId,
            memberName: entry.memberName,
            idleSecs,
            lastActivityAt: toLocalISOString(entry.lastActivityAt),
          }));
          this.update(memberId, { stallReported: true });
        }
        continue;
      }

      if (!entry.logFilePath) continue;

      logLine('stall_poll', JSON.stringify({
        event: 'stall_poll',
        memberId,
        logPath: entry.logFilePath,
        lastActivityAt: entry.lastActivityAt,
      }));

      const { lastTimestamp, error } = await pollLogFile(memberId, entry.logFilePath);

      if (error) {
        const newFailures = entry.consecutiveReadFailures + 1;
        this.update(memberId, { consecutiveReadFailures: newFailures });
        if (newFailures >= 3) {
          logWarn('stall_read_failures', JSON.stringify({ memberId, error, consecutiveReadFailures: newFailures }));
        }
        // Do NOT count as stall cycle per resilience decision
        continue;
      }

      if (lastTimestamp === null) {
        // File not yet created — do NOT count as stall cycle per resilience decision
        continue;
      }

      const ts = new Date(lastTimestamp).getTime();
      if (!isNaN(ts) && ts > entry.lastActivityAt) {
        // Activity advanced — update and reset counters
        this.update(memberId, {
          lastActivityAt: ts,
          consecutiveIdleCycles: 0,
          consecutiveReadFailures: 0,
          stallReported: false,
        });
        updateAgent(memberId, { lastLlmActivityAt: lastTimestamp });
        continue;
      }

      // No new activity — increment idle cycle counter and check stall threshold
      const newIdleCycles = entry.consecutiveIdleCycles + 1;
      this.update(memberId, {
        consecutiveIdleCycles: newIdleCycles,
        consecutiveReadFailures: 0,
      });

      if (now - entry.lastActivityAt > stallThresholdMs && !entry.stallReported) {
        const idleSecs = Math.floor((now - entry.lastActivityAt) / 1000);
        logLine('stall_detected', JSON.stringify({
          event: 'stall_detected',
          memberId,
          memberName: entry.memberName,
          idleSecs,
          lastActivityAt: toLocalISOString(entry.lastActivityAt),
        }));
        this.update(memberId, { stallReported: true });
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
