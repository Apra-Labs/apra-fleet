/**
 * Integration test for the configurable local embedding model: KB config
 * embedding.model -> profile, lazy download through the model store, the
 * embedder's failure state (fallback at the EMBEDDER level: null vectors,
 * never a throw), and the fleet_status KB section.
 *
 * No network: downloads go through the store's download seam, which serves a
 * tiny real ONNX model (tests/helpers/tiny-embedding-model.ts) that the real
 * onnxruntime-web WASM runtime loads. Every model folder is a per-test temp
 * dir; the KB config file lives in the test sandbox data dir and is restored.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { KB_CONFIG_PATH } from '../../src/services/knowledge/kb-config.js';
import {
  BUILTIN_EMBEDDING_PROFILES,
  DEFAULT_EMBEDDING_PROFILE,
  type EmbeddingProfile,
} from '../../src/services/knowledge/embedding/profiles.js';
import { ModelStore, type ModelDownloadFn } from '../../src/services/knowledge/embedding/model-store.js';
import { Embedder, getEmbedder, _setEmbedderForTest } from '../../src/services/knowledge/embedding/embedder.js';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbHealthSummary, kbHealthCompactLines } from '../../src/tools/check-status.js';
import { tinyModelFiles, writeTinyModel, TINY_DIMS } from '../helpers/tiny-embedding-model.js';

const REPO = 'Test/tiny-embed';
const REV = '0123456789abcdef0123456789abcdef01234567';

/** A built-in-style (sha256-pinned) hub profile whose files are the tiny model. */
function pinnedTinyProfile(): EmbeddingProfile {
  const files = Object.entries(tinyModelFiles()).map(([p, data]) => ({
    path: p,
    sha256: createHash('sha256').update(data).digest('hex'),
  }));
  return {
    name: 'tiny-pinned',
    builtin: true,
    modelId: REPO,
    revision: REV,
    source: { kind: 'hub', repo: REPO, revision: REV, files },
    dtype: 'q8',
    pooling: 'cls',
    normalize: true,
    queryPrefix: '',
    docPrefix: '',
    dims: TINY_DIMS,
    tokenLimit: 512,
  };
}

/** Download seam serving the tiny model (optionally with one file replaced). */
function tinyDownload(override: Record<string, Uint8Array | string> = {}) {
  const files: Record<string, Uint8Array | string> = { ...tinyModelFiles(), ...override };
  return vi.fn<ModelDownloadFn>(async (url, dest) => {
    const rel = url.split(`/resolve/${REV}/`)[1];
    if (!(rel in files)) throw new Error(`unexpected url ${url}`);
    fs.writeFileSync(dest, files[rel]);
  });
}

let tmp: string;
let priorConfig: string | null;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-embed-integ-'));
  priorConfig = fs.existsSync(KB_CONFIG_PATH) ? fs.readFileSync(KB_CONFIG_PATH, 'utf-8') : null;
  _setEmbedderForTest(null);
});

afterEach(() => {
  _setEmbedderForTest(null);
  if (priorConfig !== null) fs.writeFileSync(KB_CONFIG_PATH, priorConfig);
  else fs.rmSync(KB_CONFIG_PATH, { force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeKbConfig(config: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(KB_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(KB_CONFIG_PATH, JSON.stringify(config));
}

describe('embedding.model in the KB config file is configurable', () => {
  it.each(Object.keys(BUILTIN_EMBEDDING_PROFILES))('built-in profile %s', (name) => {
    writeKbConfig({ embedding: { model: name } });
    const e = getEmbedder();
    const profile = BUILTIN_EMBEDDING_PROFILES[name];
    expect(e.profile).toBe(profile);
    expect(e.state).toEqual({ state: 'idle', modelId: profile.modelId, revision: profile.revision });
    expect(e.dims).toBe(384);
    expect(e.tokenLimit).toBe(512);
  });

  it('absent key -> the default profile', () => {
    writeKbConfig({ provider: 'sqlite' });
    expect(getEmbedder().profile).toBe(BUILTIN_EMBEDDING_PROFILES[DEFAULT_EMBEDDING_PROFILE]);
  });

  it('a custom object -> its id, pooling, normalize and prefixes', () => {
    writeKbConfig({
      embedding: { model: { id: 'acme/encoder', revision: '0123456789abcdef0123456789abcdef01234567', pooling: 'mean', normalize: false, query_prefix: 'q: ', doc_prefix: 'd: ' } },
    });
    const e = getEmbedder();
    expect(e.profile).toMatchObject({
      builtin: false, modelId: 'acme/encoder', revision: '0123456789abcdef0123456789abcdef01234567', pooling: 'mean', normalize: false, queryPrefix: 'q: ', docPrefix: 'd: ',
    });
    expect(e.state).toEqual({ state: 'idle', modelId: 'acme/encoder', revision: '0123456789abcdef0123456789abcdef01234567' });
  });

  it("'none' -> disabled", () => {
    writeKbConfig({ embedding: { model: 'none' } });
    expect(getEmbedder().state).toEqual({ state: 'disabled' });
    expect(getEmbedder().profile).toBeNull();
  });
});

describe('the model downloads lazily', () => {
  it('constructing the embedder and the SqliteProvider downloads nothing; the first embedQuery does', async () => {
    const download = tinyDownload();
    const store = new ModelStore({ modelsDir: tmp, download });
    const e = new Embedder({ choice: { kind: 'enabled', profile: pinnedTinyProfile() }, store, log: vi.fn() });
    const provider = new SqliteProvider(path.join(tmp, 'kb', 'kb.sqlite'));
    await provider.init();
    provider.close();
    expect(download).not.toHaveBeenCalled();
    expect(e.state.state).toBe('idle');

    const q = await e.embedQuery('hello world');
    expect(download).toHaveBeenCalledTimes(Object.keys(tinyModelFiles()).length);
    expect(q).toBeInstanceOf(Float32Array);
    expect(q!.length).toBe(TINY_DIMS);
    expect(e.state).toEqual({ state: 'ready', modelId: REPO, revision: REV, dims: TINY_DIMS });
    expect(fs.existsSync(path.join(tmp, 'Test', `tiny-embed@${REV}`, 'onnx', 'model_quantized.onnx'))).toBe(true);

    // Already ready: no second download.
    await e.embedDocuments(['kb search']);
    expect(download).toHaveBeenCalledTimes(Object.keys(tinyModelFiles()).length);
  });
});

describe('fallback at the embedder: null vectors, failed state, one log line', () => {
  async function expectFallback(e: Embedder, log: ReturnType<typeof vi.fn>, reason: RegExp): Promise<void> {
    await expect(e.embedQuery('hello')).resolves.toBeNull();
    await expect(e.embedDocuments(['hello', 'world'])).resolves.toBeNull();
    await expect(e.embedQuery('again')).resolves.toBeNull();
    expect(e.state).toMatchObject({ state: 'failed', reason: expect.stringMatching(reason) });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(reason);
  }

  it('a download that fails (seam throws)', async () => {
    const log = vi.fn();
    const download = vi.fn<ModelDownloadFn>(async () => { throw new Error('getaddrinfo ENOTFOUND huggingface.co'); });
    const e = new Embedder({
      choice: { kind: 'enabled', profile: pinnedTinyProfile() },
      store: new ModelStore({ modelsDir: tmp, download }),
      log,
    });
    await expectFallback(e, log, /ENOTFOUND huggingface\.co/);
  });

  it('a corrupt model folder', async () => {
    const folder = writeTinyModel(path.join(tmp, 'corrupt'));
    fs.writeFileSync(path.join(folder, 'onnx', 'model_quantized.onnx'), 'garbage, not protobuf');
    const log = vi.fn();
    const e = new Embedder({
      choice: { kind: 'enabled', profile: { ...pinnedTinyProfile(), builtin: false, modelId: folder, revision: 'local', source: { kind: 'local', path: folder } } },
      log,
    });
    await expectFallback(e, log, /cannot load .*model_quantized\.onnx/);
  });

  it('a sha256 mismatch on a built-in profile is refused and the file removed', async () => {
    const log = vi.fn();
    const download = tinyDownload({ 'onnx/model_quantized.onnx': 'tampered bytes' });
    const e = new Embedder({
      choice: { kind: 'enabled', profile: pinnedTinyProfile() },
      store: new ModelStore({ modelsDir: tmp, download }),
      log,
    });
    await expectFallback(e, log, /sha256 mismatch/);
    // Staged download: the refused model never reaches its folder; only the
    // resume folder (never a model folder) is left, without the bad file.
    expect(fs.existsSync(path.join(tmp, 'Test', `tiny-embed@${REV}`))).toBe(false);
    expect(fs.readdirSync(path.join(tmp, 'Test'))).toEqual([`tiny-embed@${REV}.partial`]);
    expect(fs.existsSync(path.join(tmp, 'Test', `tiny-embed@${REV}.partial`, 'onnx', 'model_quantized.onnx'))).toBe(false);
  });
});

describe('fleet_status KB section reports the embedding state', () => {
  const noKb = () => path.join(tmp, 'no-kb');

  it('failed, with the reason', async () => {
    const download = vi.fn<ModelDownloadFn>(async () => { throw new Error('HTTP 503 Service Unavailable'); });
    const e = new Embedder({
      choice: { kind: 'enabled', profile: pinnedTinyProfile() },
      store: new ModelStore({ modelsDir: tmp, download }),
      log: vi.fn(),
    });
    await e.embedQuery('x');
    _setEmbedderForTest(e);
    const health = (await kbHealthSummary({ knowledgeDir: noKb() }))!;
    expect(health.embedding).toMatchObject({ state: 'failed', modelId: REPO, revision: REV, reason: expect.stringMatching(/HTTP 503/) });
    expect(kbHealthCompactLines(health)).toMatch(new RegExp(`kb embedding: ${REPO}@${REV} failed: .*HTTP 503`));
  });

  it("disabled with embedding.model 'none' (read from the KB config file)", async () => {
    writeKbConfig({ embedding: { model: 'none' } });
    const health = (await kbHealthSummary({ knowledgeDir: noKb() }))!;
    expect(health.embedding).toEqual({ state: 'disabled' });
    expect(kbHealthCompactLines(health)).toContain('kb embedding: disabled');
  });

  it('ready with model id@revision once a working model has loaded', async () => {
    const e = new Embedder({
      choice: { kind: 'enabled', profile: pinnedTinyProfile() },
      store: new ModelStore({ modelsDir: tmp, download: tinyDownload() }),
      log: vi.fn(),
    });
    await e.embedQuery('hello');
    _setEmbedderForTest(e);
    const health = (await kbHealthSummary({ knowledgeDir: noKb() }))!;
    expect(health.embedding).toEqual({ state: 'ready', modelId: REPO, revision: REV, dims: TINY_DIMS });
    expect(kbHealthCompactLines(health)).toContain(`kb embedding: ${REPO}@${REV} ready (${TINY_DIMS} dims)`);
  });

  it('reading fleet_status never loads or downloads a model', async () => {
    const download = tinyDownload();
    _setEmbedderForTest(new Embedder({
      choice: { kind: 'enabled', profile: pinnedTinyProfile() },
      store: new ModelStore({ modelsDir: tmp, download }),
      log: vi.fn(),
    }));
    const health = (await kbHealthSummary({ knowledgeDir: noKb() }))!;
    expect(health.embedding).toEqual({ state: 'idle', modelId: REPO, revision: REV });
    expect(download).not.toHaveBeenCalled();
  });
});
