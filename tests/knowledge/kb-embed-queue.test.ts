import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { Embedder } from '../../src/services/knowledge/embedding/embedder.js';
import { resolveEmbeddingModel } from '../../src/services/knowledge/embedding/profiles.js';
import { FakeEmbedder, until } from '../helpers/fake-embedder.js';

// Background embedding of KB captures (design D2a/D2c/D2f): a capture
// resolves before its embedding is computed, a model change rebuilds the
// vectors in the background while keyword search keeps serving, and a failed
// embedder never fails a capture. Runs the real kb_capture handler against a
// real SqliteProvider on a temp kb.sqlite; only the session-scope resolution
// is stubbed to hand the handler that provider. Every file lives under one
// mkdtemp dir removed in afterAll.

const providerState = vi.hoisted(() => ({ p: undefined as unknown }));

vi.mock('../../src/services/tool-scope.js', () => ({
  getSessionMemberId: () => undefined,
  getSessionKbMaintainer: () => false,
}));
vi.mock('../../src/services/knowledge/kb-self.js', () => ({
  getSelfKbProviders: async () => ({ project: providerState.p, global: providerState.p, projectSlug: 'slug' }),
  memberOwnerTag: () => undefined,
}));

import { kbCapture, kbCaptureSchema } from '../../src/tools/kb-capture.js';

const ALL_TIERS = ['CONFIRMED', 'INFERRED', 'UNVERIFIED'] as const;

let tmp: string;
let repo: string;
let n = 0;
let provider: SqliteProvider;
let logs: string[];

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-embed-queue-'));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  logs = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logs.push(args.join(' ')); });
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.join(' ')); });
  provider = new SqliteProvider(path.join(tmp, `kb-${n++}.sqlite`), repo);
  await provider.init();
  providerState.p = provider;
});
afterEach(() => {
  provider.close();
  vi.restoreAllMocks();
});

const capture = async (args: Record<string, unknown>) =>
  JSON.parse(await kbCapture(kbCaptureSchema.parse({ type: 'learning', source_files: ['src/a.ts'], ...args })));

const keywordIds = async (q: string) =>
  (await provider.query({ query: q, confidence: [...ALL_TIERS], limit: 20 })).results.map(e => e.id);

describe('production embedder wiring', () => {
  it('attaches the process embedder unless APRA_FLEET_KB_EMBED=off', async () => {
    const { kbEmbedderSource } = await import('../../src/services/knowledge/kb-providers.js');
    const { getEmbedder } = await import('../../src/services/knowledge/embedding/embedder.js');
    const saved = process.env.APRA_FLEET_KB_EMBED;
    try {
      process.env.APRA_FLEET_KB_EMBED = 'off';
      expect(kbEmbedderSource()).toBeNull();
      delete process.env.APRA_FLEET_KB_EMBED;
      expect(kbEmbedderSource()).toBe(getEmbedder);
    } finally {
      if (saved === undefined) delete process.env.APRA_FLEET_KB_EMBED;
      else process.env.APRA_FLEET_KB_EMBED = saved;
    }
  });
});

describe('background embedding', () => {
  it('resolves kb_capture before the embedding is computed; vectors appear only after the seam is released', async () => {
    const fake = new FakeEmbedder('acme/model-a');
    provider.attachEmbedder(() => fake);
    await provider.waitForEmbeddings();
    const release = fake.hold();

    // The embed seam stays held for the whole race: a capture that waited for
    // its embedding (bounded or not) would lose to the timer.
    const pending = capture({
      title: 'Orbital widget retry storm', summary: 'the orbital widget retries without bound',
      content: 'Long content about the orbital widget.', symbols: ['OrbitalWidget'],
    });
    let timer: NodeJS.Timeout | undefined;
    const raced = await Promise.race([
      pending.then(() => 'captured'),
      new Promise<string>(r => { timer = setTimeout(() => r('still waiting'), 1500); }),
    ]);
    clearTimeout(timer);
    expect(raced).toBe('captured');
    const out = await pending;
    expect(out.id).toBeTruthy();

    // The capture returned; the embed call is in flight and held open.
    await until(() => fake.calls.length > 0);
    expect(await keywordIds('orbital widget')).toContain(out.id);
    expect(provider.vectorStore.entryVectors(out.id)).toHaveLength(0);
    expect(provider.vectorIndexStatus().pending).toBe(1);

    release();
    expect(await provider.waitForEmbeddings(5000)).toBe(true);
    const vecs = provider.vectorStore.entryVectors(out.id);
    expect(vecs.length).toBeGreaterThan(0);
    expect(new Set(vecs.map(v => v.modelId))).toEqual(new Set(['acme/model-a']));
    expect(vecs.map(v => v.kind)).toContain('title_summary');
    expect(provider.vectorIndexStatus().pending).toBe(0);
  });

  it('re-embeds an entry whose rich fields change', async () => {
    const fake = new FakeEmbedder('acme/model-a');
    provider.attachEmbedder(() => fake);
    const out = await capture({ title: 'Rich field entry', summary: 'rich fields change', symbols: ['RichField'] });
    await provider.waitForEmbeddings();
    expect(provider.vectorStore.entryVectors(out.id).filter(v => v.kind === 'cue')).toHaveLength(0);
    provider.setEntryRichFields(out.id, { recall_cues: ['why does the rich field move'] });
    await provider.waitForEmbeddings();
    expect(provider.vectorStore.entryVectors(out.id).filter(v => v.kind === 'cue')).toHaveLength(1);
  });

  it('rebuilds on a model change, logged, while keyword queries keep answering', async () => {
    const a = new FakeEmbedder('acme/model-a');
    provider.attachEmbedder(() => a);
    const e1 = await capture({ title: 'Quasar cache eviction', summary: 'quasar cache evicts early', symbols: ['QuasarCache'] });
    const e2 = await capture({ title: 'Nebula lock ordering', summary: 'nebula lock order deadlock', symbols: ['NebulaLock'] });
    await provider.waitForEmbeddings();
    const modelA = { modelId: 'acme/model-a', revision: 'r1', dims: 64 };
    expect(provider.vectorStore.count(modelA)).toBeGreaterThan(0);
    expect(provider.vectorIndexStatus().model_id).toBe('acme/model-a');

    // Switch the active profile to model B and hold its embedding open.
    const b = new FakeEmbedder('acme/model-b');
    const release = b.hold();
    provider.attachEmbedder(() => b);
    await until(() => b.calls.length > 0);
    expect(logs.some(l => /vector index rebuild started: acme\/model-a@r1 -> acme\/model-b@r1/.test(l))).toBe(true);
    const mid = provider.vectorIndexStatus();
    expect(mid.rebuilding).toBe(true);
    expect(mid.model_id).toBe('acme/model-b');

    // During the rebuild: keyword search answers, scoring under B reads no A rows.
    expect(await keywordIds('quasar cache')).toContain(e1.id);
    expect(await keywordIds('nebula lock')).toContain(e2.id);
    expect(provider.scoreVectors(b.embed('quasar cache eviction'))).toEqual([]);

    release();
    expect(await provider.waitForEmbeddings(5000)).toBe(true);
    const modelB = { modelId: 'acme/model-b', revision: 'r1', dims: 64 };
    for (const id of [e1.id, e2.id]) {
      const vecs = provider.vectorStore.entryVectors(id);
      expect(vecs.length).toBeGreaterThan(0);
      expect(vecs.every(v => v.modelId === 'acme/model-b')).toBe(true);
    }
    expect(provider.vectorStore.count(modelA)).toBe(0);
    expect(provider.vectorStore.count(modelB)).toBeGreaterThan(0);
    const done = provider.vectorIndexStatus();
    expect(done.rebuilding).toBe(false);
    expect(done.rebuild_finished_at).not.toBeNull();
    expect(logs.some(l => /vector index rebuild finished/.test(l))).toBe(true);
    expect(provider.scoreVectors(b.embed('Quasar cache eviction quasar cache evicts early'))[0].entry_id).toBe(e1.id);
  });

  it('with the embedder failed, captures and keyword queries succeed and nothing throws', async () => {
    // A real Embedder whose model folder does not exist: its first load fails.
    const choice = resolveEmbeddingModel({ path: path.join(tmp, 'no-such-model') }, () => {});
    const embedder = new Embedder({ choice });
    provider.attachEmbedder(() => embedder);

    const out = await capture({ title: 'Pulsar timeout', summary: 'pulsar times out under load', symbols: ['PulsarTimeout'] });
    expect(out.id).toBeTruthy();
    expect(await provider.waitForEmbeddings(5000)).toBe(true);
    expect(embedder.state.state).toBe('failed');
    expect(await keywordIds('pulsar timeout')).toContain(out.id);
    expect(provider.vectorStore.entryVectors(out.id)).toHaveLength(0);

    // Later captures stay fine too.
    const out2 = await capture({ title: 'Pulsar retry', summary: 'pulsar retries', symbols: ['PulsarRetry'] });
    expect(await provider.waitForEmbeddings(5000)).toBe(true);
    expect(await keywordIds('pulsar retry')).toContain(out2.id);
    expect(provider.scoreVectors(new Float32Array(4))).toEqual([]);
  });

  it('claims a rebuild once when two providers share one kb.sqlite', async () => {
    const file = path.join(tmp, `shared-${n++}.sqlite`);
    const p1 = new SqliteProvider(file, repo);
    const p2 = new SqliteProvider(file, repo);
    await p1.init();
    await p2.init();
    try {
      await p1.capture({
        type: 'learning', title: 'Shared file entry', summary: 'two handles one file', content: 'two handles one file',
        source_files: ['src/a.ts'], symbols: ['SharedFile'], tags: [], content_hash: '', content_hash_type: 'sha256',
        flagged_for_review: false, author: 't', source: 'doer', confidence: 'INFERRED',
      });
      const f1 = new FakeEmbedder('acme/model-c');
      const f2 = new FakeEmbedder('acme/model-c');
      const release = f1.hold();
      p1.attachEmbedder(() => f1);
      await until(() => f1.calls.length > 0);
      p2.attachEmbedder(() => f2);
      await p2.waitForEmbeddings(2000);
      // p2 saw p1's live claim and stayed out of the way.
      expect(f2.calls).toHaveLength(0);
      release();
      expect(await p1.waitForEmbeddings(5000)).toBe(true);
      expect(logs.filter(l => /vector index rebuild started/.test(l))).toHaveLength(1);
      expect(p1.vectorStore.count({ modelId: 'acme/model-c', revision: 'r1', dims: 64 })).toBeGreaterThan(0);
    } finally {
      p1.close();
      p2.close();
    }
  });
});
