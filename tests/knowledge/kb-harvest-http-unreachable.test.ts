import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { encryptPassword } from '../../src/utils/crypto.js';
import { FLEET_DIR } from '../../src/paths.js';
import { kbHarvest } from '../../src/tools/kb-harvest.js';

// kb_harvest over an http project KB whose server is down. The provider
// queues nothing, so a failed capture is lost unless the harvest finishes its
// loop and reports it: every learning is attempted, each failure is counted
// (entries_failed), and the call itself does not throw. Then the server comes
// back on the same port and a second harvest of the same transcript lands all
// three, so the count is the caller's cue to repeat it.
//
// The server is a real in-process node:http server (no mocks); the KB config
// is the real config file read by the real provider selection.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_ENV_VAR = 'APRA_FLEET_TEST_KB_HTTP_TOKEN';
const TOKEN_FIXTURE_PATH = path.join(__dirname, 'fixtures', 'kb-http-test-token.txt');

function loadTestToken(): string {
  const fromEnv = process.env[TOKEN_ENV_VAR];
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  if (fs.existsSync(TOKEN_FIXTURE_PATH)) {
    const fromFile = fs.readFileSync(TOKEN_FIXTURE_PATH, 'utf-8').trim();
    if (fromFile.length > 0) return fromFile;
  }
  throw new Error(`Missing test KB token: set ${TOKEN_ENV_VAR} or provide a non-empty ${TOKEN_FIXTURE_PATH}`);
}

const KB_CONFIG_DIR = path.join(FLEET_DIR, 'knowledge');
const KB_CONFIG_PATH = path.join(KB_CONFIG_DIR, 'config.json');

// Three distinct learnings, one per marker family harvest extracts.
const TRANSCRIPT = [
  'Working on the widget pipeline.',
  '',
  'I found that the widget cache in src/widget-cache.ts is keyed per tenant, so tenants never share a hit.',
  '',
  'The root cause was the batch flusher in src/batch.ts not running before shutdown, so pending widgets were lost.',
  '',
  'Key insight: the retry helper in src/retry.ts doubles the delay twice when the first attempt times out.',
  '',
].join('\n');

let token: string;
let port = 0;
let server: http.Server | undefined;
let captured: string[] = [];

function startServer(): Promise<void> {
  const s = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => { raw += c.toString(); });
    req.on('end', () => {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      if (req.url === '/api/kb/capture' && req.method === 'POST') {
        captured.push((JSON.parse(raw) as { title: string }).title);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: `srv-${captured.length}`, audn_decision: 'add' }));
        return;
      }
      // No capabilities route: the pre-capabilities route set (capture included).
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found', code: 'NOT_FOUND' }));
    });
  });
  server = s;
  return new Promise<void>((resolve, reject) => {
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => {
      port = (s.address() as { port: number }).port;
      resolve();
    });
  });
}

function stopServer(): Promise<void> {
  const s = server;
  server = undefined;
  if (!s) return Promise.resolve();
  return new Promise<void>(resolve => {
    s.close(() => resolve());
    s.closeAllConnections();
  });
}

const tempDirs: string[] = [];

beforeAll(async () => {
  token = loadTestToken();
  // Bind once to learn a free port, then stop: the test starts with the server down.
  await startServer();
  await stopServer();
});

beforeEach(() => {
  captured = [];
  fs.mkdirSync(KB_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(
    KB_CONFIG_PATH,
    JSON.stringify({ provider: 'http', url: `http://127.0.0.1:${port}`, token_encrypted: encryptPassword(token) }, null, 2),
  );
  resetKbProviders();
});

afterEach(async () => {
  await stopServer();
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();
});

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('kb_harvest with the KB server down', () => {
  it('attempts all three learnings, counts three failures, and does not throw; repeated once the server is back, all three land', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-harvest-http-'));
    tempDirs.push(folder);

    const down = JSON.parse(await kbHarvest({ session_transcript: TRANSCRIPT }, { folder }));
    expect(down).toEqual({
      entries_captured: 0, entries_updated: 0, entries_skipped: 0, entries_rejected: 0, entries_failed: 3,
    });

    await startServer();
    const up = JSON.parse(await kbHarvest({ session_transcript: TRANSCRIPT }, { folder }));
    expect(up).toEqual({
      entries_captured: 3, entries_updated: 0, entries_skipped: 0, entries_rejected: 0, entries_failed: 0,
    });
    expect(captured).toHaveLength(3);
  });
});
