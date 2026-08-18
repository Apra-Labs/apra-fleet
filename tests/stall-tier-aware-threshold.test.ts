/**
 * apra-fleet-rmkb-ch5 -- pins the tier-aware stall threshold end to end
 * (StallDetector + the execute_prompt tier-to-threshold mapping helper) with
 * fake timers and mocked pollers. No test in this file requires a live
 * member or a real dispatch; on-hardware confirmation that a premium
 * dispatch survives a genuine multi-minute reasoning gap is tracked by the
 * parent bug bead (rmkb-ch5).
 *
 * Fixture setup is modeled on tests/stall-detector.test.ts (fake timers +
 * mocked pollLogFile) and tests/stall-no-signal-false-kill.test.ts (the
 * no-signal/provisional path).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockPollLogFile, mockPollDirectoryActivity, mockUpdateAgent, mockLogLine, mockLogWarn, mockScopeWarn } = vi.hoisted(() => ({
  mockPollLogFile: vi.fn(),
  mockPollDirectoryActivity: vi.fn(),
  mockUpdateAgent: vi.fn(),
  mockLogLine: vi.fn(),
  mockLogWarn: vi.fn(),
  mockScopeWarn: vi.fn(),
}));

vi.mock('../src/services/stall/stall-poller.js', () => ({
  pollLogFile: mockPollLogFile,
  pollDirectoryActivity: mockPollDirectoryActivity,
}));

vi.mock('../src/services/registry.js', () => ({
  updateAgent: mockUpdateAgent,
}));

vi.mock('../src/utils/log-helpers.js', () => ({
  logLine: mockLogLine,
  logWarn: mockLogWarn,
  LogScope: class {
    constructor(_tag: string, _msg: string) {}
    getInv() { return 'test'; }
    info(_msg: string) {}
    warn(msg: string) { mockScopeWarn(msg); }
    error(_msg: string) {}
    ok(_msg?: string) {}
    fail(_msg: string) {}
    abort(_msg: string) {}
  },
}));

import {
  StallDetector,
  type StallEntry,
  STALL_THRESHOLD_MS_BY_TIER,
  resolveStallThresholdForModel,
} from '../src/services/stall/stall-detector.js';

const PREMIUM_MS = STALL_THRESHOLD_MS_BY_TIER.premium; // 600_000
const DEFAULT_MS = STALL_THRESHOLD_MS_BY_TIER.standard; // 120_000

function makeEntry(overrides: Partial<StallEntry> = {}): StallEntry {
  return {
    sessionId: 'session-abc',
    logFilePath: '/home/user/.claude/projects/project/session-abc.jsonl',
    lastActivityAt: Date.now(),
    consecutiveIdleCycles: 0,
    consecutiveReadFailures: 0,
    memberId: 'member-1',
    memberName: 'alice',
    provisional: false,
    stallReported: false,
    ...overrides,
  };
}

function stallDetectedCalls() {
  return mockScopeWarn.mock.calls.filter((c: string[]) => {
    try { return JSON.parse(c[0]).event === 'stall_detected'; } catch { return false; }
  });
}

describe('tier-aware stall threshold (rmkb-ch5)', () => {
  let detector: StallDetector;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    detector = new StallDetector();
    delete process.env['STALL_THRESHOLD_MS'];
  });

  afterEach(() => {
    detector.stop();
    vi.useRealTimers();
    delete process.env['STALL_THRESHOLD_MS'];
  });

  describe('a long reasoning gap under the premium threshold is not a stall (regression pin)', () => {
    it('a premium-threshold entry idle 5 minutes emits no stall_detected and does not call onStall', async () => {
      const onStall = vi.fn();
      const pastTime = Date.now() - 5 * 60_000; // 5 minutes ago -- past the 120s default, well under the 600s premium threshold
      detector.add('member-1', makeEntry({
        lastActivityAt: pastTime,
        stallThresholdMs: PREMIUM_MS,
        onStall,
      }));
      mockPollLogFile.mockResolvedValue({ lastTimestamp: new Date(pastTime - 1000).toISOString() });

      await detector._poll();

      expect(stallDetectedCalls()).toHaveLength(0);
      expect(onStall).not.toHaveBeenCalled();
    });
  });

  describe('a genuine hang past the premium threshold is still killed', () => {
    it('a premium-threshold entry idle past 600s emits stall_detected and calls onStall exactly once', async () => {
      const onStall = vi.fn();
      const pastTime = Date.now() - (PREMIUM_MS + 30_000); // past the premium threshold
      detector.add('member-1', makeEntry({
        lastActivityAt: pastTime,
        stallThresholdMs: PREMIUM_MS,
        onStall,
      }));
      mockPollLogFile.mockResolvedValue({ lastTimestamp: new Date(pastTime - 1000).toISOString() });

      await detector._poll();
      // Second poll must not re-fire (stallReported latch), still exactly once total.
      await detector._poll();

      expect(stallDetectedCalls()).toHaveLength(1);
      expect(onStall).toHaveBeenCalledTimes(1);
    });
  });

  describe('non-premium entries are unchanged', () => {
    it('an entry with no per-entry threshold still fires at the 120s default', async () => {
      const onStall = vi.fn();
      const pastTime = Date.now() - (DEFAULT_MS + 5_000);
      detector.add('member-1', makeEntry({ lastActivityAt: pastTime, onStall }));
      mockPollLogFile.mockResolvedValue({ lastTimestamp: new Date(pastTime - 1000).toISOString() });

      await detector._poll();

      expect(stallDetectedCalls()).toHaveLength(1);
      expect(onStall).toHaveBeenCalledTimes(1);
    });
  });

  describe('resolution order: env STALL_THRESHOLD_MS wins over the per-entry threshold', () => {
    it('env shorter than the per-entry threshold fires early', async () => {
      process.env['STALL_THRESHOLD_MS'] = '5000'; // 5s -- much shorter than the premium 600s
      const onStall = vi.fn();
      const pastTime = Date.now() - 10_000; // 10s idle: past env (5s), nowhere near premium (600s)
      detector.add('member-1', makeEntry({
        lastActivityAt: pastTime,
        stallThresholdMs: PREMIUM_MS,
        onStall,
      }));
      mockPollLogFile.mockResolvedValue({ lastTimestamp: new Date(pastTime - 1000).toISOString() });

      await detector._poll();

      expect(stallDetectedCalls()).toHaveLength(1);
      expect(onStall).toHaveBeenCalledTimes(1);
    });

    it('env longer than the per-entry threshold suppresses the kill', async () => {
      process.env['STALL_THRESHOLD_MS'] = String(PREMIUM_MS * 2); // much longer than default
      const onStall = vi.fn();
      const pastTime = Date.now() - (DEFAULT_MS + 5_000); // would fire at the 120s default, but not at env's threshold
      detector.add('member-1', makeEntry({
        lastActivityAt: pastTime,
        stallThresholdMs: DEFAULT_MS,
        onStall,
      }));
      mockPollLogFile.mockResolvedValue({ lastTimestamp: new Date(pastTime - 1000).toISOString() });

      await detector._poll();

      expect(stallDetectedCalls()).toHaveLength(0);
      expect(onStall).not.toHaveBeenCalled();
    });
  });

  describe('all three comparison sites honor the per-entry threshold', () => {
    it('provisional baseline kill uses the per-entry threshold', async () => {
      const onStall = vi.fn();
      mockPollDirectoryActivity.mockResolvedValue({ mtimeMs: null, signalAvailable: true });
      const pastTime = Date.now() - 5 * 60_000; // 5 min: past default, under premium
      detector.add('member-1', makeEntry({
        provisional: true,
        logFilePath: null,
        lastActivityAt: pastTime,
        stallThresholdMs: PREMIUM_MS,
        onStall,
      }));

      await detector._poll();

      expect(stallDetectedCalls()).toHaveLength(0);
      expect(onStall).not.toHaveBeenCalled();
    });

    it('log-file kill uses the per-entry threshold', async () => {
      const onStall = vi.fn();
      const pastTime = Date.now() - 5 * 60_000; // 5 min: past default, under premium
      detector.add('member-1', makeEntry({
        provisional: false,
        lastActivityAt: pastTime,
        stallThresholdMs: PREMIUM_MS,
        onStall,
      }));
      // No new activity signal by either content timestamp or mtime.
      mockPollLogFile.mockResolvedValue({ lastTimestamp: new Date(pastTime - 1000).toISOString() });

      await detector._poll();

      expect(stallDetectedCalls()).toHaveLength(0);
      expect(onStall).not.toHaveBeenCalled();
    });

    it('no-signal warning uses the per-entry threshold', async () => {
      const onStall = vi.fn();
      mockPollDirectoryActivity.mockResolvedValue({ mtimeMs: null, signalAvailable: false });
      const pastTime = Date.now() - 5 * 60_000; // 5 min: past default, under premium -- must NOT warn yet
      detector.add('member-1', makeEntry({
        provisional: true,
        logFilePath: null,
        lastActivityAt: pastTime,
        stallThresholdMs: PREMIUM_MS,
        onStall,
      }));

      await detector._poll();

      const noSignalWarns = mockLogWarn.mock.calls.filter((c: string[]) => c[0] === 'stall_no_signal');
      expect(noSignalWarns).toHaveLength(0);
      expect(onStall).not.toHaveBeenCalled();
    });
  });

  describe('tier-to-threshold mapping used by execute_prompt (resolveStallThresholdForModel)', () => {
    it('maps premium to the long (600s) threshold', () => {
      expect(resolveStallThresholdForModel('premium')).toBe(PREMIUM_MS);
    });

    it('maps cheap to the 120s default', () => {
      expect(resolveStallThresholdForModel('cheap')).toBe(DEFAULT_MS);
    });

    it('maps standard to the 120s default', () => {
      expect(resolveStallThresholdForModel('standard')).toBe(DEFAULT_MS);
    });

    it('maps an omitted model to the 120s default', () => {
      expect(resolveStallThresholdForModel(undefined)).toBe(DEFAULT_MS);
    });

    it('maps an unrecognized/specific model id to the 120s default, never undefined or NaN', () => {
      const result = resolveStallThresholdForModel('claude-opus-4-20250514');
      expect(result).toBe(DEFAULT_MS);
      expect(result).not.toBeUndefined();
      expect(Number.isNaN(result)).toBe(false);
    });
  });
});
