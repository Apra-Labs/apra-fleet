import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { listMembers } from '../src/tools/list-members.js';
import { addAgent } from '../src/services/registry.js';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';

// Mock connection-dependent helpers so tests run offline
vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    testConnection: async () => ({ ok: false }),
    execCommand: async () => ({ stdout: '', stderr: '' }),
  }),
}));

vi.mock('../src/providers/index.js', () => ({
  getProvider: () => ({
    oauthCredentialFiles: () => [],
    authEnvVar: undefined,
  }),
}));

beforeEach(() => backupAndResetRegistry());
afterEach(() => restoreRegistry());

describe('list_members -- tags filter', () => {
  it('returns all members when no tags param is provided', async () => {
    addAgent(makeTestAgent({ id: 'member-a', friendlyName: 'alpha', tags: ['gpu'] }));
    addAgent(makeTestAgent({ id: 'member-b', friendlyName: 'beta', tags: ['doer'] }));
    addAgent(makeTestAgent({ id: 'member-c', friendlyName: 'gamma', tags: [] }));

    const result = await listMembers({ format: 'compact' });
    expect(result).toContain('alpha');
    expect(result).toContain('beta');
    expect(result).toContain('gamma');
    expect(result).toContain('3 member(s)');
  });

  it('returns only gpu-tagged members when tags:["gpu"] is specified', async () => {
    addAgent(makeTestAgent({ id: 'member-gpu', friendlyName: 'gpu-worker', tags: ['gpu'] }));
    addAgent(makeTestAgent({ id: 'member-cpu', friendlyName: 'cpu-worker', tags: ['doer'] }));
    addAgent(makeTestAgent({ id: 'member-both', friendlyName: 'both-worker', tags: ['gpu', 'doer'] }));

    const result = await listMembers({ format: 'compact', tags: ['gpu'] });
    expect(result).toContain('gpu-worker');
    expect(result).toContain('both-worker');
    expect(result).not.toContain('cpu-worker');
  });

  it('applies AND semantics: tags:["doer","gpu"] excludes members with only one of the two tags', async () => {
    addAgent(makeTestAgent({ id: 'member-gpu-only', friendlyName: 'gpu-only', tags: ['gpu'] }));
    addAgent(makeTestAgent({ id: 'member-doer-only', friendlyName: 'doer-only', tags: ['doer'] }));
    addAgent(makeTestAgent({ id: 'member-both', friendlyName: 'both-tags', tags: ['doer', 'gpu'] }));
    addAgent(makeTestAgent({ id: 'member-extra', friendlyName: 'extra-tags', tags: ['gpu', 'doer', 'prod'] }));

    const result = await listMembers({ format: 'compact', tags: ['doer', 'gpu'] });

    // Only members with BOTH tags should appear
    expect(result).toContain('both-tags');
    expect(result).toContain('extra-tags');

    // Members with only one of the two tags must be excluded (AND semantics)
    expect(result).not.toContain('gpu-only');
    expect(result).not.toContain('doer-only');
  });

  it('returns "No members registered." when no member matches the tag filter', async () => {
    addAgent(makeTestAgent({ id: 'member-a', friendlyName: 'alpha', tags: ['doer'] }));

    const result = await listMembers({ format: 'compact', tags: ['gpu'] });
    expect(result).toBe('No members registered.');
  });

  it('works with json format and applies the same AND filter', async () => {
    addAgent(makeTestAgent({ id: 'member-gpu', friendlyName: 'gpu-worker', tags: ['gpu'] }));
    addAgent(makeTestAgent({ id: 'member-doer', friendlyName: 'doer-worker', tags: ['doer'] }));
    addAgent(makeTestAgent({ id: 'member-both', friendlyName: 'both-worker', tags: ['gpu', 'doer'] }));

    const result = await listMembers({ format: 'json', tags: ['gpu', 'doer'] });
    const parsed = JSON.parse(result);

    expect(parsed.total).toBe(1);
    expect(parsed.members).toHaveLength(1);
    expect(parsed.members[0].name).toBe('both-worker');
    expect(parsed.members[0].tags).toEqual(expect.arrayContaining(['gpu', 'doer']));
  });
});
