/**
 * Model sources end to end over real local HTTP servers (node:http on
 * 127.0.0.1) standing in for the apra-fleet GitHub release and the Hugging
 * Face hub, through the DEFAULT download path (fetchDownload) -- no download
 * seam is injected anywhere in this file.
 *
 * 1. Hugging Face answers 503, the release serves: ready, and the release
 *    request log shows every file.
 * 2. Both unreachable: failed; the reason names both sources.
 * 3. The release serves a file with a wrong hash, Hugging Face the right one:
 *    falls through and ends ready.
 * 3b. The release writes WRONG bytes for a file and drops the connection;
 *    Hugging Face honours Range. The joined (resumed) file fails sha256, so
 *    the store retries Hugging Face once from byte 0: ready.
 * 4. kb model import of a folder: placed; ensure() is then ready with zero
 *    requests to either server.
 * 5. Same with a .tar.gz archive.
 * 6. Import with one tampered file: non-zero exit, the error names the file,
 *    nothing at the model folder.
 * 7. The release workflow script's dry-run asset names are exactly the paths
 *    the store requests from the release server for the default model.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  BUILTIN_EMBEDDING_PROFILES,
  DEFAULT_EMBEDDING_PROFILE,
  modelReleaseAssetName,
  type EmbeddingProfile,
} from '../../src/services/knowledge/embedding/profiles.js';
import { ModelStore } from '../../src/services/knowledge/embedding/model-store.js';
import { runKbModel } from '../../src/cli/kb-model-import.js';
import { makeTar } from '../helpers/tar-writer.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const REPO = 'Test/fallback-model';
const REV = 'fb0123456789abcdef01';
const TAG = 'v9.9.9';
const bodies: Record<string, string> = {
  'config.json': '{"hidden_size":4}',
  'tokenizer.json': '{"model":{"vocab":{}}}',
  'onnx/model_quantized.onnx': 'ONNX-'.repeat(300),
};
const profile: EmbeddingProfile = {
  ...BUILTIN_EMBEDDING_PROFILES[DEFAULT_EMBEDDING_PROFILE],
  builtin: true,
  source: { kind: 'hub', repo: REPO, revision: REV, files: Object.entries(bodies).map(([p, b]) => ({ path: p, sha256: sha(b) })) },
};
const choice = { kind: 'enabled' as const, profile };

interface Server { url: string; log: string[]; close: () => Promise<void> }
const servers: Server[] = [];

/** Start a real server; handler(path) returns [status, body]. Every request path is logged. */
async function serve(handler: (p: string) => [number, string]): Promise<Server> {
  const log: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent((req.url ?? '').split('?')[0]);
    log.push(p);
    const [status, body] = handler(p);
    res.writeHead(status, { 'content-type': 'application/octet-stream', 'content-length': String(Buffer.byteLength(body)) });
    res.end(body);
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const s: Server = {
    url: `http://127.0.0.1:${port}`,
    log,
    close: () => new Promise<void>((r) => { for (const k of sockets) k.destroy(); server.close(() => r()); }),
  };
  servers.push(s);
  return s;
}

/** Start a real server with a raw request handler; every request is logged as "<path> range=<Range header>". */
async function serveRaw(handler: (p: string, req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<Server> {
  const log: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent((req.url ?? '').split('?')[0]);
    log.push(`${p} range=${req.headers.range ?? ''}`);
    handler(p, req, res);
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const s: Server = {
    url: `http://127.0.0.1:${port}`,
    log,
    close: () => new Promise<void>((r) => { for (const k of sockets) k.destroy(); server.close(() => r()); }),
  };
  servers.push(s);
  return s;
}

/** A port nothing listens on (bound, then released). */
async function closedPortUrl(): Promise<string> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

const assetPath = (file: string) => `/download/${TAG}/${modelReleaseAssetName(REPO, REV, file)}`;
const hubPath = (file: string) => `/${REPO}/resolve/${REV}/${file}`;

function releaseServing(files: Record<string, string>): (p: string) => [number, string] {
  return (p) => {
    for (const [f, b] of Object.entries(files)) if (p === assetPath(f)) return [200, b];
    return [404, 'Not Found'];
  };
}
function hubServing(files: Record<string, string>): (p: string) => [number, string] {
  return (p) => {
    for (const [f, b] of Object.entries(files)) if (p === hubPath(f)) return [200, b];
    return [404, 'Not Found'];
  };
}

let tmp: string;
let tmpBefore: string[];
beforeEach(() => {
  tmpBefore = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('kb-model-fb-'));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-model-fb-'));
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  fs.rmSync(tmp, { recursive: true, force: true });
  expect(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('kb-model-fb-'))).toEqual(tmpBefore);
});

const modelsDir = () => path.join(tmp, 'models');
const store = (release: string, hub: string) =>
  new ModelStore({ modelsDir: modelsDir(), hubEndpoint: hub, releaseBaseUrl: `${release}/download/${TAG}`, stallTimeoutMs: 5000 });

describe('release source with real servers', () => {
  it('1. Hugging Face 503, release serves: ready, release log shows every file', async () => {
    const release = await serve(releaseServing(bodies));
    const hub = await serve(() => [503, 'Service Unavailable']);
    const state = await store(release.url, hub.url).ensure(choice);
    expect(state.state).toBe('ready');
    expect(release.log).toEqual(Object.keys(bodies).map(assetPath));
    expect(hub.log).toEqual([]);
    if (state.state === 'ready') {
      for (const [f, b] of Object.entries(bodies)) expect(fs.readFileSync(path.join(state.dir, ...f.split('/')), 'utf-8')).toBe(b);
    }
  });

  it('2. both unreachable: failed, the reason names both sources', async () => {
    const releaseUrl = await closedPortUrl();
    const hubUrl = await closedPortUrl();
    const state = await store(releaseUrl, hubUrl).ensure(choice);
    expect(state.state).toBe('failed');
    const reason = state.state === 'failed' ? state.reason : '';
    expect(reason).toContain(`GitHub release (${releaseUrl}/download/${TAG}/`);
    expect(reason).toContain(`Hugging Face (${hubUrl}/${REPO}/resolve/${REV}/`);
    expect(reason).toMatch(/failed from every source/);
    expect(fs.existsSync(store(releaseUrl, hubUrl).modelDir(profile))).toBe(false);
  });

  it('3. release serves a wrong hash, Hugging Face the right file: falls through, ready', async () => {
    const release = await serve(releaseServing({ ...bodies, 'tokenizer.json': '{"tampered":true}' }));
    const hub = await serve(hubServing(bodies));
    const state = await store(release.url, hub.url).ensure(choice);
    expect(state.state).toBe('ready');
    expect(release.log).toEqual(Object.keys(bodies).map(assetPath));
    expect(hub.log).toEqual([hubPath('tokenizer.json')]);
    if (state.state === 'ready') {
      expect(fs.readFileSync(path.join(state.dir, 'tokenizer.json'), 'utf-8')).toBe(bodies['tokenizer.json']);
    }
  });

  it('3b. release writes a bad prefix and drops, Hugging Face honours Range: retried from byte 0, ready', async () => {
    const onnx = 'onnx/model_quantized.onnx';
    const full = bodies[onnx];
    const release = await serveRaw((p, _req, res) => {
      for (const [f, b] of Object.entries(bodies)) {
        if (p !== assetPath(f)) continue;
        if (f !== onnx) { res.writeHead(200, { 'content-length': String(b.length) }); res.end(b); return; }
        // Wrong bytes, then the connection drops before the file is complete.
        res.writeHead(200, { 'content-length': String(full.length) });
        res.write('X'.repeat(500));
        setTimeout(() => res.socket?.destroy(), 100);
        return;
      }
      res.writeHead(404); res.end('Not Found');
    });
    const hub = await serveRaw((p, req, res) => {
      if (p !== hubPath(onnx)) { res.writeHead(404); res.end('Not Found'); return; }
      const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
      const start = m ? Number(m[1]) : 0;
      if (start > 0) {
        const rest = full.slice(start);
        res.writeHead(206, { 'content-length': String(rest.length), 'content-range': `bytes ${start}-${full.length - 1}/${full.length}` });
        res.end(rest);
        return;
      }
      res.writeHead(200, { 'content-length': String(full.length) });
      res.end(full);
    });
    const state = await store(release.url, hub.url).ensure(choice);
    expect(state.state === 'failed' ? state.reason : state.state).toBe('ready');
    // First a resume of the bad prefix, then the retry from byte 0.
    expect(hub.log).toEqual([`${hubPath(onnx)} range=bytes=500-`, `${hubPath(onnx)} range=`]);
    if (state.state === 'ready') expect(fs.readFileSync(path.join(state.dir, ...onnx.split('/')), 'utf-8')).toBe(full);
  });
});

describe('kb model import with real servers watching', () => {
  const io = () => ({ log: vi.fn(), error: vi.fn() });

  function writeFolder(dir: string, files: Record<string, string>): void {
    for (const [p, b] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, ...p.split('/'))), { recursive: true });
      fs.writeFileSync(path.join(dir, ...p.split('/')), b);
    }
  }

  it('4. a folder: placed, then ensure() is ready with zero requests to either server', async () => {
    const release = await serve(releaseServing(bodies));
    const hub = await serve(hubServing(bodies));
    const src = path.join(tmp, 'in');
    writeFolder(src, bodies);
    const s = store(release.url, hub.url);
    expect(await runKbModel(['import', src], io(), { store: s, profile })).toBe(0);
    const dir = s.modelDir(profile);
    for (const [f, b] of Object.entries(bodies)) expect(fs.readFileSync(path.join(dir, ...f.split('/')), 'utf-8')).toBe(b);
    // A fresh store (a new process) finds it ready too.
    expect((await store(release.url, hub.url).ensure(choice)).state).toBe('ready');
    expect(release.log).toEqual([]);
    expect(hub.log).toEqual([]);
  });

  it('5. a .tar.gz archive: same outcome', async () => {
    const release = await serve(releaseServing(bodies));
    const hub = await serve(hubServing(bodies));
    const archive = path.join(tmp, 'model.tar.gz');
    fs.writeFileSync(archive, makeTar(Object.fromEntries(Object.entries(bodies).map(([p, b]) => [`fallback-model/${p}`, b])), { gzip: true }));
    const s = store(release.url, hub.url);
    expect(await runKbModel(['import', archive], io(), { store: s, profile })).toBe(0);
    expect((await store(release.url, hub.url).ensure(choice)).state).toBe('ready');
    expect(release.log).toEqual([]);
    expect(hub.log).toEqual([]);
  });

  it('6. one tampered file: non-zero exit, the error names the file, nothing placed', async () => {
    const src = path.join(tmp, 'in');
    writeFolder(src, { ...bodies, 'onnx/model_quantized.onnx': 'TAMPERED' });
    const s = store(await closedPortUrl(), await closedPortUrl());
    const out = io();
    expect(await runKbModel(['import', src], out, { store: s, profile })).toBe(1);
    expect(out.error.mock.calls.join('\n')).toMatch(/sha256 mismatch for onnx\/model_quantized\.onnx.*nothing was placed/);
    const dir = s.modelDir(profile);
    expect(fs.existsSync(dir)).toBe(false);
    // No staging left beside it either.
    expect(fs.readdirSync(path.dirname(dir))).toEqual([]);
  });
});

describe('release workflow asset names', () => {
  it('7. the dry run names exactly what the store requests from the release server', async () => {
    const out = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', path.resolve(__dirname, '..', '..', 'scripts', 'model-release-assets.mjs'), '--dry-run'], { encoding: 'utf-8' });
    const planned = out.trim().split('\n').map((l) => l.split(' ')[0]);
    // The release 404s every asset and the hub is unreachable, so the store
    // stops at the first file: one single-file copy of the default profile per file.
    const release = await serve(() => [404, 'Not Found']);
    const hubUrl = await closedPortUrl();
    const base = BUILTIN_EMBEDDING_PROFILES[DEFAULT_EMBEDDING_PROFILE];
    if (base.source.kind !== 'hub') throw new Error('default profile is not a hub profile');
    for (const file of base.source.files) {
      const one = { ...base, source: { ...base.source, files: [file] } };
      const state = await store(release.url, hubUrl).ensure({ kind: 'enabled', profile: one });
      expect(state.state).toBe('failed');
    }
    expect(release.log).toEqual(planned.map((n) => `/download/${TAG}/${n}`));
  });
});
