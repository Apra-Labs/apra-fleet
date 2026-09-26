/**
 * Task 3: SEA Binary Compatibility Verification
 *
 * Verifies that src/services/http-transport.ts bundles correctly under esbuild
 * (the same bundler used to produce dist/sea-bundle.cjs). The @hono/node-server
 * package is a transitive dependency of StreamableHTTPServerTransport and has
 * historically caused issues in bundled environments. This test surfaces any
 * bundling problems before the transport is wired into the main binary.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildIsolatedHomeEnv } from './helpers/isolated-home.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// Temporary bundle output path
const BUNDLE_PATH = path.join(os.tmpdir(), `apra-fleet-sea-verify-${process.pid}.cjs`);

// The actual http-transport source file (absolute path)
const HTTP_TRANSPORT_SRC = path.join(root, 'src', 'services', 'http-transport.ts');

afterAll(async () => {
  try { fs.unlinkSync(BUNDLE_PATH); } catch { /* best-effort */ }
});

describe('SEA bundle compatibility: http-transport', () => {
  let bundleSource = '';

  it('esbuild bundles http-transport.ts without errors', async () => {
    await build({
      entryPoints: [HTTP_TRANSPORT_SRC],
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'cjs',
      outfile: BUNDLE_PATH,
      sourcemap: false,
      external: ['cpu-features'],
      loader: { '.node': 'empty' },
      // Shim import.meta.url exactly as in the real SEA build
      define: { 'import.meta.url': 'import_meta_url' },
      banner: {
        js: 'var import_meta_url = typeof document === "undefined" ? require("url").pathToFileURL(__filename).href : undefined;',
      },
    });

    expect(fs.existsSync(BUNDLE_PATH)).toBe(true);
    bundleSource = fs.readFileSync(BUNDLE_PATH, 'utf8');
    expect(bundleSource.length).toBeGreaterThan(1000);
  });

  it('bundle contains StreamableHTTPServerTransport code', () => {
    expect(bundleSource).toBeTruthy();
    expect(bundleSource).toContain('StreamableHTTPServerTransport');
  });

  it('bundle contains @hono/node-server adapter code', () => {
    expect(bundleSource).toBeTruthy();
    // @hono/node-server is the Node.js adapter used by StreamableHTTPServerTransport
    // Its presence confirms the transitive dep bundled without requiring externals
    expect(bundleSource).toMatch(/@hono\/node-server|hono.*node.*server|node.*hono/i);
  });

  it('bundled createHttpTransport starts and binds a port', async () => {
    expect(fs.existsSync(BUNDLE_PATH)).toBe(true);

    const req = createRequire(import.meta.url);
    const mod = req(BUNDLE_PATH) as { createHttpTransport: typeof import('../src/services/http-transport.js').createHttpTransport };

    expect(typeof mod.createHttpTransport).toBe('function');

    const handle = await mod.createHttpTransport({
      registerTools: (_server: McpServer) => {},
      preferredPort: 0,
    });

    try {
      expect(handle.port).toBeGreaterThan(0);
      expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

      // Verify health endpoint responds
      const resp = await fetch(`http://127.0.0.1:${handle.port}/health`);
      expect(resp.status).toBe(200);
      const json = await resp.json() as { status: string };
      expect(json.status).toBe('ok');
    } finally {
      await handle.close();
    }
  });
});

// apra-fleet-v6t7.3.2: binary smoke -- GET /ui and GET /api/fleet/members
// against the REAL packaged SEA binary (dist/apra-fleet-installer-<platform>
// -<arch>[.exe]), not an in-process bundle. Skips cleanly with an explicit
// logged reason when no binary has been built (npm run build:binary is a
// separate, expensive step -- never required just to run `npm test`).
describe('SEA binary smoke: GET /ui and GET /api/fleet/members (apra-fleet-v6t7.3.2)', () => {
  const platformMap: Record<string, string> = { win32: 'win', darwin: 'darwin', linux: 'linux' };
  const ext = process.platform === 'win32' ? '.exe' : '';
  const binaryName = `apra-fleet-installer-${platformMap[process.platform] ?? process.platform}-${process.arch}${ext}`;
  const binaryPath = path.join(root, 'dist', binaryName);
  const binaryExists = fs.existsSync(binaryPath);

  if (!binaryExists) {
    console.log(
      `SKIP: SEA binary smoke -- ${binaryPath} not found. Run "npm run build:binary" first to exercise this suite; ` +
        'this is not required for a plain "npm test" run.',
    );
  }

  /** Ask the OS for a free ephemeral port -- never 7601/8801 (staging-reserved), never the fleet default (7523). */
  async function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.unref();
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const address = srv.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        srv.close(() => resolve(port));
      });
    });
  }

  async function waitForUi(port: number, timeoutMs: number): Promise<Response> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        return await fetch(`http://127.0.0.1:${port}/ui`);
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    throw new Error(`binary never answered GET /ui on port ${port} within ${timeoutMs}ms: ${String(lastErr)}`);
  }

  it.skipIf(!binaryExists)('serves the shell at GET /ui, and gates GET /api/fleet/members on the fleet key', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-sea-binary-smoke-'));
    let child: ChildProcess | undefined;

    try {
      const port = await getFreePort();
      expect(port).not.toBe(7601);
      expect(port).not.toBe(8801);

      child = spawn(binaryPath, ['run'], {
        env: {
          ...buildIsolatedHomeEnv(tmpHome, process.env),
          APRA_FLEET_PORT: String(port),
          APRA_FLEET_HOST: '127.0.0.1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderrBuf = '';
      child.stderr?.on('data', (d) => { stderrBuf += d.toString(); });

      const exitedEarly = new Promise<never>((_, reject) => {
        child!.once('exit', (code) => reject(new Error(`binary exited early with code ${code}. stderr:\n${stderrBuf}`)));
      });

      const uiResp = await Promise.race([waitForUi(port, 20000), exitedEarly]);
      expect(uiResp.status).toBe(200);
      const uiHtml = await uiResp.text();
      expect(uiHtml.toLowerCase()).toContain('<html');

      const unauthedResp = await fetch(`http://127.0.0.1:${port}/api/fleet/members`);
      expect(unauthedResp.status).toBe(401);

      const fleetKey = (await fsp.readFile(path.join(tmpHome, '.apra-fleet', 'fleet.key'), 'utf-8')).trim();
      expect(fleetKey.length).toBe(64);

      const authedResp = await fetch(`http://127.0.0.1:${port}/api/fleet/members`, {
        headers: { Authorization: `Bearer ${fleetKey}` },
      });
      expect(authedResp.status).toBe(200);
      const membersJson = await authedResp.json();
      expect(membersJson).toBeTruthy();
    } finally {
      if (child && !child.killed) {
        child.kill();
      }
      await fsp.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    }
  }, 30000);
});
