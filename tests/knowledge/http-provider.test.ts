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
    source_files: [],
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
