/**
 * Model download over the network, end to end through the DEFAULT download
 * path (fetchDownload: undici EnvHttpProxyAgent, Range resume) against real
 * local HTTP servers on 127.0.0.1 -- no download seam is injected anywhere in
 * this file.
 *
 * - proxy: HTTP_PROXY / HTTPS_PROXY route the download through a real local
 *   CONNECT proxy; NO_PROXY matching the server host bypasses it.
 * - stall: a server that stops sending fails with a reason naming the stall.
 * - slow but steady: a download longer than the stall timeout in total, that
 *   never pauses that long, succeeds.
 * - resume: a dropped connection is continued with a Range request on the
 *   next attempt (206), or re-downloaded whole when the server ignores Range
 *   (200); sha256 is checked either way, and a mismatch after resume leaves no
 *   model folder and discards the bad file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import {
  BUILTIN_EMBEDDING_PROFILES,
  DEFAULT_EMBEDDING_PROFILE,
  type EmbeddingProfile,
} from '../../src/services/knowledge/embedding/profiles.js';
import { ModelStore } from '../../src/services/knowledge/embedding/model-store.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const REV = 'net0123';
const ONNX = 'onnx/model_quantized.onnx';
const bodies: Record<string, string> = {
  'config.json': '{"hidden_size":4}',
  'tokenizer.json': '{"model":{"vocab":{}}}',
  [ONNX]: 'ONNX-'.repeat(400), // 2000 bytes: big enough to cut in the middle
};

function profileFor(files: Record<string, string>): EmbeddingProfile {
  return {
    ...BUILTIN_EMBEDDING_PROFILES[DEFAULT_EMBEDDING_PROFILE],
    source: {
      kind: 'hub',
      repo: 'Test/net-model',
      revision: REV,
      files: Object.entries(files).map(([p, b]) => ({ path: p, sha256: sha(b) })),
    },
  };
}

interface Started { port: number; close: () => Promise<void> }
const toClose: Started[] = [];

async function listen(server: http.Server): Promise<Started> {
  const sockets = new Set<net.Socket>();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const started: Started = {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
  toClose.push(started);
  return started;
}

interface Hit { file: string; range: string | undefined }

/** Model file server. handler gets the file, its body and the request; default serves it whole. */
async function modelServer(
  handler?: (file: string, body: string, req: http.IncomingMessage, res: http.ServerResponse, n: number) => boolean,
): Promise<Started & { hits: Hit[] }> {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    const file = decodeURIComponent((req.url ?? '').split(`/resolve/${REV}/`)[1] ?? '');
    const body = bodies[file];
    hits.push({ file, range: req.headers.range });
    if (body === undefined) { res.writeHead(404); res.end(); return; }
    const n = hits.filter((h) => h.file === file).length;
    if (handler?.(file, body, req, res, n)) return;
    res.writeHead(200, { 'content-length': String(body.length) });
    res.end(body);
  });
  return { ...(await listen(server)), hits };
}

/** Serve a Range request as 206 from its start, with the given body. */
function serveRange(req: http.IncomingMessage, res: http.ServerResponse, body: string): void {
  const start = Number(/^bytes=(\d+)-$/.exec(req.headers.range ?? '')?.[1] ?? 0);
  res.writeHead(206, {
    'content-range': `bytes ${start}-${body.length - 1}/${body.length}`,
    'content-length': String(body.length - start),
  });
  res.end(body.slice(start));
}

/** Send the first `cut` bytes of body (announcing the full length), then drop the connection. */
function dropMidway(res: http.ServerResponse, body: string, cut: number): void {
  res.writeHead(200, { 'content-length': String(body.length) });
  res.write(body.slice(0, cut), () => setTimeout(() => res.destroy(), 20));
}

/** A real forward proxy: CONNECT tunnels and absolute-URI http forwarding, both logged. */
async function forwardProxy(): Promise<Started & { log: string[] }> {
  const log: string[] = [];
  const server = http.createServer((req, res) => {
    log.push(`${req.method} ${req.url}`);
    const target = new URL(req.url ?? '');
    const up = http.request(
      { host: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method, headers: req.headers },
      (upRes) => { res.writeHead(upRes.statusCode ?? 502, upRes.headers); upRes.pipe(res); },
    );
    up.on('error', () => res.destroy());
    req.pipe(up);
  });
  server.on('connect', (req, client: net.Socket, head) => {
    log.push(`CONNECT ${req.url}`);
    const [host, port] = (req.url ?? '').split(':');
    const up = net.connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    up.on('error', () => client.destroy());
    client.on('error', () => up.destroy());
  });
  return { ...(await listen(server)), log };
}

const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];
let savedEnv: Record<string, string | undefined>;
let tmp: string;
let tmpBefore: string[];

beforeEach(() => {
  // Ambient proxy settings of the machine running the tests must not leak in.
  savedEnv = Object.fromEntries(PROXY_VARS.map((k) => [k, process.env[k]]));
  for (const k of PROXY_VARS) delete process.env[k];
  tmpBefore = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('kb-model-net-'));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-model-net-'));
});

afterEach(async () => {
  for (const s of toClose.splice(0)) await s.close();
  for (const k of PROXY_VARS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  expect(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('kb-model-net-'))).toEqual(tmpBefore);
});

const owner = () => path.join(tmp, 'Test');
const modelDir = () => path.join(owner(), `net-model@${REV}`);
const resumeFile = (rel: string) => path.join(owner(), `net-model@${REV}.partial`, ...rel.split('/'));
const store = (port: number, stallTimeoutMs?: number) =>
  new ModelStore({ modelsDir: tmp, hubEndpoint: `http://127.0.0.1:${port}`, ...(stallTimeoutMs ? { stallTimeoutMs } : {}) });

function expectModelFiles(): void {
  for (const [rel, body] of Object.entries(bodies)) {
    expect(fs.readFileSync(path.join(modelDir(), ...rel.split('/')), 'utf-8')).toBe(body);
  }
}

describe('proxy', () => {
  it('with HTTP_PROXY/HTTPS_PROXY set the default download goes through the proxy and the model ends ready', async () => {
    const server = await modelServer();
    const proxy = await forwardProxy();
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`;
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxy.port}`;
    const state = await store(server.port).ensure({ kind: 'enabled', profile: profileFor(bodies) });
    expect(state).toMatchObject({ state: 'ready', dir: modelDir() });
    expectModelFiles();
    // Every model file request was carried by the proxy to this server.
    expect(server.hits.map((h) => h.file).sort()).toEqual(Object.keys(bodies).sort());
    expect(proxy.log.length).toBeGreaterThanOrEqual(1);
    for (const line of proxy.log) expect(line).toContain(`127.0.0.1:${server.port}`);
  });

  it('a host matching NO_PROXY bypasses the proxy and still downloads', async () => {
    const server = await modelServer();
    const proxy = await forwardProxy();
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`;
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxy.port}`;
    process.env.NO_PROXY = 'localhost,127.0.0.1';
    const state = await store(server.port).ensure({ kind: 'enabled', profile: profileFor(bodies) });
    expect(state).toMatchObject({ state: 'ready', dir: modelDir() });
    expectModelFiles();
    expect(server.hits.length).toBe(3);
    expect(proxy.log).toEqual([]);
  });
});

describe('stall and slow links', () => {
  it('a server that sends part of a file then stops fails with a reason naming the stall', async () => {
    const server = await modelServer((file, body, _req, res) => {
      if (file !== ONNX) return false;
      res.writeHead(200, { 'content-length': String(body.length) });
      res.write(body.slice(0, 100)); // and then silence
      return true;
    });
    const state = await store(server.port, 300).ensure({ kind: 'enabled', profile: profileFor(bodies) });
    expect(state.state).toBe('failed');
    expect(state.state === 'failed' && state.reason).toMatch(/onnx\/model_quantized\.onnx failed: stalled: no data received for 0\.3 s/);
    expect(fs.existsSync(modelDir())).toBe(false);
  });

  it('a slow but steady server that takes longer than the stall timeout in total succeeds', async () => {
    const stallMs = 400;
    const server = await modelServer((file, body, _req, res) => {
      if (file !== ONNX) return false;
      res.writeHead(200, { 'content-length': String(body.length) });
      // 10 pieces, one every 150 ms: ~1.5 s in total, never a pause near 400 ms.
      const pieces = 10;
      const size = Math.ceil(body.length / pieces);
      let i = 0;
      const t = setInterval(() => {
        res.write(body.slice(i * size, (i + 1) * size));
        i += 1;
        if (i === pieces) { clearInterval(t); res.end(); }
      }, 150);
      res.on('close', () => clearInterval(t));
      return true;
    });
    const started = Date.now();
    const state = await store(server.port, stallMs).ensure({ kind: 'enabled', profile: profileFor(bodies) });
    expect(state).toMatchObject({ state: 'ready', dir: modelDir() });
    expect(Date.now() - started).toBeGreaterThan(stallMs * 2);
    expectModelFiles();
  });
});

describe('resume', () => {
  it('a dropped connection is continued with a Range request from the partial size; the file passes sha256', async () => {
    const server = await modelServer((file, body, req, res, n) => {
      if (file !== ONNX) return false;
      if (n === 1) { dropMidway(res, body, 700); return true; }
      serveRange(req, res, body);
      return true;
    });
    const profile = profileFor(bodies);
    const first = await store(server.port).ensure({ kind: 'enabled', profile });
    expect(first.state).toBe('failed');
    expect(fs.existsSync(modelDir())).toBe(false);
    const partial = fs.statSync(resumeFile(ONNX)).size;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(bodies[ONNX].length);

    const second = await store(server.port).ensure({ kind: 'enabled', profile });
    expect(second).toMatchObject({ state: 'ready', dir: modelDir() });
    expectModelFiles();
    const onnxHits = server.hits.filter((h) => h.file === ONNX);
    expect(onnxHits.map((h) => h.range)).toEqual([undefined, `bytes=${partial}-`]);
    // Files finished in the first attempt are not requested again.
    expect(server.hits.filter((h) => h.file === 'config.json').length).toBe(1);
    expect(fs.readdirSync(owner())).toEqual([`net-model@${REV}`]);
  });

  it('a server that ignores Range (always 200) gets the file re-downloaded whole and correct', async () => {
    const server = await modelServer((file, body, _req, res, n) => {
      if (file !== ONNX || n !== 1) return false;
      dropMidway(res, body, 700);
      return true;
    });
    const profile = profileFor(bodies);
    expect((await store(server.port).ensure({ kind: 'enabled', profile })).state).toBe('failed');
    const partial = fs.statSync(resumeFile(ONNX)).size;
    expect(partial).toBeGreaterThan(0);

    const second = await store(server.port).ensure({ kind: 'enabled', profile });
    expect(second).toMatchObject({ state: 'ready', dir: modelDir() });
    expectModelFiles();
    const onnxHits = server.hits.filter((h) => h.file === ONNX);
    expect(onnxHits.map((h) => h.range)).toEqual([undefined, `bytes=${partial}-`]);
    expect(fs.readdirSync(owner())).toEqual([`net-model@${REV}`]);
  });

  it('a resumed file that fails sha256 leaves the model not ready, no model folder, and is discarded', async () => {
    const tampered = 'X'.repeat(bodies[ONNX].length);
    const server = await modelServer((file, body, req, res, n) => {
      if (file !== ONNX) return false;
      if (n === 1) { dropMidway(res, body, 700); return true; }
      if (n === 2) { serveRange(req, res, tampered); return true; } // wrong tail bytes
      return false; // third attempt: the true file, whole
    });
    const profile = profileFor(bodies);
    expect((await store(server.port).ensure({ kind: 'enabled', profile })).state).toBe('failed');
    const partial = fs.statSync(resumeFile(ONNX)).size;

    const second = await store(server.port).ensure({ kind: 'enabled', profile });
    expect(second.state).toBe('failed');
    expect(second.state === 'failed' && second.reason).toMatch(/sha256 mismatch for .*onnx\/model_quantized\.onnx/);
    expect(fs.existsSync(modelDir())).toBe(false);
    expect(fs.existsSync(resumeFile(ONNX))).toBe(false);
    expect(server.hits.filter((h) => h.file === ONNX).map((h) => h.range)).toEqual([undefined, `bytes=${partial}-`]);

    // The discarded file is fetched afresh (no Range) next time.
    const third = await store(server.port).ensure({ kind: 'enabled', profile });
    expect(third).toMatchObject({ state: 'ready', dir: modelDir() });
    expect(server.hits.filter((h) => h.file === ONNX).map((h) => h.range)[2]).toBeUndefined();
    expectModelFiles();
  });
});
