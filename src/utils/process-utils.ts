import http from 'node:http';

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
