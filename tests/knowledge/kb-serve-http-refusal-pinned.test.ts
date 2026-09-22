import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startKbServer, KbServerHttpProviderRefusedError } from '../../src/commands/kb-server.js';
import { encryptPassword } from '../../src/utils/crypto.js';
import { FLEET_DIR } from '../../src/paths.js';
import { resetKbProviders } from '../../src/services/knowledge/kb-providers.js';

// my-beads-db-0cd.20: pins the my-beads-db-0cd.15 decision (fail fast, never
// self-proxy) so a future change to kb-server.ts or its callers cannot
// silently regress it. FALSIFIABILITY was verified by hand for this file:
// reverting kb-server.ts's http-provider guard to its pre-.15 no-op made
// every test in the "refuses an http project provider" describe block below
// fail (the in-process rejection assertions failed because startKbServer
// resolved instead of rejecting, and the CLI subprocess assertion failed
// because the child exited 0 having bound the port) -- then the guard was
// restored and this file was re-run to confirm it passes again.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = path.resolve(__dirname, '..', '..', 'dist', 'index.js');

const KB_CONFIG_DIR = path.join(FLEET_DIR, 'knowledge');
const KB_CONFIG_PATH = path.join(KB_CONFIG_DIR, 'config.json');
const TOKEN_PATH = path.join(KB_CONFIG_DIR, 'kb-server.token');

// Deliberately unreachable + obviously fake, matching
// tests/knowledge/kb-providers-http-selection.test.ts's convention: these
// tests assert on observable behaviour (rejection, request counts, port
// availability) and never expect a real response from this URL.
const FAKE_TOKEN = 'NOT_A_REAL_KEY';

const tempDataDirs: string[] = [];

function makeChildDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-serve-cli-'));
  tempDataDirs.push(dir);
  return dir;
}

// encryptPassword (src/utils/crypto.ts) derives its AES-256-GCM key from
// FLEET_DIR/salt of the CALLING process. The CLI-subprocess test below runs
// the server in a *different* FLEET_DIR (via APRA_FLEET_DATA_DIR), so a token
// encrypted with this process's key would fail to decrypt there. This helper
// reimplements the same algorithm against a caller-supplied key so a config
// can be prepared for a child process's own FLEET_DIR -- the key is written
// to that child's FLEET_DIR/salt before spawning, exactly mirroring how
// getOrCreateKey() persists one for real.
function encryptForChildDataDir(key: Buffer, plaintext: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

function writeHttpConfigForChild(dataDir: string, remoteUrl: string): void {
  const key = crypto.randomBytes(32);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'salt'), key.toString('hex'), { mode: 0o600 });
  const knowledgeDir = path.join(dataDir, 'knowledge');
  fs.mkdirSync(knowledgeDir, { recursive: true });
  fs.writeFileSync(
    path.join(knowledgeDir, 'config.json'),
    JSON.stringify({
      provider: 'http',
      url: remoteUrl,
      token_encrypted: encryptForChildDataDir(key, FAKE_TOKEN),
    }, null, 2),
  );
}

function runKbServerCli(dataDir: string, port: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DIST_INDEX, 'kb-server', '--port', String(port)], {
      env: { ...process.env, APRA_FLEET_DATA_DIR: dataDir },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('kb-server CLI did not exit within 10s (expected to fail fast before binding)'));
    }, 10_000);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// Proves nothing is left listening on `port`: a plain server can bind to it.
async function expectPortFree(port: number): Promise<void> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => resolve());
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
}

beforeEach(() => {
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  fs.rmSync(TOKEN_PATH, { force: true });
  resetKbProviders();
});

afterEach(() => {
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  fs.rmSync(TOKEN_PATH, { force: true });
  resetKbProviders();
});

afterAll(() => {
  for (const dir of tempDataDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('kb serve refuses an http project provider, and never self-proxies (my-beads-db-0cd.15 pinned by my-beads-db-0cd.20)', () => {
  it('in-process: rejects with the named error and never sends a request to the configured remote', async () => {
    let remoteRequestCount = 0;
    const remote = http.createServer((_req, res) => {
      remoteRequestCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'this remote must never be contacted' }));
    });
    await new Promise<void>((resolve) => remote.listen(0, '127.0.0.1', resolve));
    const address = remote.address();
    if (address === null || typeof address === 'string') {
      throw new Error('kb-serve-http-refusal-pinned: remote stub did not bind to a TCP port');
    }
    const remoteUrl = `http://127.0.0.1:${address.port}`;

    try {
      fs.mkdirSync(KB_CONFIG_DIR, { recursive: true });
      fs.writeFileSync(
        KB_CONFIG_PATH,
        JSON.stringify({
          provider: 'http',
          url: remoteUrl,
          token_encrypted: encryptPassword(FAKE_TOKEN),
        }, null, 2),
      );

      const kbServerPort = 17920;
      await expect(startKbServer(kbServerPort, false)).rejects.toThrow(KbServerHttpProviderRefusedError);
      await expect(startKbServer(kbServerPort, false)).rejects.toThrow('KB server refuses an http project provider');

      expect(remoteRequestCount).toBe(0);

      // No server object is ever constructed on the refusal path (the throw
      // happens before `http.createServer` is called in kb-server.ts), so the
      // port must still be free afterwards.
      await expectPortFree(kbServerPort);
    } finally {
      await new Promise<void>((resolve) => remote.close(() => resolve()));
    }
  });

  it('real CLI subprocess: exits nonzero before binding, with the named error on stderr, and leaves the port free', async () => {
    let remoteRequestCount = 0;
    const remote = http.createServer((_req, res) => {
      remoteRequestCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'this remote must never be contacted' }));
    });
    await new Promise<void>((resolve) => remote.listen(0, '127.0.0.1', resolve));
    const address = remote.address();
    if (address === null || typeof address === 'string') {
      throw new Error('kb-serve-http-refusal-pinned: remote stub did not bind to a TCP port');
    }
    const remoteUrl = `http://127.0.0.1:${address.port}`;

    try {
      const dataDir = makeChildDataDir();
      writeHttpConfigForChild(dataDir, remoteUrl);

      const kbServerPort = 17921;
      const result = await runKbServerCli(dataDir, kbServerPort);

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('KB server refuses an http project provider');
      expect(remoteRequestCount).toBe(0);

      await expectPortFree(kbServerPort);
    } finally {
      await new Promise<void>((resolve) => remote.close(() => resolve()));
    }
  });
});

describe('kb serve with a stock KB config still starts and serves as today (my-beads-db-0cd.20)', () => {
  it('no config file: starts, serves /health, and serves an authenticated /api/kb/query', async () => {
    expect(fs.existsSync(KB_CONFIG_PATH)).toBe(false);
    const port = 17922;
    const server = await startKbServer(port, false);
    try {
      const health = await new Promise<{ status: number; body: any }>((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/health`, (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(body) }));
        }).on('error', reject);
      });
      expect(health.status).toBe(200);
      expect(health.body.status).toBe('ok');

      const encryptedToken = fs.readFileSync(TOKEN_PATH, 'utf-8').trim();
      const { decryptPassword } = await import('../../src/utils/crypto.js');
      const token = decryptPassword(encryptedToken);

      const queryResult = await new Promise<{ status: number }>((resolve, reject) => {
        http.get(
          `http://127.0.0.1:${port}/api/kb/query?query=test`,
          { headers: { Authorization: `Bearer ${token}` } },
          (res) => { res.resume(); resolve({ status: res.statusCode! }); },
        ).on('error', reject);
      });
      expect(queryResult.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('explicit provider "sqlite": starts and serves /health identically', async () => {
    fs.mkdirSync(KB_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(KB_CONFIG_PATH, JSON.stringify({ provider: 'sqlite' }, null, 2));

    const port = 17923;
    const server = await startKbServer(port, false);
    try {
      const health = await new Promise<{ status: number; body: any }>((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/health`, (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(body) }));
        }).on('error', reject);
      });
      expect(health.status).toBe(200);
      expect(health.body.status).toBe('ok');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
