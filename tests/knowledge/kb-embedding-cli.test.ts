import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runKbEmbedding, KB_EMBEDDING_USAGE } from '../../src/cli/kb-embedding.js';
import { getEmbedder, _setEmbedderForTest } from '../../src/services/knowledge/embedding/embedder.js';
import { DEFAULT_EMBEDDING_PROFILE } from '../../src/services/knowledge/embedding/profiles.js';
import { FLEET_DIR } from '../../src/paths.js';

// `apra-fleet kb embedding` and the server-side re-read of embedding.model on
// a KB config change. FLEET_DIR is the per-run test sandbox; every test starts
// with no config and puts back whatever was there.

const configPath = path.join(FLEET_DIR, 'knowledge', 'config.json');
let savedConfig: string | null;

beforeEach(() => {
  savedConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : null;
  fs.rmSync(configPath, { force: true });
  _setEmbedderForTest(null);
});

afterEach(() => {
  _setEmbedderForTest(null);
  if (savedConfig === null) fs.rmSync(configPath, { force: true });
  else fs.writeFileSync(configPath, savedConfig);
  vi.restoreAllMocks();
});

function writeConfig(config: unknown): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, typeof config === 'string' ? config : JSON.stringify(config, null, 2));
}

function readConfig(): Record<string, any> {
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { log: (m: string) => out.push(m), error: (m: string) => err.push(m) }, out, err };
}

const OTHER_KEYS = {
  provider: 'http',
  url: 'https://kb.example.test',
  token_ref: '{{secret.KB_TOKEN}}',
  tool_profile: 'developer',
  an_unknown_key: [1, 2, 3],
};

describe('apra-fleet kb embedding', () => {
  it('with no argument prints the default when nothing is set, and the configured value otherwise', async () => {
    const a = captureIo();
    expect(await runKbEmbedding([], a.io)).toBe(0);
    expect(a.out).toEqual([`KB embedding model: ${DEFAULT_EMBEDDING_PROFILE} (default, not set in the KB config)`]);
    expect(fs.existsSync(configPath)).toBe(false);

    writeConfig({ embedding: { model: 'bge-small-en-v1.5' } });
    const b = captureIo();
    expect(await runKbEmbedding([], b.io)).toBe(0);
    expect(b.out).toEqual(['KB embedding model: bge-small-en-v1.5']);
  });

  it('writes none and prints what changed, keeping every other key', async () => {
    writeConfig(OTHER_KEYS);
    const { io, out, err } = captureIo();
    expect(await runKbEmbedding(['none'], io)).toBe(0);
    expect(err).toEqual([]);
    expect(out[0]).toBe(`KB embedding model: ${DEFAULT_EMBEDDING_PROFILE} (default, not set in the KB config) -> none (semantic search off; keyword and anchor search serve)`);
    expect(out.some(l => /no restart needed/.test(l))).toBe(true);
    expect(readConfig()).toEqual({ ...OTHER_KEYS, embedding: { model: 'none' } });
  });

  it('writes a built-in name over none', async () => {
    writeConfig({ ...OTHER_KEYS, embedding: { model: 'none' } });
    const { io, out } = captureIo();
    expect(await runKbEmbedding(['snowflake-arctic-embed-s'], io)).toBe(0);
    expect(out[0]).toMatch(/^KB embedding model: none .* -> snowflake-arctic-embed-s$/);
    expect(readConfig()).toEqual({ ...OTHER_KEYS, embedding: { model: 'snowflake-arctic-embed-s' } });
  });

  it('an unknown name exits non-zero and leaves the file byte-identical', async () => {
    writeConfig({ ...OTHER_KEYS, embedding: { model: 'none' } });
    const before = fs.readFileSync(configPath);
    const { io, err } = captureIo();
    expect(await runKbEmbedding(['no-such-model'], io)).toBe(1);
    expect(err[0]).toMatch(/unknown embedding model "no-such-model"; nothing was written/);
    expect(fs.readFileSync(configPath).equals(before)).toBe(true);
  });

  it('an unknown name with no config file creates nothing', async () => {
    const { io } = captureIo();
    expect(await runKbEmbedding(['nope'], io)).toBe(1);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  for (const [label, content] of [['not valid JSON', '{ "provider": "http", '], ['not a JSON object', '["none"]']] as const) {
    it(`never overwrites a config file that is ${label}`, async () => {
      writeConfig(content);
      const set = captureIo();
      expect(await runKbEmbedding(['none'], set.io)).toBe(1);
      expect(set.err[0]).toMatch(/nothing was written/);
      expect(set.err[1]).toMatch(/Fix that file by hand/);
      expect(fs.readFileSync(configPath, 'utf-8')).toBe(content);
      const show = captureIo();
      expect(await runKbEmbedding([], show.io)).toBe(1);
      expect(fs.readFileSync(configPath, 'utf-8')).toBe(content);
    });
  }

  it('refuses extra arguments and prints usage for --help', async () => {
    const extra = captureIo();
    expect(await runKbEmbedding(['none', 'bge-small-en-v1.5'], extra.io)).toBe(1);
    expect(extra.err).toContain(KB_EMBEDDING_USAGE);
    const help = captureIo();
    expect(await runKbEmbedding(['--help'], help.io)).toBe(0);
    expect(help.out).toEqual([KB_EMBEDDING_USAGE]);
  });
});

describe('server re-reads embedding.model when the KB config changes', () => {
  /** How many times the KB config file was read (readFileSync) since the spy was set. */
  function spyConfigReads(): () => number {
    const spy = vi.spyOn(fs, 'readFileSync');
    return () => spy.mock.calls.filter(c => String(c[0]) === configPath).length;
  }

  it('does no config read (so no JSON parse) while the file is unchanged', () => {
    writeConfig({ ...OTHER_KEYS, embedding: { model: 'none' } });
    const e = getEmbedder();
    const reads = spyConfigReads();
    for (let i = 0; i < 50; i++) expect(getEmbedder()).toBe(e);
    expect(reads()).toBe(0);
  });

  it('a write by another process (the CLI) switches the running embedder on the next call, both ways', async () => {
    const enabled = getEmbedder();
    expect(enabled.state.state).toBe('idle');
    const reads = spyConfigReads();

    // Simulates the CLI in a separate process: only the file changes.
    writeConfig({ ...OTHER_KEYS, embedding: { model: 'none' } });
    const disabled = getEmbedder();
    expect(disabled).not.toBe(enabled);
    expect(disabled.state).toEqual({ state: 'disabled' });
    expect(reads()).toBe(1);
    expect(getEmbedder()).toBe(disabled);
    expect(reads()).toBe(1);
    await vi.waitFor(() => expect(enabled.retired).toBe(true));

    writeConfig({ ...OTHER_KEYS, embedding: { model: 'bge-small-en-v1.5' } });
    const back = getEmbedder();
    expect(back.state.state).toBe('idle');
    expect(back.modelId).toBe('Xenova/bge-small-en-v1.5');
  });

  it('a changed file that resolves to the same choice keeps the same embedder', () => {
    writeConfig({ embedding: { model: 'none' } });
    const e = getEmbedder();
    writeConfig({ provider: 'sqlite', embedding: { model: 'none' } });
    expect(getEmbedder()).toBe(e);
    expect(e.retired).toBe(false);
  });

  it('a value that no longer resolves, or a broken file, keeps the current embedder and never throws', () => {
    writeConfig({ embedding: { model: 'none' } });
    const e = getEmbedder();
    writeConfig({ embedding: { model: 'no-such-model' } });
    expect(getEmbedder()).toBe(e);
    writeConfig('{ "embedding": ');
    expect(getEmbedder()).toBe(e);
    writeConfig({ embedding: 'none' });
    expect(getEmbedder()).toBe(e);
    expect(e.state).toEqual({ state: 'disabled' });
    // Fixed again: a real change is picked up.
    writeConfig({ embedding: { model: 'snowflake-arctic-embed-s' } });
    expect(getEmbedder()).not.toBe(e);
  });

  it('deleting the config file goes back to the default model', () => {
    writeConfig({ embedding: { model: 'none' } });
    const e = getEmbedder();
    fs.rmSync(configPath);
    const d = getEmbedder();
    expect(d).not.toBe(e);
    expect(d.profile?.name).toBe(DEFAULT_EMBEDDING_PROFILE);
  });

  it('the CLI verb run in this process switches it at once too', async () => {
    const e = getEmbedder();
    const { io, out } = captureIo();
    expect(await runKbEmbedding(['none'], io)).toBe(0);
    expect(out.some(l => /switched to it now/.test(l))).toBe(true);
    expect(getEmbedder()).not.toBe(e);
    expect(getEmbedder().state).toEqual({ state: 'disabled' });
  });
});
