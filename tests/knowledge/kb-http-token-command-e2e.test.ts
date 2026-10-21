import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { kbSetup } from '../../src/tools/kb-setup.js';
import { getKbProviders, resetKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { HttpKbProvider } from '../../src/services/knowledge/http-provider.js';
import { FLEET_DIR } from '../../src/paths.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

// End-to-end: kb_setup token_command -> getKbProviders -> real HTTP requests to
// a real local node http server. No mocks: the token command is a real
// `node -e` process that prints tokens from a counter file, and the server
// accepts only its CURRENT token, answering 401 with an EMPTY body otherwise.
//
// Revert check (criterion "reverting the 401 refresh-and-retry makes the
// rotation test fail"): in src/services/knowledge/http-provider.ts rawRequest,
// replacing the catch-then-refresh tail with a plain
// `return this.sendRequest(token, ...)` made "re-runs the command once ..."
// fail with `HTTP 401: ` (rejects) and the counter stay at 1; the file was
// restored afterwards.

const configPath = path.join(FLEET_DIR, 'knowledge', 'config.json');
const SECRET_MARKER = 'SECRET_MARKER_5f3a9c';

const tempDirs: string[] = [];
let savedConfig: string | null;
let server: http.Server;
let port: number;
let acceptedToken = '';
let seenAuth: (string | undefined)[] = [];
let captures: KBEntryInput[] = [];

function toShellPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/** A real `node -e` command: fails (stderr marker, exit 1) while failFlag exists, else prints tok-<run count>. */
function tokenCommand(counterFile: string, failFlag: string): string {
  const js = [
    `const fs=require('fs')`,
    `if(fs.existsSync('${toShellPath(failFlag)}')){console.error('${SECRET_MARKER}');process.exit(1)}`,
    `const c='${toShellPath(counterFile)}'`,
    `const n=(fs.existsSync(c)?Number(fs.readFileSync(c,'utf8')):0)+1`,
    `fs.writeFileSync(c,String(n))`,
    `console.log('tok-'+n)`,
  ].join(';');
  return `node -e "${js}"`;
}

function runCount(counterFile: string): number {
  return fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, 'utf8')) : 0;
}

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-token-cmd-e2e-'));
  tempDirs.push(dir);
  return dir;
}

function makeEntry(): KBEntryInput {
  return {
    type: 'knowledge',
    title: 'kb-http-token-command-e2e entry',
    summary: 'Entry captured through a provider whose token comes from a command.',
    content: 'kb-http-token-command-e2e content.',
    source_files: [],
    symbols: ['kbHttpTokenCommandE2e'],
    tags: [],
    content_hash: '',
    content_hash_type: 'sha256',
    flagged_for_review: false,
    author: 'doer',
    source: 'session',
    confidence: 'INFERRED',
  };
}

function handler(req: http.IncomingMessage, res: http.ServerResponse): void {
  let body = '';
  req.on('data', (c: Buffer) => { body += c.toString(); });
  req.on('end', () => {
    seenAuth.push(req.headers.authorization);
    if (req.headers.authorization !== `Bearer ${acceptedToken}`) {
      res.writeHead(401);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url?.startsWith('/api/kb/capture')) {
      captures.push(JSON.parse(body) as KBEntryInput);
      res.end(JSON.stringify({ id: 'server-id', audn_decision: 'add' }));
    } else {
      res.end(JSON.stringify({ l1_results: [], l2_expanded: [] }));
    }
  });
}

function listen(srv: http.Server, p: number): Promise<number> {
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(p, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') reject(new Error('no tcp port'));
      else resolve(addr.port);
    });
  });
}

function closeServer(srv: http.Server): Promise<void> {
  return new Promise(resolve => {
    if (!srv.listening) { resolve(); return; }
    srv.close(() => resolve());
    srv.closeAllConnections();
  });
}

async function configuredProvider(command: string): Promise<HttpKbProvider> {
  const repoPath = makeTempDir();
  const remoteUrl = `https://example.invalid/kb-token-cmd-e2e-${crypto.randomUUID()}.git`;
  await kbSetup(
    { provider: 'http', remote: `http://127.0.0.1:${port}`, token_command: command },
    { folder: repoPath },
  );
  const providers = await getKbProviders(repoPath, remoteUrl);
  expect(providers.project).toBeInstanceOf(HttpKbProvider);
  return providers.project as HttpKbProvider;
}

beforeEach(async () => {
  savedConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : null;
  fs.rmSync(configPath, { force: true });
  resetKbProviders();
  acceptedToken = 'tok-1';
  seenAuth = [];
  captures = [];
  server = http.createServer(handler);
  port = await listen(server, 0);
});

afterEach(async () => {
  resetKbProviders();
  await closeServer(server);
  if (savedConfig === null) fs.rmSync(configPath, { force: true });
  else fs.writeFileSync(configPath, savedConfig);
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('token_command end to end', () => {
  it('a query through the config-built provider carries the command token', async () => {
    const dir = makeTempDir();
    const counter = path.join(dir, 'counter');
    const provider = await configuredProvider(tokenCommand(counter, path.join(dir, 'fail')));
    await provider.query({ query: 'anything' });
    expect(seenAuth).toEqual(['Bearer tok-1']);
    expect(runCount(counter)).toBe(1);
  });

  it('re-runs the command once on rotation, retries and succeeds', async () => {
    const dir = makeTempDir();
    const counter = path.join(dir, 'counter');
    const provider = await configuredProvider(tokenCommand(counter, path.join(dir, 'fail')));
    await provider.query({ query: 'first' });
    expect(runCount(counter)).toBe(1);

    acceptedToken = 'tok-2'; // the server rotated; the cached tok-1 is now rejected
    seenAuth = [];
    await expect(provider.query({ query: 'second' })).resolves.toBeDefined();
    expect(seenAuth).toEqual(['Bearer tok-1', 'Bearer tok-2']);
    expect(runCount(counter)).toBe(2);
  });

  it('a capture queued while the server is down is delivered exactly once after recovery', async () => {
    const dir = makeTempDir();
    const counter = path.join(dir, 'counter');
    const failFlag = path.join(dir, 'fail');
    const provider = await configuredProvider(tokenCommand(counter, failFlag));

    await closeServer(server); // server down
    const queued = await provider.capture(makeEntry());
    expect(queued.id).toMatch(/^offline-/);
    expect(provider.offlineQueue).toHaveLength(1);

    // Server back and rotated (the cached token is rejected), but the token command
    // is failing: the flush must keep the capture.
    acceptedToken = 'tok-2';
    server = http.createServer(handler);
    await listen(server, port);
    fs.writeFileSync(failFlag, '');
    await expect(provider.query({ query: 'during failure' })).rejects.toThrow(/token command failed/);
    expect(provider.offlineQueue).toHaveLength(1);
    expect(captures).toHaveLength(0);

    // Command recovers: the next call flushes the queue exactly once.
    fs.rmSync(failFlag);
    await provider.query({ query: 'after recovery' });
    expect(captures).toHaveLength(1);
    expect(provider.offlineQueue).toHaveLength(0);
    await provider.query({ query: 'again' });
    expect(captures).toHaveLength(1);
  });

  it('never leaks the failing command output into errors, the config file or stderr', async () => {
    const dir = makeTempDir();
    const failFlag = path.join(dir, 'fail');
    fs.writeFileSync(failFlag, '');
    const command = tokenCommand(path.join(dir, 'counter'), failFlag);
    const provider = await configuredProvider(command);

    const stderrChunks: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return (realWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;

    let message = '';
    try {
      await provider.query({ query: 'x' });
    } catch (err) {
      message = (err as Error).message;
    } finally {
      process.stderr.write = realWrite;
    }

    expect(message).toMatch(/token command failed/);
    expect(message).not.toContain(SECRET_MARKER);
    expect(fs.readFileSync(configPath, 'utf-8')).not.toContain(SECRET_MARKER);
    expect(stderrChunks.join('')).not.toContain(SECRET_MARKER);
    expect(stderrChunks.join('')).not.toContain('node -e');
  });
});
