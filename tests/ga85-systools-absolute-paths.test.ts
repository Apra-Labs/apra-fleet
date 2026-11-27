/**
 * Windows: the fleet server and CLI never start taskkill / tasklist / schtasks /
 * whoami / cmd.exe by bare name (CreateProcess searches the cwd first), and
 * `apra-fleet start` runs the server with the data dir as its working folder.
 *
 * Runs on every OS: windowsExecutable is replaced by the REAL resolver with
 * injected win32 deps in which a planted taskkill.exe / schtasks.exe / ... sits
 * in the current directory, on a relative PATH entry and on an earlier absolute
 * PATH entry. Every site must hand its spawn spy the System32 path.
 * HOME and USERPROFILE point at a temp sandbox; nothing real is touched.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SYS32 = 'C:\\Windows\\System32';

const h = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: h.execFileSync,
  execSync: h.execSync,
  spawn: h.spawn,
  spawnSync: h.spawnSync,
}));

vi.mock('../src/os/windows-executable.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/os/windows-executable.js')>();
  const planted = (p: string) => /^(\.[\\/]|relative[\\/]|C:\\planted[\\/]|C:\\Windows\\System32[\\/])?[a-z0-9]+\.exe$/i.test(p);
  return {
    ...actual,
    windowsExecutable: (name: string) => actual.resolveWindowsExecutable(name, {
      platform: 'win32',
      // a planted file earlier on PATH: relative entry, then an absolute non-system dir
      pathValue: 'relative;.;C:\\planted;C:\\Windows\\System32',
      pathext: '.EXE',
      isFile: planted,
      systemRoot: 'C:\\Windows',
    }),
  };
});

const realPlatform = process.platform;
function setPlatform(p: string): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

const firstProgram = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => String(c[0]));

let sandbox: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-ga85-'));
  for (const k of ['HOME', 'USERPROFILE', 'APRA_FLEET_DATA_DIR']) savedEnv[k] = process.env[k];
  process.env.HOME = sandbox;
  process.env.USERPROFILE = sandbox;
  process.env.APRA_FLEET_DATA_DIR = path.join(sandbox, 'data');
});
afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(sandbox, { recursive: true, force: true });
});
beforeEach(() => {
  h.execFileSync.mockReset();
  h.execSync.mockReset();
  h.spawn.mockReset();
  h.spawnSync.mockReset();
});
afterEach(() => setPlatform(realPlatform));

describe('system tools resolve to System32 on win32 (planted files in cwd/PATH are ignored)', () => {
  it('strategy: killLocalProcessTree runs System32 taskkill.exe', async () => {
    setPlatform('win32');
    const { killLocalProcessTree } = await import('../src/services/strategy.js');
    killLocalProcessTree(4242, 'kill -9 4242');
    expect(firstProgram(h.execFileSync)).toEqual([`${SYS32}\\taskkill.exe`]);
  });

  it('process-utils: processImageName runs System32 tasklist.exe', async () => {
    h.execFileSync.mockReturnValue('"apra-fleet.exe","4242","Console","1","10,000 K"\r\n');
    const { processImageName } = await import('../src/utils/process-utils.js');
    processImageName(4242);
    expect(firstProgram(h.execFileSync)).toEqual([`${SYS32}\\tasklist.exe`]);
  });

  it('install-guard: getRunningApraFleetProcesses runs System32 tasklist.exe with no cmd.exe string command', async () => {
    setPlatform('win32');
    h.execFileSync.mockImplementation((file: string) => (
      /tasklist/i.test(file) ? '"apra-fleet.exe","4242","Console","1","10,000 K"\r\n' : '4242|C:\\x\\apra-fleet.exe\r\n'
    ));
    const { getRunningApraFleetProcesses } = await import('../src/cli/install-guard.js');
    expect(getRunningApraFleetProcesses()).toEqual([{ pid: 4242, exePath: 'C:\\x\\apra-fleet.exe' }]);
    expect(h.execFileSync.mock.calls[0]).toEqual([
      `${SYS32}\\tasklist.exe`, ['/FI', 'IMAGENAME eq apra-fleet.exe', '/NH', '/FO', 'CSV'], expect.anything(),
    ]);
    // The Get-Process lookup is an absolute powershell.exe too, never a bare name.
    expect(String(h.execFileSync.mock.calls[1][0])).toMatch(/^[A-Z]:\\.*\\powershell\.exe$/i);
    expect(h.execSync).not.toHaveBeenCalled();
  });

  it('owner-only-fs: the default whoami is System32 whoami.exe', async () => {
    h.execFileSync.mockReturnValue('CORP\\alice\r\n');
    vi.resetModules();
    const { currentWindowsUser } = await import('../src/utils/owner-only-fs.js');
    currentWindowsUser();
    expect(firstProgram(h.execFileSync)).toEqual([`${SYS32}\\whoami.exe`]);
  });

  it('dolt-install: killChild falls back to System32 taskkill.exe', async () => {
    const { killChild } = await import('../src/cli/dolt-install.js');
    const exec = vi.fn();
    const child = { pid: 99, exitCode: null, signalCode: null, kill: () => true, unref: () => {}, once: () => child, removeListener: () => child } as never;
    await killChild(child, { platform: 'win32', execFileSync: exec as never, waitMs: 5, warn: () => {} });
    expect(firstProgram(exec)).toEqual([`${SYS32}\\taskkill.exe`]);
  });

  it('claude-mod: the cmd.exe fallback for a .cmd shim is System32 cmd.exe', async () => {
    const { claudeSpawnSpec } = await import('../src/cli/claude-mod.js');
    const spec = claudeSpawnSpec('C:\\npm\\claude.cmd', ['--version'], 'win32', '');
    expect(spec.cmd).toBe(`${SYS32}\\cmd.exe`);
    expect(spec.verbatim).toBe(true);
  });

  it('claude-mod: a relative or non-cmd.exe ComSpec is ignored in favour of System32 cmd.exe', async () => {
    const { claudeSpawnSpec } = await import('../src/cli/claude-mod.js');
    expect(claudeSpawnSpec('C:\\npm\\claude.cmd', [], 'win32', 'cmd.exe').cmd).toBe(`${SYS32}\\cmd.exe`);
    expect(claudeSpawnSpec('C:\\npm\\claude.cmd', [], 'win32', 'C:\\evil\\pwn.exe').cmd).toBe(`${SYS32}\\cmd.exe`);
    expect(claudeSpawnSpec('C:\\npm\\claude.cmd', [], 'win32', 'D:\\alt\\cmd.exe').cmd).toBe('D:\\alt\\cmd.exe');
  });

  it('service manager: default schtasks runner and whoami use System32 paths', async () => {
    h.execFileSync.mockReturnValue('CORP\\alice\r\n');
    const { WindowsServiceManager, resolveTaskUserId } = await import('../src/services/service-manager/windows.js');
    await new WindowsServiceManager(undefined, path.join(sandbox, 'w.bat')).isInstalled();
    resolveTaskUserId();
    expect(firstProgram(h.execFileSync)).toEqual([`${SYS32}\\schtasks.exe`, `${SYS32}\\whoami.exe`]);
  });

  it('service manager: start() spawns System32 schtasks.exe (task) and cmd.exe (Run-key fallback)', async () => {
    const { WindowsServiceManager } = await import('../src/services/service-manager/windows.js');
    const spawned: string[] = [];
    const opts = { spawnDetached: (c: string) => { spawned.push(c); }, stoppedByUser: () => false, env: {} };
    // task registered -> detached schtasks /run
    await new WindowsServiceManager(() => '', path.join(sandbox, 'a.bat'), { ...opts, runReg: () => '' }).start();
    // no task, Run key present, no launcher -> detached cmd.exe /c wrapper
    const noTask = () => { throw new Error('not found'); };
    await new WindowsServiceManager(noTask, path.join(sandbox, 'b.bat'), { ...opts, runReg: () => '' }).start();
    expect(spawned).toEqual([`${SYS32}\\schtasks.exe`, `${SYS32}\\cmd.exe`]);
  });

  it('supervisor-service-cleanup: Windows query and removal use System32 schtasks.exe / taskkill.exe', async () => {
    setPlatform('win32');
    h.execFileSync.mockImplementation((file: string, args: string[]) => {
      if (/powershell/i.test(file)) return '1234\r\n';
      return '';
    });
    const { findSupervisorRegistrations, removeSupervisorRegistration, SUPERVISOR_WINDOWS_TASK_NAME } =
      await import('../src/services/supervisor-service-cleanup.js');
    findSupervisorRegistrations();
    try {
      removeSupervisorRegistration({
        platform: 'win32', name: SUPERVISOR_WINDOWS_TASK_NAME, definitionPath: null, target: null, installedByFleet: false,
      } as never);
    } catch { /* the wrapper cleanup may report; only the spawned programs matter */ }
    const programs = firstProgram(h.execFileSync).filter((p) => !/powershell/i.test(p));
    expect(programs.length).toBeGreaterThanOrEqual(3);
    for (const p of programs) expect([`${SYS32}\\schtasks.exe`, `${SYS32}\\taskkill.exe`]).toContain(p);
    expect(programs).toContain(`${SYS32}\\schtasks.exe`);
    expect(programs).toContain(`${SYS32}\\taskkill.exe`);
  });
});

describe('apra-fleet stop force-kill', () => {
  it('runs System32 taskkill.exe on win32 for a verified fleet server that ignores /shutdown', async () => {
    setPlatform('win32');
    vi.resetModules();
    vi.doMock('../src/services/singleton.js', () => ({
      checkRunningInstance: async () => ({ running: true, state: 'running', url: 'http://127.0.0.1:1/mcp', pid: 4242 }),
    }));
    vi.doMock('../src/utils/process-utils.js', () => ({
      isPidAlive: () => true, isApraFleetProcess: () => true, postShutdown: async () => {},
    }));
    vi.doMock('../src/services/stopped-marker.js', () => ({ writeStoppedMarker: () => {} }));
    vi.doMock('../src/services/service-notice.js', () => ({ showPendingServiceNotice: () => {} }));
    vi.doMock('../src/services/service-manager/index.js', () => ({
      getServiceManager: async () => ({ isInstalled: async () => false }),
    }));
    vi.doMock('../src/paths.js', () => ({
      SERVER_INFO_PATH: path.join(sandbox, 'server.json'), FLEET_DIR: sandbox, isNonDefaultInstance: () => false,
    }));
    const { runStop } = await import('../src/cli/stop.js');
    await runStop([]);
    expect(firstProgram(h.execFileSync)).toEqual([`${SYS32}\\taskkill.exe`]);
    vi.doUnmock('../src/services/singleton.js');
    vi.doUnmock('../src/utils/process-utils.js');
    vi.doUnmock('../src/services/stopped-marker.js');
    vi.doUnmock('../src/services/service-notice.js');
    vi.doUnmock('../src/services/service-manager/index.js');
    vi.doUnmock('../src/paths.js');
  }, 20_000);
});

describe('apra-fleet start: server working folder', () => {
  it('direct spawn passes cwd = the data dir (never the folder start was run from)', async () => {
    const dataDir = path.join(sandbox, 'start-data');
    vi.resetModules();
    vi.doMock('../src/services/singleton.js', () => ({
      checkRunningInstance: async () => (h.spawn.mock.calls.length > 0
        ? { running: true, state: 'running', url: 'http://127.0.0.1:1/mcp', pid: 7 }
        : { running: false, state: 'absent' }),
      describePreviousServer: () => null,
      isPortInUse: async () => false,
      portInUseMessage: () => '',
      readServerInfoPid: () => null,
      unresponsiveInstanceMessage: () => '',
    }));
    vi.doMock('../src/services/service-manager/index.js', () => ({
      getServiceManager: async () => ({ isInstalled: async () => false }),
    }));
    vi.doMock('../src/paths.js', () => ({
      LOG_FILE_PATH: path.join(dataDir, 'fleet.log'), FLEET_DIR: dataDir, DEFAULT_HOST: '127.0.0.1',
      isNonDefaultInstance: () => false, resolveServerPort: () => 1,
    }));
    vi.doMock('../src/services/stopped-marker.js', () => ({ clearStoppedMarker: () => {}, readStoppedMarker: () => null }));
    vi.doMock('../src/services/service-notice.js', () => ({ showPendingServiceNotice: () => {} }));
    h.spawn.mockReturnValue({ unref: () => {} });
    const { runStart } = await import('../src/cli/start.js');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = vi.useFakeTimers({ toFake: ['setTimeout'] });
    const done = runStart([]);
    await vi.advanceTimersByTimeAsync(2500);
    await done.catch(() => {});
    t.useRealTimers();
    log.mockRestore();
    err.mockRestore();
    expect(h.spawn).toHaveBeenCalledTimes(1);
    const opts = h.spawn.mock.calls[0][2] as { cwd?: string; detached?: boolean };
    expect(opts.cwd).toBe(dataDir);
    expect(opts.detached).toBe(true);
    expect(fs.existsSync(dataDir)).toBe(true);
    vi.doUnmock('../src/services/singleton.js');
    vi.doUnmock('../src/services/service-manager/index.js');
    vi.doUnmock('../src/services/stopped-marker.js');
    vi.doUnmock('../src/services/service-notice.js');
    vi.doUnmock('../src/paths.js');
  }, 20_000);

  it('Windows Run-key fallback: the default detached launch starts in the data dir (else home), never the CLI folder', async () => {
    vi.resetModules();
    const { WindowsServiceManager, detachedLaunchCwd } = await import('../src/services/service-manager/windows.js');
    const dataDir = path.join(sandbox, 'runkey-data');
    fs.mkdirSync(dataDir, { recursive: true });
    expect(detachedLaunchCwd(dataDir)).toBe(dataDir);
    expect(detachedLaunchCwd(path.join(sandbox, 'missing-data'))).toBe(os.homedir());

    h.spawn.mockReturnValue({ unref: () => {} });
    const noTask = () => { throw new Error('not found'); };
    await new WindowsServiceManager(noTask, path.join(sandbox, 'c.bat'), { runReg: () => '', stoppedByUser: () => false, env: {} }).start();
    expect(h.spawn).toHaveBeenCalledTimes(1);
    const opts = h.spawn.mock.calls[0][2] as { cwd?: string; detached?: boolean };
    expect(opts.detached).toBe(true);
    expect(opts.cwd).toBe(detachedLaunchCwd());
    expect(opts.cwd).not.toBe(process.cwd());
  });
});

describe('uninstall: cmd.exe shell for its run() steps', () => {
  it('source passes windowsExecutable(cmd.exe) as the win32 shell and no bare cmd.exe literal remains', () => {
    const text = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'cli', 'uninstall.ts'), 'utf8');
    expect(text).toContain("{ shell: windowsExecutable('cmd.exe') }");
    expect(text).not.toMatch(/shell:\s*'cmd\.exe'/);
  });
});
