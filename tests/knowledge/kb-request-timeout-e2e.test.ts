import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { kbSetup } from '../../src/tools/kb-setup.js';
import { getKbProviders, resetKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { HttpKbProvider } from '../../src/services/knowledge/http-provider.js';
import { FLEET_DIR } from '../../src/paths.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

// End to end: kb_setup request_timeout_ms -> getKbProviders -> real requests to
// a real local node http server. No mocks.
//
// Revert check: in src/services/knowledge/http-provider.ts, replacing
// `req.setTimeout(this.requestTimeoutMs,` with `req.setTimeout(5000,` made
// "request_timeout_ms=1500 times out against a 3 s server" fail (the 1500 ms
// provider got the server's answer instead of queueing the capture); the file
// was restored afterwards.

const configPath = path.join(FLEET_DIR, 'knowledge', 'config.json');
const SERVER_DELAY_MS = 3000;

const tempDirs: string[] = [];
let savedConfig: string | null;
let server: http.Server;
let port: number;
let responseDelayMs = 0;
let seenAuth: (string | undefined)[] = [];

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

async function providerFor(setup: { token?: string; token_command?: string; request_timeout_ms: number }): Promise<HttpKbProvider> {
  resetKbProviders();
  const repoPath = makeTempDir();
  await kbSetup({ provider: 'http', remote: `http://127.0.0.1:${port}`, ...setup }, { folder: repoPath });
  const providers = await getKbProviders(repoPath, `https://example.invalid/kb-timeout-e2e-${crypto.randomUUID()}.git`);
  expect(providers.project).toBeInstanceOf(HttpKbProvider);
  return providers.project as HttpKbProvider;
}

beforeEach(async () => {
  savedConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : null;
  fs.rmSync(configPath, { force: true });
  responseDelayMs = 0;
  seenAuth = [];
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seenAuth.push(req.headers.authorization);
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
  it('request_timeout_ms=1500 times out against a 3 s server; 5000 gets the answer', async () => {
    responseDelayMs = SERVER_DELAY_MS;

    const short = await providerFor({ token: 'static-token', request_timeout_ms: 1500 });
    const queued = await short.capture(makeEntry());
    expect(queued.id).toMatch(/^offline-/);
    expect(short.offlineQueue).toHaveLength(1);

    const long = await providerFor({ token: 'static-token', request_timeout_ms: 5000 });
    const answered = await long.capture(makeEntry());
    expect(answered.id).toBe('server-id');
    expect(long.offlineQueue).toHaveLength(0);
  }, 20000);

  it('a slow token command does not consume the request timeout', async () => {
    const command = `node -e "setTimeout(()=>console.log('tok-slow'),2000)"`;
    const provider = await providerFor({ token_command: command, request_timeout_ms: 1500 });
    const started = Date.now();
    await provider.query({ query: 'anything' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
    expect(seenAuth).toEqual(['Bearer tok-slow']);
  }, 20000);
});
