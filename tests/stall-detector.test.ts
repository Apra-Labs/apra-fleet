import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  mockPollLogFile, mockPollDirectoryActivity, mockUpdateAgent, mockLogLine, mockLogWarn,
  mockScopeWarn, mockScopeOk, mockWriteStatusline,
} = vi.hoisted(() => ({
  mockPollLogFile: vi.fn(),
  mockPollDirectoryActivity: vi.fn(),
  mockUpdateAgent: vi.fn(),
  mockLogLine: vi.fn(),
  mockLogWarn: vi.fn(),
  mockScopeWarn: vi.fn(),
  mockScopeOk: vi.fn(),
  mockWriteStatusline: vi.fn(),
}));

vi.mock('../src/services/stall/stall-poller.js', () => ({
  pollLogFile: mockPollLogFile,
  pollDirectoryActivity: mockPollDirectoryActivity,
}));

vi.mock('../src/services/registry.js', () => ({
  updateAgent: mockUpdateAgent,
}));

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: mockWriteStatusline,
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
    ok(msg?: string) { mockScopeOk(msg); }
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

  describe('_poll — per-entry thresholdMs (apra-fleet-25yl.1.1)', () => {
    it('a non-provisional entry with its own thresholdMs is evaluated against it, ignoring the env fallback', async () => {
      process.env['STALL_THRESHOLD_MS'] = '5000'; // would fire if honored
      const pastTime = Date.now() - 10_000; // 10s idle -- past the 5s env value
      detector.add('member-1', makeEntry({ lastActivityAt: pastTime, thresholdMs: 60_000 })); // but well within 60s
      mockPollLogFile.mockResolvedValue({ lastTimestamp: new Date(pastTime - 1000).toISOString() });

      await detector._poll();

      const stallCalls = mockScopeWarn.mock.calls.filter((c: string[]) => {
        try { return JSON.parse(c[0]).event === 'stall_detected'; } catch { return false; }
      });
      expect(stallCalls).toHaveLength(0);
    });

    it('a non-provisional entry with a SHORTER thresholdMs than the env fallback stalls sooner', async () => {
      process.env['STALL_THRESHOLD_MS'] = '600000'; // env alone would not fire
      const pastTime = Date.now() - 10_000; // 10s idle
      detector.add('member-1', makeEntry({ lastActivityAt: pastTime, thresholdMs: 5_000 })); // but its own budget is 5s
      mockPollLogFile.mockResolvedValue({ lastTimestamp: new Date(pastTime - 1000).toISOString() });

      await detector._poll();

      const stallCalls = mockScopeWarn.mock.calls.filter((c: string[]) => {
        try { return JSON.parse(c[0]).event === 'stall_detected'; } catch { return false; }
      });
      expect(stallCalls).toHaveLength(1);
    });

    it('a provisional entry with its own thresholdMs is evaluated against it on the provisional path too', async () => {
      process.env['STALL_THRESHOLD_MS'] = '5000'; // would fire if honored
      const pastTime = Date.now() - 10_000; // 10s idle -- past the 5s env value
      mockPollDirectoryActivity.mockResolvedValue({ mtimeMs: null, signalAvailable: true });
      const onStall = vi.fn();
      detector.add('member-1', makeEntry({
        provisional: true,
        logFilePath: null,
        lastActivityAt: pastTime,
        thresholdMs: 60_000, // well within its own 60s budget
        onStall,
      }));

      await detector._poll();

      expect(onStall).not.toHaveBeenCalled();
      const stallCalls = mockScopeWarn.mock.calls.filter((c: string[]) => {
        try { return JSON.parse(c[0]).event === 'stall_detected'; } catch { return false; }
      });
      expect(stallCalls).toHaveLength(0);
    });

    it('an entry without thresholdMs falls back to the env/default value on the non-provisional path (no behavior change)', async () => {
      process.env['STALL_THRESHOLD_MS'] = '5000';
      const pastTime = Date.now() - 10_000;
      detector.add('member-1', makeEntry({ lastActivityAt: pastTime })); // no thresholdMs set
      mockPollLogFile.mockResolvedValue({ lastTimestamp: new Date(pastTime - 1000).toISOString() });

      await detector._poll();

      const stallCalls = mockScopeWarn.mock.calls.filter((c: string[]) => {
        try { return JSON.parse(c[0]).event === 'stall_detected'; } catch { return false; }
      });
      expect(stallCalls).toHaveLength(1);
    });

    it('an entry without thresholdMs falls back to the env/default value on the provisional path too (no behavior change)', async () => {
      process.env['STALL_THRESHOLD_MS'] = '5000';
      const pastTime = Date.now() - 10_000; // 10s idle -- past the 5s env value
      mockPollDirectoryActivity.mockResolvedValue({ mtimeMs: null, signalAvailable: true });
      const onStall = vi.fn();
      detector.add('member-1', makeEntry({
        provisional: true,
        logFilePath: null,
        lastActivityAt: pastTime,
        onStall,
        // no thresholdMs set
      }));

      await detector._poll();

      expect(onStall).toHaveBeenCalledTimes(1);
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

  // apra-fleet-25yl.4: the adaptive probe cadence's floor (the loop's own
  // tick interval) must win over its 300_000ms ceiling when
  // STALL_POLL_INTERVAL_MS is overridden above that ceiling. Before this fix,
  // probeIntervalMs = min(ceiling, max(tick, threshold/5)) let the ceiling
  // win instead, so an over-ceiling tick interval produced a probe interval
  // BELOW the tick interval and the gate fired on every tick.
  describe('_poll — adaptive probe cadence floor wins over the ceiling (apra-fleet-25yl.4)', () => {
    it('does not probe again until the over-ceiling tick interval has elapsed', async () => {
      const tickIntervalMs = 360_000; // 6 minutes -- above the 300_000ms ceiling
      process.env['STALL_POLL_INTERVAL_MS'] = String(tickIntervalMs);
      process.env['STALL_THRESHOLD_MS'] = '5000'; // threshold/5 = 1000ms, well under the ceiling
      mockPollLogFile.mockResolvedValue({ lastTimestamp: new Date().toISOString() });

      const start = Date.now();
      detector.add('member-1', makeEntry({ lastActivityAt: start }));

      // First poll seeds lastPolledAt.
      await detector._poll();
      expect(mockPollLogFile).toHaveBeenCalledTimes(1);

      // Past the OLD (buggy) 300_000ms ceiling, but still short of the
      // 360_000ms tick interval -- with the fix, the floor wins and this
      // tick must be skipped (no live probe issued).
      vi.setSystemTime(start + 300_001);
      await detector._poll();
      expect(mockPollLogFile).toHaveBeenCalledTimes(1);

      // At/past the tick interval -- now it must probe again.
      vi.setSystemTime(start + tickIntervalMs + 1);
      await detector._poll();
      expect(mockPollLogFile).toHaveBeenCalledTimes(2);
    });
  });

  // apra-fleet-25yl.3.2: full behavioural coverage of the adaptive per-entry
  // probe cadence introduced by apra-fleet-25yl.3.1/.3/.4 -- the ceiling, the
  // false-kill-window guard, and the stall_poll_tick observability fields
  // added by apra-fleet-25yl.3.3. All fake timers; no real waits.
  describe('_poll — adaptive probe cadence (apra-fleet-25yl.3.2)', () => {
    const TICK_MS = 30_000; // DEFAULT_POLL_INTERVAL_MS

    /** Advances fake time by `deltaMs` and drives one more _poll() tick. */
    async function tick(deltaMs: number): Promise<void> {
      vi.setSystemTime(Date.now() + deltaMs);
      await detector._poll();
    }

    const stallDetectedCalls = () => mockScopeWarn.mock.calls.filter((c: string[]) => {
      try { return JSON.parse(c[0]).event === 'stall_detected'; } catch { return false; }
    });

    it('part A: a long-threshold entry is probed at least 5x less often than the fixed tick baseline, and less often than a small-threshold entry', async () => {
      const start = Date.now();
      mockPollLogFile.mockImplementation(async () => ({ lastTimestamp: new Date().toISOString() }));

      // 150s default threshold -> probeIntervalMs === tickIntervalMs (the fixed baseline).
      detector.add('small', makeEntry({ memberId: 'small', memberName: 'small', lastActivityAt: start }));
      // 9000s threshold -> probeIntervalMs capped at 300_000ms (10x the tick interval).
      detector.add('long', makeEntry({ memberId: 'long', memberName: 'long', lastActivityAt: start, thresholdMs: 9_000_000 }));

      await detector._poll(); // seed both at t=0
      const WINDOW_TICKS = 20; // 10 minutes at a 30s tick
      for (let i = 0; i < WINDOW_TICKS; i++) await tick(TICK_MS);

      const countFor = (id: string) => mockPollLogFile.mock.calls.filter((c) => c[0] === id).length;
      const smallCount = countFor('small');
      const longCount = countFor('long');

      expect(smallCount).toBe(WINDOW_TICKS + 1); // probed every tick, same as the fixed baseline
      expect(longCount).toBeLessThanOrEqual(Math.floor(smallCount / 5)); // at least 5x less often
      expect(longCount).toBeLessThan(smallCount);
    });

    it('an entry with a 1800s stable threshold is probed about once per 300s (the 5-minute cap)', async () => {
      const start = Date.now();
      mockPollLogFile.mockImplementation(async () => ({ lastTimestamp: new Date().toISOString() }));
      detector.add('e', makeEntry({ memberId: 'e', memberName: 'e', lastActivityAt: start, thresholdMs: 1_800_000 }));

      await detector._poll(); // seed, t=0
      const probeTimes: number[] = [Date.now()];
      for (let i = 0; i < 20; i++) {
        await tick(TICK_MS);
        const count = mockPollLogFile.mock.calls.filter((c) => c[0] === 'e').length;
        if (count > probeTimes.length) probeTimes.push(Date.now());
      }

      // 20 * 30s = 600s window -> probes at t=0, 300s, 600s: 3 probes, ~300s apart.
      expect(probeTimes).toHaveLength(3);
      expect(probeTimes[1]! - probeTimes[0]!).toBe(300_000);
      expect(probeTimes[2]! - probeTimes[1]!).toBe(300_000);
    });

    it('an entry with the 9000s production threshold is ALSO capped at 300s -- it must not drift to 1800s', async () => {
      const start = Date.now();
      mockPollLogFile.mockImplementation(async () => ({ lastTimestamp: new Date().toISOString() }));
      detector.add('e', makeEntry({ memberId: 'e', memberName: 'e', lastActivityAt: start, thresholdMs: 9_000_000 }));

      await detector._poll(); // seed, t=0
      await tick(300_000); // t=300s -- must probe again if capped at 300s
      await tick(300_000); // t=600s -- must probe again

      // Would be 1 (no re-probe within this window at all) if the cap were
      // dropped: 9000s / 5 = 1800s, which is longer than this 600s window.
      const count = mockPollLogFile.mock.calls.filter((c) => c[0] === 'e').length;
      expect(count).toBe(3);
    });

    it('a 150s-default entry is probed at exactly the loop tick interval, and STALL_POLL_INTERVAL_MS moves that floor with it (no independent floor knob)', async () => {
      process.env['STALL_POLL_INTERVAL_MS'] = '60000';
      const start = Date.now();
      mockPollLogFile.mockImplementation(async () => ({ lastTimestamp: new Date().toISOString() }));
      detector.add('e', makeEntry({ memberId: 'e', memberName: 'e', lastActivityAt: start }));

      await detector._poll(); // seed, t=0
      vi.setSystemTime(start + 59_000);
      await detector._poll();
      expect(mockPollLogFile.mock.calls.filter((c) => c[0] === 'e')).toHaveLength(1); // not yet due -- below the overridden 60s floor

      vi.setSystemTime(start + 60_000);
      await detector._poll();
      expect(mockPollLogFile.mock.calls.filter((c) => c[0] === 'e')).toHaveLength(2); // due exactly at the overridden tick interval
    });

    it('two entries with different thresholds are gated independently within the same shared tick loop', async () => {
      const start = Date.now();
      mockPollLogFile.mockImplementation(async () => ({ lastTimestamp: new Date().toISOString() }));
      detector.add('fast', makeEntry({ memberId: 'fast', memberName: 'fast', lastActivityAt: start })); // tick cadence
      detector.add('slow', makeEntry({ memberId: 'slow', memberName: 'slow', lastActivityAt: start, thresholdMs: 9_000_000 })); // 300s cadence

      await detector._poll(); // t=0 -- both due (never polled)
      for (let i = 0; i < 9; i++) await tick(TICK_MS); // through t=270000

      expect(mockPollLogFile.mock.calls.filter((c) => c[0] === 'fast')).toHaveLength(10);
      expect(mockPollLogFile.mock.calls.filter((c) => c[0] === 'slow')).toHaveLength(1);

      await tick(TICK_MS); // t=300000 -- 'slow' becomes due again
      expect(mockPollLogFile.mock.calls.filter((c) => c[0] === 'slow')).toHaveLength(2);
      expect(mockPollLogFile.mock.calls.filter((c) => c[0] === 'fast')).toHaveLength(11);
    });

    it('part B (false-kill window): a tick on which an entry probe is deferred issues no probe and performs no stall-threshold evaluation', async () => {
      process.env['STALL_THRESHOLD_MS'] = '5000';
      const start = Date.now();
      detector.add('e', makeEntry({ memberId: 'e', memberName: 'e', lastActivityAt: start }));
      mockPollLogFile.mockResolvedValue({ lastTimestamp: new Date(start).toISOString() }); // frozen -- no advance

      await detector._poll(); // seed at t=0 -- idle=0, no stall
      let entry = detector.getEntry('e')!;
      const idleCyclesAfterSeed = entry.consecutiveIdleCycles;
      const readFailuresAfterSeed = entry.consecutiveReadFailures;
      expect(idleCyclesAfterSeed).toBe(1);

      // 10s idle already exceeds the entry's own 5s threshold, but its own
      // probeIntervalMs is floored at the 30s tick interval, so it is not due
      // for another probe yet.
      vi.setSystemTime(start + 10_000);
      await detector._poll();

      expect(mockPollLogFile).toHaveBeenCalledTimes(1); // no second probe issued
      entry = detector.getEntry('e')!;
      expect(entry.consecutiveIdleCycles).toBe(idleCyclesAfterSeed); // no evaluation happened on the skipped tick
      expect(entry.consecutiveReadFailures).toBe(readFailuresAfterSeed);
      expect(stallDetectedCalls()).toHaveLength(0); // not reported as stalled despite naive-elapsed > threshold
    });

    it('part B: a short-timeout entry with a genuinely frozen transcript is still killed within one probe interval of its own threshold', async () => {
      process.env['STALL_THRESHOLD_MS'] = '5000';
      const start = Date.now();
      detector.add('e', makeEntry({ memberId: 'e', memberName: 'e', lastActivityAt: start }));
      mockPollLogFile.mockResolvedValue({ lastTimestamp: new Date(start).toISOString() }); // frozen forever

      await detector._poll(); // seed at t=0

      vi.setSystemTime(start + TICK_MS); // t=30000 -- the next probe-interval boundary (the tick floor), past the 5s threshold
      await detector._poll();

      const calls = stallDetectedCalls();
      expect(calls).toHaveLength(1); // killed at the first probe due after its own (short) threshold elapsed
      const logged = JSON.parse(calls[0]![0] as string);
      expect(logged.idleSecs).toBe(30); // not the old global 150s default, and not a longer adaptive interval
    });

    it('a genuinely stalled long-threshold entry is reported stalled within one probe interval past its threshold', async () => {
      const start = Date.now();
      const THRESHOLD_MS = 9_000_000;
      detector.add('e', makeEntry({ memberId: 'e', memberName: 'e', lastActivityAt: start, thresholdMs: THRESHOLD_MS }));
      mockPollLogFile.mockResolvedValue({ lastTimestamp: new Date(start).toISOString() }); // frozen forever

      await detector._poll(); // seed at t=0

      vi.setSystemTime(start + THRESHOLD_MS); // exactly at the threshold -- not yet exceeded
      await detector._poll();
      expect(stallDetectedCalls()).toHaveLength(0);

      vi.setSystemTime(start + THRESHOLD_MS + 300_000); // one probe interval past the threshold
      await detector._poll();
      expect(stallDetectedCalls()).toHaveLength(1);
    });

    it('stall_poll_tick observability: probesIssued/probesSkipped/entryProbeIntervals reflect one due entry and one gated-off entry', async () => {
      const start = Date.now();
      mockPollLogFile.mockImplementation(async () => ({ lastTimestamp: new Date().toISOString() }));

      detector.add('due', makeEntry({ memberId: 'due', memberName: 'due', lastActivityAt: start })); // tick cadence, always due
      detector.add('gated', makeEntry({ memberId: 'gated', memberName: 'gated', lastActivityAt: start, thresholdMs: 9_000_000 })); // 300s cadence

      await detector._poll(); // seed both -- both due on the very first tick
      mockScopeOk.mockClear();

      await tick(TICK_MS); // t=30000 -- 'due' is due again, 'gated' is not

      expect(mockScopeOk).toHaveBeenCalledTimes(1);
      const summary = JSON.parse(mockScopeOk.mock.calls[0]![0] as string);
      expect(summary.probesIssued).toBe(1);
      expect(summary.probesSkipped).toBe(1);
      expect(summary.entryProbeIntervals).toHaveLength(2);
      expect(summary.entryProbeIntervals).toEqual(expect.arrayContaining([
        { memberName: 'due', probeIntervalMs: TICK_MS },
        { memberName: 'gated', probeIntervalMs: 300_000 },
      ]));
    });

    it('the status line is still refreshed for an entry whose probe was skipped', async () => {
      const start = Date.now();
      mockPollLogFile.mockImplementation(async () => ({ lastTimestamp: new Date().toISOString() }));
      detector.add('gated', makeEntry({ memberId: 'gated', memberName: 'gated', lastActivityAt: start, thresholdMs: 9_000_000 }));

      await detector._poll(); // seed
      mockWriteStatusline.mockClear();
      await tick(TICK_MS); // 'gated' entry's probe is skipped this tick

      expect(mockPollLogFile.mock.calls.filter((c) => c[0] === 'gated')).toHaveLength(1); // still just the seed -- skipped
      const lastCall = mockWriteStatusline.mock.calls[mockWriteStatusline.mock.calls.length - 1]!;
      const arg = lastCall[0] as Map<string, string>;
      expect(arg.get('gated')).toMatch(/^busy\(/);
    });
  });

  // apra-fleet-25yl.6: a malformed STALL_THRESHOLD_MS must not silently wedge
  // the adaptive probe gate for entries with no per-dispatch thresholdMs.
  describe('_poll — malformed STALL_THRESHOLD_MS env guard (apra-fleet-25yl.6)', () => {
    it('a non-numeric STALL_THRESHOLD_MS still yields a finite probeIntervalMs, and an entry with no thresholdMs is probed a second time on a later tick', async () => {
      process.env['STALL_THRESHOLD_MS'] = 'not-a-number';
      const start = Date.now();
      mockPollLogFile.mockImplementation(async () => ({ lastTimestamp: new Date().toISOString() }));
      detector.add('e', makeEntry({ memberId: 'e', memberName: 'e', lastActivityAt: start })); // no thresholdMs -- uses the fallback

      await detector._poll(); // seed at t=0
      expect(mockPollLogFile.mock.calls.filter((c) => c[0] === 'e')).toHaveLength(1);

      // Advance well past the DEFAULT_STALL_THRESHOLD_MS (150s) fallback the
      // guard must produce -- a NaN probeIntervalMs would leave dueForProbe
      // false forever and this entry would never be probed again.
      vi.setSystemTime(start + 200_000);
      await detector._poll();
      expect(mockPollLogFile.mock.calls.filter((c) => c[0] === 'e')).toHaveLength(2);
    });

    it('an entry that DOES carry its own thresholdMs is unaffected by the malformed env value', async () => {
      process.env['STALL_THRESHOLD_MS'] = 'garbage';
      const start = Date.now();
      mockPollLogFile.mockImplementation(async () => ({ lastTimestamp: new Date().toISOString() }));
      // 60s thresholdMs / 5 = 12s, floored at the 30s tick interval.
      detector.add('e', makeEntry({ memberId: 'e', memberName: 'e', lastActivityAt: start, thresholdMs: 60_000 }));

      await detector._poll(); // seed
      vi.setSystemTime(start + 30_000);
      await detector._poll();
      expect(mockPollLogFile.mock.calls.filter((c) => c[0] === 'e')).toHaveLength(2); // cadence derived purely from its own thresholdMs
    });

    it('logs the rejected env value exactly once, not once per tick', async () => {
      process.env['STALL_THRESHOLD_MS'] = 'nope';
      const start = Date.now();
      mockPollLogFile.mockImplementation(async () => ({ lastTimestamp: new Date().toISOString() }));
      detector.add('e', makeEntry({ memberId: 'e', memberName: 'e', lastActivityAt: start }));

      await detector._poll();
      vi.setSystemTime(start + 30_000);
      await detector._poll();
      vi.setSystemTime(start + 60_000);
      await detector._poll();

      const warnCalls = mockLogWarn.mock.calls.filter((c) => c[0] === 'stall_threshold_env_invalid');
      expect(warnCalls).toHaveLength(1);
      expect(JSON.parse(warnCalls[0]![1] as string).value).toBe('nope');
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

  /**
   * apra-fleet-qe83.2: reproduces the recorded missed stall -- a transcript
   * whose tail is a dated assistant entry, an attachment entry, and a final
   * last-prompt record with no timestamp field, byte-cap-truncated so the
   * dated entry never survives extraction (see the fixture
   * tests/fixtures/stall-frozen-tail-no-timestamp.jsonl and its pollLogFile-
   * level reproduction in tests/stall-poller.test.ts). The file's own mtime
   * is frozen at the same instant. pollLogFile is mocked here to return
   * exactly what that extraction layer produces for this shape
   * (lastTimestamp: null, mtimeMs pinned) so this block isolates the
   * DETECTOR's classification of that result, not the extraction itself.
   */
  describe('_poll — frozen-tail-null-timestamp (apra-fleet-qe83.2)', () => {
    // EXPECTED TO FLIP once apra-fleet-qe83.2.2 lands: today the detector
    // silently `continue`s when lastTimestamp is null and mtime hasn't
    // advanced, even though the file's own mtime proves it is genuinely
    // frozen -- no stall_detected, no onStall, and no log line at all.
    it('EXPECTED TO FLIP: currently misses a stall past threshold with no signal at all (no stall_detected, no onStall, no log line)', async () => {
      process.env['STALL_THRESHOLD_MS'] = '1800000'; // matches the recorded bug's 30-minute threshold
      const baseTime = Date.now();
      const onStall = vi.fn();
      detector.add('member-1', makeEntry({ lastActivityAt: baseTime, onStall }));

      // Frozen: content extraction found nothing usable, and the file's own
      // mtime has not advanced past lastActivityAt either.
      mockPollLogFile.mockResolvedValue({ lastTimestamp: null, mtimeMs: baseTime });

      // Threshold + one poll past T0.
      vi.setSystemTime(baseTime + 1_800_000 + 30_000);
      await detector._poll();

      expect(onStall).not.toHaveBeenCalled();
      const stallCalls = mockScopeWarn.mock.calls.filter((c: string[]) => {
        try { return JSON.parse(c[0]).event === 'stall_detected'; } catch { return false; }
      });
      expect(stallCalls).toHaveLength(0);
      // No diagnostic log line of any kind for this silent-continue path.
      expect(mockLogLine).not.toHaveBeenCalledWith('stall_tail_truncated', expect.any(String));
      expect(mockLogWarn).not.toHaveBeenCalledWith('stall_tail_truncated', expect.any(String));
      expect(detector.getEntry('member-1')?.consecutiveIdleCycles).toBe(0);
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

  // apra-fleet-25yl.1.1: the trusted baseline (orchestrator-authored
  // timeout_s) must never be capped by MAX_STALL_THRESHOLD_MS -- that ceiling
  // exists only to bound the untrusted pendingToolTimeoutMs contribution.
  describe('trusted baseline is never capped (apra-fleet-25yl.1.1)', () => {
    it('a trusted baseline at the ceiling survives unchanged with no declaration', () => {
      expect(computeEffectiveThresholdMs(CEILING, null)).toBe(CEILING);
      expect(describeClamp(CEILING, null, CEILING)).toBeNull();
    });

    it('a trusted baseline ABOVE the ceiling survives unchanged with no declaration', () => {
      const above = CEILING + 1_000_000;
      expect(computeEffectiveThresholdMs(above, null)).toBe(above);
      expect(describeClamp(above, null, above)).toBeNull();
    });

    it('an untrusted pendingToolTimeoutMs is still capped by the ceiling regardless of baseline', () => {
      const actual = computeEffectiveThresholdMs(300_000, 86_400_000);
      expect(actual).toBe(CEILING);
      expect(describeClamp(300_000, 86_400_000, actual)).toBe('ceiling');
    });

    it('a trusted baseline above the ceiling still wins over a large-but-lesser pending declaration', () => {
      const above = CEILING + 500_000;
      const actual = computeEffectiveThresholdMs(above, 900_000);
      expect(actual).toBe(above);
      // The baseline dominated the (ceiling-capped) untrusted contribution --
      // same "floor" verdict as any other case where the trusted value wins,
      // never mislabeled as a ceiling clamp that did not happen.
      expect(describeClamp(above, 900_000, actual)).toBe('floor');
    });

    it('a trusted baseline above the ceiling still wins even when the raw (uncapped) pending value exceeds it', () => {
      // PRIMARY regression case: base sits ABOVE the ceiling, and raw
      // (pending + grace) sits ABOVE base too -- the one region the earlier
      // fix's fixtures never covered. The baseline still wins the max(), but
      // effective ends up BELOW raw, which is exactly what fooled the old
      // "effective < raw => ceiling" comparison into lying.
      const base = 3_600_000; // above CEILING (1_800_000)
      const pending = 86_400_000; // raw = 86_460_000, far above base
      const actual = computeEffectiveThresholdMs(base, pending);
      expect(actual).toBe(base);
      expect(describeClamp(base, pending, actual)).toBe('floor');
    });

    it('reports "floor", not null, at the knife-edge where the baseline happens to equal the raw pending value', () => {
      // SECONDARY regression case: base === pending + GRACE (raw), so the
      // final effective value coincides with raw even though the ceiling DID
      // cap the pending contribution internally along the way. The verdict
      // must reflect that the baseline (floor) is what determined the
      // result, not fall back to null just because effective === raw.
      const base = 3_060_000;
      const pending = 3_000_000; // raw = 3_060_000 === base
      const actual = computeEffectiveThresholdMs(base, pending);
      expect(actual).toBe(base);
      expect(describeClamp(base, pending, actual)).toBe('floor');
    });
  });
});
