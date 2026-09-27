import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { FLEET_DIR } from '../src/paths.js';

// apra-fleet-i9ag.14.6: verification for the "Data dir: -" half of the parent
// bug. fleetStatus()'s json payload used to have no dataDir field at all --
// the zero-members early return didn't even carry logFile -- so a fresh
// install's console Health page fell through to "-". These assertions must
// FAIL against pre-fix check-status.ts (no `dataDir` in either json branch)
// and PASS once i9ag.14.4's fix lands.
//
// kb-stats.js and strategy.js are mocked (mirrors fleet-status-version-
// check.test.ts) so this file never depends on node:sqlite/FTS5 and does not
// need to join the vitest.config.ts NODE_SQLITE_DEPENDENT_TESTS exclusion
// list the way fleet-status-branch.test.ts (which does NOT mock kb-stats.js)
// does.
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

describe('fleetStatus() json payload dataDir field (apra-fleet-i9ag.14)', () => {
  beforeEach(() => {
    vi.resetModules();
    backupAndResetRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('is present and equal to the resolved data dir on the zero-members early-return branch (fresh install)', async () => {
    const { fleetStatus } = await import('../src/tools/check-status.js');

    const result = await fleetStatus({ format: 'json' });
    const parsed = JSON.parse(result);

    expect(parsed.members).toEqual([]);
    expect(parsed.summary).toEqual({ total: 0, online: 0, offline: 0 });
    expect(typeof parsed.dataDir).toBe('string');
    expect(parsed.dataDir).toBe(FLEET_DIR);
  });

  it('is present with the same value when at least one member is registered', async () => {
    const { fleetStatus } = await import('../src/tools/check-status.js');
    addAgent(makeTestAgent({ friendlyName: 'datadir-member' }));

    const result = await fleetStatus({ format: 'json' });
    const parsed = JSON.parse(result);

    expect(parsed.summary.total).toBe(1);
    expect(parsed.dataDir).toBe(FLEET_DIR);
  });

  it('tracks APRA_FLEET_DATA_DIR when set, on a fresh module load (FLEET_DIR is resolved at import time)', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-datadir-test-'));
    const previousEnv = process.env.APRA_FLEET_DATA_DIR;
    process.env.APRA_FLEET_DATA_DIR = tempDir;

    try {
      vi.resetModules();
      const freshPaths = await import('../src/paths.js');
      expect(freshPaths.FLEET_DIR).toBe(tempDir);

      const { fleetStatus: freshFleetStatus } = await import('../src/tools/check-status.js');
      const result = await freshFleetStatus({ format: 'json' });
      const parsed = JSON.parse(result);

      expect(parsed.dataDir).toBe(tempDir);
    } finally {
      if (previousEnv === undefined) {
        delete process.env.APRA_FLEET_DATA_DIR;
      } else {
        process.env.APRA_FLEET_DATA_DIR = previousEnv;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
      vi.resetModules();
    }
  });

  it('compact format (default or explicit) carries no dataDir key and is otherwise unchanged', async () => {
    const { fleetStatus } = await import('../src/tools/check-status.js');
    addAgent(makeTestAgent({ friendlyName: 'compact-member' }));

    const explicitCompact = await fleetStatus({ format: 'compact' });
    expect(explicitCompact).not.toContain('dataDir');
    expect(explicitCompact).toContain('compact-member');

    const defaultFormat = await fleetStatus();
    expect(defaultFormat).not.toContain('dataDir');
    expect(defaultFormat).toContain('compact-member');
  });
});
