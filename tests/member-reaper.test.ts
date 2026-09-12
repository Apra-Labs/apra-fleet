import { describe, it, expect, vi } from 'vitest';
import {
  AUTO_TAG,
  autoMemberTtlMin,
  isAutoMember,
  lastActivityMs,
  selectReapable,
  reapAutoMembers,
} from '../src/services/member-reaper.js';
import type { Agent } from '../src/types.js';

const NOW = Date.parse('2026-09-12T12:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function member(overrides: Partial<Agent> = {}): Agent {
  return {
    id: overrides.id ?? 'id-1',
    friendlyName: overrides.friendlyName ?? 'dev1',
    createdAt: minutesAgo(600),
    lastUsed: minutesAgo(600),
    tags: [AUTO_TAG],
    ...overrides,
  } as Agent;
}

const neverBusy = () => false;
const base = { now: NOW, ttlMin: 120, isBusy: neverBusy };

describe('autoMemberTtlMin', () => {
  it('defaults to 120 minutes', () => {
    expect(autoMemberTtlMin({})).toBe(120);
  });

  it('honours FLEET_AUTO_MEMBER_TTL_MIN', () => {
    expect(autoMemberTtlMin({ FLEET_AUTO_MEMBER_TTL_MIN: '30' })).toBe(30);
  });

  it('ignores junk and non-positive values', () => {
    for (const v of ['', 'abc', '0', '-5']) {
      expect(autoMemberTtlMin({ FLEET_AUTO_MEMBER_TTL_MIN: v })).toBe(120);
    }
  });
});

describe('isAutoMember', () => {
  it('requires the auto tag', () => {
    expect(isAutoMember(member())).toBe(true);
    expect(isAutoMember(member({ tags: ['doer'] }))).toBe(false);
  });

  it('tolerates missing and null tags', () => {
    expect(isAutoMember(member({ tags: undefined }))).toBe(false);
    expect(isAutoMember(member({ tags: null as never }))).toBe(false);
  });
});

describe('lastActivityMs', () => {
  it('prefers lastUsed', () => {
    const a = member({ createdAt: minutesAgo(600), lastUsed: minutesAgo(5) });
    expect(lastActivityMs(a)).toBe(NOW - 5 * 60_000);
  });

  it('falls back to createdAt when never dispatched to', () => {
    const a = member({ createdAt: minutesAgo(90), lastUsed: undefined });
    expect(lastActivityMs(a)).toBe(NOW - 90 * 60_000);
  });
});

describe('selectReapable', () => {
  it('reaps an idle auto member past its TTL', () => {
    const a = member({ lastUsed: minutesAgo(121) });
    expect(selectReapable([a], base).map((m) => m.id)).toEqual(['id-1']);
  });

  it('never reaps a member the user registered by hand, however old', () => {
    const handmade = member({ id: 'mine', tags: ['doer'], lastUsed: minutesAgo(100_000) });
    expect(selectReapable([handmade], base)).toEqual([]);
  });

  it('never reaps an untagged member', () => {
    const untagged = member({ id: 'mine', tags: undefined, lastUsed: minutesAgo(100_000) });
    expect(selectReapable([untagged], base)).toEqual([]);
  });

  it('skips a busy member', () => {
    const a = member({ lastUsed: minutesAgo(999) });
    const busy = selectReapable([a], { ...base, isBusy: (id) => id === 'id-1' });
    expect(busy).toEqual([]);
  });

  it('spares a member inside its TTL', () => {
    expect(selectReapable([member({ lastUsed: minutesAgo(119) })], base)).toEqual([]);
  });

  it('does not reap exactly at the TTL boundary', () => {
    expect(selectReapable([member({ lastUsed: minutesAgo(120) })], base)).toEqual([]);
  });

  it('never reaps on unparseable timestamps', () => {
    const bad = member({ createdAt: 'not-a-date', lastUsed: 'also-not-a-date' });
    expect(selectReapable([bad], base)).toEqual([]);
  });

  it('picks only the expired ones out of a mixed fleet', () => {
    const agents = [
      member({ id: 'stale', friendlyName: 'stale', lastUsed: minutesAgo(500) }),
      member({ id: 'fresh', friendlyName: 'fresh', lastUsed: minutesAgo(10) }),
      member({ id: 'manual', friendlyName: 'manual', tags: ['doer'], lastUsed: minutesAgo(500) }),
      member({ id: 'working', friendlyName: 'working', lastUsed: minutesAgo(500) }),
    ];
    const got = selectReapable(agents, { ...base, isBusy: (id) => id === 'working' });
    expect(got.map((m) => m.id)).toEqual(['stale']);
  });
});

describe('reapAutoMembers', () => {
  it('removes each selected member without forcing', async () => {
    const remove = vi.fn().mockResolvedValue('ok');
    const agents = [
      member({ id: 'a', friendlyName: 'dev1', lastUsed: minutesAgo(500) }),
      member({ id: 'b', friendlyName: 'dev2', lastUsed: minutesAgo(500) }),
    ];
    const res = await reapAutoMembers({ ...base, agents, remove });

    expect(res.reaped).toEqual(['dev1', 'dev2']);
    expect(res.failed).toEqual([]);
    expect(remove).toHaveBeenCalledTimes(2);
    // force=false: a member that turns busy mid-sweep survives to the next one.
    for (const call of remove.mock.calls) {
      expect(call[0].force).toBe(false);
    }
  });

  it('does nothing when the fleet has no auto members', async () => {
    const remove = vi.fn();
    const res = await reapAutoMembers({ ...base, agents: [member({ tags: ['doer'] })], remove });
    expect(res.reaped).toEqual([]);
    expect(remove).not.toHaveBeenCalled();
  });

  it('reports a failure without aborting the rest of the sweep', async () => {
    const remove = vi
      .fn()
      .mockRejectedValueOnce(new Error('still busy'))
      .mockResolvedValueOnce('ok');
    const agents = [
      member({ id: 'a', friendlyName: 'dev1', lastUsed: minutesAgo(500) }),
      member({ id: 'b', friendlyName: 'dev2', lastUsed: minutesAgo(500) }),
    ];
    const res = await reapAutoMembers({ ...base, agents, remove });

    expect(res.failed).toEqual([{ name: 'dev1', error: 'still busy' }]);
    expect(res.reaped).toEqual(['dev2']);
  });
});
