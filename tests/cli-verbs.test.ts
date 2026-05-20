import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// Hoisted mock refs — local modules only (these are safe; factory mocks for
// built-in node modules leak in fileParallelism:false mode, so we use spies)
// ---------------------------------------------------------------------------
const { mockCheckRunning, mockGetSvcMgr, mockSvcMgr } = vi.hoisted(() => {
  const mockSvcMgr = {
    isInstalled: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
    start: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    stop: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    query: vi.fn<() => Promise<{ installed: boolean; running: boolean; enabled?: boolean }>>()
      .mockResolvedValue({ installed: false, running: false }),
    register: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    unregister: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
  return {
    mockCheckRunning: vi.fn<() => Promise<{ running: boolean; url?: string; pid?: number }>>()
      .mockResolvedValue({ running: false }),
    mockGetSvcMgr: vi.fn<() => Promise<typeof mockSvcMgr>>().mockResolvedValue(mockSvcMgr),
    mockSvcMgr,
  };
});

vi.mock('../src/services/singleton.js', () => ({
  checkRunningInstance: mockCheckRunning,
}));

vi.mock('../src/services/service-manager/index.js', () => ({
  getServiceManager: mockGetSvcMgr,
}));

// Auto-mock (no factory) so named imports get stubs — auto-mocks clean up
// between files in sequential mode; factory mocks do not.
vi.mock('node:child_process');

// ---------------------------------------------------------------------------
// Imports of subjects under test (after mocks so mocks apply)
// ---------------------------------------------------------------------------
import { runStart } from '../src/cli/start.js';
import { runStop } from '../src/cli/stop.js';
import { runRestart } from '../src/cli/restart.js';
import { runStatus } from '../src/cli/status.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------
const RUNNING = { running: true as const, url: 'http://127.0.0.1:7523/mcp', pid: 1234 };
const STOPPED = { running: false as const };
const SERVER_INFO = JSON.stringify({ pid: 1234, port: 7523, url: 'http://127.0.0.1:7523/mcp' });
const HEALTH_BODY = JSON.stringify({ version: 'v0.1', uptime: 30, sessions: 1 });

// ---------------------------------------------------------------------------
// Per-test spy helpers (vi.spyOn restores cleanly in afterEach — no leakage)
// ---------------------------------------------------------------------------
function setupFsSpies() {
  vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined as any);
  vi.spyOn(fs, 'openSync').mockReturnValue(3 as any);
  vi.spyOn(fs, 'closeSync').mockReturnValue(undefined);
  vi.spyOn(fs, 'unlinkSync').mockReturnValue(undefined);
  vi.spyOn(fs, 'existsSync').mockReturnValue(true); // lets findProjectRoot() succeed
  vi.spyOn(fs, 'readFileSync').mockReturnValue(SERVER_INFO as any);
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

  it('reports already running and skips service manager when server is up', async () => {
    mockCheckRunning.mockResolvedValue(RUNNING);
    await runStart([]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('already running'));
    expect(mockGetSvcMgr).not.toHaveBeenCalled();
  });

  it('calls service manager start when unit is installed', async () => {
    mockSvcMgr.isInstalled.mockResolvedValue(true);
    mockCheckRunning.mockResolvedValueOnce(STOPPED).mockResolvedValueOnce(RUNNING);
    vi.useFakeTimers();
    const p = runStart([]);
    await vi.advanceTimersByTimeAsync(2001);
    await p;
    expect(mockSvcMgr.start).toHaveBeenCalled();
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

  it('posts /shutdown when server is running', async () => {
    mockCheckRunning.mockResolvedValue(RUNNING);
    await runStop([]);
    expect(http.request).toHaveBeenCalled();
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
});
