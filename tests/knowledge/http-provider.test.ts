import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import { HttpKbProvider, KbHttpUnreachableError } from '../../src/services/knowledge/http-provider.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

const MOCK_PORT = 27878;
const MOCK_TOKEN = 'test-http-provider-token';
const OFFLINE_URL = 'http://127.0.0.1:17777'; // nothing listens here

/** Awaits a write that must fail with E-KB-HTTP-UNREACHABLE, saying nothing was written. */
async function expectUnreachable(write: Promise<unknown>): Promise<void> {
  const err = await write.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(KbHttpUnreachableError);
  expect((err as KbHttpUnreachableError).code).toBe('E-KB-HTTP-UNREACHABLE');
  expect((err as Error).message).toMatch(/nothing was read or written/);
  expect((err as Error).message).not.toMatch(/queued/);
}

function makeInput(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'learning',
    title: 'Test entry',
    summary: 'Test summary',
    content: 'Test content',
    source_files: ['src/fixture.ts'],
    symbols: [],
    tags: [],
    content_hash: '',
    content_hash_type: 'sha256',
    flagged_for_review: false,
    author: 'test',
    source: 'doer',
    confidence: 'INFERRED',
    ...overrides,
  };
}

// Lightweight mock server that records capture requests
let mockServer: http.Server;
const captureRequests: KBEntryInput[] = [];
const queryUrls: string[] = [];
const feedbackRequests: Array<{ body: Record<string, unknown>; headers: http.IncomingHttpHeaders }> = [];
// Ordered "METHOD path" of every authorised write, to check replay order.
const writeLog: string[] = [];

beforeAll(async () => {
  mockServer = http.createServer((req, res) => {
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${MOCK_TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized', code: 'UNAUTHORIZED' }));
      return;
    }

    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      const url = req.url ?? '';
      const method = req.method ?? 'GET';

      if (method === 'POST') writeLog.push(`POST ${url}`);
      if (url === '/api/kb/capture' && method === 'POST') {
        const input = JSON.parse(body) as KBEntryInput;
        captureRequests.push(input);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'server-id-123', audn_decision: 'add' }));
      } else if (url.startsWith('/api/kb/query') && method === 'GET') {
        queryUrls.push(url);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results: [], total: 0, l1_only: false }));
      } else if (url === '/api/kb/invalidate' && method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ invalidated: 1 }));
      } else if (url === '/api/kb/feedback' && method === 'POST') {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        feedbackRequests.push({ body: parsed, headers: req.headers });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: parsed.id, stale: true, flagged_for_review: true, confidence: 'CONFIRMED' }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    });
  });

  await new Promise<void>(resolve => mockServer.listen(MOCK_PORT, '127.0.0.1', resolve));
});

afterAll(async () => {
  await new Promise<void>(resolve => mockServer.close(() => resolve()));
});

beforeEach(() => {
  captureRequests.length = 0;
  queryUrls.length = 0;
  feedbackRequests.length = 0;
  writeLog.length = 0;
});

describe('HttpKbProvider', () => {
  it('forwards the kb_query trust filters to the server, and only when set', async () => {
    const provider = new HttpKbProvider(`http://127.0.0.1:${MOCK_PORT}`, MOCK_TOKEN);
    await provider.init();

    try {
      await provider.query({ query: 'x', confidence: ['CONFIRMED', 'INFERRED'], exclude_disputed: true });
      await provider.query({ query: 'x' });
      expect(queryUrls).toHaveLength(2);
      const filtered = new URL(queryUrls[0], 'http://h').searchParams;
      expect(filtered.get('confidence')).toBe('CONFIRMED,INFERRED');
      expect(filtered.get('exclude_disputed')).toBe('true');
      const plain = new URL(queryUrls[1], 'http://h').searchParams;
      expect(plain.has('confidence')).toBe(false);
      expect(plain.has('exclude_disputed')).toBe(false);
    } finally {
      provider.dispose();
    }
  });

  it('proxy success: capture forwarded to server', async () => {
    const provider = new HttpKbProvider(
      `http://127.0.0.1:${MOCK_PORT}`, MOCK_TOKEN
    );
    await provider.init();

    try {
      const result = await provider.capture(makeInput({ title: 'Proxy test' }));
      expect(result.id).toBe('server-id-123');
      expect(result.audn_decision).toBe('add');
      expect(captureRequests).toHaveLength(1);
      expect(captureRequests[0].title).toBe('Proxy test');
    } finally {
      provider.dispose();
    }
  });

  it('server down: every read fails with E-KB-HTTP-UNREACHABLE, never answered from a local store', async () => {
    const provider = new HttpKbProvider(OFFLINE_URL, MOCK_TOKEN);
    await provider.init();

    try {
      for (const read of [
        () => provider.query({}),
        () => provider.context(['src/a.ts']),
        () => provider.prime({ session_files: [] } as any),
        () => provider.list({}),
        () => provider.promote('some-id', 'a reason long enough to pass the floor'),
      ]) {
        const err = await read().then(() => null, (e: unknown) => e);
        expect(err).toBeInstanceOf(KbHttpUnreachableError);
        expect((err as Error).message).toMatch(/^E-KB-HTTP-UNREACHABLE: .*127.0.0.1:17777.*nothing was read or written/);
      }
      // No local store stands in for the server.
      expect(await provider.touch(['x'])).toBe(0);
      expect(await provider.getLinked('x')).toEqual([]);
      expect(await provider.relatedClaims(['x'])).toEqual([]);
    } finally {
      provider.dispose();
    }
  });

  it('server down: every write fails with E-KB-HTTP-UNREACHABLE and is never sent later', async () => {
    const provider = new HttpKbProvider(OFFLINE_URL, MOCK_TOKEN);
    await provider.init();

    try {
      await expectUnreachable(provider.capture(makeInput({ title: 'never replayed' })));
      await expectUnreachable(provider.feedback('entry-2', 'stale advice', 'doer'));
      await expectUnreachable(provider.invalidate(['src/a.ts']));

      // The server comes back: the next call sends only itself. No write
      // failed earlier is replayed; repeating one is the caller's decision.
      (provider as any).baseUrl = `http://127.0.0.1:${MOCK_PORT}`;
      await provider.query({});
      await provider.capture(makeInput({ title: 'sent now' }));

      expect(writeLog).toEqual(['POST /api/kb/capture']);
      expect(captureRequests.map(r => r.title)).toEqual(['sent now']);
      expect(feedbackRequests).toHaveLength(0);
    } finally {
      provider.dispose();
    }
  });

  it('feedback: POSTs {id, reason, role} to /api/kb/feedback and returns the server body as is', async () => {
    const provider = new HttpKbProvider(`http://127.0.0.1:${MOCK_PORT}`, MOCK_TOKEN);
    await provider.init();
    try {
      const result = await provider.feedback('entry-1', 'wrong in practice', 'reviewer');
      expect(feedbackRequests).toHaveLength(1);
      expect(feedbackRequests[0].body).toEqual({ id: 'entry-1', reason: 'wrong in practice', role: 'reviewer' });
      expect(feedbackRequests[0].headers.authorization).toBe(`Bearer ${MOCK_TOKEN}`);
      // The server's confidence is passed through untouched.
      expect(result).toEqual({ id: 'entry-1', stale: true, flagged_for_review: true, confidence: 'CONFIRMED' });
    } finally {
      provider.dispose();
    }
  });
});
