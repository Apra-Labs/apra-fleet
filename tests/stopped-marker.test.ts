/**
 * "Stopped by user" marker (GitHub #585 recovery, owner decision option B):
 * `apra-fleet stop` records a deliberate stop in the data dir so clients
 * never auto-start the server again; `apra-fleet start` clears it and
 * `apra-fleet status` shows it. Real fs on the per-run test data dir; the
 * singleton probe and service manager are faked (no server, no OS service).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const { mockCheckRunning } = vi.hoisted(() => ({ mockCheckRunning: vi.fn() }));
vi.mock('../src/services/singleton.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/singleton.js')>()),
  checkRunningInstance: mockCheckRunning,
  isPortInUse: vi.fn().mockResolvedValue(false),
  readServerInfoPid: () => undefined,
}));
vi.mock('../src/services/service-manager/index.js', () => ({
  getServiceManager: vi.fn().mockResolvedValue({
    isInstalled: vi.fn().mockResolvedValue(false),
    query: vi.fn().mockResolvedValue({ installed: false, running: false }),
  }),
}));

import { runStop } from '../src/cli/stop.js';
import { runStart } from '../src/cli/start.js';
import { runStatus } from '../src/cli/status.js';
import {
  STOPPED_MARKER_PATH, readStoppedMarker, writeStoppedMarker, clearStoppedMarker, STOPPED_BY_USER_FILE,
} from '../src/services/stopped-marker.js';
import { FLEET_DIR } from '../src/paths.js';
import { serverVersion } from '../src/version.js';

async function withHealth(version: string, fn: (url: string) => Promise<void>): Promise<void> {
  const srv = http.createServer((_req, res) => { res.end(JSON.stringify({ version, uptime: 1, sessions: 0 })); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  try {
    await fn(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp`);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
}

const RUNNING = { running: true as const, state: 'running' as const, url: 'http://127.0.0.1:7999/mcp', pid: 1234 };
const GONE = { running: false as const, state: 'gone' as const };

describe('stopped-by-user marker', () => {
  let out: string[];
  beforeEach(() => {
    clearStoppedMarker();
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  });
  afterEach(() => {
    clearStoppedMarker();
    vi.restoreAllMocks();
  });

  it('lives in the resolved data dir under the name the client reads', () => {
    expect(STOPPED_MARKER_PATH.startsWith(FLEET_DIR)).toBe(true);
    expect(STOPPED_BY_USER_FILE).toBe('stopped-by-user.json');
  });

  it('apra-fleet stop writes the marker (time, command, user)', async () => {
    mockCheckRunning.mockResolvedValue(GONE);
    await runStop([]);
    const m = readStoppedMarker();
    expect(m).not.toBeNull();
    expect(m!.by).toBe('apra-fleet stop');
    expect(Date.parse(m!.stoppedAt)).not.toBeNaN();
    expect(m!.user).toBeTruthy();
  });

  it('apra-fleet start clears it', async () => {
    writeStoppedMarker('apra-fleet stop');
    mockCheckRunning.mockResolvedValue(RUNNING); // already running -> start returns early
    await runStart([]);
    expect(fs.existsSync(STOPPED_MARKER_PATH)).toBe(false);
  });

  it('status shows the stopped-by-user state', async () => {
    writeStoppedMarker('apra-fleet stop', STOPPED_MARKER_PATH, new Date('2026-10-03T10:00:00Z'));
    mockCheckRunning.mockResolvedValue(GONE);
    await runStatus([]);
    expect(out.join('\n')).toMatch(/State:\s+stopped \(stopped by .+ at 2026-10-03T10:00:00\.000Z via 'apra-fleet stop' -- run 'apra-fleet start'\)/);
  });

  it('a start launched by a client auto-start (APRA_FLEET_AUTOSTART=1) refuses and KEEPS a racing stop', async () => {
    writeStoppedMarker('apra-fleet stop');
    mockCheckRunning.mockResolvedValue(GONE);
    const errs: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a) => { errs.push(a.join(' ')); });
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    process.env.APRA_FLEET_AUTOSTART = '1';
    try {
      await expect(runStart([])).rejects.toThrow('exit 1');
    } finally {
      delete process.env.APRA_FLEET_AUTOSTART;
    }
    expect(exit).toHaveBeenCalledWith(1);
    expect(fs.existsSync(STOPPED_MARKER_PATH)).toBe(true);
    expect(errs.join('\n')).toMatch(/stopped by the user .*not auto-starting/);
  });

  it('a port-only override never records a stop in the shared data dir when the server there is not its own', async () => {
    const saved = { dir: process.env.APRA_FLEET_DATA_DIR, port: process.env.APRA_FLEET_PORT };
    delete process.env.APRA_FLEET_DATA_DIR; // port-only: shares the default data dir
    process.env.APRA_FLEET_PORT = '9999';
    mockCheckRunning.mockResolvedValue(RUNNING); // production server on 7999, not 9999
    try {
      await runStop([]);
    } finally {
      if (saved.dir === undefined) delete process.env.APRA_FLEET_DATA_DIR; else process.env.APRA_FLEET_DATA_DIR = saved.dir;
      if (saved.port === undefined) delete process.env.APRA_FLEET_PORT; else process.env.APRA_FLEET_PORT = saved.port;
    }
    expect(out.join('\n')).toMatch(/not stopping it/);
    expect(fs.existsSync(STOPPED_MARKER_PATH)).toBe(false);
  });

  it('status flags a server running while the stop marker is set', async () => {
    writeStoppedMarker('apra-fleet stop');
    await withHealth(serverVersion, async (url) => {
      mockCheckRunning.mockResolvedValue({ ...RUNNING, url });
      await runStatus([]);
    });
    expect(out.join('\n')).toMatch(/State:\s+running \(stop marker set -- run 'apra-fleet start' to clear\)/);
    expect(out.join('\n')).not.toMatch(/Warning:/);
  });

  it('status running without a marker is plain "running"', async () => {
    await withHealth(serverVersion, async (url) => {
      mockCheckRunning.mockResolvedValue({ ...RUNNING, url });
      await runStatus([]);
    });
    expect(out.join('\n')).toMatch(/State:\s+running$/m);
  });

  it('status warns when the running server is another version than this apra-fleet', async () => {
    await withHealth('v0.0.1_deadbe', async (url) => {
      mockCheckRunning.mockResolvedValue({ ...RUNNING, url });
      await runStatus([]);
    });
    expect(out.join('\n')).toMatch(/Warning:\s+the running server is v0\.0\.1_deadbe but this apra-fleet is .* stop it \('apra-fleet stop'\), then run 'apra-fleet install'/);
  });

  it('status without a marker is plain "stopped"', async () => {
    mockCheckRunning.mockResolvedValue(GONE);
    await runStatus([]);
    expect(out.join('\n')).toMatch(/State:\s+stopped$/m);
  });
});
