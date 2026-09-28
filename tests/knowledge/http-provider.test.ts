import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import { HttpKbProvider } from '../../src/services/knowledge/http-provider.js';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

const MOCK_PORT = 27878;
const MOCK_TOKEN = 'test-http-provider-token';
const OFFLINE_URL = 'http://127.0.0.1:17777'; // nothing listens here

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

      if (url === '/api/kb/capture' && method === 'POST') {
        const input = JSON.parse(body) as KBEntryInput;
        captureRequests.push(input);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'server-id-123', audn_decision: 'add' }));
      } else if (url.startsWith('/api/kb/query') && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results: [], total: 0, l1_only: false }));
      } else if (url === '/api/kb/invalidate' && method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ invalidated: 1 }));
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
});

describe('HttpKbProvider', () => {
  it('proxy success: capture forwarded to server', async () => {
    const fallback = new SqliteProvider(':memory:');
    await fallback.init();
    const provider = new HttpKbProvider(
      `http://127.0.0.1:${MOCK_PORT}`, MOCK_TOKEN, fallback
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

  it('offline read fallback: server down, reads served from local SqliteProvider', async () => {
    const fallback = new SqliteProvider(':memory:');
    await fallback.init();
    await fallback.capture(makeInput({ title: 'Local-only entry' }));

    const provider = new HttpKbProvider(OFFLINE_URL, MOCK_TOKEN, fallback);
    await provider.init();

    try {
      const result = await provider.query({});
      expect(result.results.length).toBe(1);
      expect(result.results[0].title).toBe('Local-only entry');
    } finally {
      provider.dispose();
    }
  });

  it('offline write queue: server down, capture queued', async () => {
    const fallback = new SqliteProvider(':memory:');
    await fallback.init();
    const provider = new HttpKbProvider(OFFLINE_URL, MOCK_TOKEN, fallback);
    await provider.init();

    try {
      const result = await provider.capture(makeInput({ title: 'Queued entry' }));
      // Returns synthetic offline id
      expect(result.id).toContain('offline-');
      expect(result.audn_decision).toBe('add');
      // Entry is in the queue
      expect(provider.offlineQueue.length).toBe(1);
      const op = provider.offlineQueue[0] as { op: string; input: KBEntryInput };
      expect(op.op).toBe('capture');
      expect(op.input.title).toBe('Queued entry');
    } finally {
      provider.dispose();
    }
  });

  it('queue flush: server comes back, queued writes flushed to server', async () => {
    const fallback = new SqliteProvider(':memory:');
    await fallback.init();

    // Start pointing at offline URL
    const provider = new HttpKbProvider(OFFLINE_URL, MOCK_TOKEN, fallback);
    await provider.init();

    try {
      // Queue a capture while offline
      await provider.capture(makeInput({ title: 'Will be flushed' }));
      expect(provider.offlineQueue.length).toBe(1);

      // Simulate server coming back -- point to mock server
      (provider as any).baseUrl = `http://127.0.0.1:${MOCK_PORT}`;

      // Next request triggers flush
      await provider.query({});

      // Queue should now be empty
      expect(provider.offlineQueue.length).toBe(0);
      // Server received the queued capture
      expect(captureRequests.some(r => r.title === 'Will be flushed')).toBe(true);
    } finally {
      provider.dispose();
    }
  });

  it('queue overflow: 1001 writes drop oldest, warning logged', async () => {
    const stderrLines: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: string, ...rest: unknown[]) => {
      stderrLines.push(typeof s === 'string' ? s : String(s));
      return origWrite(s as any, ...(rest as any[]));
    };

    try {
      const fallback = new SqliteProvider(':memory:');
      await fallback.init();
      const provider = new HttpKbProvider(OFFLINE_URL, MOCK_TOKEN, fallback);
      await provider.init();

      try {
        for (let i = 0; i < 1001; i++) {
          await provider.capture(makeInput({ title: `Entry ${i}` }));
        }

        expect(provider.offlineQueue.length).toBe(1000);
        const first = provider.offlineQueue[0] as { op: string; input: KBEntryInput };
        expect(first.input.title).toBe('Entry 1'); // Entry 0 was dropped
        expect(stderrLines.some(l => l.includes('offline queue full'))).toBe(true);
      } finally {
        provider.dispose();
      }
    } finally {
      (process.stderr as any).write = origWrite;
    }
  });

  it('degraded signal: offline read warns to stderr naming the remote URL and error, and stats() reports degraded', async () => {
    const stderrLines: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: string, ...rest: unknown[]) => {
      stderrLines.push(typeof s === 'string' ? s : String(s));
      return origWrite(s as any, ...(rest as any[]));
    };

    try {
      const fallback = new SqliteProvider(':memory:');
      await fallback.init();
      const provider = new HttpKbProvider(OFFLINE_URL, MOCK_TOKEN, fallback);
      await provider.init();

      try {
        // apra-fleet-i9ag.15.13: before any request, the provider must not
        // claim to be degraded -- it has not tried to reach the remote yet.
        const preStats = await provider.stats();
        expect(preStats.degraded).toBe(false);

        // A read against an unreachable configured remote must be an
        // observable signal, not a silent local read: a stderr warning naming
        // the remote URL and the connection error...
        await provider.query({});
        const warning = stderrLines.find(
          l => l.includes('[KB] WARNING: remote KB server at') && l.includes(OFFLINE_URL)
        );
        expect(warning).toBeDefined();
        expect(warning).toContain('unreachable');

        // ...and an inspectable degraded state via stats() (kb_stats), not
        // just a one-time stderr line a later caller can't see.
        const stats = await provider.stats();
        expect(stats.degraded).toBe(true);
        expect(stats.remote_url).toBe(OFFLINE_URL);
        expect(stats.degraded_reason).toBeTruthy();
        expect(stats.degraded_since).toBeTruthy();

        // The warning fires once per drop, not once per call.
        const warningCountAfterFirst = stderrLines.filter(l => l.includes('is unreachable')).length;
        await provider.query({});
        const warningCountAfterSecond = stderrLines.filter(l => l.includes('is unreachable')).length;
        expect(warningCountAfterSecond).toBe(warningCountAfterFirst);
      } finally {
        provider.dispose();
      }
    } finally {
      (process.stderr as any).write = origWrite;
    }
  });

  it('degraded signal: reconnecting to a live server clears degraded state and re-arms the warning', async () => {
    const stderrLines: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: string, ...rest: unknown[]) => {
      stderrLines.push(typeof s === 'string' ? s : String(s));
      return origWrite(s as any, ...(rest as any[]));
    };

    try {
      const fallback = new SqliteProvider(':memory:');
      await fallback.init();
      const provider = new HttpKbProvider(OFFLINE_URL, MOCK_TOKEN, fallback);
      await provider.init();

      try {
        await provider.query({});
        expect((await provider.stats()).degraded).toBe(true);

        // Server comes back.
        (provider as any).baseUrl = `http://127.0.0.1:${MOCK_PORT}`;
        await provider.query({});

        const reconnected = await provider.stats();
        expect(reconnected.degraded).toBe(false);
        expect(reconnected.degraded_reason).toBeUndefined();
        expect(stderrLines.some(l => l.includes('Reconnected to remote KB server'))).toBe(true);
      } finally {
        provider.dispose();
      }
    } finally {
      (process.stderr as any).write = origWrite;
    }
  });

  // apra-fleet-i9ag.15.13.3: the once-per-drop dedupe (hasWarnedDegraded) must
  // reset on reconnect, not just clear degraded/stats(). Otherwise a SECOND,
  // independent outage after a successful reconnect would stay silent forever
  // -- exactly the "implicit environment decides behaviour, failure is
  // silent" shape CLAUDE.md forbids. This pins that the tracker genuinely
  // resets rather than the first test's single-drop count happening to match.
  it('degraded signal: the warning fires again after a reconnect is followed by a second, independent drop', async () => {
    const stderrLines: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: string, ...rest: unknown[]) => {
      stderrLines.push(typeof s === 'string' ? s : String(s));
      return origWrite(s as any, ...(rest as any[]));
    };

    try {
      const fallback = new SqliteProvider(':memory:');
      await fallback.init();
      const provider = new HttpKbProvider(OFFLINE_URL, MOCK_TOKEN, fallback);
      await provider.init();

      try {
        // First drop: warns once.
        await provider.query({});
        const countAfterFirstDrop = stderrLines.filter(l => l.includes('is unreachable')).length;
        expect(countAfterFirstDrop).toBe(1);

        // Reconnect: degraded clears, warning re-arms.
        (provider as any).baseUrl = `http://127.0.0.1:${MOCK_PORT}`;
        await provider.query({});
        expect((await provider.stats()).degraded).toBe(false);

        // Second, independent drop: must warn AGAIN, not stay silent because
        // hasWarnedDegraded was never reset.
        (provider as any).baseUrl = OFFLINE_URL;
        await provider.query({});
        const countAfterSecondDrop = stderrLines.filter(l => l.includes('is unreachable')).length;
        expect(countAfterSecondDrop).toBe(2);
        expect((await provider.stats()).degraded).toBe(true);
      } finally {
        provider.dispose();
      }
    } finally {
      (process.stderr as any).write = origWrite;
    }
  });

  // apra-fleet-i9ag.15.13.3: kb_stats must not be stuck reporting degraded on
  // a provider that has always been healthy -- the flag is inspectable state,
  // not a one-way latch.
  it('degraded signal: kb_stats on a healthy http provider reports degraded false', async () => {
    const fallback = new SqliteProvider(':memory:');
    await fallback.init();
    const provider = new HttpKbProvider(
      `http://127.0.0.1:${MOCK_PORT}`, MOCK_TOKEN, fallback
    );
    await provider.init();

    try {
      await provider.query({});
      const stats = await provider.stats();
      expect(stats.degraded).toBe(false);
      expect(stats.degraded_reason).toBeUndefined();
      expect(stats.degraded_since).toBeUndefined();
    } finally {
      provider.dispose();
    }
  });

  // apra-fleet-i9ag.15.13.2/.3: strict mode (offline_fallback: "error") is the
  // hard-fail half of this bead -- every read AND write path must reject
  // rather than silently serving/queuing against the local fallback, and each
  // rejection must name the configured remote and the underlying connection
  // error so a caller can tell this apart from any other thrown error. A test
  // that merely tolerates either outcome (reject OR silently-local) proves
  // nothing, so every assertion below is an explicit `.rejects`.
  it('strict mode: remote refusing connections -- init, query, context, getLinked, prime and a write all reject naming the remote and the connection error', async () => {
    const fallback = new SqliteProvider(':memory:');
    await fallback.init();
    const provider = new HttpKbProvider(OFFLINE_URL, MOCK_TOKEN, fallback, 'error');

    try {
      const assertStrictRejection = async (p: Promise<unknown>) => {
        await expect(p).rejects.toThrow(
          new RegExp(`${OFFLINE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*unreachable`, 's')
        );
      };

      await assertStrictRejection(provider.init());
      await assertStrictRejection(provider.query({}));
      await assertStrictRejection(provider.context(['src/fixture.ts']));
      await assertStrictRejection(provider.getLinked('some-id'));
      await assertStrictRejection(provider.prime({}));
      await assertStrictRejection(provider.capture(makeInput({ title: 'Strict write' })));

      // Never silently local: no read above must have populated the fallback
      // query path, and no write above must have been queued for later flush.
      expect(provider.offlineQueue.length).toBe(0);
    } finally {
      provider.dispose();
    }
  });

  // Strict mode must not change behaviour for a reachable remote -- it only
  // changes what happens when the remote is unreachable.
  it('strict mode: reachable remote behaves normally (init succeeds, capture forwarded)', async () => {
    const fallback = new SqliteProvider(':memory:');
    await fallback.init();
    const provider = new HttpKbProvider(
      `http://127.0.0.1:${MOCK_PORT}`, MOCK_TOKEN, fallback, 'error'
    );

    try {
      await expect(provider.init()).resolves.toBeUndefined();
      const result = await provider.capture(makeInput({ title: 'Strict but reachable' }));
      expect(result.id).toBe('server-id-123');
      expect(captureRequests.some(r => r.title === 'Strict but reachable')).toBe(true);
      const stats = await provider.stats();
      expect(stats.degraded).toBe(false);
    } finally {
      provider.dispose();
    }
  });

  it('beforeExit warning: queue has entries, warning emitted to stderr', async () => {
    const stderrLines: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: string, ...rest: unknown[]) => {
      stderrLines.push(typeof s === 'string' ? s : String(s));
      return origWrite(s as any, ...(rest as any[]));
    };

    try {
      const fallback = new SqliteProvider(':memory:');
      await fallback.init();
      const provider = new HttpKbProvider(OFFLINE_URL, MOCK_TOKEN, fallback);
      await provider.init();

      try {
        // Queue one entry
        await provider.capture(makeInput({ title: 'Unsaved entry' }));
        expect(provider.offlineQueue.length).toBe(1);

        // Trigger beforeExit handlers
        process.emit('beforeExit', 0);

        const hasWarning = stderrLines.some(
          l => l.includes('[KB] WARNING: offline queue has') && l.includes('unsaved captures')
        );
        expect(hasWarning).toBe(true);
      } finally {
        provider.dispose();
      }
    } finally {
      (process.stderr as any).write = origWrite;
    }
  });
});
