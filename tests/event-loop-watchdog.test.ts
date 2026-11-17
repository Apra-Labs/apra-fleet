import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { evaluateWatchdogTick, type WorkerTickState } from '../src/services/event-loop-watchdog.js';

// GitHub #562: event-loop stall watchdog.

const cfg = { tickMs: 1000, blockedThresholdMs: 3000, blockedRepeatMs: 30_000 };

function freshState(t: number, beat: number): WorkerTickState {
  return { prevTick: t, lastBeatSeen: beat, suspendedBeat: null, lastReportAt: null };
}

describe('evaluateWatchdogTick (worker decision)', () => {
  it('reports a stale heartbeat once past the threshold, then every 30s while still blocked', () => {
    const s = freshState(0, 0);
    const reports: Array<number | null> = [];
    for (let t = 1000; t <= 40_000; t += 1000) reports.push(evaluateWatchdogTick(s, t, 0, cfg));
    const fired = reports.map((r, i) => (r !== null ? (i + 1) * 1000 : null)).filter((x) => x !== null);
    expect(fired).toEqual([3000, 33_000]);
    expect(reports[2]).toBe(3000);
  });

  it('a fresh heartbeat clears the stall', () => {
    const s = freshState(0, 0);
    for (let t = 1000; t <= 4000; t += 1000) evaluateWatchdogTick(s, t, 0, cfg);
    expect(evaluateWatchdogTick(s, 5000, 4900, cfg)).toBeNull();
    expect(s.lastReportAt).toBeNull();
    expect(evaluateWatchdogTick(s, 6000, 4900, cfg)).toBeNull(); // 1.1s old: under threshold
  });

  it('a host/process suspend (the worker itself ran late) is NOT reported as a blocked main loop', () => {
    const s = freshState(0, 0);
    expect(evaluateWatchdogTick(s, 1000, 1000, cfg)).toBeNull();
    // Whole process suspended for 10 minutes: the worker's own tick is late too.
    expect(evaluateWatchdogTick(s, 601_000, 1000, cfg)).toBeNull();
    // Still the same stale beat on the next regular worker tick: suppressed until the main loop beats again.
    expect(evaluateWatchdogTick(s, 602_000, 1000, cfg)).toBeNull();
    expect(evaluateWatchdogTick(s, 603_000, 602_500, cfg)).toBeNull(); // main loop resumed
  });
});

describe('startEventLoopWatchdog (real worker)', () => {
  const originalDataDir = process.env.APRA_FLEET_DATA_DIR;
  let dataDir: string;

  beforeEach(() => {
    vi.resetModules();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-watchdog-'));
    process.env.APRA_FLEET_DATA_DIR = dataDir;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.APRA_FLEET_DATA_DIR = originalDataDir;
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('a 5s main-thread block gets an event_loop_blocked line DURING the block and an event_loop_lag line after', async () => {
    const logHelpers = await import('../src/utils/log-helpers.js');
    const { startEventLoopWatchdog } = await import('../src/services/event-loop-watchdog.js');
    const logFile = logHelpers.getActiveLogFile()!;
    const wd = startEventLoopWatchdog({ logFile });
    try {
      await new Promise((r) => setTimeout(r, 1500)); // worker up, at least one heartbeat
      const blockStart = Date.now();
      while (Date.now() - blockStart < 5000) { /* block the main thread */ }
      const blockEnd = Date.now();
      await new Promise((r) => setTimeout(r, 1500)); // let the main-thread lag check run

      const recs = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean)
        .map((l) => JSON.parse(l) as { ts: string; tag: string; msg: string });
      const blocked = recs.filter((r) => r.tag === 'event_loop_blocked');
      expect(blocked.length).toBeGreaterThanOrEqual(1);
      const t = Date.parse(blocked[0].ts);
      expect(t).toBeGreaterThanOrEqual(blockStart);
      expect(t).toBeLessThanOrEqual(blockEnd); // written while the main thread was still blocked
      expect(Number(/ms=(\d+)/.exec(blocked[0].msg)![1])).toBeGreaterThanOrEqual(3000);

      const lag = recs.filter((r) => r.tag === 'event_loop_lag');
      expect(lag.length).toBeGreaterThanOrEqual(1);
      expect(lag[0].msg).toMatch(/^ms=\d+ wall_ms=\d+$/);
      expect(Date.parse(lag[0].ts)).toBeGreaterThanOrEqual(blockEnd - 50);
    } finally {
      await wd.stop();
      logHelpers.closeLogFile();
    }
  }, 20_000);

  it('never keeps the process alive: a process that only started the watchdog exits on its own', async () => {
    const distWatchdog = new URL('../dist/services/event-loop-watchdog.js', import.meta.url);
    expect(fs.existsSync(distWatchdog), 'dist/ missing -- run npm run build first').toBe(true);
    const script = [
      `const m = await import(${JSON.stringify(distWatchdog.href)});`,
      `m.startEventLoopWatchdog({ logFile: null });`,
    ].join('\n');
    const started = Date.now();
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, APRA_FLEET_DATA_DIR: dataDir },
      stdio: 'ignore',
      windowsHide: true,
    });
    const code = await new Promise<number | null>((resolve) => {
      const killer = setTimeout(() => { child.kill('SIGKILL'); }, 10_000);
      child.once('exit', (c) => { clearTimeout(killer); resolve(c); });
    });
    expect(code).toBe(0);
    expect(Date.now() - started).toBeLessThan(8000);
  }, 20_000);

  it('stop() terminates the worker and clears the interval', async () => {
    const { startEventLoopWatchdog } = await import('../src/services/event-loop-watchdog.js');
    const wd = startEventLoopWatchdog({ logFile: null });
    await expect(wd.stop()).resolves.toBeUndefined();
    await expect(wd.stop()).resolves.toBeUndefined(); // idempotent
  });
});
