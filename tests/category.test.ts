import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { fleetStatus } from '../src/tools/check-status.js';
import { listMembers } from '../src/tools/list-members.js';

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: vi.fn().mockResolvedValue({ stdout: 'idle', stderr: '', code: 0 }),
    testConnection: vi.fn().mockResolvedValue({ ok: true, latencyMs: 5 }),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

describe('fleet_status -- category grouping', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('groups members by category in compact output', async () => {
    addAgent(makeTestAgent({ friendlyName: 'worker-1', category: 'doers' }));
    addAgent(makeTestAgent({ friendlyName: 'reviewer-1', category: 'reviewers' }));
    const result = await fleetStatus({ format: 'compact' });
    expect(result).toContain('[doers]');
    expect(result).toContain('[reviewers]');
    expect(result).toContain('worker-1');
    expect(result).toContain('reviewer-1');
  });

  it('shows uncategorized members in (uncategorized) group', async () => {
    addAgent(makeTestAgent({ friendlyName: 'worker-1' }));
    const result = await fleetStatus({ format: 'compact' });
    expect(result).toContain('[(uncategorized)]');
    expect(result).toContain('worker-1');
  });

  it('places (uncategorized) after named categories', async () => {
    addAgent(makeTestAgent({ friendlyName: 'anon' }));
    addAgent(makeTestAgent({ friendlyName: 'alpha', category: 'alpha-team' }));
    const result = await fleetStatus({ format: 'compact' });
    const alphaPos = result.indexOf('[alpha-team]');
    const uncatPos = result.indexOf('[(uncategorized)]');
    expect(alphaPos).toBeGreaterThan(-1);
    expect(uncatPos).toBeGreaterThan(alphaPos);
  });

  it('includes category in JSON output', async () => {
    addAgent(makeTestAgent({ friendlyName: 'worker-1', category: 'doers' }));
    const result = await fleetStatus({ format: 'json' });
    const parsed = JSON.parse(result);
    expect(parsed.members[0].category).toBe('doers');
  });

  it('has null category in JSON output for uncategorized member', async () => {
    addAgent(makeTestAgent({ friendlyName: 'worker-1' }));
    const result = await fleetStatus({ format: 'json' });
    const parsed = JSON.parse(result);
    expect(parsed.members[0].category).toBeNull();
  });

  it('treats whitespace-only category as uncategorized', async () => {
    addAgent(makeTestAgent({ friendlyName: 'worker-1', category: '   ' }));
    const result = await fleetStatus({ format: 'compact' });
    expect(result).toContain('[(uncategorized)]');
    expect(result).not.toMatch(/\[\s+\]/);
  });

  it('renders tags in compact output', async () => {
    addAgent(makeTestAgent({ friendlyName: 'worker-1', tags: ['gpu', 'prod'] }));
    const result = await fleetStatus({ format: 'compact' });
    expect(result).toContain('tags=[gpu, prod]');
  });

  it('includes tags in JSON output', async () => {
    addAgent(makeTestAgent({ friendlyName: 'worker-1', tags: ['fast'] }));
    const result = await fleetStatus({ format: 'json' });
    const parsed = JSON.parse(result);
    expect(parsed.members[0].tags).toEqual(['fast']);
  });

  it('omits tags key in JSON output when member has no tags', async () => {
    addAgent(makeTestAgent({ friendlyName: 'worker-1' }));
    const result = await fleetStatus({ format: 'json' });
    const parsed = JSON.parse(result);
    expect(parsed.members[0].tags).toBeUndefined();
  });
});

describe('list_members -- category grouping', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('groups members by category in compact output', async () => {
    addAgent(makeTestAgent({ friendlyName: 'worker-1', category: 'doers' }));
    addAgent(makeTestAgent({ friendlyName: 'reviewer-1', category: 'reviewers' }));
    const result = await listMembers({ format: 'compact' });
    expect(result).toContain('[doers]');
    expect(result).toContain('[reviewers]');
  });

  it('shows uncategorized members under (uncategorized)', async () => {
    addAgent(makeTestAgent({ friendlyName: 'worker-1' }));
    const result = await listMembers({ format: 'compact' });
    expect(result).toContain('[(uncategorized)]');
  });

  it('includes category field in JSON output', async () => {
    addAgent(makeTestAgent({ friendlyName: 'worker-1', category: 'doers' }));
    const result = await listMembers({ format: 'json' });
    const parsed = JSON.parse(result);
    expect(parsed.members[0].category).toBe('doers');
  });

  it('has null category in JSON output for uncategorized member', async () => {
    addAgent(makeTestAgent({ friendlyName: 'worker-1' }));
    const result = await listMembers({ format: 'json' });
    const parsed = JSON.parse(result);
    expect(parsed.members[0].category).toBeNull();
  });

  it('renders tags in compact output', async () => {
    addAgent(makeTestAgent({ friendlyName: 'worker-1', tags: ['doer', 'nightly'] }));
    const result = await listMembers({ format: 'compact' });
    expect(result).toContain('tags=[doer, nightly]');
  });

  it('includes tags in JSON output', async () => {
    addAgent(makeTestAgent({ friendlyName: 'worker-1', tags: ['reviewer'] }));
    const result = await listMembers({ format: 'json' });
    const parsed = JSON.parse(result);
    expect(parsed.members[0].tags).toEqual(['reviewer']);
  });

  it('has null tags in JSON output when member has no tags', async () => {
    addAgent(makeTestAgent({ friendlyName: 'worker-1' }));
    const result = await listMembers({ format: 'json' });
    const parsed = JSON.parse(result);
    expect(parsed.members[0].tags).toBeNull();
  });
});
