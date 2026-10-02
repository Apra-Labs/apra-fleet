import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

// GitHub #585: every observable exit path appends exactly one synchronous
// {"tag":"shutdown","reason":...} record to fleet-<pid>.log before exit.

const originalDataDir = process.env.APRA_FLEET_DATA_DIR;
let dataDir: string;

type Lifecycle = typeof import('../src/services/server-lifecycle.js');
type LogHelpers = typeof import('../src/utils/log-helpers.js');
let lifecycle: Lifecycle;
let logHelpers: LogHelpers;

beforeEach(async () => {
  vi.resetModules();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-lifecycle-'));
  process.env.APRA_FLEET_DATA_DIR = dataDir;
  logHelpers = await import('../src/utils/log-helpers.js');
  lifecycle = await import('../src/services/server-lifecycle.js');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  logHelpers.closeLogFile();
  vi.restoreAllMocks();
  process.env.APRA_FLEET_DATA_DIR = originalDataDir;
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function shutdownRecords(pid = process.pid, dir = dataDir): Array<Record<string, unknown>> {
  const file = path.join(dir, 'logs', `fleet-${pid}.log`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((r) => r.tag === 'shutdown');
}

describe('signal exit paths', () => {
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
    it(`${sig} writes one shutdown record synchronously, then runs the graceful shutdown`, () => {
      const proc = new EventEmitter() as unknown as NodeJS.Process;
      const onSignal = vi.fn(() => {
        // The record is already on disk when the graceful shutdown starts.
        expect(shutdownRecords()).toHaveLength(1);
      });
      lifecycle.installShutdownHandlers(onSignal, proc, 'win32');

      (proc as unknown as EventEmitter).emit(sig);
      (proc as unknown as EventEmitter).emit(sig); // a repeat signal adds no second line

      expect(onSignal).toHaveBeenCalledWith(sig);
      const recs = shutdownRecords();
      expect(recs).toHaveLength(1);
      expect(recs[0]).toMatchObject({ tag: 'shutdown', reason: sig, pid: process.pid });
    });
  }

  it('SIGBREAK is only wired on Windows', () => {
    expect(lifecycle.shutdownSignals('win32')).toContain('SIGBREAK');
    expect(lifecycle.shutdownSignals('linux')).not.toContain('SIGBREAK');
    expect(lifecycle.shutdownSignals('linux')).toEqual(expect.arrayContaining(['SIGINT', 'SIGTERM', 'SIGHUP']));
  });
});

describe('POST /shutdown', () => {
  it('records reason http_shutdown (not the SIGINT it re-enters)', async () => {
    const { createHttpTransport } = await import('../src/services/http-transport.js');
    const { getOrCreateKey } = await import('../src/services/jwt.js');
    const emitSpy = vi.spyOn(process, 'emit').mockImplementation(() => true);
    const handle = await createHttpTransport({ registerTools: () => {}, preferredPort: 0 });
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1', port: handle.port, path: '/shutdown', method: 'POST',
          headers: { Authorization: `Bearer ${getOrCreateKey()}` },
        }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
        req.on('error', reject);
        req.end();
      });
      expect(status).toBe(200);
      const recs = shutdownRecords();
      expect(recs).toHaveLength(1);
      expect(recs[0]).toMatchObject({ tag: 'shutdown', reason: 'http_shutdown' });
      await new Promise((r) => setTimeout(r, 150)); // let the deferred SIGINT emit hit the spy
      expect(emitSpy).toHaveBeenCalledWith('SIGINT');
    } finally {
      await handle.close();
    }
  });
});

describe('shutdown_server tool', () => {
  it('records reason shutdown_server before scheduling the exit', async () => {
    const { shutdownServer, cancelScheduledExit } = await import('../src/tools/shutdown-server.js');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
    try {
      await shutdownServer();
      const recs = shutdownRecords();
      expect(recs).toHaveLength(1);
      expect(recs[0]).toMatchObject({ tag: 'shutdown', reason: 'shutdown_server' });
    } finally {
      cancelScheduledExit();
      exitSpy.mockRestore();
    }
  });
});

// Crash paths run in a real child process: the record must be on disk before
// Node's default crash handling exits the process (code 1, unchanged).
describe('crash exit paths', () => {
  function runCrashChild(body: string): Promise<{ code: number | null; pid: number; dir: string }> {
    const distLifecycle = new URL('../dist/services/server-lifecycle.js', import.meta.url);
    expect(fs.existsSync(distLifecycle), 'dist/ missing -- run npm run build first').toBe(true);
    const dir = path.join(dataDir, 'child');
    const script = [
      `const m = await import(${JSON.stringify(distLifecycle.href)});`,
      `m.installShutdownHandlers(() => {});`,
      body,
    ].join('\n');
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, APRA_FLEET_DATA_DIR: dir },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    child.stderr!.resume();
    return new Promise((resolve) => child.once('exit', (code) => resolve({ code, pid: child.pid!, dir })));
  }

  it('uncaughtException writes one shutdown record and still exits 1', async () => {
    const { code, pid, dir } = await runCrashChild(`setTimeout(() => { throw new Error('boom token=sec://abc'); }, 10);`);
    expect(code).toBe(1);
    const recs = shutdownRecords(pid, dir);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ tag: 'shutdown', reason: 'uncaughtException', level: 'error' });
    expect(String(recs[0].error)).toContain('boom');
    expect(String(recs[0].error)).not.toContain('sec://abc'); // redacted
  }, 20_000);

  it('unhandledRejection writes one shutdown record and still exits 1', async () => {
    const { code, pid, dir } = await runCrashChild(`setTimeout(() => { Promise.reject(new Error('rejected')); }, 10);`);
    expect(code).toBe(1);
    const recs = shutdownRecords(pid, dir);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ tag: 'shutdown', reason: 'unhandledRejection' });
    expect(String(recs[0].error)).toContain('rejected');
  }, 20_000);
});
