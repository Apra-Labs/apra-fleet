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
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

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
