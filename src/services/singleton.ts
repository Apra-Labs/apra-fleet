import fs from 'node:fs';
import http from 'node:http';
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

export interface RunningInstance {
  running: true;
  url: string;
  pid: number;
}

export type InstanceCheckResult = RunningInstance | { running: false };

export interface StartupLock {
  acquired: boolean;
  release: () => void;
}

function checkHealthEndpoint(url: string): Promise<boolean> {
  const healthUrl = url.replace(/\/mcp$/, '/health');
  return new Promise((resolve) => {
    const req = http.get(healthUrl, { timeout: 2000 }, (res) => {
      res.resume(); // drain response body
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

export async function checkRunningInstance(): Promise<InstanceCheckResult> {
  const serverInfoPath = getServerInfoPath();
  let info: { pid?: number; url?: string };
  try {
    const raw = fs.readFileSync(serverInfoPath, 'utf8');
    info = JSON.parse(raw);
  } catch {
    return { running: false };
  }

  if (!info.pid || !info.url) return { running: false };

  if (!isPidAlive(info.pid)) {
    try { fs.unlinkSync(serverInfoPath); } catch {}
    return { running: false };
  }

  const healthy = await checkHealthEndpoint(info.url);
  if (!healthy) {
    try { fs.unlinkSync(serverInfoPath); } catch {}
    return { running: false };
  }

  return { running: true, url: info.url, pid: info.pid };
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
