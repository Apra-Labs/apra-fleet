import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry, spawnDeadPid } from './test-helpers.js';
import { addAgent, getAgent, updateAgent } from '../src/services/registry.js';
import { memberReservation, getReservation, reapIfDead } from '../src/tools/member-reservation.js';

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

      const { text: result } = await memberReservation({ member_id: member.id, action: 'reserve', sprint_id: 'sprint-1' });

      expect(result).toContain('reserved for "sprint-1"');
      expect(getAgent(member.id)?.reservedBy).toBe('sprint-1');
    });

    it('requires sprint_id', async () => {
      const member = makeTestAgent();
      addAgent(member);

      const { text: result } = await memberReservation({ member_id: member.id, action: 'reserve' });

      expect(result).toContain('sprint_id is required');
      expect(getAgent(member.id)?.reservedBy ?? null).toBeNull();
    });

    it('rejects reserving a member already held by a different sprint', async () => {
      const member = makeTestAgent({ reservedBy: 'sprint-1' });
      addAgent(member);

      const { text: result } = await memberReservation({ member_id: member.id, action: 'reserve', sprint_id: 'sprint-2' });

      expect(result).toContain('already reserved by "sprint-1"');
      expect(getAgent(member.id)?.reservedBy).toBe('sprint-1');
    });

    it('is idempotent when re-reserving with the same sprint_id', async () => {
      const member = makeTestAgent({ reservedBy: 'sprint-1' });
      addAgent(member);

      const { text: result } = await memberReservation({ member_id: member.id, action: 'reserve', sprint_id: 'sprint-1' });

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

      const { text: result } = await memberReservation({ member_id: member.id, action: 'reserve', sprint_id: 'sprint-1' });

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

      const { text: result } = await memberReservation({ member_id: member.id, action: 'release', sprint_id: 'sprint-1' });

      expect(result).toContain('reservation released');
      expect(getAgent(member.id)?.reservedBy ?? null).toBeNull();
    });

    it('requires sprint_id', async () => {
      const member = makeTestAgent({ reservedBy: 'sprint-1' });
      addAgent(member);

      const { text: result } = await memberReservation({ member_id: member.id, action: 'release' });

      expect(result).toContain('sprint_id is required');
      expect(getAgent(member.id)?.reservedBy).toBe('sprint-1');
    });

    it('refuses to release a reservation held by a different sprint', async () => {
      const member = makeTestAgent({ reservedBy: 'sprint-1' });
      addAgent(member);

      const { text: result } = await memberReservation({ member_id: member.id, action: 'release', sprint_id: 'sprint-2' });

      expect(result).toContain('reserved by "sprint-1"');
      expect(result).toContain('force_release');
      expect(getAgent(member.id)?.reservedBy).toBe('sprint-1');
    });

    it('no-ops when the member was not reserved', async () => {
      const member = makeTestAgent();
      addAgent(member);

      const { text: result } = await memberReservation({ member_id: member.id, action: 'release', sprint_id: 'sprint-1' });

      expect(result).toContain('Nothing to release');
      expect(getAgent(member.id)?.reservedBy ?? null).toBeNull();
    });
  });

  describe('force_release', () => {
    it('clears a reservation regardless of current owner', async () => {
      const member = makeTestAgent({ reservedBy: 'sprint-1' });
      addAgent(member);

      const { text: result } = await memberReservation({ member_id: member.id, action: 'force_release' });

      expect(result).toContain('forcibly cleared');
      expect(result).toContain('sprint-1');
      expect(getAgent(member.id)?.reservedBy ?? null).toBeNull();
    });

    it('is idempotent when the member was already unreserved', async () => {
      const member = makeTestAgent();
      addAgent(member);

      const { text: result } = await memberReservation({ member_id: member.id, action: 'force_release' });

      expect(result).toContain('Nothing to force-release');
      expect(getAgent(member.id)?.reservedBy ?? null).toBeNull();
    });
  });

  it('returns an error for an unknown member', async () => {
    const { text: result } = await memberReservation({ member_name: 'does-not-exist', action: 'reserve', sprint_id: 'sprint-1' });
    expect(result).toMatch(/not found|Error/i);
  });

  // apra-fleet: a member flagged unreservable (a role designed to be shared
  // by more than one sprint at once, e.g. fleet-sprint's orchestrator) must
  // never actually acquire a reservedBy value -- reserve/release/
  // force_release all become no-op successes, regardless of sprint_id or
  // current state, so the member can never become the "already reserved by
  // X" target of a normal exclusive-reservation conflict.
  describe('unreservable member', () => {
    it('reserve is a no-op success and never sets reservedBy', async () => {
      const member = makeTestAgent({ unreservable: true });
      addAgent(member);

      const { text: result } = await memberReservation({ member_id: member.id, action: 'reserve', sprint_id: 'sprint-1' });

      expect(result).toContain('shared/unreservable');
      expect(getAgent(member.id)?.reservedBy ?? null).toBeNull();
    });

    it('release is a no-op success even without a sprint_id (bypasses the normal sprint_id-required check)', async () => {
      const member = makeTestAgent({ unreservable: true });
      addAgent(member);

      const { text: result } = await memberReservation({ member_id: member.id, action: 'release' });

      expect(result).toContain('shared/unreservable');
    });

    it('force_release is a no-op success', async () => {
      const member = makeTestAgent({ unreservable: true });
      addAgent(member);

      const { text: result } = await memberReservation({ member_id: member.id, action: 'force_release' });

      expect(result).toContain('shared/unreservable');
    });

    it('a pre-existing reservedBy (e.g. set before the member was flagged unreservable) is left untouched by any action', async () => {
      const member = makeTestAgent({ unreservable: true, reservedBy: 'stale-sprint' });
      addAgent(member);

      await memberReservation({ member_id: member.id, action: 'reserve', sprint_id: 'sprint-1' });
      await memberReservation({ member_id: member.id, action: 'release', sprint_id: 'sprint-1' });
      await memberReservation({ member_id: member.id, action: 'force_release' });

      expect(getAgent(member.id)?.reservedBy).toBe('stale-sprint');
    });
  });
});

/**
 * apra-fleet-ecjf.3: the reservation OBJECT ({runId, pid, at}) that now lives
 * alongside the reservedBy string mirror, plus lazy dead-pid reaping.
 *
 * Every dead pid used here comes from spawnDeadPid() -- a real child process
 * that was spawned and awaited to exit -- never a guessed pid number, which
 * could belong to a live unrelated process (making the assertion vacuous) or
 * be re-used (making it flaky).
 */
describe('reservation object, reaping and legacy compat (apra-fleet-ecjf.3)', () => {
  beforeEach(() => {
    backupAndResetRegistry();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('reserve with a pid writes {runId,pid,at} and the reservedBy mirror together', async () => {
    const member = makeTestAgent();
    addAgent(member);

    const { structuredContent } = await memberReservation({
      member_id: member.id, action: 'reserve', sprint_id: 'sprint-1', pid: process.pid,
    });

    const stored = getAgent(member.id)!;
    expect(stored.reservedBy).toBe('sprint-1');
    expect(stored.reservation).toEqual({
      runId: 'sprint-1', pid: process.pid, at: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(stored.reservation!.at))).toBe(false);
    expect(structuredContent.outcome).toBe('reserved');
    expect(structuredContent.reservation).toEqual(stored.reservation);
    expect(structuredContent.reaped).toBe(false);
  });

  it('reserve without a pid records pid null', async () => {
    const member = makeTestAgent();
    addAgent(member);

    const { structuredContent } = await memberReservation({
      member_id: member.id, action: 'reserve', sprint_id: 'sprint-1',
    });

    expect(getAgent(member.id)?.reservation).toEqual({
      runId: 'sprint-1', pid: null, at: expect.any(String),
    });
    expect(structuredContent.reservation).toMatchObject({ runId: 'sprint-1', pid: null });
  });

  it('a refresh by the same sprint updates pid and at, keeping the runId', async () => {
    const member = makeTestAgent();
    addAgent(member);

    await memberReservation({ member_id: member.id, action: 'reserve', sprint_id: 'sprint-1' });
    const first = getAgent(member.id)!.reservation!;
    expect(first.pid).toBeNull();

    await new Promise((r) => setTimeout(r, 20));
    const { structuredContent } = await memberReservation({
      member_id: member.id, action: 'reserve', sprint_id: 'sprint-1', pid: process.pid,
    });

    const refreshed = getAgent(member.id)!.reservation!;
    expect(structuredContent.outcome).toBe('reservation_refreshed');
    expect(refreshed.runId).toBe('sprint-1');
    expect(refreshed.pid).toBe(process.pid);
    expect(Date.parse(refreshed.at)).toBeGreaterThan(Date.parse(first.at));
    expect(structuredContent.reservation).toEqual(refreshed);
  });

  it('release clears the object and the mirror together', async () => {
    const member = makeTestAgent();
    addAgent(member);
    await memberReservation({ member_id: member.id, action: 'reserve', sprint_id: 'sprint-1', pid: process.pid });

    const { structuredContent } = await memberReservation({
      member_id: member.id, action: 'release', sprint_id: 'sprint-1',
    });

    const stored = getAgent(member.id)!;
    expect(stored.reservedBy ?? null).toBeNull();
    expect(stored.reservation ?? null).toBeNull();
    expect(structuredContent.outcome).toBe('released');
    expect(structuredContent.reservation).toBeNull();
  });

  it('force_release clears the object and the mirror together', async () => {
    const member = makeTestAgent();
    addAgent(member);
    await memberReservation({ member_id: member.id, action: 'reserve', sprint_id: 'sprint-1', pid: process.pid });

    const { structuredContent } = await memberReservation({ member_id: member.id, action: 'force_release' });

    const stored = getAgent(member.id)!;
    expect(stored.reservedBy ?? null).toBeNull();
    expect(stored.reservation ?? null).toBeNull();
    expect(structuredContent.outcome).toBe('force_released');
    expect(structuredContent.reservation).toBeNull();
  });

  it('getReservation reads a legacy string-only member as {runId, pid:null, at:null}', () => {
    const member = makeTestAgent({ reservedBy: 'legacy-sprint' });
    expect(getReservation(member)).toEqual({ runId: 'legacy-sprint', pid: null, at: null });
    expect(getReservation(makeTestAgent())).toBeNull();
  });

  it('a legacy string-only reservation is never reaped and is still releasable', async () => {
    const member = makeTestAgent({ reservedBy: 'legacy-sprint' });
    addAgent(member);

    // Not reaped, even though it carries no pid at all.
    expect(reapIfDead(getAgent(member.id)!).reaped).toBe(false);

    // It still blocks another sprint...
    const blocked = await memberReservation({ member_id: member.id, action: 'reserve', sprint_id: 'other-sprint' });
    expect(blocked.structuredContent.outcome).toBe('already_reserved_by_other');
    expect(blocked.structuredContent.reaped).toBe(false);
    expect(blocked.structuredContent.reservation).toEqual({ runId: 'legacy-sprint', pid: null, at: null });
    expect(getAgent(member.id)?.reservedBy).toBe('legacy-sprint');

    // ...and its own holder can release it.
    const released = await memberReservation({ member_id: member.id, action: 'release', sprint_id: 'legacy-sprint' });
    expect(released.structuredContent.outcome).toBe('released');
    expect(getAgent(member.id)?.reservedBy ?? null).toBeNull();
  });

  it('a dead-pid holder is reaped by the next reserve from another run (outcome reserved, reaped true)', async () => {
    const deadPid = await spawnDeadPid();
    const member = makeTestAgent();
    addAgent(member);
    await memberReservation({ member_id: member.id, action: 'reserve', sprint_id: 'sprint-dead', pid: deadPid });
    expect(getAgent(member.id)?.reservedBy).toBe('sprint-dead');

    const { structuredContent } = await memberReservation({
      member_id: member.id, action: 'reserve', sprint_id: 'sprint-new', pid: process.pid,
    });

    expect(structuredContent.outcome).toBe('reserved');
    expect(structuredContent.reaped).toBe(true);
    expect(structuredContent.reservation).toMatchObject({ runId: 'sprint-new', pid: process.pid });
    expect(getAgent(member.id)?.reservedBy).toBe('sprint-new');
  });

  it('reapIfDead clears both fields for a dead holder and returns the post-write agent', async () => {
    const deadPid = await spawnDeadPid();
    const member = makeTestAgent();
    addAgent(member);
    await memberReservation({ member_id: member.id, action: 'reserve', sprint_id: 'sprint-dead', pid: deadPid });

    const { agent, reaped } = reapIfDead(getAgent(member.id)!);

    expect(reaped).toBe(true);
    expect(agent.reservedBy ?? null).toBeNull();
    expect(agent.reservation ?? null).toBeNull();
    expect(getAgent(member.id)?.reservedBy ?? null).toBeNull();
  });

  it('an alive pid is never reaped -- it keeps blocking a reserve from another run', async () => {
    const member = makeTestAgent();
    addAgent(member);
    await memberReservation({ member_id: member.id, action: 'reserve', sprint_id: 'sprint-live', pid: process.pid });

    expect(reapIfDead(getAgent(member.id)!).reaped).toBe(false);

    const { structuredContent } = await memberReservation({
      member_id: member.id, action: 'reserve', sprint_id: 'sprint-other', pid: process.pid,
    });

    expect(structuredContent.outcome).toBe('already_reserved_by_other');
    expect(structuredContent.reaped).toBe(false);
    expect(structuredContent.ownerSprintId).toBe('sprint-live');
    expect(getAgent(member.id)?.reservedBy).toBe('sprint-live');
  });
});

/**
 * apra-fleet-ecjf.4: owner_ref refusal. A package may pass the owner tag it
 * expects the member to carry; a member tagged for a DIFFERENT package/ref is
 * refused outright (outcome member_other_owner) and nothing is written.
 *
 * "Nothing is written" is asserted on both reservation fields in every
 * refusal case, including the one where the member's holder is dead -- the
 * refusal runs before reaping precisely so a refused call cannot mutate the
 * member at all. Reverting the refusal branch turns these into reserves and
 * fails them.
 */
describe('owner_ref refusal (apra-fleet-ecjf.4)', () => {
  const ownerTag = { package: 'fleet-sprint', ref: 'project-a' };

  beforeEach(() => {
    backupAndResetRegistry();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('refuses a package mismatch with member_other_owner and writes nothing', async () => {
    const member = makeTestAgent({ owner: ownerTag });
    addAgent(member);

    const { text, structuredContent } = await memberReservation({
      member_id: member.id, action: 'reserve', sprint_id: 'sprint-1',
      owner_ref: { package: 'other-package', ref: 'project-a' },
    });

    expect(structuredContent.outcome).toBe('member_other_owner');
    expect(structuredContent.ok).toBe(false);
    expect(text.startsWith('[-]')).toBe(true);
    expect(text).toContain('fleet-sprint@project-a');
    const stored = getAgent(member.id)!;
    expect(stored.reservedBy ?? null).toBeNull();
    expect(stored.reservation ?? null).toBeNull();
    expect(stored.owner).toEqual(ownerTag);
  });

  it('refuses a ref mismatch with member_other_owner and writes nothing', async () => {
    const member = makeTestAgent({ owner: ownerTag });
    addAgent(member);

    const { structuredContent } = await memberReservation({
      member_id: member.id, action: 'reserve', sprint_id: 'sprint-1',
      owner_ref: { package: 'fleet-sprint', ref: 'project-b' },
    });

    expect(structuredContent.outcome).toBe('member_other_owner');
    const stored = getAgent(member.id)!;
    expect(stored.reservedBy ?? null).toBeNull();
    expect(stored.reservation ?? null).toBeNull();
  });

  it('allows a reserve when owner_ref matches the member owner tag exactly', async () => {
    const member = makeTestAgent({ owner: ownerTag });
    addAgent(member);

    const { structuredContent } = await memberReservation({
      member_id: member.id, action: 'reserve', sprint_id: 'sprint-1', owner_ref: { ...ownerTag },
    });

    expect(structuredContent.outcome).toBe('reserved');
    expect(getAgent(member.id)?.reservedBy).toBe('sprint-1');
  });

  it('allows a reserve on an untagged member even when owner_ref is supplied', async () => {
    const member = makeTestAgent();
    addAgent(member);

    const { structuredContent } = await memberReservation({
      member_id: member.id, action: 'reserve', sprint_id: 'sprint-1',
      owner_ref: { package: 'fleet-sprint', ref: 'project-a' },
    });

    expect(structuredContent.outcome).toBe('reserved');
    expect(getAgent(member.id)?.reservedBy).toBe('sprint-1');
  });

  it('allows a reserve on an owner-tagged member when no owner_ref is supplied (existing callers unchanged)', async () => {
    const member = makeTestAgent({ owner: ownerTag });
    addAgent(member);

    const { structuredContent } = await memberReservation({
      member_id: member.id, action: 'reserve', sprint_id: 'sprint-1',
    });

    expect(structuredContent.outcome).toBe('reserved');
    expect(getAgent(member.id)?.reservedBy).toBe('sprint-1');
  });

  it('refuses a foreign-owned member BEFORE the already_reserved_by_other check, whoever holds it', async () => {
    const member = makeTestAgent({ owner: ownerTag, reservedBy: 'sprint-holder' });
    addAgent(member);

    const { structuredContent } = await memberReservation({
      member_id: member.id, action: 'reserve', sprint_id: 'sprint-1',
      owner_ref: { package: 'other-package', ref: 'project-a' },
    });

    expect(structuredContent.outcome).toBe('member_other_owner');
    expect(structuredContent.ownerSprintId).toBe('sprint-holder');
    expect(getAgent(member.id)?.reservedBy).toBe('sprint-holder');
  });

  it('refuses BEFORE reaping, so a refused reserve never even clears a dead holder', async () => {
    const deadPid = await spawnDeadPid();
    const member = makeTestAgent({
      owner: ownerTag,
      reservedBy: 'sprint-dead',
      reservation: { runId: 'sprint-dead', pid: deadPid, at: '2026-09-25T00:00:00.000Z' },
    });
    addAgent(member);

    const { structuredContent } = await memberReservation({
      member_id: member.id, action: 'reserve', sprint_id: 'sprint-1',
      owner_ref: { package: 'other-package', ref: 'project-a' },
    });

    expect(structuredContent.outcome).toBe('member_other_owner');
    expect(structuredContent.reaped).toBe(false);
    const stored = getAgent(member.id)!;
    expect(stored.reservedBy).toBe('sprint-dead');
    expect(stored.reservation).toEqual({ runId: 'sprint-dead', pid: deadPid, at: '2026-09-25T00:00:00.000Z' });
  });

  it('still refuses a reserve without sprint_id as invalid_input (the sprint_id guard keeps precedence)', async () => {
    const member = makeTestAgent({ owner: ownerTag });
    addAgent(member);

    const { structuredContent } = await memberReservation({
      member_id: member.id, action: 'reserve',
      owner_ref: { package: 'other-package', ref: 'project-a' },
    });

    expect(structuredContent.outcome).toBe('invalid_input');
  });

  it('release and force_release ignore owner_ref entirely', async () => {
    const member = makeTestAgent({ owner: ownerTag, reservedBy: 'sprint-1' });
    addAgent(member);
    const foreign = { package: 'other-package', ref: 'project-a' };

    const released = await memberReservation({
      member_id: member.id, action: 'release', sprint_id: 'sprint-1', owner_ref: foreign,
    });
    expect(released.structuredContent.outcome).toBe('released');
    expect(getAgent(member.id)?.reservedBy ?? null).toBeNull();

    await memberReservation({ member_id: member.id, action: 'reserve', sprint_id: 'sprint-2' });
    const forced = await memberReservation({
      member_id: member.id, action: 'force_release', owner_ref: foreign,
    });
    expect(forced.structuredContent.outcome).toBe('force_released');
    expect(getAgent(member.id)?.reservedBy ?? null).toBeNull();
  });
});
