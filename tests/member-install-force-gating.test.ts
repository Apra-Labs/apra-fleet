/**
 * `install --member --force` gating (apra-fleet-b4g.69.4): a member install does
 * not stop a running server a member install did not start unless explicitly forced.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { runInstall, _setSeaOverride, _setManifestOverride } from '../src/cli/install.js';
import { getServiceManager } from '../src/services/service-manager/index.js';
import { memberForceMayStop, fullInstallRefusalText, memberInstallMarkerPath } from '../src/cli/install-guard.js';

// ---------------------------------------------------------------------------
// install --member --force gating (real runInstall over mocked fs/os/process)
// ---------------------------------------------------------------------------

vi.mock('node:os', () => ({ default: { homedir: vi.fn(() => '/mock/home'), platform: vi.fn(() => 'linux') } }));
vi.mock('node:fs');
vi.mock('node:child_process');
vi.mock('../src/services/service-manager/index.js', () => ({ getServiceManager: vi.fn() }));

const mockHome = '/mock/home';
const runningExe = `${mockHome}/.apra-fleet/bin/apra-fleet`;

function setupFs(files: Map<string, string>) {
  vi.mocked(fs.existsSync).mockImplementation((p: any) => {
    const ps = p.toString();
    return ps.includes('version.json') || ps.includes('hooks-config.json') || files.has(ps);
  });
  vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
    const ps = p.toString();
    if (files.has(ps)) return files.get(ps)!;
    if (ps.includes('version.json')) return JSON.stringify({ version: '0.1.0' });
    if (ps.includes('hooks-config.json')) return JSON.stringify({ hooks: { PostToolUse: [] } });
    return '';
  });
  vi.mocked(fs.writeFileSync).mockImplementation((p: any, c: any) => { files.set(p.toString(), c.toString()); });
  vi.mocked(fs.rmSync).mockImplementation((p: any) => { files.delete(p.toString()); });
  vi.mocked(fs.readdirSync).mockReturnValue([] as any);
  vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
  vi.mocked(fs.chmodSync).mockImplementation(() => {});
  vi.mocked(fs.copyFileSync).mockImplementation(() => {});
}

function serverRunning(killLog: string[]) {
  let killed = false;
  vi.mocked(execSync).mockImplementation((cmd: any) => {
    const c = cmd.toString();
    if (c === 'pgrep -x apra-fleet') {
      if (killed) throw Object.assign(new Error('no match'), { status: 1 });
      return '5678\n' as any;
    }
    if (c.startsWith('pkill') || c.includes('/IM ')) throw new Error('name-based kill issued: ' + c);
    if (c.startsWith('readlink -f /proc/') || c.startsWith('ps -p ')) return `${runningExe}\n` as any;
    return '' as any;
  });
  // install --force stops the server by pid (never by name); process.kill is
  // stubbed so no real process is signalled. Signal 0 (isPidAlive) sees none.
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
    const s = String(sig ?? 'SIGTERM');
    if (s === '0') throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    killLog.push(`${s}:${pid}`);
    if (pid === 5678) killed = true;
    return true;
  }) as any);
}

describe('install --member --force over a server it did not start', () => {
  let files: Map<string, string>;
  let kills: string[];
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHome);
    files = new Map();
    kills = [];
    setupFs(files);
    vi.mocked(getServiceManager).mockResolvedValue({
      register: vi.fn().mockResolvedValue('created'), unregister: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue({ installed: false, running: false }), isInstalled: vi.fn().mockResolvedValue(false),
    } as any);
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    _setSeaOverride(true);
    _setManifestOverride({ version: '0.1.0', hooks: {}, scripts: {}, skills: {}, fleetSkills: {} });
    serverRunning(kills);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
  });

  afterEach(() => {
    _setSeaOverride(null);
    _setManifestOverride(null);
    vi.restoreAllMocks();
    Object.defineProperty(process, 'platform', { value: process.platform, configurable: true });
  });

  const memberArgs = ['--llm', 'claude', '--member', '--workflows', 'none', '--transport', 'http', '--force'];

  it('refuses without a member-install marker: names the running server and the override, stops nothing', async () => {
    await expect(runInstall(memberArgs)).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(3);
    expect(kills).toEqual([]);
    const err = errorSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(err).toContain('E-FULL-INSTALL-RUNNING');
    expect(err).toContain('pid 5678');
    expect(err).toContain('--force-stop-full-install');
  });

  it('the explicit override stops it', async () => {
    await runInstall([...memberArgs, '--force-stop-full-install']);
    expect(kills).toEqual(['SIGTERM:5678']);
  });

  it('a server a previous member install left behind (marker present) is stopped by plain --force', async () => {
    files.set(memberInstallMarkerPath(), '{}');
    await runInstall(memberArgs);
    expect(kills).toEqual(['SIGTERM:5678']);
  });

  it('legacy pre-marker member server (member install state, no member-install.json): --force alone exits 3 and does not kill it; the override stops it and the install proceeds', async () => {
    // A member installed by a build before the marker: its data dir exists,
    // the server runs from the member bin path, but no marker was ever written.
    files.set(`${mockHome}/.apra-fleet/data/install-config.json`, JSON.stringify({ providers: {} }));
    expect(files.has(memberInstallMarkerPath())).toBe(false);

    await expect(runInstall(memberArgs)).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(3);
    expect(kills).toEqual([]);
    expect(errorSpy.mock.calls.map(c => c.join(' ')).join('\n')).toContain('E-FULL-INSTALL-RUNNING');
    const svc = await getServiceManager();
    expect(svc.register).not.toHaveBeenCalled();

    exitSpy.mockClear();
    await runInstall([...memberArgs, '--force-stop-full-install']);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(kills).toEqual(['SIGTERM:5678']);
    expect(svc.register).toHaveBeenCalledTimes(1);
    expect(files.has(memberInstallMarkerPath())).toBe(true);
  });

  it('a full (non-member) install --force is unaffected', async () => {
    await runInstall(['--skill', 'none', '--force']);
    expect(kills).toEqual(['SIGTERM:5678']);
  });

  it('pure gate: only member-mode installs are gated', () => {
    expect(memberForceMayStop({ memberMode: false, overridden: false })).toBe(true);
    expect(fullInstallRefusalText('pid 1 (x)')).toContain('pid 1 (x)');
  });
});
