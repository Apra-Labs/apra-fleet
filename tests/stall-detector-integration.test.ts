import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent, updateAgent, getAgent } from '../src/services/registry.js';
import type { SSHExecResult } from '../src/types.js';

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();
const mockTestConnection = vi.fn<() => Promise<{ ok: boolean; latencyMs: number; error?: string }>>();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: mockTestConnection,
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

import { StallDetector, type StallEntry } from '../src/services/stall/stall-detector.js';
import { memberDetail } from '../src/tools/member-detail.js';
import { fleetStatus } from '../src/tools/check-status.js';

function makeEntry(overrides: Partial<StallEntry> = {}): StallEntry {
  return {
    sessionId: null,
    logFilePath: null,
    lastActivityAt: Date.now(),
    consecutiveIdleCycles: 0,
    consecutiveReadFailures: 0,
    memberId: 'member-1',
    memberName: 'alice',
    provisional: true,
    ...overrides,
  };
}

function setupDefaultMocks() {
  mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 3 });
  mockExecCommand.mockImplementation(async (cmd: string) => {
    if (cmd.includes('.credentials.json')) return { stdout: 'missing', stderr: '', code: 0 };
    if (cmd.includes('ANTHROPIC_API_KEY')) return { stdout: '', stderr: '', code: 0 };
    if (cmd.includes('--version')) return { stdout: '1.0.42', stderr: '', code: 0 };
    if (cmd.includes('pgrep') || cmd.includes('wmic process')) return { stdout: 'idle', stderr: '', code: 0 };
    if (cmd.includes('branch --show-current')) return { stdout: '', stderr: '', code: 0 };
    return { stdout: 'N/A', stderr: '', code: 0 };
  });
}

describe('StallDetector lifecycle — integration (T13)', () => {
  let detector: StallDetector;

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    detector = new StallDetector();
  });

  afterEach(() => {
    detector.stop();
    restoreRegistry();
  });

  it('provisional add at spawn → upgrade on sessionId → remove on exit', () => {
    const entry = makeEntry({ memberId: 'member-1', provisional: true });
    detector.add('member-1', entry);

    expect(detector.getEntry('member-1')).toBeDefined();
    expect(detector.getEntry('member-1')!.provisional).toBe(true);
    expect(detector.getEntry('member-1')!.sessionId).toBeNull();

    detector.update('member-1', {
      sessionId: 'session-xyz',
      logFilePath: '/home/user/.claude/projects/proj/session-xyz.jsonl',
      provisional: false,
    });

    const upgraded = detector.getEntry('member-1')!;
    expect(upgraded.provisional).toBe(false);
    expect(upgraded.sessionId).toBe('session-xyz');
    expect(upgraded.logFilePath).toContain('session-xyz.jsonl');

    detector.remove('member-1');
    expect(detector.getEntry('member-1')).toBeUndefined();
  });

  it('stop_prompt removes entry — idempotent with execute_prompt finally', () => {
    detector.add('member-1', makeEntry({ memberId: 'member-1' }));
    expect(detector.stallCheckList.size).toBe(1);

    // stop_prompt calls remove
    detector.remove('member-1');
    expect(detector.stallCheckList.size).toBe(0);

    // execute_prompt finally also calls remove — should not throw
    expect(() => detector.remove('member-1')).not.toThrow();
    expect(detector.stallCheckList.size).toBe(0);
  });

  it('member unregister removes entry', () => {
    detector.add('member-1', makeEntry({ memberId: 'member-1' }));
    detector.add('member-2', makeEntry({ memberId: 'member-2', memberName: 'bob' }));
    expect(detector.stallCheckList.size).toBe(2);

    // Unregister member-1
    detector.remove('member-1');
    expect(detector.stallCheckList.size).toBe(1);
    expect(detector.getEntry('member-1')).toBeUndefined();
    expect(detector.getEntry('member-2')).toBeDefined();
  });

  it('process exits before sessionId — provisional removed cleanly', () => {
    detector.add('member-1', makeEntry({
      memberId: 'member-1',
      provisional: true,
      sessionId: null,
      logFilePath: null,
    }));

    // Process crashes before sessionId arrives → finally block calls remove
    detector.remove('member-1');
    expect(detector.getEntry('member-1')).toBeUndefined();
  });
});

describe('member_detail surfaces lastLlmActivityAt and idleSecs (T13)', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('returns lastLlmActivityAt and idleSecs when member is busy', async () => {
    const activityTime = new Date(Date.now() - 30_000).toISOString(); // 30s ago
    const member = makeTestAgent({
      friendlyName: 'busy-member',
      lastLlmActivityAt: activityTime,
    });
    addAgent(member);
    setupDefaultMocks();
    mockExecCommand.mockImplementation(async (cmd: string) => {
      if (cmd.includes('.credentials.json')) return { stdout: 'missing', stderr: '', code: 0 };
      if (cmd.includes('ANTHROPIC_API_KEY')) return { stdout: '', stderr: '', code: 0 };
      if (cmd.includes('--version')) return { stdout: '1.0.42', stderr: '', code: 0 };
      if (cmd.includes('pgrep') || cmd.includes('wmic process')) return { stdout: 'fleet-busy', stderr: '', code: 0 };
      if (cmd.includes('branch --show-current')) return { stdout: '', stderr: '', code: 0 };
      return { stdout: 'N/A', stderr: '', code: 0 };
    });

    const result = JSON.parse(await memberDetail({ member_id: member.id, format: 'json' }));
    expect(result.session.lastLlmActivityAt).toBe(activityTime);
    expect(result.session.idleSecs).toBeTypeOf('number');
    expect(result.session.idleSecs).toBeGreaterThanOrEqual(29);
    expect(result.session.idleSecs).toBeLessThan(60);
  });

  it('returns lastLlmActivityAt but NOT idleSecs when member is idle', async () => {
    const activityTime = new Date(Date.now() - 60_000).toISOString();
    const member = makeTestAgent({
      friendlyName: 'idle-member',
      lastLlmActivityAt: activityTime,
    });
    addAgent(member);
    setupDefaultMocks();

    const result = JSON.parse(await memberDetail({ member_id: member.id, format: 'json' }));
    expect(result.session.lastLlmActivityAt).toBe(activityTime);
    expect(result.session.idleSecs).toBeUndefined();
    expect(result.session.status).toBe('idle');
  });

  it('returns null lastLlmActivityAt when field is not set', async () => {
    const member = makeTestAgent({ friendlyName: 'fresh-member' });
    addAgent(member);
    setupDefaultMocks();

    const result = JSON.parse(await memberDetail({ member_id: member.id, format: 'json' }));
    expect(result.session.lastLlmActivityAt).toBeNull();
    expect(result.session.idleSecs).toBeUndefined();
  });
});

describe('fleet_status JSON includes lastLlmActivityAt (T13)', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('includes lastLlmActivityAt per member in JSON output', async () => {
    const ts1 = new Date(Date.now() - 10_000).toISOString();
    const member1 = makeTestAgent({
      friendlyName: 'active-member',
      lastLlmActivityAt: ts1,
    });
    const member2 = makeTestAgent({
      friendlyName: 'no-activity-member',
    });
    addAgent(member1);
    addAgent(member2);
    setupDefaultMocks();

    const result = JSON.parse(await fleetStatus({ format: 'json' }));
    expect(result.members).toHaveLength(2);

    const m1 = result.members.find((m: Record<string, unknown>) => m.name === 'active-member');
    const m2 = result.members.find((m: Record<string, unknown>) => m.name === 'no-activity-member');

    expect(m1.lastLlmActivityAt).toBe(ts1);
    expect(m2.lastLlmActivityAt).toBeUndefined();
  });
});

describe('updateAgent persists lastLlmActivityAt to registry (T13)', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('updateAgent writes lastLlmActivityAt to the agent record', () => {
    const member = makeTestAgent({ friendlyName: 'tracked-member' });
    addAgent(member);

    const ts = new Date().toISOString();
    updateAgent(member.id, { lastLlmActivityAt: ts });

    const updated = getAgent(member.id);
    expect(updated.lastLlmActivityAt).toBe(ts);
  });
});
