/**
 * Integration coverage for apra-fleet-1aw: the install running-process guard
 * must be scoped to the install target (src/cli/install-guard.ts
 * classifyRunningServer()), not to any `apra-fleet` process found anywhere
 * on the machine (isApraFleetRunning(), which stays OS-global on purpose --
 * see the module docstring in install-guard.ts).
 *
 * Unlike tests/install-force.test.ts (which fully mocks node:fs and asserts
 * the CLI-level error text via runInstall()), this exercises the real
 * filesystem and a real live pid so the guard's actual I/O -- reading
 * server.json out of a real temp APRA_FLEET_DATA_DIR, and isPidAlive() on a
 * genuinely-alive pid -- is what decides the outcome, not a mocked fs
 * implementation.
 *
 * classifyRunningServer()'s `relevant` field is exactly what install.ts's
 * guard block (runInstall(), "Running-process guard" section) uses to decide
 * whether to print "Error: apra-fleet is currently running. Stop the server
 * before installing." and exit(1) (relevant: true) or let the install
 * proceed with an informational note (relevant: false) -- see install.ts's
 * `if (runningScope?.relevant) { ... }` block. We assert against that field
 * (and its `reason`/`detail`) directly rather than driving the full CLI,
 * because runInstall() computes BIN_DIR from the real developer machine's
 * home directory at module load time and would not be hermetic here; the
 * CLI-level error text itself is already covered by tests/install-force.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import type { Server } from 'node:http';
import { execSync } from 'node:child_process';
import { classifyRunningServer, isUnderInstallPrefix } from '../../src/cli/install-guard.js';
import { isApraFleetRunning } from '../../src/cli/install.js';

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, execSync: vi.fn() };
});

const originalDataDir = process.env.APRA_FLEET_DATA_DIR;
let tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Throwaway server answering 200 on /health, matching checkRunningInstance()'s health-url shape. */
function startHealthyServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200);
        res.end('ok');
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/mcp` });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Answer the OS-global process-detection commands isApraFleetRunning() and
 * getRunningApraFleetProcesses() issue, reporting one running process (not
 * this test process) whose resolved executable path is `exePath`, or with no
 * running process at all when `exePath` is null.
 */
function mockGlobalProcessDetection(exePath: string | null) {
  vi.mocked(execSync).mockImplementation((cmd: any) => {
    const c = cmd.toString();
    if (exePath === null) {
      if (c === 'pgrep -x apra-fleet') throw Object.assign(new Error('no match'), { status: 1 });
      if (c.startsWith('tasklist')) return '' as any;
      return '' as any;
    }
    if (c === 'pgrep -x apra-fleet') return '999999\n' as any;
    if (c.startsWith('tasklist')) return '"apra-fleet.exe","999999","Console","1","14,000 K"\n' as any;
    if (c.startsWith('readlink -f /proc/') || c.startsWith('ps -p ')) return `${exePath}\n` as any;
    if (c.startsWith('powershell')) return `999999|${exePath}\n` as any;
    return '' as any;
  });
}

describe('install running-process guard is scoped to the install target - integration (apra-fleet-1aw.3)', () => {
  let dataDir: string;
  let installPrefixDir: string;
  let healthy: { server: Server; url: string } | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDirs = [];
    dataDir = makeTempDir('apra-fleet-guard-datadir-');
    installPrefixDir = makeTempDir('apra-fleet-guard-prefix-');
    process.env.APRA_FLEET_DATA_DIR = dataDir;
  });

  afterEach(async () => {
    if (healthy) {
      await closeServer(healthy.server);
      healthy = null;
    }
    if (originalDataDir === undefined) delete process.env.APRA_FLEET_DATA_DIR;
    else process.env.APRA_FLEET_DATA_DIR = originalDataDir;
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  it('case 1: guard fires for the targeted data dir (live pid + healthy /health fixture)', async () => {
    // Pinned fixture contract: checkRunningInstance()'s real requirements are
    // server.json + a LIVE pid + a health endpoint returning 200. A
    // refused/unreachable health endpoint makes THAT check not fire, so we
    // stand up a real, live-answering server for the positive case even
    // though the scoped install guard's own data-dir check
    // (liveInstancePidForDataDir(), install-guard.ts) only needs server.json
    // + a live pid and does not probe health itself.
    healthy = await startHealthyServer();
    fs.writeFileSync(
      path.join(dataDir, 'server.json'),
      JSON.stringify({ pid: process.pid, url: healthy.url }),
    );
    // No global-process mocking needed: liveInstancePidForDataDir() short-circuits
    // classifyRunningServer() before it ever calls getRunningApraFleetProcesses().
    mockGlobalProcessDetection(null);

    const scope = classifyRunningServer(installPrefixDir);

    // relevant: true, reason: 'data-dir' is exactly what makes install.ts's
    // guard block print "Error: apra-fleet is currently running. Stop the
    // server before installing." and process.exit(1) (see this file's header).
    expect(scope.relevant).toBe(true);
    expect(scope.reason).toBe('data-dir');
    expect(scope.detail).toContain('recorded live in the data dir');
  });

  it('case 2: guard does NOT fire for an unrelated server, even when global-process detection reports one running', async () => {
    // No server.json in the temp data dir at all.
    expect(fs.existsSync(path.join(dataDir, 'server.json'))).toBe(false);
    // A running apra-fleet process exists on the machine (isApraFleetRunning()
    // stubbed true), but its executable lives outside the install prefix.
    mockGlobalProcessDetection('/opt/unrelated-prefix/bin/apra-fleet');

    expect(isApraFleetRunning()).toBe(true);

    const scope = classifyRunningServer(installPrefixDir);

    // This assertion is what makes the test fail if apra-fleet-1aw.1's
    // scoping is reverted to the old OS-global refusal: with the old
    // behavior, any running apra-fleet process (as stubbed above) would make
    // the guard fire regardless of data dir or prefix.
    expect(scope.relevant).toBe(false);
    expect(scope.reason).toBeNull();
  });

  it('case 3: ETXTBSY protection retained - guard fires when the running executable is under the install prefix, even though data dirs differ', async () => {
    // No server.json in the (isolated) data dir this install targets.
    expect(fs.existsSync(path.join(dataDir, 'server.json'))).toBe(false);
    const runningExePath = path.join(installPrefixDir, 'apra-fleet');
    mockGlobalProcessDetection(runningExePath);
    expect(isUnderInstallPrefix(runningExePath, installPrefixDir)).toBe(true);

    const scope = classifyRunningServer(installPrefixDir);

    expect(scope.relevant).toBe(true);
    expect(scope.reason).toBe('install-prefix');
    expect(scope.detail).toContain('inside the install prefix being written');
  });

  it('sanity: a live-but-unrelated data dir process does not fire when the recorded pid is dead', async () => {
    // A server.json exists but records a pid that is not alive -- must not be
    // treated as a live instance for this data dir.
    const deadPid = 0x7fffffff; // exceedingly unlikely to be a live pid
    fs.writeFileSync(
      path.join(dataDir, 'server.json'),
      JSON.stringify({ pid: deadPid, url: 'http://127.0.0.1:1/mcp' }),
    );
    mockGlobalProcessDetection(null);

    const scope = classifyRunningServer(installPrefixDir);

    expect(scope.relevant).toBe(false);
  });
});
