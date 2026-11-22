/**
 * A full install refuses on a fleet member host (apra-fleet-vrzn.1, vrzn.3).
 *
 * A full install clears data/member-install.json, which silently turns a fleet
 * member host into a full install (the fleet then reports full-install-running
 * and the members lose KB/code tools). The installer must refuse before
 * stopping or writing anything; install --member --force is the upgrade path
 * and --convert-member-host converts on purpose.
 *
 * Runs the real runInstall over an in-memory filesystem (node:fs mocked) with
 * HOME, USERPROFILE and APRA_FLEET_DATA_DIR pointed at sandbox paths, and a
 * stubbed running server whose kill is recorded, never delivered.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { runInstall, _setSeaOverride, _setManifestOverride } from '../src/cli/install.js';
import { getServiceManager } from '../src/services/service-manager/index.js';
import {
  memberInstallMarkerPath, MEMBER_HOST_FULL_INSTALL_CODE, CONVERT_MEMBER_HOST_FLAG,
} from '../src/cli/install-guard.js';
import { serverVersion } from '../src/version.js';

const SANDBOX = '/sandbox/vrzn-test';
const HOME = `${SANDBOX}/home`;
const DATA_DIR = `${SANDBOX}/data`;

vi.mock('node:os', () => ({
  default: { homedir: vi.fn(() => '/sandbox/vrzn-test/home'), platform: vi.fn(() => 'linux'), userInfo: vi.fn(() => ({ username: 'sandbox-user' })) },
}));
vi.mock('node:fs');
vi.mock('node:child_process');
vi.mock('../src/services/service-manager/index.js', () => ({ getServiceManager: vi.fn() }));

const runningExe = `${HOME}/.apra-fleet/bin/apra-fleet`;
const key = (p: any) => p.toString().replace(/\\/g, '/');

let files: Map<string, string>;
let kills: string[];
let serverUp: boolean;
let exitSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, APRA_FLEET_DATA_DIR: process.env.APRA_FLEET_DATA_DIR, APRA_FLEET_PORT: process.env.APRA_FLEET_PORT };

function setupFs() {
  vi.mocked(fs.existsSync).mockImplementation((p: any) => {
    const k = key(p);
    return k.includes('version.json') || k.includes('hooks-config.json') || files.has(k);
  });
  vi.mocked(fs.readFileSync).mockImplementation(((p: any) => {
    const k = key(p);
    if (files.has(k)) return files.get(k)!;
    if (k.includes('version.json')) return JSON.stringify({ version: '0.1.0' });
    if (k.includes('hooks-config.json')) return JSON.stringify({ hooks: { PostToolUse: [] } });
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }) as any);
  vi.mocked(fs.writeFileSync).mockImplementation(((p: any, c: any) => { files.set(key(p), String(c)); }) as any);
  vi.mocked(fs.appendFileSync).mockImplementation(((p: any, c: any) => { files.set(key(p), (files.get(key(p)) ?? '') + String(c)); }) as any);
  vi.mocked(fs.rmSync).mockImplementation(((p: any) => { files.delete(key(p)); }) as any);
  vi.mocked(fs.readdirSync).mockReturnValue([] as any);
  vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
  vi.mocked(fs.chmodSync).mockImplementation(() => {});
  vi.mocked(fs.copyFileSync).mockImplementation(() => {});
}

/** A running server under the install prefix; a kill is recorded, never sent. */
function serverRunning() {
  vi.mocked(execSync).mockImplementation(((cmd: any) => {
    const c = cmd.toString();
    if (c === 'pgrep -x apra-fleet') {
      if (!serverUp) throw Object.assign(new Error('no match'), { status: 1 });
      return '5678\n';
    }
    if (c.startsWith('pkill') || c.includes('/IM ')) throw new Error('name-based kill issued: ' + c);
    if (c.startsWith('readlink -f /proc/') || c.startsWith('ps -p ')) return `${runningExe}\n`;
    return '';
  }) as any);
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
    const s = String(sig ?? 'SIGTERM');
    if (s === '0') throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    kills.push(`${s}:${pid}`);
    if (pid === 5678) serverUp = false;
    return true;
  }) as any);
}

const marker = () => JSON.parse(files.get(memberInstallMarkerPath().replace(/\\/g, '/'))!);
const hasMarker = () => files.has(memberInstallMarkerPath().replace(/\\/g, '/'));
const errText = () => errorSpy.mock.calls.map(c => c.join(' ')).join('\n');
const logText = () => logSpy.mock.calls.map(c => c.join(' ')).join('\n');
const memberForceArgs = ['--llm', 'claude', '--member', '--workflows', 'none', '--transport', 'http', '--force'];

beforeEach(() => {
  vi.clearAllMocks();
  process.env.HOME = HOME;
  process.env.USERPROFILE = HOME;
  process.env.APRA_FLEET_DATA_DIR = DATA_DIR;
  delete process.env.APRA_FLEET_PORT;
  vi.mocked(os.homedir).mockReturnValue(HOME);
  files = new Map();
  kills = [];
  serverUp = true;
  setupFs();
  vi.mocked(getServiceManager).mockResolvedValue({
    register: vi.fn().mockResolvedValue('created'), unregister: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({ installed: false, running: false }), isInstalled: vi.fn().mockResolvedValue(false),
  } as any);
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  _setSeaOverride(true);
  _setManifestOverride({ version: '0.1.0', hooks: {}, scripts: {}, skills: {}, fleetSkills: {} });
  serverRunning();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
  // The Beads step checks bd --version against the pin; answer with a pinned bd.
  vi.mocked(execFileSync).mockImplementation(((cmd: string) => (String(cmd).endsWith('bd') ? 'bd version 1.3.0 (test)\n' : '')) as any);
  process.exitCode = undefined;
});

afterEach(() => {
  _setSeaOverride(null);
  _setManifestOverride(null);
  vi.restoreAllMocks();
  Object.defineProperty(process, 'platform', { value: process.platform, configurable: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  process.exitCode = undefined;
});

describe('full install on a fleet member host', () => {
  it('the marker lives in the sandbox data dir', () => {
    expect(memberInstallMarkerPath().replace(/\\/g, '/')).toBe(`${DATA_DIR}/member-install.json`);
  });

  it('refuses with the member-host code, names the marker and both upgrade paths, and touches nothing', async () => {
    const original = JSON.stringify({ version: '0.0.1', installedAt: 'x', port: 7611 }) + '\n';
    files.set(`${DATA_DIR}/member-install.json`, original);

    await expect(runInstall(['--skill', 'none', '--force'])).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    const err = errText();
    expect(err).toContain(MEMBER_HOST_FULL_INSTALL_CODE);
    expect(err).toContain('fleet member host');
    expect(err).toContain(`${DATA_DIR}/member-install.json`);
    expect(err).toContain('0.0.1');
    expect(err).toContain('7611');
    expect(err).toContain('update_member');
    expect(err).toContain('fleet_install: "auto"');
    expect(err).toMatch(/install --member[^\n]*--force/);
    expect(err).toContain(CONVERT_MEMBER_HOST_FLAG);
    // Marker byte-identical, running server not signalled, no service touched.
    expect(files.get(`${DATA_DIR}/member-install.json`)).toBe(original);
    expect(kills).toEqual([]);
    const svc = await getServiceManager();
    expect(svc.stop).not.toHaveBeenCalled();
    expect(svc.register).not.toHaveBeenCalled();
    expect(vi.mocked(fs.copyFileSync)).not.toHaveBeenCalled();
  });

  it('a malformed marker still makes the host a member host', async () => {
    files.set(`${DATA_DIR}/member-install.json`, 'not json');
    await expect(runInstall(['--skill', 'none', '--force'])).rejects.toThrow('exit');
    expect(errText()).toContain(MEMBER_HOST_FULL_INSTALL_CODE);
    expect(kills).toEqual([]);
  });

  it('with the convert flag the full install proceeds, removes the marker and says the host was converted', async () => {
    files.set(`${DATA_DIR}/member-install.json`, JSON.stringify({ version: '0.0.1', installedAt: 'x', port: 7611 }));
    await runInstall(['--skill', 'none', '--force', CONVERT_MEMBER_HOST_FLAG]);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(hasMarker()).toBe(false);
    expect(kills).toEqual(['SIGTERM:5678']);
    expect(logText()).toMatch(/Converted this fleet member host to a full install/);
    expect(errText()).not.toContain(MEMBER_HOST_FULL_INSTALL_CODE);
  });

  it('install --member --force on a marker host still upgrades: new version, recorded port kept', async () => {
    files.set(`${DATA_DIR}/member-install.json`, JSON.stringify({ version: '0.0.1', installedAt: 'x', port: 7611 }));
    await runInstall(memberForceArgs);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(kills).toEqual(['SIGTERM:5678']);
    expect(hasMarker()).toBe(true);
    expect(marker().version).toBe(serverVersion);
    expect(marker().port).toBe(7611);
    expect(errText()).not.toContain(MEMBER_HOST_FULL_INSTALL_CODE);
  });

  it('a full install into a data dir without a marker is unaffected', async () => {
    await runInstall(['--skill', 'none', '--force']);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(kills).toEqual(['SIGTERM:5678']);
    expect(errText()).not.toContain(MEMBER_HOST_FULL_INSTALL_CODE);
  });

  it('the refusal is per data dir: a marker in another data dir does not block', async () => {
    files.set(`${HOME}/.apra-fleet/data/member-install.json`, JSON.stringify({ version: '0.0.1', port: 7611 }));
    await runInstall(['--skill', 'none', '--force']);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(files.has(`${HOME}/.apra-fleet/data/member-install.json`)).toBe(true);
  });
});

/** Every path the install wrote, created, copied to or removed (mocked fs). */
function touchedPaths(): string[] {
  const m = vi.mocked(fs);
  return [
    ...m.writeFileSync.mock.calls.map(c => c[0]),
    ...m.appendFileSync.mock.calls.map(c => c[0]),
    ...m.mkdirSync.mock.calls.map(c => c[0]),
    ...m.copyFileSync.mock.calls.map(c => c[1]),
    ...m.renameSync.mock.calls.map(c => c[1]),
    ...m.rmSync.mock.calls.map(c => c[0]),
    ...m.chmodSync.mock.calls.map(c => c[0]),
  ].map(p => key(p));
}

describe('deploy on a member host keeps a member install of the deployed build', () => {
  it('member install -> deploy.md member path -> wrong full path refused; nothing outside the sandbox', async () => {
    // 1. Member install with an explicit port into the sandbox (no server yet).
    serverUp = false;
    await runInstall(['--llm', 'claude', '--member', '--workflows', 'none', '--transport', 'http', '--port', '7611']);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(hasMarker()).toBe(true);
    expect(marker().port).toBe(7611);

    // The marker an older build left behind; its server is now running.
    files.set(`${DATA_DIR}/member-install.json`, JSON.stringify({ ...marker(), version: '0.0.1' }));
    serverUp = true;

    // 2. The production deploy deploy.md prescribes for a marker host.
    await runInstall(memberForceArgs);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode ?? 0).toBe(0);
    expect(hasMarker()).toBe(true);
    expect(marker().version).toBe(serverVersion);
    expect(marker().port).toBe(7611);

    // 3. The wrong path: a plain full install --force on the same host.
    serverUp = true;
    kills = [];
    errorSpy.mockClear();
    const before = files.get(`${DATA_DIR}/member-install.json`);
    await expect(runInstall(['--force'])).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    const err = errText();
    expect(err).toContain(MEMBER_HOST_FULL_INSTALL_CODE);
    expect(err).toContain('fleet_install: "auto"');
    expect(err).toMatch(/install --member[^\n]*--force/);
    expect(files.get(`${DATA_DIR}/member-install.json`)).toBe(before);
    expect(kills).toEqual([]);

    // 4. Nothing was written outside the sandbox: this test's sandbox root, or
    // the per-run temp data dir tests/setup.ts provides (paths that modules
    // resolve at load time, e.g. the service notice, land there).
    const runDataDir = key(savedEnv.APRA_FLEET_DATA_DIR!);
    expect(runDataDir).toContain('apra-fleet-test-data');
    const touched = touchedPaths();
    expect(touched.length).toBeGreaterThan(0);
    const outside = touched.filter(p => !p.startsWith(`${SANDBOX}/`) && p !== runDataDir && !p.startsWith(`${runDataDir}/`));
    expect(outside).toEqual([]);
    const realHome = savedEnv.HOME ? key(savedEnv.HOME) : null;
    if (realHome) expect(touched.filter(p => p.startsWith(`${realHome}/`) && !p.startsWith(`${runDataDir}/`))).toEqual([]);
  });

  it('deploy.md Deploy pins member-install.json detection and install --member --force', async () => {
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const md = realFs.readFileSync(path.resolve(__dirname, '..', 'deploy.md'), 'utf8');
    const start = md.indexOf('\n## Deploy\n');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = md.indexOf('\n## ', start + 1);
    const deploy = md.slice(start, end < 0 ? undefined : end);
    expect(deploy).toMatch(/test -f [^\n]*member-install\.json/);
    expect(deploy).toMatch(/Test-Path[^\n]*member-install\.json/);
    expect(deploy).toMatch(/deploy-install\.mjs -- --member\b/);
    expect(deploy).toContain('install --member --force');
  });
});
