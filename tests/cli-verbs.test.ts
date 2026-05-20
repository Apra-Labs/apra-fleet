import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock refs
// ---------------------------------------------------------------------------
const {
  mockCheckRunning,
  mockGetSvcMgr,
  mockSvcMgr,
  mockSpawn,
  mockHttpRequest,
  mockHttpGet,
} = vi.hoisted(() => {
  const mockSvcMgr = {
    isInstalled: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
    start: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    stop: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    query: vi.fn<() => Promise<{ installed: boolean; running: boolean; enabled?: boolean }>>()
      .mockResolvedValue({ installed: false, running: false }),
    register: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    unregister: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };

  const mockReq = { on: vi.fn().mockReturnThis(), end: vi.fn(), destroy: vi.fn() };

  const healthBody = JSON.stringify({ version: 'v0.1', uptime: 30, sessions: 1 });

  const mockHttpRequest = vi.fn().mockImplementation(
    (_opts: unknown, cb?: (res: { resume: () => void }) => void) => {
      cb?.({ resume: vi.fn() });
      return mockReq;
    },
  );

  const mockHttpGet = vi.fn().mockImplementation(
    (_opts: unknown, cb?: (res: { on: (ev: string, handler: (...a: unknown[]) => void) => void }) => void) => {
      cb?.({
        on(ev: string, handler: (...a: unknown[]) => void) {
          if (ev === 'data') handler(Buffer.from(healthBody));
          if (ev === 'end') handler();
        },
      });
      return mockReq;
    },
  );

  const mockSpawn = vi.fn().mockReturnValue({ unref: vi.fn() });

  return {
    mockCheckRunning: vi.fn<() => Promise<{ running: boolean; url?: string; pid?: number }>>()
      .mockResolvedValue({ running: false }),
    mockGetSvcMgr: vi.fn<() => Promise<typeof mockSvcMgr>>().mockResolvedValue(mockSvcMgr),
    mockSvcMgr,
    mockSpawn,
    mockHttpRequest,
    mockHttpGet,
  };
});

// ---------------------------------------------------------------------------
// Module mocks (must precede imports of the tested modules)
// ---------------------------------------------------------------------------
vi.mock('../src/services/singleton.js', () => ({
  checkRunningInstance: mockCheckRunning,
}));

vi.mock('../src/services/service-manager/index.js', () => ({
  getServiceManager: mockGetSvcMgr,
}));

vi.mock('node:child_process', () => ({
  default: { spawn: mockSpawn, execFileSync: vi.fn() },
  spawn: mockSpawn,
  execFileSync: vi.fn(),
}));

vi.mock('node:fs', () => {
  const serverInfoJson = JSON.stringify({ pid: 1234, port: 7523, url: 'http://127.0.0.1:7523/mcp' });
  const m = {
    mkdirSync: vi.fn(),
    openSync: vi.fn().mockReturnValue(3),
    closeSync: vi.fn(),
    unlinkSync: vi.fn(),
    // existsSync returns true so findProjectRoot() does not throw
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn().mockReturnValue(serverInfoJson),
    writeFileSync: vi.fn(),
  };
  return { default: m, ...m };
});

vi.mock('node:http', () => ({
  default: { request: mockHttpRequest, get: mockHttpGet },
  request: mockHttpRequest,
  get: mockHttpGet,
}));

// ---------------------------------------------------------------------------
// Subject imports (after mocks)
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

// ---------------------------------------------------------------------------
// runStart
// ---------------------------------------------------------------------------
describe('runStart', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRunning.mockResolvedValue(STOPPED);
    mockSvcMgr.isInstalled.mockResolvedValue(false);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
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
    mockCheckRunning
      .mockResolvedValueOnce(STOPPED)
      .mockResolvedValueOnce(RUNNING);
    vi.useFakeTimers();
    const p = runStart([]);
    await vi.advanceTimersByTimeAsync(2001);
    await p;
    expect(mockSvcMgr.start).toHaveBeenCalled();
  });

  it('spawns a detached process when no service unit is installed', async () => {
    mockCheckRunning
      .mockResolvedValueOnce(STOPPED)
      .mockResolvedValueOnce(RUNNING);
    vi.useFakeTimers();
    const p = runStart([]);
    await vi.advanceTimersByTimeAsync(2001);
    await p;
    expect(mockSpawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['--transport', 'http']),
      expect.objectContaining({ detached: true }),
    );
  });

  it('logs success URL after spawn when server comes up', async () => {
    mockCheckRunning
      .mockResolvedValueOnce(STOPPED)
      .mockResolvedValueOnce(RUNNING);
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
    mockCheckRunning.mockResolvedValue(STOPPED);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Make isPidAlive return false immediately so polling loop exits
    killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid, sig) => {
      if (sig === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      return true;
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    killSpy.mockRestore();
  });

  it('logs "not running" and returns without HTTP call when server is stopped', async () => {
    await runStop([]);
    expect(logSpy).toHaveBeenCalledWith('Server is not running.');
    expect(mockHttpRequest).not.toHaveBeenCalled();
  });

  it('posts /shutdown when server is running', async () => {
    mockCheckRunning.mockResolvedValue(RUNNING);
    await runStop([]);
    expect(mockHttpRequest).toHaveBeenCalled();
  });

  it('reports "Server stopped." after shutdown', async () => {
    mockCheckRunning.mockResolvedValue(RUNNING);
    await runStop([]);
    expect(logSpy).toHaveBeenCalledWith('Server stopped.');
  });

  it('cleans up server.json and lock file after stop', async () => {
    const { unlinkSync } = await import('node:fs');
    mockCheckRunning.mockResolvedValue(RUNNING);
    await runStop([]);
    expect(unlinkSync).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// runRestart
// ---------------------------------------------------------------------------
describe('runRestart', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid, sig) => {
      if (sig === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      return true;
    });
    mockSvcMgr.isInstalled.mockResolvedValue(false);
  });

  afterEach(() => {
    logSpy.mockRestore();
    killSpy.mockRestore();
    vi.useRealTimers();
  });

  it('stops then starts the server', async () => {
    mockCheckRunning
      .mockResolvedValueOnce(RUNNING)   // stop: running
      .mockResolvedValueOnce(STOPPED)   // start: not running
      .mockResolvedValueOnce(RUNNING);  // start: verify after 2s wait
    vi.useFakeTimers();
    const p = runRestart([]);
    await vi.advanceTimersByTimeAsync(2001);
    await p;
    expect(mockHttpRequest).toHaveBeenCalled(); // /shutdown was posted
    expect(mockSpawn).toHaveBeenCalled();        // process was spawned
  });

  it('is idempotent when server is already stopped before restart', async () => {
    mockCheckRunning
      .mockResolvedValueOnce(STOPPED)   // stop: not running
      .mockResolvedValueOnce(STOPPED)   // start: not running
      .mockResolvedValueOnce(RUNNING);  // start: verify after 2s wait
    vi.useFakeTimers();
    const p = runRestart([]);
    await vi.advanceTimersByTimeAsync(2001);
    await p;
    // stop is a no-op, start spawns
    expect(mockSpawn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// runStatus
// ---------------------------------------------------------------------------
describe('runStatus', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRunning.mockResolvedValue(STOPPED);
    mockSvcMgr.query.mockResolvedValue({ installed: false, running: false });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
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
    expect(output()).toContain('v0.1');  // version from health mock
    expect(output()).toContain('30s');   // uptime: 30 seconds
    expect(output()).toContain('1');     // sessions: 1
  });

  it('omits live fields when server is stopped', async () => {
    await runStatus([]);
    const out = output();
    expect(out).not.toContain('PID');
    expect(out).not.toContain('Port');
    expect(out).not.toContain('URL');
  });
});
