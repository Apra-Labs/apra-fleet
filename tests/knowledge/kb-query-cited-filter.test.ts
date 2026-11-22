import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { HttpKbProvider } from '../../src/services/knowledge/http-provider.js';
import { normalizeCitedPath, CitedFilterError } from '../../src/services/knowledge/cited-filter.js';
import { validateFilePaths } from '../../src/services/knowledge/path-validation.js';
import { startKbServer, KB_SERVER_CAPABILITIES } from '../../src/commands/kb-server.js';
import { getProjectSlug } from '../../src/services/knowledge/kb-providers.js';
import { kbQuery, kbQuerySchema } from '../../src/tools/kb-query.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import type { KBEntry, KBEntryInput } from '../../src/services/knowledge/types.js';

// kb_query's cited filter (files / symbols): a HARD filter. Only entries whose
// source_files cite one of the given paths (exactly, or under a given
// directory) or whose symbols name one of the given symbols come back -- an
// unrelated entry with a far stronger keyword match is excluded. With neither
// field the result is exactly what it was before the filter existed.
//
// HTTP: the filter is sent only to a KB server whose GET /api/kb/capabilities
// lists it in query_filters (fleet's own kb-server does); a server that does
// not list it gets E-KB-HTTP-UNSUPPORTED and no query is sent. Both run
// against the real sample kb-server (startKbServer) on a sandboxed database;
// the "not advertised" server is that same server behind a pass-through proxy
// that drops query_filters from the capabilities answer.

function makeInput(overrides: Partial<KBEntryInput>): KBEntryInput {
  return {
    type: 'knowledge',
    title: 'Cited filter entry',
    summary: 'cited filter summary',
    content: 'cited filter content',
    source_files: [],
    symbols: [],
    tags: [],
    content_hash: '',
    content_hash_type: 'sha256',
    flagged_for_review: false,
    author: 'test-agent',
    source: 'doer',
    confidence: 'CONFIRMED',
    ...overrides,
  };
}

// importMode keeps CONFIRMED (every other capture path clamps to INFERRED).
async function seed(p: SqliteProvider): Promise<Record<string, string>> {
  const add = async (o: Partial<KBEntryInput>) => (await p.capture(makeInput(o), { importMode: true })).id;
  return {
    gear: await add({
      title: 'Gear stage batches sprocket work',
      summary: 'The gear stage batches sprocket work per tick.',
      source_files: ['src/widgets/gear.ts'], symbols: ['gearTick'],
    }),
    cog: await add({
      title: 'Cog helper retries a sprocket once',
      summary: 'The cog helper retries a failed sprocket once.',
      source_files: ['src\\widgets\\sub\\cog.ts'], symbols: ['cogTurn'],
    }),
    // A directory-prefix trap: src/widgets must not match src/widgets-legacy.
    legacy: await add({
      title: 'Legacy sprocket path',
      summary: 'The legacy sprocket path is kept for old callers.',
      source_files: ['src/widgets-legacy/old.ts'], symbols: ['legacyRun'],
    }),
    // The generic entry: the strongest keyword match by far, citing no widget file.
    generic: await add({
      title: 'Sprocket sprocket sprocket overview',
      summary: 'Sprocket overview: every sprocket, sprocket stage and sprocket rule in one place.',
      content: 'sprocket sprocket sprocket',
      source_files: ['docs/sprocket-overview.md'], symbols: ['sprocketOverview'],
    }),
  };
}

const idsOf = (rows: Array<{ id: string }>) => rows.map(r => r.id);

describe('normalizeCitedPath', () => {
  it('normalises separators, a leading ./, repeated and trailing slashes', () => {
    expect(normalizeCitedPath('.\\src\\widgets\\gear.ts')).toBe('src/widgets/gear.ts');
    expect(normalizeCitedPath('./src//widgets/')).toBe('src/widgets');
  });

  it('makes an absolute path inside the repository repo-relative', () => {
    expect(normalizeCitedPath('/work/repo/src/a.ts', '/work/repo')).toBe('src/a.ts');
    expect(normalizeCitedPath('C:\\work\\repo\\src\\a.ts', 'c:\\Work\\Repo')).toBe('src/a.ts');
    // A sibling folder sharing the prefix is not inside the repository.
    expect(normalizeCitedPath('/work/repo-other/a.ts', '/work/repo')).toBe('/work/repo-other/a.ts');
  });
});

describe('SqliteProvider.query cited filter', () => {
  let provider: SqliteProvider;
  let ids: Record<string, string>;

  beforeEach(async () => {
    provider = new SqliteProvider(':memory:');
    await provider.init();
    ids = await seed(provider);
  });
  afterEach(() => provider.close());

  it('a file filter keeps only entries citing that file; the stronger generic keyword match is excluded', async () => {
    const unfiltered = await provider.query({ query: 'sprocket', limit: 20 });
    // Precondition: without the filter the generic entry ranks first.
    expect(unfiltered.results[0].id).toBe(ids.generic);

    const r = await provider.query({ query: 'sprocket', limit: 20, cited: { files: ['src/widgets/gear.ts'] } });
    expect(idsOf(r.results)).toEqual([ids.gear]);
  });

  it('a directory prefix matches files under it, not a sibling sharing the prefix', async () => {
    const r = await provider.query({ query: 'sprocket', limit: 20, cited: { files: ['./src/widgets/'] } });
    expect(idsOf(r.results).sort()).toEqual([ids.gear, ids.cog].sort());
  });

  it('a stored backslash path is matched by its forward-slash form', async () => {
    const r = await provider.query({ query: 'sprocket', limit: 20, cited: { files: ['src/widgets/sub/cog.ts'] } });
    expect(idsOf(r.results)).toEqual([ids.cog]);
  });

  it('symbols filter on exact symbol names; files and symbols together keep either match', async () => {
    expect(idsOf((await provider.query({ query: 'sprocket', cited: { symbols: ['cogTurn'] } })).results)).toEqual([ids.cog]);
    const both = await provider.query({ query: 'sprocket', cited: { files: ['src/widgets/gear.ts'], symbols: ['legacyRun'] } });
    expect(idsOf(both.results).sort()).toEqual([ids.gear, ids.legacy].sort());
  });

  it('works without query text (a listing of the citing entries)', async () => {
    const r = await provider.query({ cited: { files: ['src/widgets'] } });
    expect(idsOf(r.results).sort()).toEqual([ids.gear, ids.cog].sort());
  });

  it('refuses a files value naming no path inside the repository', async () => {
    await expect(provider.query({ query: 'sprocket', cited: { files: ['./'] } })).rejects.toBeInstanceOf(CitedFilterError);
  });
});

// Stored source_files are kept as captured: capture() does not rewrite them.
// The files filter compares a stored path after converting backslashes and
// dropping one leading './'; other odd stored forms are documented as not
// matched. context() and invalidate() match a caller's path as given or in
// canonical form, so a backslash caller finds a forward-slash row.
describe('stored source_files are kept as captured', () => {
  let base: string;
  let repo: string;
  let provider: SqliteProvider;

  beforeEach(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-cited-store-'));
    repo = path.join(base, 'repo');
    fs.mkdirSync(path.join(repo, 'src', 'svc'), { recursive: true });
    for (const f of ['a.ts', 'b.ts', 'c.ts']) fs.writeFileSync(path.join(repo, 'src', 'svc', f), `export const ${f[0]} = 1;
`);
    // A file OUTSIDE the repository, next to it: a path escaping the repo
    // must never be stored as a basis.
    fs.writeFileSync(path.join(base, 'x'), 'outside the repository\n');
    provider = new SqliteProvider(':memory:', repo);
    await provider.init();
  });
  afterEach(() => {
    provider.close();
    fs.rmSync(base, { recursive: true, force: true });
  });

  const liveRows = () => ((provider as any).db.prepare(
    'SELECT id, source_files FROM entries WHERE superseded_at IS NULL',
  ).all() as { id: string; source_files: string }[]);

  it('kb_query {files: ["src/svc"]} matches a one-leading-./ stored path, not repeated / or ././', async () => {
    const capture = async (title: string, file: string, symbol: string) => (await provider.capture(makeInput({
      title, summary: `${title} summary`, source_files: [file], symbols: [symbol],
    }))).id;
    const a = await capture('Service a doubles the input', 'src//svc/a.ts', 'svcA');
    const b = await capture('Service b halves the input', '././src/svc/b.ts', 'svcB');
    const c = await capture('Service c negates the input', './src/svc/c.ts', 'svcC');

    const r = await provider.query({ cited: { files: ['src/svc'] }, limit: 20 });
    expect(idsOf(r.results)).toEqual([c]);
    const stored = Object.fromEntries(liveRows().map(row => [row.id, JSON.parse(row.source_files)]));
    expect(stored[a]).toEqual(['src//svc/a.ts']);
    expect(stored[b]).toEqual(['././src/svc/b.ts']);
    expect(stored[c]).toEqual(['./src/svc/c.ts']);
  });

  it('context() and invalidate() find a canonical stored path by a backslash or ./ caller form', async () => {
    const { id } = await provider.capture(makeInput({
      type: 'context-cache', title: 'Service a context', source_files: ['src/svc/a.ts'], symbols: ['svcACtx'],
    }));
    const ctx = await provider.context(['src\\svc\\a.ts']);
    expect(ctx[0]?.entry_id).toBe(id);
    expect((await provider.invalidate(['./src/svc/a.ts'])).invalidated).toBe(1);
  });

  // The capture boundaries (kb_capture, POST /api/kb/capture) run
  // validateFilePaths on the raw source_files, then capture(). The path
  // validated must be the path stored: a leading space before an absolute
  // path, or backslash '..' segments (not separators on POSIX), must not turn
  // into an absolute or traversing stored path that reaches a real file.
  it('a raw path that passes validateFilePaths is never stored absolute or traversing', async () => {
    const atBoundary = async (file: string) => {
      validateFilePaths([file]);
      return provider.capture(makeInput({ title: `Escape via ${file}`, source_files: [file], symbols: ['escape'] }));
    };
    for (const file of [' ' + path.join(base, 'x'), 'a\\..\\..\\x']) {
      await expect(atBoundary(file)).rejects.toThrow();
    }
    expect(liveRows()).toEqual([]);
  });

  it('re-capturing an entry whose existing row stores ./src/svc/a.ts updates it in place', async () => {
    const input = makeInput({
      type: 'context-cache', title: 'Service a context legacy', source_files: ['./src/svc/a.ts'], symbols: ['svcALegacy'],
    });
    const { id } = await provider.capture(input);
    // Pin the row to exactly the form an older build stored.
    (provider as any).db.prepare('UPDATE entries SET source_files = ? WHERE id = ?')
      .run(JSON.stringify(['./src/svc/a.ts']), id);

    const again = await provider.capture({ ...input, summary: 'refreshed context summary' });
    expect(again.id).toBe(id);
    expect(liveRows().map(r => r.id)).toEqual([id]);
    expect((await provider.invalidate(['./src/svc/a.ts'])).invalidated).toBe(1);
  });
});

describe('kb_query tool cited filter', () => {
  let provider: SqliteProvider;
  let ids: Record<string, string>;
  let global: SqliteProvider;

  beforeEach(async () => {
    provider = new SqliteProvider(':memory:');
    await provider.init();
    ids = await seed(provider);
    global = new SqliteProvider(':memory:');
    await global.init();
    vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({ project: provider, global, projectSlug: 'test' } as any);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    provider.close();
    global.close();
  });

  it('files filters l1 and l2 to the citing entries', async () => {
    const parsed = JSON.parse(await kbQuery({ query: 'sprocket', files: ['src/widgets/gear.ts'] }));
    expect(idsOf(parsed.l1_results)).toEqual([ids.gear]);
    expect(idsOf(parsed.l2_expanded)).toEqual([ids.gear]);
  });

  it('files or symbols alone is a valid request; neither (and no query/tag) is refused', async () => {
    const parsed = JSON.parse(await kbQuery({ symbols: ['gearTick'] }));
    expect(idsOf(parsed.l1_results)).toEqual([ids.gear]);
    await expect(kbQuery({})).rejects.toThrow(/files or symbols/);
    expect(kbQuerySchema.safeParse({ files: [] }).success).toBe(false);
    expect(kbQuerySchema.safeParse({ files: ['src/a.ts'], symbols: ['a'] }).success).toBe(true);
  });

  it('no filter: the result is unchanged (snapshot of the ranked titles)', async () => {
    const parsed = JSON.parse(await kbQuery({ query: 'sprocket' }));
    expect(parsed.l1_results.map((e: KBEntry) => e.title)).toMatchInlineSnapshot(`
      [
        "Sprocket sprocket sprocket overview",
        "Gear stage batches sprocket work",
        "Legacy sprocket path",
        "Cog helper retries a sprocket once",
      ]
    `);
    expect(parsed.l2_expanded).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// HTTP: the real sample kb-server, and the same server with query_filters
// dropped from its capabilities.

describe('HttpKbProvider cited filter against the sample kb-server', () => {
  let tmp: string;
  let server: http.Server;
  let proxy: http.Server;
  let serverUrl: string;
  let proxyUrl: string;
  const proxied: string[] = [];
  const TOKEN = 'NOT_A_REAL_KEY-kb-cited-filter-test';
  let ids: Record<string, string>;
  const project = getProjectSlug();

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-cited-filter-'));
    const dbPath = path.join(tmp, 'kb.sqlite');
    const tokenFile = path.join(tmp, 'token.txt');
    fs.writeFileSync(tokenFile, TOKEN, { mode: 0o600 });
    const seeder = new SqliteProvider(dbPath);
    await seeder.init();
    ids = await seed(seeder);
    seeder.close();

    server = await startKbServer(0, false, dbPath, tokenFile);
    serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // Pass-through proxy that removes query_filters from the capabilities answer.
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
  });

  afterAll(async () => {
    proxy.closeAllConnections();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('the sample server lists the filter in query_filters', async () => {
    expect(KB_SERVER_CAPABILITIES.query_filters).toEqual(['files', 'symbols']);
    const p = new HttpKbProvider(serverUrl, TOKEN, { projectSlug: project });
    try {
      expect((await p.capabilities()).query_filters).toEqual(['files', 'symbols']);
    } finally {
      p.dispose();
    }
  });

  it('forwards the filter when advertised, and the server honours it', async () => {
    const p = new HttpKbProvider(serverUrl, TOKEN, { projectSlug: project });
    try {
      const unfiltered = await p.query({ query: 'sprocket', confidence: ['CONFIRMED'] });
      expect(idsOf(unfiltered.results)).toContain(ids.generic);
      const r = await p.query({ query: 'sprocket', confidence: ['CONFIRMED'], cited: { files: ['src/widgets'] } });
      expect(idsOf(r.results).sort()).toEqual([ids.gear, ids.cog].sort());
      const s = await p.query({ query: 'sprocket', cited: { symbols: ['legacyRun'] } });
      expect(idsOf(s.results)).toEqual([ids.legacy]);
    } finally {
      p.dispose();
    }
  });

  // The http server has no repo root, so kb_query makes an absolute files
  // path repo-relative itself, against the session's repo, before sending it.
  it('kb_query makes an absolute files path inside the repository repo-relative before sending it', async () => {
    const root = path.join(tmp, 'repo');
    const p = new HttpKbProvider(serverUrl, TOKEN, { projectSlug: project });
    const global = new SqliteProvider(':memory:');
    await global.init();
    vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({ project: p, global, projectSlug: project } as any);
    try {
      const parsed = JSON.parse(await kbQuery({ query: 'sprocket', files: [path.join(root, 'src', 'widgets')] }, { folder: root }));
      expect(idsOf(parsed.l1_results).sort()).toEqual([ids.gear, ids.cog].sort());
    } finally {
      vi.restoreAllMocks();
      global.close();
      p.dispose();
    }
  });

  it('a server that does not advertise it gets E-KB-HTTP-UNSUPPORTED and no query is sent', async () => {
    const p = new HttpKbProvider(proxyUrl, TOKEN, { projectSlug: project });
    try {
      proxied.length = 0;
      await expect(p.query({ query: 'sprocket', cited: { files: ['src/widgets'] } }))
        .rejects.toMatchObject({ code: 'E-KB-HTTP-UNSUPPORTED', message: expect.stringMatching(/files filter.*query_filters/) });
      expect(proxied).toEqual(['GET /api/kb/capabilities']);
      // Without the filter the same server still answers.
      const r = await p.query({ query: 'sprocket' });
      expect(idsOf(r.results)).toContain(ids.generic);
    } finally {
      p.dispose();
    }
  });
});
