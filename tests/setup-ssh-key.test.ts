import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { makeTestAgent, makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { setupSSHKey } from '../src/tools/setup-ssh-key.js';
import { invalidatePreflightCache } from '../src/services/preflight-check.js';

// tests/setup.ts globally mocks preflight-check.js with vi.fn() implementations
const mockInvalidatePreflightCache = vi.mocked(invalidatePreflightCache);

const mockExecCommand = vi.fn();
vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
  }),
}));

const mockTestAuthConnection = vi.fn();
vi.mock('../src/services/ssh.js', () => ({
  testAuthConnection: (...args: unknown[]) => mockTestAuthConnection(...args),
}));

describe('setupSSHKey', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    mockExecCommand.mockReset();
    mockTestAuthConnection.mockReset();
    mockInvalidatePreflightCache.mockClear();
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 }); // deploy commands succeed
    mockTestAuthConnection.mockResolvedValue({ stdout: 'key-auth-ok', stderr: '', code: 0 });
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('is a no-op for local members', async () => {
    const agent = makeTestLocalAgent();
    addAgent(agent);

    const result = await setupSSHKey({ member_id: agent.id });
    expect(result).toContain('not applicable for local members');
    expect(mockInvalidatePreflightCache).not.toHaveBeenCalled();
  });

  it('short-circuits when the member already uses key-based auth', async () => {
    const agent = makeTestAgent({ authType: 'key' });
    addAgent(agent);

    const result = await setupSSHKey({ member_id: agent.id });
    expect(result).toContain('already using key-based authentication');
    expect(mockInvalidatePreflightCache).not.toHaveBeenCalled();
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('generates a key pair, deploys it, verifies key auth, and invalidates the preflight cache on success', async () => {
    const agent = makeTestAgent({ authType: 'password' });
    addAgent(agent);

    const result = await setupSSHKey({ member_id: agent.id });

    expect(result).toContain('SSH key authentication set up');
    expect(mockExecCommand).toHaveBeenCalled(); // key deployment commands ran
    expect(mockTestAuthConnection).toHaveBeenCalledOnce(); // key-auth verification ran
    expect(mockInvalidatePreflightCache).toHaveBeenCalledWith(agent.id);
    expect(mockInvalidatePreflightCache).toHaveBeenCalledOnce();
  }, 20000);

  it('does NOT invalidate the preflight cache when key deployment fails', async () => {
    const agent = makeTestAgent({ authType: 'password' });
    addAgent(agent);
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: 'permission denied', code: 1 });

    const result = await setupSSHKey({ member_id: agent.id });

    expect(result).toContain('Failed to deploy key');
    expect(mockInvalidatePreflightCache).not.toHaveBeenCalled();
  }, 20000);

  it('does NOT invalidate the preflight cache when key-auth verification fails', async () => {
    const agent = makeTestAgent({ authType: 'password' });
    addAgent(agent);
    mockTestAuthConnection.mockResolvedValue({ stdout: 'permission denied', stderr: '', code: 1 });

    const result = await setupSSHKey({ member_id: agent.id });

    expect(result).toContain('Key-based authentication test failed');
    expect(mockInvalidatePreflightCache).not.toHaveBeenCalled();
  }, 20000);
});
