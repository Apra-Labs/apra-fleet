import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent, getAgent, updateAgent } from '../src/services/registry.js';
import { memberReservation } from '../src/tools/member-reservation.js';

// apra-fleet-p2to.3.3 -- updateAgent is wrapped with vi.fn(actual.updateAgent)
// so every existing test in this file keeps exercising the REAL registry
// read/write path unchanged, while the store-write-failure test below can
// force a single call to return falsy (simulating a reservation-store write
// failure) without touching any other test's behavior.
vi.mock('../src/services/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/registry.js')>();
  return {
    ...actual,
    updateAgent: vi.fn(actual.updateAgent),
  };
});

describe('memberReservation', () => {
  beforeEach(() => {
    backupAndResetRegistry();
  });

  afterEach(() => {
    restoreRegistry();
  });

  describe('reserve', () => {
    it('reserves an unreserved member', async () => {
      const member = makeTestAgent();
      addAgent(member);

      const result = await memberReservation({ member_id: member.id, action: 'reserve', sprint_id: 'sprint-1' });

      expect(result).toContain('reserved for "sprint-1"');
      expect(getAgent(member.id)?.reservedBy).toBe('sprint-1');
    });

    it('requires sprint_id', async () => {
      const member = makeTestAgent();
      addAgent(member);

      const result = await memberReservation({ member_id: member.id, action: 'reserve' });

      expect(result).toContain('sprint_id is required');
      expect(getAgent(member.id)?.reservedBy ?? null).toBeNull();
    });

    it('rejects reserving a member already held by a different sprint', async () => {
      const member = makeTestAgent({ reservedBy: 'sprint-1' });
      addAgent(member);

      const result = await memberReservation({ member_id: member.id, action: 'reserve', sprint_id: 'sprint-2' });

      expect(result).toContain('already reserved by "sprint-1"');
      expect(getAgent(member.id)?.reservedBy).toBe('sprint-1');
    });

    it('is idempotent when re-reserving with the same sprint_id', async () => {
      const member = makeTestAgent({ reservedBy: 'sprint-1' });
      addAgent(member);

      const result = await memberReservation({ member_id: member.id, action: 'reserve', sprint_id: 'sprint-1' });

      expect(result).toContain('already held by this sprint');
      expect(getAgent(member.id)?.reservedBy).toBe('sprint-1');
    });

    // apra-fleet-p2to.3.3 / apra-fleet-p2to.4.5: a reservation-store WRITE
    // failure (updateAgent() itself returning falsy, as opposed to the
    // "already reserved by X" owner-check rejection above) must be reported
    // as a failed reserve, not silently treated as success. This pins the
    // '[-]' marker on that return string (member-reservation.ts ~line 55) --
    // without it, runner.js's callFor() (fleet-sprint/runner.js) default-
    // trusts unmarked text as a successful reacquire (apra-fleet-p2to.4.5).
    it('treats a reservation-store write failure as a failed reserve, marked with a leading "[-]"', async () => {
      const member = makeTestAgent();
      addAgent(member);

      vi.mocked(updateAgent).mockReturnValueOnce(undefined);

      const result = await memberReservation({ member_id: member.id, action: 'reserve', sprint_id: 'sprint-1' });

      expect(result.startsWith('[-]')).toBe(true);
      expect(result).toContain('Failed to reserve');
      // The store write never actually happened -- reservedBy stays unset.
      expect(getAgent(member.id)?.reservedBy ?? null).toBeNull();
    });
  });

  describe('release', () => {
    it('releases a member reserved by the requesting sprint', async () => {
      const member = makeTestAgent({ reservedBy: 'sprint-1' });
      addAgent(member);

      const result = await memberReservation({ member_id: member.id, action: 'release', sprint_id: 'sprint-1' });

      expect(result).toContain('reservation released');
      expect(getAgent(member.id)?.reservedBy ?? null).toBeNull();
    });

    it('requires sprint_id', async () => {
      const member = makeTestAgent({ reservedBy: 'sprint-1' });
      addAgent(member);

      const result = await memberReservation({ member_id: member.id, action: 'release' });

      expect(result).toContain('sprint_id is required');
      expect(getAgent(member.id)?.reservedBy).toBe('sprint-1');
    });

    it('refuses to release a reservation held by a different sprint', async () => {
      const member = makeTestAgent({ reservedBy: 'sprint-1' });
      addAgent(member);

      const result = await memberReservation({ member_id: member.id, action: 'release', sprint_id: 'sprint-2' });

      expect(result).toContain('reserved by "sprint-1"');
      expect(result).toContain('force_release');
      expect(getAgent(member.id)?.reservedBy).toBe('sprint-1');
    });

    it('no-ops when the member was not reserved', async () => {
      const member = makeTestAgent();
      addAgent(member);

      const result = await memberReservation({ member_id: member.id, action: 'release', sprint_id: 'sprint-1' });

      expect(result).toContain('Nothing to release');
      expect(getAgent(member.id)?.reservedBy ?? null).toBeNull();
    });
  });

  describe('force_release', () => {
    it('clears a reservation regardless of current owner', async () => {
      const member = makeTestAgent({ reservedBy: 'sprint-1' });
      addAgent(member);

      const result = await memberReservation({ member_id: member.id, action: 'force_release' });

      expect(result).toContain('forcibly cleared');
      expect(result).toContain('sprint-1');
      expect(getAgent(member.id)?.reservedBy ?? null).toBeNull();
    });

    it('is idempotent when the member was already unreserved', async () => {
      const member = makeTestAgent();
      addAgent(member);

      const result = await memberReservation({ member_id: member.id, action: 'force_release' });

      expect(result).toContain('Nothing to force-release');
      expect(getAgent(member.id)?.reservedBy ?? null).toBeNull();
    });
  });

  it('returns an error for an unknown member', async () => {
    const result = await memberReservation({ member_name: 'does-not-exist', action: 'reserve', sprint_id: 'sprint-1' });
    expect(result).toMatch(/not found|Error/i);
  });
});
