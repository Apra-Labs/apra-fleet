/**
 * Integration coverage for apra-fleet-i8qj.4: runStart() must diagnose the
 * Windows no-interactive-session case (NoInteractiveSessionError from
 * WindowsServiceManager.start(), apra-fleet-i8qj.3) with a distinct,
 * identifiable message instead of folding it into the generic
 * service-manager-failure fallback warning -- and, either way, the server
 * must still come up via a direct spawn with an explicit no-auto-restart
 * warning (the shipped behaviour from apra-fleet-i8qj.4).
 *
 * Before the apra-fleet-i8qj.4 fix, any svcMgr.start() failure (including
 * this one) fell through to the same generic
 * "Service manager start failed (...); falling back to direct spawn."
 * warning with no mention of the interactive-session cause -- these tests
 * fail against that pre-fix behaviour and pass after the fix (src/cli/start.ts).
 *
 * This drives the injected service-manager/singleton seams (same pattern as
 * tests/cli-verbs.test.ts's runStart suite) rather than shelling out to real
 * schtasks/query user, so nothing here needs a non-win32 skip guard.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// Hoisted mock refs -- local modules only, mirroring tests/cli-verbs.test.ts's
// approach (factory mocks for built-in node modules leak in this project's
// fileParallelism:false mode, so node:child_process is auto-mocked below).
// ---------------------------------------------------------------------------
const { mockCheckRunning, mockGetSvcMgr, mockSvcMgr } = vi.hoisted(() => {
  const mockSvcMgr = {
    isInstalled: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    start: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    stop: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    query: vi.fn<() => Promise<{ installed: boolean; running: boolean; enabled?: boolean }>>()
      .mockResolvedValue({ installed: true, running: false }),
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

vi.mock('../../src/services/singleton.js', () => ({
  checkRunningInstance: mockCheckRunning,
}));

vi.mock('../../src/services/service-manager/index.js', () => ({
  getServiceManager: mockGetSvcMgr,
}));

// Auto-mock (no factory) so named imports get stubs -- auto-mocks clean up
// between files in sequential mode; factory mocks do not (see cli-verbs.test.ts).
vi.mock('node:child_process');

// ---------------------------------------------------------------------------
// Imports of subjects under test (after mocks so mocks apply)
// ---------------------------------------------------------------------------
import { runStart } from '../../src/cli/start.js';
import { NoInteractiveSessionError } from '../../src/services/service-manager/windows.js';

const RUNNING = { running: true as const, url: 'http://127.0.0.1:7523/mcp', pid: 1234 };
const STOPPED = { running: false as const };
const SERVER_INFO = JSON.stringify({ pid: 1234, port: 7523, url: 'http://127.0.0.1:7523/mcp' });

function setupFsSpies() {
  vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined as any);
  vi.spyOn(fs, 'openSync').mockReturnValue(3 as any);
  vi.spyOn(fs, 'closeSync').mockReturnValue(undefined);
  vi.spyOn(fs, 'unlinkSync').mockReturnValue(undefined);
  vi.spyOn(fs, 'existsSync').mockReturnValue(true); // lets findProjectRoot() succeed
  vi.spyOn(fs, 'readFileSync').mockReturnValue(SERVER_INFO as any);
}

describe('runStart diagnoses the no-interactive-session case distinctly from a bare start timeout (apra-fleet-i8qj.5)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let savedDataDir: string | undefined;
  let savedPort: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    setupFsSpies();
    mockCheckRunning.mockResolvedValue(STOPPED);
    mockSvcMgr.isInstalled.mockResolvedValue(true);
    vi.mocked(spawn).mockReturnValue({ unref: vi.fn() } as any);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);
    // apra-fleet-eft.51.1: tests/setup.ts always sets APRA_FLEET_DATA_DIR for test
    // isolation; the default-instance path under test requires it (and any port
    // override) cleared so isNonDefaultInstance() reports false.
    savedDataDir = process.env.APRA_FLEET_DATA_DIR;
    savedPort = process.env.APRA_FLEET_PORT;
    delete process.env.APRA_FLEET_DATA_DIR;
    delete process.env.APRA_FLEET_PORT;
  });

  afterEach(() => {
    if (savedDataDir !== undefined) process.env.APRA_FLEET_DATA_DIR = savedDataDir;
    if (savedPort !== undefined) process.env.APRA_FLEET_PORT = savedPort;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('case 1: names the interactive-session cause (specific message/code), not a bare start-timeout message', async () => {
    const thrown = new NoInteractiveSessionError(
      "apra-fleet: the ApraFleet scheduled task did not start because there is no interactive " +
      "logon session on this machine.",
    );
    // Pin the specific error identity this branch (isNoInteractiveSessionError, src/services/service-manager/windows.ts)
    // must recognize -- not just any Error.
    expect(thrown.code).toBe('NO_INTERACTIVE_SESSION');
    expect(thrown.name).toBe('NoInteractiveSessionError');
    mockSvcMgr.start.mockRejectedValueOnce(thrown);
    mockCheckRunning.mockResolvedValueOnce(STOPPED).mockResolvedValueOnce(RUNNING);
    vi.useFakeTimers();
    const p = runStart([]);
    await vi.advanceTimersByTimeAsync(2001);
    await p;

    // Assert on the specific NoInteractiveSessionError cause, not just "some error".
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('no interactive logon session'),
    );
    // Regression guard: must not fall through to the bare pre-fix message,
    // which named no cause at all.
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringMatching(/^Service manager start failed \(/),
    );
  });

  it('case 2: shipped behaviour holds -- direct-spawns and warns that this instance will not auto-restart after reboot', async () => {
    mockSvcMgr.start.mockRejectedValueOnce(
      new NoInteractiveSessionError('apra-fleet: no interactive logon session.'),
    );
    mockCheckRunning.mockResolvedValueOnce(STOPPED).mockResolvedValueOnce(RUNNING);
    vi.useFakeTimers();
    const p = runStart([]);
    await vi.advanceTimersByTimeAsync(2001);
    await p;

    expect(vi.mocked(spawn)).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/will NOT auto-restart after a reboot/),
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Server started'));
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  it('case 3 (regression guard): a generic service-manager failure still takes the pre-existing generic fallback path, unchanged', async () => {
    mockSvcMgr.start.mockRejectedValueOnce(new Error('Command failed: schtasks /run /tn ApraFleet'));
    mockCheckRunning.mockResolvedValueOnce(STOPPED).mockResolvedValueOnce(RUNNING);
    vi.useFakeTimers();
    const p = runStart([]);
    await vi.advanceTimersByTimeAsync(2001);
    await p;

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Service manager start failed (Command failed: schtasks /run /tn ApraFleet); falling back to direct spawn.'),
    );
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('no interactive logon session'));
    expect(vi.mocked(spawn)).toHaveBeenCalled();
  });

  it('case 4: non-default (sandboxed) instance path is unchanged -- direct-spawns without ever calling the service manager', async () => {
    process.env.APRA_FLEET_PORT = '18701';
    mockCheckRunning.mockResolvedValueOnce(STOPPED).mockResolvedValueOnce(RUNNING);
    vi.useFakeTimers();
    const p = runStart([]);
    await vi.advanceTimersByTimeAsync(2001);
    await p;

    expect(mockSvcMgr.start).not.toHaveBeenCalled();
    expect(vi.mocked(spawn)).toHaveBeenCalled();
  });
});
