import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import {
  HttpKbProvider,
  KbHttpAuthError,
  KbHttpServerError,
  KbHttpUnreachableError,
} from '../../src/services/knowledge/http-provider.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';
import { createKbWorkClient } from '../../packages/apra-fleet-se/fleet-sprint/kb.mjs';
import { fakeMaintainerSelector } from '../../packages/apra-fleet-se/test/helpers/kb-maintainer-fakes.mjs';

// The http KB provider's error mapping for an answered request:
//   - a READ (query, list, ...) answered 500, 502 or 504 is
//     E-KB-HTTP-UNREACHABLE naming the status (a read writes nothing, so it
//     is safe to repeat); a WRITE answered the same is E-KB-HTTP-SERVER-ERROR;
//   - a 429 says the server rate limited the request and names the
//     Retry-After value, never "start the KB server"; the code stays
//     E-KB-HTTP-UNREACHABLE;
//   - a literal token answered 401 is E-KB-HTTP-AUTH (reason rejected) whose
//     remediation names kb_setup, never a fleet secret, and the sprint engine
//     keeps such a write queued instead of dropping it.
//
// The server is a real in-process node:http server; no mocks.

const TOKEN = 'NOT_A_REAL_KEY-kb-error-mapping-test';

type Answer = { status: number; body: unknown; headers?: Record<string, string> };

let server: http.Server | null = null;
let port = 0;
let seen: string[] = [];
let answers: Map<string, Answer> = new Map();
// The token the server accepts; any other bearer token is answered 401.
let accepted = TOKEN;

function listen(): Promise<void> {
  const s = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://stand-in').pathname;
      seen.push(`${req.method} ${path}`);
      if (req.headers.authorization !== `Bearer ${accepted}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      const answer = answers.get(path) ?? { status: 404, body: { error: 'Not found', code: 'NOT_FOUND' } };
      res.writeHead(answer.status, { 'Content-Type': 'application/json', ...(answer.headers ?? {}) });
      res.end(JSON.stringify(answer.body));
    });
  });
  server = s;
  return new Promise(resolve => s.listen(0, '127.0.0.1', () => {
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

function entry(title = 'error mapping entry'): KBEntryInput {
  return {
    type: 'knowledge', title, summary: 'Entry for the error mapping test.',
    content: 'body', source_files: [], symbols: [], tags: [], content_hash: '', content_hash_type: 'sha256',
    flagged_for_review: false, author: 'test', source: 'doer', confidence: 'INFERRED',
  } as KBEntryInput;
}

const failure = (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (e: unknown) => e);

let provider: HttpKbProvider;

beforeEach(async () => {
  seen = [];
  accepted = TOKEN;
  answers = new Map([
    ['/api/kb/capabilities', { status: 200, body: { contract: 'v1', routes: ['capture', 'query', 'promote', 'list'], branch_aware: false } }],
    ['/api/kb/query', { status: 200, body: { results: [], total: 0, l1_only: false } }],
    ['/api/kb/list', { status: 200, body: { results: [] } }],
    ['/api/kb/capture', { status: 201, body: { id: 'srv-1', audn_decision: 'add' } }],
  ]);
  await listen();
  provider = new HttpKbProvider(`http://127.0.0.1:${port}`, TOKEN);
});

afterEach(async () => {
  provider.dispose();
  await stop();
});

describe('a read answered 5xx is retryable E-KB-HTTP-UNREACHABLE; a write stays E-KB-HTTP-SERVER-ERROR', () => {
  for (const status of [500, 502, 504]) {
    it(`kb_query and kb_list reads answered ${status} are E-KB-HTTP-UNREACHABLE naming the status`, async () => {
      answers.set('/api/kb/query', { status, body: { error: 'Server error' } });
      answers.set('/api/kb/list', { status, body: { error: 'Server error' } });

      for (const [route, method, call] of [
        ['query', 'GET', () => provider.query({ query: 'x' })],
        ['list', 'GET', () => provider.list({})],
      ] as const) {
        const err = await failure(call());
        expect(err, route).toBeInstanceOf(KbHttpUnreachableError);
        expect((err as KbHttpUnreachableError).code, route).toBe('E-KB-HTTP-UNREACHABLE');
        expect((err as Error).message, route).toMatch(new RegExp(`^E-KB-HTTP-UNREACHABLE: ${method} /api/kb/${route}: .*HTTP ${status}`));
        expect((err as Error).message, route).not.toMatch(/rate limited/);
      }
    });

    it(`a kb_capture write answered ${status} is still E-KB-HTTP-SERVER-ERROR`, async () => {
      answers.set('/api/kb/capture', { status, body: { error: 'Server error' } });
      const err = await failure(provider.capture(entry()));
      expect(err).toBeInstanceOf(KbHttpServerError);
      expect((err as KbHttpServerError).code).toBe('E-KB-HTTP-SERVER-ERROR');
      expect((err as Error).message).toMatch(new RegExp(`^E-KB-HTTP-SERVER-ERROR: POST /api/kb/capture: .*HTTP ${status}.*whether the write took effect is unknown`));
    });
  }
});

describe('a 429 says the server rate limited the request and names Retry-After', () => {
  it('a read answered 429 with Retry-After: 30', async () => {
    answers.set('/api/kb/query', { status: 429, body: { error: 'Rate limit exceeded' }, headers: { 'Retry-After': '30' } });
    const err = await failure(provider.query({ query: 'x' }));
    expect(err).toBeInstanceOf(KbHttpUnreachableError);
    expect((err as KbHttpUnreachableError).code).toBe('E-KB-HTTP-UNREACHABLE');
    const message = (err as Error).message;
    expect(message).toMatch(/^E-KB-HTTP-UNREACHABLE: GET \/api\/kb\/query: .*rate limited the request/);
    expect(message).toContain('Retry-After: 30');
    expect(message).toContain('30');
    expect(message).not.toMatch(/start the KB server/);
    expect(message).not.toMatch(/is unreachable/);
    expect((err as KbHttpUnreachableError).rateLimit).toEqual({ retryAfter: '30' });
  });

  it('a write answered 429 with Retry-After: 30', async () => {
    answers.set('/api/kb/capture', { status: 429, body: { error: 'Rate limit exceeded' }, headers: { 'Retry-After': '30' } });
    const err = await failure(provider.capture(entry()));
    expect(err).toBeInstanceOf(KbHttpUnreachableError);
    const message = (err as Error).message;
    expect(message).toMatch(/^E-KB-HTTP-UNREACHABLE: POST \/api\/kb\/capture: .*rate limited the request/);
    expect(message).toContain('Retry-After: 30');
    expect(message).not.toMatch(/start the KB server/);
  });

  it('a capabilities read answered 429 names the caller\'s request and keeps the rate-limit message', async () => {
    answers.set('/api/kb/capabilities', { status: 429, body: { error: 'Rate limit exceeded' }, headers: { 'Retry-After': '30' } });
    const err = await failure(provider.query({ query: 'x' }));
    expect(err).toBeInstanceOf(KbHttpUnreachableError);
    const message = (err as Error).message;
    expect(message).toMatch(/^E-KB-HTTP-UNREACHABLE: GET \/api\/kb\/query: .*rate limited the request/);
    expect(message).toContain('Retry-After: 30');
    expect(message).not.toMatch(/start the KB server/);
    expect(seen).toEqual(['GET /api/kb/capabilities']);
  });

  it('a 429 without Retry-After still says rate limited and names no Retry-After', async () => {
    answers.set('/api/kb/query', { status: 429, body: { error: 'Rate limit exceeded' } });
    const message = ((await failure(provider.query({ query: 'x' }))) as Error).message;
    expect(message).toMatch(/rate limited the request/);
    expect(message).not.toMatch(/Retry-After/);
    expect(message).not.toMatch(/start the KB server/);
  });

  it('an unusable Retry-After value (over 64 characters) is dropped, never quoted', async () => {
    answers.set('/api/kb/query', { status: 429, body: { error: 'Rate limit exceeded' }, headers: { 'Retry-After': 'x'.repeat(200) } });
    const message = ((await failure(provider.query({ query: 'x' }))) as Error).message;
    expect(message).toMatch(/rate limited the request/);
    expect(message).not.toMatch(/Retry-After/);
  });

  it('a 503 is still the unreachable wording (not rate limited)', async () => {
    answers.set('/api/kb/query', { status: 503, body: { error: 'Restarting' } });
    const message = ((await failure(provider.query({ query: 'x' }))) as Error).message;
    expect(message).toMatch(/is unreachable/);
    expect(message).not.toMatch(/rate limited/);
  });
});

describe('a literal token answered 401 is E-KB-HTTP-AUTH', () => {
  it('read and write: code E-KB-HTTP-AUTH, reason rejected, no retry, remediation names kb_setup and no fleet secret', async () => {
    // Capabilities read with the accepted token first, so the 401 answers the
    // route request itself.
    await provider.query({ query: 'warm' });
    accepted = 'NOT_A_REAL_KEY-some-other-token';
    for (const [route, request, call] of [
      ['capture', 'POST /api/kb/capture', () => provider.capture(entry())],
      ['query', 'GET /api/kb/query', () => provider.query({ query: 'x' })],
    ] as const) {
      seen = [];
      const err = await failure(call());
      expect(err, route).toBeInstanceOf(KbHttpAuthError);
      const auth = err as KbHttpAuthError;
      expect(auth.code, route).toBe('E-KB-HTTP-AUTH');
      expect(auth.reason, route).toBe('rejected');
      expect(auth.secretName, route).toBeUndefined();
      expect(auth.remediation, route).toContain('kb_setup');
      expect(auth.remediation, route).not.toMatch(/secret/);
      expect(auth.message, route).not.toMatch(/secret --set|fleet secret/);
      expect(auth.message, route).not.toContain(TOKEN);
      // Sent once: a literal value cannot change between attempts.
      expect(seen, route).toEqual([request]);
    }
  });
});

// Provider and sprint engine together: the engine keeps a write whose tool
// result carries E-KB-HTTP-AUTH queued (the server never handled it) and
// applies it on the next flush once the token is accepted.
describe('sprint engine over HttpKbProvider: a literal-token 401 write stays queued', () => {
  const REPO = 'github.com/org/repo-a';
  const MAINT = Object.freeze({ id: 'id-maint-a', name: 'maint-a', type: 'remote' });

  it('kept queued with the write behind it, not dropped as rejected; the next flush sends both', async () => {
    const logs: string[] = [];
    const kb = createKbWorkClient({
      maintainers: fakeMaintainerSelector({
        repoOf: { 'doer-a': REPO, 'maint-a': REPO },
        maintainerOf: { [REPO]: MAINT },
      }),
      // The maintainer's kb_capture tool, reduced to the provider call: a
      // thrown provider error is the tool's isError result.
      memberCall: async (_member: unknown, tool: string, args: Record<string, unknown>) => {
        if (tool !== 'kb_capture') return {};
        try {
          return await provider.capture(entry(String(args.title)));
        } catch (e) {
          return { isError: true, content: [{ type: 'text', text: (e as Error).message }] };
        }
      },
      gPull: async () => {},
      log: (m: string) => logs.push(m),
    });
    const capture = (title: string) => ({
      type: 'knowledge', title, summary: 'The widget cache is keyed per tenant id.',
      content: 'src/widget-cache.ts builds its key from the tenant and the id.', source_files: ['src/widget-cache.ts'],
    });

    accepted = 'NOT_A_REAL_KEY-some-other-token';
    const out = await kb.apply('doer', 'doer-a', { kb_captures: [capture('first'), capture('second')] });
    expect(out.captured).toBe(0);
    expect(kb.pendingCount(REPO)).toBe(2);
    expect(logs.some(l => l.startsWith('[kb-work] WARN: KB server token refused during kb_capture for "first"')), JSON.stringify(logs)).toBe(true);
    expect(logs.some(l => /non-fatal/.test(l)), JSON.stringify(logs)).toBe(false);

    accepted = TOKEN;
    const later = await kb.flushAll();
    expect(later.captured).toBe(2);
    expect(kb.pendingCount()).toBe(0);
  });
});
