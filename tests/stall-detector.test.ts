import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockPollLogFile, mockUpdateAgent, mockLogLine, mockLogWarn } = vi.hoisted(() => ({
  mockPollLogFile: vi.fn(),
  mockUpdateAgent: vi.fn(),
  mockLogLine: vi.fn(),
  mockLogWarn: vi.fn(),
}));

vi.mock('../src/services/stall/stall-poller.js', () => ({
  pollLogFile: mockPollLogFile,
}));

vi.mock('../src/services/registry.js', () => ({
  updateAgent: mockUpdateAgent,
}));

vi.mock('../src/utils/log-helpers.js', () => ({
  logLine: mockLogLine,
  logWarn: mockLogWarn,
}));

import { StallDetector, type StallEntry } from '../src/services/stall/stall-detector.js';

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

      const stallCalls = mockLogLine.mock.calls.filter((c: string[]) => c[0] === 'stall_detected');
      expect(stallCalls).toHaveLength(1);
      const logged = JSON.parse(stallCalls[0][1] as string);
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
      detector.add('member-1', makeEntry({ provisional: true, logFilePath: null, lastActivityAt: pastTime }));

      await detector._poll();

      const stallCalls = mockLogLine.mock.calls.filter((c: string[]) => c[0] === 'stall_detected');
      expect(stallCalls).toHaveLength(1);
    });
  });

  describe('_poll — once-per-stall guard (stallReported)', () => {
    it('fires stall_detected exactly once per stall period across multiple polls', async () => {
      process.env['STALL_THRESHOLD_MS'] = '5000';
      const pastTime = Date.now() - 10_000;
      detector.add('member-1', makeEntry({ lastActivityAt: pastTime }));

      const oldTs = new Date(pastTime - 1000).toISOString();
      mockPollLogFile.mockResolvedValue({ lastTimestamp: oldTs });

      // First poll — stall fires
      await detector._poll();
      const calls1 = mockLogLine.mock.calls.filter((c: string[]) => c[0] === 'stall_detected');
      expect(calls1).toHaveLength(1);

      // Second poll — stallReported=true, must NOT fire again
      await detector._poll();
      const calls2 = mockLogLine.mock.calls.filter((c: string[]) => c[0] === 'stall_detected');
      expect(calls2).toHaveLength(1);
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
});
