/**
 * End-to-end supervisor liveness: a real `serve.mjs --detach` supervisor, the
 * heartbeat it writes, and what core `apra-fleet status` logic reports from it.
 *
 *  1. detached supervisor -> status UP
 *  2. hard kill (no clean shutdown) -> status DOWN with the last heartbeat time
 *  3. a second supervisor stopped via /api/shutdown -> stopped cleanly
 *
 * Isolation: throwaway beads dir, temp FLEET_SE_DATA_DIR + APRA_FLEET_DATA_DIR,
 * ephemeral ports; teardown kills only the pids this test started and removes
 * the temp dirs. Windows hosts run it too (TerminateProcess via SIGKILL); the
 * "launching console closes" scenario is external evidence (see the bead).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readSupervisorLiveness, formatSupervisorLine } from '../src/cli/supervisor-liveness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SE_ROOT = path.join(here, '..', 'packages', 'apra-fleet-se');
const SERVE_BIN = path.join(SE_ROOT, 'bin', 'serve.mjs');

const pids = new Set<number>();
const tmpDirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterAll(async () => {
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  for (const c of cleanups) await c();
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)); });
  });
}

function postShutdown(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const body = Buffer.from('{}');
    const req = http.request({ host: '127.0.0.1', port, path: '/api/shutdown', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': body.length } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
    req.on('error', reject);
    req.end(body);
  });
}

async function waitFor(pred: () => boolean, ms = 30000, label = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return; await sleep(100); }
  throw new Error(`timed out waiting for ${label}`);
}

async function startDetached() {
  const seData = fs.mkdtempSync(path.join(os.tmpdir(), 'liveness-se-'));
  const fleetData = fs.mkdtempSync(path.join(os.tmpdir(), 'liveness-fleet-'));
  tmpDirs.push(seData, fleetData);
  const helper = await import(pathToFileURL(path.join(SE_ROOT, 'test', 'helpers', 'beads-fixture.mjs')).href);
  const fx = await helper.createBeadsFixture();
  cleanups.push(fx.cleanup);
  const port = await freePort();
  const env = helper.envWithoutBeadsDir({
    FLEET_SE_DATA_DIR: seData, APRA_FLEET_DATA_DIR: fleetData,
    FLEET_SE_HEARTBEAT_INTERVAL_MS: '300', FLEET_SE_DETACH_TIMEOUT_MS: '90000',
  });
  const r = spawnSync(process.execPath, [SERVE_BIN, '--detach', '--port', String(port), '--beads-dir', fx.dir], { cwd: SE_ROOT, env, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  const m = /pid (\d+), port (\d+)/.exec(r.stdout ?? '');
  if (m) pids.add(Number(m[1]));
  if (r.status !== 0 || !m) throw new Error(`detach failed: ${r.stdout}\n${r.stderr}`);
  return { seData, port, pid: Number(m[1]) };
}

describe('supervisor liveness end to end', () => {
  it('detached supervisor -> UP; hard kill -> DOWN with the last heartbeat time', async () => {
    const sup = await startDetached();
    await waitFor(() => readSupervisorLiveness({ dataDir: sup.seData }).state === 'up', 30000, 'status UP');
    const up = readSupervisorLiveness({ dataDir: sup.seData });
    expect(up).toMatchObject({ state: 'up', pid: sup.pid, port: sup.port });
    expect(formatSupervisorLine(up)).toMatch(/Supervisor: UP/);

    // Let at least one more heartbeat land so "last heartbeat" is meaningful.
    await sleep(700);
    process.kill(sup.pid, 'SIGKILL'); // no clean shutdown: no final record
    await waitFor(() => !alive(sup.pid), 15000, 'child death');
    pids.delete(sup.pid);

    const down = readSupervisorLiveness({ dataDir: sup.seData });
    expect(down.state).toBe('down');
    const line = formatSupervisorLine(down);
    expect(line).toMatch(/Supervisor: DOWN/);
    const rec = JSON.parse(fs.readFileSync(path.join(sup.seData, 'supervisor.json'), 'utf8'));
    expect(rec.stoppedAt).toBeUndefined();
    expect(line).toContain(rec.updatedAt);
  }, 240000);

  it('clean stop via /api/shutdown -> stopped cleanly', async () => {
    const sup = await startDetached();
    await waitFor(() => readSupervisorLiveness({ dataDir: sup.seData }).state === 'up', 30000, 'status UP');
    expect(await postShutdown(sup.port)).toBe(200);
    await waitFor(() => readSupervisorLiveness({ dataDir: sup.seData }).state === 'stopped', 30000, 'stopped cleanly');
    expect(formatSupervisorLine(readSupervisorLiveness({ dataDir: sup.seData }))).toMatch(/stopped cleanly/);
    await waitFor(() => !alive(sup.pid), 15000, 'child exit');
    pids.delete(sup.pid);
  }, 240000);
});
