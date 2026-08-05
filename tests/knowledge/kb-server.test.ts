import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { startKbServer } from '../../src/commands/kb-server.js';
import { FLEET_DIR } from '../../src/paths.js';
import { encryptPassword } from '../../src/utils/crypto.js';

const TEST_PORT = 17878;
const TOKEN_DIR = path.join(FLEET_DIR, 'knowledge');
const TOKEN_PATH = path.join(TOKEN_DIR, 'kb-server.token');

let server: http.Server;
let testToken: string;

function request(
  method: string,
  urlPath: string,
  opts?: { body?: any; token?: string | null }
): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const data = opts?.body ? JSON.stringify(opts.body) : undefined;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (opts?.token !== null) {
      headers['Authorization'] = `Bearer ${opts?.token ?? testToken}`;
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
