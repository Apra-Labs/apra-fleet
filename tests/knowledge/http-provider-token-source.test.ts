import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { HttpKbProvider } from '../../src/services/knowledge/http-provider.js';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { CommandTokenSource, TOKEN_SOURCE_FAILED } from '../../src/services/knowledge/token-source.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';
import {
  bumpCounterJs,
  makeTempDir,
  nodeEvalCommand,
  readCounter,
  unsignedJwt,
} from './token-command-helpers.js';

// No mocks: a real node http server on an ephemeral port accepts only its
// current token and answers any other with 401 and an EMPTY body; token
// commands are real `node -e` scripts that bump a counter file in a temp dir.

let server: http.Server;
let serverUrl: string;
let acceptedToken = '';
let requestCount = 0;
const captureTitles: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requestCount++;
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      if (req.headers.authorization !== `Bearer ${acceptedToken}`) {
        res.writeHead(401);
        res.end();
        return;
      }
      const url = req.url ?? '';
      if (url === '/api/kb/capture' && req.method === 'POST') {
        captureTitles.push((JSON.parse(body) as KBEntryInput).title);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'server-id', audn_decision: 'add' }));
      } else if (url.startsWith('/api/kb/query') && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results: [], total: 0, l1_only: false }));
      } else {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'route refused by test server' }));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

let tmp: string;
let counter: string;
const providers: HttpKbProvider[] = [];

beforeEach(() => {
  tmp = makeTempDir('http-token-source-');
  counter = path.join(tmp, 'count');
  acceptedToken = '';
  requestCount = 0;
  captureTitles.length = 0;
});

afterEach(() => {
  for (const p of providers.splice(0)) p.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function makeProvider(url: string, token: string | CommandTokenSource): Promise<HttpKbProvider> {
  const fallback = new SqliteProvider(':memory:');
  await fallback.init();
  const provider = new HttpKbProvider(url, token, fallback);
  providers.push(provider);
  await provider.init();
  return provider;
}

/** A command printing `tok-<run number>`, so each run yields a new token. */
function rotatingCommand(): string {
  return nodeEvalCommand(bumpCounterJs(counter, 'process.stdout.write("tok-"+n)'));
}

async function rejection(p: Promise<unknown>): Promise<NodeJS.ErrnoException> {
  try {
    await p;
  } catch (err) {
    return err as NodeJS.ErrnoException;
  }
  throw new Error('expected the promise to reject, but it resolved');
}

/** A port nothing listens on: bind an ephemeral port, then release it. */
async function closedPortUrl(): Promise<string> {
  const probe = http.createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

function makeInput(title: string): KBEntryInput {
  return {
    type: 'learning',
    title,
    summary: 'summary',
    content: 'content',
    source_files: ['src/fixture.ts'],
    symbols: [],
    tags: [],
    content_hash: '',
    content_hash_type: 'sha256',
    flagged_for_review: false,
    author: 'test',
    source: 'doer',
    confidence: 'INFERRED',
  };
}

describe('HttpKbProvider with a CommandTokenSource', () => {
  it('sends the command token, and after the server rotates it refreshes once, retries and succeeds', async () => {
    acceptedToken = 'tok-1';
    const provider = await makeProvider(serverUrl, new CommandTokenSource({ command: rotatingCommand() }));

    await provider.query({ query: 'first' });
    expect(readCounter(counter)).toBe(1);
    expect(requestCount).toBe(1);

    acceptedToken = 'tok-2';
    const result = await provider.query({ query: 'second' });
    expect(result.results).toEqual([]);
    expect(readCounter(counter)).toBe(2);
    // first query, the rejected stale-token request, the retry
    expect(requestCount).toBe(3);
  });

  it('rejects with HTTP_401 after exactly one retry when the server keeps refusing', async () => {
    acceptedToken = 'never-issued';
    const provider = await makeProvider(serverUrl, new CommandTokenSource({ command: rotatingCommand() }));

    const err = await rejection(provider.query({ query: 'x' }));
    expect(err.code).toBe('HTTP_401');
    expect(err.message).not.toMatch(/Invalid JSON/);
    expect(requestCount).toBe(2);
    expect(readCounter(counter)).toBe(2);
  });
});

describe('HttpKbProvider with a static token', () => {
  it('a 401 with an empty body rejects with HTTP_401 and is not retried', async () => {
    acceptedToken = 'the-right-one';
    const provider = await makeProvider(serverUrl, 'the-wrong-one');

    const err = await rejection(provider.query({ query: 'x' }));
    expect(err.code).toBe('HTTP_401');
    expect(err.message).not.toMatch(/Invalid JSON/);
    expect(requestCount).toBe(1);
  });

  it('an error status with a JSON body keeps the body error field in the message', async () => {
    acceptedToken = 'the-right-one';
    const provider = await makeProvider(serverUrl, 'the-right-one');

    const err = await rejection(provider.invalidate(['src/x.ts']));
    expect(err.code).toBe('HTTP_403');
    expect(err.message).toBe('HTTP 403: route refused by test server');
  });
});

describe('HttpKbProvider offline queue with a failing token command', () => {
  it('keeps a queued capture through a flush whose token fetch fails, then sends it exactly once', async () => {
    // An always-stale token (JWT exp 200 s away) so every request runs the
    // command; the command fails while the `fail` flag file exists.
    const jwt = unsignedJwt(200);
    const failFlag = path.join(tmp, 'fail');
    const js = bumpCounterJs(
      counter,
      `if(fs.existsSync(${JSON.stringify(failFlag)}))process.exit(3);process.stdout.write(${JSON.stringify(jwt)})`
    );
    acceptedToken = jwt;
    const provider = await makeProvider(await closedPortUrl(), new CommandTokenSource({ command: nodeEvalCommand(js) }));

    // Server unreachable: the capture is queued.
    const queued = await provider.capture(makeInput('queued while offline'));
    expect(queued.id).toContain('offline-');
    expect(provider.offlineQueue).toHaveLength(1);

    // Server back, token command failing: the flush stops and keeps the queue.
    (provider as any).baseUrl = serverUrl;
    fs.writeFileSync(failFlag, '');
    const err = await rejection(provider.query({ query: 'x' }));
    expect(err.code).toBe(TOKEN_SOURCE_FAILED);
    expect(provider.offlineQueue).toHaveLength(1);
    expect(captureTitles).toEqual([]);

    // Token command works again: the next call flushes the capture once.
    fs.rmSync(failFlag);
    await provider.query({ query: 'x' });
    expect(provider.offlineQueue).toHaveLength(0);
    expect(captureTitles).toEqual(['queued while offline']);
  });
});
