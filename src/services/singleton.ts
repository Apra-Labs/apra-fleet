import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { isPidAlive } from '../utils/process-utils.js';

// Paths are computed at call time (not module load) so tests can override APRA_FLEET_DATA_DIR
function getFleetDir(): string {
  return process.env.APRA_FLEET_DATA_DIR ?? path.join(os.homedir(), '.apra-fleet', 'data');
}

function getServerInfoPath(): string {
  return path.join(getFleetDir(), 'server.json');
}

function getLockPath(): string {
  return path.join(getFleetDir(), 'server.lock');
}

const STALE_LOCK_AGE_MS = 60_000;
const HEALTH_TIMEOUT_MS = 2000;
// Windows retries a SYN to a closed loopback port for ~2s before reporting
// ECONNREFUSED, so a shorter timeout would misread "refused" as "timeout".
const TCP_PROBE_TIMEOUT_MS = 3000;

/**
 * Singleton probe is tri-state (GitHub #584):
 *  - running:      pid alive and /health answered 200.
 *  - unresponsive: pid alive and the recorded port still accepts TCP, but
 *                  /health did not answer -- e.g. a server whose event loop is
 *                  blocked. It is NOT dead: server.json is kept and launchers
 *                  must refuse to start a second server on this data dir.
 *  - gone:         no server.json, or its pid is dead, or the recorded port
 *                  refuses TCP. Only this state unlinks server.json.
 */
export type InstanceState = 'running' | 'unresponsive' | 'gone';

export interface RunningInstance {
  running: true;
  state: 'running';
  url: string;
  pid: number;
  /** Version reported by the running server's server.json, or undefined if it predates this field. */
  version?: string;
}

export interface UnresponsiveInstance {
  running: false;
  state: 'unresponsive';
  url: string;
  pid: number;
  port?: number;
  version?: string;
}

export interface GoneInstance {
  running: false;
  state: 'gone';
}

export type InstanceCheckResult = RunningInstance | UnresponsiveInstance | GoneInstance;

export interface StartupLock {
  acquired: boolean;
  release: () => void;
}

type HealthResult = 'ok' | 'refused' | 'failed';

function checkHealthEndpoint(url: string): Promise<HealthResult> {
  const healthUrl = url.replace(/\/mcp$/, '/health');
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: HealthResult) => { if (!settled) { settled = true; resolve(r); } };
    const req = http.get(healthUrl, { timeout: HEALTH_TIMEOUT_MS }, (res) => {
      res.resume(); // drain response body
      finish(res.statusCode === 200 ? 'ok' : 'failed');
    });
    req.on('error', (err: NodeJS.ErrnoException) => finish(err.code === 'ECONNREFUSED' ? 'refused' : 'failed'));
    req.on('timeout', () => { finish('failed'); req.destroy(); });
  });
}

export type TcpProbeResult = 'open' | 'refused' | 'timeout' | 'error';

/**
 * Plain TCP connect probe. A server whose event loop is blocked still accepts
 * connections (the kernel completes the handshake into the listen backlog),
 * so 'open' means "something is listening", independent of whether it answers.
 */
export function probeTcpPort(port: number, host = '127.0.0.1', timeoutMs = TCP_PROBE_TIMEOUT_MS): Promise<TcpProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: TcpProbeResult) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(r);
    };
    const sock = net.connect({ port, host });
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish('open'));
    sock.once('timeout', () => finish('timeout'));
    sock.once('error', (err: NodeJS.ErrnoException) => finish(err.code === 'ECONNREFUSED' ? 'refused' : 'error'));
  });
}

/**
 * True when <host>:<port> cannot be bound because it is already in use -- the
 * exact failure the HTTP server would hit. A bind probe (not a connect probe):
 * instant on every OS, where a refused connect takes ~2s on Windows.
 */
export function isPortInUse(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (err: NodeJS.ErrnoException) => resolve(err.code === 'EADDRINUSE'));
    srv.listen(port, host, () => { srv.close(() => resolve(false)); });
  });
}

function portFromUrl(url: string): number | undefined {
  try {
    const p = Number(new URL(url).port);
    return Number.isFinite(p) && p > 0 ? p : undefined;
  } catch {
    return undefined;
  }
}

export async function checkRunningInstance(): Promise<InstanceCheckResult> {
  const serverInfoPath = getServerInfoPath();
  let info: { pid?: number; url?: string; port?: number; version?: string };
  try {
    const raw = fs.readFileSync(serverInfoPath, 'utf8');
    info = JSON.parse(raw);
  } catch {
    return { running: false, state: 'gone' };
  }

  if (!info.pid || !info.url) return { running: false, state: 'gone' };

  if (!isPidAlive(info.pid)) {
    try { fs.unlinkSync(serverInfoPath); } catch {}
    return { running: false, state: 'gone' };
  }

  const health = await checkHealthEndpoint(info.url);
  if (health === 'ok') {
    return { running: true, state: 'running', url: info.url, pid: info.pid, version: info.version };
  }

  // Live pid but no /health answer. Only a refused TCP connect on the
  // recorded port proves the server is gone (e.g. the pid was reused by an
  // unrelated process); a timeout or an accepted connect means a live but
  // unresponsive server, whose server.json must survive.
  const port = typeof info.port === 'number' && info.port > 0 ? info.port : portFromUrl(info.url);
  let host = '127.0.0.1';
  try { host = new URL(info.url).hostname || host; } catch { /* keep loopback */ }
  if (health === 'refused' || (port !== undefined && (await probeTcpPort(port, host)) === 'refused')) {
    try { fs.unlinkSync(serverInfoPath); } catch {}
    return { running: false, state: 'gone' };
  }
  return { running: false, state: 'unresponsive', url: info.url, pid: info.pid, port, version: info.version };
}

/** pid recorded in this data dir's server.json, if any (no liveness check, never deletes). */
export function readServerInfoPid(): number | undefined {
  try {
    const info = JSON.parse(fs.readFileSync(getServerInfoPath(), 'utf8')) as { pid?: unknown };
    return typeof info.pid === 'number' ? info.pid : undefined;
  } catch {
    return undefined;
  }
}

/** Operator-facing refusal for a live-but-unresponsive server. */
export function unresponsiveInstanceMessage(inst: UnresponsiveInstance): string {
  const portStr = inst.port !== undefined ? ` port ${inst.port}` : '';
  return `apra-fleet server pid ${inst.pid}${portStr} (${inst.url}) is alive but not answering /health. `
    + 'Refusing to start a second server on the same data dir. '
    + 'Run "apra-fleet stop" to stop it, then start again.';
}

/**
 * Operator-facing error for a configured port that is already taken. The
 * server never falls back to a random port: configured MCP clients only know
 * the configured port, so a silent fallback produces an unreachable server.
 */
export function portInUseMessage(port: number, holderPid?: number): string {
  const holder = holderPid !== undefined
    ? `server.json in this data dir records apra-fleet pid ${holderPid}`
    : 'server.json in this data dir records no apra-fleet server (holder pid: none)';
  return `Port ${port} is already in use; apra-fleet cannot start its server there (${holder}). `
    + `Free port ${port} (if it is a hung apra-fleet server, run "apra-fleet stop"), `
    + 'or set APRA_FLEET_PORT to a free port and re-run "apra-fleet install" so MCP clients point at it.';
}

export function claimStartupLock(): StartupLock {
  const fleetDir = getFleetDir();
  const lockPath = getLockPath();

  try { fs.mkdirSync(fleetDir, { recursive: true }); } catch {}

  function tryAcquire(allowRetry: boolean): StartupLock {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return {
        acquired: true,
        release: () => { try { fs.unlinkSync(lockPath); } catch {} },
      };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

      // Lock file exists -- check if it is stale (crashed process)
      if (allowRetry) {
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > STALE_LOCK_AGE_MS) {
            fs.unlinkSync(lockPath);
            return tryAcquire(false);
          }
        } catch {
          // stat failed -- lock may have been deleted between our check and now
        }
      }
      return { acquired: false, release: () => {} };
    }
  }

  return tryAcquire(true);
}
