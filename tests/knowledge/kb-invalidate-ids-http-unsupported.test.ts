import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { kbSetup } from '../../src/tools/kb-setup.js';
import { kbInvalidate } from '../../src/tools/kb-invalidate.js';
import { getKbProviders, resetKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { HttpKbProvider } from '../../src/services/knowledge/http-provider.js';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { FLEET_DIR } from '../../src/paths.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

// kb_invalidate {ids} under the http KB provider is a typed refusal. Real
// kb_setup, real HttpKbProvider / SqliteProvider selected through
// getKbProviders, and a real local node http server standing in for the KB
// endpoint. No mocks.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TAXONOMY_PATH = path.join(__dirname, '..', '..', 'memory-contract', 'v1', 'taxonomy.json');

// Same token source as kb-http-provider-e2e.test.ts: env var, else a committed
// deliberately-fake fixture file; fail fast naming the key otherwise.
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

const KB_CONFIG_PATH = path.join(FLEET_DIR, 'knowledge', 'config.json');

function entryInput(title: string): KBEntryInput {
  return {
    type: 'knowledge',
    title,
    summary: `Summary of ${title}`,
    content: `Content body of ${title}.`,
    source_files: ['fixture.ts'],
    symbols: [`sym${title}`],
    tags: [],
    content_hash: '',
    content_hash_type: 'sha256',
    flagged_for_review: false,
    author: 'test-agent',
    source: 'doer',
    confidence: 'INFERRED',
  };
}

function supersededCount(sqlite: SqliteProvider): number {
  const row = (sqlite as unknown as { getDb(): { prepare(sql: string): { get(): { n: number } } } })
    .getDb().prepare('SELECT COUNT(*) AS n FROM entries WHERE superseded_at IS NOT NULL').get();
  return row.n;
}

let server: http.Server;
let port: number;
let requestCount = 0;
let token: string;
let folder: string;
let remoteUrl: string;

beforeAll(async () => {
  token = loadTestToken();
  server = http.createServer((req, res) => {
    requestCount += 1;
    req.resume();
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('kb-invalidate-ids-http-unsupported: server did not bind a TCP port');
  port = address.port;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();
  requestCount = 0;
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-invalidate-http-'));
  fs.writeFileSync(path.join(folder, 'fixture.ts'), '// fixture cited by captured entries\n');
  remoteUrl = `https://example.invalid/kb-invalidate-http-${crypto.randomUUID()}.git`;
});

afterEach(() => {
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();
  fs.rmSync(folder, { recursive: true, force: true });
});

describe('kb_invalidate {ids} under the http KB provider', () => {
  it('rejects with the typed E-KB-HTTP-UNSUPPORTED error and discards nothing, remotely or locally', async () => {
    await kbSetup({ provider: 'http', remote: `http://127.0.0.1:${port}`, token }, { folder });
    const providers = await getKbProviders(folder, remoteUrl);
    expect(providers.project).toBeInstanceOf(HttpKbProvider);
    const fallback = (providers.project as unknown as { fallback: SqliteProvider }).fallback;
    const { id } = await fallback.capture(entryInput('HttpDiscardRefused'));
    const requestsBefore = requestCount;

    const err = await kbInvalidate({ ids: [id] }, { folder, remoteUrl }).then(
      () => { throw new Error('expected kbInvalidate to reject under the http provider'); },
      (e: unknown) => e as Error & { code?: string },
    );

    expect(err.code).toBe('E-KB-HTTP-UNSUPPORTED');
    expect(err.message.startsWith('E-KB-HTTP-UNSUPPORTED: ')).toBe(true);
    expect(err.message).toContain('id-level discard');
    expect(requestCount).toBe(requestsBefore);
    expect(supersededCount(fallback)).toBe(0);
  });
});

describe('kb_invalidate {ids} under the sqlite KB provider is unchanged', () => {
  it('discards the entry: it is reported in discarded and drops out of kb_query', async () => {
    await kbSetup({ provider: 'sqlite' }, { folder });
    const providers = await getKbProviders(folder, remoteUrl);
    expect(providers.project).toBeInstanceOf(SqliteProvider);
    const sqlite = providers.project as SqliteProvider;
    const { id } = await sqlite.capture(entryInput('SqliteDiscardStillWorks'));
    expect((await sqlite.query({ query: 'SqliteDiscardStillWorks' })).results.some(e => e.id === id)).toBe(true);

    const result = JSON.parse(await kbInvalidate({ ids: [id] }, { folder, remoteUrl }));

    expect(result.discarded).toEqual([id]);
    expect((await sqlite.query({ query: 'SqliteDiscardStillWorks' })).results.some(e => e.id === id)).toBe(false);
    expect(supersededCount(sqlite)).toBe(1);
  });
});

describe('memory contract taxonomy', () => {
  it('registers E-KB-HTTP-UNSUPPORTED (read from the real taxonomy.json)', () => {
    const taxonomy = JSON.parse(fs.readFileSync(TAXONOMY_PATH, 'utf-8')) as {
      groups: Record<string, { codes: Array<{ code: string; $anchor: string }> }>;
    };
    const codes = Object.values(taxonomy.groups).flatMap(g => g.codes);
    const entry = codes.find(c => c.code === 'E-KB-HTTP-UNSUPPORTED');
    expect(entry).toBeDefined();
    expect(entry!.$anchor).toBe('E-KB-HTTP-UNSUPPORTED');
  });
});
