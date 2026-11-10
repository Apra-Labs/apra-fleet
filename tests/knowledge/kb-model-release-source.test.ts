/**
 * Model sources (unit level, download seam injected): a built-in model is
 * fetched from the apra-fleet GitHub release first and from Hugging Face when
 * the release fails; every file is sha256-verified whatever its source; when
 * both fail, the reason names both. Plus `kb model import`: a folder or a tar
 * archive in hub layout is verified and placed so ensure() is ready with no
 * download, and a bad hash places nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  BUILTIN_EMBEDDING_PROFILES,
  DEFAULT_EMBEDDING_PROFILE,
  modelReleaseAssetName,
  modelReleaseAssets,
  type EmbeddingProfile,
} from '../../src/services/knowledge/embedding/profiles.js';
import {
  ModelStore,
  defaultModelReleaseBaseUrl,
  type ModelDownloadFn,
} from '../../src/services/knowledge/embedding/model-store.js';
import { readTar, runKbModel } from '../../src/cli/kb-model-import.js';
import { makeTar } from '../helpers/tar-writer.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const REPO = 'Test/rel-model';
const REV = 'rel0123456789abcdef';
const RELEASE = 'http://release.test/download/v9.9.9';
const HUB = 'http://hub.test';
const bodies: Record<string, string> = {
  'config.json': '{"a":1}',
  'tokenizer.json': '{"t":1}',
  'onnx/model_quantized.onnx': 'ONNX-BYTES',
};

function profile(builtin = true): EmbeddingProfile {
  return {
    ...BUILTIN_EMBEDDING_PROFILES[DEFAULT_EMBEDDING_PROFILE],
    builtin,
    source: { kind: 'hub', repo: REPO, revision: REV, files: Object.entries(bodies).map(([p, b]) => ({ path: p, sha256: sha(b) })) },
  };
}

/** Map a requested URL back to the file it names, for either source. */
function fileOf(url: string): string | undefined {
  if (url.startsWith(`${HUB}/`)) return url.split(`/resolve/${REV}/`)[1];
  for (const p of Object.keys(bodies)) if (url === `${RELEASE}/${modelReleaseAssetName(REPO, REV, p)}`) return p;
  return undefined;
}

function seam(opts: { releaseDown?: boolean; hubDown?: boolean; releaseBad?: string } = {}) {
  return vi.fn<ModelDownloadFn>(async (url, dest) => {
    const rel = fileOf(url);
    if (!rel) throw new Error(`unexpected url ${url}`);
    const fromRelease = url.startsWith(RELEASE);
    if (fromRelease && opts.releaseDown) throw new Error('connect ECONNREFUSED release');
    if (!fromRelease && opts.hubDown) throw new Error('HTTP 503 Service Unavailable');
    fs.writeFileSync(dest, fromRelease && opts.releaseBad === rel ? 'TAMPERED' : bodies[rel]);
  });
}

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-model-rel-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const store = (download: ModelDownloadFn, releaseBaseUrl: string | null = RELEASE) =>
  new ModelStore({ modelsDir: path.join(tmp, 'models'), download, hubEndpoint: HUB, releaseBaseUrl });

describe('release asset names', () => {
  it('are flat, GitHub-safe and derived from repo, revision and path', () => {
    expect(modelReleaseAssetName('Snowflake/snowflake-arctic-embed-xs', 'd8c86521100d3556476a063fc2342036d45c106f', 'onnx/model_quantized.onnx'))
      .toBe('kbmodel-Snowflake.snowflake-arctic-embed-xs-d8c86521100d-onnx.model_quantized.onnx');
    const assets = modelReleaseAssets(BUILTIN_EMBEDDING_PROFILES[DEFAULT_EMBEDDING_PROFILE]);
    expect(assets.length).toBe(5);
    for (const a of assets) expect(a.name).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(new Set(assets.map((a) => a.name)).size).toBe(assets.length);
  });

  it('default release URL is the running version tag; the env var overrides or turns it off', () => {
    expect(defaultModelReleaseBaseUrl({}, 'v0.4.5')).toBe('https://github.com/Apra-Labs/apra-fleet/releases/download/v0.4.5');
    expect(defaultModelReleaseBaseUrl({ APRA_FLEET_MODEL_RELEASE_URL: 'http://127.0.0.1:1/x/' }, 'v0.4.5')).toBe('http://127.0.0.1:1/x');
    expect(defaultModelReleaseBaseUrl({ APRA_FLEET_MODEL_RELEASE_URL: 'off' }, 'v0.4.5')).toBeNull();
    expect(defaultModelReleaseBaseUrl({ APRA_FLEET_MODEL_RELEASE_URL: '' }, 'v0.4.5')).toBeNull();
  });
});

describe('source order: release, then Hugging Face', () => {
  it('everything from the release when it serves; Hugging Face is never asked', async () => {
    const download = seam();
    const state = await store(download).ensure({ kind: 'enabled', profile: profile() });
    expect(state.state).toBe('ready');
    const urls = download.mock.calls.map((c) => c[0]);
    expect(urls.every((u) => u.startsWith(RELEASE))).toBe(true);
    expect(urls.length).toBe(3);
  });

  it('Hugging Face down: downloads from the release', async () => {
    const state = await store(seam({ hubDown: true })).ensure({ kind: 'enabled', profile: profile() });
    expect(state.state).toBe('ready');
  });

  it('release down: falls through to Hugging Face, release not re-asked after its first failure', async () => {
    const download = seam({ releaseDown: true });
    const state = await store(download).ensure({ kind: 'enabled', profile: profile() });
    expect(state.state).toBe('ready');
    const releaseCalls = download.mock.calls.filter((c) => c[0].startsWith(RELEASE));
    expect(releaseCalls.length).toBe(1);
  });

  it('release serves a bad hash for one file: that file comes from Hugging Face', async () => {
    const download = seam({ releaseBad: 'tokenizer.json' });
    const state = await store(download).ensure({ kind: 'enabled', profile: profile() });
    expect(state.state).toBe('ready');
    expect(download.mock.calls.map((c) => c[0])).toContain(`${HUB}/${REPO}/resolve/${REV}/tokenizer.json`);
    if (state.state === 'ready') expect(fs.readFileSync(path.join(state.dir, 'tokenizer.json'), 'utf-8')).toBe(bodies['tokenizer.json']);
  });

  it('both down: failed, the reason names both sources and why', async () => {
    const state = await store(seam({ releaseDown: true, hubDown: true })).ensure({ kind: 'enabled', profile: profile() });
    expect(state.state).toBe('failed');
    const reason = state.state === 'failed' ? state.reason : '';
    expect(reason).toMatch(/failed from every source/);
    expect(reason).toMatch(/GitHub release \(http:\/\/release\.test\/.*\): connect ECONNREFUSED release/);
    expect(reason).toMatch(/Hugging Face \(http:\/\/hub\.test\/.*\): HTTP 503/);
  });

  it('a custom (non-built-in) model never asks the release', async () => {
    const download = seam();
    const state = await store(download).ensure({ kind: 'enabled', profile: profile(false) });
    expect(state.state).toBe('ready');
    expect(download.mock.calls.every((c) => c[0].startsWith(HUB))).toBe(true);
  });
});

describe('kb model import', () => {
  const io = () => ({ log: vi.fn(), error: vi.fn() });

  function writeFolder(dir: string, files: Record<string, string>): void {
    for (const [p, b] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      fs.writeFileSync(path.join(dir, p), b);
    }
  }

  it('a folder: placed, then ensure() is ready with no download', async () => {
    const src = path.join(tmp, 'in');
    writeFolder(src, bodies);
    const download = seam();
    const s = store(download);
    const out = io();
    expect(await runKbModel(['import', src], out, { store: s, profile: profile() })).toBe(0);
    const state = await s.ensure({ kind: 'enabled', profile: profile() });
    expect(state.state).toBe('ready');
    expect(download).not.toHaveBeenCalled();
  });

  it('a .tar.gz archive with a top-level folder: placed and ready', async () => {
    const archive = path.join(tmp, 'model.tar.gz');
    fs.writeFileSync(archive, makeTar(Object.fromEntries(Object.entries(bodies).map(([p, b]) => [`rel-model/${p}`, b])), { gzip: true }));
    const s = store(seam());
    expect(await runKbModel(['import', archive], io(), { store: s, profile: profile() })).toBe(0);
    expect((await s.ensure({ kind: 'enabled', profile: profile() })).state).toBe('ready');
  });

  it('a tampered file: non-zero, names the file, nothing placed', async () => {
    const src = path.join(tmp, 'in');
    writeFolder(src, { ...bodies, 'tokenizer.json': 'TAMPERED' });
    const s = store(seam());
    const out = io();
    expect(await runKbModel(['import', src], out, { store: s, profile: profile() })).toBe(1);
    expect(out.error.mock.calls.join('\n')).toMatch(/sha256 mismatch for tokenizer\.json/);
    expect(fs.existsSync(s.modelDir(profile()))).toBe(false);
    expect(fs.readdirSync(path.dirname(s.modelDir(profile())))).toEqual([]);
  });

  it('a missing file: non-zero, names the file, nothing placed', async () => {
    const src = path.join(tmp, 'in');
    writeFolder(src, { 'config.json': bodies['config.json'], 'tokenizer.json': bodies['tokenizer.json'] });
    const s = store(seam());
    const out = io();
    expect(await runKbModel(['import', src], out, { store: s, profile: profile() })).toBe(1);
    expect(out.error.mock.calls.join('\n')).toMatch(/missing file onnx\/model_quantized\.onnx/);
    expect(fs.existsSync(s.modelDir(profile()))).toBe(false);
  });

  it('usage errors: no subcommand, unknown model, not an archive', async () => {
    expect(await runKbModel([], io())).toBe(1);
    expect(await runKbModel(['import', tmp, '--model', 'nope'], io())).toBe(1);
    const junk = path.join(tmp, 'junk.bin');
    fs.writeFileSync(junk, Buffer.alloc(1024, 7));
    const out = io();
    expect(await runKbModel(['import', junk], out, { store: store(seam()), profile: profile() })).toBe(1);
    expect(out.error.mock.calls.join('\n')).toMatch(/cannot read .* as a \.tar or \.tar\.gz archive/);
  });

  it('readTar reads long names through the ustar prefix', () => {
    const long = `${'d'.repeat(120)}/onnx/model_quantized.onnx`;
    const files = readTar(makeTar({ [long]: 'X' }));
    expect(files).toEqual([{ name: long, data: Buffer.from('X') }]);
  });
});
