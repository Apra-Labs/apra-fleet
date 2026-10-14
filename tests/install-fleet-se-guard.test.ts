import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { runInstall, _setSeaOverride, _setManifestOverride, _setFleetSeProbes, _resetFleetSeProbes } from '../src/cli/install.js';
import { detectRunningFleetSe, fleetSeRefusalText, type FleetSeProbes } from '../src/cli/fleet-se-guard.js';

// Upgrading under a running fleet-sprint supervisor/sprint breaks them with
// HTTP 401 (old process, no member access secret). install must refuse before
// stopping or writing anything; --force must not bypass it; only
// --ignore-running-sprints does. All detection seams are injected fakes.

vi.mock('node:os', () => ({
  default: { homedir: vi.fn(() => '/mock/home'), platform: vi.fn(() => 'linux'), tmpdir: vi.fn(() => '/tmp') },
}));
vi.mock('node:fs');
vi.mock('node:child_process');

const BASE_MANIFEST = {
  version: '0.1.0', hooks: {}, scripts: {}, skills: {}, fleetSkills: {}, agents: {}, workflows: {},
};
const ENOENT = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
const LOCK_DIR = path.join('/locks');

function fakeProbes(o: {
  locks?: Record<string, string>;
  alive?: number[];
  health?: Record<number, unknown>;
  sprints?: Record<number, unknown>;
  log?: string;
  cmd?: Record<number, string | null>;
} = {}): FleetSeProbes {
  const alive = new Set(o.alive ?? []);
  const cmd = o.cmd ?? {};
  return {
    lockDir: () => LOCK_DIR,
    supervisorLogPath: () => '/se/logs/supervisor.log',
    readDir: () => (o.locks ? Object.keys(o.locks) : ENOENT()),
    readFile: (f: string) => {
      if (f === '/se/logs/supervisor.log') return o.log ?? ENOENT();
      const name = path.basename(f);
      return o.locks && name in o.locks ? o.locks[name] : ENOENT();
    },
    isPidAlive: (pid: number) => alive.has(pid),
    commandLine: (pid: number) => (pid in cmd ? cmd[pid] : 'node /home/u/.apra-fleet/workflows/fleet-sprint/bin/cli.mjs --branch b'),
    getJson: async (url: string) => {
      const m = url.match(/:(\d+)\/api\/(health|sprints)$/);
      if (!m) return null;
      const table = m[2] === 'health' ? o.health : o.sprints;
      return table?.[Number(m[1])] ?? null;
    },
  };
}

const SUPERVISOR_HEALTH = { status: 'ok', pid: 500, seams: { ledger: 'wired' } };

describe('detectRunningFleetSe', () => {
  it('nothing running: no lock dir, no supervisor', async () => {
    expect(await detectRunningFleetSe(fakeProbes())).toEqual({ supervisor: null, sprints: [], warnings: [] });
  });

  it('a stale lock whose pid was reused by an unrelated process is not a running sprint', async () => {
    const r = await detectRunningFleetSe(fakeProbes({
      locks: { 'a.lock': '111', 'b.lock': '222' },
      alive: [111, 222],
      cmd: { 111: 'C:\\Windows\\System32\\svchost.exe -k netsvcs', 222: 'apra-fleet workflow fleet-sprint --branch b' },
    }));
    expect(r.sprints).toEqual([{ pid: 222, lockFile: path.join(LOCK_DIR, 'b.lock') }]);
    expect(r.warnings).toEqual([]);
  });

  it('an unreadable command line fails open: lock skipped with a warning', async () => {
    const r = await detectRunningFleetSe(fakeProbes({ locks: { 'a.lock': '111' }, alive: [111], cmd: { 111: null } }));
    expect(r.sprints).toEqual([]);
    expect(r.warnings?.[0]).toContain('could not read the command line of pid 111');
  });

  it('a live sprint lock is a running sprint; a dead pid (or another user, EPERM) is not', async () => {
    const r = await detectRunningFleetSe(fakeProbes({ locks: { 'a.lock': '111', 'b.lock': '222', 'c.txt': '333' }, alive: [111, 333] }));
    expect(r.supervisor).toBeNull();
    expect(r.sprints).toEqual([{ pid: 111, lockFile: path.join(LOCK_DIR, 'a.lock') }]);
  });

  it('supervisor on 8787 is detected and its sprints are named from GET /api/sprints', async () => {
    const r = await detectRunningFleetSe(fakeProbes({
      locks: { 'x.lock': '700' },
      alive: [500, 700],
      health: { 8787: SUPERVISOR_HEALTH },
      sprints: { 8787: { sprints: [{ sprintId: 'sprint-1', childPid: 700 }, { sprintId: 'gone', childPid: 999 }] } },
    }));
    expect(r.supervisor).toEqual({ pid: 500, port: 8787 });
    expect(r.sprints).toEqual([{ pid: 700, lockFile: path.join(LOCK_DIR, 'x.lock'), sprintId: 'sprint-1' }]);
  });

  it('finds a supervisor on the non-default port it last logged', async () => {
    const r = await detectRunningFleetSe(fakeProbes({
      alive: [500],
      log: '[supervisor] listening on http://localhost:8787 (pid 1)\n[supervisor] listening on http://localhost:9911 (pid 500)\n',
      health: { 9911: SUPERVISOR_HEALTH },
    }));
    expect(r.supervisor).toEqual({ pid: 500, port: 9911 });
  });

  it('a non-supervisor answering on 8787 (no seams) or a dead health pid is not a supervisor', async () => {
    expect((await detectRunningFleetSe(fakeProbes({ alive: [500], health: { 8787: { status: 'ok', pid: 500 } } }))).supervisor).toBeNull();
    expect((await detectRunningFleetSe(fakeProbes({ health: { 8787: SUPERVISOR_HEALTH } }))).supervisor).toBeNull();
  });

  it('an unexpected read error propagates (the caller warns and proceeds)', async () => {
    const p = fakeProbes();
    p.readDir = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
    await expect(detectRunningFleetSe(p)).rejects.toThrow('EACCES');
  });
});

describe('fleetSeRefusalText', () => {
  it('names what runs, the stop steps, the upgrade command and the override; ASCII only', () => {
    const text = fleetSeRefusalText(
      { supervisor: { pid: 500, port: 8787 }, sprints: [{ pid: 700, sprintId: 'sprint-1' }, { pid: 800, lockFile: '/l/x.lock' }] },
      { platform: 'win32', rerunLines: ['C:\\inst.exe install --force'], ignoreLines: ['C:\\inst.exe install --force --ignore-running-sprints'] },
    );
    expect(text).toContain('E-FLEET-SE-RUNNING');
    expect(text).toContain('replaces\nthe fleet server underneath it');
    expect(text).toContain('started before the member access secret existed (0.4.3 and earlier)');
    expect(text).toContain('HTTP 401');
    expect(text).toContain('fleet-sprint supervisor: pid 500, http://localhost:8787');
    expect(text).toContain('sprint sprint-1: pid 700');
    expect(text).toContain('fleet-sprint run: pid 800 (lock file /l/x.lock)');
    expect(text).toContain('curl.exe -X POST http://localhost:8787/api/sprints/sprint-1/stop');
    expect(text).toContain('curl.exe -X POST http://localhost:8787/api/shutdown');
    expect(text).toContain('C:\\inst.exe install --force\n');
    expect(text).toContain('C:\\inst.exe install --force --ignore-running-sprints');
    expect(text).toContain('Restart the supervisor');
    expect(/^[\x00-\x7F]*$/.test(text)).toBe(true);
  });
});

describe('runInstall running fleet-sprint guard', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  const running = () => fakeProbes({
    locks: { 'x.lock': '700' },
    alive: [500, 700],
    health: { 8787: SUPERVISOR_HEALTH },
    sprints: { 8787: { sprints: [{ sprintId: 'sprint-1', childPid: 700 }] } },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/mock/home');
    vi.mocked(fs.existsSync).mockReturnValue(false);
    _setSeaOverride(true);
    _setManifestOverride(BASE_MANIFEST as any);
    process.env.APRA_FLEET_ENABLE_FLEET_SE_GUARD = '1';
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as any);
  });

  afterEach(() => {
    _setSeaOverride(null);
    _setManifestOverride(null);
    _resetFleetSeProbes();
    delete process.env.APRA_FLEET_ENABLE_FLEET_SE_GUARD;
    vi.restoreAllMocks();
  });

  const errors = () => errorSpy.mock.calls.map(c => c.join(' ')).join('\n');

  it.each([[[]], [['--force']]])('refuses with %j before anything is stopped or the binary is written', async (args) => {
    _setFleetSeProbes(running());

    await expect(runInstall(args as string[])).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errors()).toContain('E-FLEET-SE-RUNNING');
    expect(errors()).toContain('sprint sprint-1: pid 700');
    expect(errors()).toContain('--ignore-running-sprints');
    // Nothing stopped or installed: no process listing/kill, no binary copy.
    expect(execSync).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
    expect(fs.copyFileSync).not.toHaveBeenCalled();
    // Persisted for a detached install (apra-fleet update) that has no console.
    expect(vi.mocked(fs.writeFileSync).mock.calls.some(c => String(c[0]).endsWith('service-notice.json'))).toBe(true);
  });

  it('--ignore-running-sprints proceeds past the guard without probing', async () => {
    const getJson = vi.fn(async () => SUPERVISOR_HEALTH);
    _setFleetSeProbes({ ...running(), getJson });
    // The rest of the (fully mocked) install may or may not complete; only the gate matters here.
    await runInstall(['--ignore-running-sprints']).catch(() => {});
    expect(getJson).not.toHaveBeenCalled();
    expect(errors()).not.toContain('E-FLEET-SE-RUNNING');
  });

  it('nothing running: no refusal, and an obsolete persisted refusal notice is cleared', async () => {
    _setFleetSeProbes(fakeProbes());
    vi.mocked(fs.readFileSync).mockImplementation(((p: unknown) => {
      if (String(p).endsWith('service-notice.json')) return JSON.stringify({ createdAt: 'x', text: 'Error: E-FLEET-SE-RUNNING: ...' });
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }) as any);
    await runInstall([]).catch(() => {});
    expect(errors()).not.toContain('E-FLEET-SE-RUNNING');
    expect(vi.mocked(fs.unlinkSync).mock.calls.some(c => String(c[0]).endsWith('service-notice.json'))).toBe(true);
  });

  it('an unrelated pending notice is kept', async () => {
    _setFleetSeProbes(fakeProbes());
    vi.mocked(fs.readFileSync).mockImplementation(((p: unknown) => {
      if (String(p).endsWith('service-notice.json')) return JSON.stringify({ createdAt: 'x', text: 'legacy task guidance' });
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }) as any);
    await runInstall([]).catch(() => {});
    expect(vi.mocked(fs.unlinkSync).mock.calls.some(c => String(c[0]).endsWith('service-notice.json'))).toBe(false);
  });

  it('detection warnings (unverifiable lock pid) are printed and the install proceeds', async () => {
    _setFleetSeProbes(fakeProbes({ locks: { 'a.lock': '111' }, alive: [111], cmd: { 111: null } }));
    await runInstall([]).catch(() => {});
    expect(vi.mocked(console.warn).mock.calls.map(c => c.join(' ')).join('\n')).toContain('WARNING: could not read the command line of pid 111');
    expect(errors()).not.toContain('E-FLEET-SE-RUNNING');
  });

  it('a detection error warns and proceeds (fail open)', async () => {
    _setFleetSeProbes({ ...fakeProbes(), readDir: () => { throw new Error('boom'); } });
    const warnSpy = vi.mocked(console.warn);
    await runInstall([]).catch(() => {});
    expect(warnSpy.mock.calls.map(c => c.join(' ')).join('\n')).toContain('WARNING: could not check for a running fleet-sprint supervisor');
    expect(errors()).not.toContain('E-FLEET-SE-RUNNING');
  });

  it('a member install is exempt', async () => {
    const getJson = vi.fn(async () => SUPERVISOR_HEALTH);
    _setFleetSeProbes({ ...running(), getJson });
    await runInstall(['--member']).catch(() => {});
    expect(getJson).not.toHaveBeenCalled();
    expect(errors()).not.toContain('E-FLEET-SE-RUNNING');
  });
});
