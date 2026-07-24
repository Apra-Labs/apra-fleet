import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';

// T2.2 (F5/F6, D4/D5 amended): fleet_status KB health surfacing. Mocks
// kb-stats.js entirely so these tests never touch a real kb.sqlite (the same
// real-KB-leak class of bug the T1.6 doer flagged in kb-session-prime.test.ts,
// yashr-bwc) -- fleetStatus() must never depend on this machine's actual KB
// state to pass.
const mockKbStats = vi.fn();
vi.mock('../src/tools/kb-stats.js', () => ({
  kbStats: (input: unknown) => mockKbStats(input),
}));

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: vi.fn().mockResolvedValue({ stdout: 'idle', stderr: '', code: 0 }),
    testConnection: vi.fn().mockResolvedValue({ ok: true, latencyMs: 5 }),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

function healthyKbStatsPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    totals: {
      by_confidence: { CONFIRMED: 10, INFERRED: 5, UNVERIFIED: 2 },
      by_type: { 'context-cache': 1, learning: 2, knowledge: 10, runbook: 2, 'user-directive': 2 },
      total: 17,
    },
    stale: 1,
    flagged: 2,
    superseded: 3,
    retrieval: { entries_retrieved: 8, total_uses: 40, hit_rate: 0.6543 },
    promote_ratio: 0.8,
    bible: { present: true, entries: 10, drift: 0 },
    ...overrides,
  });
}

describe('kbHealthCompactLine (T2.2)', () => {
  it('renders totals/stale/flagged/hit-rate/promote-ratio without a drift fragment when drift is 0', async () => {
    const { kbHealthCompactLine } = await import('../src/tools/check-status.js');
    const health = JSON.parse(healthyKbStatsPayload());
    const line = kbHealthCompactLine(health);
    expect(line).toBe('kb: 17 entries (confirmed:10 stale:1 flagged:2) | hit-rate:65% | promote-ratio:80%');
    expect(line).not.toContain('bible:');
  });

  it('renders the exact D5-amended anomaly wording when drift > 0', async () => {
    const { kbHealthCompactLine } = await import('../src/tools/check-status.js');
    const health = JSON.parse(healthyKbStatsPayload({ bible: { present: true, entries: 5, drift: 3 } }));
    const line = kbHealthCompactLine(health);
    expect(line).toContain('bible: 3 promotions behind (auto-commit may have failed -- run apra-fleet kb commit)');
  });

  it('renders n/a for null hit_rate and promote_ratio (empty KB)', async () => {
    const { kbHealthCompactLine } = await import('../src/tools/check-status.js');
    const health = JSON.parse(healthyKbStatsPayload({
      retrieval: { entries_retrieved: 0, total_uses: 0, hit_rate: null },
      promote_ratio: null,
    }));
    const line = kbHealthCompactLine(health);
    expect(line).toContain('hit-rate:n/a');
    expect(line).toContain('promote-ratio:n/a');
  });

  it('bible present false with drift > 0 still renders the anomaly fragment', async () => {
    const { kbHealthCompactLine } = await import('../src/tools/check-status.js');
    const health = JSON.parse(healthyKbStatsPayload({ bible: { present: false, entries: 0, drift: 4 } }));
    const line = kbHealthCompactLine(health);
    expect(line).toContain('bible: 4 promotions behind');
  });
});

describe('kbHealthSummary (T2.2, degraded-safe)', () => {
  beforeEach(() => {
    mockKbStats.mockReset();
  });

  it('returns the parsed kb_stats payload on success', async () => {
    mockKbStats.mockResolvedValue(healthyKbStatsPayload());
    const { kbHealthSummary } = await import('../src/tools/check-status.js');
    const health = await kbHealthSummary();
    expect(health).not.toBeNull();
    expect(health!.totals.total).toBe(17);
  });

  it('returns null (never throws) when kb_stats rejects', async () => {
    mockKbStats.mockRejectedValue(new Error('DB unavailable'));
    const { kbHealthSummary } = await import('../src/tools/check-status.js');
    await expect(kbHealthSummary()).resolves.toBeNull();
  });

  it('returns null (never throws) when kb_stats returns unparseable JSON', async () => {
    mockKbStats.mockResolvedValue('not valid json{{{');
    const { kbHealthSummary } = await import('../src/tools/check-status.js');
    await expect(kbHealthSummary()).resolves.toBeNull();
  });
});

describe('fleetStatus() KB health section (T2.2)', () => {
  beforeEach(() => {
    vi.resetModules();
    backupAndResetRegistry();
    vi.clearAllMocks();
    mockKbStats.mockReset();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('compact output includes the KB health line when kb_stats succeeds', async () => {
    mockKbStats.mockResolvedValue(healthyKbStatsPayload());
    const { fleetStatus } = await import('../src/tools/check-status.js');
    addAgent(makeTestAgent({ friendlyName: 'kb-health-member' }));

    const result = await fleetStatus({ format: 'compact' });
    expect(result).toContain('kb: 17 entries');
    expect(result).toContain('hit-rate:65%');
  });

  it('JSON output includes the kbHealth key when kb_stats succeeds', async () => {
    mockKbStats.mockResolvedValue(healthyKbStatsPayload());
    const { fleetStatus } = await import('../src/tools/check-status.js');
    addAgent(makeTestAgent({ friendlyName: 'kb-health-json-member' }));

    const result = await fleetStatus({ format: 'json' });
    const parsed = JSON.parse(result);
    expect(parsed.kbHealth).toBeDefined();
    expect(parsed.kbHealth.totals.total).toBe(17);
  });

  it('drift > 0 renders the actionable bible line in compact output', async () => {
    mockKbStats.mockResolvedValue(healthyKbStatsPayload({ bible: { present: true, entries: 7, drift: 2 } }));
    const { fleetStatus } = await import('../src/tools/check-status.js');
    addAgent(makeTestAgent({ friendlyName: 'kb-drift-member' }));

    const result = await fleetStatus({ format: 'compact' });
    expect(result).toContain('bible: 2 promotions behind (auto-commit may have failed -- run apra-fleet kb commit)');
  });

  it('omits the KB section entirely (compact + json) and still succeeds when kb_stats throws', async () => {
    mockKbStats.mockRejectedValue(new Error('KB provider unavailable'));
    const { fleetStatus } = await import('../src/tools/check-status.js');
    addAgent(makeTestAgent({ friendlyName: 'kb-error-member' }));

    const compact = await fleetStatus({ format: 'compact' });
    expect(compact).not.toContain('kb:');
    expect(compact).not.toContain('bible:');
    expect(compact).toContain('kb-error-member');

    const json = JSON.parse(await fleetStatus({ format: 'json' }));
    expect(json.kbHealth).toBeUndefined();
    expect(json.members).toBeDefined();
  });

  it('does not perturb existing status sections (members, codeIntelligence) when KB fails', async () => {
    mockKbStats.mockRejectedValue(new Error('boom'));
    const { fleetStatus } = await import('../src/tools/check-status.js');
    addAgent(makeTestAgent({ friendlyName: 'kb-error-sections-member' }));

    const json = JSON.parse(await fleetStatus({ format: 'json' }));
    expect(json.summary.total).toBe(1);
    expect(json.codeIntelligence).toBeDefined();
  });
});
