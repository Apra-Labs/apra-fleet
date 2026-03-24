/**
 * T4 (PR#2): Unit tests for F5 re-provisioning in ensureCloudReady.
 * Tests that auth credentials are re-provisioned after a cloud instance starts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockGetInstanceState, mockStartInstance, mockWaitForRunning, mockGetPublicIp,
        mockProvisionAuth, mockProvisionVcsAuth, mockCreateConnection } = vi.hoisted(() => ({
  mockGetInstanceState: vi.fn(),
  mockStartInstance: vi.fn().mockResolvedValue(undefined),
  mockWaitForRunning: vi.fn().mockResolvedValue(undefined),
  mockGetPublicIp: vi.fn().mockResolvedValue('1.2.3.4'),
  mockProvisionAuth: vi.fn().mockResolvedValue('✅ auth provisioned'),
  mockProvisionVcsAuth: vi.fn().mockResolvedValue('✅ vcs auth provisioned'),
  mockCreateConnection: vi.fn(),
}));

vi.mock('../src/services/cloud/aws.js', () => ({
  awsProvider: {
    getInstanceState: mockGetInstanceState,
    startInstance: mockStartInstance,
    waitForRunning: mockWaitForRunning,
    waitForStopped: vi.fn().mockResolvedValue(undefined),
    getPublicIp: mockGetPublicIp,
    getInstanceDetails: vi.fn(),
  },
}));

vi.mock('../src/tools/provision-auth.js', () => ({
  provisionAuth: mockProvisionAuth,
}));

vi.mock('../src/tools/provision-vcs-auth.js', () => ({
  provisionVcsAuth: mockProvisionVcsAuth,
}));

vi.mock('node:net', () => ({
  default: {
    createConnection: mockCreateConnection,
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeStoppedCloudAgent(overrides = {}) {
  return makeTestAgent({
    host: '10.0.0.1',
    port: 22,
    cloud: {
      provider: 'aws' as const,
      instanceId: 'i-0abc1234def567890',
      region: 'us-east-1',
      idleTimeoutMin: 30,
      sshKeyPath: '/home/user/.ssh/key.pem',
    },
    ...overrides,
  });
}

function mockSshReady(): void {
  // SSH poll: createConnection resolves immediately (port is open)
  mockCreateConnection.mockImplementation((_opts: object) => {
    const handlers: Record<string, (() => void)[]> = {};
    const socket = {
      on: (event: string, handler: () => void) => {
        handlers[event] = handlers[event] ?? [];
        handlers[event].push(handler);
        // Fire 'connect' immediately
        if (event === 'connect') setImmediate(handler);
        return socket;
      },
      destroy: vi.fn(),
    };
    return socket;
  });
}

// ---------------------------------------------------------------------------
// F5 re-provisioning tests
// ---------------------------------------------------------------------------

describe('ensureCloudReady - F5 re-provisioning after start', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    mockStartInstance.mockResolvedValue(undefined);
    mockWaitForRunning.mockResolvedValue(undefined);
    mockGetPublicIp.mockResolvedValue('1.2.3.4');
    mockProvisionAuth.mockResolvedValue('✅ auth provisioned');
    mockProvisionVcsAuth.mockResolvedValue('✅ vcs auth provisioned');
    mockSshReady();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('calls provisionAuth with member_id after instance starts', async () => {
    mockGetInstanceState.mockResolvedValue('stopped');
    const agent = makeStoppedCloudAgent();
    addAgent(agent);

    const { ensureCloudReady } = await import('../src/services/cloud/lifecycle.js');
    await ensureCloudReady(agent);

    expect(mockProvisionAuth).toHaveBeenCalledOnce();
    expect(mockProvisionAuth).toHaveBeenCalledWith(
      expect.objectContaining({ member_id: agent.id }),
    );
  });

  it('does NOT call provisionVcsAuth when agent has no git repos', async () => {
    mockGetInstanceState.mockResolvedValue('stopped');
    const agent = makeStoppedCloudAgent({ gitAccess: undefined, gitRepos: undefined });
    addAgent(agent);

    const { ensureCloudReady } = await import('../src/services/cloud/lifecycle.js');
    await ensureCloudReady(agent);

    expect(mockProvisionVcsAuth).not.toHaveBeenCalled();
  });

  it('calls provisionVcsAuth with gitAccess + gitRepos when agent has git repos', async () => {
    mockGetInstanceState.mockResolvedValue('stopped');
    const agent = makeStoppedCloudAgent({
      gitAccess: 'push',
      gitRepos: ['Apra-Labs/apra-fleet'],
    });
    addAgent(agent);

    const { ensureCloudReady } = await import('../src/services/cloud/lifecycle.js');
    await ensureCloudReady(agent);

    expect(mockProvisionVcsAuth).toHaveBeenCalledOnce();
    expect(mockProvisionVcsAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        member_id: agent.id,
        provider: 'github',
        git_access: 'push',
        repos: ['Apra-Labs/apra-fleet'],
      }),
    );
  });

  it('does not throw when provisionAuth fails (best-effort)', async () => {
    mockGetInstanceState.mockResolvedValue('stopped');
    mockProvisionAuth.mockRejectedValue(new Error('auth server unavailable'));
    const agent = makeStoppedCloudAgent();
    addAgent(agent);

    const { ensureCloudReady } = await import('../src/services/cloud/lifecycle.js');
    // Should not throw even though provisionAuth failed
    await expect(ensureCloudReady(agent)).resolves.toBeDefined();
  });

  it('does not throw when provisionVcsAuth fails (best-effort)', async () => {
    mockGetInstanceState.mockResolvedValue('stopped');
    mockProvisionVcsAuth.mockRejectedValue(new Error('github app error'));
    const agent = makeStoppedCloudAgent({
      gitAccess: 'read',
      gitRepos: ['Apra-Labs/apra-fleet'],
    });
    addAgent(agent);

    const { ensureCloudReady } = await import('../src/services/cloud/lifecycle.js');
    await expect(ensureCloudReady(agent)).resolves.toBeDefined();
  });

  it('skips re-provisioning when instance is already running', async () => {
    mockGetInstanceState.mockResolvedValue('running');
    mockGetPublicIp.mockResolvedValue('1.2.3.4');
    const agent = makeStoppedCloudAgent({ host: '1.2.3.4' });
    addAgent(agent);

    const { ensureCloudReady } = await import('../src/services/cloud/lifecycle.js');
    await ensureCloudReady(agent);

    // No re-provisioning for already-running instances
    expect(mockProvisionAuth).not.toHaveBeenCalled();
    expect(mockProvisionVcsAuth).not.toHaveBeenCalled();
  });
});
