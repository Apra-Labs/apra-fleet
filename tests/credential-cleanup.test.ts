import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Agent } from '../src/types.js';

const {
  mockGetAllAgents,
  mockTestConnection,
  mockExecCommand,
  mockRevoke,
} = vi.hoisted(() => ({
  mockGetAllAgents: vi.fn<() => Agent[]>(),
  mockTestConnection: vi.fn(),
  mockExecCommand: vi.fn(),
  mockRevoke: vi.fn(),
}));

vi.mock('../src/services/registry.js', () => ({
  getAllAgents: mockGetAllAgents,
}));

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    testConnection: mockTestConnection,
    execCommand: mockExecCommand,
  }),
}));

vi.mock('../src/os/index.js', () => ({
  getOsCommands: () => ({}),
}));

vi.mock('../src/utils/agent-helpers.js', () => ({
  getAgentOS: () => 'linux',
  touchAgent: vi.fn(),
  setIdleTouchHook: vi.fn(),
  getAgentOrFail: vi.fn(),
}));

vi.mock('../src/services/vcs/github.js', () => ({
  githubProvider: {
    revoke: mockRevoke,
    deploy: vi.fn(),
    testConnectivity: vi.fn(),
  },
}));
vi.mock('../src/services/vcs/bitbucket.js', () => ({
  bitbucketProvider: { revoke: vi.fn(), deploy: vi.fn(), testConnectivity: vi.fn() },
}));
vi.mock('../src/services/vcs/azure-devops.js', () => ({
  azureDevOpsProvider: { revoke: vi.fn(), deploy: vi.fn(), testConnectivity: vi.fn() },
}));

import { scheduleCredentialCleanup, cancelCredentialCleanup, _getCleanupTimers } from '../src/services/credential-cleanup.js';

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'member-1', friendlyName: 'test', agentType: 'remote',
    host: '1.2.3.4', port: 22, username: 'user', authType: 'key',
    workFolder: '/home/user', createdAt: new Date().toISOString(),
    vcsProvider: 'github',
    ...overrides,
  };
}

describe('scheduleCredentialCleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    for (const id of Array.from(_getCleanupTimers().keys())) cancelCredentialCleanup(id);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules a timer with default 55-minute TTL when no expiresAt', () => {
    scheduleCredentialCleanup('member-1');
    expect(_getCleanupTimers().has('member-1')).toBe(true);
  });

  it('schedules timer based on expiresAt', () => {
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    scheduleCredentialCleanup('member-1', expiresAt);
    expect(_getCleanupTimers().has('member-1')).toBe(true);
  });

  it('calls revoke when timer fires and member has vcsProvider', async () => {
    const member = makeAgent();
    mockGetAllAgents.mockReturnValue([member]);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 1 });
    mockRevoke.mockResolvedValue({ success: true, message: 'revoked' });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    scheduleCredentialCleanup('member-1');
    await vi.advanceTimersByTimeAsync(55 * 60 * 1000 + 1000);

    expect(mockRevoke).toHaveBeenCalledOnce();
    expect(_getCleanupTimers().has('member-1')).toBe(false);
  });

  it('does not call revoke when member has no vcsProvider', async () => {
    mockGetAllAgents.mockReturnValue([makeAgent({ vcsProvider: undefined })]);

    scheduleCredentialCleanup('member-1');
    await vi.advanceTimersByTimeAsync(55 * 60 * 1000 + 1000);

    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it('is silent when revoke throws', async () => {
    mockGetAllAgents.mockReturnValue([makeAgent()]);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 1 });
    mockRevoke.mockRejectedValue(new Error('network error'));

    scheduleCredentialCleanup('member-1');
    await expect(vi.advanceTimersByTimeAsync(55 * 60 * 1000 + 1000)).resolves.not.toThrow();
  });

  it('cancels previous timer when re-provisioning same member', () => {
    scheduleCredentialCleanup('member-1');
    const timer1 = _getCleanupTimers().get('member-1');

    scheduleCredentialCleanup('member-1');
    const timer2 = _getCleanupTimers().get('member-1');

    expect(timer2).not.toBe(timer1);
    expect(_getCleanupTimers().size).toBe(1);
  });

  it('multiple agents have independent timers', () => {
    scheduleCredentialCleanup('member-1');
    scheduleCredentialCleanup('member-2');

    expect(_getCleanupTimers().size).toBe(2);
    expect(_getCleanupTimers().has('member-1')).toBe(true);
    expect(_getCleanupTimers().has('member-2')).toBe(true);
  });
});

describe('cancelCredentialCleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    for (const id of Array.from(_getCleanupTimers().keys())) cancelCredentialCleanup(id);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancels the timer and removes from map', () => {
    scheduleCredentialCleanup('member-1');
    expect(_getCleanupTimers().has('member-1')).toBe(true);

    cancelCredentialCleanup('member-1');
    expect(_getCleanupTimers().has('member-1')).toBe(false);
  });

  it('does not throw when cancelling non-existent member', () => {
    expect(() => cancelCredentialCleanup('no-such-member')).not.toThrow();
  });

  it('prevents revoke from firing after cancellation', async () => {
    mockGetAllAgents.mockReturnValue([makeAgent()]);

    scheduleCredentialCleanup('member-1');
    cancelCredentialCleanup('member-1');

    await vi.advanceTimersByTimeAsync(55 * 60 * 1000 + 1000);

    expect(mockRevoke).not.toHaveBeenCalled();
  });
});
