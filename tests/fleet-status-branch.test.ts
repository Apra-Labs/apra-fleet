import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { fleetStatus } from '../src/tools/check-status.js';
import * as logHelpers from '../src/utils/log-helpers.js';

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
    const member = makeTestAgent({ friendlyName: 'branch-member', lastBranch: 'feature/my-branch' });
    addAgent(member);

    const result = await fleetStatus({ format: 'compact' });
    expect(result).toContain('branch=feature/my-branch');
  });

  it('omits branch from compact output when lastBranch is not set', async () => {
    const member = makeTestAgent({ friendlyName: 'no-branch-member' });
    addAgent(member);

    const result = await fleetStatus({ format: 'compact' });
    expect(result).not.toContain('branch=');
  });
});

describe('fleetStatus log file reporting', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreRegistry();
    vi.restoreAllMocks();
  });

  it('compact output includes log= path when log file is available', async () => {
    vi.spyOn(logHelpers, 'getActiveLogFile').mockReturnValue('/tmp/fleet-99.log');
    const member = makeTestAgent({ friendlyName: 'log-member' });
    addAgent(member);

    const result = await fleetStatus({ format: 'compact' });
    expect(result).toContain('log=/tmp/fleet-99.log');
  });

  it('compact output omits log= when log file is null', async () => {
    vi.spyOn(logHelpers, 'getActiveLogFile').mockReturnValue(null);
    const member = makeTestAgent({ friendlyName: 'nolog-member' });
    addAgent(member);

    const result = await fleetStatus({ format: 'compact' });
    expect(result).not.toContain('log=');
  });

  it('JSON output includes logFile when log file is available', async () => {
    vi.spyOn(logHelpers, 'getActiveLogFile').mockReturnValue('/tmp/fleet-99.log');
    const member = makeTestAgent({ friendlyName: 'json-log-member' });
    addAgent(member);

    const result = await fleetStatus({ format: 'json' });
    const parsed = JSON.parse(result);
    expect(parsed.logFile).toBe('/tmp/fleet-99.log');
  });

  it('JSON output omits logFile when log file is null', async () => {
    vi.spyOn(logHelpers, 'getActiveLogFile').mockReturnValue(null);
    const member = makeTestAgent({ friendlyName: 'json-nolog-member' });
    addAgent(member);

    const result = await fleetStatus({ format: 'json' });
    const parsed = JSON.parse(result);
    expect(parsed.logFile).toBeUndefined();
  });
});
