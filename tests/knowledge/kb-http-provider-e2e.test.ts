import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { kbSetup } from '../../src/tools/kb-setup.js';
import { getKbProviders, resetKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { HttpKbProvider } from '../../src/services/knowledge/http-provider.js';
import { FLEET_DIR } from '../../src/paths.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

// my-beads-db-0cd.7: end-to-end verification that a STOCK build, configured
// only through the real kb_setup tool, reaches a remote KB server. No mocks,
// stubs or fake provider classes anywhere in this file -- real kb_setup, real
// HttpKbProvider, real SqliteProvider, and a real local node http server
// standing in for the KB endpoint.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// CLAUDE.md testing rule: never hardcode a token literal in test source. Read
// it from an environment variable, falling back to a committed fixture file
// whose value is deliberately fake (obviously not a real credential -- see
// tests/knowledge/fixtures/kb-http-test-token.txt) so `npm test` stays green
// on a machine that has never set the env var. Fails fast, naming the missing
// key, only if neither source provides a value.
const TOKEN_ENV_VAR = 'APRA_FLEET_TEST_KB_HTTP_TOKEN';
const TOKEN_FIXTURE_PATH = path.join(__dirname, 'fixtures', 'kb-http-test-token.txt');

function loadTestToken(): string {
  const fromEnv = process.env[TOKEN_ENV_VAR];
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  if (fs.existsSync(TOKEN_FIXTURE_PATH)) {
    const fromFile = fs.readFileSync(TOKEN_FIXTURE_PATH, 'utf-8').trim();
    if (fromFile.length > 0) return fromFile;
  }
  throw new Error(
    `Missing test KB token: set ${TOKEN_ENV_VAR} or provide a non-empty ${TOKEN_FIXTURE_PATH}`,
  );
}

const KB_CONFIG_DIR = path.join(FLEET_DIR, 'knowledge');
const KB_CONFIG_PATH = path.join(KB_CONFIG_DIR, 'config.json');

// `fallback` is private on HttpKbProvider -- reading it through a cast is how
// this suite proves the fallback is the project SqliteProvider getKbProviders
// built. getKbProviders never exposes that instance directly (confirmed KB
// entry: tests/knowledge/kb-providers-http-selection.test.ts), so identity is
// asserted via the repoPath/dbPath discriminator instead of a direct `===`.
function fallbackOf(provider: HttpKbProvider): SqliteProvider {
  return (provider as unknown as { fallback: SqliteProvider }).fallback;
}

function makeEntry(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'knowledge',
    title: 'kb-http-provider-e2e entry',
    summary: 'Entry captured through a real HttpKbProvider reached via kb_setup.',
    content: 'kb-http-provider-e2e content.',
    source_files: [],
    symbols: ['kbHttpProviderE2e'],
    tags: [],
    content_hash: '',
    content_hash_type: 'sha256',
    flagged_for_review: false,
    author: 'doer',
    source: 'session',
    confidence: 'INFERRED',
    ...overrides,
  };
}

const tempDirs: string[] = [];

function makeRepoPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-http-e2e-'));
  tempDirs.push(dir);
  return dir;
}

let server: http.Server;
let port: number;
let capturedBodies: KBEntryInput[] = [];
let capturedAuthHeaders: (string | undefined)[] = [];
let token: string;

beforeAll(async () => {
  token = loadTestToken();
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      capturedAuthHeaders.push(req.headers.authorization);
      if (req.url === '/api/kb/capture' && req.method === 'POST') {
        capturedBodies.push(JSON.parse(body) as KBEntryInput);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'kb-http-e2e-server-id', audn_decision: 'add' }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('kb-http-provider-e2e: server did not bind to a TCP port');
  }
  port = address.port;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();
  capturedBodies = [];
  capturedAuthHeaders = [];
});

afterEach(() => {
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();
});

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('kb_setup selects the http provider, reachable from getKbProviders (my-beads-db-0cd.7)', () => {
  it('kb_setup + getKbProviders yields an HttpKbProvider that reaches the real server, with the project SqliteProvider as its fallback', async () => {
    const repoPath = makeRepoPath();
    const remoteUrl = `https://example.invalid/kb-http-e2e-${crypto.randomUUID()}.git`;
    const remote = `http://127.0.0.1:${port}`;

    const setupResult = JSON.parse(await kbSetup({ repo_path: repoPath, provider: 'http', remote, token }));
    expect(setupResult.success).toBe(true);
    expect(fs.existsSync(KB_CONFIG_PATH)).toBe(true);

    // Criterion 1: getKbProviders returns an HttpKbProvider as project.
    const providers = await getKbProviders(repoPath, remoteUrl);
    expect(providers.project).toBeInstanceOf(HttpKbProvider);

    // Criterion 6: global stays SqliteProvider, projectSlug behaves normally.
    expect(providers.global).toBeInstanceOf(SqliteProvider);
    expect(providers.global).not.toBeInstanceOf(HttpKbProvider);
    expect(typeof providers.projectSlug).toBe('string');
    expect(providers.projectSlug.length).toBeGreaterThan(0);

    // Criterion 2: fallback is the SAME SqliteProvider instance getKbProviders
    // built for this (slug, repoPath) -- asserted via the repoPath/dbPath
    // discriminator (see fallbackOf's doc comment above).
    const fallback = fallbackOf(providers.project as HttpKbProvider);
    expect(fallback).toBeInstanceOf(SqliteProvider);
    expect(fallback.repoPath).toBe(repoPath);
    expect(fallback.dbPath).toBe(path.join(FLEET_DIR, 'knowledge', providers.projectSlug, 'kb.sqlite'));

    // Criterion 1 (continued): a capture through the returned provider produces
    // a real HTTP request observed by the local test server -- proving the
    // request left the process rather than landing in sqlite.
    const captureResult = await providers.project.capture(makeEntry());
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].title).toBe('kb-http-provider-e2e entry');
    expect(capturedAuthHeaders[0]).toBe(`Bearer ${token}`);
    expect(captureResult.id).toBe('kb-http-e2e-server-id');

    // No sqlite file was written by that capture (it went to the server, not
    // the fallback) -- the fallback's db file gets created by init(), not by
    // a remote-routed capture.
    expect(fs.existsSync(fallback.dbPath)).toBe(true); // created by createKbProvidersForSlug's init()
  });

  it('resetKbProviders removes the beforeExit listener the HTTP project provider registered', async () => {
    const repoPath = makeRepoPath();
    const remoteUrl = `https://example.invalid/kb-http-e2e-${crypto.randomUUID()}.git`;
    await kbSetup({ repo_path: repoPath, provider: 'http', remote: `http://127.0.0.1:${port}`, token });

    const baseline = process.listenerCount('beforeExit');
    const providers = await getKbProviders(repoPath, remoteUrl);
    expect(providers.project).toBeInstanceOf(HttpKbProvider);
    expect(process.listenerCount('beforeExit')).toBe(baseline + 1);

    resetKbProviders();
    expect(process.listenerCount('beforeExit')).toBe(baseline);
  });

  it('repeated setup/reset cycles emit no MaxListenersExceededWarning', async () => {
    const warnings: unknown[] = [];
    const onWarning = (w: unknown) => warnings.push(w);
    process.on('warning', onWarning);

    try {
      const repoPath = makeRepoPath();
      const remoteUrl = `https://example.invalid/kb-http-e2e-${crypto.randomUUID()}.git`;
      await kbSetup({ repo_path: repoPath, provider: 'http', remote: `http://127.0.0.1:${port}`, token });

      const baseline = process.listenerCount('beforeExit');
      for (let i = 0; i < 15; i++) {
        const providers = await getKbProviders(repoPath, remoteUrl);
        expect(providers.project).toBeInstanceOf(HttpKbProvider);
        resetKbProviders();
      }
      expect(process.listenerCount('beforeExit')).toBe(baseline);
    } finally {
      process.removeListener('warning', onWarning);
    }

    const maxListenersWarnings = warnings.filter(
      w => w instanceof Error && w.name === 'MaxListenersExceededWarning',
    );
    expect(maxListenersWarnings).toHaveLength(0);
  });

  it('no sqlite database file is created outside the temporary FLEET_DIR used by the test', async () => {
    // Snapshot every location a no-arg `new SqliteProvider()` (the exact hole
    // this bead's parent guards against, http-provider.ts:52) would write a
    // stray kb.sqlite to: the repo root and the current process.cwd(). Both
    // are provably distinct from FLEET_DIR (a per-run tmpdir, tests/setup.ts).
    const repoRoot = path.resolve(__dirname, '..', '..');
    const cwd = process.cwd();
    const suspectDirs = Array.from(new Set([repoRoot, cwd]));

    function snapshotSqliteFiles(dir: string): string[] {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).filter(name => name.endsWith('.sqlite'));
    }

    const before = suspectDirs.map(snapshotSqliteFiles);

    const repoPath = makeRepoPath();
    const remoteUrl = `https://example.invalid/kb-http-e2e-${crypto.randomUUID()}.git`;
    await kbSetup({ repo_path: repoPath, provider: 'http', remote: `http://127.0.0.1:${port}`, token });
    const providers = await getKbProviders(repoPath, remoteUrl);
    await providers.project.capture(makeEntry({ symbols: ['kbHttpProviderE2eNoStray'] }));

    const after = suspectDirs.map(snapshotSqliteFiles);

    suspectDirs.forEach((dir, i) => {
      expect(after[i], `no new .sqlite files should appear in ${dir}`).toEqual(before[i]);
    });

    // Positive control: the fallback's db file DOES land inside FLEET_DIR.
    const fallback = fallbackOf(providers.project as HttpKbProvider);
    expect(fallback.dbPath.startsWith(FLEET_DIR)).toBe(true);
  });
});
