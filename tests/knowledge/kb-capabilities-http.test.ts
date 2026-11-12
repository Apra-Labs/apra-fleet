import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import {
  HttpKbProvider,
  KbHttpUnsupportedError,
  KbHttpServerError,
  KB_DEFAULT_CAPABILITIES,
} from '../../src/services/knowledge/http-provider.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

// GET /api/kb/capabilities on the client side: HttpKbProvider reads it once
// per connection (again after a reconnect), never calls a route the server
// does not list, assumes the pre-capabilities route set when the server has
// no capabilities route, and turns a 404/501 from an optional route into
// E-KB-HTTP-UNSUPPORTED naming the route.
//
// The server is a real in-process node:http server whose answers each test
// sets; every request it receives is recorded. No mocks.

const TOKEN = 'NOT_A_REAL_KEY-kb-capabilities-test';

interface Seen { method: string; path: string }
type Answer = { status: number; body: unknown };

let server: http.Server | null = null;
let port = 0;
let seen: Seen[] = [];
// Path -> answer. A path with no entry answers 404 {code: NOT_FOUND}.
let answers: Map<string, Answer> = new Map();

function listen(onPort = 0): Promise<void> {
  const s = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => { raw += c.toString(); });
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://stand-in').pathname;
      seen.push({ method: req.method ?? '', path });
      const answer = answers.get(path) ?? { status: 404, body: { error: 'Not found', code: 'NOT_FOUND' } };
      res.writeHead(answer.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    });
  });
  server = s;
  return new Promise(resolve => s.listen(onPort, '127.0.0.1', () => {
    port = (s.address() as { port: number }).port;
    resolve();
  }));
}

function stop(): Promise<void> {
  const s = server;
  server = null;
  if (!s) return Promise.resolve();
  s.closeAllConnections();
  return new Promise(resolve => s.close(() => resolve()));
}

function capabilities(routes: string[], extra: Record<string, unknown> = {}): Answer {
  return { status: 200, body: { contract: 'v1', routes, branch_aware: false, ...extra } };
}

function entry(): KBEntryInput {
  return {
    type: 'knowledge', title: 'capabilities test entry', summary: 'Entry for the capabilities test.',
    content: 'body', source_files: [], symbols: [], tags: [], content_hash: '', content_hash_type: 'sha256',
    flagged_for_review: false, author: 'test', source: 'doer', confidence: 'INFERRED',
  } as KBEntryInput;
}

const paths = () => seen.map(r => `${r.method} ${r.path}`);

let provider: HttpKbProvider;

beforeEach(async () => {
  seen = [];
  answers = new Map([
    ['/api/kb/query', { status: 200, body: { results: [], total: 0, l1_only: false } }],
    ['/api/kb/capture', { status: 201, body: { id: 'srv-1', audn_decision: 'add' } }],
    ['/api/kb/context', { status: 200, body: { results: [] } }],
    ['/api/kb/list', { status: 200, body: { results: [] } }],
    ['/api/kb/invalidate', { status: 200, body: { invalidated: 1 } }],
  ]);
  await listen();
  provider = new HttpKbProvider(`http://127.0.0.1:${port}`, TOKEN);
});

afterEach(async () => {
  provider.dispose();
  await stop();
});

describe('HttpKbProvider capabilities', () => {
  it('reads GET /api/kb/capabilities once per connection, not once per call', async () => {
    answers.set('/api/kb/capabilities', capabilities(['capture', 'query', 'promote', 'context']));
    await provider.query({ query: 'a' });
    await provider.query({ query: 'b' });
    await provider.context(['src/a.ts']);
    expect(paths()).toEqual([
      'GET /api/kb/capabilities', 'GET /api/kb/query', 'GET /api/kb/query', 'GET /api/kb/context',
    ]);
    expect(await provider.capabilities()).toEqual({
      contract: 'v1', routes: ['capture', 'query', 'promote', 'context'], branch_aware: false,
    });
  });

  it('reads the capabilities again after a reconnect, and uses the new answer', async () => {
    answers.set('/api/kb/capabilities', capabilities(['capture', 'query', 'promote']));
    await provider.query({ query: 'a' });
    const sameHost = port;
    await stop();
    await expect(provider.query({ query: 'down' })).rejects.toMatchObject({ code: 'E-KB-HTTP-UNREACHABLE' });

    // Back on the same port, now serving context too.
    answers.set('/api/kb/capabilities', capabilities(['capture', 'query', 'promote', 'context']));
    await listen(sameHost);
    seen = [];
    await provider.context(['src/a.ts']);
    expect(paths()).toEqual(['GET /api/kb/capabilities', 'GET /api/kb/context']);
  });

  it('never calls a route the server does not list: E-KB-HTTP-UNSUPPORTED naming the route, nothing sent', async () => {
    answers.set('/api/kb/capabilities', capabilities(['capture', 'query', 'promote']));
    const calls: Array<[string, () => Promise<unknown>]> = [
      ['context', () => provider.context(['src/a.ts'])],
      ['prime', () => provider.prime({ session_files: [] } as never)],
      ['invalidate', () => provider.invalidate(['src/a.ts'])],
      ['feedback', () => provider.feedback('id-1', 'wrong in practice', 'doer')],
      ['list', () => provider.list({})],
    ];
    for (const [route, call] of calls) {
      const err = await call().then(() => null, (e: unknown) => e);
      expect(err, route).toBeInstanceOf(KbHttpUnsupportedError);
      expect((err as KbHttpUnsupportedError).code).toBe('E-KB-HTTP-UNSUPPORTED');
      expect((err as Error).message).toContain(`the ${route} route`);
    }
    expect(paths()).toEqual(['GET /api/kb/capabilities']);
  });

  it('a server without the capabilities route is assumed to serve the pre-capabilities route set (no demote)', async () => {
    // No /api/kb/capabilities answer: 404.
    expect(await provider.capabilities()).toEqual({ ...KB_DEFAULT_CAPABILITIES, routes: [...KB_DEFAULT_CAPABILITIES.routes] });
    expect(KB_DEFAULT_CAPABILITIES.routes).not.toContain('demote');
    await provider.context(['src/a.ts']);
    expect(paths()).toEqual(['GET /api/kb/capabilities', 'GET /api/kb/context']);

    answers.set('/api/kb/capabilities', { status: 501, body: { title: 'Not implemented', status: 501 } });
    const other = new HttpKbProvider(`http://127.0.0.1:${port}`, TOKEN);
    try {
      expect((await other.capabilities()).routes).toEqual(KB_DEFAULT_CAPABILITIES.routes);
    } finally {
      other.dispose();
    }
  });

  it('a 404 or 501 from a listed optional route is E-KB-HTTP-UNSUPPORTED naming the route, never a raw HTTP error', async () => {
    answers.set('/api/kb/capabilities', capabilities(['capture', 'query', 'promote', 'context', 'list']));
    answers.set('/api/kb/context', { status: 501, body: { title: 'Method not supported', status: 501, code: 'E-METHOD-UNSUPPORTED' } });
    answers.delete('/api/kb/list'); // 404 NOT_FOUND
    for (const [route, call] of [
      ['context', () => provider.context(['src/a.ts'])],
      ['list', () => provider.list({})],
    ] as Array<[string, () => Promise<unknown>]>) {
      const err = await call().then(() => null, (e: unknown) => e);
      expect(err, route).toBeInstanceOf(KbHttpUnsupportedError);
      expect((err as Error).message).toMatch(new RegExp(`^E-KB-HTTP-UNSUPPORTED: the ${route} route .*HTTP (404|501)`));
    }
  });

  it('a 404 that says the ENTRY is unknown stays an entry error on an optional id route', async () => {
    answers.set('/api/kb/capabilities', capabilities(['capture', 'query', 'promote', 'feedback']));
    answers.set('/api/kb/feedback', { status: 404, body: { error: 'Entry not found: id-9', code: 'ENTRY_NOT_FOUND' } });
    const err = await provider.feedback('id-9', 'wrong in practice', 'doer').then(() => null, (e: unknown) => e);
    expect(err).not.toBeInstanceOf(KbHttpUnsupportedError);
    expect((err as NodeJS.ErrnoException).code).toBe('HTTP_404');
    expect((err as Error).message).toMatch(/Entry not found: id-9/);
  });

  it('a promote 404 whose body code is ENTRY_NOT_FOUND is the entry not-found', async () => {
    answers.set('/api/kb/capabilities', capabilities(['capture', 'query', 'promote']));
    answers.set('/api/kb/promote', { status: 404, body: { error: 'Entry not found: missing-id', code: 'ENTRY_NOT_FOUND' } });
    await expect(provider.promote('missing-id', 'a reason long enough to pass the floor'))
      .rejects.toThrow(/^Entry not found: missing-id \(the KB server answered HTTP 404/);
  });

  it('a server with no promote route (404 without ENTRY_NOT_FOUND, as kb-server v0.4.4 answers) is E-KB-HTTP-UNSUPPORTED: upgrade the KB server', async () => {
    // No capabilities route and no promote route: every path answers
    // 404 {error: 'Not found', code: 'NOT_FOUND'}, the v0.4.4 kb-server reply.
    const err = await provider.promote('some-id', 'a reason long enough to pass the floor').then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(KbHttpUnsupportedError);
    expect((err as Error).message).toMatch(/^E-KB-HTTP-UNSUPPORTED: the promote route .*HTTP 404.*nothing was promoted.*Remediation: upgrade the KB server/);
    expect((err as Error).message).not.toMatch(/Entry not found/);
    expect(paths()).toEqual(['GET /api/kb/capabilities', 'POST /api/kb/promote']);
  });

  it('a write while the capabilities read answers 503 is E-KB-HTTP-UNREACHABLE and never sent; repeated later it is sent once', async () => {
    answers.set('/api/kb/capabilities', { status: 503, body: { error: 'Service unavailable', code: 'UNAVAILABLE' } });
    const err = await provider.capture(entry()).then(() => null, (e: unknown) => e);
    expect((err as { code?: string }).code).toBe('E-KB-HTTP-UNREACHABLE');
    expect((err as Error).message).toMatch(/POST \/api\/kb\/capture: .*GET \/api\/kb\/capabilities answered HTTP 503/);
    expect((err as Error).message).not.toMatch(/queued/);
    expect(paths()).toEqual(['GET /api/kb/capabilities']);

    // Up again: a read sends only itself (nothing was kept to replay); the
    // caller repeating its capture sends it exactly once.
    answers.set('/api/kb/capabilities', capabilities(['capture', 'query', 'promote']));
    seen = [];
    await provider.query({ query: 'y' });
    await provider.capture(entry());
    expect(paths()).toEqual(['GET /api/kb/capabilities', 'GET /api/kb/query', 'POST /api/kb/capture']);
  });

  it('a capabilities read answering 403 is E-KB-HTTP-UNSUPPORTED naming the read, never a raw HTTP error', async () => {
    answers.set('/api/kb/capabilities', { status: 403, body: { error: 'Forbidden' } });
    const err = await provider.invalidate(['src/a.ts']).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(KbHttpUnsupportedError);
    expect((err as Error).message).toMatch(/^E-KB-HTTP-UNSUPPORTED: GET \/api\/kb\/capabilities .*answered HTTP 403/);
    expect(paths()).toEqual(['GET /api/kb/capabilities']);
  });

  for (const status of [500, 502, 503, 504, 429]) {
    it(`a capture answered ${status} is E-KB-HTTP-SERVER-ERROR (outcome unknown), sent once and never repeated by the provider`, async () => {
      answers.set('/api/kb/capabilities', capabilities(['capture', 'query', 'promote']));
      answers.set('/api/kb/capture', { status, body: { error: 'Server busy' } });

      const err = await provider.capture(entry()).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(KbHttpServerError);
      expect((err as Error).message).toMatch(new RegExp(`^E-KB-HTTP-SERVER-ERROR: POST /api/kb/capture: .*answered HTTP ${status}.*whether the write took effect is unknown`));

      answers.set('/api/kb/capture', { status: 201, body: { id: 'srv-1', audn_decision: 'add' } });
      await provider.query({ query: 'x' });
      expect(paths()).toEqual(['GET /api/kb/capabilities', 'POST /api/kb/capture', 'GET /api/kb/query']);
    });
  }

  it('invalidate(files), feedback, promote and demote answered 502 are each E-KB-HTTP-SERVER-ERROR, sent once', async () => {
    answers.set('/api/kb/capabilities', capabilities(['capture', 'query', 'promote', 'invalidate', 'feedback', 'demote']));
    for (const route of ['invalidate', 'feedback', 'promote', 'demote']) {
      answers.set(`/api/kb/${route}`, { status: 502, body: { error: 'Bad gateway' } });
    }
    const calls: Array<[string, () => Promise<unknown>]> = [
      ['invalidate', () => provider.invalidate(['src/a.ts'])],
      ['feedback', () => provider.feedback('id-1', 'wrong in practice', 'doer')],
      ['promote', () => provider.promote('id-1', 'a reason long enough to pass the floor')],
      ['demote', () => provider.demote('id-1', 'a reason long enough to pass the floor', ['src/a.ts'])],
    ];
    for (const [route, call] of calls) {
      const err = await call().then(() => null, (e: unknown) => e);
      expect(err, route).toBeInstanceOf(KbHttpServerError);
      expect((err as Error).message).toMatch(new RegExp(`^E-KB-HTTP-SERVER-ERROR: POST /api/kb/${route}: .*HTTP 502`));
    }
    await provider.query({ query: 'x' });
    expect(paths()).toEqual([
      'GET /api/kb/capabilities', 'POST /api/kb/invalidate', 'POST /api/kb/feedback',
      'POST /api/kb/promote', 'POST /api/kb/demote', 'GET /api/kb/query',
    ]);
  });

  it('a capabilities answer with some fields but not all, well typed, is E-KB-HTTP-UNSUPPORTED', async () => {
    answers.set('/api/kb/capabilities', { status: 200, body: { contract: 'v1', routes: 'capture,query' } });
    const err = await provider.query({ query: 'x' }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(KbHttpUnsupportedError);
    expect((err as Error).message).toMatch(/GET \/api\/kb\/capabilities .*without \{contract, routes, branch_aware\}/);
    expect(paths()).toEqual(['GET /api/kb/capabilities']);
  });
});
