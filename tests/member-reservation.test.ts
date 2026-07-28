import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent, getAgent } from '../src/services/registry.js';
import { memberReservation } from '../src/tools/member-reservation.js';

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
