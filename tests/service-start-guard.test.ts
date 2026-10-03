/**
 * GitHub #585 recovery: a service launch that keeps failing backs off instead
 * of retrying (and writing a new fleet-<pid>.log) on every revive-trigger
 * tick. Unit tests on the state file, plus the real built server
 * (dist/index.js) in a sandboxed data dir to prove the startup wiring.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { consumeLaunchMarkers, MACOS_PLIST_LABEL } from '../src/services/service-manager/types.js';
import {
  serviceStartBackoff, recordServiceStartAttempt, clearServiceStartFailures, shouldLogServiceNotice,
  MAX_CONSECUTIVE_FAILURES, BACKOFF_MS,
} from '../src/services/service-start-guard.js';

const DIST_INDEX = path.resolve(__dirname, '..', 'dist', 'index.js');

describe('service start guard state', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-guard-'));
    file = path.join(dir, 'service-start-failures.json');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('no state -> no backoff', () => {
    expect(serviceStartBackoff(file, 1000)).toBeNull();
  });

  it(`backs off only after ${MAX_CONSECUTIVE_FAILURES} consecutive failed launches, until the window passes`, () => {
    const t0 = 1_000_000;
    for (let i = 1; i < MAX_CONSECUTIVE_FAILURES; i++) {
      recordServiceStartAttempt(file, t0 + i);
      expect(serviceStartBackoff(file, t0 + i + 1)).toBeNull();
    }
    const last = t0 + MAX_CONSECUTIVE_FAILURES;
    recordServiceStartAttempt(file, last);
    const skip = serviceStartBackoff(file, last + 60_000);
    expect(skip).toMatch(new RegExp(`last ${MAX_CONSECUTIVE_FAILURES} service starts failed`));
    expect(skip).toContain("'apra-fleet start' retries immediately");
    expect(serviceStartBackoff(file, last + BACKOFF_MS)).toBeNull();
  });

  it('a successful start (or explicit start) clears the streak', () => {
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) recordServiceStartAttempt(file, 10);
    expect(serviceStartBackoff(file, 20)).not.toBeNull();
    clearServiceStartFailures(file);
    expect(serviceStartBackoff(file, 20)).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('a corrupt state file never blocks a start', () => {
    fs.writeFileSync(file, '{not json');
    expect(serviceStartBackoff(file, 1)).toBeNull();
  });
});

function runServer(env: Record<string, string>): Promise<{ code: number | null; stdout: string }> {
  const base = { ...process.env };
  delete base.APRA_FLEET_SERVICE;
  delete base.INVOCATION_ID;
  delete base.XPC_SERVICE_NAME;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DIST_INDEX, 'run'], {
      env: { ...base, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '';
    child.stdout!.on('data', (d) => { stdout += d; });
    const killer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.once('exit', (code) => { clearTimeout(killer); resolve({ code, stdout }); });
  });
}

describe('built server honours the backoff under the service marker', () => {
  let dataDir: string;
  beforeEach(() => {
    expect(fs.existsSync(DIST_INDEX), 'dist/ missing -- run npm run build first').toBe(true);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-guard-srv-'));
    fs.writeFileSync(path.join(dataDir, 'service-start-failures.json'),
      JSON.stringify({ consecutive: MAX_CONSECUTIVE_FAILURES, lastAttemptAt: Date.now() }));
  });
  afterEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

  it('service launch in backoff: exit 0, one line to the service log, no fleet-<pid>.log, no server.json', async () => {
    // HOME/USERPROFILE sandboxed too: if the guard regressed, a full server would start and
    // must not touch the real ~/.apra-fleet (fleet.key) or ~/.fleet-tasks.
    const { code, stdout } = await runServer({
      APRA_FLEET_DATA_DIR: dataDir, APRA_FLEET_PORT: '1', APRA_FLEET_SERVICE: '1', HOME: dataDir, USERPROFILE: dataDir,
    });
    expect(code).toBe(0);
    expect(stdout).toMatch(/service launch skipped/);
    expect(fs.existsSync(path.join(dataDir, 'server.json'))).toBe(false);
    const logs = fs.existsSync(path.join(dataDir, 'logs')) ? fs.readdirSync(path.join(dataDir, 'logs')) : [];
    expect(logs).toEqual([]);
  }, 40_000);
});

describe('service-launch notices are rate limited', () => {
  it('logs a kind at most once per interval', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-notice-'));
    try {
      const file = path.join(dir, 'service-notices.json');
      expect(shouldLogServiceNotice('already-running', file, 1_000, 3_600_000)).toBe(true);
      expect(shouldLogServiceNotice('already-running', file, 2_000, 3_600_000)).toBe(false);
      expect(shouldLogServiceNotice('stopped-by-user', file, 2_000, 3_600_000)).toBe(true);
      expect(shouldLogServiceNotice('already-running', file, 1_000 + 3_600_000, 3_600_000)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A deliberate `apra-fleet stop` must stick across logon/boot on every OS:
// launchd RunAtLoad, an enabled systemd unit, the Windows HKCU Run fallback
// and an undisableable old task all launch the server with the service marker.
describe('built server: service launch after apra-fleet stop', () => {
  let dataDir: string;
  beforeEach(() => {
    expect(fs.existsSync(DIST_INDEX), 'dist/ missing -- run npm run build first').toBe(true);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-stopped-srv-'));
    fs.writeFileSync(path.join(dataDir, 'stopped-by-user.json'),
      JSON.stringify({ stoppedAt: '2026-10-03T10:00:00.000Z', by: 'apra-fleet stop', user: 'alice', host: 'h', pid: 1 }));
  });
  afterEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

  for (const marker of [{ APRA_FLEET_SERVICE: '1' }]) {
    it(`${Object.keys(marker)[0]} launch: exit 0, one notice, marker kept, no server`, async () => {
      const { code, stdout } = await runServer({ APRA_FLEET_DATA_DIR: dataDir, APRA_FLEET_PORT: '1', ...marker });
      expect(code).toBe(0);
      expect(stdout).toMatch(/service launch skipped: stopped by alice at 2026-10-03T10:00:00\.000Z/);
      expect(fs.existsSync(path.join(dataDir, 'stopped-by-user.json'))).toBe(true);
      expect(fs.existsSync(path.join(dataDir, 'server.json'))).toBe(false);
    }, 40_000);
  }

  // INVOCATION_ID / XPC_SERVICE_NAME leak into hand-run shells (systemd-run
  // --shell, tmux under a user unit): a hand-run `apra-fleet run` there must
  // START, not exit 0 silently.
  for (const leaked of [{ INVOCATION_ID: 'abc123' }, { XPC_SERVICE_NAME: MACOS_PLIST_LABEL }]) {
    it(`hand-run with only ${Object.keys(leaked)[0]} set starts the server despite the marker (marker kept)`, async () => {
      const port = await freePort();
      const { ready, stdout } = await runServerUntilReady({
        APRA_FLEET_DATA_DIR: dataDir, APRA_FLEET_PORT: String(port), HOME: dataDir, USERPROFILE: dataDir, ...leaked,
      }, path.join(dataDir, 'server.json'));
      expect(stdout).not.toMatch(/service launch skipped/);
      expect(ready).toBe(true);
      expect(fs.existsSync(path.join(dataDir, 'stopped-by-user.json'))).toBe(true);
    }, 60_000);
  }
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

function runServerUntilReady(env: Record<string, string>, readyFile: string): Promise<{ ready: boolean; stdout: string }> {
  const base = { ...process.env };
  delete base.APRA_FLEET_SERVICE;
  delete base.INVOCATION_ID;
  delete base.XPC_SERVICE_NAME;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DIST_INDEX, 'run'], {
      env: { ...base, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '';
    let ready = false;
    child.stdout!.on('data', (d) => { stdout += d; });
    const started = Date.now();
    const poll = setInterval(() => {
      if (fs.existsSync(readyFile)) ready = true;
      if (ready || Date.now() - started > 40_000) { clearInterval(poll); child.kill('SIGKILL'); }
    }, 200);
    child.once('exit', () => { clearInterval(poll); resolve({ ready, stdout }); });
  });
}

describe('consumeLaunchMarkers', () => {
  it('reports our marker strictly, any service-manager hint loosely, and strips ours so children never inherit them', () => {
    const env: Record<string, string | undefined> = { APRA_FLEET_SERVICE: '1', APRA_FLEET_AUTOSTART: '1', INVOCATION_ID: 'x', OTHER: 'y' };
    expect(consumeLaunchMarkers(env)).toEqual({ service: true, managed: true });
    expect(env).toEqual({ INVOCATION_ID: 'x', OTHER: 'y' });
    expect(consumeLaunchMarkers({ INVOCATION_ID: 'x' })).toEqual({ service: false, managed: true });
    // A child of the launchd-run server inherits our label: managed, never "service".
    expect(consumeLaunchMarkers({ XPC_SERVICE_NAME: MACOS_PLIST_LABEL })).toEqual({ service: false, managed: true });
    expect(consumeLaunchMarkers({})).toEqual({ service: false, managed: false });
  });
});
