/**
 * T4 (PR#2): Unit tests for F5 re-provisioning in ensureCloudReady.
 * Tests that auth credentials are re-provisioned after a cloud instance starts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { invalidatePreflightCache } from '../src/services/preflight-check.js';

// tests/setup.ts globally mocks preflight-check.js with vi.fn() implementations
const mockInvalidatePreflightCache = vi.mocked(invalidatePreflightCache);

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockGetInstanceState, mockStartInstance, mockWaitForRunning, mockGetPublicIp,
        mockProvisionAuth, mockProvisionVcsAuth, mockCreateConnection } = vi.hoisted(() => ({
  mockGetInstanceState: vi.fn(),
  mockStartInstance: vi.fn().mockResolvedValue(undefined),
  mockWaitForRunning: vi.fn().mockResolvedValue(undefined),
  mockGetPublicIp: vi.fn().mockResolvedValue('1.2.3.4'),
  mockProvisionAuth: vi.fn(),
  mockProvisionVcsAuth: vi.fn(),
  mockCreateConnection: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Provisioning result doubles
//
// provisionAuth/provisionVcsAuth return `{ text, structuredContent }`, NOT a
// bare string: reProvisionAuth branches on `structuredContent.ok`. A double
// that still resolves to a plain string makes the ok-read dereference
// undefined, and reProvisionAuth's best-effort catch swallows the resulting
// TypeError -- the suite stays green while the real code path throws on every
// call. Keep these shapes in sync with ProvisionAuthResult
// (src/tools/provision-auth.ts) and ProvisionVcsAuthResult
// (src/tools/provision-vcs-auth.ts).
// ---------------------------------------------------------------------------

function authOk() {
  return {
    text: '[OK] Auth provisioned',
    structuredContent: {
      ok: true, reason: 'ok', provider: 'claude', credentialLabel: 'oauth',
      expiresAt: null, verified: true, memberId: 'm1', memberName: 'Test Member',
    },
  };
}

function authFail() {
  return {
    text: '[FAIL] Auth deploy failed\nmore detail',
    structuredContent: {
      ok: false, reason: 'oauth_credential_write_failed', provider: 'claude',
      credentialLabel: null, expiresAt: null, verified: false,
      memberId: 'm1', memberName: 'Test Member',
    },
  };
}

function vcsOk() {
  return {
    text: '[OK] VCS auth provisioned',
    structuredContent: {
      ok: true, reason: 'ok', provider: 'github', credentialLabel: 'github',
      scopeUrl: 'https://github.com', expiresAt: null, verified: true,
      verificationSkipped: false, metadata: { token: 'ghs_****' },
      expiryWarning: null, memberId: 'm1', memberName: 'Test Member',
    },
  };
}

function vcsFail() {
  return {
    text: '[FAIL] VCS auth deploy failed\nmore detail',
    structuredContent: {
      ok: false, reason: 'deploy_failed', provider: 'github', credentialLabel: 'github',
      scopeUrl: null, expiresAt: null, verified: false, verificationSkipped: false,
      metadata: null, expiryWarning: null, memberId: 'm1', memberName: 'Test Member',
    },
  };
}

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
    mockProvisionAuth.mockResolvedValue(authOk());
    mockProvisionVcsAuth.mockResolvedValue(vcsOk());
    mockSshReady();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('calls provisionAuth with member_id after instance starts', async () => {
    mockGetInstanceState.mockResolvedValue('stopped');
    const member = makeStoppedCloudAgent();
    addAgent(member);

    const { ensureCloudReady } = await import('../src/services/cloud/lifecycle.js');
    await ensureCloudReady(member);

    expect(mockProvisionAuth).toHaveBeenCalledOnce();
    expect(mockProvisionAuth).toHaveBeenCalledWith(
      expect.objectContaining({ member_id: member.id }),
    );
  });

  it('does NOT call provisionVcsAuth when member has no git repos', async () => {
    mockGetInstanceState.mockResolvedValue('stopped');
    const member = makeStoppedCloudAgent({ gitAccess: undefined, gitRepos: undefined });
    addAgent(member);

    const { ensureCloudReady } = await import('../src/services/cloud/lifecycle.js');
    await ensureCloudReady(member);

    expect(mockProvisionVcsAuth).not.toHaveBeenCalled();
  });

  it('calls provisionVcsAuth with gitAccess + gitRepos when member has git repos', async () => {
    mockGetInstanceState.mockResolvedValue('stopped');
    const member = makeStoppedCloudAgent({
      gitAccess: 'push',
      gitRepos: ['Apra-Labs/apra-fleet'],
    });
    addAgent(member);

    const { ensureCloudReady } = await import('../src/services/cloud/lifecycle.js');
    await ensureCloudReady(member);

    expect(mockProvisionVcsAuth).toHaveBeenCalledOnce();
    expect(mockProvisionVcsAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        member_id: member.id,
        provider: 'github',
        git_access: 'push',
        repos: ['Apra-Labs/apra-fleet'],
      }),
    );
  });

  it('does not throw when provisionAuth fails (best-effort)', async () => {
    mockGetInstanceState.mockResolvedValue('stopped');
    mockProvisionAuth.mockRejectedValue(new Error('auth server unavailable'));
    const member = makeStoppedCloudAgent();
    addAgent(member);

    const { ensureCloudReady } = await import('../src/services/cloud/lifecycle.js');
    // Should not throw even though provisionAuth failed
    await expect(ensureCloudReady(member)).resolves.toBeDefined();
  });

  it('does not throw when provisionVcsAuth fails (best-effort)', async () => {
    mockGetInstanceState.mockResolvedValue('stopped');
    mockProvisionVcsAuth.mockRejectedValue(new Error('github app error'));
    const member = makeStoppedCloudAgent({
      gitAccess: 'read',
      gitRepos: ['Apra-Labs/apra-fleet'],
    });
    addAgent(member);

    const { ensureCloudReady } = await import('../src/services/cloud/lifecycle.js');
    await expect(ensureCloudReady(member)).resolves.toBeDefined();
  });

  it('skips re-provisioning when instance is already running', async () => {
    mockGetInstanceState.mockResolvedValue('running');
    mockGetPublicIp.mockResolvedValue('1.2.3.4');
    const member = makeStoppedCloudAgent({ host: '1.2.3.4' });
    addAgent(member);

    const { ensureCloudReady } = await import('../src/services/cloud/lifecycle.js');
    await ensureCloudReady(member);

    // No re-provisioning for already-running instances
    expect(mockProvisionAuth).not.toHaveBeenCalled();
    expect(mockProvisionVcsAuth).not.toHaveBeenCalled();
  });

  // ---- invalidatePreflightCache on host/IP identity changes ----
  it('invalidates the preflight cache after starting a stopped instance (new IP)', async () => {
    mockGetInstanceState.mockResolvedValue('stopped');
    mockGetPublicIp.mockResolvedValue('1.2.3.4');
    const member = makeStoppedCloudAgent({ host: '10.0.0.1' });
    addAgent(member);

    const { ensureCloudReady } = await import('../src/services/cloud/lifecycle.js');
    await ensureCloudReady(member);

    expect(mockInvalidatePreflightCache).toHaveBeenCalledWith(member.id);
  });

  it('invalidates the preflight cache when a running instance IP changes', async () => {
    mockGetInstanceState.mockResolvedValue('running');
    mockGetPublicIp.mockResolvedValue('5.6.7.8'); // different from member.host
    const member = makeStoppedCloudAgent({ host: '1.2.3.4' });
    addAgent(member);

    const { ensureCloudReady } = await import('../src/services/cloud/lifecycle.js');
    await ensureCloudReady(member);

    expect(mockInvalidatePreflightCache).toHaveBeenCalledWith(member.id);
  });

  it('does not invalidate the preflight cache when a running instance IP is unchanged', async () => {
    mockGetInstanceState.mockResolvedValue('running');
    mockGetPublicIp.mockResolvedValue('1.2.3.4'); // same as member.host
    const member = makeStoppedCloudAgent({ host: '1.2.3.4' });
    addAgent(member);

    const { ensureCloudReady } = await import('../src/services/cloud/lifecycle.js');
    await ensureCloudReady(member);

    expect(mockInvalidatePreflightCache).not.toHaveBeenCalled();
  });

  // ---- structured ok/failed discriminator drives the warning log ----
  // These are the tests that catch a stale string-shaped double: with the old
  // `'auth provisioned'` mocks, reading `.ok` throws inside the best-effort
  // catch, so the ok:true case emits a 'provision_llm_auth failed ... Cannot
  // read properties of undefined' line and the ok:false case emits the wrong
  // line -- both assertions below fail.

  function captureStderr(): { lines: () => string[]; restore: () => void } {
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    return { lines: () => written, restore: () => spy.mockRestore() };
  }

  it('logs NO provisioning warning when both tools report structured ok:true', async () => {
    mockGetInstanceState.mockResolvedValue('stopped');
    const member = makeStoppedCloudAgent({ gitAccess: 'push', gitRepos: ['Apra-Labs/apra-fleet'] });
    addAgent(member);

    const stderr = captureStderr();
    try {
      const { ensureCloudReady } = await import('../src/services/cloud/lifecycle.js');
      await ensureCloudReady(member);
    } finally {
      stderr.restore();
    }

    expect(mockProvisionAuth).toHaveBeenCalledOnce();
    expect(mockProvisionVcsAuth).toHaveBeenCalledOnce();
    const provisionLines = stderr.lines().filter(l => l.includes('provision_'));
    expect(provisionLines).toEqual([]);
  });

  it('logs a warning carrying the summary line when provisionAuth reports ok:false', async () => {
    mockGetInstanceState.mockResolvedValue('stopped');
    mockProvisionAuth.mockResolvedValue(authFail());
    const member = makeStoppedCloudAgent();
    addAgent(member);

    const stderr = captureStderr();
    try {
      const { ensureCloudReady } = await import('../src/services/cloud/lifecycle.js');
      await ensureCloudReady(member);
    } finally {
      stderr.restore();
    }

    const warnings = stderr.lines().filter(l => l.includes('provision_llm_auth'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('provision_llm_auth warning for ' + member.friendlyName);
    expect(warnings[0]).toContain('[FAIL] Auth deploy failed');
    // Only the first prose line is logged, never the trailing detail.
    expect(warnings[0]).not.toContain('more detail');
  });

  it('logs a warning when provisionVcsAuth reports ok:false', async () => {
    mockGetInstanceState.mockResolvedValue('stopped');
    mockProvisionVcsAuth.mockResolvedValue(vcsFail());
    const member = makeStoppedCloudAgent({ gitAccess: 'push', gitRepos: ['Apra-Labs/apra-fleet'] });
    addAgent(member);

    const stderr = captureStderr();
    try {
      const { ensureCloudReady } = await import('../src/services/cloud/lifecycle.js');
      await ensureCloudReady(member);
    } finally {
      stderr.restore();
    }

    const warnings = stderr.lines().filter(l => l.includes('provision_vcs_auth'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('provision_vcs_auth warning for ' + member.friendlyName);
    expect(warnings[0]).toContain('[FAIL] VCS auth deploy failed');
  });

  it('does not throw or warn when a result carries no structuredContent (legacy shape)', async () => {
    mockGetInstanceState.mockResolvedValue('stopped');
    mockProvisionAuth.mockResolvedValue({ text: '[OK] Auth provisioned' });
    const member = makeStoppedCloudAgent();
    addAgent(member);

    const stderr = captureStderr();
    try {
      const { ensureCloudReady } = await import('../src/services/cloud/lifecycle.js');
      await expect(ensureCloudReady(member)).resolves.toBeDefined();
    } finally {
      stderr.restore();
    }

    expect(stderr.lines().filter(l => l.includes('provision_llm_auth'))).toEqual([]);
  });

  it('falls back to the [FAIL] prose marker when a result carries no structuredContent', async () => {
    mockGetInstanceState.mockResolvedValue('stopped');
    mockProvisionAuth.mockResolvedValue({ text: '[FAIL] Auth deploy failed' });
    const member = makeStoppedCloudAgent();
    addAgent(member);

    const stderr = captureStderr();
    try {
      const { ensureCloudReady } = await import('../src/services/cloud/lifecycle.js');
      await ensureCloudReady(member);
    } finally {
      stderr.restore();
    }

    const warnings = stderr.lines().filter(l => l.includes('provision_llm_auth'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('provision_llm_auth warning for ' + member.friendlyName);
  });
});
