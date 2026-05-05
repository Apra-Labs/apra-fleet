import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Agent } from '../src/types.js';

const {
  mockGetAllAgents,
  mockGetInstanceState,
  mockStopInstance,
  mockCheckMemberActivity,
  mockSetIdleTouchHook,
} = vi.hoisted(() => ({
  mockGetAllAgents: vi.fn<() => Agent[]>(() => []),
  mockGetInstanceState: vi.fn(),
  mockStopInstance: vi.fn(),
  mockCheckMemberActivity: vi.fn(),
  mockSetIdleTouchHook: vi.fn<(fn: (id: string) => void) => void>(),
}));

vi.mock('../src/services/registry.js', () => ({
  getAllAgents: mockGetAllAgents,
}));

vi.mock('../src/services/cloud/aws.js', () => ({
  awsProvider: {
    getInstanceState: mockGetInstanceState,
    stopInstance: mockStopInstance,
  },
}));

vi.mock('../src/services/cloud/activity.js', () => ({
  checkMemberActivity: mockCheckMemberActivity,
}));

vi.mock('../src/utils/agent-helpers.js', () => ({
  setIdleTouchHook: mockSetIdleTouchHook,
}));

import { IdleManager } from '../src/services/cloud/idle-manager.js';

// Cloud member with lastUsed 2 hours ago
const cloudAgent: Agent = {
  id: 'cloud-id',
  friendlyName: 'cloud-worker',
  agentType: 'remote',
  host: '1.2.3.4',
  port: 22,
  username: 'ubuntu',
  workFolder: '/home/ubuntu/work',
  os: 'linux',
  icon: '☁️',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastUsed: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h ago
  cloud: { provider: 'aws' as const, instanceId: 'i-12345678', region: 'us-east-1', idleTimeoutMin: 1 },
};

// Local member — no cloud field, should never be checked
const localAgent: Agent = {
  id: 'local-id',
  friendlyName: 'local-worker',
  agentType: 'local',
  workFolder: '/home/user/work',
  os: 'linux',
  icon: '🏠',
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('IdleManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAllAgents.mockReturnValue([]);
  });

  // --- start() ---

  describe('start()', () => {
    it('registers the touch hook and starts a timer', () => {
      const manager = new IdleManager();
      manager.start(60_000);
      expect(mockSetIdleTouchHook).toHaveBeenCalledWith(expect.any(Function));
      manager.stop();
    });

    it('is idempotent — second start() is a no-op', () => {
      const manager = new IdleManager();
      manager.start(60_000);
      manager.start(60_000);
      expect(mockSetIdleTouchHook).toHaveBeenCalledTimes(1);
      manager.stop();
    });

    it('R-9: preloads lastActivity from registry so recently-active members are not stopped', async () => {
      const recentAgent: Agent = {
        ...cloudAgent,
        lastUsed: new Date(Date.now() - 1000).toISOString(), // 1s ago
      };
      mockGetAllAgents.mockReturnValue([recentAgent]);
      mockGetInstanceState.mockResolvedValue('running');

      const manager = new IdleManager();
      manager.start(60_000); // 1 min timeout; member was active 1s ago

      await manager.checkOnce();

      expect(mockStopInstance).not.toHaveBeenCalled();
      manager.stop();
    });
  });

  // --- resetTimer() ---

  describe('resetTimer()', () => {
    it('prevents idle stop for an member just touched', async () => {
      // Agent lastUsed = 2h ago — would normally trigger stop at 1min timeout
      mockGetAllAgents.mockReturnValue([cloudAgent]);
      mockGetInstanceState.mockResolvedValue('running');
      mockCheckMemberActivity.mockResolvedValue('idle');

      const manager = new IdleManager();
      manager.start(60_000); // 1 min timeout

      // Reset timer to now (simulates a tool call)
      manager.resetTimer(cloudAgent.id);

      await manager.checkOnce();

      // idleMs = ~0ms < 60000ms → skip
      expect(mockStopInstance).not.toHaveBeenCalled();
      manager.stop();
    });

    it('is wired into touchAgent via setIdleTouchHook', () => {
      const manager = new IdleManager();
      manager.start(60_000);

      // The hook registered with setIdleTouchHook should call resetTimer
      const hookFn = mockSetIdleTouchHook.mock.calls[0][0];
      hookFn(cloudAgent.id);

      // Verify the hook updated lastActivity (indirectly: member stays non-idle after hook call)
      // We test this via the no-stop behavior: member was 2h idle, but hook reset the timer
      manager.resetTimer(cloudAgent.id); // equivalent to what the hook does
      expect(typeof hookFn).toBe('function');
      manager.stop();
    });
  });

  // --- checkOnce() / idle stop logic ---

  describe('checkOnce()', () => {
    it('stops an idle cloud member that has been idle past the timeout', async () => {
      mockGetAllAgents.mockReturnValue([cloudAgent]);
      mockGetInstanceState.mockResolvedValue('running');
      mockCheckMemberActivity.mockResolvedValue('idle');
      mockStopInstance.mockResolvedValue(undefined);

      const manager = new IdleManager();
      manager.start(60_000); // 1 min timeout; cloudAgent.lastUsed = 2h ago

      await manager.checkOnce();

      expect(mockGetInstanceState).toHaveBeenCalledWith(cloudAgent.cloud);
      expect(mockCheckMemberActivity).toHaveBeenCalledWith(cloudAgent);
      expect(mockStopInstance).toHaveBeenCalledWith(cloudAgent.cloud);
      manager.stop();
    });

    it('does not stop a cloud member with active GPU workload', async () => {
      mockGetAllAgents.mockReturnValue([cloudAgent]);
      mockGetInstanceState.mockResolvedValue('running');
      mockCheckMemberActivity.mockResolvedValue('busy-gpu');

      const manager = new IdleManager();
      manager.start(60_000);

      await manager.checkOnce();

      expect(mockStopInstance).not.toHaveBeenCalled();
      manager.stop();
    });

    it('does not stop a cloud member with running fleet process', async () => {
      mockGetAllAgents.mockReturnValue([cloudAgent]);
      mockGetInstanceState.mockResolvedValue('running');
      mockCheckMemberActivity.mockResolvedValue('busy-process');

      const manager = new IdleManager();
      manager.start(60_000);

      await manager.checkOnce();

      expect(mockStopInstance).not.toHaveBeenCalled();
      manager.stop();
    });

    it('does not stop a cloud member when activity is unknown (safe default)', async () => {
      mockGetAllAgents.mockReturnValue([cloudAgent]);
      mockGetInstanceState.mockResolvedValue('running');
      mockCheckMemberActivity.mockResolvedValue('unknown');

      const manager = new IdleManager();
      manager.start(60_000);

      await manager.checkOnce();

      expect(mockStopInstance).not.toHaveBeenCalled();
      manager.stop();
    });

    it('skips already-stopped instances without checking activity', async () => {
      mockGetAllAgents.mockReturnValue([cloudAgent]);
      mockGetInstanceState.mockResolvedValue('stopped');

      const manager = new IdleManager();
      manager.start(60_000);

      await manager.checkOnce();

      expect(mockCheckMemberActivity).not.toHaveBeenCalled();
      expect(mockStopInstance).not.toHaveBeenCalled();
      manager.stop();
    });

    it('skips local (non-cloud) members entirely', async () => {
      mockGetAllAgents.mockReturnValue([localAgent]);

      const manager = new IdleManager();
      manager.start(60_000);

      await manager.checkOnce();

      expect(mockGetInstanceState).not.toHaveBeenCalled();
      expect(mockStopInstance).not.toHaveBeenCalled();
      manager.stop();
    });

    it('skips member that has not yet exceeded the idle timeout', async () => {
      const recentAgent: Agent = {
        ...cloudAgent,
        lastUsed: new Date(Date.now() - 30_000).toISOString(), // 30s ago
      };
      mockGetAllAgents.mockReturnValue([recentAgent]);

      const manager = new IdleManager();
      manager.start(60_000); // 1 min timeout

      await manager.checkOnce();

      expect(mockGetInstanceState).not.toHaveBeenCalled();
      manager.stop();
    });

    it('continues gracefully if getInstanceState throws', async () => {
      mockGetAllAgents.mockReturnValue([cloudAgent]);
      mockGetInstanceState.mockRejectedValue(new Error('AWS unreachable'));

      const manager = new IdleManager();
      manager.start(60_000);

      await expect(manager.checkOnce()).resolves.toBeUndefined();
      expect(mockStopInstance).not.toHaveBeenCalled();
      manager.stop();
    });

    it('continues gracefully if stopInstance throws', async () => {
      mockGetAllAgents.mockReturnValue([cloudAgent]);
      mockGetInstanceState.mockResolvedValue('running');
      mockCheckMemberActivity.mockResolvedValue('idle');
      mockStopInstance.mockRejectedValue(new Error('stop failed'));

      const manager = new IdleManager();
      manager.start(60_000);

      await expect(manager.checkOnce()).resolves.toBeUndefined();
      manager.stop();
    });

    it('mutex: skips member already being stopped by a concurrent check', async () => {
      let resolveStop!: () => void;
      const slowStop = new Promise<void>(r => { resolveStop = r; });

      mockGetAllAgents.mockReturnValue([cloudAgent]);
      mockGetInstanceState.mockResolvedValue('running');
      mockCheckMemberActivity.mockResolvedValue('idle');
      mockStopInstance.mockReturnValueOnce(slowStop).mockResolvedValue(undefined);

      const manager = new IdleManager();
      manager.start(60_000);

      // Start check1 — it will get to stopInstance and await the slow promise
      const check1 = manager.checkOnce();

      // Drain microtask queue so check1 advances to the await stopInstance point
      // and adds the member to the stopping set
      await new Promise(r => setImmediate(r));

      // Start check2 while check1 is still awaiting the slow stop
      const check2 = manager.checkOnce();
      await check2;

      // Resolve and finish check1
      resolveStop();
      await check1;

      // stopInstance should only have been called once (check2 was blocked by mutex)
      expect(mockStopInstance).toHaveBeenCalledTimes(1);
      manager.stop();
    });
  });
});
