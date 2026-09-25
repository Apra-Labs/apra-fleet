import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent, getAgent, updateAgent } from '../src/services/registry.js';
import { memberOwner } from '../src/tools/member-owner.js';

// apra-fleet-4qtu.2.1 -- updateAgent is wrapped with vi.fn(actual.updateAgent)
// so every existing test in this file keeps exercising the REAL registry
// read/write path unchanged, while the store-write-failure test below can
// force a single call to return falsy without touching any other test.
vi.mock('../src/services/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/registry.js')>();
  return {
    ...actual,
    updateAgent: vi.fn(actual.updateAgent),
  };
});

describe('memberOwner', () => {
  beforeEach(() => {
    backupAndResetRegistry();
  });

  afterEach(() => {
    restoreRegistry();
  });

  describe('set', () => {
    it('writes owner {package, ref} on an unheld member', async () => {
      const member = makeTestAgent();
      addAgent(member);

      const { text: result } = await memberOwner({ member_id: member.id, action: 'set', package: 'fleet-sprint', ref: 'sprint-42' });

      expect(result).toContain('owner set to fleet-sprint@sprint-42');
      expect(getAgent(member.id)?.owner).toEqual({ package: 'fleet-sprint', ref: 'sprint-42' });
    });

    it('requires both package and ref', async () => {
      const member = makeTestAgent();
      addAgent(member);

      const { text: missingRef } = await memberOwner({ member_id: member.id, action: 'set', package: 'fleet-sprint' });
      expect(missingRef).toContain('are required');
      expect(getAgent(member.id)?.owner).toBeUndefined();

      const { text: missingPackage } = await memberOwner({ member_id: member.id, action: 'set', ref: 'sprint-42' });
      expect(missingPackage).toContain('are required');
      expect(getAgent(member.id)?.owner).toBeUndefined();
    });

    it('rejects a malformed package and leaves any existing owner untouched', async () => {
      const member = makeTestAgent({ owner: { package: 'fleet-sprint', ref: 'sprint-1' } });
      addAgent(member);

      const { text: result } = await memberOwner({ member_id: member.id, action: 'set', package: 'bad package!', ref: 'sprint-2' });

      expect(result).toContain('Invalid owner package');
      expect(getAgent(member.id)?.owner).toEqual({ package: 'fleet-sprint', ref: 'sprint-1' });
    });

    it('rejects a malformed ref and leaves any existing owner untouched', async () => {
      const member = makeTestAgent({ owner: { package: 'fleet-sprint', ref: 'sprint-1' } });
      addAgent(member);

      const { text: result } = await memberOwner({ member_id: member.id, action: 'set', package: 'fleet-sprint', ref: 'bad ref!' });

      expect(result).toContain('Invalid owner ref');
      expect(getAgent(member.id)?.owner).toEqual({ package: 'fleet-sprint', ref: 'sprint-1' });
    });

    it('refuses while the member is held (reservedBy set)', async () => {
      const member = makeTestAgent({ reservedBy: 'sprint-99' });
      addAgent(member);

      const { text: result } = await memberOwner({ member_id: member.id, action: 'set', package: 'fleet-sprint', ref: 'sprint-1' });

      expect(result).toContain('member-held');
      expect(result.toLowerCase()).toContain('held');
      expect(getAgent(member.id)?.owner).toBeUndefined();
    });

    it('treats a registry write failure as a failed set', async () => {
      const member = makeTestAgent();
      addAgent(member);

      vi.mocked(updateAgent).mockReturnValueOnce(undefined);

      const { text: result } = await memberOwner({ member_id: member.id, action: 'set', package: 'fleet-sprint', ref: 'sprint-1' });

      expect(result).toContain('Failed to set owner');
      expect(getAgent(member.id)?.owner).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('removes an existing owner', async () => {
      const member = makeTestAgent({ owner: { package: 'fleet-sprint', ref: 'sprint-1' } });
      addAgent(member);

      const { text: result } = await memberOwner({ member_id: member.id, action: 'clear' });

      expect(result).toContain('owner cleared');
      expect(getAgent(member.id)?.owner).toBeUndefined();
    });

    it('no-ops when there was no owner to clear', async () => {
      const member = makeTestAgent();
      addAgent(member);

      const { text: result } = await memberOwner({ member_id: member.id, action: 'clear' });

      expect(result).toContain('Nothing to clear');
      expect(getAgent(member.id)?.owner).toBeUndefined();
    });

    it('refuses while the member is held (reservedBy set)', async () => {
      const member = makeTestAgent({ reservedBy: 'sprint-99', owner: { package: 'fleet-sprint', ref: 'sprint-1' } });
      addAgent(member);

      const { text: result } = await memberOwner({ member_id: member.id, action: 'clear' });

      expect(result).toContain('member-held');
      expect(result.toLowerCase()).toContain('held');
      expect(getAgent(member.id)?.owner).toEqual({ package: 'fleet-sprint', ref: 'sprint-1' });
    });
  });

  it('returns an error for an unknown member', async () => {
    const { text: result } = await memberOwner({ member_name: 'does-not-exist', action: 'set', package: 'fleet-sprint', ref: 'sprint-1' });
    expect(result).toMatch(/not found|Error/i);
  });

  it('exposes structuredContent.outcome for programmatic callers', async () => {
    const member = makeTestAgent();
    addAgent(member);

    const set = await memberOwner({ member_id: member.id, action: 'set', package: 'fleet-sprint', ref: 'sprint-1' });
    expect(set.structuredContent.outcome).toBe('set');
    expect(set.structuredContent.ok).toBe(true);
    expect(set.structuredContent.owner).toEqual({ package: 'fleet-sprint', ref: 'sprint-1' });

    const cleared = await memberOwner({ member_id: member.id, action: 'clear' });
    expect(cleared.structuredContent.outcome).toBe('cleared');
    expect(cleared.structuredContent.owner).toBeNull();
  });
});
