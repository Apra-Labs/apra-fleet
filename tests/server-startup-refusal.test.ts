import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

// GitHub #584 review: the real `apra-fleet run` startup refusals, end to end
// against the built server (dist/index.js) in a sandboxed data dir.
//  - an unresponsive server holding the data dir -> refuse, keep server.json
//  - the configured port held by a foreign listener -> refuse with the message
// Both are launched without a terminal on stdin (as a service manager would),
// so they must exit 0 -- a non-zero exit would make systemd/launchd restart the
// refusing server in a loop.

const DIST_INDEX = path.resolve(__dirname, '..', 'dist', 'index.js');

function runServer(env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DIST_INDEX, 'run'], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr!.on('data', (d) => { stderr += d; });
    const killer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.once('exit', (code) => { clearTimeout(killer); resolve({ code, stderr }); });
  });
}

describe('apra-fleet run startup refusals (built server)', () => {
  let dataDir: string;
  let listener: net.Server;
  const sockets: net.Socket[] = [];
  let port: number;

  beforeEach(async () => {
    expect(fs.existsSync(DIST_INDEX), 'dist/ missing -- run npm run build first').toBe(true);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-refusal-'));
    // A listener that accepts connections and never answers: a hung fleet
    // server (blocked event loop) or a foreign app on the port.
    listener = net.createServer((s) => { sockets.push(s); });
    await new Promise<void>((r) => listener.listen(0, '127.0.0.1', r));
    port = (listener.address() as net.AddressInfo).port;
  });

  afterEach(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => listener.close(() => r()));
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('unresponsive live server in server.json -> refuses, exits 0 (non-TTY), keeps server.json', async () => {
    const info = path.join(dataDir, 'server.json');
    fs.writeFileSync(info, JSON.stringify({ pid: process.pid, port, url: `http://127.0.0.1:${port}/mcp` }));
    const { code, stderr } = await runServer({ APRA_FLEET_DATA_DIR: dataDir, APRA_FLEET_PORT: String(port) });
    expect(code).toBe(0);
    expect(stderr).toContain(`pid ${process.pid}`);
    expect(stderr).toContain('apra-fleet stop');
    expect(fs.existsSync(info)).toBe(true);
  }, 40_000);

  it('configured port held by a foreign listener (no server.json) -> refuses with the port message, exits 0 (non-TTY)', async () => {
    const { code, stderr } = await runServer({ APRA_FLEET_DATA_DIR: dataDir, APRA_FLEET_PORT: String(port) });
    expect(code).toBe(0);
    expect(stderr).toContain(`Port ${port} is already in use`);
    expect(stderr).toContain('APRA_FLEET_PORT');
    expect(fs.existsSync(path.join(dataDir, 'server.json'))).toBe(false);
  }, 40_000);
});
