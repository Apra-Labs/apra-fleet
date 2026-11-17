import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';

// T2.4 (F7, D6): fleet_status version handshake surfacing. Mocks
// version-check.js entirely (module-singleton pattern: vi.resetModules() +
// dynamic import per test) so these tests control match/mismatch/unreadable
// deterministically without touching real version.json or process state.
const mockCheckVersionMismatch = vi.fn();
vi.mock('../src/services/version-check.js', () => ({
  checkVersionMismatch: (...args: unknown[]) => mockCheckVersionMismatch(...args),
}));

vi.mock('../src/tools/kb-stats.js', () => ({
  kbStats: vi.fn().mockResolvedValue(JSON.stringify({
    totals: { by_confidence: { CONFIRMED: 0, INFERRED: 0, UNVERIFIED: 0 }, by_type: {}, total: 0 },
    stale: 0, flagged: 0, superseded: 0,
    retrieval: { entries_retrieved: 0, total_uses: 0, hit_rate: null },
    promote_ratio: null,
    bible: { present: false, entries: 0, drift: 0 },
  })),
}));

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: vi.fn().mockResolvedValue({ stdout: 'idle', stderr: '', code: 0 }),
    testConnection: vi.fn().mockResolvedValue({ ok: true, latencyMs: 5 }),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

describe('fleetStatus() version handshake section (T2.4, F7, D6)', () => {
  beforeEach(() => {
    vi.resetModules();
    backupAndResetRegistry();
    mockCheckVersionMismatch.mockReset();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('no warning in compact or json when versions match (checkVersionMismatch returns null)', async () => {
    mockCheckVersionMismatch.mockReturnValue(null);
    const { fleetStatus } = await import('../src/tools/check-status.js');
    addAgent(makeTestAgent({ friendlyName: 'version-match-member' }));

    const compact = await fleetStatus({ format: 'compact' });
    expect(compact).not.toContain('restart your MCP client');

    const json = JSON.parse(await fleetStatus({ format: 'json' }));
    expect(json.versionMismatch).toBeUndefined();
  });

  it('renders the exact D6 warning line and json field on mismatch', async () => {
    mockCheckVersionMismatch.mockReturnValue({ running: 'v1.0.0', disk: 'v1.1.0' });
    const { fleetStatus } = await import('../src/tools/check-status.js');
    addAgent(makeTestAgent({ friendlyName: 'version-mismatch-member' }));

    const compact = await fleetStatus({ format: 'compact' });
    expect(compact).toContain('server running v1.0.0, disk has v1.1.0 -- restart your MCP client');

    const json = JSON.parse(await fleetStatus({ format: 'json' }));
    expect(json.versionMismatch).toEqual({ running: 'v1.0.0', disk: 'v1.1.0' });
  });

  it('omits the field/line (never fails fleet_status) when checkVersionMismatch throws', async () => {
    mockCheckVersionMismatch.mockImplementation(() => { throw new Error('disk unreadable'); });
    const { fleetStatus } = await import('../src/tools/check-status.js');
    addAgent(makeTestAgent({ friendlyName: 'version-error-member' }));

    const compact = await fleetStatus({ format: 'compact' });
    expect(compact).not.toContain('restart your MCP client');
    expect(compact).toContain('version-error-member');

    const json = JSON.parse(await fleetStatus({ format: 'json' }));
    expect(json.versionMismatch).toBeUndefined();
    expect(json.summary.total).toBe(1);
  });
});
