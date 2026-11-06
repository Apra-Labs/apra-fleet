import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  resolveEmbeddingModel,
  BUILTIN_EMBEDDING_PROFILES,
  DEFAULT_EMBEDDING_PROFILE,
  type EmbeddingModelChoice,
  type EmbeddingProfile,
} from '../../src/services/knowledge/embedding/profiles.js';
import { ModelStore, type ModelDownloadFn } from '../../src/services/knowledge/embedding/model-store.js';
import { readEmbeddingModelSetting, KB_CONFIG_PATH } from '../../src/services/knowledge/kb-config.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** A built-in-shaped profile whose pinned hashes match the given file bodies. */
function pinnedProfile(bodies: Record<string, string>): EmbeddingProfile {
  return {
    ...BUILTIN_EMBEDDING_PROFILES[DEFAULT_EMBEDDING_PROFILE],
    source: {
      kind: 'hub',
      repo: 'Test/tiny-model',
      revision: 'abc123',
      files: Object.entries(bodies).map(([p, b]) => ({ path: p, sha256: sha(b) })),
    },
  };
}

/** Fake download seam serving bodies by the file path at the end of the URL. */
function fakeDownload(bodies: Record<string, string>, opts: { delayMs?: number } = {}) {
  const fn = vi.fn<ModelDownloadFn>(async (url, dest) => {
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    const rel = url.split('/resolve/abc123/')[1];
    if (!(rel in bodies)) throw new Error(`404 ${rel}`);
    fs.writeFileSync(dest, bodies[rel]);
  });
  return fn;
}

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-embed-store-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('resolveEmbeddingModel', () => {
  it('absent key -> default profile, no warning', () => {
    const warn = vi.fn();
    const c = resolveEmbeddingModel(undefined, warn);
    expect(c.kind).toBe('enabled');
    expect(c.kind === 'enabled' && c.profile.name).toBe('snowflake-arctic-embed-xs');
    expect(c.kind === 'enabled' && c.profile.dims).toBe(384);
    expect(c.kind === 'enabled' && c.profile.pooling).toBe('cls');
    expect(c.kind === 'enabled' && c.profile.queryPrefix).toBe('Represent this sentence for searching relevant passages: ');
    expect(warn).not.toHaveBeenCalled();
  });

  it('the former default bge-small-en-v1.5 is still selectable by name, with no query prefix', () => {
    const warn = vi.fn();
    const c = resolveEmbeddingModel('bge-small-en-v1.5', warn);
    expect(c.kind === 'enabled' && c.profile).toBe(BUILTIN_EMBEDDING_PROFILES['bge-small-en-v1.5']);
    expect(c.kind === 'enabled' && c.profile.modelId).toBe('Xenova/bge-small-en-v1.5');
    expect(c.kind === 'enabled' && c.profile.queryPrefix).toBe('');
    expect(warn).not.toHaveBeenCalled();
  });

  it("'none' -> disabled", () => {
    expect(resolveEmbeddingModel('none', vi.fn())).toEqual({ kind: 'disabled' });
  });

  it('built-in arctic profiles carry their query instruction prefix and pinned hashes', () => {
    for (const name of ['snowflake-arctic-embed-s', 'snowflake-arctic-embed-xs']) {
      const c = resolveEmbeddingModel(name, vi.fn());
      expect(c.kind === 'enabled' && c.profile.queryPrefix).toBe('Represent this sentence for searching relevant passages: ');
      const src = c.kind === 'enabled' ? c.profile.source : undefined;
      expect(src?.kind).toBe('hub');
      if (src?.kind === 'hub') {
        expect(src.revision).toMatch(/^[0-9a-f]{40}$/);
        for (const f of src.files) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });

  it('custom object -> its pooling, normalize and prefixes', () => {
    const c = resolveEmbeddingModel(
      { id: 'someone/my-model', pooling: 'mean', normalize: false, query_prefix: 'query: ', doc_prefix: 'passage: ' },
      vi.fn(),
    );
    expect(c.kind).toBe('enabled');
    if (c.kind !== 'enabled') return;
    expect(c.profile.builtin).toBe(false);
    expect(c.profile.pooling).toBe('mean');
    expect(c.profile.normalize).toBe(false);
    expect(c.profile.queryPrefix).toBe('query: ');
    expect(c.profile.docPrefix).toBe('passage: ');
    expect(c.profile.source).toMatchObject({ kind: 'hub', repo: 'someone/my-model', revision: 'main' });
  });

  it('custom local folder path -> local source', () => {
    const c = resolveEmbeddingModel({ path: tmp, pooling: 'cls' }, vi.fn());
    expect(c.kind === 'enabled' && c.profile.source).toEqual({ kind: 'local', path: tmp });
  });

  it.each([
    ['unknown profile name', 'no-such-model'],
    ['number', 42],
    ['array', ['x']],
    ['object without id or path', { pooling: 'cls' }],
    ['bad pooling', { id: 'a/b', pooling: 'max' }],
    ['relative path', { path: 'models/x' }],
    ['traversal id', { id: '../etc' }],
  ])('malformed (%s) -> default plus a warning, never a throw', (_label, raw) => {
    const warn = vi.fn();
    const c = resolveEmbeddingModel(raw, warn);
    expect(c.kind === 'enabled' && c.profile.name).toBe(DEFAULT_EMBEDDING_PROFILE);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('readEmbeddingModelSetting', () => {
  let prior: string | null;
  beforeEach(() => {
    prior = fs.existsSync(KB_CONFIG_PATH) ? fs.readFileSync(KB_CONFIG_PATH, 'utf-8') : null;
  });
  afterEach(() => {
    if (prior !== null) fs.writeFileSync(KB_CONFIG_PATH, prior);
    else fs.rmSync(KB_CONFIG_PATH, { force: true });
  });
  const write = (raw: string) => {
    fs.mkdirSync(path.dirname(KB_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(KB_CONFIG_PATH, raw);
  };

  it('absent file or key -> undefined', () => {
    fs.rmSync(KB_CONFIG_PATH, { force: true });
    expect(readEmbeddingModelSetting()).toBeUndefined();
    write(JSON.stringify({ provider: 'sqlite' }));
    expect(readEmbeddingModelSetting()).toBeUndefined();
  });

  it('returns the raw embedding.model value', () => {
    write(JSON.stringify({ embedding: { model: 'none' } }));
    expect(readEmbeddingModelSetting()).toBe('none');
  });

  it('malformed file or embedding value -> undefined, no throw', () => {
    write('{not json');
    expect(readEmbeddingModelSetting()).toBeUndefined();
    write(JSON.stringify({ embedding: 'oops' }));
    expect(readEmbeddingModelSetting()).toBeUndefined();
  });
});

describe('ModelStore', () => {
  const bodies = { 'config.json': '{"a":1}', 'onnx/model_quantized.onnx': 'ONNX-BYTES' };

  it('constructing the store downloads nothing; the first ensure() does', async () => {
    const download = fakeDownload(bodies);
    const store = new ModelStore({ modelsDir: tmp, download });
    expect(download).not.toHaveBeenCalled();
    const state = await store.ensure({ kind: 'enabled', profile: pinnedProfile(bodies) });
    expect(state.state).toBe('ready');
    expect(download).toHaveBeenCalledTimes(2);
    const dir = path.join(tmp, 'Test', 'tiny-model@abc123');
    expect(state.state === 'ready' && state.dir).toBe(dir);
    expect(fs.readFileSync(path.join(dir, 'onnx', 'model_quantized.onnx'), 'utf-8')).toBe('ONNX-BYTES');
  });

  it("'none' -> disabled without any download", async () => {
    const download = fakeDownload(bodies);
    const store = new ModelStore({ modelsDir: tmp, download });
    expect(await store.ensure({ kind: 'disabled' })).toEqual({ state: 'disabled' });
    expect(download).not.toHaveBeenCalled();
  });

  it('sha256 mismatch on a built-in profile -> failed and the bad file removed', async () => {
    const profile = pinnedProfile(bodies);
    const download = fakeDownload({ ...bodies, 'onnx/model_quantized.onnx': 'TAMPERED' });
    const store = new ModelStore({ modelsDir: tmp, download });
    const state = await store.ensure({ kind: 'enabled', profile });
    expect(state.state).toBe('failed');
    expect(state.state === 'failed' && state.reason).toMatch(/sha256 mismatch.*onnx\/model_quantized\.onnx/);
    // Staged download: no model folder at all, and no staging leftovers.
    expect(fs.existsSync(path.join(tmp, 'Test', 'tiny-model@abc123'))).toBe(false);
    expect(fs.readdirSync(path.join(tmp, 'Test'))).toEqual([]);
  });

  it('a corrupt file already on disk is re-downloaded', async () => {
    const profile = pinnedProfile(bodies);
    const dir = path.join(tmp, 'Test', 'tiny-model@abc123');
    fs.mkdirSync(path.join(dir, 'onnx'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), bodies['config.json']);
    fs.writeFileSync(path.join(dir, 'onnx', 'model_quantized.onnx'), 'CORRUPT');
    const download = fakeDownload(bodies);
    const state = await new ModelStore({ modelsDir: tmp, download }).ensure({ kind: 'enabled', profile });
    expect(state.state).toBe('ready');
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('a download failure -> failed with the reason', async () => {
    const download = vi.fn<ModelDownloadFn>(async () => { throw new Error('ECONNREFUSED'); });
    const state = await new ModelStore({ modelsDir: tmp, download }).ensure({ kind: 'enabled', profile: pinnedProfile(bodies) });
    expect(state.state === 'failed' && state.reason).toMatch(/ECONNREFUSED/);
  });

  it('a local folder path resolves without any download', async () => {
    const folder = path.join(tmp, 'air-gapped');
    fs.mkdirSync(path.join(folder, 'onnx'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'onnx', 'model_quantized.onnx'), 'x');
    const choice = resolveEmbeddingModel({ path: folder, pooling: 'cls' }, vi.fn()) as EmbeddingModelChoice;
    const download = fakeDownload(bodies);
    const state = await new ModelStore({ modelsDir: tmp, download }).ensure(choice);
    expect(state).toMatchObject({ state: 'ready', dir: folder });
    expect(download).not.toHaveBeenCalled();
  });

  it('a missing local folder -> failed, no download', async () => {
    const choice = resolveEmbeddingModel({ path: path.join(tmp, 'nope') }, vi.fn());
    const download = fakeDownload(bodies);
    const state = await new ModelStore({ modelsDir: tmp, download }).ensure(choice);
    expect(state.state === 'failed' && state.reason).toMatch(/does not exist/);
    expect(download).not.toHaveBeenCalled();
  });

  it('two concurrent first requests trigger one download', async () => {
    const download = fakeDownload(bodies, { delayMs: 20 });
    const store = new ModelStore({ modelsDir: tmp, download });
    const choice: EmbeddingModelChoice = { kind: 'enabled', profile: pinnedProfile(bodies) };
    const [a, b] = await Promise.all([store.ensure(choice), store.ensure(choice)]);
    expect(a.state).toBe('ready');
    expect(b).toBe(a);
    expect(download).toHaveBeenCalledTimes(2); // one per file, once
  });
});
