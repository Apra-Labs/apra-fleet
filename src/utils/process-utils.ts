import http from 'node:http';

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function postShutdown(url: string): Promise<void> {
  return new Promise((resolve) => {
    const shutdownUrl = url.replace(/\/mcp$/, '/shutdown');
    const parsed = new URL(shutdownUrl);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname,
        method: 'POST',
        timeout: 3000,
      },
      (res) => { res.resume(); resolve(); },
    );
    req.on('error', () => resolve());
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.end();
  });
}
