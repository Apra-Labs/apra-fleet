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
  getAgentShell: () => undefined,
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

  it('schedules no timer at all when no expiresAt is known (no blind default-TTL self-destruct)', () => {
    scheduleCredentialCleanup('member-1');
    expect(_getCleanupTimers().has('member-1')).toBe(false);
  });

  it('schedules no timer when expiresAt is unparseable', () => {
    scheduleCredentialCleanup('member-1', 'not-a-date');
    expect(_getCleanupTimers().has('member-1')).toBe(false);
  });

  it('schedules timer based on expiresAt', () => {
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    scheduleCredentialCleanup('member-1', expiresAt);
    expect(_getCleanupTimers().has('member-1')).toBe(true);
  });

  // apra-fleet-5co8.5.1: setTimeout's delay is a signed 32-bit int and Node
  // SILENTLY CLAMPS an overflowing one to ~1ms instead of firing it later, so
  // a 90-day Azure DevOps PAT would be auto-revoked moments after deployment.
  // Beyond the ceiling we schedule NOTHING and rely on checkVcsTokenExpiry's
  // day-scale warning plus reactive AUTH_EXPIRED classification instead.
  it('schedules no timer at all when expiresAt is beyond setTimeout\'s ~24.8-day ceiling', () => {
    const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    scheduleCredentialCleanup('member-1', expiresAt);
    expect(_getCleanupTimers().has('member-1')).toBe(false);
  });

  it('still schedules just inside the ceiling', () => {
    const expiresAt = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString();
    scheduleCredentialCleanup('member-1', expiresAt);
    expect(_getCleanupTimers().has('member-1')).toBe(true);
  });

  it('cancels an existing timer even when the new expiry is beyond the ceiling', () => {
    const nearExpiry = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    scheduleCredentialCleanup('member-1', nearExpiry);
    expect(_getCleanupTimers().has('member-1')).toBe(true);
    scheduleCredentialCleanup('member-1', new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString());
    expect(_getCleanupTimers().has('member-1')).toBe(false);
  });

  it('calls revoke when timer fires and member has vcsProvider', async () => {
    const member = makeAgent();
    mockGetAllAgents.mockReturnValue([member]);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 1 });
    mockRevoke.mockResolvedValue({ success: true, message: 'revoked' });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const expiresAt = new Date(Date.now() + 55 * 60 * 1000).toISOString();
    scheduleCredentialCleanup('member-1', expiresAt);
    await vi.advanceTimersByTimeAsync(55 * 60 * 1000 + 1000);

    expect(mockRevoke).toHaveBeenCalledOnce();
    expect(_getCleanupTimers().has('member-1')).toBe(false);
  });

  it('threads the agent\'s persisted vcsCredentialLabel/vcsCredentialScopeUrl into revoke, not an unlabeled/default-host guess', async () => {
    const member = makeAgent({ vcsCredentialLabel: 'work-github', vcsCredentialScopeUrl: 'https://github.com/my-org' });
    mockGetAllAgents.mockReturnValue([member]);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 1 });
    mockRevoke.mockResolvedValue({ success: true, message: 'revoked' });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const expiresAt = new Date(Date.now() + 55 * 60 * 1000).toISOString();
    scheduleCredentialCleanup('member-1', expiresAt);
    await vi.advanceTimersByTimeAsync(55 * 60 * 1000 + 1000);

    expect(mockRevoke).toHaveBeenCalledWith(member, {}, expect.any(Function), 'work-github', 'https://github.com/my-org');
  });

  it('does not call revoke when member has no vcsProvider', async () => {
    mockGetAllAgents.mockReturnValue([makeAgent({ vcsProvider: undefined })]);

    const expiresAt = new Date(Date.now() + 55 * 60 * 1000).toISOString();
    scheduleCredentialCleanup('member-1', expiresAt);
    await vi.advanceTimersByTimeAsync(55 * 60 * 1000 + 1000);

    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it('is silent when revoke throws', async () => {
    mockGetAllAgents.mockReturnValue([makeAgent()]);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 1 });
    mockRevoke.mockRejectedValue(new Error('network error'));

    const expiresAt = new Date(Date.now() + 55 * 60 * 1000).toISOString();
    scheduleCredentialCleanup('member-1', expiresAt);
    await expect(vi.advanceTimersByTimeAsync(55 * 60 * 1000 + 1000)).resolves.not.toThrow();
  });

  it('cancels previous timer when re-provisioning same member', () => {
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    scheduleCredentialCleanup('member-1', expiresAt);
    const timer1 = _getCleanupTimers().get('member-1');

    scheduleCredentialCleanup('member-1', expiresAt);
    const timer2 = _getCleanupTimers().get('member-1');

    expect(timer2).not.toBe(timer1);
    expect(_getCleanupTimers().size).toBe(1);
  });

  it('multiple agents have independent timers', () => {
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    scheduleCredentialCleanup('member-1', expiresAt);
    scheduleCredentialCleanup('member-2', expiresAt);

    expect(_getCleanupTimers().size).toBe(2);
    expect(_getCleanupTimers().has('member-1')).toBe(true);
    expect(_getCleanupTimers().has('member-2')).toBe(true);
  });

  // Core regression scenario for the "silently clobbers a valid credential"
  // bug: two credentials (different labels) deployed to the same member on
  // the same host. Credential A's cleanup timer firing must revoke ONLY A's
  // label/scopeUrl -- it must never touch B's still-valid registration. This
  // test asserts the call-site contract (the exact label/scopeUrl revoke is
  // invoked with); the credential-file/config-key isolation itself is
  // asserted independently in tests/os/linux-credential-helper.test.ts (or
  // equivalent OS command builder tests) by comparing the two commands.
  it('cleanup for credential A never carries credential B\'s label/scopeUrl, even when both target the same host', async () => {
    const credA = makeAgent({ id: 'member-1', vcsCredentialLabel: 'label-a', vcsCredentialScopeUrl: 'https://github.com' });
    mockGetAllAgents.mockReturnValue([credA]);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 1 });
    mockRevoke.mockResolvedValue({ success: true, message: 'revoked' });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    scheduleCredentialCleanup('member-1', expiresAt);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 1000);

    const [, , , calledLabel, calledScopeUrl] = mockRevoke.mock.calls[0];
    expect(calledLabel).toBe('label-a');
    expect(calledLabel).not.toBe('label-b');
    expect(calledScopeUrl).toBe('https://github.com');
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
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    scheduleCredentialCleanup('member-1', expiresAt);
    expect(_getCleanupTimers().has('member-1')).toBe(true);

    cancelCredentialCleanup('member-1');
    expect(_getCleanupTimers().has('member-1')).toBe(false);
  });

  it('does not throw when cancelling non-existent member', () => {
    expect(() => cancelCredentialCleanup('no-such-member')).not.toThrow();
  });

  it('prevents revoke from firing after cancellation', async () => {
    mockGetAllAgents.mockReturnValue([makeAgent()]);

    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    scheduleCredentialCleanup('member-1', expiresAt);
    cancelCredentialCleanup('member-1');

    await vi.advanceTimersByTimeAsync(55 * 60 * 1000 + 1000);

    expect(mockRevoke).not.toHaveBeenCalled();
  });
});
