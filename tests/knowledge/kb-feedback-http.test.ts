import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { resetKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { getSelfKbProviders } from '../../src/services/knowledge/kb-self.js';
import { HttpKbProvider } from '../../src/services/knowledge/http-provider.js';
import { runWithSessionMember } from '../../src/services/tool-scope.js';
import { encryptPassword } from '../../src/utils/crypto.js';
import { FLEET_DIR } from '../../src/paths.js';
import { kbFeedback } from '../../src/tools/kb-feedback.js';

// GitHub #761: kb_feedback on an HTTP-backed install, end to end. Real
// kbFeedback tool, real HttpKbProvider selected from a real http config file,
// and a real local node:http server standing in for the remote KB (no local
// store stands in for it). Nothing here is mocked.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REQUEST_SCHEMA_PATH = path.join(
  __dirname, '..', '..', 'memory-contract', 'v1', 'schemas', 'kb_feedback.request.json',
);

const QUEUED_FIXTURE_PATH = path.join(
  __dirname, '..', '..', 'memory-contract', 'v1', 'fixtures', 'kb_feedback', 'refusal-unreachable-queued.json',
);

const TOKEN_ENV_VAR = 'APRA_FLEET_TEST_KB_HTTP_TOKEN';
const TOKEN_FIXTURE_PATH = path.join(__dirname, 'fixtures', 'kb-http-test-token.txt');

function loadTestToken(): string {
  const fromEnv = process.env[TOKEN_ENV_VAR];
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  if (fs.existsSync(TOKEN_FIXTURE_PATH)) {
    const fromFile = fs.readFileSync(TOKEN_FIXTURE_PATH, 'utf-8').trim();
    if (fromFile.length > 0) return fromFile;
  }
  throw new Error(`Missing test KB token: set ${TOKEN_ENV_VAR} or provide a non-empty ${TOKEN_FIXTURE_PATH}`);
}

const KB_CONFIG_DIR = path.join(FLEET_DIR, 'knowledge');
const KB_CONFIG_PATH = path.join(KB_CONFIG_DIR, 'config.json');

interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

const SERVER_RESPONSE = { stale: true, flagged_for_review: true, confidence: 'CONFIRMED' };

let token: string;
let port = 0;
let server: http.Server | undefined;
let recorded: RecordedRequest[] = [];

function startStub(): Promise<void> {
  const s = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
    req.on('end', () => {
      const body = raw.length > 0 ? JSON.parse(raw) : undefined;
      recorded.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/api/kb/feedback' && req.method === 'POST') {
        res.end(JSON.stringify({ id: (body as { id: string }).id, ...SERVER_RESPONSE }));
      } else if (req.url?.startsWith('/api/kb/query')) {
        res.end(JSON.stringify({ results: [], total: 0, l1_only: false }));
      } else {
        res.end(JSON.stringify({}));
      }
    });
  });
  server = s;
  return new Promise<void>((resolve, reject) => {
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => {
      const address = s.address();
      if (address && typeof address !== 'string') port = address.port;
      resolve();
    });
  });
}

function stopStub(): Promise<void> {
  const s = server;
  server = undefined;
  if (!s) return Promise.resolve();
  return new Promise<void>(resolve => {
    s.close(() => resolve());
    s.closeAllConnections();
  });
}

function writeHttpConfig(): void {
  fs.mkdirSync(KB_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(
    KB_CONFIG_PATH,
    JSON.stringify({ provider: 'http', url: `http://127.0.0.1:${port}`, token_encrypted: encryptPassword(token) }, null, 2),
  );
}

const tempDirs: string[] = [];

function makeRepoPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-feedback-http-'));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'fixture.ts'), '// kb-feedback-http fixture\n');
  return dir;
}

async function httpProviderFor(folder: string): Promise<HttpKbProvider> {
  const providers = await getSelfKbProviders({ folder });
  expect(providers.project).toBeInstanceOf(HttpKbProvider);
  return providers.project as HttpKbProvider;
}

function feedbackRequests(): RecordedRequest[] {
  return recorded.filter(r => r.url === '/api/kb/feedback');
}

beforeAll(async () => {
  token = loadTestToken();
  await startStub();
});

afterAll(async () => {
  await stopStub();
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  if (!server) await startStub();
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();
  writeHttpConfig();
  recorded = [];
});

afterEach(() => {
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();
});

describe('kb_feedback over the HTTP KB provider (GitHub #761)', () => {
  it('online: POSTs a contract-valid body to /api/kb/feedback and returns the server response', async () => {
    const folder = makeRepoPath();
    const out = JSON.parse(await kbFeedback({ id: 'remote-entry-1', reason: 'Proved wrong in practice.', role: 'reviewer' }, { folder }));

    const fb = feedbackRequests();
    expect(fb).toHaveLength(1);
    expect(fb[0].method).toBe('POST');
    expect(fb[0].headers.authorization).toBe(`Bearer ${token}`);
    const schema = JSON.parse(fs.readFileSync(REQUEST_SCHEMA_PATH, 'utf-8'));
    const validate = new Ajv2020({ strict: false }).compile(schema);
    expect(validate(fb[0].body), JSON.stringify(validate.errors)).toBe(true);
    expect(fb[0].body).toEqual({ id: 'remote-entry-1', reason: 'Proved wrong in practice.', role: 'reviewer' });
    expect(out).toEqual({ id: 'remote-entry-1', ...SERVER_RESPONSE });
  });

  it('confidence untouched: the server answer is kept and no other request is sent', async () => {
    const folder = makeRepoPath();
    const out = JSON.parse(await kbFeedback({ id: 'remote-entry-0', reason: 'Wrong in practice.', role: 'doer' }, { folder }));

    expect(out).toEqual({ id: 'remote-entry-0', stale: true, flagged_for_review: true, confidence: 'CONFIRMED' });
    expect(recorded.map(r => `${r.method} ${r.url}`)).toEqual(['POST /api/kb/feedback']);
  });

  it('offline: queues the feedback, then sends it exactly once after the server is back', async () => {
    const folder = makeRepoPath();
    const provider = await httpProviderFor(folder);
    await stopStub();

    await expect(kbFeedback({ id: 'remote-entry-2', reason: 'Stale advice.', role: 'planner' }, { folder }))
      .rejects.toMatchObject({ code: 'E-KB-HTTP-UNREACHABLE', queued: true });
    expect(provider.offlineQueue).toEqual([
      { op: 'feedback', id: 'remote-entry-2', reason: 'Stale advice.', role: 'planner' },
    ]);
    expect(recorded).toHaveLength(0);

    await startStub();
    await provider.query({ query: 'anything' });
    expect(provider.offlineQueue).toHaveLength(0);
    // A further call must not resend it.
    await provider.query({ query: 'again' });

    const fb = feedbackRequests();
    expect(fb).toHaveLength(1);
    expect(fb[0].body).toEqual({ id: 'remote-entry-2', reason: 'Stale advice.', role: 'planner' });
  });

  it('the committed refusal-unreachable-queued fixture is what the real tool throws offline', async () => {
    const fixture = JSON.parse(fs.readFileSync(QUEUED_FIXTURE_PATH, 'utf-8'));
    const folder = makeRepoPath();
    const provider = await httpProviderFor(folder);
    await stopStub();

    const err = await kbFeedback(fixture.request, { folder }).then(() => null, (e: unknown) => e);

    expect((err as { code?: string }).code).toBe(fixture.expected_error_code);
    // The live port and the socket error text vary; the fixture records them
    // as port 0 and "<cause>".
    const normalized = (err as Error).message
      .replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:0')
      .replace(/is unreachable \([^)]*\)/, 'is unreachable (<cause>)');
    expect(normalized).toBe(fixture.error.message);
    expect(provider.offlineQueue).toHaveLength(1);
  });

  it('member session: E-MEMBER-VIEW-READ-ONLY and the server receives nothing', async () => {
    const err = await runWithSessionMember('member-kb-feedback-http', () =>
      kbFeedback({ id: 'remote-entry-3', reason: 'x' }),
    ).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe('E-MEMBER-VIEW-READ-ONLY');
    expect(recorded).toHaveLength(0);
  });
});
