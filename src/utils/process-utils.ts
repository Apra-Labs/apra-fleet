import http from 'node:http';
import { execFileSync } from 'node:child_process';

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** True when a process command line is an apra-fleet server: the SEA binary,
 *  or node running a dist/index.js build. */
export function isApraFleetCommandLine(cmd: string): boolean {
  return /apra-fleet/i.test(cmd) || /dist[\\/]index\.js/i.test(cmd);
}

/** The command line of a live pid, or null when it cannot be read. */
export function processCommandLine(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const opts = { encoding: 'utf8' as const, stdio: 'pipe' as const, windowsHide: true, timeout: 10_000 };
  try {
    const out = process.platform === 'win32'
      ? execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], opts)
      : execFileSync('ps', ['-p', String(pid), '-o', 'command='], opts);
    const trimmed = String(out).trim();
    return trimmed === '' ? null : trimmed;
  } catch {
    return null;
  }
}

/**
 * GitHub #584 review: before force-killing the pid recorded in server.json,
 * confirm it is still an apra-fleet server -- pids are reused, and the port
 * owner may be a foreign app. true / false, or null when it cannot be told.
 */
export function isApraFleetProcess(pid: number): boolean | null {
  const cmd = processCommandLine(pid);
  return cmd === null ? null : isApraFleetCommandLine(cmd);
}

export async function postShutdown(url: string): Promise<void> {
  const shutdownUrl = url.replace(/\/mcp$/, '/shutdown');
  const parsed = new URL(shutdownUrl);
  // Authenticate the admin shutdown call with the same local signing key the
  // JWT service uses (~/.apra-fleet/fleet.key, mode 0o600). This is not a member
  // JWT -- it's a local-admin proof: only a process running as the same OS user
  // can read the key file, which matches the existing 127.0.0.1-only trust
  // boundary of this server. See apra-fleet-2xs.11.
  let authHeader: Record<string, string> = {};
  try {
    const { getOrCreateKey } = await import('../services/jwt.js');
    authHeader = { Authorization: `Bearer ${getOrCreateKey()}` };
  } catch {
    // If the key can't be read/created, fall through with no auth header --
    // the server will reject the request with 401, which is the safe default.
  }
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname,
        method: 'POST',
        timeout: 3000,
        headers: authHeader,
      },
      (res) => { res.resume(); resolve(); },
    );
    req.on('error', () => resolve());
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.end();
  });
}
