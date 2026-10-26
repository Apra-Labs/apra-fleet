import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { kbSetup } from '../../src/tools/kb-setup.js';
import { getKbProviders, resetKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { HttpKbProvider, DEFAULT_REQUEST_TIMEOUT_MS } from '../../src/services/knowledge/http-provider.js';
import { FLEET_DIR } from '../../src/paths.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

// End to end: kb_setup request_timeout_ms -> getKbProviders -> real requests to
// a real local node:http server that delays its response. No mocks.

const configPath = path.join(FLEET_DIR, 'knowledge', 'config.json');

const tempDirs: string[] = [];
let savedConfig: string | null;
let server: http.Server;
let port: number;
let responseDelayMs = 0;

// The private request method, reached through a cast so the typed timeout
// error can be asserted directly: every public method deliberately turns a
// timeout into offline-queue or local-fallback behaviour.
type RawRequest = (method: string, pathname: string, body?: unknown) => Promise<unknown>;
function rawRequestOf(provider: HttpKbProvider): RawRequest {
  const raw = (provider as unknown as { rawRequest: RawRequest }).rawRequest;
  return raw.bind(provider);
}

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-timeout-e2e-'));
  tempDirs.push(dir);
  return dir;
}

function makeEntry(): KBEntryInput {
  return {
    type: 'knowledge',
    title: 'kb-request-timeout-e2e entry',
    summary: 'Entry captured to prove the configured request timeout is applied.',
    content: 'kb-request-timeout-e2e content.',
    source_files: [],
    symbols: ['kbRequestTimeoutE2e'],
    tags: [],
    content_hash: '',
    content_hash_type: 'sha256',
    flagged_for_review: false,
    author: 'doer',
    source: 'session',
    confidence: 'INFERRED',
  };
}

async function providerFor(requestTimeoutMs?: number): Promise<HttpKbProvider> {
  resetKbProviders();
  const repoPath = makeTempDir();
  const timeoutField = requestTimeoutMs === undefined ? {} : { request_timeout_ms: requestTimeoutMs };
  await kbSetup(
    { provider: 'http', remote: `http://127.0.0.1:${port}`, token: 'static-token', ...timeoutField },
    { folder: repoPath },
  );
  const providers = await getKbProviders(repoPath, `https://example.invalid/kb-timeout-e2e-${crypto.randomUUID()}.git`);
  expect(providers.project).toBeInstanceOf(HttpKbProvider);
  return providers.project as HttpKbProvider;
}

async function expectTimeout(provider: HttpKbProvider, timeoutMs: number): Promise<number> {
  const started = Date.now();
  await expect(rawRequestOf(provider)('POST', '/api/kb/capture', makeEntry())).rejects.toMatchObject({
    code: 'ETIMEDOUT',
    message: `ETIMEDOUT: KB server request timed out after ${timeoutMs} ms`,
  });
  return Date.now() - started;
}

beforeEach(async () => {
  savedConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : null;
  fs.rmSync(configPath, { force: true });
  responseDelayMs = 0;
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(req.url?.startsWith('/api/kb/capture')
          ? { id: 'server-id', audn_decision: 'add' }
          : { l1_results: [], l2_expanded: [] }));
      }, responseDelayMs);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  resetKbProviders();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (savedConfig === null) fs.rmSync(configPath, { force: true });
  else fs.writeFileSync(configPath, savedConfig);
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('request_timeout_ms end to end', () => {
  it('a request slower than request_timeout_ms fails with ETIMEDOUT naming the timeout', async () => {
    responseDelayMs = 3000;
    const provider = await providerFor(1500);
    const elapsed = await expectTimeout(provider, 1500);
    expect(elapsed).toBeGreaterThanOrEqual(1400);
    expect(elapsed).toBeLessThan(2900);
  }, 20000);

  it('request_timeout_ms=1500 queues the capture offline against a 3 s server; 5000 gets the answer', async () => {
    responseDelayMs = 3000;

    const short = await providerFor(1500);
    const queued = await short.capture(makeEntry());
    expect(queued.id).toMatch(/^offline-/);
    expect(short.offlineQueue).toHaveLength(1);

    const long = await providerFor(5000);
    const answered = await long.capture(makeEntry());
    expect(answered.id).toBe('server-id');
    expect(long.offlineQueue).toHaveLength(0);
  }, 20000);

  it('applies the 5000 ms default when request_timeout_ms is unset', async () => {
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(5000);
    responseDelayMs = 8000;
    const provider = await providerFor();
    const elapsed = await expectTimeout(provider, DEFAULT_REQUEST_TIMEOUT_MS);
    expect(elapsed).toBeGreaterThanOrEqual(4900);
    expect(elapsed).toBeLessThan(7500);
  }, 20000);
});
