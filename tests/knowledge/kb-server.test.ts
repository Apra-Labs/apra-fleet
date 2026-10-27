import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { startKbServer, KbServerHttpProviderRefusedError } from '../../src/commands/kb-server.js';
import { FLEET_DIR } from '../../src/paths.js';
import { encryptPassword } from '../../src/utils/crypto.js';
import { resetKbProviders, getProjectSlug } from '../../src/services/knowledge/kb-providers.js';
import { HttpKbProvider, KbHttpProjectMismatchError, redactUrlUserinfo } from '../../src/services/knowledge/http-provider.js';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';

const TEST_PORT = 17878;
const TOKEN_DIR = path.join(FLEET_DIR, 'knowledge');
const TOKEN_PATH = path.join(TOKEN_DIR, 'kb-server.token');

let server: http.Server;
let testToken: string;
// The project the server serves: startKbServer builds its providers for
// process.cwd(), the same folder getProjectSlug() defaults to.
const SERVER_PROJECT = getProjectSlug();

function request(
  method: string,
  urlPath: string,
  opts?: { body?: any; raw?: string; token?: string | null; project?: string | null }
): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const data = opts?.raw ?? (opts?.body ? JSON.stringify(opts.body) : undefined);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (opts?.token !== null) {
      headers['Authorization'] = `Bearer ${opts?.token ?? testToken}`;
    }
    if (opts?.project !== null) {
      headers['X-KB-Project'] = opts?.project ?? SERVER_PROJECT;
    }
    if (data) headers['Content-Length'] = Buffer.byteLength(data).toString();

    const req = http.request(
      { hostname: '127.0.0.1', port: TEST_PORT, path: urlPath, method, headers },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(body), headers: res.headers });
          } catch {
            resolve({ status: res.statusCode!, body, headers: res.headers });
          }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

beforeAll(async () => {
  // Write a known token
  testToken = crypto.randomBytes(16).toString('hex');
  if (!fs.existsSync(TOKEN_DIR)) fs.mkdirSync(TOKEN_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_PATH, encryptPassword(testToken), { mode: 0o600 });

  server = await startKbServer(TEST_PORT, false);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try { fs.unlinkSync(TOKEN_PATH); } catch { /* ignore */ }
});

// Declared before the main suite on purpose: its rate-limit test exhausts
// the per-IP bucket (module-level, 60s window), and these requests would
// then get 429.
// POST /api/kb/promote and the query tag filter: the routes HttpKbProvider
// uses for promote and for the member own-scope lookup, served by fleet's own
// reference server so the http provider has a fleet-defined counterpart.
describe('kb-server promote and tag filter', () => {
  const PROMOTE_REASON = 'Checked against src/commands/kb-server.ts: the route exists and is served.';

  async function captureTagged(tags: string[]): Promise<string> {
    const marker = crypto.randomUUID();
    const res = await request('POST', '/api/kb/capture', {
      body: {
        type: 'knowledge',
        title: `kb-server promote route check ${marker}`,
        summary: `Entry ${marker} captured to exercise the promote route.`,
        content: `Unique content ${marker} for the kb-server promote route test.`,
        source_files: ['src/commands/kb-server.ts'],
        symbols: [], tags, content_hash: '', content_hash_type: 'sha256',
        flagged_for_review: false, author: 'test', source: 'doer', confidence: 'INFERRED',
      },
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  it('promotes an INFERRED entry to CONFIRMED and answers {id, previous_confidence, new_confidence}', async () => {
    const id = await captureTagged([]);
    const res = await request('POST', '/api/kb/promote', { body: { id, reason: PROMOTE_REASON } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id, previous_confidence: 'INFERRED', new_confidence: 'CONFIRMED' });
  });

  it('answers 404 NOT_FOUND for an unknown id', async () => {
    const res = await request('POST', '/api/kb/promote', { body: { id: 'no-such-entry', reason: PROMOTE_REASON } });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND', error: 'Entry not found: no-such-entry' });
  });

  it('answers 422 PROMOTE_REFUSED when the promote ladder refuses (trivial reason) and leaves the entry INFERRED', async () => {
    const tag = `owner:${crypto.randomUUID()}`;
    const id = await captureTagged([tag]);
    const res = await request('POST', '/api/kb/promote', { body: { id, reason: 'ok' } });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PROMOTE_REFUSED');
    expect(res.body.error).toMatch(/requires a reason/);
    const after = await request('GET', `/api/kb/query?tag=${encodeURIComponent(tag)}&confidence=INFERRED,CONFIRMED`);
    expect(after.body.results.map((e: { id: string; confidence: string }) => [e.id, e.confidence])).toEqual([[id, 'INFERRED']]);
  });

  it('answers 400 BAD_REQUEST for a promote body that is not JSON', async () => {
    const res = await request('POST', '/api/kb/promote', { raw: '{"id": "x", reason' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'BAD_REQUEST', error: 'Request body is not valid JSON' });
  });

  it('GET /api/kb/list reads an owner\'s entries without bumping use_count; GET /api/kb/query does bump it', async () => {
    const tag = `member:${crypto.randomUUID()}`;
    const id = await captureTagged([tag]);
    const store = new SqliteProvider(path.join(FLEET_DIR, 'knowledge', SERVER_PROJECT, 'kb.sqlite'));
    await store.init();
    const useCount = () => ((store as any).getDb().prepare('SELECT use_count FROM entries WHERE id = ?').get(id) as { use_count: number }).use_count;
    try {
      const before = useCount();
      const listed = await request('GET', `/api/kb/list?tag=${encodeURIComponent(tag)}&confidence=INFERRED&include_stale=true`);
      expect(listed.status).toBe(200);
      expect(listed.body.results.map((e: { id: string; tags: string[] }) => [e.id, e.tags])).toEqual([[id, [tag]]]);
      expect(useCount()).toBe(before);

      await request('GET', `/api/kb/query?tag=${encodeURIComponent(tag)}&confidence=INFERRED`);
      expect(useCount()).toBe(before + 1);
    } finally {
      store.close();
    }
  });

  it('answers 400 BAD_REQUEST without an id', async () => {
    const res = await request('POST', '/api/kb/promote', { body: { reason: PROMOTE_REASON } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('GET /api/kb/query?tag= returns only entries carrying that tag, with their tags', async () => {
    const tag = `owner:${crypto.randomUUID()}`;
    const tagged = await captureTagged([tag]);
    await captureTagged([`owner:${crypto.randomUUID()}`]);
    const res = await request('GET', `/api/kb/query?tag=${encodeURIComponent(tag)}&confidence=INFERRED`);
    expect(res.status).toBe(200);
    expect(res.body.results.map((e: { id: string }) => e.id)).toEqual([tagged]);
    expect(res.body.results[0].tags).toContain(tag);
  });

  it('GET /api/kb/query?fts_terms= applies the terms as an OR-joined FTS match; a malformed value is 400', async () => {
    const term = `zorblax${crypto.randomBytes(6).toString('hex')}`;
    // captureTagged has no hook for the term: capture the matching entry directly.
    const matching = await request('POST', '/api/kb/capture', {
      body: {
        type: 'knowledge', title: `Neighbour ${term} note`, summary: `Entry about ${term} wiring.`,
        content: `Details of ${term} for the fts_terms wire test.`, source_files: ['src/commands/kb-server.ts'],
        symbols: [], tags: [], content_hash: '', content_hash_type: 'sha256',
        flagged_for_review: false, author: 'test', source: 'doer', confidence: 'INFERRED',
      },
    });
    expect(matching.status).toBe(201);
    // Newer, unrelated entries: a recency listing would return these, not the match.
    const newer = [await captureTagged([]), await captureTagged([]), await captureTagged([])];
    expect(newer).not.toContain(matching.body.id);

    const terms = encodeURIComponent(JSON.stringify([term, 'no-such-neighbour.ts']));
    const res = await request('GET', `/api/kb/query?fts_terms=${terms}&l1_only=true&limit=3&confidence=INFERRED`);
    expect(res.status).toBe(200);
    expect(res.body.results.map((e: { id: string }) => e.id)).toEqual([matching.body.id]);

    const bad = await request('GET', `/api/kb/query?fts_terms=${encodeURIComponent('not json')}`);
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('BAD_REQUEST');
  });

  it('HttpKbProvider forwards fts_terms: the neighbour query returns the FTS-matched ids, the same as a SQLite KB seeded alike', async () => {
    const term = `quuxneighbour${crypto.randomBytes(6).toString('hex')}`;
    const fallbackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-server-fts-terms-'));
    const provider = new HttpKbProvider(
      `http://127.0.0.1:${TEST_PORT}`, testToken, new SqliteProvider(path.join(fallbackDir, 'kb.sqlite')),
      { projectSlug: SERVER_PROJECT },
    );
    const local = new SqliteProvider(path.join(fallbackDir, 'local.sqlite'));
    const entry = (title: string, summary: string) => ({
      type: 'knowledge', title, summary, content: `${summary} Extra body text for the capture floor.`,
      source_files: ['src/commands/kb-server.ts'], symbols: [], tags: [], content_hash: '',
      content_hash_type: 'sha256', flagged_for_review: false, author: 'test', source: 'doer', confidence: 'INFERRED',
    }) as any;
    try {
      await local.init();
      // Oldest first: the match is the OLDEST entry, so recency order excludes it at limit 2.
      const seeds = [
        entry(`Match ${term} entry`, `The ${term} module wires the sprocket.`),
        entry(`Unrelated alpha ${term.slice(0, 8)}x`, 'Completely different topic one about gearboxes.'),
        entry(`Unrelated beta ${term.slice(0, 8)}y`, 'Completely different topic two about flywheels.'),
        entry(`Unrelated gamma ${term.slice(0, 8)}z`, 'Completely different topic three about camshafts.'),
      ];
      const remoteIds: string[] = [];
      for (const seed of seeds) {
        remoteIds.push((await provider.capture(seed)).id);
        await local.capture(seed);
      }
      const opts = { fts_terms: [term, 'absent-neighbour.ts'], l1_only: true, limit: 2, confidence: ['INFERRED' as const] };
      const overHttp = await provider.query(opts);
      const overSqlite = await local.query(opts);
      expect(overHttp.results.map(r => r.id)).toEqual([remoteIds[0]]);
      expect(overHttp.results.map(r => r.title)).toEqual(overSqlite.results.map(r => r.title));
    } finally {
      provider.dispose();
      fs.rmSync(fallbackDir, { recursive: true, force: true });
    }
  });

  it('HttpKbProvider against this server: member own-scope promote works for the owner and is not-found for anyone else', async () => {
    const owner = `member:${crypto.randomUUID()}`;
    const id = await captureTagged([owner]);
    const fallbackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-server-http-provider-'));
    const provider = new HttpKbProvider(
      `http://127.0.0.1:${TEST_PORT}`, testToken, new SqliteProvider(path.join(fallbackDir, 'kb.sqlite')),
      { projectSlug: SERVER_PROJECT },
    );
    try {
      await expect(provider.promote(id, PROMOTE_REASON, { ownerTag: `member:${crypto.randomUUID()}` }))
        .rejects.toThrow(`Entry not found: ${id}`);
      const stillInferred = await request('GET', `/api/kb/query?tag=${encodeURIComponent(owner)}&confidence=INFERRED`);
      expect(stillInferred.body.results.map((e: { id: string }) => e.id)).toEqual([id]);

      await expect(provider.promote(id, PROMOTE_REASON, { ownerTag: owner }))
        .resolves.toEqual({ id, confidence_before: 'INFERRED', confidence_after: 'CONFIRMED' });
    } finally {
      provider.dispose();
      fs.rmSync(fallbackDir, { recursive: true, force: true });
    }
  });
});

// One server serves one project. Declared before the main suite for the same
// rate-limit reason as the block above.
describe('kb-server refuses a client for another project on every route', () => {
  const OTHER = 'some-other-repo-slug';
  const ROUTES: Array<[string, string, unknown]> = [
    ['POST', '/api/kb/capture', { type: 'knowledge', title: 't', summary: 's', content: 'c', source_files: [], symbols: [], tags: [] }],
    ['GET', '/api/kb/query?query=x', undefined],
    ['GET', '/api/kb/list?tag=x', undefined],
    ['POST', '/api/kb/promote', { id: 'x', reason: 'a reason long enough to pass the floor' }],
    ['POST', '/api/kb/invalidate', { files: ['src/a.ts'] }],
    ['GET', '/api/kb/context?files=src/a.ts', undefined],
    ['POST', '/api/kb/prime', {}],
  ];

  it.each(ROUTES)('%s %s: 409 naming both projects, for another project and for none', async (method, urlPath, body) => {
    for (const project of [OTHER, null]) {
      const res = await request(method, urlPath, { body, project });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'PROJECT_MISMATCH',
        server_project: SERVER_PROJECT,
        client_project: project ?? '(none)',
      });
    }
  });

  it('an HttpKbProvider for another project gets E-KB-HTTP-PROJECT-MISMATCH from every call, never its fallback store', async () => {
    const fallbackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-server-other-project-'));
    const fallback = new SqliteProvider(path.join(fallbackDir, 'kb.sqlite'));
    const provider = new HttpKbProvider(`http://127.0.0.1:${TEST_PORT}`, testToken, fallback, { projectSlug: OTHER });
    try {
      await provider.init();
      const calls: Array<[string, () => Promise<unknown>]> = [
        ['capture', () => provider.capture({
          type: 'knowledge', title: 'Other project capture', summary: 'Must never land on this server.', content: 'c',
          source_files: [], symbols: [], tags: [], content_hash: '', content_hash_type: 'sha256',
          flagged_for_review: false, author: 'test', source: 'doer', confidence: 'INFERRED',
        } as any)],
        ['query', () => provider.query({ query: 'x' })],
        ['context', () => provider.context(['src/a.ts'])],
        ['invalidate', () => provider.invalidate(['src/a.ts'])],
        ['prime', () => provider.prime({ session_files: [] } as any)],
        ['promote', () => provider.promote('x', 'a reason long enough to pass the floor')],
        ['promote (member)', () => provider.promote('x', 'a reason long enough to pass the floor', { ownerTag: 'member:x' })],
      ];
      for (const [name, call] of calls) {
        const err = await call().then(() => null, (e: unknown) => e);
        expect(err, name).toBeInstanceOf(KbHttpProjectMismatchError);
        expect((err as Error).message, name).toMatch(
          new RegExp(`^E-KB-HTTP-PROJECT-MISMATCH: .*serves project "${SERVER_PROJECT}", not "${OTHER}"`));
      }
      expect(provider.offlineQueue).toEqual([]);
    } finally {
      provider.dispose();
      fallback.close();
      fs.rmSync(fallbackDir, { recursive: true, force: true });
    }
  });
});

describe('redactUrlUserinfo', () => {
  it('drops user and password from a KB server url and leaves a plain url unchanged', () => {
    expect(redactUrlUserinfo('https://alice:s3cret@kb.example.test:7878/base')).toBe('https://kb.example.test:7878/base');
    expect(redactUrlUserinfo('http://127.0.0.1:7878')).toBe('http://127.0.0.1:7878');
  });
});

describe('kb-server', () => {
  it('GET /health returns 200', async () => {
    const res = await request('GET', '/health', { token: null });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('returns 401 when no token provided', async () => {
    const res = await request('GET', '/api/kb/query', { token: null });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 when wrong token provided', async () => {
    const res = await request('GET', '/api/kb/query', { token: 'wrong-token' });
    expect(res.status).toBe(401);
  });

  it('POST /api/kb/capture creates entry and returns 201', async () => {
    const res = await request('POST', '/api/kb/capture', {
      body: {
        type: 'learning',
        title: 'Test from kb-server',
        summary: 'Testing HTTP capture',
        content: 'This entry was created via the HTTP REST API.',
        // KB-TRUST PHASE 1: a capture needs a basis that resolves in the repo
        // the server is anchored at. This used to be [], which now rejects.
        source_files: ['src/commands/kb-server.ts'],
        symbols: [],
        tags: [],
        content_hash: '',
        content_hash_type: 'sha256',
        flagged_for_review: false,
        author: 'test',
        source: 'doer',
        confidence: 'INFERRED',
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.audn_decision).toBe('add');
  });

  // The HTTP route calls provider.capture() directly and never touches the
  // kb_capture handler, so it is one of the three call sites a tool-layer check
  // would have missed. Enforcement lives in the provider; this asserts it lands.
  it('POST /api/kb/capture rejects an entry with no source_files', async () => {
    const res = await request('POST', '/api/kb/capture', {
      body: {
        type: 'learning',
        title: 'Unfalsifiable over HTTP',
        summary: 'Cites nothing',
        content: 'A claim with no basis, submitted over the REST API.',
        source_files: [],
        symbols: [],
        tags: [],
        content_hash: '',
        content_hash_type: 'sha256',
        flagged_for_review: false,
        author: 'test',
        source: 'doer',
        confidence: 'INFERRED',
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CAPTURE_REJECTED');
    expect(res.body.reason).toBe('no_source_files');
  });

  it('POST /api/kb/capture rejects source_files that do not exist in the repo', async () => {
    const res = await request('POST', '/api/kb/capture', {
      body: {
        type: 'learning',
        title: 'Cites a ghost over HTTP',
        summary: 'Cites a file that is not there',
        content: 'A claim about a file this repository does not contain.',
        source_files: ['src/does-not-exist-anywhere.ts'],
        symbols: [],
        tags: [],
        content_hash: '',
        content_hash_type: 'sha256',
        flagged_for_review: false,
        author: 'test',
        source: 'doer',
        confidence: 'INFERRED',
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CAPTURE_REJECTED');
    expect(res.body.reason).toBe('missing_source_files');
  });

  it('returns 400 for path traversal attempt', async () => {
    const res = await request('POST', '/api/kb/invalidate', {
      body: { files: ['../../etc/passwd'] },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PATH_TRAVERSAL');
  });

  // kb_query trust filters over REST: the route must parse confidence (a
  // comma-separated tier list) and exclude_disputed and apply them, or a
  // remote HttpKbProvider forwarding them would be silently ignored.
  it('GET /api/kb/query applies confidence and exclude_disputed', async () => {
    const capture = (title: string, extra: Record<string, unknown> = {}) => request('POST', '/api/kb/capture', {
      body: {
        type: 'learning', title, summary: 'trustroute summary', content: `trustroute ${title}`,
        source_files: ['src/commands/kb-server.ts'], symbols: [], tags: [],
        content_hash: '', content_hash_type: 'sha256', flagged_for_review: false,
        author: 'test', source: 'doer', confidence: 'INFERRED', ...extra,
      },
    });
    expect((await capture('Trustroute plain inferred')).status).toBe(201);
    expect((await capture('Trustroute flagged inferred', { flagged_for_review: true })).status).toBe(201);

    const titles = async (qs: string) => {
      const res = await request('GET', `/api/kb/query?query=trustroute&limit=50${qs}`);
      expect(res.status).toBe(200);
      return res.body.results.map((e: { title: string }) => e.title);
    };

    const unfiltered = await titles('');
    expect(unfiltered).toContain('Trustroute plain inferred');
    expect(unfiltered).toContain('Trustroute flagged inferred');

    expect(await titles('&confidence=CONFIRMED')).toEqual([]);
    const inferred = await titles('&confidence=CONFIRMED,INFERRED');
    expect(inferred).toContain('Trustroute plain inferred');

    const undisputed = await titles('&exclude_disputed=true');
    expect(undisputed).toContain('Trustroute plain inferred');
    expect(undisputed).not.toContain('Trustroute flagged inferred');
  });

  it('returns 429 after rate limit exceeded', async () => {
    // We need to exhaust the rate limit -- send 100+ requests fast
    const promises: Promise<any>[] = [];
    for (let i = 0; i < 105; i++) {
      promises.push(request('GET', '/health', { token: null }));
    }
    const results = await Promise.all(promises);
    const got429 = results.some(r => r.status === 429);
    expect(got429).toBe(true);
  });
});

// my-beads-db-0cd.15 (reopened): the http-provider refusal used to call
// process.exit(1) from inside startKbServer, which -- called in-process, as
// this whole file already does in beforeAll -- would kill the vitest worker
// on any host whose KB config selects provider=http rather than fail a test.
// It now throws KbServerHttpProviderRefusedError instead, which this test
// pins directly: no mock, a real KB config file on disk selecting http.
describe('kb-server refuses an http project provider (my-beads-db-0cd.15)', () => {
  const KB_CONFIG_DIR = path.join(FLEET_DIR, 'knowledge');
  const KB_CONFIG_PATH = path.join(KB_CONFIG_DIR, 'config.json');
  const REFUSAL_PORT = 17879;

  beforeEach(() => {
    fs.rmSync(KB_CONFIG_PATH, { force: true });
    resetKbProviders();
  });

  afterEach(() => {
    fs.rmSync(KB_CONFIG_PATH, { force: true });
    resetKbProviders();
  });

  it('rejects with a named error before binding when the KB config selects http', async () => {
    fs.mkdirSync(KB_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(
      KB_CONFIG_PATH,
      JSON.stringify({
        provider: 'http',
        // Deliberately unreachable + obviously fake: this test never issues a
        // request, so no HTTP timeout is ever paid.
        url: 'http://kb.invalid:7878',
        token_encrypted: encryptPassword('NOT_A_REAL_KEY'),
      }, null, 2),
    );

    await expect(startKbServer(REFUSAL_PORT, false)).rejects.toThrow(KbServerHttpProviderRefusedError);
    await expect(startKbServer(REFUSAL_PORT, false)).rejects.toThrow('KB server refuses an http project provider');
  });
});
