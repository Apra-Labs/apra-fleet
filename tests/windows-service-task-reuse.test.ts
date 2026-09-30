/**
 * Windows install --force: reuse an existing (elevated) ApraFleet task when
 * schtasks /create fails, and never leave a --force-stopped server down.
 * Everything is faked: schtasks goes through an injected runner, node:fs,
 * node:child_process and the home dir are mocked, and runInstall gets a fake
 * ServiceManager -- no real scheduled task or install dir is touched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { WindowsServiceManager, taskXmlCommand } from '../src/services/service-manager/windows.js';
import { runInstall, serviceRestartCommand, _setSeaOverride, _setManifestOverride } from '../src/cli/install.js';
import { getServiceManager } from '../src/services/service-manager/index.js';
import type { ServiceManager } from '../src/services/service-manager/types.js';

vi.mock('node:os', () => ({
  default: {
    homedir: vi.fn(() => '/mock/home'),
    platform: vi.fn(() => 'linux'),
  },
}));
vi.mock('node:fs');
vi.mock('node:child_process');
vi.mock('../src/services/service-manager/index.js', () => ({
  getServiceManager: vi.fn(),
  gracefulStopByServerJson: vi.fn(),
}));

const WRAPPER = 'C:\\Users\\u\\.apra-fleet\\bin\\apra-fleet-service.bat';
const taskXml = (cmd: string) =>
  `<?xml version="1.0" encoding="UTF-16"?>\r\n<Task><Actions Context="Author"><Exec><Command>${cmd}</Command></Exec></Actions></Task>`;
const deny = () => { throw new Error('ERROR: Access is denied.'); };

function fakeRunner(handlers: Partial<Record<'/create' | '/query' | '/run', () => Buffer | string>>) {
  const calls: string[][] = [];
  const run = vi.fn((args: string[]) => {
    calls.push(args);
    const h = handlers[args[0] as '/create' | '/query' | '/run'];
    if (!h) throw new Error(`unexpected schtasks ${args.join(' ')}`);
    return h();
  });
  return { run, calls };
}

describe('WindowsServiceManager task reuse on /create failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
  });

  it('(a) /create succeeds -> "created", no query, start() uses the detached path', async () => {
    const { run, calls } = fakeRunner({ '/create': () => '' });
    const mgr = new WindowsServiceManager('mcp-server', run, WRAPPER);
    expect(await mgr.register('C:\\bin\\apra-fleet.exe', ['--transport', 'http'], 'C:\\log.txt')).toBe('created');
    expect(calls.map(c => c[0])).toEqual(['/create']);
    // Wrapper written before /create so a reused task would run the new binary.
    expect(vi.mocked(fs.writeFileSync).mock.invocationCallOrder[0]).toBeLessThan(run.mock.invocationCallOrder[0]);
  });

  it('(b) /create denied + existing task runs the wrapper -> "reused", start runs /run synchronously', async () => {
    const { run, calls } = fakeRunner({ '/create': deny, '/query': () => taskXml(WRAPPER), '/run': () => 'SUCCESS' });
    const mgr = new WindowsServiceManager('mcp-server', run, WRAPPER);
    expect(await mgr.register('C:\\bin\\apra-fleet.exe', [], 'C:\\log.txt')).toBe('reused');
    await mgr.start();
    expect(calls).toEqual([
      expect.arrayContaining(['/create']),
      ['/query', '/tn', 'ApraFleet', '/xml'],
      ['/run', '/tn', 'ApraFleet'],
    ]);
  });

  it('(b) matches a UTF-16 (NUL-laden) XML with a quoted, case/slash-different command', async () => {
    const variant = `"${WRAPPER.toUpperCase().replace(/\\/g, '/')}"`;
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml(variant), 'utf16le')]);
    const nulLaden = Buffer.from(taskXml(variant), 'utf16le'); // no BOM: decoded as utf8, NULs stripped
    expect(taskXmlCommand(utf16)).toBe(variant);
    expect(taskXmlCommand(nulLaden)).toBe(variant);
    for (const raw of [utf16, nulLaden]) {
      const { run } = fakeRunner({ '/create': deny, '/query': () => raw });
      expect(await new WindowsServiceManager('mcp-server', run, WRAPPER).register('x', [], 'l')).toBe('reused');
    }
  });

  it('(c) /create denied + no existing task -> loud error carrying the /create error', async () => {
    const { run } = fakeRunner({ '/create': deny, '/query': () => { throw new Error('task not found'); } });
    await expect(new WindowsServiceManager('mcp-server', run, WRAPPER).register('x', [], 'l'))
      .rejects.toThrow(/no existing ApraFleet task.*Access is denied/);
  });

  it('(d) /create denied + existing task points elsewhere -> loud error', async () => {
    const { run } = fakeRunner({ '/create': deny, '/query': () => taskXml('C:\\other\\thing.bat') });
    await expect(new WindowsServiceManager('mcp-server', run, WRAPPER).register('x', [], 'l'))
      .rejects.toThrow(/runs C:\\other\\thing\.bat.*Access is denied/);
  });

  it('(e) reused task + /run fails -> start() rejects', async () => {
    const { run } = fakeRunner({ '/create': deny, '/query': () => taskXml(WRAPPER), '/run': () => { throw new Error('exit 1'); } });
    const mgr = new WindowsServiceManager('mcp-server', run, WRAPPER);
    await mgr.register('x', [], 'l');
    await expect(mgr.start()).rejects.toThrow(/schtasks \/run \/tn ApraFleet failed: exit 1/);
  });
});

describe('runInstall --force service step never leaves the server stopped', () => {
  const runningExe = '/mock/home/.apra-fleet/bin/apra-fleet';
  let serviceStopped: boolean;
  let logLines: string[];
  let errLines: string[];

  function fakeSvc(overrides: Partial<ServiceManager>): ServiceManager {
    return {
      register: vi.fn().mockResolvedValue('created'),
      unregister: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockImplementation(async () => { serviceStopped = true; }),
      query: vi.fn().mockResolvedValue({ installed: true, running: false }),
      isInstalled: vi.fn().mockResolvedValue(true),
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/mock/home');
    vi.mocked(fs.existsSync).mockImplementation((p: any) => /version\.json|hooks-config\.json/.test(p.toString()));
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (ps.includes('version.json')) return JSON.stringify({ version: '0.1.0' });
      if (ps.includes('hooks-config.json')) return JSON.stringify({ hooks: { PostToolUse: [] } });
      return '';
    });
    vi.mocked(fs.readdirSync).mockReturnValue([] as any);
    vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
    vi.mocked(fs.chmodSync).mockImplementation(() => {});
    vi.mocked(fs.copyFileSync).mockImplementation(() => {});
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    _setSeaOverride(true);
    _setManifestOverride({ version: '0.1.0', hooks: {}, scripts: {}, skills: {}, fleetSkills: {} });
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    serviceStopped = false;
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      const c = cmd.toString();
      if (c === 'pgrep -x apra-fleet') {
        if (serviceStopped) throw Object.assign(new Error('no match'), { status: 1 });
        return '5678\n' as any;
      }
      if (c.startsWith('readlink -f /proc/')) return `${runningExe}\n` as any;
      return '' as any;
    });
    logLines = [];
    errLines = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => { logLines.push(a.join(' ')); });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation((...a) => { errLines.push(a.join(' ')); });
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
  });

  afterEach(() => {
    _setSeaOverride(null);
    _setManifestOverride(null);
    Object.defineProperty(process, 'platform', { value: process.platform, configurable: true });
    vi.restoreAllMocks();
  });

  it('--force + registration failure exits 1 with the restart command, before "installed successfully"', async () => {
    const svc = fakeSvc({ register: vi.fn().mockRejectedValue(new Error('Access is denied')) });
    vi.mocked(getServiceManager).mockResolvedValue(svc);
    await expect(runInstall(['--skill', 'none', '--workflows', 'none', '--force', '--transport', 'http'])).rejects.toThrow('exit');
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(errLines.join('\n')).toContain(serviceRestartCommand());
    expect(logLines.join('\n')).not.toContain('installed successfully');
  });

  it('--force stopped a manual (non-service) run + registration failure -> suggests apra-fleet start, not the service restart command', async () => {
    let stopped = false;
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      const c = cmd.toString();
      if (c === 'pgrep -x apra-fleet') {
        if (stopped) throw Object.assign(new Error('no match'), { status: 1 });
        return '5678\n' as any;
      }
      if (c === 'pkill -x apra-fleet') {
        stopped = true;
        return '' as any;
      }
      if (c.startsWith('readlink -f /proc/')) return `${runningExe}\n` as any;
      return '' as any;
    });
    const svc = fakeSvc({
      isInstalled: vi.fn().mockResolvedValue(false),
      register: vi.fn().mockRejectedValue(new Error('Access is denied')),
    });
    vi.mocked(getServiceManager).mockResolvedValue(svc);
    await expect(runInstall(['--skill', 'none', '--workflows', 'none', '--force', '--transport', 'http'])).rejects.toThrow('exit');
    expect(process.exit).toHaveBeenCalledWith(1);
    const err = errLines.join('\n');
    expect(err).toContain('apra-fleet start');
    expect(err).not.toContain(serviceRestartCommand());
  });

  it('reused task + start ok -> success summary notes reuse, no exit', async () => {
    const svc = fakeSvc({ register: vi.fn().mockResolvedValue('reused') });
    vi.mocked(getServiceManager).mockResolvedValue(svc);
    await runInstall(['--skill', 'none', '--workflows', 'none', '--force', '--transport', 'http']);
    const log = logLines.join('\n');
    expect(log).toContain('registered and running (existing task reused)');
    expect(log).toContain('installed successfully');
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('reused task + start fails -> never unregisters the pre-existing task, exits 1', async () => {
    const svc = fakeSvc({
      register: vi.fn().mockResolvedValue('reused'),
      start: vi.fn().mockRejectedValue(new Error('schtasks /run failed')),
    });
    vi.mocked(getServiceManager).mockResolvedValue(svc);
    await expect(runInstall(['--skill', 'none', '--workflows', 'none', '--force', '--transport', 'http'])).rejects.toThrow('exit');
    expect(svc.unregister).not.toHaveBeenCalled();
    expect(logLines.join('\n')).not.toContain('installed successfully');
  });

  it('server not running beforehand -> registration failure stays a warning (unchanged)', async () => {
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      if (cmd.toString() === 'pgrep -x apra-fleet') throw Object.assign(new Error('no match'), { status: 1 });
      return '' as any;
    });
    const svc = fakeSvc({ register: vi.fn().mockRejectedValue(new Error('Access is denied')) });
    vi.mocked(getServiceManager).mockResolvedValue(svc);
    await runInstall(['--skill', 'none', '--workflows', 'none', '--force', '--transport', 'http']);
    expect(process.exit).not.toHaveBeenCalled();
    expect(logLines.join('\n')).toContain('installed successfully');
  });
});
