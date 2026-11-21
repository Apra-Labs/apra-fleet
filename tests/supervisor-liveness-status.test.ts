/**
 * `apra-fleet status` Supervisor line, read from <FLEET_SE_DATA_DIR>/supervisor.json.
 * All I/O is in a per-test temp dir; pid liveness and the clock are injected.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { mockCheckRunning } = vi.hoisted(() => ({ mockCheckRunning: vi.fn() }));
vi.mock('../src/services/singleton.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/singleton.js')>()),
  checkRunningInstance: mockCheckRunning,
}));
vi.mock('../src/services/service-manager/index.js', () => ({
  getServiceManager: vi.fn().mockResolvedValue({ query: vi.fn().mockResolvedValue({ installed: false, running: false }) }),
}));

import { readSupervisorLiveness, formatSupervisorLine } from '../src/cli/supervisor-liveness.js';
import { runStatus } from '../src/cli/status.js';

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
let dir: string;
const iso = (ms: number) => new Date(ms).toISOString();
const write = (rec: unknown) => fs.writeFileSync(path.join(dir, 'supervisor.json'), typeof rec === 'string' ? rec : JSON.stringify(rec));
const read = (isAlive = true) => readSupervisorLiveness({ dataDir: dir, now: () => NOW, isAlive: () => isAlive });
const rec = (over: Record<string, unknown> = {}) => ({ pid: 4242, port: 8787, beadsDir: '/b/.beads', intervalMs: 15000, startedAt: iso(NOW - 99000), updatedAt: iso(NOW - 5000), ...over });

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-live-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); delete process.env.FLEET_SE_DATA_DIR; });

describe('readSupervisorLiveness', () => {
  it('fresh heartbeat + live pid -> UP', () => {
    write(rec());
    const l = read();
    expect(l.state).toBe('up');
    expect(formatSupervisorLine(l)).toMatch(/Supervisor: UP \(pid 4242, port 8787, last heartbeat 5s ago\)/);
  });
  it('stale updatedAt -> DOWN with the last heartbeat time', () => {
    const updatedAt = iso(NOW - 60000);
    write(rec({ updatedAt }));
    const l = read();
    expect(l).toMatchObject({ state: 'down', reason: 'stale' });
    expect(formatSupervisorLine(l)).toContain(`DOWN`);
    expect(formatSupervisorLine(l)).toContain(updatedAt);
  });
  it('dead pid with fresh updatedAt -> DOWN', () => {
    write(rec());
    const l = read(false);
    expect(l).toMatchObject({ state: 'down', reason: 'pid-dead' });
    expect(formatSupervisorLine(l)).toContain(rec().updatedAt);
  });
  it('no file -> not running', () => {
    const l = read();
    expect(l.state).toBe('never-started');
    expect(formatSupervisorLine(l)).toMatch(/not running/);
  });
  it('malformed JSON / bad shape -> unreadable naming the path, no throw', () => {
    write('{ not json');
    let l = read();
    expect(l.state).toBe('unreadable');
    expect(formatSupervisorLine(l)).toContain(path.join(dir, 'supervisor.json'));
    write({ pid: 'x' });
    l = read();
    expect(l.state).toBe('unreadable');
    write('[]');
    expect(read().state).toBe('unreadable');
  });
  it('final record with stoppedAt -> stopped cleanly, even though updatedAt is old', () => {
    write(rec({ updatedAt: iso(NOW - 600000), stoppedAt: iso(NOW - 600000) }));
    const l = read(false);
    expect(l.state).toBe('stopped');
    expect(formatSupervisorLine(l)).toMatch(/stopped cleanly/);
  });
  it('EPERM from the pid probe counts as alive (default probe)', () => {
    write(rec());
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('x'), { code: 'EPERM' }); });
    expect(readSupervisorLiveness({ dataDir: dir, now: () => NOW }).state).toBe('up');
    spy.mockImplementation(() => { throw Object.assign(new Error('x'), { code: 'ESRCH' }); });
    expect(readSupervisorLiveness({ dataDir: dir, now: () => NOW }).state).toBe('down');
  });
});

describe('runStatus prints a Supervisor line from FLEET_SE_DATA_DIR in every server state', () => {
  it('shows DOWN for a stale record (running and stopped core)', async () => {
    process.env.FLEET_SE_DATA_DIR = dir;
    write(rec({ updatedAt: iso(Date.now() - 3600_000) }));
    for (const inst of [{ running: false, state: 'gone' }, { running: false, state: 'unresponsive', url: 'http://127.0.0.1:1/mcp', pid: 1 }]) {
      const out: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
      mockCheckRunning.mockResolvedValue(inst);
      await runStatus([]);
      expect(out.join('\n')).toMatch(/Supervisor: DOWN/);
      vi.restoreAllMocks();
    }
  });
  it('shows not running when there is no file', async () => {
    process.env.FLEET_SE_DATA_DIR = dir;
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
    mockCheckRunning.mockResolvedValue({ running: false, state: 'gone' });
    await runStatus([]);
    expect(out.join('\n')).toMatch(/Supervisor: not running/);
  });
});
