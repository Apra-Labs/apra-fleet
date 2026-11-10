import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { kbSetup, writeKbEmbeddingModel, checkEmbeddingModel } from '../../src/tools/kb-setup.js';
import {
  Embedder,
  getEmbedder,
  switchEmbedder,
  _setEmbedderForTest,
} from '../../src/services/knowledge/embedding/embedder.js';
import { resolveEmbeddingModel, DEFAULT_EMBEDDING_PROFILE, BUILTIN_EMBEDDING_PROFILES } from '../../src/services/knowledge/embedding/profiles.js';
import { KbConfigUnreadableError } from '../../src/services/knowledge/kb-config.js';
import { FLEET_DIR } from '../../src/paths.js';
import { isolateGitConfig } from './isolate-git-config.js';

// kb_setup embedding_model: validated before anything is written, merged into
// the KB config keeping every other key, and switched live in this process.
// FLEET_DIR is shared by the run: every test starts from no config and puts
// back whatever was there.

let tmpDir: string;
const configPath = path.join(FLEET_DIR, 'knowledge', 'config.json');
let savedConfig: string | null;
let restoreGitConfig: () => void;

beforeEach(() => {
  restoreGitConfig = isolateGitConfig();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-setup-embedding-test-'));
  execFileSync('git', ['init', '-q'], { cwd: tmpDir });
  savedConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : null;
  fs.rmSync(configPath, { force: true });
  _setEmbedderForTest(null);
});

afterEach(() => {
  _setEmbedderForTest(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (savedConfig === null) fs.rmSync(configPath, { force: true });
  else fs.writeFileSync(configPath, savedConfig);
  restoreGitConfig();
  vi.restoreAllMocks();
});

function readConfig(): Record<string, any> {
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

function writeConfig(config: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

const FULL_CONFIG = {
  provider: 'http',
  url: 'https://kb.example.test',
  token_ref: '{{secret.KB_TOKEN}}',
  request_timeout_ms: 9000,
  bible: { autoCommit: false },
  tool_profile: 'developer',
  some_future_key: { a: 1 },
  embedding: { model: 'bge-small-en-v1.5', note: 'kept' },
};

describe('kb_setup embedding_model writes', () => {
  it('keeps every other key in the KB config (kb_setup)', async () => {
    writeConfig(FULL_CONFIG);
    const result = JSON.parse(await kbSetup({ embedding_model: 'none' }, { folder: tmpDir }));
    expect(result.success).toBe(true);
    expect(result.steps.some((s: string) => /embedding model to none/.test(s))).toBe(true);
    expect(readConfig()).toEqual({ ...FULL_CONFIG, embedding: { model: 'none', note: 'kept' } });
  });

  it('keeps every other key in the KB config (writeKbEmbeddingModel)', async () => {
    writeConfig(FULL_CONFIG);
    const { steps } = await writeKbEmbeddingModel('snowflake-arctic-embed-s');
    expect(steps[0]).toMatch(/embedding model to snowflake-arctic-embed-s/);
    expect(readConfig()).toEqual({ ...FULL_CONFIG, embedding: { model: 'snowflake-arctic-embed-s', note: 'kept' } });
  });

  it('accepts a custom-model object and stores it as given', async () => {
    const custom = { path: path.join(tmpDir, 'my-model'), pooling: 'mean', dims: 8 };
    await kbSetup({ embedding_model: custom }, { folder: tmpDir });
    expect(readConfig().embedding).toEqual({ model: custom });
  });

  const MALFORMED: Array<[string, unknown]> = [
    ['an unknown name', 'no-such-model'],
    ['a custom object without id or path', { pooling: 'cls' }],
    ['a hub id without a commit sha', { id: 'acme/model', revision: 'main' }],
    ['a bad pooling', { path: '/models/x', pooling: 'max' }],
    ['a relative path', { path: 'models/x' }],
    ['null', null],
    ['a number', 42],
    ['an array', ['none']],
  ];

  for (const [label, value] of MALFORMED) {
    it(`refuses ${label} and leaves the config byte-identical (kb_setup and the shared writer)`, async () => {
      writeConfig(FULL_CONFIG);
      const before = fs.readFileSync(configPath);
      await expect(kbSetup({ embedding_model: value as any }, { folder: tmpDir })).rejects.toThrow(/kb_setup: embedding_model is not valid/);
      expect(fs.readFileSync(configPath).equals(before)).toBe(true);
      await expect(writeKbEmbeddingModel(value)).rejects.toThrow(/embedding_model is not valid/);
      expect(fs.readFileSync(configPath).equals(before)).toBe(true);
      // No hook was installed either: validation ran before any side effect.
      expect(fs.existsSync(path.join(tmpDir, '.git', 'hooks', 'post-commit'))).toBe(false);
    });
  }

  it('the shared writer never overwrites a config it cannot parse', async () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '{ "provider": "http", broken');
    const before = fs.readFileSync(configPath);
    await expect(writeKbEmbeddingModel('none')).rejects.toBeInstanceOf(KbConfigUnreadableError);
    expect(fs.readFileSync(configPath).equals(before)).toBe(true);
    fs.writeFileSync(configPath, '[1, 2]');
    await expect(writeKbEmbeddingModel('none')).rejects.toBeInstanceOf(KbConfigUnreadableError);
    expect(fs.readFileSync(configPath, 'utf-8')).toBe('[1, 2]');
  });

  it('checkEmbeddingModel names the problem without the fallback wording', () => {
    expect(() => checkEmbeddingModel('nope')).toThrow(/"nope" is not a built-in profile/);
    expect(() => checkEmbeddingModel('nope')).not.toThrow(/using the default/);
    expect(() => checkEmbeddingModel(undefined)).toThrow(/needs a value/);
    expect(checkEmbeddingModel('none')).toEqual({ kind: 'disabled' });
  });
});

describe('live switch of the process embedder (no restart)', () => {
  it('kb_setup none disables the running embedder; a built-in name re-enables it', async () => {
    const before = getEmbedder();
    expect(before.state.state).toBe('idle');
    expect(before.modelId).toBe(BUILTIN_EMBEDDING_PROFILES[DEFAULT_EMBEDDING_PROFILE].modelId);

    const off = JSON.parse(await kbSetup({ embedding_model: 'none' }, { folder: tmpDir }));
    expect(off.steps.some((s: string) => /switched to it now/.test(s))).toBe(true);
    const disabled = getEmbedder();
    expect(disabled).not.toBe(before);
    expect(disabled.state).toEqual({ state: 'disabled' });
    expect(before.retired).toBe(true);

    await kbSetup({ embedding_model: 'bge-small-en-v1.5' }, { folder: tmpDir });
    const back = getEmbedder();
    expect(back).not.toBe(disabled);
    expect(back.state.state).toBe('idle');
    expect(back.modelId).toBe('Xenova/bge-small-en-v1.5');
    expect(disabled.retired).toBe(true);
  });

  it('setting the active choice again keeps the same embedder', async () => {
    writeConfig({ embedding: { model: 'none' } });
    const e = getEmbedder();
    expect(e.state.state).toBe('disabled');
    expect(await switchEmbedder(resolveEmbeddingModel('none', () => {}))).toBe(false);
    await kbSetup({ embedding_model: 'none' }, { folder: tmpDir });
    expect(getEmbedder()).toBe(e);
    expect(e.retired).toBe(false);
  });

  it('before the process built its embedder the switch is a no-op and the first use reads the new value', async () => {
    const { steps } = await writeKbEmbeddingModel('none');
    expect(steps[0]).toMatch(/takes effect on the next KB search/);
    expect(getEmbedder().state).toEqual({ state: 'disabled' });
  });

  it('a retired embedder never loads: embed calls resolve null without touching the store or runtime', async () => {
    const ensure = vi.fn();
    const runtimeFactory = vi.fn();
    const e = new Embedder({
      choice: resolveEmbeddingModel('bge-small-en-v1.5', () => {}),
      store: { ensure } as any,
      runtimeFactory,
    });
    await e.retire();
    expect(e.retired).toBe(true);
    e.warmUp();
    expect(await e.embedQuery('hello')).toBeNull();
    expect(await e.embedDocuments(['hello'])).toBeNull();
    expect(ensure).not.toHaveBeenCalled();
    expect(runtimeFactory).not.toHaveBeenCalled();
  });

  it('a load that finishes after retire closes its runtime instead of keeping it', async () => {
    let finishLoad!: () => void;
    const loaded = new Promise<void>(r => { finishLoad = r; });
    const close = vi.fn(async () => {});
    const e = new Embedder({
      choice: resolveEmbeddingModel('bge-small-en-v1.5', () => {}),
      store: { ensure: async () => { await loaded; return { state: 'ready', dir: tmpDir }; } } as any,
      runtimeFactory: async () => ({ dims: 4, embed: async (t: string[]) => t.map(() => new Float32Array(4)), close }),
      log: () => {},
    });
    const pending = e.embedQuery('hello');
    const retiring = e.retire();
    finishLoad();
    await retiring;
    expect(await pending).toBeNull();
    expect(close).toHaveBeenCalled();
    expect(e.state.state).not.toBe('ready');
  });
});
