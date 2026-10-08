/**
 * `apra-fleet start` when the configured port is held, with a FAKE port-holder
 * probe:
 *  - held by ANOTHER user's process (a second member install on this host) ->
 *    non-zero exit, error names that user, the pid and the remedy;
 *  - held by this user's own apra-fleet for this data dir -> the existing
 *    already-running reuse path, no error and the probe is never consulted.
 * The install-side refusal is in install-member.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';

const { mockCheckRunning, mockPortInUse, mockSvcMgr } = vi.hoisted(() => ({
  mockCheckRunning: vi.fn(),
  mockPortInUse: vi.fn<(port: number, host?: string) => Promise<boolean>>(),
  mockSvcMgr: {
    isInstalled: vi.fn().mockResolvedValue(false),
    start: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../src/services/singleton.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/singleton.js')>()),
  checkRunningInstance: mockCheckRunning,
  isPortInUse: mockPortInUse,
  readServerInfoPid: () => undefined,
}));
vi.mock('../src/services/service-manager/index.js', () => ({ getServiceManager: vi.fn(async () => mockSvcMgr) }));
vi.mock('../src/services/stopped-marker.js', () => ({
  readStoppedMarker: () => null,
  clearStoppedMarker: () => {},
}));
vi.mock('node:child_process');

import { runStart } from '../src/cli/start.js';
import { _setPortHolderProbeOverride, PORT_HELD_BY_OTHER_USER_CODE, currentUser } from '../src/services/port-holder.js';

const OTHER = { pid: 4321, user: 'fleet-other-user', uid: 987654, command: 'apra-fleet' };

let errSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;
let probeCalls: number[];

beforeEach(() => {
  vi.clearAllMocks();
  probeCalls = [];
  mockCheckRunning.mockResolvedValue({ running: false, state: 'gone' });
  mockPortInUse.mockResolvedValue(true);
  vi.mocked(spawn).mockReturnValue({ unref: vi.fn() } as any);
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);
});

afterEach(() => {
  _setPortHolderProbeOverride(null);
  vi.restoreAllMocks();
});

const errText = () => errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');

describe('apra-fleet start: configured port held', () => {
  it('by another user\'s process -> exit 1 naming that user, the pid and the remedy', async () => {
    _setPortHolderProbeOverride(async (port) => { probeCalls.push(port); return OTHER; });
    await runStart([]);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const msg = errText();
    expect(msg).toContain(PORT_HELD_BY_OTHER_USER_CODE);
    expect(msg).toContain('"fleet-other-user"');
    expect(msg).toContain('pid 4321');
    expect(msg).toContain('install --member --port');
    expect(probeCalls).toHaveLength(1);
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    expect(mockSvcMgr.start).not.toHaveBeenCalled();
  });

  it('by this user\'s process outside this data dir -> exit 1 with the generic message plus the holder pid', async () => {
    const me = currentUser();
    _setPortHolderProbeOverride(async () => ({ pid: 2468, ...me, command: 'node' }));
    await runStart([]);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const msg = errText();
    expect(msg).not.toContain(PORT_HELD_BY_OTHER_USER_CODE);
    expect(msg).toContain('is already in use');
    expect(msg).toContain('pid 2468');
  });

  it('by this user\'s own apra-fleet for this data dir -> existing reuse path, no error', async () => {
    _setPortHolderProbeOverride(async (port) => { probeCalls.push(port); return OTHER; });
    mockCheckRunning.mockResolvedValue({ running: true, state: 'running', url: 'http://127.0.0.1:7523/mcp', pid: 1357 });
    await runStart([]);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('already running'));
    expect(probeCalls).toEqual([]);
  });
});
