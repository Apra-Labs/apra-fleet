import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { HOST_OPT_IN_FLAG, hostPassEnv, hostRefusal, platformOf, scrubNodeFromPath, selectDriver } from './lib/host.mjs';
import { baselineStaleness, compareTags, newestBaselineTag, releaseAssetUrl, resolveLatestRelease } from './lib/baseline.mjs';
import { evaluateStep, finalVerdict, STATUS } from './lib/verdict.mjs';

describe('fresh-install driver selection', () => {
  it('defaults by platform: windows -> sandbox, linux -> docker, macos -> host', () => {
    expect(selectDriver({ platform: 'windows', hostPlatform: 'windows' })).toEqual({ platform: 'windows', driver: 'sandbox' });
    expect(selectDriver({ platform: 'linux', hostPlatform: 'windows' })).toEqual({ platform: 'linux', driver: 'docker' });
    expect(selectDriver({ platform: 'macos', hostPlatform: 'macos' })).toEqual({ platform: 'macos', driver: 'host' });
  });

  it('host driver derives the platform from this machine and rejects a mismatch', () => {
    expect(selectDriver({ driver: 'host', hostPlatform: 'linux' })).toEqual({ platform: 'linux', driver: 'host' });
    expect(() => selectDriver({ driver: 'host', platform: 'windows', hostPlatform: 'linux' })).toThrow(/does not match/);
    expect(() => selectDriver({ platform: 'macos', hostPlatform: 'windows' })).toThrow(/does not match/);
  });

  it('rejects unknown drivers/platforms and impossible combinations', () => {
    expect(() => selectDriver({ driver: 'vm', platform: 'linux', hostPlatform: 'linux' })).toThrow(/--driver/);
    expect(() => selectDriver({ hostPlatform: 'linux' })).toThrow(/--platform/);
    expect(() => selectDriver({ driver: 'sandbox', platform: 'linux', hostPlatform: 'linux' })).toThrow(/only runs the windows/);
    expect(() => selectDriver({ driver: 'docker', platform: 'macos', hostPlatform: 'macos' })).toThrow(/only runs the linux/);
  });

  it('maps node platforms', () => {
    expect([platformOf('win32'), platformOf('linux'), platformOf('darwin'), platformOf('aix')]).toEqual(['windows', 'linux', 'macos', null]);
  });
});

describe('fresh-install host opt-in guard', () => {
  const ok = { env: { CI: 'true' }, optInFlag: true, passes: ['B'], fleetHomeExists: false };

  it('allows only CI=true AND the explicit flag, one pass, on a machine without apra-fleet', () => {
    expect(hostRefusal(ok)).toBeNull();
  });

  it('refuses loudly without CI=true, without the flag, or without both', () => {
    for (const bad of [
      { ...ok, env: {} },
      { ...ok, env: { CI: '1' } },
      { ...ok, optInFlag: false },
      { ...ok, env: {}, optInFlag: false },
    ]) {
      const msg = hostRefusal(bad);
      expect(msg).toMatch(/^REFUSED: .*disposable/);
      expect(msg).toContain(HOST_OPT_IN_FLAG);
    }
  });

  it('refuses more than one pass per machine and a machine that already has apra-fleet', () => {
    expect(hostRefusal({ ...ok, passes: ['A', 'B'] })).toMatch(/exactly one pass/);
    expect(hostRefusal({ ...ok, passes: [] })).toMatch(/exactly one pass/);
    expect(hostRefusal({ ...ok, fleetHomeExists: true, fleetHome: '/home/x/.apra-fleet' })).toMatch(/\/home\/x\/\.apra-fleet already exists/);
  });

  it('scrubs every PATH dir holding node or npm and strips CI markers from the box env', () => {
    const files = new Set(['/usr/local/bin/node', '/opt/tool/node/bin/npm', 'C:/nodejs/node.exe']);
    const { path: p, dropped } = scrubNodeFromPath('/usr/local/bin:/usr/bin::/opt/tool/node/bin:/bin', { sep: ':', join: (a: string, b: string) => `${a}/${b}`, exists: (f: string) => files.has(f) });
    expect(p).toBe('/usr/bin:/bin');
    expect(dropped).toEqual(['/usr/local/bin', '/opt/tool/node/bin']);
    const win = scrubNodeFromPath('C:/Windows;C:/nodejs', { sep: ';', join: (a: string, b: string) => `${a}/${b}`, exists: (f: string) => files.has(f) });
    expect(win.path).toBe('C:/Windows');
    // isolated-home-allow: plain data passed to a pure env-filter function; no process runs with this HOME.
    const env = hostPassEnv({ Path: 'x', CI: 'true', npm_config_prefix: '/p', HOME: '/h', GITHUB_ACTIONS: 'true' }, 'scrubbed');
    expect(env).toEqual({ Path: 'scrubbed', HOME: '/h', GITHUB_ACTIONS: 'true' });
  });
});

describe('fresh-install upgrade baseline', () => {
  const pins = JSON.parse(fs.readFileSync(path.join(__dirname, 'pins.json'), 'utf8'));

  it('picks the newest pinned baseline by semver, not key order', () => {
    expect(newestBaselineTag({ baselines: { 'v0.10.0': {}, 'v0.9.9': {}, 'v0.4.3': {} } })).toBe('v0.10.0');
    expect(newestBaselineTag({ baselines: {} })).toBeNull();
    expect(compareTags('v0.4.3', 'v0.4.10')).toBeLessThan(0);
  });

  it('the shipped pins cover every platform for the newest baseline and Node', () => {
    const tag = newestBaselineTag(pins);
    for (const plat of ['windows', 'linux', 'macos']) {
      expect(pins.baselines[tag][plat]?.sha256, `${tag}/${plat}`).toMatch(/^[0-9a-f]{64}$/);
      expect(pins.node[plat]?.sha256, `node/${plat}`).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(pins.baselines[tag].version.startsWith(`${tag}_`)).toBe(true);
    expect(releaseAssetUrl('o/r', 'v1.2.3', 'a.exe')).toBe('https://github.com/o/r/releases/download/v1.2.3/a.exe');
  });

  it('is current only when the used baseline is the latest release; stale or unresolved is not current', () => {
    expect(baselineStaleness({ usedTag: 'v0.4.3', latestTag: 'v0.4.3' }).status).toBe('current');
    const stale = baselineStaleness({ usedTag: 'v0.4.3', latestTag: 'v0.4.4' });
    expect(stale.status).toBe('stale');
    expect(stale.note).toMatch(/baseline pin stale.*v0\.4\.4/);
    const unknown = baselineStaleness({ usedTag: 'v0.4.3', latestTag: null, lookupError: 'api: HTTP 403' });
    expect(unknown.status).toBe('unknown');
    expect(unknown.note).toContain('HTTP 403');
  });

  it('a stale pin makes an all-PASS run INCONCLUSIVE (exit 3); FAIL still wins', () => {
    const pass = { pass: 'U', platform: 'linux', blocking: false, verdict: STATUS.PASS };
    const fail = { pass: 'B', platform: 'linux', blocking: true, verdict: STATUS.FAIL };
    expect(finalVerdict([pass], [])).toMatchObject({ verdict: 'PASS', exitCode: 0 });
    expect(finalVerdict([pass], ['baseline pin stale'])).toMatchObject({ verdict: 'INCONCLUSIVE', exitCode: 3 });
    expect(finalVerdict([pass, fail], ['baseline pin stale'])).toMatchObject({ verdict: 'FAIL', exitCode: 1, blocking: ['linux/B'] });
  });

  it('resolves the latest release tokenless: API first, web redirect when the API is rate limited', async () => {
    const calls: string[] = [];
    const api = async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push(url);
      expect(JSON.stringify(init?.headers ?? {})).not.toMatch(/authorization/i);
      return { ok: true, status: 200, json: async () => ({ tag_name: 'v0.4.3' }) };
    };
    expect(await resolveLatestRelease('o/r', api as never)).toEqual({ tag: 'v0.4.3', source: 'api' });
    expect(calls).toEqual(['https://api.github.com/repos/o/r/releases/latest']);

    const limited = async (url: string) => new URL(url).hostname === 'api.github.com'
      ? { ok: false, status: 403 }
      : { ok: false, status: 302, headers: new Headers({ location: 'https://github.com/o/r/releases/tag/v0.4.4' }) };
    expect(await resolveLatestRelease('o/r', limited as never)).toEqual({ tag: 'v0.4.4', source: 'redirect' });

    const down = async () => { throw new Error('offline'); };
    const r = await resolveLatestRelease('o/r', down as never);
    expect(r.tag).toBeNull();
    expect(r.error).toMatch(/api: offline; redirect: offline/);
  });
});

describe('fresh-install env-limited rules are scoped by driver', () => {
  const step = { id: 'B04', title: 'install', expect: { exit: 0 }, envLimited: [{ platforms: ['linux'], drivers: ['docker'], keyline: 'systemd', note: 'no systemd' }] };
  const rec = { id: 'B04', exit: '1', keyline: 'systemd user mode is not available' };

  it('excuses a missing systemd only in the docker container, never on a host VM', () => {
    expect(evaluateStep(step, rec, { platform: 'linux', driver: 'docker' }).status).toBe(STATUS.ENV);
    expect(evaluateStep(step, rec, { platform: 'linux', driver: 'host' }).status).toBe(STATUS.FAIL);
  });

  it('every linux envLimited rule in the shipped checklist is scoped to the docker driver', () => {
    const real = JSON.parse(fs.readFileSync(path.join(__dirname, 'checklist.json'), 'utf8'));
    for (const def of Object.values<any>(real.passes)) {
      for (const s of def.steps) for (const e of s.envLimited ?? []) expect(e.drivers, s.id).toEqual(['docker']);
    }
  });
});
