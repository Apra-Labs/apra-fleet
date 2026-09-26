import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getKbProviders, resetKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { HttpKbProvider } from '../../src/services/knowledge/http-provider.js';
import { encryptPassword } from '../../src/utils/crypto.js';
import { FLEET_DIR } from '../../src/paths.js';
import { kbList } from '../../src/tools/kb-list.js';
import { kbFeedback } from '../../src/tools/kb-feedback.js';
import { kbFreshnessSweep } from '../../src/tools/kb-freshness-sweep.js';
import { kbReconcilePrefilter } from '../../src/tools/kb-reconcile-prefilter.js';
import { kbResolveContradiction } from '../../src/tools/kb-resolve-contradiction.js';
import { kbImport } from '../../src/tools/kb-import.js';
import { kbExport } from '../../src/tools/kb-export.js';
import { kbStats } from '../../src/tools/kb-stats.js';
import { runKbDirectives } from '../../src/cli/kb-directives.js';
import { kbCapture } from '../../src/tools/kb-capture.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

// my-beads-db-0cd.8: the negative half of the http-provider-selection
// verification -- the stock local (sqlite) path must stay byte-identical, and
// every SqliteProvider-only tool must fail FAST and NAMED when the project
// KB is backed by a remote HTTP provider (kb_stats is the deliberate
// exception -- it degrades to a non-computable bible block instead).
//
// Criterion 3 was rewritten 2026-09-17 (see bd notes for my-beads-db-0cd.8)
// after a CRITERIA-DEFECT report: the original wording demanded getKbProviders
// THROW on an http-selecting config missing its url/token, which contradicts
// the PARENT bead's own criterion 1 ("returns SqliteProvider unchanged ...
// including missing/malformed config") and bead .12 (closed, commit
// 51e3baa7), which deliberately shipped the degrade-with-warning behaviour.
// The corrected criterion 3 requires the opposite of the original wording: a
// config missing url, and separately one missing token_encrypted, must
// DEGRADE to SqliteProvider with a one-time warning naming the offending key,
// while readKbConfigFromDisk itself still throws on both in isolation. Both
// halves, for both missing keys, are asserted together in
// tests/knowledge/kb-providers-http-selection.test.ts (the
// "provider \"http\" missing url" / "missing token_encrypted" tests in the
// my-beads-db-0cd.12 describe block) -- this file does not duplicate that
// coverage, per criterion 3's own instruction to cite rather than re-copy.

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
  throw new Error(
    `Missing test KB token: set ${TOKEN_ENV_VAR} or provide a non-empty ${TOKEN_FIXTURE_PATH}`,
  );
}

const KB_CONFIG_DIR = path.join(FLEET_DIR, 'knowledge');
const KB_CONFIG_PATH = path.join(KB_CONFIG_DIR, 'config.json');

function writeSqliteConfigWithCorruptToken(): void {
  fs.mkdirSync(KB_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(
    KB_CONFIG_PATH,
    JSON.stringify({ provider: 'sqlite', token_encrypted: 'not-a-valid-encrypted-blob' }, null, 2),
  );
}

let token: string;
let remote: string;

function writeHttpConfig(): void {
  fs.mkdirSync(KB_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(
    KB_CONFIG_PATH,
    JSON.stringify({ provider: 'http', url: remote, token_encrypted: encryptPassword(token) }, null, 2),
  );
}

const tempDirs: string[] = [];

function makeRepoPath(withFixture = true): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-sqlite-http-guard-'));
  tempDirs.push(dir);
  if (withFixture) {
    fs.writeFileSync(path.join(dir, 'fixture.ts'), '// kb-sqlite-http-guard fixture\n');
  }
  return dir;
}

function seedEntry(overrides: Partial<KBEntryInput> & { symbols: string[] }): KBEntryInput {
  return {
    type: 'knowledge',
    title: 'seed title',
    summary: 'seed summary',
    content: 'seed content',
    source_files: ['fixture.ts'],
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

beforeEach(() => {
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();
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

describe('sqlite path stays byte-identical (my-beads-db-0cd.8 criterion 1-2)', () => {
  it('no config file: getKbProviders returns SqliteProvider, capture+query round-trips, db lands at the same slug-derived path', async () => {
    expect(fs.existsSync(KB_CONFIG_PATH)).toBe(false);
    const repoPath = makeRepoPath();
    const remoteUrl = `https://example.invalid/kb-sqlite-stock-${crypto.randomUUID()}.git`;

    const providers = await getKbProviders(repoPath, remoteUrl);
    expect(providers.project).toBeInstanceOf(SqliteProvider);
    expect(providers.project).not.toBeInstanceOf(HttpKbProvider);
    expect((providers.project as SqliteProvider).dbPath).toBe(
      path.join(FLEET_DIR, 'knowledge', providers.projectSlug, 'kb.sqlite'),
    );

    const { id } = await providers.project.capture(seedEntry({ symbols: ['sqliteStockRoundTrip'] }));
    const result = await providers.project.query({ query: 'seed title' });
    expect(result.results.some(e => e.id === id)).toBe(true);
  });

  it('config selecting sqlite with a corrupt, undecryptable token_encrypted: capture+query still succeed, with no console.error warning', async () => {
    writeSqliteConfigWithCorruptToken();
    const repoPath = makeRepoPath();
    const remoteUrl = `https://example.invalid/kb-sqlite-corrupt-token-${crypto.randomUUID()}.git`;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const providers = await getKbProviders(repoPath, remoteUrl);
      expect(providers.project).toBeInstanceOf(SqliteProvider);
      expect(providers.project).not.toBeInstanceOf(HttpKbProvider);

      const { id } = await providers.project.capture(seedEntry({ symbols: ['sqliteCorruptTokenRoundTrip'] }));
      const result = await providers.project.query({ query: 'seed title' });
      expect(result.results.some(e => e.id === id)).toBe(true);

      // This is the assertion that distinguishes "works by design" (the
      // provider!=='http' early return in readKbConfigFromDisk, which never
      // touches token_encrypted) from "works by accident" (selectProjectProvider's
      // catch-and-degrade path for a genuinely malformed config, which DOES warn).
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('user-directive capture on a sqlite-configured host is unchanged: still downgraded to UNVERIFIED/flagged/tagged (my-beads-db-0cd.14 criterion 3)', async () => {
    expect(fs.existsSync(KB_CONFIG_PATH)).toBe(false);
    const repoPath = makeRepoPath();
    const remoteUrl = `https://example.invalid/kb-sqlite-directive-${crypto.randomUUID()}.git`;

    const providers = await getKbProviders(repoPath, remoteUrl);
    expect(providers.project).toBeInstanceOf(SqliteProvider);

    const out = JSON.parse(await kbCapture({
      repo_path: repoPath,
      repo_remote_url: remoteUrl,
      type: 'user-directive',
      title: 'sqlite directive unchanged',
      summary: 'proves the fix did not move the choke point',
      content: 'The user said: never force-push to main.',
      confidence: 'CONFIRMED', // attempt to smuggle an active directive
    } as any));

    const entry = (await providers.project.query({ ids: [out.id] })).results[0];
    expect(entry.confidence).toBe('UNVERIFIED');
    expect(entry.flagged_for_review).toBe(true);
    expect(entry.tags).toContain('directive:pending');
    expect(entry.scope).toBe('project');
  });
});

describe('eight SqliteProvider-only entrypoints fail fast and named under an http config (my-beads-db-0cd.8 criterion 4)', () => {
  beforeAll(() => {
    token = loadTestToken();
    remote = 'http://127.0.0.1:1'; // never dialed: every entrypoint below must throw before any network call
  });

  beforeEach(() => {
    writeHttpConfig();
  });

  const REFUSAL_SUFFIX = 'this operation is not supported when the KB is backed by a remote HTTP provider';

  it('kb_list', async () => {
    await expect(kbList({ repo_path: makeRepoPath() } as any)).rejects.toThrow(`kb_list: ${REFUSAL_SUFFIX}`);
  });

  it('kb_feedback', async () => {
    await expect(
      kbFeedback({ repo_path: makeRepoPath(), id: 'anything', reason: 'x' } as any),
    ).rejects.toThrow(`kb_feedback: ${REFUSAL_SUFFIX}`);
  });

  it('kb_freshness_sweep', async () => {
    await expect(kbFreshnessSweep({ repo_path: makeRepoPath() } as any)).rejects.toThrow(
      `kb_freshness_sweep: ${REFUSAL_SUFFIX}`,
    );
  });

  it('kb_reconcile_prefilter', async () => {
    await expect(kbReconcilePrefilter({ repo_path: makeRepoPath() } as any)).rejects.toThrow(
      `kb_reconcile_prefilter: ${REFUSAL_SUFFIX}`,
    );
  });

  it('kb_resolve_contradiction', async () => {
    await expect(
      kbResolveContradiction({ repo_path: makeRepoPath(), winnerId: 'w', loserId: 'l', evidence: 'e' } as any),
    ).rejects.toThrow(`kb_resolve_contradiction: ${REFUSAL_SUFFIX}`);
  });

  it('kb_import', async () => {
    const importDir = makeRepoPath();
    fs.mkdirSync(path.join(importDir, '.fleet'), { recursive: true });
    fs.writeFileSync(path.join(importDir, '.fleet', 'kb-canonical.json'), '[]');
    await expect(kbImport({ repo_path: importDir } as any)).rejects.toThrow(`kb_import: ${REFUSAL_SUFFIX}`);
  });

  it('kb_export', async () => {
    await expect(kbExport({ repo_path: makeRepoPath() } as any)).rejects.toThrow(`kb_export: ${REFUSAL_SUFFIX}`);
  });

  it('kb_directives CLI (list subcommand)', async () => {
    await expect(runKbDirectives('directives', [])).rejects.toThrow(`kb_directives: ${REFUSAL_SUFFIX}`);
  });
});

describe('kb_stats is the deliberate exception: returns a not-computable bible instead of throwing (my-beads-db-0cd.8 criterion 5)', () => {
  beforeAll(() => {
    token = loadTestToken();
    remote = 'http://127.0.0.1:1'; // never dialed: stats() never contacts the remote server
  });

  beforeEach(() => {
    writeHttpConfig();
  });

  it('kb_stats returns supported:false and bible.computable:false, never throws, never reports a bare 0 drift', async () => {
    const repoPath = makeRepoPath();
    await expect(kbStats({ repo_path: repoPath } as any)).resolves.toBeTypeOf('string');

    const raw = await kbStats({ repo_path: repoPath } as any);
    const parsed = JSON.parse(raw);

    expect(parsed.supported).toBe(false);
    expect(parsed.bible).toEqual({
      computable: false,
      reason: 'bible drift is not computable over a remote HTTP provider',
    });
    // Distinguishing check: a 0 in `drift` is indistinguishable from an
    // up-to-date bible, so the shape must be the `computable:false` variant,
    // never `{ present, entries, drift: 0 }`.
    expect(parsed.bible.drift).toBeUndefined();
  });
});

describe('operations MemorEYES X-1 depends on work over http: capture, query, context, prime, promote (my-beads-db-0cd.8 criterion 6)', () => {
  let server: http.Server;
  let port: number;
  // my-beads-db-0cd.14 criterion 2: this mock server is deliberately NOT a
  // fleet SqliteProvider -- it is a plain http.Server that echoes success. It
  // records the raw JSON body of the last /api/kb/capture POST so tests can
  // assert on the outgoing payload directly, proving the downgrade happened
  // on OUR side (the handler) before the request left the process, not
  // because the remote happened to enforce it.
  let lastCaptureBody: Record<string, unknown> | null = null;

  beforeAll(async () => {
    token = loadTestToken();
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        const url = req.url ?? '';
        const method = req.method ?? 'GET';
        if (url === '/api/kb/capture' && method === 'POST') {
          lastCaptureBody = JSON.parse(body);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: 'guard-e2e-server-id', audn_decision: 'add' }));
        } else if (url.startsWith('/api/kb/query') && method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ results: [], total: 0, l1_only: false }));
        } else if (url.startsWith('/api/kb/context') && method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ results: [{ file: 'src/fixture.ts', status: 'fresh' }] }));
        } else if (url === '/api/kb/prime' && method === 'POST') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            session_warm: true,
            stale_files: [],
            top_entries: [],
            fresh_summaries: [],
            recommended_code_calls: [],
            token_estimate: 0,
          }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
        }
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('kb-sqlite-stock-and-http-guard: server did not bind to a TCP port');
    }
    port = address.port;
    remote = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  beforeEach(() => {
    writeHttpConfig();
    lastCaptureBody = null;
  });

  it('user-directive capture over http is quarantined before it reaches the remote: UNVERIFIED, flagged, tagged (my-beads-db-0cd.14 criteria 1-2, 4)', async () => {
    const repoPath = makeRepoPath();
    const remoteUrl = `https://example.invalid/kb-http-directive-${crypto.randomUUID()}.git`;
    const providers = await getKbProviders(repoPath, remoteUrl);
    expect(providers.project).toBeInstanceOf(HttpKbProvider);

    const out = JSON.parse(await kbCapture({
      repo_path: repoPath,
      repo_remote_url: remoteUrl,
      type: 'user-directive',
      title: 'http directive quarantine',
      summary: 'proves the handler downgrades before the POST, not the remote',
      content: 'The user said: never force-push to main.',
      confidence: 'CONFIRMED', // attempt to smuggle an active directive over the wire
    } as any));
    expect(out.id).toBe('guard-e2e-server-id');

    // The assertion that matters: the mock remote above is a plain http.Server,
    // NOT a fleet SqliteProvider, so if this payload were ever
    // confidence=INFERRED / flagged_for_review=false, nothing on the remote
    // side would have caught or corrected it.
    expect(lastCaptureBody).not.toBeNull();
    expect(lastCaptureBody?.confidence).toBe('UNVERIFIED');
    expect(lastCaptureBody?.flagged_for_review).toBe(true);
    expect(lastCaptureBody?.tags).toContain('directive:pending');
    expect(lastCaptureBody?.scope).toBe('project');
  });

  it('capture, query, context, and prime reach the remote server and do not raise', async () => {
    const repoPath = makeRepoPath();
    const remoteUrl = `https://example.invalid/kb-http-ops-${crypto.randomUUID()}.git`;
    const providers = await getKbProviders(repoPath, remoteUrl);
    expect(providers.project).toBeInstanceOf(HttpKbProvider);

    await expect(providers.project.capture(seedEntry({ symbols: ['httpOpsCapture'] }))).resolves.toMatchObject({
      id: 'guard-e2e-server-id',
      audn_decision: 'add',
    });
    await expect(providers.project.query({ query: 'anything' })).resolves.toEqual({
      results: [], total: 0, l1_only: false,
    });
    await expect(providers.project.context(['src/fixture.ts'])).resolves.toEqual([
      { file: 'src/fixture.ts', status: 'fresh' },
    ]);
    await expect(providers.project.prime({})).resolves.toMatchObject({ session_warm: true });
  });

  it('promote does not raise over an http-configured project (delegates to the local fallback, per http-provider.ts design)', async () => {
    const repoPath = makeRepoPath();
    const remoteUrl = `https://example.invalid/kb-http-ops-promote-${crypto.randomUUID()}.git`;
    const providers = await getKbProviders(repoPath, remoteUrl);
    expect(providers.project).toBeInstanceOf(HttpKbProvider);

    // promote() is delegated straight to the fallback (http-provider.ts),
    // so the entry must exist there -- captured directly against the
    // fallback, not through the remote server, to seed it.
    const fallback = (providers.project as unknown as { fallback: SqliteProvider }).fallback;
    const { id } = await fallback.capture(seedEntry({ symbols: ['httpOpsPromote'] }));

    await expect(
      providers.project.promote(id, 'kb-sqlite-http-guard test: verified against the fallback fixture directly'),
    ).resolves.toMatchObject({
      id,
      confidence_before: 'INFERRED',
      confidence_after: 'CONFIRMED',
    });
  });
});
