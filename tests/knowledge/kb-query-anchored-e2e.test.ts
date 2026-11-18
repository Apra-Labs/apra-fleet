import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { addAgent } from '../../src/services/registry.js';
import { runWithSessionMember } from '../../src/services/tool-scope.js';
import { getKbProviders, getProjectSlug, resetKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { requireSqliteProject } from '../../src/services/knowledge/require-sqlite-project.js';
import { resetMemberBibleViews } from '../../src/services/knowledge/member-bible-view.js';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';
import { startKbServer } from '../../src/commands/kb-server.js';
import { kbSetup } from '../../src/tools/kb-setup.js';
import { kbQuery, MEMBER_DEFAULT_LIMIT, MEMBER_SLIM_ROW_KEYS } from '../../src/tools/kb-query.js';
import { FLEET_DIR } from '../../src/paths.js';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from '../test-helpers.js';

// kb_query anchored retrieval end to end, through the real tool surface
// (kbQuery with kb-self routing, member sessions, kb_setup, the real KB
// providers, the sample kb-server). One assertion block per point:
//
//   (a) MEMBER session over a SQLite project KB: the files filter returns only
//       entries citing the file (a directory prefix included) and excludes a
//       generic entry with a stronger keyword match.
//   (b) the same member without arguments gets at most MEMBER_DEFAULT_LIMIT
//       slim CONFIRMED rows and no L2 content; explicit limit / confidence
//       keep their meaning.
//   (c) HTTP provider against the sample kb-server started in-process: the
//       filter is forwarded and honoured when the capabilities list it; the
//       same server behind a proxy that drops query_filters gets
//       E-KB-HTTP-UNSUPPORTED and no query is sent.
//   (d) a KB database built with the 0.4.5 schema opens after the upgrade and
//       answers kb_query (plain and filtered) with no manual step.
//
// Isolation: tests/setup.ts points APRA_FLEET_DATA_DIR at a per-run temp dir;
// the registry is backed up and restored; every checkout, database and token
// file lives under one mkdtemp root removed in afterAll; the KB config is
// removed and both servers are closed in afterAll.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_ENV_VAR = 'APRA_FLEET_TEST_KB_HTTP_TOKEN';
const TOKEN_FIXTURE_PATH = path.join(__dirname, 'fixtures', 'kb-http-test-token.txt');
const SCHEMA_045 = fs.readFileSync(path.resolve(__dirname, '../fixtures/kb-v045-schema.sql'), 'utf-8');
const KB_CONFIG_PATH = path.join(FLEET_DIR, 'knowledge', 'config.json');
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const LONG = 'The gizmo stage batches work into fixed windows and flushes on idle. '.repeat(20);

function loadTestToken(): string {
  const fromEnv = process.env[TOKEN_ENV_VAR];
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  if (fs.existsSync(TOKEN_FIXTURE_PATH)) {
    const fromFile = fs.readFileSync(TOKEN_FIXTURE_PATH, 'utf-8').trim();
    if (fromFile.length > 0) return fromFile;
  }
  throw new Error(`Missing test KB token: set ${TOKEN_ENV_VAR} or provide a non-empty ${TOKEN_FIXTURE_PATH}`);
}

let scratch: string;

/** A git checkout with an origin remote; every listed file is created. */
function makeRepo(name: string, files: string[]): string {
  const repo = path.join(scratch, name);
  fs.mkdirSync(path.join(repo, '.fleet'), { recursive: true });
  for (const f of files) {
    const abs = path.join(repo, f);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (!fs.existsSync(abs)) fs.writeFileSync(abs, `// ${f}\n`);
  }
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', `https://example.test/kb-query-anchored-${name}-${RUN}.git`], { cwd: repo });
  return repo;
}

type Row = { id: string; title: string; confidence: string; source_files: string[] } & Record<string, unknown>;
const ids = (rows: Row[]) => rows.map(r => r.id);
const citesUnder = (r: Row, dir: string) => r.source_files.some(f => f.startsWith(dir + '/'));

beforeAll(() => {
  backupAndResetRegistry();
  resetMemberBibleViews();
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-query-anchored-e2e-'));
});

afterAll(() => {
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();
  resetMemberBibleViews();
  restoreRegistry();
  fs.rmSync(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (a) and (b): a MEMBER session over a SQLite project KB (checkout bible view).

describe('member session over a SQLite project KB', () => {
  let memberId: string;
  const asMember = <T>(fn: () => Promise<T>): Promise<T> => runWithSessionMember(memberId, fn);

  function bibleEntry(id: string, title: string, summary: string, file: string, extra: Record<string, unknown> = {}) {
    return {
      id, type: 'knowledge', title, summary, content: LONG, symbols: [], source_files: [file],
      confidence: 'CONFIRMED', updated_at: '2026-09-01T00:00:00.000Z', ...extra,
    };
  }

  beforeAll(async () => {
    const entries = [
      ...Array.from({ length: 8 }, (_, i) => bibleEntry(
        `gizmo-${i}`, `Gizmo pipeline fact ${i}`, `Gizmo pipeline fact ${i}: the gizmo stage batches work.`,
        i % 2 === 0 ? 'src/gizmo/stage.ts' : 'src/gizmo/sub/flush.ts',
      )),
      // The generic entry: by far the strongest keyword match, citing no gizmo source.
      bibleEntry('generic', 'Gizmo pipeline overview: gizmo gizmo gizmo',
        'Gizmo pipeline overview -- every gizmo, gizmo stage and gizmo pipeline rule.', 'docs/gizmo-overview.md',
        { content: 'gizmo pipeline gizmo pipeline gizmo pipeline' }),
      // Shares the directory name as a prefix but is not under src/gizmo/.
      bibleEntry('legacy', 'Gizmo pipeline legacy path', 'The legacy gizmo pipeline path.', 'src/gizmo-legacy/old.ts'),
    ];
    const repo = makeRepo('member', entries.flatMap(e => e.source_files));
    fs.writeFileSync(path.join(repo, '.fleet', 'kb-canonical.json'), JSON.stringify({ version: 2, entries }), 'utf-8');
    const agent = makeTestLocalAgent({ friendlyName: `kb-anchored-member-${RUN}`, workFolder: repo });
    addAgent(agent);
    memberId = agent.id;
    // The member's own INFERRED capture: absent from a default (CONFIRMED) read.
    const providers = await getKbProviders(repo);
    await requireSqliteProject(providers.project, 'test').capture({
      type: 'knowledge', title: 'Gizmo pipeline own note', summary: 'Own note on the gizmo pipeline stage.',
      content: 'Own note on the gizmo pipeline stage.', source_files: ['src/gizmo/stage.ts'], symbols: [],
      tags: [`member:${memberId}`], content_hash: '', content_hash_type: 'sha256', stale: false, flagged_for_review: false,
      author: 'test', source: 'doer', confidence: 'INFERRED', scope: 'project',
    } as KBEntryInput, { importMode: true, preferredId: 'own-inferred', verbatim: true });
  });

  it('(a) files filter: only entries citing the file or a file under the directory; the generic keyword match is excluded', async () => {
    const unfiltered = JSON.parse(await asMember(() => kbQuery({ query: 'gizmo pipeline overview', limit: 20 })));
    // Precondition: the generic entry is the top keyword match without the filter.
    expect(unfiltered.l1_results[0].id).toBe('generic');

    const dir = JSON.parse(await asMember(() => kbQuery({ query: 'gizmo pipeline overview', files: ['src/gizmo'], limit: 20 })));
    expect(dir.l1_results).toHaveLength(8);
    for (const r of dir.l1_results as Row[]) expect(citesUnder(r, 'src/gizmo')).toBe(true);
    expect(ids(dir.l1_results)).not.toContain('generic');
    expect(ids(dir.l1_results)).not.toContain('legacy');

    const file = JSON.parse(await asMember(() => kbQuery({ query: 'gizmo pipeline overview', files: ['./src/gizmo/sub/flush.ts'] })));
    expect(ids(file.l1_results).sort()).toEqual(['gizmo-1', 'gizmo-3', 'gizmo-5', 'gizmo-7']);
  });

  it('(b) no arguments: at most the member cap of slim CONFIRMED rows and no L2; explicit limit and confidence keep their meaning', async () => {
    const out = JSON.parse(await asMember(() => kbQuery({ query: 'gizmo pipeline' })));
    expect(out.l1_results).toHaveLength(MEMBER_DEFAULT_LIMIT);
    for (const row of out.l1_results) {
      expect(Object.keys(row).sort()).toEqual([...MEMBER_SLIM_ROW_KEYS].sort());
      expect(row).not.toHaveProperty('content');
      expect(row.confidence).toBe('CONFIRMED');
    }
    expect(out.l2_expanded).toEqual([]);

    const limited = JSON.parse(await asMember(() => kbQuery({ query: 'gizmo pipeline', limit: 9 })));
    expect(limited.l1_results).toHaveLength(9);
    for (const row of limited.l1_results) expect(row).toHaveProperty('content');
    expect(limited.l2_expanded).toHaveLength(5);
    expect(limited.l2_expanded[0].content.length).toBeGreaterThan(0);

    const tiers = JSON.parse(await asMember(() => kbQuery({ query: 'gizmo pipeline own', confidence: ['CONFIRMED', 'INFERRED'], limit: 20 })));
    expect(ids(tiers.l1_results)).toContain('own-inferred');
    expect(ids(tiers.l1_results)).toContain('generic');
  });
});

// ---------------------------------------------------------------------------
// (d) a 0.4.5-schema KB database opens after the upgrade with no manual step.

describe('a KB built with the 0.4.5 schema', () => {
  let repo: string;

  beforeAll(() => {
    repo = makeRepo('upgrade', ['src/handshake/retry.ts', 'src/theme.ts']);
    resetKbProviders();
    const dir = path.join(FLEET_DIR, 'knowledge', getProjectSlug(repo));
    fs.mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(path.join(dir, 'kb.sqlite'));
    db.exec('PRAGMA journal_mode=WAL');
    db.exec(SCHEMA_045);
    // Rows written exactly the way 0.4.5's insertEntry writes them.
    const insert = db.prepare(`
      INSERT INTO entries (id, type, title, summary, content, source_files, symbols, tags, author, source,
        confidence, scope, created_at, source_file_hashes)
      VALUES (?, 'knowledge', ?, ?, ?, ?, '[]', '[]', 'doer', 'doer', 'CONFIRMED', 'project', ?, '{}')
    `);
    const now = new Date().toISOString();
    insert.run('v045-retry', 'Retrying uploads after a failed handshake', 'The client retries failed handshakes with backoff.',
      'retry body', JSON.stringify(['src/handshake/retry.ts']), now);
    insert.run('v045-theme', 'Handshake colours in the theme', 'The handshake banner uses the theme palette.',
      'theme body', JSON.stringify(['src/theme.ts']), now);
    db.close();
  });

  it('(d) answers kb_query, plain and filtered, through the tool surface', async () => {
    const plain = JSON.parse(await kbQuery({ query: 'handshake' }, { folder: repo }));
    expect(ids(plain.l1_results).sort()).toEqual(['v045-retry', 'v045-theme']);
    const filtered = JSON.parse(await kbQuery({ query: 'handshake', files: ['src/handshake'] }, { folder: repo }));
    expect(ids(filtered.l1_results)).toEqual(['v045-retry']);
  });
});

// ---------------------------------------------------------------------------
// (c) HTTP provider against the sample kb-server (last: it switches the KB
// config to http, removed again in afterAll).

describe('member session over the http provider (sample kb-server)', () => {
  let memberId: string;
  let repo: string;
  let server: http.Server;
  let proxy: http.Server;
  let serverUrl: string;
  let proxyUrl: string;
  let token: string;
  const proxied: string[] = [];
  const asMember = <T>(fn: () => Promise<T>): Promise<T> => runWithSessionMember(memberId, fn);

  beforeAll(async () => {
    token = loadTestToken();
    repo = makeRepo('http', ['src/widgets/gear.ts', 'src/widgets/sub/cog.ts', 'docs/sprocket.md']);
    const dbPath = path.join(scratch, 'http-server-kb.sqlite');
    const tokenFile = path.join(scratch, 'http-server-token.txt');
    fs.writeFileSync(tokenFile, token, { mode: 0o600 });
    const seeder = new SqliteProvider(dbPath);
    await seeder.init();
    const add = async (id: string, title: string, summary: string, file: string) => seeder.capture({
      type: 'knowledge', title, summary, content: summary, source_files: [file], symbols: [], tags: [],
      content_hash: '', content_hash_type: 'sha256', flagged_for_review: false,
      author: 'test', source: 'doer', confidence: 'CONFIRMED',
    } as KBEntryInput, { importMode: true, preferredId: id, verbatim: true });
    await add('gear', 'Gear stage batches sprocket work', 'The gear stage batches sprocket work per tick.', 'src/widgets/gear.ts');
    await add('cog', 'Cog helper retries a sprocket once', 'The cog helper retries a failed sprocket once.', 'src/widgets/sub/cog.ts');
    await add('generic', 'Sprocket sprocket sprocket overview', 'Sprocket overview: every sprocket and sprocket rule.', 'docs/sprocket.md');
    seeder.close();

    // startKbServer serves the project of process.cwd(): start it from the checkout.
    const cwd = process.cwd();
    process.chdir(repo);
    try {
      server = await startKbServer(0, false, dbPath, tokenFile);
    } finally {
      process.chdir(cwd);
    }
    serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // The same server, minus query_filters in its capabilities answer.
    proxy = http.createServer((req, res) => {
      proxied.push(`${req.method} ${new URL(req.url ?? '/', 'http://p').pathname}`);
      const upstream = http.request(`${serverUrl}${req.url}`, { method: req.method, headers: req.headers }, up => {
        let body = '';
        up.on('data', (c: Buffer) => { body += c.toString(); });
        up.on('end', () => {
          if ((req.url ?? '').startsWith('/api/kb/capabilities') && up.statusCode === 200) {
            const caps = JSON.parse(body) as Record<string, unknown>;
            delete caps.query_filters;
            body = JSON.stringify(caps);
          }
          res.writeHead(up.statusCode ?? 500, { 'Content-Type': 'application/json' });
          res.end(body);
        });
      });
      req.pipe(upstream);
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', () => resolve()));
    proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;

    const agent = makeTestLocalAgent({ friendlyName: `kb-anchored-http-${RUN}`, workFolder: repo });
    addAgent(agent);
    memberId = agent.id;
  });

  afterAll(async () => {
    fs.rmSync(KB_CONFIG_PATH, { force: true });
    resetKbProviders();
    proxy.closeAllConnections();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('(c) the filter is forwarded and honoured when listed; refused with E-KB-HTTP-UNSUPPORTED when not', async () => {
    const setup = JSON.parse(await kbSetup({ provider: 'http', remote: serverUrl, token }, { folder: repo }));
    expect(setup.success).toBe(true);
    const unfiltered = JSON.parse(await asMember(() => kbQuery({ query: 'sprocket' })));
    expect(ids(unfiltered.l1_results)).toContain('generic');
    const filtered = JSON.parse(await asMember(() => kbQuery({ query: 'sprocket', files: ['src/widgets'] })));
    expect(ids(filtered.l1_results).sort()).toEqual(['cog', 'gear']);

    const viaProxy = JSON.parse(await kbSetup({ provider: 'http', remote: proxyUrl, token }, { folder: repo }));
    expect(viaProxy.success).toBe(true);
    resetKbProviders();
    proxied.length = 0;
    await expect(asMember(() => kbQuery({ query: 'sprocket', files: ['src/widgets'] })))
      .rejects.toMatchObject({ code: 'E-KB-HTTP-UNSUPPORTED', message: expect.stringMatching(/files filter.*query_filters/) });
    expect(proxied).not.toContain('GET /api/kb/query');
    // The same server without the filter still answers.
    const plain = JSON.parse(await asMember(() => kbQuery({ query: 'sprocket' })));
    expect(ids(plain.l1_results)).toContain('generic');
  });
});
