/**
 * Semantic search comes back after a restart without any write: when the KB
 * already has vectors for the active model, the background embed queue loads
 * the model after open (off the request path), and a failed load is retried
 * after a bounded backoff instead of staying failed for the life of the
 * process. With APRA_FLEET_KB_EMBED=off nothing loads and nothing retries.
 *
 * Real SqliteProvider on a temp kb.sqlite and the real Embedder class; only
 * the model runtime is a fake that understands paraphrase (words mapped to a
 * shared concept before hashing), so no download and no ONNX.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import {
  Embedder,
  embedderRetryDelayMs,
  EMBEDDER_RETRY_INITIAL_MS,
  EMBEDDER_RETRY_MAX_MS,
  _setEmbedderForTest,
  type EmbeddingRuntime,
  type EmbeddingRuntimeFactory,
} from '../../src/services/knowledge/embedding/embedder.js';
import { resolveEmbeddingModel, type EmbeddingModelChoice } from '../../src/services/knowledge/embedding/profiles.js';
import { kbEmbedderSource } from '../../src/services/knowledge/kb-providers.js';
import { hashedBagOfWords } from '../helpers/fake-embedder.js';
import { writeTinyModel } from '../helpers/tiny-embedding-model.js';

const ALL_TIERS = ['CONFIRMED', 'INFERRED', 'UNVERIFIED'] as const;
const CONCEPTS: Record<string, string> = {
  car: 'c_vehicle', automobile: 'c_vehicle',
  engine: 'c_motor', motor: 'c_motor',
  fix: 'c_repair', mending: 'c_repair',
  stalls: 'c_stop', dies: 'c_stop',
};
const PARAPHRASE = 'automobile dies mending';
const DIMS = 64;

function conceptRuntime(): EmbeddingRuntime {
  return {
    dims: DIMS,
    async embed(texts) {
      return texts.map((t) => {
        const mapped = (t.toLowerCase().match(/[a-z0-9_]+/g) ?? []).map((w) => CONCEPTS[w] ?? w).join(' ');
        return hashedBagOfWords(mapped, DIMS, 'concept');
      });
    },
  };
}

let tmp: string;
let repo: string;
let modelDir: string;
let choice: EmbeddingModelChoice;
let tmpBefore: string[];

beforeEach(() => {
  tmpBefore = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('kb-startup-load-'));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-startup-load-'));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  // A local model folder only satisfies the model store; the runtime is the fake.
  modelDir = writeTinyModel(path.join(tmp, 'model'));
  choice = resolveEmbeddingModel({ path: modelDir }, () => {});
});
afterEach(() => {
  vi.useRealTimers();
  _setEmbedderForTest(null);
  fs.rmSync(tmp, { recursive: true, force: true });
  expect(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('kb-startup-load-'))).toEqual(tmpBefore);
});

async function captureEntry(p: SqliteProvider, title: string, summary: string): Promise<string> {
  const out = await p.capture({
    type: 'learning', title, summary, content: summary,
    source_files: ['src/a.ts'], symbols: [], tags: [], content_hash: '', content_hash_type: 'sha256',
    flagged_for_review: false, author: 't', source: 'doer', confidence: 'INFERRED',
  });
  return (out as { id: string }).id;
}

const ids = (r: { results: { id: string }[] }) => r.results.map((e) => e.id);
const query = (p: SqliteProvider, q: string) => p.query({ query: q, confidence: [...ALL_TIERS], limit: 10 });

/** Run 1: embed two entries, close. Returns the KB file and the target id. */
async function seedEmbeddedKb(): Promise<{ file: string; target: string }> {
  const file = path.join(tmp, 'kb.sqlite');
  const p = new SqliteProvider(file, repo);
  const e = new Embedder({ choice, runtimeFactory: async () => conceptRuntime(), log: () => {} });
  p.attachEmbedder(() => e);
  await p.init();
  const target = await captureEntry(p, 'Car engine stalls', 'fix the motor by reseating the sensor');
  await captureEntry(p, 'Database backup rotation', 'snapshots are pruned weekly');
  expect(await p.waitForEmbeddings(5000)).toBe(true);
  expect(p.vectorStore.count()).toBeGreaterThan(0);
  // Sanity: in the run that embedded them, the paraphrase finds the target.
  expect(ids(await query(p, PARAPHRASE))[0]).toBe(target);
  p.close();
  await e.close();
  return { file, target };
}

/** Let pending immediates and microtasks run (fake timers leave setImmediate real). */
async function settle(cond: () => boolean, rounds = 2000): Promise<void> {
  for (let i = 0; i < rounds && !cond(); i++) await new Promise((r) => setImmediate(r));
  expect(cond()).toBe(true);
}

describe('restart on a KB that already has vectors', () => {
  it('loads the model in the background after open; the first request is not delayed; paraphrase then hits', async () => {
    const { file, target } = await seedEmbeddedKb();

    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((r) => { releaseLoad = r; });
    const factory = vi.fn<EmbeddingRuntimeFactory>(async () => { await loadGate; return conceptRuntime(); });
    const e = new Embedder({ choice, runtimeFactory: factory, log: () => {} });
    const p = new SqliteProvider(file, repo);
    p.attachEmbedder(() => e);
    await p.init();
    try {
      // No capture: the queue's post-open run starts the load on its own.
      await settle(() => factory.mock.calls.length === 1);
      expect(e.state.state).toBe('loading');

      // The first request runs while the load is held: answered at once, keyword-only.
      const started = Date.now();
      const first = await query(p, PARAPHRASE);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(ids(first)).toEqual([]);

      releaseLoad();
      await settle(() => e.state.state === 'ready');
      expect(ids(await query(p, PARAPHRASE))[0]).toBe(target);
      expect(factory).toHaveBeenCalledTimes(1);
    } finally {
      p.close();
      await e.close();
    }
  });

  it('a ready embedder after restart still drops a paraphrase scoring below the floor: [] is the floor, not loading', async () => {
    // An empty paraphrase result after a restart has two possible causes:
    // the model never loaded, or the target's best vector scored below the
    // model's similarity floor (hybridRows then answers exactly as keyword
    // search does). This pins the second: no write, the embedder reaches
    // ready, nothing is re-embedded, and the floor alone decides.
    const { file, target } = await seedEmbeddedKb();

    // The target's real score for the paraphrase under the fake runtime.
    const probe = new Embedder({ choice, runtimeFactory: async () => conceptRuntime(), log: () => {} });
    const scoring = new SqliteProvider(file, repo);
    await scoring.init();
    const qv = await probe.embedQuery(PARAPHRASE);
    const model = { modelId: probe.modelId!, revision: probe.revision!, dims: qv!.length };
    const score = scoring.scoreVectorsForModel(qv!, model).find((s) => s.entry_id === target)!.score;
    scoring.close();
    await probe.close();
    expect(score).toBeGreaterThan(0.1);

    // Same model identity, with a floor just above the target's score.
    const floored = resolveEmbeddingModel({ path: modelDir, semantic_floor: Math.min(1, score + 0.05) }, () => {});
    expect(floored.kind === 'enabled' && choice.kind === 'enabled'
      && floored.profile.modelId === choice.profile.modelId && floored.profile.revision === choice.profile.revision).toBe(true);
    const e = new Embedder({ choice: floored, runtimeFactory: async () => conceptRuntime(), log: () => {} });
    const p = new SqliteProvider(file, repo);
    p.attachEmbedder(() => e);
    await p.init();
    try {
      const vectorsBefore = p.vectorStore.count();
      // No capture: the post-open queue run loads the model on its own.
      await settle(() => e.state.state === 'ready');
      expect(p.vectorIndexStatus().pending).toBe(0);
      expect(p.vectorStore.count()).toBe(vectorsBefore);

      // Below the floor: exactly the keyword-only answer (empty here).
      const keywordOnly = ids(await p.query({ query: PARAPHRASE, confidence: [...ALL_TIERS], limit: 10, disable_lists: ['semantic'] }));
      expect(keywordOnly).not.toContain(target);
      expect(ids(await query(p, PARAPHRASE))).toEqual(keywordOnly);
      // The semantic list is there: a floor just under the score returns the target.
      const under = await p.query({ query: PARAPHRASE, confidence: [...ALL_TIERS], limit: 10, semantic_floor: score - 0.01 });
      expect(ids(under)[0]).toBe(target);
    } finally {
      p.close();
      await e.close();
    }
  });

  it('a load that fails once is retried after the bounded wait, then semantic results appear', async () => {
    const { file, target } = await seedEmbeddedKb();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const log = vi.fn();
    let calls = 0;
    const factory = vi.fn<EmbeddingRuntimeFactory>(async () => {
      if (++calls === 1) throw new Error('wasm backend exploded');
      return conceptRuntime();
    });
    const e = new Embedder({ choice, runtimeFactory: factory, log });
    const p = new SqliteProvider(file, repo);
    p.attachEmbedder(() => e);
    await p.init();
    try {
      await settle(() => e.state.state === 'failed');
      expect(factory).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).toMatch(/wasm backend exploded.*retrying in 60 s/);
      expect(ids(await query(p, PARAPHRASE))).toEqual([]);

      // Not before the bounded wait...
      await vi.advanceTimersByTimeAsync(EMBEDDER_RETRY_INITIAL_MS - 1);
      expect(factory).toHaveBeenCalledTimes(1);
      // ...and exactly at it.
      await vi.advanceTimersByTimeAsync(1);
      await settle(() => e.state.state === 'ready');
      expect(factory).toHaveBeenCalledTimes(2);
      expect(log.mock.calls.filter(([m]) => /retry/.test(String(m)))).toHaveLength(2);
      expect(ids(await query(p, PARAPHRASE))[0]).toBe(target);
    } finally {
      p.close();
      await e.close();
    }
  });

  it('repeated failures back off with a capped interval, one log line per attempt', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const log = vi.fn();
    const factory = vi.fn<EmbeddingRuntimeFactory>(async () => { throw new Error('still broken'); });
    const e = new Embedder({ choice, runtimeFactory: factory, log });
    e.warmUp();
    await settle(() => e.state.state === 'failed');
    let elapsed = 0;
    const waits: number[] = [];
    for (let attempt = 1; attempt <= 8; attempt++) {
      const want = embedderRetryDelayMs(attempt);
      waits.push(want);
      await vi.advanceTimersByTimeAsync(want - 1);
      expect(factory).toHaveBeenCalledTimes(attempt);
      await vi.advanceTimersByTimeAsync(1);
      elapsed += want;
      await settle(() => factory.mock.calls.length === attempt + 1 && e.state.state === 'failed');
    }
    expect(waits[0]).toBe(EMBEDDER_RETRY_INITIAL_MS);
    expect(waits[1]).toBe(EMBEDDER_RETRY_INITIAL_MS * 2);
    expect(Math.max(...waits)).toBe(EMBEDDER_RETRY_MAX_MS);
    expect(elapsed).toBeGreaterThan(0);
    // One line per failed attempt (initial + 8 retries).
    expect(log).toHaveBeenCalledTimes(9);
    // close() stops the retries.
    await e.close();
    await vi.advanceTimersByTimeAsync(EMBEDDER_RETRY_MAX_MS * 2);
    expect(factory).toHaveBeenCalledTimes(9);
  });
});

describe('APRA_FLEET_KB_EMBED=off', () => {
  it('nothing loads and nothing retries, even on a KB that has vectors', async () => {
    const { file } = await seedEmbeddedKb();
    expect(process.env.APRA_FLEET_KB_EMBED).toBe('off');

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const factory = vi.fn<EmbeddingRuntimeFactory>(async () => { throw new Error('must not load'); });
    const e = new Embedder({ choice, runtimeFactory: factory, log: () => {} });
    _setEmbedderForTest(e);
    const p = new SqliteProvider(file, repo);
    p.attachEmbedder(kbEmbedderSource());
    await p.init();
    try {
      await query(p, PARAPHRASE);
      for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
      await vi.advanceTimersByTimeAsync(EMBEDDER_RETRY_MAX_MS * 4);
      expect(factory).not.toHaveBeenCalled();
      expect(e.state.state).toBe('idle');
    } finally {
      p.close();
    }
  });
});
