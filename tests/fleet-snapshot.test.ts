import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// fleet_snapshot reads the registry and statusline-state.json from FLEET_DIR,
// which src/paths.ts evaluates once at module load -- same per-file data dir
// plus vi.resetModules() shape as tests/statusline.test.ts.
const TMP_DIR = path.join(os.tmpdir(), `fleet-snapshot-test-${process.pid}`);
process.env.APRA_FLEET_DATA_DIR = TMP_DIR;
vi.resetModules();

const { buildFleetSnapshot, fleetSnapshot } = await import('../src/tools/fleet-snapshot.js');
const { addAgent } = await import('../src/services/registry.js');
const { getStallDetector } = await import('../src/services/stall/index.js');
const { isMemberAllowedTool, REGISTERED_TOOL_NAMES } = await import('../src/services/member-tool-allowlist.js');

const STATE_PATH = path.join(TMP_DIR, 'statusline-state.json');

function makeAgent(id: string, name: string, extra: Record<string, unknown> = {}): any {
  return {
    id,
    friendlyName: name,
    agentType: 'local',
    workFolder: '/tmp/work',
    os: 'linux',
    createdAt: '2026-01-01T00:00:00.000Z',
    icon: 'X',
    ...extra,
  };
}

describe('fleet_snapshot', () => {
  beforeEach(() => {
    if (fs.existsSync(TMP_DIR)) fs.rmSync(TMP_DIR, { recursive: true, force: true });
    fs.mkdirSync(TMP_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(TMP_DIR)) fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it('returns an empty member list on a fresh install', () => {
    const snap = buildFleetSnapshot();
    expect(snap.members).toEqual([]);
    expect(typeof snap.version).toBe('string');
  });

  it('reports every member with its persisted state, category and holder', () => {
    addAgent(makeAgent('a1', 'alice', { category: 'build', reservedBy: 'sprint-42' }));
    addAgent(makeAgent('b1', 'bob', { category: '  ' }));
    addAgent(makeAgent('c1', 'carol'));
    addAgent(makeAgent('d1', 'dave'));
    addAgent(makeAgent('e1', 'erin'));
    fs.writeFileSync(STATE_PATH, JSON.stringify({ a1: 'busy(02:14)', b1: 'offline', c1: 'unknown', d1: 'weird' }));

    const snap = buildFleetSnapshot();
    const byName = Object.fromEntries(snap.members.map(m => [m.name, m]));
    expect(byName.alice).toEqual({ id: 'a1', name: 'alice', icon: 'X', category: 'build', status: 'busy', quietForS: 134, reservedBy: 'sprint-42' });
    expect(byName.bob).toMatchObject({ status: 'offline', category: null });
    expect(byName.carol.status).toBe('unknown');
    // an unrecognised persisted state is reported as unknown, never guessed
    expect(byName.dave.status).toBe('unknown');
    // no persisted state yet: idle, as the statusline writer defaults it
    expect(byName.erin.status).toBe('idle');
    expect(byName.erin.quietForS).toBeUndefined();
  });

  it('prefers the live stall detector clock and reports a reported stall as unknown', () => {
    addAgent(makeAgent('a1', 'alice'));
    addAgent(makeAgent('b1', 'bob'));
    fs.writeFileSync(STATE_PATH, JSON.stringify({ a1: 'busy(00:01)', b1: 'busy(00:01)' }));
    const now = 1_000_000;
    const spy = vi.spyOn(getStallDetector(), 'getEntry').mockImplementation((id: string) => {
      if (id === 'a1') return { lastActivityAt: now - 90_000, provisional: false, stallReported: false } as any;
      if (id === 'b1') return { lastActivityAt: now - 900_000, provisional: false, stallReported: true } as any;
      return undefined;
    });
    try {
      const byName = Object.fromEntries(buildFleetSnapshot(now).members.map(m => [m.name, m]));
      expect(byName.alice).toMatchObject({ status: 'busy', quietForS: 90 });
      expect(byName.bob.status).toBe('unknown');
      expect(byName.bob.quietForS).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('is read-only: the persisted state and registry are left byte-identical', async () => {
    addAgent(makeAgent('a1', 'alice'));
    fs.writeFileSync(STATE_PATH, JSON.stringify({ a1: 'idle', gone: 'busy' }));
    const files = () => fs.readdirSync(TMP_DIR).filter(f => fs.statSync(path.join(TMP_DIR, f)).isFile()).map(f => [f, fs.readFileSync(path.join(TMP_DIR, f), 'utf-8')]);
    const before = files();
    const text = await fleetSnapshot();
    expect(JSON.parse(text).members).toHaveLength(1);
    const after = files();
    expect(after).toEqual(before);
  });

  it('is registered and served to FULL sessions only, never to a member session', () => {
    expect(REGISTERED_TOOL_NAMES).toContain('fleet_snapshot');
    expect(isMemberAllowedTool('fleet_snapshot')).toBe(false);
  });
});
