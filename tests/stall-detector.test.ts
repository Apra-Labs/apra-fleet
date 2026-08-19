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
  computeEffectiveThresholdMs,
  describeClamp,
  type StallEntry,
} from '../src/services/stall/stall-detector.js';

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

describe('StallDetector', () => {
  let detector: StallDetector;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    detector = new StallDetector();
    delete process.env['STALL_POLL_INTERVAL_MS'];
    delete process.env['STALL_THRESHOLD_MS'];
  });

  afterEach(() => {
    detector.stop();
    vi.useRealTimers();
    delete process.env['STALL_POLL_INTERVAL_MS'];
    delete process.env['STALL_THRESHOLD_MS'];
  });

  describe('add / remove / getEntry', () => {
    it('adds an entry', () => {
      const entry = makeEntry({ memberId: 'member-1' });
      detector.add('member-1', entry);
      expect(detector.getEntry('member-1')).toEqual(entry);
    });

    it('removes an entry', () => {
      detector.add('member-1', makeEntry());
      detector.remove('member-1');
      expect(detector.getEntry('member-1')).toBeUndefined();
    });

    it('double-remove is idempotent — no error', () => {
      detector.add('member-1', makeEntry());
      detector.remove('member-1');
      expect(() => detector.remove('member-1')).not.toThrow();
      expect(detector.getEntry('member-1')).toBeUndefined();
    });

    it('add logs warning on overwrite', () => {
      detector.add('member-1', makeEntry());
      detector.add('member-1', makeEntry());
      expect(mockLogWarn).toHaveBeenCalledWith(
        'stall_detector',
        expect.stringContaining('member-1')
      );
    });

    it('update merges partial fields', () => {
      const entry = makeEntry({ memberId: 'member-1', consecutiveIdleCycles: 0 });
      detector.add('member-1', entry);
      detector.update('member-1', { consecutiveIdleCycles: 3 });
      expect(detector.getEntry('member-1')?.consecutiveIdleCycles).toBe(3);
    });

    it('update on non-existent entry logs warning', () => {
      detector.update('nonexistent', { consecutiveIdleCycles: 1 });
      expect(mockLogWarn).toHaveBeenCalledWith(
        'stall_detector',
        expect.stringContaining('nonexistent')
      );
    });
  });

  describe('start / stop lifecycle', () => {
    it('start sets interval', () => {
      const spy = vi.spyOn(global, 'setInterval');
      detector.start();
      expect(spy).toHaveBeenCalled();
    });

    it('start twice logs warning', () => {
      detector.start();
      detector.start();
      expect(mockLogWarn).toHaveBeenCalledWith('stall_detector', expect.stringContaining('Already started'));
    });

    it('stop clears interval and stallCheckList', () => {
      detector.add('member-1', makeEntry());
      detector.start();
      detector.stop();
      expect(detector.stallCheckList.size).toBe(0);
    });
  });

  describe('_poll — activity advancing (no stall)', () => {
    it('updates lastActivityAt and calls updateAgent when timestamp advances', async () => {
      const baseTime = Date.now();
      const entry = makeEntry({ lastActivityAt: baseTime });
      detector.add('member-1', entry);

      const newTimestamp = new Date(baseTime + 5000).toISOString();
      mockPollLogFile.mockResolvedValue({ lastTimestamp: newTimestamp });

      await detector._poll();

      const updated = detector.getEntry('member-1');
      expect(updated?.lastActivityAt).toBe(new Date(newTimestamp).getTime());
      expect(updated?.consecutiveIdleCycles).toBe(0);
      expect(mockUpdateAgent).toHaveBeenCalledWith('member-1', { lastLlmActivityAt: newTimestamp });
    });

    it('does not emit stall_detected when activity advances', async () => {
      const baseTime = Date.now();
      detector.add('member-1', makeEntry({ lastActivityAt: baseTime }));
      mockPollLogFile.mockResolvedValue({ lastTimestamp: new Date(baseTime + 1000).toISOString() });

      await detector._poll();

      const stallCalls = mockLogLine.mock.calls.filter((c: string[]) => c[0] === 'stall_detected');
      expect(stallCalls).toHaveLength(0);
    });
  });

  describe('_poll — stale timestamp (stall fires)', () => {
    it('emits stall_detected after STALL_THRESHOLD_MS of no activity', async () => {
      process.env['STALL_THRESHOLD_MS'] = '5000';
      const pastTime = Date.now() - 10_000; // 10s ago
      const entry = makeEntry({ lastActivityAt: pastTime });
      detector.add('member-1', entry);

      // Timestamp is older than lastActivityAt — no new activity
      const oldTimestamp = new Date(pastTime - 1000).toISOString();
      mockPollLogFile.mockResolvedValue({ lastTimestamp: oldTimestamp });

      await detector._poll();

      const stallCalls = mockScopeWarn.mock.calls.filter((c: string[]) => {
        try { return JSON.parse(c[0]).event === 'stall_detected'; } catch { return false; }
      });
      expect(stallCalls).toHaveLength(1);
      const logged = JSON.parse(stallCalls[0][0] as string);
      expect(logged.event).toBe('stall_detected');
      expect(logged.memberId).toBe('member-1');
      expect(logged.memberName).toBe('alice');
      expect(logged.idleSecs).toBeGreaterThanOrEqual(10);
    });

    it('increments consecutiveIdleCycles when timestamp is stale', async () => {
      const pastTime = Date.now() - 200;
      detector.add('member-1', makeEntry({ lastActivityAt: pastTime }));
      mockPollLogFile.mockResolvedValue({ lastTimestamp: new Date(pastTime - 1000).toISOString() });

      await detector._poll();

      expect(detector.getEntry('member-1')?.consecutiveIdleCycles).toBe(1);
    });
  });

  describe('_poll — pending tool_use timeout overrides the idle threshold', () => {
    // apra-fleet: reproduces confirmed stall site d2e30668 (fleet-win-dev1,
    // sprint apra-fleet-ivxi/u1qw/69pp) -- the pending Bash tool_use had
    // declared an explicit 900000ms budget. Idle past the generic
    // STALL_THRESHOLD_MS (5s here) must NOT fire a stall while still inside
    // that declared budget + grace.
    it('does not stall while idle time is within the pending tool_use timeout + grace', async () => {
      process.env['STALL_THRESHOLD_MS'] = '5000';
      const pastTime = Date.now() - 10_000; // 10s idle -- past the 5s generic threshold
      detector.add('member-1', makeEntry({ lastActivityAt: pastTime }));
      mockPollLogFile.mockResolvedValue({
        lastTimestamp: new Date(pastTime - 1000).toISOString(),
        pendingToolTimeoutMs: 900_000,
      });

      await detector._poll();

      const stallCalls = mockScopeWarn.mock.calls.filter((c: string[]) => {
        try { return JSON.parse(c[0]).event === 'stall_detected'; } catch { return false; }
      });
      expect(stallCalls).toHaveLength(0);
    });

    it('stalls once idle time exceeds the pending tool_use timeout + grace', async () => {
      process.env['STALL_THRESHOLD_MS'] = '5000';
      // 900_000ms declared timeout + 60_000ms grace = 960_000ms effective threshold.
      const pastTime = Date.now() - 961_000;
      detector.add('member-1', makeEntry({ lastActivityAt: pastTime }));
      mockPollLogFile.mockResolvedValue({
        lastTimestamp: new Date(pastTime - 1000).toISOString(),
        pendingToolTimeoutMs: 900_000,
      });

      await detector._poll();

      const stallCalls = mockScopeWarn.mock.calls.filter((c: string[]) => {
        try { return JSON.parse(c[0]).event === 'stall_detected'; } catch { return false; }
      });
      expect(stallCalls).toHaveLength(1);
      const logged = JSON.parse(stallCalls[0][0] as string);
      expect(logged.pendingToolTimeoutMs).toBe(900_000);
      expect(logged.effectiveThresholdMs).toBe(960_000);
    });

    // apra-fleet: confirmed stall site 963a1740 -- 600000ms declared budget.
    it('honors a different declared timeout (600000ms) from another real stall site', async () => {
      process.env['STALL_THRESHOLD_MS'] = '5000';
      const pastTime = Date.now() - 600_000; // well past the generic threshold, still inside 600s+grace
      detector.add('member-1', makeEntry({ lastActivityAt: pastTime }));
      mockPollLogFile.mockResolvedValue({
        lastTimestamp: new Date(pastTime - 1000).toISOString(),
        pendingToolTimeoutMs: 600_000,
      });

      await detector._poll();

      const stallCalls = mockScopeWarn.mock.calls.filter((c: string[]) => {
        try { return JSON.parse(c[0]).event === 'stall_detected'; } catch { return false; }
      });
      expect(stallCalls).toHaveLength(0);
    });

    it('falls back to the generic STALL_THRESHOLD_MS when no tool_use is pending', async () => {
      process.env['STALL_THRESHOLD_MS'] = '5000';
      const pastTime = Date.now() - 10_000;
      detector.add('member-1', makeEntry({ lastActivityAt: pastTime }));
      mockPollLogFile.mockResolvedValue({
        lastTimestamp: new Date(pastTime - 1000).toISOString(),
        pendingToolTimeoutMs: null,
      });

      await detector._poll();

      const stallCalls = mockScopeWarn.mock.calls.filter((c: string[]) => {
        try { return JSON.parse(c[0]).event === 'stall_detected'; } catch { return false; }
      });
      expect(stallCalls).toHaveLength(1);
    });
  });

  describe('_poll — missing log file (no false stall)', () => {
    it('does not count as stall cycle when file not yet created', async () => {
      process.env['STALL_THRESHOLD_MS'] = '5000';
      const baseTime = Date.now() - 10_000;
      detector.add('member-1', makeEntry({ lastActivityAt: baseTime, consecutiveIdleCycles: 0 }));
      mockPollLogFile.mockResolvedValue({ lastTimestamp: null }); // no error field = file not found

      await detector._poll();

      expect(detector.getEntry('member-1')?.consecutiveIdleCycles).toBe(0);
      const stallCalls = mockLogLine.mock.calls.filter((c: string[]) => c[0] === 'stall_detected');
      expect(stallCalls).toHaveLength(0);
    });
  });

  describe('_poll — read failure (no false stall)', () => {
    it('increments consecutiveReadFailures on error, does not count as stall cycle', async () => {
      process.env['STALL_THRESHOLD_MS'] = '5000';
      const baseTime = Date.now() - 10_000;
      detector.add('member-1', makeEntry({ lastActivityAt: baseTime }));
      mockPollLogFile.mockResolvedValue({ lastTimestamp: null, error: 'Connection refused' });

      await detector._poll();

      expect(detector.getEntry('member-1')?.consecutiveReadFailures).toBe(1);
      const stallCalls = mockLogLine.mock.calls.filter((c: string[]) => c[0] === 'stall_detected');
      expect(stallCalls).toHaveLength(0);
    });

    it('logs warning after 3 consecutive read failures', async () => {
      const baseTime = Date.now() - 10_000;
      detector.add('member-1', makeEntry({ lastActivityAt: baseTime, consecutiveReadFailures: 2 }));
      mockPollLogFile.mockResolvedValue({ lastTimestamp: null, error: 'Timeout' });

      await detector._poll();

      expect(mockLogWarn).toHaveBeenCalledWith(
        'stall_read_failures',
        expect.stringContaining('member-1')
      );
    });
  });

  describe('_poll — provisional entries', () => {
    it('skips log reading for provisional entries', async () => {
      detector.add('member-1', makeEntry({ provisional: true, logFilePath: null }));
      await detector._poll();
      expect(mockPollLogFile).not.toHaveBeenCalled();
    });

    it('emits stall_detected for provisional entry exceeding threshold', async () => {
      process.env['STALL_THRESHOLD_MS'] = '5000';
      const pastTime = Date.now() - 10_000;
      // A pollable log directory exists (signal IS available) but nothing in it
      // advanced -- that is a genuine, evidence-backed stall.
      mockPollDirectoryActivity.mockResolvedValue({ mtimeMs: null, signalAvailable: true });
      detector.add('member-1', makeEntry({ provisional: true, logFilePath: null, lastActivityAt: pastTime }));

      await detector._poll();

      const stallCalls = mockScopeWarn.mock.calls.filter((c: string[]) => {
        try { return JSON.parse(c[0]).event === 'stall_detected'; } catch { return false; }
      });
      expect(stallCalls).toHaveLength(1);
    });

    // apra-fleet-ivxi.8: the provisional branch (a member that hasn't yet
    // produced any real log activity) must honor a pending tool_use's
    // declared timeout exactly like the non-provisional path does -- a
    // provisional entry stuck behind a genuinely long-running tool call
    // should not be killed mid-budget just because it never left the
    // provisional state.
    it('does not stall a provisional entry at the generic 150s threshold while inside its pending tool_use budget', async () => {
      delete process.env['STALL_THRESHOLD_MS']; // exercise the real 150s default
      const pastTime = Date.now() - 160_000; // idle 160s -- past the 150s default, well inside 600s+grace
      const onStall = vi.fn();
      mockPollLogFile.mockResolvedValue({
        lastTimestamp: null,
        mtimeMs: null,
        pendingToolTimeoutMs: 600_000,
      });
      detector.add('member-1', makeEntry({ provisional: true, lastActivityAt: pastTime, onStall }));

      await detector._poll();

      expect(onStall).not.toHaveBeenCalled();
      const stallCalls = mockScopeWarn.mock.calls.filter((c: string[]) => {
        try { return JSON.parse(c[0]).event === 'stall_detected'; } catch { return false; }
      });
      expect(stallCalls).toHaveLength(0);
    });

    it('stalls a provisional entry once idle time exceeds its own pending tool_use timeout + grace', async () => {
      delete process.env['STALL_THRESHOLD_MS'];
      // 600_000ms declared timeout + 60_000ms grace = 660_000ms effective threshold.
      const pastTime = Date.now() - 661_000;
      const onStall = vi.fn();
      mockPollLogFile.mockResolvedValue({
        lastTimestamp: null,
        mtimeMs: null,
        pendingToolTimeoutMs: 600_000,
      });
      detector.add('member-1', makeEntry({ provisional: true, lastActivityAt: pastTime, onStall }));

      await detector._poll();

      expect(onStall).toHaveBeenCalledTimes(1);
      const stallCalls = mockScopeWarn.mock.calls.filter((c: string[]) => {
        try { return JSON.parse(c[0]).event === 'stall_detected'; } catch { return false; }
      });
      expect(stallCalls).toHaveLength(1);
      const logged = JSON.parse(stallCalls[0][0] as string);
      expect(logged.pendingToolTimeoutMs).toBe(600_000);
      expect(logged.effectiveThresholdMs).toBe(660_000);
    });
  });

  /**
   * apra-fleet issue #390 / apra-fleet-igoe -- "no signal available" is the
   * ABSENCE of evidence, not evidence of a stall.
   *
   * For codex/copilot/none, resolveSessionLogDir returns null unconditionally,
   * so pollDirectoryActivity can never produce a positive signal. Every such
   * dispatch's lastActivityAt stayed frozen at dispatch start, crossed the
   * 120s threshold, and got killed by onStall() -- mid-progress, every time.
   * The same happened to remote AGY/OpenCode members whose log directory could
   * not be resolved at all (unknown member home dir).
   */
  describe('_poll — no-signal providers are never killed by the stall detector', () => {
    const stallDetectedCalls = () => mockScopeWarn.mock.calls.filter((c: string[]) => {
      try { return JSON.parse(c[0]).event === 'stall_detected'; } catch { return false; }
    });

    it('does NOT invoke onStall for a long-running dispatch when no signal mechanism exists', async () => {
      process.env['STALL_THRESHOLD_MS'] = '5000';
      mockPollDirectoryActivity.mockResolvedValue({ mtimeMs: null, signalAvailable: false });
      const onStall = vi.fn();
      // 10x past the threshold, and still going.
      detector.add('member-1', makeEntry({
        provisional: true,
        logFilePath: null,
        lastActivityAt: Date.now() - 50_000,
        onStall,
      }));

      await detector._poll();
      await detector._poll();
      await detector._poll();

      expect(onStall).not.toHaveBeenCalled();
      expect(stallDetectedCalls()).toHaveLength(0);
      // It is still reported, once, as a diagnostic -- silence would be worse.
      const noSignalWarns = mockLogWarn.mock.calls.filter((c: string[]) => c[0] === 'stall_no_signal');
      expect(noSignalWarns).toHaveLength(1);
      expect(noSignalWarns[0]![1]).toContain('member-1');
    });

    it('DOES invoke onStall when a signal mechanism exists but the signal is frozen', async () => {
      process.env['STALL_THRESHOLD_MS'] = '5000';
      mockPollDirectoryActivity.mockResolvedValue({ mtimeMs: null, signalAvailable: true });
      const onStall = vi.fn();
      detector.add('member-1', makeEntry({
        provisional: true,
        logFilePath: null,
        lastActivityAt: Date.now() - 50_000,
        onStall,
      }));

      await detector._poll();

      expect(onStall).toHaveBeenCalledTimes(1);
      expect(stallDetectedCalls()).toHaveLength(1);
    });

    it('still tracks real directory activity when a signal mechanism exists', async () => {
      process.env['STALL_THRESHOLD_MS'] = '5000';
      const fresh = Date.now();
      mockPollDirectoryActivity.mockResolvedValue({ mtimeMs: fresh, signalAvailable: true });
      const onStall = vi.fn();
      detector.add('member-1', makeEntry({
        provisional: true,
        logFilePath: null,
        lastActivityAt: Date.now() - 50_000,
        onStall,
      }));

      await detector._poll();

      expect(onStall).not.toHaveBeenCalled();
      expect(detector.getEntry('member-1')?.lastActivityAt).toBe(fresh);
    });

    it('falls back to kill-capable behavior if the poller itself blows up (fail-closed)', async () => {
      process.env['STALL_THRESHOLD_MS'] = '5000';
      mockPollDirectoryActivity.mockRejectedValue(new Error('poller exploded'));
      const onStall = vi.fn();
      detector.add('member-1', makeEntry({
        provisional: true,
        logFilePath: null,
        lastActivityAt: Date.now() - 50_000,
        onStall,
      }));

      await detector._poll();

      // An unexpected poller failure must not silently disable stall protection
      // for members that DO have a working signal -- only an explicit
      // signalAvailable:false opts out.
      expect(onStall).toHaveBeenCalledTimes(1);
    });
  });

  describe('_poll — once-per-stall guard (stallReported)', () => {
    it('fires stall_detected exactly once per stall period across multiple polls', async () => {
      process.env['STALL_THRESHOLD_MS'] = '5000';
      const pastTime = Date.now() - 10_000;
      detector.add('member-1', makeEntry({ lastActivityAt: pastTime }));

      const oldTs = new Date(pastTime - 1000).toISOString();
      mockPollLogFile.mockResolvedValue({ lastTimestamp: oldTs });

      const stallDetectedCalls = () => mockScopeWarn.mock.calls.filter((c: string[]) => {
        try { return JSON.parse(c[0]).event === 'stall_detected'; } catch { return false; }
      });

      // First poll — stall fires
      await detector._poll();
      expect(stallDetectedCalls()).toHaveLength(1);

      // Second poll — stallReported=true, must NOT fire again
      await detector._poll();
      expect(stallDetectedCalls()).toHaveLength(1);
    });

    it('resets stallReported and lastActivityAt when activity resumes after stall', async () => {
      process.env['STALL_THRESHOLD_MS'] = '5000';
      const pastTime = Date.now() - 10_000;
      // Start in already-stalled state
      detector.add('member-1', makeEntry({ lastActivityAt: pastTime, stallReported: true }));

      const newTs = new Date(Date.now()).toISOString();
      mockPollLogFile.mockResolvedValue({ lastTimestamp: newTs });

      await detector._poll();

      const entry = detector.getEntry('member-1');
      expect(entry?.stallReported).toBe(false);
      expect(entry?.lastActivityAt).toBe(new Date(newTs).getTime());
      expect(mockUpdateAgent).toHaveBeenCalledWith('member-1', { lastLlmActivityAt: newTs });
    });
  });

  // apra-fleet-iuc.2: the transcript file's OS mtime cross-checked against the
  // content-parsed timestamp. Every test above mocks pollLogFile WITHOUT
  // mtimeMs (undefined), so this block is what actually exercises the new
  // branches -- the rest stays a pure regression guard that behavior is
  // unchanged when no mtime signal is present.
  describe('_poll — mtime cross-check (apra-fleet-iuc.2)', () => {
    it('counts mtime advancement as activity even when content parsing found nothing (no false stall)', async () => {
      process.env['STALL_THRESHOLD_MS'] = '5000';
      const baseTime = Date.now() - 10_000;
      detector.add('member-1', makeEntry({ lastActivityAt: baseTime }));

      const mtimeMs = baseTime + 4000;
      mockPollLogFile.mockResolvedValue({ lastTimestamp: null, mtimeMs });

      await detector._poll();

      const entry = detector.getEntry('member-1');
      expect(entry?.lastActivityAt).toBe(mtimeMs);
      expect(entry?.consecutiveIdleCycles).toBe(0);
      expect(entry?.stallReported).toBe(false);
      const stallCalls = mockScopeWarn.mock.calls.filter((c: string[]) => {
        try { return JSON.parse(c[0]).event === 'stall_detected'; } catch { return false; }
      });
      expect(stallCalls).toHaveLength(0);
      // No content timestamp string was available, so there is nothing
      // meaningful to persist as lastLlmActivityAt.
      expect(mockUpdateAgent).not.toHaveBeenCalled();
    });

    it('still treats a frozen file as no-activity when mtime does not advance either (content null + stale mtime)', async () => {
      process.env['STALL_THRESHOLD_MS'] = '5000';
      const pastTime = Date.now() - 10_000;
      detector.add('member-1', makeEntry({ lastActivityAt: pastTime }));

      // mtime is older than (or equal to) lastActivityAt — no corroborating signal.
      mockPollLogFile.mockResolvedValue({ lastTimestamp: null, mtimeMs: pastTime - 1000 });

      await detector._poll();

      expect(detector.getEntry('member-1')?.consecutiveIdleCycles).toBe(0);
      const stallCalls = mockLogLine.mock.calls.filter((c: string[]) => c[0] === 'stall_detected');
      expect(stallCalls).toHaveLength(0);
    });

    it('emits stall_detected only when BOTH content timestamp and mtime agree there is no new activity', async () => {
      process.env['STALL_THRESHOLD_MS'] = '5000';
      const pastTime = Date.now() - 10_000;
      detector.add('member-1', makeEntry({ lastActivityAt: pastTime }));

      mockPollLogFile.mockResolvedValue({
        lastTimestamp: new Date(pastTime - 1000).toISOString(),
        mtimeMs: pastTime - 500,
      });

      await detector._poll();

      const stallCalls = mockScopeWarn.mock.calls.filter((c: string[]) => {
        try { return JSON.parse(c[0]).event === 'stall_detected'; } catch { return false; }
      });
      expect(stallCalls).toHaveLength(1);
      expect(detector.getEntry('member-1')?.stallReported).toBe(true);
    });

    it('a fresher mtime prevents the stall that a stale content timestamp alone would have triggered', async () => {
      process.env['STALL_THRESHOLD_MS'] = '5000';
      const pastTime = Date.now() - 10_000;
      detector.add('member-1', makeEntry({ lastActivityAt: pastTime }));

      // Content parsing found a stale entry (would stall on its own), but the
      // file's own mtime shows it was genuinely rewritten more recently --
      // e.g. an unrecognized/newer transcript entry shape the content parser
      // does not yet understand. This is exactly the "must not false-kill"
      // guarantee for a format gap like apra-fleet-6z8.2/apra-fleet-979.
      const mtimeMs = Date.now() - 1000;
      mockPollLogFile.mockResolvedValue({
        lastTimestamp: new Date(pastTime - 1000).toISOString(),
        mtimeMs,
      });

      await detector._poll();

      const entry = detector.getEntry('member-1');
      expect(entry?.lastActivityAt).toBe(mtimeMs);
      expect(entry?.stallReported).toBe(false);
      const stallCalls = mockScopeWarn.mock.calls.filter((c: string[]) => {
        try { return JSON.parse(c[0]).event === 'stall_detected'; } catch { return false; }
      });
      expect(stallCalls).toHaveLength(0);
    });

    it('advances lastActivityAt to the max of the content timestamp and mtime when both progressed', async () => {
      const baseTime = Date.now();
      detector.add('member-1', makeEntry({ lastActivityAt: baseTime }));

      const contentTs = baseTime + 1000;
      const mtimeMs = baseTime + 5000; // mtime is the more recent signal
      mockPollLogFile.mockResolvedValue({ lastTimestamp: new Date(contentTs).toISOString(), mtimeMs });

      await detector._poll();

      expect(detector.getEntry('member-1')?.lastActivityAt).toBe(mtimeMs);
    });
  });
});

describe('computeEffectiveThresholdMs (PR#416 finding 4: clamp)', () => {
  const BASELINE = 150_000;   // DEFAULT_STALL_THRESHOLD_MS
  const GRACE = 60_000;       // TOOL_TIMEOUT_GRACE_MS
  const CEILING = 1_800_000;  // MAX_STALL_THRESHOLD_MS

  beforeEach(() => { delete process.env['STALL_MAX_THRESHOLD_MS']; });
  afterEach(() => { delete process.env['STALL_MAX_THRESHOLD_MS']; });

  // [label, pendingToolTimeoutMs, expected effective threshold, expected clamp]
  const cases: Array<[string, number | null | undefined, number, 'floor' | 'ceiling' | null]> = [
    ['zero',                    0,          BASELINE, 'floor'],
    ['one ms',                  1,          BASELINE, 'floor'],
    ['seconds-denominated 30',  30,         BASELINE, 'floor'],
    ['30s',                     30_000,     BASELINE, 'floor'],
    ['just under the floor',    89_999,     BASELINE, 'floor'],
    ['just over the floor',     90_001,     150_001,  null],
    ['the real 900s case',      900_000,    960_000,  null],
    ['absurd 24h declaration',  86_400_000, CEILING,  'ceiling'],
    ['exactly at the ceiling',  CEILING - GRACE, CEILING, null],
    ['null',                    null,       BASELINE, null],
    ['undefined',               undefined,  BASELINE, null],
    ['NaN',                     NaN,        BASELINE, null],
    ['negative',                -5_000,     BASELINE, 'floor'],
    ['negative beyond grace',   -1_000_000, BASELINE, 'floor'],
    ['Infinity',                Infinity,   BASELINE, null],
  ];

  for (const [label, pending, expected, expectedClamp] of cases) {
    it(`${label} -> ${expected}ms (clamped: ${String(expectedClamp)})`, () => {
      const actual = computeEffectiveThresholdMs(BASELINE, pending);
      expect(actual).toBe(expected);
      expect(describeClamp(BASELINE, pending, actual)).toBe(expectedClamp);
    });
  }

  it('never returns below the supplied baseline, whatever the declaration', () => {
    for (const pending of [0, 1, 30, 30_000, 89_999, -1, NaN, null, undefined]) {
      expect(computeEffectiveThresholdMs(BASELINE, pending as number)).toBeGreaterThanOrEqual(BASELINE);
    }
  });

  it('never returns above the ceiling, whatever the declaration', () => {
    for (const pending of [900_000, 1_800_000, 86_400_000, Number.MAX_SAFE_INTEGER]) {
      expect(computeEffectiveThresholdMs(BASELINE, pending)).toBeLessThanOrEqual(CEILING);
    }
  });

  it('honors the STALL_MAX_THRESHOLD_MS env override', () => {
    process.env['STALL_MAX_THRESHOLD_MS'] = '300000';
    expect(computeEffectiveThresholdMs(BASELINE, 900_000)).toBe(300_000);
    expect(describeClamp(BASELINE, 900_000, 300_000)).toBe('ceiling');
  });

  it('respects a baseline raised above the declared timeout + grace', () => {
    expect(computeEffectiveThresholdMs(500_000, 100_000)).toBe(500_000);
  });

  it('falls back to the built-in ceiling when the env override is unparseable', () => {
    process.env['STALL_MAX_THRESHOLD_MS'] = 'not-a-number';
    expect(computeEffectiveThresholdMs(BASELINE, 86_400_000)).toBe(CEILING);
  });
});
