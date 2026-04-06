import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { fleetStatus } from '../src/tools/check-status.js';

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: vi.fn().mockResolvedValue({ stdout: 'idle', stderr: '', code: 0 }),
    testConnection: vi.fn().mockResolvedValue({ ok: true, latencyMs: 5 }),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

describe('fleetStatus branch display', () => {
  beforeEach(() => {
    vi.resetModules();
    backupAndResetRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('shows cached lastBranch in compact output when set', async () => {
    const agent = makeTestAgent({ friendlyName: 'branch-member', lastBranch: 'feature/my-branch' });
    addAgent(agent);

    const result = await fleetStatus({ format: 'compact' });
    expect(result).toContain('branch=feature/my-branch');
  });

  it('omits branch from compact output when lastBranch is not set', async () => {
    const agent = makeTestAgent({ friendlyName: 'no-branch-member' });
    addAgent(agent);

    const result = await fleetStatus({ format: 'compact' });
    expect(result).not.toContain('branch=');
  });
});
