import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent, getAgent } from '../src/services/registry.js';

// apra-fleet-g6ap.5.1/5.2 (DQ-22): member_owner (set/clear) and remove_member
// (without force) consult every registered workflow package's holds route
// and refuse when a package reports the member held -- in addition to the
// pre-existing sync reservedBy check. The registry service itself is
// stubbed here (per the parent bead's own note: "inject them in tests via
// vi.mock") so these tests never touch the real workflow-packages.json file
// or make a real network call.
const mockList = vi.fn<() => Array<{ id: string; ownerRefs: string | null }>>(() => []);
const mockConsultHolds = vi.fn<
  (memberId: string) => Promise<Array<{ packageId: string; held: boolean; reason?: string; error?: string }>>
>(async () => []);
const mockCheckOwnerRef = vi.fn<
  (packageId: string, ref: string) => Promise<{ known: boolean } | { error: string }>
>(async () => ({ error: 'not stubbed for this test' }));

vi.mock('../src/services/workflow-packages.js', () => ({
  workflowPackageService: {
    list: () => mockList(),
    consultHolds: (memberId: string) => mockConsultHolds(memberId),
    checkOwnerRef: (packageId: string, ref: string) => mockCheckOwnerRef(packageId, ref),
  },
  // apra-fleet-g6ap.8: member-owner.ts now imports this constant (not just
  // workflowPackageService) from this module -- a mock factory omitting it
  // makes every named import undefined, not just workflowPackageService's
  // own methods, which broke test 5 below (heldBy's package became
  // undefined instead of "fleet").
  FLEET_RESERVATION_PACKAGE: 'fleet',
}));

import { memberOwner } from '../src/tools/member-owner.js';

describe('memberOwner -- workflow-package holds consult and ownerRefs validation (DQ-22)', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    mockList.mockReset().mockReturnValue([]);
    mockConsultHolds.mockReset().mockResolvedValue([]);
    mockCheckOwnerRef.mockReset().mockResolvedValue({ error: 'not stubbed for this test' });
  });

  afterEach(() => restoreRegistry());

  it('1. set refused member_held when a registered package reports held; heldBy lists {package, reason}; owner unchanged', async () => {
    const member = makeTestAgent();
    addAgent(member);
    mockConsultHolds.mockResolvedValueOnce([{ packageId: 'fleet-sprint', held: true, reason: 'in-progress-assignment' }]);

    const { text, structuredContent } = await memberOwner({
      member_id: member.id, action: 'set', package: 'fleet-sprint', ref: 'sprint-1',
    });

    expect(structuredContent.outcome).toBe('member_held');
    expect(structuredContent.ok).toBe(false);
    expect(structuredContent.heldBy).toEqual([{ package: 'fleet-sprint', reason: 'in-progress-assignment' }]);
    expect(text).toContain('member-held');
    expect(text).toContain('fleet-sprint');
    expect(getAgent(member.id)?.owner).toBeUndefined();
  });

  it('2. clear refused the same way', async () => {
    const member = makeTestAgent({ owner: { package: 'fleet-sprint', ref: 'sprint-1' } });
    addAgent(member);
    mockConsultHolds.mockResolvedValueOnce([{ packageId: 'fleet-sprint', held: true, reason: 'assignment' }]);

    const { text, structuredContent } = await memberOwner({ member_id: member.id, action: 'clear' });

    expect(structuredContent.outcome).toBe('member_held');
    expect(structuredContent.heldBy).toEqual([{ package: 'fleet-sprint', reason: 'assignment' }]);
    expect(text).toContain('member-held');
    expect(getAgent(member.id)?.owner).toEqual({ package: 'fleet-sprint', ref: 'sprint-1' });
  });

  it('3. owning package registered but its holds call errors -> member_held with reason holds-unavailable', async () => {
    const member = makeTestAgent();
    addAgent(member);
    mockConsultHolds.mockResolvedValueOnce([{ packageId: 'fleet-sprint', held: false, error: 'timeout contacting package' }]);

    const { structuredContent } = await memberOwner({
      member_id: member.id, action: 'set', package: 'fleet-sprint', ref: 'sprint-1',
    });

    expect(structuredContent.outcome).toBe('member_held');
    expect(structuredContent.heldBy).toEqual([{ package: 'fleet-sprint', reason: 'holds-unavailable' }]);
    expect(getAgent(member.id)?.owner).toBeUndefined();
  });

  it('3b. apra-fleet-g6ap.7: set reassigns A -> B while A (current owner) errors -> member_held, owner unchanged', async () => {
    // The member is currently owned by "pkg-a"; the caller reassigns it to
    // "pkg-b" via set. pkg-a's own holds call errors (it cannot vouch for
    // whether it still needs the member) -- this must fail closed exactly
    // like clear/remove would, not silently let the reassignment through.
    const member = makeTestAgent({ owner: { package: 'pkg-a', ref: 'old-ref' } });
    addAgent(member);
    mockConsultHolds.mockResolvedValueOnce([{ packageId: 'pkg-a', held: false, error: 'timeout contacting package' }]);

    const { structuredContent } = await memberOwner({
      member_id: member.id, action: 'set', package: 'pkg-b', ref: 'new-ref',
    });

    expect(structuredContent.outcome).toBe('member_held');
    expect(structuredContent.heldBy).toEqual([{ package: 'pkg-a', reason: 'holds-unavailable' }]);
    expect(getAgent(member.id)?.owner).toEqual({ package: 'pkg-a', ref: 'old-ref' });
  });

  it('4. a non-owning package erroring is skipped and the action proceeds', async () => {
    const member = makeTestAgent();
    addAgent(member);
    // The member is being set to "fleet-sprint" (the owning package); a
    // DIFFERENT package's holds call errors and must be skipped, not
    // block the write.
    mockConsultHolds.mockResolvedValueOnce([{ packageId: 'other-pkg', held: false, error: 'boom' }]);

    const { structuredContent } = await memberOwner({
      member_id: member.id, action: 'set', package: 'fleet-sprint', ref: 'sprint-1',
    });

    expect(structuredContent.outcome).toBe('set');
    expect(structuredContent.heldBy).toBeNull();
    expect(getAgent(member.id)?.owner).toEqual({ package: 'fleet-sprint', ref: 'sprint-1' });
  });

  it('5. reservedBy still refuses (existing behaviour) and heldBy reports it', async () => {
    const member = makeTestAgent({ reservedBy: 'sprint-99' });
    addAgent(member);

    const { text, structuredContent } = await memberOwner({
      member_id: member.id, action: 'set', package: 'fleet-sprint', ref: 'sprint-1',
    });

    expect(structuredContent.outcome).toBe('member_held');
    expect(text).toContain('member-held');
    expect(text.toLowerCase()).toContain('held');
    expect(structuredContent.heldBy).toEqual([{ package: 'fleet', reason: 'reservation' }]);
    expect(getAgent(member.id)?.owner).toBeUndefined();
    // memberHeldCheck always runs both checks (reservedBy is sufficient here
    // to refuse, but the packages consult still happens).
    expect(mockConsultHolds).toHaveBeenCalledWith(member.id);
  });

  it('6a. set with a ref unknown to the package\'s ownerRefs -> invalid_input', async () => {
    const member = makeTestAgent();
    addAgent(member);
    mockList.mockReturnValueOnce([{ id: 'fleet-sprint', ownerRefs: '/api/owner-refs' }]);
    mockCheckOwnerRef.mockResolvedValueOnce({ known: false });

    const { text, structuredContent } = await memberOwner({
      member_id: member.id, action: 'set', package: 'fleet-sprint', ref: 'no-such-ref',
    });

    expect(structuredContent.outcome).toBe('invalid_input');
    expect(text).toContain('unknown ref');
    expect(getAgent(member.id)?.owner).toBeUndefined();
    expect(mockCheckOwnerRef).toHaveBeenCalledWith('fleet-sprint', 'no-such-ref');
    // A rejected ref must never reach the holds consult.
    expect(mockConsultHolds).not.toHaveBeenCalled();
  });

  it('6b. set with a ref known to the package\'s ownerRefs -> set succeeds', async () => {
    const member = makeTestAgent();
    addAgent(member);
    mockList.mockReturnValue([{ id: 'fleet-sprint', ownerRefs: '/api/owner-refs' }]);
    mockCheckOwnerRef.mockResolvedValueOnce({ known: true });

    const { structuredContent } = await memberOwner({
      member_id: member.id, action: 'set', package: 'fleet-sprint', ref: 'sprint-42',
    });

    expect(structuredContent.outcome).toBe('set');
    expect(getAgent(member.id)?.owner).toEqual({ package: 'fleet-sprint', ref: 'sprint-42' });
  });

  it('6c. an ownerRefs consult error -> outcome failed with the error text', async () => {
    const member = makeTestAgent();
    addAgent(member);
    mockList.mockReturnValueOnce([{ id: 'fleet-sprint', ownerRefs: '/api/owner-refs' }]);
    mockCheckOwnerRef.mockResolvedValueOnce({ error: 'ownerRefs endpoint unreachable' });

    const { text, structuredContent } = await memberOwner({
      member_id: member.id, action: 'set', package: 'fleet-sprint', ref: 'sprint-42',
    });

    expect(structuredContent.outcome).toBe('failed');
    expect(text).toContain('ownerRefs endpoint unreachable');
    expect(getAgent(member.id)?.owner).toBeUndefined();
  });

  it('7. set for an unregistered package -> format-only validation, set succeeds', async () => {
    const member = makeTestAgent();
    addAgent(member);
    // mockList returns [] (default): "unregistered-pkg" is not found, so no
    // ownerRefs consult happens at all.
    const { structuredContent } = await memberOwner({
      member_id: member.id, action: 'set', package: 'unregistered-pkg', ref: 'sprint-1',
    });

    expect(structuredContent.outcome).toBe('set');
    expect(getAgent(member.id)?.owner).toEqual({ package: 'unregistered-pkg', ref: 'sprint-1' });
    expect(mockCheckOwnerRef).not.toHaveBeenCalled();
  });

  it('a registered package declaring no ownerRefs keeps format-only validation', async () => {
    const member = makeTestAgent();
    addAgent(member);
    mockList.mockReturnValueOnce([{ id: 'fleet-sprint', ownerRefs: null }]);

    const { structuredContent } = await memberOwner({
      member_id: member.id, action: 'set', package: 'fleet-sprint', ref: 'sprint-1',
    });

    expect(structuredContent.outcome).toBe('set');
    expect(mockCheckOwnerRef).not.toHaveBeenCalled();
  });
});
