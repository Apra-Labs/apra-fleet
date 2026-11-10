import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { getSelfKbProviders } from '../../src/services/knowledge/kb-self.js';
import { HttpKbProvider } from '../../src/services/knowledge/http-provider.js';
import { encryptPassword } from '../../src/utils/crypto.js';
import { FLEET_DIR } from '../../src/paths.js';
import { kbContext } from '../../src/tools/kb-context.js';

// GitHub #761: confirm the kb_context TOOL path works with the HTTP KB
// provider. tests/knowledge/kb-sqlite-stock-and-http-guard.test.ts and
// http-provider-repository-headers.test.ts call HttpKbProvider.context
// directly; this file drives the real kbContext tool, selected from a real
// http config file, against a real local node:http server. Nothing is mocked.

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

const STUB_RESULTS = [
  { file: 'src/a.ts', status: 'fresh', entry: { id: 'remote-ctx-a', title: 'a.ts summary' } },
  { file: 'src/b.ts', status: 'stale', entry: { id: 'remote-ctx-b', title: 'b.ts summary' } },
  { file: 'src/c.ts', status: 'missing' },
];

let token: string;
let server: http.Server;
let port: number;
let seen: Array<{ method: string; url: string; authorization: string | undefined }> = [];
const tempDirs: string[] = [];

beforeAll(async () => {
  token = loadTestToken();
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization });
      if (req.method === 'GET' && (req.url ?? '').startsWith('/api/kb/context')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results: STUB_RESULTS }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('stub did not bind a TCP port');
  port = address.port;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();
  fs.mkdirSync(KB_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(
    KB_CONFIG_PATH,
    JSON.stringify({ provider: 'http', url: `http://127.0.0.1:${port}`, token_encrypted: encryptPassword(token) }, null, 2),
  );
  seen = [];
});

afterEach(() => {
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();
});

describe('kb_context with the HTTP KB provider (GitHub #761)', () => {
  it('sends GET /api/kb/context with the requested files and returns the server results through the tool output', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-context-http-'));
    tempDirs.push(folder);
    expect((await getSelfKbProviders({ folder })).project).toBeInstanceOf(HttpKbProvider);

    const out = JSON.parse(await kbContext({ files: ['src/a.ts', 'src/b.ts', 'src/c.ts'] }, { folder }));

    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('GET');
    expect(seen[0].authorization).toBe(`Bearer ${token}`);
    const url = new URL(seen[0].url, 'http://stub');
    expect(url.pathname).toBe('/api/kb/context');
    expect(url.searchParams.get('files')).toBe('src/a.ts,src/b.ts,src/c.ts');
    // The tool's default trust filter travels with the request.
    expect(url.searchParams.get('confidence')).toBe('CONFIRMED,INFERRED');
    expect(url.searchParams.get('exclude_disputed')).toBe('true');

    expect(out).toEqual({
      fresh: [STUB_RESULTS[0]],
      stale: [STUB_RESULTS[1]],
      missing: ['src/c.ts'],
    });
  });
});
