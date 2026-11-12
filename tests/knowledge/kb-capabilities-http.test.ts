import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import {
  HttpKbProvider,
  KbHttpUnsupportedError,
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
    // Refused, not queued: the server answered, it just does not serve the route.
    expect(provider.offlineQueue).toEqual([]);
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

  it('a required route is not converted: a 404 from promote stays the entry not-found', async () => {
    answers.set('/api/kb/capabilities', capabilities(['capture', 'query', 'promote']));
    await expect(provider.promote('missing-id', 'a reason long enough to pass the floor'))
      .rejects.toThrow(/^Entry not found: missing-id \(the KB server answered HTTP 404/);
  });

  it('a write queued while the server was down is dropped, loudly and unsent, when the server comes back without its route', async () => {
    const sameHost = port;
    await stop();
    await expect(provider.invalidate(['src/a.ts'])).rejects.toMatchObject({ code: 'E-KB-HTTP-UNREACHABLE', queued: true });
    expect(provider.offlineQueue.map(o => o.op)).toEqual(['invalidate']);

    answers.set('/api/kb/capabilities', capabilities(['capture', 'query', 'promote']));
    await listen(sameHost);
    seen = [];
    const stderr: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (chunk: string) => { stderr.push(String(chunk)); return true; };
    try {
      await provider.capture(entry());
    } finally {
      (process.stderr as unknown as { write: typeof write }).write = write;
    }
    expect(provider.offlineQueue).toEqual([]);
    expect(paths()).toEqual(['GET /api/kb/capabilities', 'POST /api/kb/capture']);
    expect(stderr.join('')).toMatch(/dropped a queued invalidate: E-KB-HTTP-UNSUPPORTED: the invalidate route/);
  });

  it('a capabilities answer with some fields but not all, well typed, is E-KB-HTTP-UNSUPPORTED', async () => {
    answers.set('/api/kb/capabilities', { status: 200, body: { contract: 'v1', routes: 'capture,query' } });
    const err = await provider.query({ query: 'x' }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(KbHttpUnsupportedError);
    expect((err as Error).message).toMatch(/GET \/api\/kb\/capabilities .*without \{contract, routes, branch_aware\}/);
    expect(paths()).toEqual(['GET /api/kb/capabilities']);
  });
});
