import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { applyIsolatedHome } from './helpers/isolated-home.mjs';

// apra-fleet-y3xp.2: home isolation for EVERY test in this file.
// runStop/runRestart (when the mocked RUNNING fixture is active) reach
// src/utils/process-utils.ts's postShutdown(), which dynamically imports
// the REAL (unmocked) src/services/jwt.ts and calls getOrCreateKey() for
// its auth header. setupFsSpies() below globally mocks fs.readFileSync to
// always return SERVER_INFO's JSON (a different shape/length than the
// 64-char key), which makes getOrCreateKey() treat the real key as
// missing/invalid; jwt.ts's own fs.writeFileSync is NOT mocked, and
// os.homedir() was not overridden anywhere in this file, so this used to
// mint and write a BRAND NEW random key over the operator's real
// ~/.apra-fleet/fleet.key on every one of those test runs -- verified live
// (sha256 of the real file changed after an isolated run of this file
// alone, mtime moving to the exact run second) before this fix, and
// confirmed unchanged after it. http.request is already mocked
// (setupHttpSpies()) so no real network call was ever involved; this was
// purely the getOrCreateKey() write path.
let restoreHome: (() => Promise<void>) | undefined;
beforeEach(async () => {
  restoreHome = (await applyIsolatedHome('cli-verbs-home-')).restore;
});
afterEach(async () => {
  await restoreHome?.();
});

// ---------------------------------------------------------------------------
// Hoisted mock refs -- local modules only (these are safe; factory mocks for
// built-in node modules leak in fileParallelism:false mode, so we use spies)
// ---------------------------------------------------------------------------
const { mockCheckRunning, mockGetSvcMgr, mockSvcMgr } = vi.hoisted(() => {
  const mockSvcMgr = {
    isInstalled: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
    start: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    stop: vi.fn<() => Promise<boolean | void>>().mockResolvedValue(undefined),
    query: vi.fn<() => Promise<{ installed: boolean; running: boolean; enabled?: boolean }>>()
      .mockResolvedValue({ installed: false, running: false }),
    register: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    unregister: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
  return {
    mockCheckRunning: vi.fn<() => Promise<{ running: boolean; url?: string; pid?: number; version?: string }>>()
      .mockResolvedValue({ running: false }),
    mockGetSvcMgr: vi.fn<() => Promise<typeof mockSvcMgr>>().mockResolvedValue(mockSvcMgr),
    mockSvcMgr,
  };
});

const { mockPortInUse } = vi.hoisted(() => ({
  mockPortInUse: vi.fn<(port: number, host?: string) => Promise<boolean>>().mockResolvedValue(false),
}));

vi.mock('../src/services/singleton.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/singleton.js')>()),
  checkRunningInstance: mockCheckRunning,
  isPortInUse: mockPortInUse,
  readServerInfoPid: () => undefined,
}));

vi.mock('../src/services/service-manager/index.js', () => ({
  getServiceManager: mockGetSvcMgr,
}));

// Auto-mock (no factory) so named imports get stubs -- auto-mocks clean up
// between files in sequential mode; factory mocks do not.
vi.mock('node:child_process');

// ---------------------------------------------------------------------------
// Imports of subjects under test (after mocks so mocks apply)
// ---------------------------------------------------------------------------
import { runStart } from '../src/cli/start.js';
import { runStop } from '../src/cli/stop.js';
import { runRestart } from '../src/cli/restart.js';
import { runStatus } from '../src/cli/status.js';
import { serverVersion } from '../src/version.js';
import { FLEET_SE_PREREQ_FIX_LINE } from '../src/cli/fleet-se-prereqs.js';
import type { FleetSePrereqResult } from '../src/cli/fleet-se-prereqs.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------
const RUNNING = { running: true as const, state: 'running' as const, url: 'http://127.0.0.1:7523/mcp', pid: 1234 };
const STOPPED = { running: false as const, state: 'gone' as const };
const UNRESPONSIVE = { running: false as const, state: 'unresponsive' as const, url: 'http://127.0.0.1:7523/mcp', pid: 1234, port: 7523 };
const SERVER_INFO = JSON.stringify({ pid: 1234, port: 7523, url: 'http://127.0.0.1:7523/mcp' });
const HEALTH_BODY = JSON.stringify({ version: 'v0.1', uptime: 30, sessions: 1 });

// ---------------------------------------------------------------------------
// Per-test spy helpers (vi.spyOn restores cleanly in afterEach -- no leakage)
// ---------------------------------------------------------------------------
function setupFsSpies() {
  vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined as any);
  vi.spyOn(fs, 'openSync').mockReturnValue(3 as any);
  vi.spyOn(fs, 'closeSync').mockReturnValue(undefined);
  vi.spyOn(fs, 'unlinkSync').mockReturnValue(undefined);
  vi.spyOn(fs, 'existsSync').mockReturnValue(true); // lets findProjectRoot() succeed
  vi.spyOn(fs, 'readFileSync').mockReturnValue(SERVER_INFO as any);
  // runStop -> postShutdown -> getOrCreateKey() reads the fleet key through the
  // readFileSync spy above (SERVER_INFO is not a 64-char key) and then WROTE a
  // fresh key to ~/.apra-fleet/fleet.key with the real writeFileSync --
  // rewriting the developer's real signing key and invalidating member JWTs.
  vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
}

function setupHttpSpies() {
  const mockReq = { on: vi.fn().mockReturnThis(), end: vi.fn(), destroy: vi.fn() };
  vi.spyOn(http, 'request').mockImplementation(
    (_opts: any, cb?: (res: any) => void) => {
      cb?.({ resume: vi.fn() });
      return mockReq as any;
    },
  );
  vi.spyOn(http, 'get').mockImplementation(
    (_opts: any, cb?: (res: any) => void) => {
      cb?.({
        on(ev: string, handler: (...a: any[]) => void) {
          if (ev === 'data') handler(Buffer.from(HEALTH_BODY));
          if (ev === 'end') handler();
        },
      });
      return mockReq as any;
    },
  );
}

// ---------------------------------------------------------------------------
// runStart
// ---------------------------------------------------------------------------
describe('runStart', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    setupFsSpies();
    mockCheckRunning.mockResolvedValue(STOPPED);
    mockPortInUse.mockResolvedValue(false);
    mockSvcMgr.isInstalled.mockResolvedValue(false);
    vi.mocked(spawn).mockReturnValue({ unref: vi.fn() } as any);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // GitHub #584: a live-but-unresponsive server is not "stopped".
  it('refuses with pid/port and a stop hint when the server is unresponsive', async () => {
    mockCheckRunning.mockResolvedValue(UNRESPONSIVE);
    await runStart([]);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const msg = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(msg).toContain('pid 1234');
    expect(msg).toContain('port 7523');
    expect(msg).toContain('apra-fleet stop');
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    expect(mockGetSvcMgr).not.toHaveBeenCalled();
  });

  // GitHub #585: start reports an unclean previous exit before starting.
  it('prints the previous-server note before starting a new server', async () => {
    mockCheckRunning
      .mockResolvedValueOnce({ ...STOPPED, previous: { pid: 778, startedAt: 'T1', lastLogAt: 'T2' } })
      .mockResolvedValueOnce(RUNNING);
    vi.useFakeTimers();
    const p = runStart([]);
    await vi.advanceTimersByTimeAsync(2001);
    await p;
    const lines = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(lines[0]).toContain('previous server pid 778 (started T1, last log T2) exited without a shutdown record');
    expect(vi.mocked(spawn)).toHaveBeenCalled();
  });

  // GitHub #584: no random-port fallback -- a taken port is a clear error.
  it('refuses with a message naming the port and APRA_FLEET_PORT when the configured port is taken', async () => {
    mockPortInUse.mockResolvedValue(true);
    await runStart([]);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const msg = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(msg).toContain('Port 7523');
    expect(msg).toContain('APRA_FLEET_PORT');
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    expect(mockGetSvcMgr).not.toHaveBeenCalled();
  });

  it('reports already running and skips service manager when server is up', async () => {
    mockCheckRunning.mockResolvedValue(RUNNING);
    await runStart([]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('already running'));
    expect(mockGetSvcMgr).not.toHaveBeenCalled();
  });

  it('calls service manager start when unit is installed', async () => {
    // apra-fleet-eft.51.1: this is the "default instance" case (no
    // APRA_FLEET_PORT/APRA_FLEET_DATA_DIR sandbox override), so svcMgr.start()
    // must still run. tests/setup.ts always sets APRA_FLEET_DATA_DIR for test
    // isolation, so temporarily clear it here to represent an un-overridden
    // (default) instance -- restored in afterEach via the saved value below.
    const savedDataDir = process.env.APRA_FLEET_DATA_DIR;
    delete process.env.APRA_FLEET_DATA_DIR;
    try {
      mockSvcMgr.isInstalled.mockResolvedValue(true);
      mockCheckRunning.mockResolvedValueOnce(STOPPED).mockResolvedValueOnce(RUNNING);
      vi.useFakeTimers();
      const p = runStart([]);
      await vi.advanceTimersByTimeAsync(2001);
      await p;
      expect(mockSvcMgr.start).toHaveBeenCalled();
    } finally {
      if (savedDataDir !== undefined) process.env.APRA_FLEET_DATA_DIR = savedDataDir;
    }
  });

  it('falls back to direct spawn when service manager reports installed but start() throws (e.g. no D-Bus session)', async () => {
    // isInstalled() can report true from a leftover unit file alone even when
    // registration never fully completed (daemon-reload failed for lack of a
    // D-Bus/systemd user session, e.g. a headless CI runner) -- in that case
    // svcMgr.start() fails the same way `systemctl --user start` would.
    const savedDataDir = process.env.APRA_FLEET_DATA_DIR;
    delete process.env.APRA_FLEET_DATA_DIR;
    try {
      mockSvcMgr.isInstalled.mockResolvedValue(true);
      mockSvcMgr.start.mockRejectedValueOnce(new Error('Command failed: systemctl --user start apra-fleet'));
      mockCheckRunning.mockResolvedValueOnce(STOPPED).mockResolvedValueOnce(RUNNING);
      vi.useFakeTimers();
      const p = runStart([]);
      await vi.advanceTimersByTimeAsync(2001);
      await p;
      expect(mockSvcMgr.start).toHaveBeenCalled();
      expect(vi.mocked(spawn)).toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalledWith(1);
    } finally {
      if (savedDataDir !== undefined) process.env.APRA_FLEET_DATA_DIR = savedDataDir;
    }
  });

  it('direct-spawns and skips service manager start for a non-default instance (custom port)', async () => {
    const savedPort = process.env.APRA_FLEET_PORT;
    process.env.APRA_FLEET_PORT = '18700';
    try {
      mockSvcMgr.isInstalled.mockResolvedValue(true);
      mockCheckRunning.mockResolvedValueOnce(STOPPED).mockResolvedValueOnce(RUNNING);
      vi.useFakeTimers();
      const p = runStart([]);
      await vi.advanceTimersByTimeAsync(2001);
      await p;
      expect(mockSvcMgr.start).not.toHaveBeenCalled();
      expect(vi.mocked(spawn)).toHaveBeenCalled();
    } finally {
      if (savedPort === undefined) delete process.env.APRA_FLEET_PORT;
      else process.env.APRA_FLEET_PORT = savedPort;
    }
  });

  it('spawns a detached process when no service unit is installed', async () => {
    mockCheckRunning.mockResolvedValueOnce(STOPPED).mockResolvedValueOnce(RUNNING);
    vi.useFakeTimers();
    const p = runStart([]);
    await vi.advanceTimersByTimeAsync(2001);
    await p;
    expect(vi.mocked(spawn)).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['--transport', 'http']),
      expect.objectContaining({ detached: true }),
    );
  });

  it('logs success URL after server comes up', async () => {
    mockCheckRunning.mockResolvedValueOnce(STOPPED).mockResolvedValueOnce(RUNNING);
    vi.useFakeTimers();
    const p = runStart([]);
    await vi.advanceTimersByTimeAsync(2001);
    await p;
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Server started'));
  });

  it('exits with code 1 when server does not come up in time', async () => {
    mockCheckRunning.mockResolvedValue(STOPPED);
    vi.useFakeTimers();
    const p = runStart([]);
    await vi.advanceTimersByTimeAsync(2001);
    await p;
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // apra-fleet-yru.2: verification for apra-fleet-yru.1 (version-freshness
  // fix) -- a running server reporting a DIFFERENT version than the
  // installed one must be refused loud, not silently reused.
  it('refuses to reuse a running server whose version does not match the installed version', async () => {
    mockCheckRunning.mockResolvedValue({
      ...RUNNING,
      version: 'v0.0.1-stale-does-not-match',
    });
    await runStart([]);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('v0.0.1-stale-does-not-match'),
    );
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining(serverVersion),
    );
    expect(mockGetSvcMgr).not.toHaveBeenCalled();
  });

  // apra-fleet-yru.2: matching versions must preserve the existing reuse
  // (fast path) behaviour -- no error, no exit(1), no service-manager call.
  it('reuses a running server whose version matches the installed version', async () => {
    mockCheckRunning.mockResolvedValue({ ...RUNNING, version: serverVersion });
    await runStart([]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('already running'));
    expect(errSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockGetSvcMgr).not.toHaveBeenCalled();
  });

  // apra-fleet-5co8.23: deliberate leniency -- an older server.json predating
  // version recording (no `version` field at all, as opposed to a mismatched
  // one) must NOT be refused. This pins the existing lenient reuse behaviour
  // as an explicit invariant rather than something only incidentally covered
  // by the plain "already running" fixture.
  it('reuses a running server whose server.json predates version recording (no version field) -- deliberate leniency', async () => {
    mockCheckRunning.mockResolvedValue(RUNNING); // RUNNING has no `version` field
    await runStart([]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('already running'));
    expect(errSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockGetSvcMgr).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// runStop
// ---------------------------------------------------------------------------
describe('runStop', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    setupFsSpies();
    setupHttpSpies();
    mockCheckRunning.mockResolvedValue(STOPPED);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Make isPidAlive return false immediately so the polling loop exits
    killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid, sig) => {
      if (sig === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs "not running" and skips /shutdown when server is stopped', async () => {
    await runStop([]);
    expect(logSpy).toHaveBeenCalledWith('Server is not running.');
    expect(http.request).not.toHaveBeenCalled();
  });

  it('force-stops an unresponsive server instead of reporting it not running', async () => {
    mockCheckRunning.mockResolvedValue(UNRESPONSIVE);
    await runStop([]);
    expect(logSpy).not.toHaveBeenCalledWith('Server is not running.');
    expect(http.request).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('Server stopped.');
  });

  it('posts /shutdown when server is running', async () => {
    mockCheckRunning.mockResolvedValue(RUNNING);
    await runStop([]);
    expect(http.request).toHaveBeenCalled();
  });

  // GitHub #584 review: never force-kill a reused pid that is not apra-fleet.
  describe('force-kill guard', () => {
    function pidStaysAlive() {
      killSpy.mockImplementation(() => true); // kill(pid, 0) succeeds -> alive
    }
    function forceKillCalls(): number {
      const taskkills = vi.mocked(execFileSync).mock.calls.filter((c) => c[0] === 'taskkill').length;
      const sigkills = killSpy.mock.calls.filter((c: unknown[]) => c[1] === 'SIGKILL').length;
      return taskkills + sigkills;
    }

    it('refuses to force-kill a surviving pid whose command line is not apra-fleet', async () => {
      mockCheckRunning.mockResolvedValue(UNRESPONSIVE);
      pidStaysAlive();
      vi.mocked(execFileSync).mockReturnValue('C:\\Windows\\System32\\notepad.exe' as any);
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.useFakeTimers();
      try {
        const p = runStop([]);
        await vi.advanceTimersByTimeAsync(6000);
        await p;
      } finally {
        vi.useRealTimers();
      }
      expect(forceKillCalls()).toBe(0);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('not force-killing'));
      expect(logSpy).not.toHaveBeenCalledWith('Server stopped.');
      expect(fs.unlinkSync).not.toHaveBeenCalled();
      process.exitCode = 0;
    });

    it('force-kills a surviving pid that is verifiably apra-fleet', async () => {
      mockCheckRunning.mockResolvedValue(UNRESPONSIVE);
      pidStaysAlive();
      vi.mocked(execFileSync).mockReturnValue('"C:\\Users\\u\\bin\\apra-fleet.exe" --transport http' as any);
      vi.useFakeTimers();
      try {
        const p = runStop([]);
        await vi.advanceTimersByTimeAsync(6000);
        await p;
      } finally {
        vi.useRealTimers();
      }
      expect(forceKillCalls()).toBe(1);
      expect(logSpy).toHaveBeenCalledWith('Server stopped.');
    });
  });

  describe('registered OS service', () => {
    // tests/setup.ts sets APRA_FLEET_DATA_DIR; clear it (and any port override)
    // so this is the default instance that owns the registered service.
    const saved = { dir: process.env.APRA_FLEET_DATA_DIR, port: process.env.APRA_FLEET_PORT };
    beforeEach(() => { delete process.env.APRA_FLEET_DATA_DIR; delete process.env.APRA_FLEET_PORT; });
    afterEach(() => {
      if (saved.dir !== undefined) process.env.APRA_FLEET_DATA_DIR = saved.dir;
      if (saved.port !== undefined) process.env.APRA_FLEET_PORT = saved.port;
      mockSvcMgr.isInstalled.mockResolvedValue(false);
      process.exitCode = 0;
    });

    it('reports "Server stopped." when the service stop succeeds', async () => {
      mockSvcMgr.isInstalled.mockResolvedValue(true);
      mockSvcMgr.stop.mockResolvedValueOnce(true);
      await runStop([]);
      expect(mockSvcMgr.stop).toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith('Server stopped.');
      expect(process.exitCode ?? 0).toBe(0);
    });

    it('propagates a force-kill refusal: no success line, exit code 1', async () => {
      mockSvcMgr.isInstalled.mockResolvedValue(true);
      // v0.5: runStop first stops the fleet-supervisor service through its own
      // manager -- give that call a not-installed stub so the refusal below
      // reaches the MCP server's stop().
      mockGetSvcMgr.mockResolvedValueOnce({ ...mockSvcMgr, isInstalled: vi.fn().mockResolvedValue(false) } as any);
      mockSvcMgr.stop.mockResolvedValueOnce(false);
      await runStop([]);
      expect(mockGetSvcMgr).toHaveBeenCalledWith('fleet-supervisor');
      expect(logSpy).not.toHaveBeenCalledWith('Server stopped.');
      expect(process.exitCode).toBe(1);
    });
  });

  it('reports "Server stopped." after shutdown', async () => {
    mockCheckRunning.mockResolvedValue(RUNNING);
    await runStop([]);
    expect(logSpy).toHaveBeenCalledWith('Server stopped.');
  });

  it('cleans up server.json and lock file after stop', async () => {
    mockCheckRunning.mockResolvedValue(RUNNING);
    await runStop([]);
    expect(fs.unlinkSync).toHaveBeenCalledTimes(2);
  });

  // Sandboxed (non-default) instance: stop must never touch registered OS
  // services -- symmetric with runStart's isNonDefaultInstance() guard.
  describe('non-default instance', () => {
    const saved = { dir: process.env.APRA_FLEET_DATA_DIR, port: process.env.APRA_FLEET_PORT };
    afterEach(() => {
      if (saved.dir === undefined) delete process.env.APRA_FLEET_DATA_DIR; else process.env.APRA_FLEET_DATA_DIR = saved.dir;
      if (saved.port === undefined) delete process.env.APRA_FLEET_PORT; else process.env.APRA_FLEET_PORT = saved.port;
      mockSvcMgr.isInstalled.mockResolvedValue(false);
    });

    function expectNoServiceTouched() {
      expect(mockGetSvcMgr).not.toHaveBeenCalled();
      expect(mockSvcMgr.isInstalled).not.toHaveBeenCalled();
      expect(mockSvcMgr.stop).not.toHaveBeenCalled();
      for (const call of vi.mocked(execFileSync).mock.calls) {
        const [cmd, args] = call as [string, string[] | undefined];
        expect(cmd).not.toBe('schtasks');
        expect(args ?? []).not.toContain('/T');
      }
    }

    it('APRA_FLEET_DATA_DIR set: never stops the registered service, stops own server', async () => {
      process.env.APRA_FLEET_DATA_DIR = '/tmp/sandbox-data';
      delete process.env.APRA_FLEET_PORT;
      mockSvcMgr.isInstalled.mockResolvedValue(true);
      mockCheckRunning.mockResolvedValue(RUNNING);
      await runStop([]);
      expectNoServiceTouched();
      expect(http.request).toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith('Server stopped.');
    });

    it('non-7523 APRA_FLEET_PORT: never stops the registered service, stops own server', async () => {
      delete process.env.APRA_FLEET_DATA_DIR;
      process.env.APRA_FLEET_PORT = '18800';
      mockSvcMgr.isInstalled.mockResolvedValue(true);
      mockCheckRunning.mockResolvedValue({ ...RUNNING, url: 'http://127.0.0.1:18800/mcp' });
      await runStop([]);
      expectNoServiceTouched();
      expect(http.request).toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith('Server stopped.');
    });

    it('non-7523 APRA_FLEET_PORT: does not shut down a different-port server from the shared server.json', async () => {
      delete process.env.APRA_FLEET_DATA_DIR;
      process.env.APRA_FLEET_PORT = '18800';
      mockSvcMgr.isInstalled.mockResolvedValue(true);
      mockCheckRunning.mockResolvedValue(RUNNING); // production on 7523
      await runStop([]);
      expectNoServiceTouched();
      expect(http.request).not.toHaveBeenCalled();
      expect(process.kill).not.toHaveBeenCalledWith(1234, 'SIGKILL');
    });
  });
});

// ---------------------------------------------------------------------------
// runRestart
// ---------------------------------------------------------------------------
describe('runRestart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupFsSpies();
    setupHttpSpies();
    vi.mocked(spawn).mockReturnValue({ unref: vi.fn() } as any);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);
    vi.spyOn(process, 'kill').mockImplementation((_pid, sig) => {
      if (sig === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      return true;
    });
    mockSvcMgr.isInstalled.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('stops then starts the server', async () => {
    mockCheckRunning
      .mockResolvedValueOnce(RUNNING)   // stop: running
      .mockResolvedValueOnce(STOPPED)   // start: not running
      .mockResolvedValueOnce(RUNNING);  // start: verify after 2s
    vi.useFakeTimers();
    const p = runRestart([]);
    await vi.advanceTimersByTimeAsync(2001);
    await p;
    expect(http.request).toHaveBeenCalled();   // /shutdown was posted
    expect(vi.mocked(spawn)).toHaveBeenCalled(); // process was spawned
  });

  it('is idempotent when server is already stopped before restart', async () => {
    mockCheckRunning
      .mockResolvedValueOnce(STOPPED)   // stop: not running (no-op)
      .mockResolvedValueOnce(STOPPED)   // start: not running
      .mockResolvedValueOnce(RUNNING);  // start: verify after 2s
    vi.useFakeTimers();
    const p = runRestart([]);
    await vi.advanceTimersByTimeAsync(2001);
    await p;
    expect(vi.mocked(spawn)).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// runStatus
// ---------------------------------------------------------------------------
describe('runStatus', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    setupFsSpies();
    setupHttpSpies();
    mockCheckRunning.mockResolvedValue(STOPPED);
    mockSvcMgr.query.mockResolvedValue({ installed: false, running: false });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function output(): string {
    return logSpy.mock.calls.map(c => c.join(' ')).join('\n');
  }

  it('shows stopped state when server is not running', async () => {
    await runStatus([]);
    expect(output()).toContain('stopped');
  });

  it('shows "not installed" when no service unit exists', async () => {
    await runStatus([]);
    expect(output()).toContain('not installed');
  });

  it('shows "installed (enabled)" when service unit is enabled', async () => {
    mockSvcMgr.query.mockResolvedValue({ installed: true, running: true, enabled: true });
    await runStatus([]);
    expect(output()).toContain('installed (enabled)');
  });

  it('shows "installed (disabled)" when service unit is disabled', async () => {
    mockSvcMgr.query.mockResolvedValue({ installed: true, running: false, enabled: false });
    await runStatus([]);
    expect(output()).toContain('installed (disabled)');
  });

  it('shows running state with URL when server is up', async () => {
    mockCheckRunning.mockResolvedValue(RUNNING);
    await runStatus([]);
    expect(output()).toContain('running');
    expect(output()).toContain(RUNNING.url);
  });

  it('shows health info (version, uptime, sessions) from /health endpoint', async () => {
    mockCheckRunning.mockResolvedValue(RUNNING);
    await runStatus([]);
    expect(output()).toContain('v0.1');
    expect(output()).toContain('30s');
    expect(output()).toContain('1');
  });

  it('omits live fields when server is stopped', async () => {
    await runStatus([]);
    const out = output();
    expect(out).not.toContain('PID');
    expect(out).not.toContain('Port');
    expect(out).not.toContain('URL');
  });

  // apra-fleet-i9ag.13.8 / .13.10: runStatus's injected-detector seam. None of
  // these assertions depend on the host's real node/npm -- the detector is
  // supplied directly, so the suite's outcome cannot change on a machine
  // with no npm on PATH.
  //
  // REVERT CHECK (criterion 8): deleting the fleet-se line from
  // src/cli/status.ts makes the canary case "stopped branch: injected
  // detector reporting node missing shows NOT INSTALLED and the fix line"
  // (below) FAIL, along with the other three cases in this block -- verified
  // via git stash and restored.
  const NODE_MISSING: FleetSePrereqResult = {
    node: { present: false, version: null, satisfiesMin: false },
    npm: { present: true, version: '10.5.0' },
    ok: false,
    missing: ['node'],
  };
  const SATISFIED: FleetSePrereqResult = {
    node: { present: true, version: '22.16.0', satisfiesMin: true },
    npm: { present: true, version: '10.5.0' },
    ok: true,
    missing: [],
  };

  it('stopped branch: injected detector reporting node missing shows NOT INSTALLED and the fix line', async () => {
    await runStatus([], { detectFleetSePrereqs: () => NODE_MISSING });
    const out = output();
    expect(out).toContain('NOT INSTALLED');
    expect(out).toContain(FLEET_SE_PREREQ_FIX_LINE);
  });

  it('running branch: injected detector reporting node missing shows NOT INSTALLED and the fix line', async () => {
    mockCheckRunning.mockResolvedValue(RUNNING);
    await runStatus([], { detectFleetSePrereqs: () => NODE_MISSING });
    const out = output();
    expect(out).toContain('NOT INSTALLED');
    expect(out).toContain(FLEET_SE_PREREQ_FIX_LINE);
  });

  it('injected detector reporting prerequisites satisfied names the node and npm versions', async () => {
    await runStatus([], { detectFleetSePrereqs: () => SATISFIED });
    const out = output();
    expect(out).toContain('22.16.0');
    expect(out).toContain('10.5.0');
  });

  it('injected detector that throws degrades to "fleet-se: unknown" without throwing, and does not drop other status lines', async () => {
    await expect(
      runStatus([], {
        detectFleetSePrereqs: () => {
          throw new Error('boom: probe failed');
        },
      }),
    ).resolves.toBeUndefined();

    const out = output();
    expect(out).toContain('fleet-se: unknown');
    expect(out).toContain('State:');
    expect(out).toContain('Service (MCP server):');
    expect(out).toContain('Service (fleet supervisor):');
  });

  // GitHub #585: an unclean previous exit is reported before anything else.
  it('prints the previous-server note first when the probe cleaned up a stale server.json', async () => {
    mockCheckRunning.mockResolvedValue({ ...STOPPED, previous: { pid: 777, startedAt: 'T1', lastLogAt: 'T2' } });
    await runStatus([]);
    const lines = logSpy.mock.calls.map(c => c.join(' '));
    expect(lines[0]).toContain('previous server pid 777 (started T1, last log T2) exited without a shutdown record');
    expect(lines[1]).toBe('apra-fleet status');
  });

  // GitHub #584: alive-but-silent is reported as such, never as "stopped".
  it('shows State: unresponsive with pid/port and a stop hint when the server is unresponsive', async () => {
    mockCheckRunning.mockResolvedValue(UNRESPONSIVE);
    await runStatus([]);
    const out = output();
    expect(out).toContain('State:    unresponsive');
    expect(out).toContain('1234');
    expect(out).toContain('7523');
    expect(out).toContain('apra-fleet stop');
    expect(out).not.toContain('stopped');
  });
});
