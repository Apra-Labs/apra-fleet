import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { launchedByServiceManager, MACOS_PLIST_LABEL } from '../src/services/service-manager/types.js';

// GitHub #584 review: the real `apra-fleet run` startup refusals, end to end
// against the built server (dist/index.js) in a sandboxed data dir.
//  - an unresponsive server holding the data dir -> refuse, keep server.json
//  - the configured port held by a foreign listener -> refuse with the message
// Exit code: 0 ONLY when launched by a restarting service manager (a non-zero
// exit would make systemd/launchd restart the refusing server in a loop);
// every other launch (CI, nohup, containers, scripts, terminals) exits 1.

const DIST_INDEX = path.resolve(__dirname, '..', 'dist', 'index.js');

function runServer(env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
  const base = { ...process.env };
  // Start from a launch that is NOT under a service manager, whatever runs the tests.
  delete base.APRA_FLEET_SERVICE;
  delete base.INVOCATION_ID;
  delete base.XPC_SERVICE_NAME;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DIST_INDEX, 'run'], {
      env: { ...base, ...env },
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr!.on('data', (d) => { stderr += d; });
    const killer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.once('exit', (code) => { clearTimeout(killer); resolve({ code, stderr }); });
  });
}

describe('launchedByServiceManager', () => {
  it('recognizes the explicit marker, systemd and our launchd label -- nothing else', () => {
    expect(launchedByServiceManager({ APRA_FLEET_SERVICE: '1' })).toBe(true);
    expect(launchedByServiceManager({ INVOCATION_ID: 'abc123' })).toBe(true);
    expect(launchedByServiceManager({ XPC_SERVICE_NAME: MACOS_PLIST_LABEL })).toBe(true);
    expect(launchedByServiceManager({ XPC_SERVICE_NAME: 'com.apple.Terminal' })).toBe(false);
    expect(launchedByServiceManager({ APRA_FLEET_SERVICE: '0' })).toBe(false);
    expect(launchedByServiceManager({ CI: 'true' })).toBe(false);
    expect(launchedByServiceManager({})).toBe(false);
  });
});

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

  function writeUnresponsiveServerJson(): string {
    const info = path.join(dataDir, 'server.json');
    fs.writeFileSync(info, JSON.stringify({ pid: process.pid, port, url: `http://127.0.0.1:${port}/mcp` }));
    return info;
  }

  it('unresponsive server, ordinary (non-service) launch -> refuses with exit 1, keeps server.json', async () => {
    const info = writeUnresponsiveServerJson();
    const { code, stderr } = await runServer({ APRA_FLEET_DATA_DIR: dataDir, APRA_FLEET_PORT: String(port) });
    expect(code).toBe(1);
    expect(stderr).toContain(`pid ${process.pid}`);
    expect(stderr).toContain('apra-fleet stop');
    expect(fs.existsSync(info)).toBe(true);
  }, 40_000);

  it('unresponsive server under a service manager (APRA_FLEET_SERVICE=1) -> refuses with exit 0', async () => {
    const info = writeUnresponsiveServerJson();
    const { code, stderr } = await runServer({ APRA_FLEET_DATA_DIR: dataDir, APRA_FLEET_PORT: String(port), APRA_FLEET_SERVICE: '1' });
    expect(code).toBe(0);
    expect(stderr).toContain('apra-fleet stop');
    expect(fs.existsSync(info)).toBe(true);
  }, 40_000);

  it('busy port, ordinary launch -> refuses with the port message and exit 1', async () => {
    const { code, stderr } = await runServer({ APRA_FLEET_DATA_DIR: dataDir, APRA_FLEET_PORT: String(port) });
    expect(code).toBe(1);
    expect(stderr).toContain(`Port ${port} is already in use`);
    expect(stderr).toContain('APRA_FLEET_PORT');
    expect(fs.existsSync(path.join(dataDir, 'server.json'))).toBe(false);
  }, 40_000);

  it('busy port under systemd (INVOCATION_ID set, pre-marker unit) -> exit 0', async () => {
    const { code, stderr } = await runServer({ APRA_FLEET_DATA_DIR: dataDir, APRA_FLEET_PORT: String(port), INVOCATION_ID: 'test-invocation' });
    expect(code).toBe(0);
    expect(stderr).toContain(`Port ${port} is already in use`);
  }, 40_000);
});
