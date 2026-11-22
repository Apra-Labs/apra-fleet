import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { HttpKbProvider, KB_DEFAULT_CAPABILITIES, KB_PROJECT_HEADER, KB_REQUIRED_ROUTES, KB_OPTIONAL_ROUTES } from '../../src/services/knowledge/http-provider.js';
import { KB_LOCAL_CAPABILITIES } from '../../src/services/knowledge/kb-local-capabilities.js';
import { startKbServer, KB_SERVER_CAPABILITIES } from '../../src/commands/kb-server.js';
import { getProjectSlug } from '../../src/services/knowledge/kb-providers.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import { kbCapabilities } from '../../src/tools/kb-capabilities.js';
import { registerAllTools } from '../../src/services/tool-registry.js';
import { KB_REMOVED_SCOPE_KEYS } from '../../src/services/knowledge/kb-removed-scope-keys.js';

// kb_capabilities end to end: what the calling session's project KB serves,
// in the shape of GET /api/kb/capabilities.
//
// Every provider here is REAL: the sample kb-server (startKbServer) on a
// sandboxed database, an in-process node:http server whose answer each test
// sets, and a SqliteProvider on a temp file. The only stand-in is the
// getKbProviders spy that hands the real provider to the tool (the same
// wiring seam tests/knowledge/kb-query-cited-filter.test.ts uses), so no
// global KB config is written.
//
// FALSIFICATION: on a tree without src/tools/kb-capabilities.ts (main before
// this tool) the file fails to import; returning the normalized
// HttpKbProvider.capabilities() view instead of capabilitiesBody() fails the
// non-normalized pass-through test (the unknown route and the extra field
// are dropped).

const ANCHOR = { folder: os.tmpdir() };

function useProject(project: unknown): void {
  vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({ project, global: project, projectSlug: 'kb-capabilities-tool' } as any);
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1 and 5: the sample kb-server and the SQLite answer.

describe('kb_capabilities against the sample kb-server and a SQLite KB', () => {
  const TOKEN = 'NOT_A_REAL_KEY-kb-capabilities-tool-test';
  const project = getProjectSlug();
  let tmp: string;
  let server: http.Server;
  let serverUrl: string;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-capabilities-tool-'));
    const tokenFile = path.join(tmp, 'token.txt');
    fs.writeFileSync(tokenFile, TOKEN, { mode: 0o600 });
    server = await startKbServer(0, false, path.join(tmp, 'kb.sqlite'), tokenFile);
    serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** A direct GET /api/kb/capabilities with the same token and project header the provider sends. */
  function directGet(): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const req = http.request(`${serverUrl}/api/kb/capabilities`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${TOKEN}`, [KB_PROJECT_HEADER]: project },
      }, res => {
        let body = '';
        res.on('data', (c: Buffer) => { body += c.toString(); });
        res.on('end', () => {
          if (res.statusCode !== 200) reject(new Error(`direct GET answered ${res.statusCode}: ${body}`));
          else resolve(JSON.parse(body));
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('HTTP: returns exactly what the sample kb-server answers on GET /api/kb/capabilities', async () => {
    const provider = new HttpKbProvider(serverUrl, TOKEN, { projectSlug: project });
    try {
      useProject(provider);
      const viaTool = JSON.parse(await kbCapabilities({}, ANCHOR));
      const direct = await directGet();
      expect(viaTool).toEqual(direct);
      // Non-vacuous: the server's answer carries the routes the default set lacks.
      expect(viaTool.routes).toEqual(expect.arrayContaining(['demote', 'withdraw']));
    } finally {
      provider.dispose();
    }
  });

  it('local capabilities list exactly the contract routes (KB_REQUIRED_ROUTES + KB_OPTIONAL_ROUTES)', () => {
    expect([...KB_LOCAL_CAPABILITIES.routes].sort()).toEqual([...KB_REQUIRED_ROUTES, ...KB_OPTIONAL_ROUTES].sort());
  });

  it('SQLite: every route incl. demote and withdraw, branch_aware false, query_filters files+symbols -- the sample kb-server answer', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-capabilities-sqlite-'));
    const provider = new SqliteProvider(path.join(dir, 'kb.sqlite'));
    try {
      await provider.init();
      useProject(provider);
      const caps = JSON.parse(await kbCapabilities({}, ANCHOR));
      expect(caps.contract).toBe('v1');
      expect(caps.routes).toEqual(expect.arrayContaining(['withdraw', 'demote']));
      expect(caps.branch_aware).toBe(false);
      expect(caps.query_filters).toEqual(['files', 'symbols']);
      // Single source: the same value the sample kb-server answers.
      expect(caps).toEqual(JSON.parse(JSON.stringify(KB_SERVER_CAPABILITIES)));
      expect(caps).toEqual(await directGet());
    } finally {
      provider.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 2, 3, 4: an in-process server whose capabilities answer each test sets.

describe('kb_capabilities over HTTP against a server whose capabilities answer the test sets', () => {
  const TOKEN = 'NOT_A_REAL_KEY-kb-capabilities-tool-stub';
  let server: http.Server;
  let port = 0;
  let answer: { status: number; body: unknown };
  let provider: HttpKbProvider;

  beforeEach(async () => {
    answer = { status: 404, body: { error: 'Not found', code: 'NOT_FOUND' } };
    server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const route = new URL(req.url ?? '/', 'http://stand-in').pathname;
        const a = route === '/api/kb/capabilities' ? answer : { status: 404, body: { error: 'Not found', code: 'NOT_FOUND' } };
        res.writeHead(a.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(a.body));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
    provider = new HttpKbProvider(`http://127.0.0.1:${port}`, TOKEN);
    useProject(provider);
  });

  afterEach(async () => {
    provider.dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('passes a non-normalized body through unchanged: an unknown route name and an extra top-level field are kept', async () => {
    const body = {
      contract: 'v1',
      routes: ['capture', 'query', 'promote', 'future-route'],
      branch_aware: true,
      query_filters: ['files', 'future-filter'],
      server_build: 'example-build-7',
    };
    answer = { status: 200, body };
    expect(JSON.parse(await kbCapabilities({}, ANCHOR))).toEqual(body);
    // The normalized view used for route gating drops what the tool keeps.
    const normalized = await provider.capabilities();
    expect(normalized.routes).not.toContain('future-route');
    expect(normalized).not.toHaveProperty('server_build');
  });

  it.each([404, 501])('a server without the route (HTTP %i) yields the documented default set', async (status) => {
    answer = { status, body: { error: 'no such route' } };
    const caps = JSON.parse(await kbCapabilities({}, ANCHOR));
    expect(caps).toEqual(JSON.parse(JSON.stringify(KB_DEFAULT_CAPABILITIES)));
    expect(caps.routes).not.toContain('demote');
    expect(caps.routes).not.toContain('withdraw');
    expect(caps.branch_aware).toBe(false);
    expect(caps).not.toHaveProperty('query_filters');
  });

  it.each([
    ['a string', 'files'],
    ['an object', { files: true }],
    ['an array with a non-string element', ['files', 3]],
  ])('a query_filters that is %s is dropped: the server honours no filter (tool and route gating agree)', async (_label, malformed) => {
    const body = { contract: 'v1', routes: ['capture', 'query', 'promote'], branch_aware: false, query_filters: malformed, server_build: 'b1' };
    answer = { status: 200, body };
    const caps = JSON.parse(await kbCapabilities({}, ANCHOR));
    expect(caps).toEqual({ contract: 'v1', routes: ['capture', 'query', 'promote'], branch_aware: false, server_build: 'b1' });
    expect(caps).not.toHaveProperty('query_filters');
    expect(await provider.capabilities()).not.toHaveProperty('query_filters');
  });

  it('a partially-typed body is E-KB-HTTP-UNSUPPORTED', async () => {
    answer = { status: 200, body: { contract: 'v1', routes: ['capture', 'query', 'promote'] } };
    await expect(kbCapabilities({}, ANCHOR)).rejects.toMatchObject({ code: 'E-KB-HTTP-UNSUPPORTED' });
  });

  it('a 503 is E-KB-HTTP-UNREACHABLE', async () => {
    answer = { status: 503, body: { error: 'restarting' } };
    await expect(kbCapabilities({}, ANCHOR)).rejects.toMatchObject({ code: 'E-KB-HTTP-UNREACHABLE' });
  });
});

// ---------------------------------------------------------------------------
// 8: the removed scope keys, through the real registration wrapper.

describe('kb_capabilities refuses the removed scope keys', () => {
  async function registeredHandler(): Promise<(input: unknown) => Promise<unknown>> {
    let handler: ((input: unknown) => Promise<unknown>) | undefined;
    const fakeServer = {
      tool: (name: string, _d: string, _s: unknown, h: (input: unknown) => Promise<unknown>) => {
        if (name === 'kb_capabilities') handler = h;
      },
      server: { sendLoggingMessage: async () => {} },
    };
    await registerAllTools(fakeServer as never);
    if (!handler) throw new Error('kb_capabilities is not registered');
    return handler;
  }

  it.each(KB_REMOVED_SCOPE_KEYS)('%s fails with E-SCOPE-KEY-REMOVED naming it', async (key) => {
    const spy = vi.spyOn(kbProvidersModule, 'getKbProviders');
    const handler = await registeredHandler();
    const err = await handler({ [key]: '/some/other/repo' }).then(() => null, (e: unknown) => e as Error & { code?: string });
    expect(err).toBeInstanceOf(Error);
    expect(err!.code).toBe('E-SCOPE-KEY-REMOVED');
    expect(err!.message).toContain(`kb_capabilities no longer accepts '${key}'`);
    // Refused before any KB is resolved.
    expect(spy).not.toHaveBeenCalled();
  });
});
