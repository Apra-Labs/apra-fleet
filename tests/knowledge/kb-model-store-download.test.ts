/**
 * Model download robustness: one overall deadline bounds the whole model
 * download (every file, redirects and body streaming), and an interrupted
 * download never leaves a folder a later run treats as complete (files are
 * staged in a temp folder, verified, then the folder is renamed into place).
 * The models folder path <modelsDir>/<owner>/<name>@<revision>/ is the
 * contract; models already downloaded there are used as-is.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import {
  BUILTIN_EMBEDDING_PROFILES,
  DEFAULT_EMBEDDING_PROFILE,
  type EmbeddingProfile,
} from '../../src/services/knowledge/embedding/profiles.js';
import { ModelStore, fetchDownload, type ModelDownloadFn } from '../../src/services/knowledge/embedding/model-store.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const REV = 'abc123';

function pinnedProfile(bodies: Record<string, string>): EmbeddingProfile {
  return {
    ...BUILTIN_EMBEDDING_PROFILES[DEFAULT_EMBEDDING_PROFILE],
    source: {
      kind: 'hub',
      repo: 'Test/tiny-model',
      revision: REV,
      files: Object.entries(bodies).map(([p, b]) => ({ path: p, sha256: sha(b) })),
    },
  };
}

const bodies = { 'config.json': '{"a":1}', 'tokenizer.json': '{"t":1}', 'onnx/model_quantized.onnx': 'ONNX-BYTES' };

function serveDownload(files: Record<string, string>, opts: { failOn?: string } = {}) {
  return vi.fn<ModelDownloadFn>(async (url, dest) => {
    const rel = url.split(`/resolve/${REV}/`)[1];
    if (rel === opts.failOn) {
      fs.writeFileSync(dest, files[rel].slice(0, 3)); // partial bytes, then the connection drops
      throw new Error('socket hang up');
    }
    fs.writeFileSync(dest, files[rel]);
  });
}

let tmp: string;
let tmpBefore: string[];
beforeEach(() => {
  tmpBefore = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('kb-model-dl-'));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-model-dl-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  expect(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('kb-model-dl-'))).toEqual(tmpBefore);
});

const modelDir = () => path.join(tmp, 'Test', `tiny-model@${REV}`);

describe('overall download deadline', () => {
  it('a server that keeps trickling bytes is cut off at the overall deadline, with a reason naming the timeout', async () => {
    // Real HTTP: one small chunk every 50 ms, forever -- never idle, never done.
    const sockets = new Set<import('node:net').Socket>();
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const t = setInterval(() => res.write('x'), 50);
      res.on('close', () => clearInterval(t));
    });
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const store = new ModelStore({ modelsDir: tmp, hubEndpoint: `http://127.0.0.1:${port}`, downloadDeadlineMs: 400 });
      const started = Date.now();
      const state = await store.ensure({ kind: 'enabled', profile: pinnedProfile(bodies) });
      const took = Date.now() - started;
      expect(state.state).toBe('failed');
      expect(state.state === 'failed' && state.reason).toMatch(/timed out after 0\.4 s \(overall model download deadline\)/);
      expect(took).toBeGreaterThanOrEqual(350);
      expect(took).toBeLessThan(5000);
      expect(fs.existsSync(modelDir())).toBe(false);
      expect(fs.readdirSync(tmp).filter((n) => n !== 'Test')).toEqual([]);
      expect(fs.existsSync(path.join(tmp, 'Test')) ? fs.readdirSync(path.join(tmp, 'Test')) : []).toEqual([]);
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('the deadline spans all files, not each one: slow files that each fit a per-file budget still fail overall', async () => {
    const download = vi.fn<ModelDownloadFn>(async (url, dest, signal) => {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 150);
        signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
      });
      fs.writeFileSync(dest, bodies[url.split(`/resolve/${REV}/`)[1] as keyof typeof bodies]);
    });
    const store = new ModelStore({ modelsDir: tmp, download, downloadDeadlineMs: 250 });
    const state = await store.ensure({ kind: 'enabled', profile: pinnedProfile(bodies) });
    expect(state.state === 'failed' && state.reason).toMatch(/timed out after 0\.25 s/);
    expect(download.mock.calls.length).toBe(2);
    expect(fs.existsSync(modelDir())).toBe(false);
  });

  it('a download seam that ignores the abort signal is still bounded by the deadline', async () => {
    const download = vi.fn<ModelDownloadFn>(() => new Promise(() => {}));
    const store = new ModelStore({ modelsDir: tmp, download, downloadDeadlineMs: 100 });
    const state = await store.ensure({ kind: 'enabled', profile: pinnedProfile(bodies) });
    expect(state.state === 'failed' && state.reason).toMatch(/timed out after 0\.1 s/);
  });

  it('fetchDownload honours the abort signal', async () => {
    const server = http.createServer((_req, res) => { res.writeHead(200); res.write('partial'); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const ac = new AbortController();
      setTimeout(() => ac.abort(new Error('stop now')), 100);
      await expect(fetchDownload(`http://127.0.0.1:${port}/x`, path.join(tmp, 'x.bin'), ac.signal)).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('interrupted downloads', () => {
  it('a download that fails on a later file leaves no model folder; the next attempt downloads and is ready', async () => {
    const profile = pinnedProfile(bodies);
    const broken = serveDownload(bodies, { failOn: 'onnx/model_quantized.onnx' });
    const first = await new ModelStore({ modelsDir: tmp, download: broken }).ensure({ kind: 'enabled', profile });
    expect(first.state === 'failed' && first.reason).toMatch(/socket hang up/);
    expect(fs.existsSync(modelDir())).toBe(false);
    // No staging leftovers either.
    expect(fs.readdirSync(path.join(tmp, 'Test'))).toEqual([]);

    // A later run with a store that would treat any existing folder as complete never sees a half folder.
    const good = serveDownload(bodies);
    const second = await new ModelStore({ modelsDir: tmp, download: good }).ensure({ kind: 'enabled', profile });
    expect(second).toMatchObject({ state: 'ready', dir: modelDir() });
    expect(good).toHaveBeenCalledTimes(3);
    expect(fs.readFileSync(path.join(modelDir(), 'onnx', 'model_quantized.onnx'), 'utf-8')).toBe('ONNX-BYTES');
    expect(fs.readdirSync(path.join(tmp, 'Test'))).toEqual([`tiny-model@${REV}`]);
  });

  it('a process killed mid-download (staging folder left behind) is never loaded as ready and is cleaned up', async () => {
    const profile = pinnedProfile(bodies);
    // What a killed process leaves: a staging folder with some files.
    const staging = path.join(tmp, 'Test', `tiny-model@${REV}.part-99999-deadbeef`);
    fs.mkdirSync(path.join(staging, 'onnx'), { recursive: true });
    fs.writeFileSync(path.join(staging, 'config.json'), bodies['config.json']);
    const good = serveDownload(bodies);
    const state = await new ModelStore({ modelsDir: tmp, download: good }).ensure({ kind: 'enabled', profile });
    expect(state).toMatchObject({ state: 'ready', dir: modelDir() });
    expect(good).toHaveBeenCalledTimes(3);
    expect(fs.readdirSync(path.join(tmp, 'Test'))).toEqual([`tiny-model@${REV}`]);
  });
});

describe('models folder path contract', () => {
  it('a model already downloaded at <modelsDir>/<owner>/<name>@<revision>/ is used with no download', async () => {
    const profile = pinnedProfile(bodies);
    for (const [rel, body] of Object.entries(bodies)) {
      const f = path.join(modelDir(), ...rel.split('/'));
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, body);
    }
    const download = serveDownload(bodies);
    const state = await new ModelStore({ modelsDir: tmp, download }).ensure({ kind: 'enabled', profile });
    expect(state).toMatchObject({ state: 'ready', dir: modelDir() });
    expect(download).not.toHaveBeenCalled();
  });

  it('a folder from an older version with one file missing gets only that file, and stays at the same path', async () => {
    const profile = pinnedProfile(bodies);
    fs.mkdirSync(path.join(modelDir(), 'onnx'), { recursive: true });
    fs.writeFileSync(path.join(modelDir(), 'config.json'), bodies['config.json']);
    fs.writeFileSync(path.join(modelDir(), 'onnx', 'model_quantized.onnx'), bodies['onnx/model_quantized.onnx']);
    const download = serveDownload(bodies);
    const state = await new ModelStore({ modelsDir: tmp, download }).ensure({ kind: 'enabled', profile });
    expect(state).toMatchObject({ state: 'ready', dir: modelDir() });
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0][0]).toMatch(/tokenizer\.json$/);
    expect(fs.readdirSync(path.join(tmp, 'Test'))).toEqual([`tiny-model@${REV}`]);
  });
});
