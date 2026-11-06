import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';

// A member bible view gets the shared process embedder. Its embed queue
// subscribes to Embedder.onReady when the embedder is failed (or idle with
// stored vectors), and the embedder keeps that listener until it is
// unsubscribed. A view that leaves the cache (bible rewritten -> rebuilt, or
// resetMemberBibleViews) must release that subscription, or each rewrite pins
// one more view (and its in-memory DB) for the life of the process, and a
// later embedder load wakes every dead view to embed its stale entries.
//
// The remote transport is stubbed with a strategy that runs the view's own
// commands in a local /bin/sh against a temp folder (as in
// kb-remote-member-bible-view.test.ts).

vi.mock('../../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: (command: string) => new Promise((resolve) => {
      exec(command, { shell: '/bin/sh' }, (err, stdout, stderr) => {
        resolve({ stdout, stderr, code: err ? (err.code as number) : 0 });
      });
    }),
  }),
}));

import { addAgent } from '../../src/services/registry.js';
import {
  getMemberBibleView, resetMemberBibleViews, setMemberViewEmbedderSourceForTests,
  setMemberViewCodeResolverFactory, type MemberViewCodeResolverFactory,
} from '../../src/services/knowledge/member-bible-view.js';
import type { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import type { KbAnchor } from '../../src/services/knowledge/kb-self.js';
import { FakeEmbedder } from '../helpers/fake-embedder.js';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from '../test-helpers.js';

/** A fake process embedder that starts failed and counts its onReady listeners. */
class FailingEmbedder extends FakeEmbedder {
  readonly listeners = new Set<() => void>();
  private down = true;
  constructor() { super('release-fake', 'r1', 32, 512); }
  override get state(): { state: string; reason?: string } {
    return this.down ? { state: 'failed', reason: 'model download failed' } : { state: 'ready' };
  }
  override async embedDocuments(texts: string[]): Promise<Float32Array[] | null> {
    if (this.down) { this.calls.push(texts); return null; }
    return super.embedDocuments(texts);
  }
  override async embedQuery(text: string): Promise<Float32Array | null> {
    return this.down ? null : this.embed(text);
  }
  onReady(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }
  /** A retry succeeded: become ready and notify every listener. */
  recover(): void {
    this.down = false;
    for (const cb of [...this.listeners]) cb();
  }
}

const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const REWRITES = 5;
let scratch: string;
let prevFactory: MemberViewCodeResolverFactory | null;

function entries(n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `rel-${i}`, type: 'knowledge',
    title: `Sprocket gearbox release fact ${i}`,
    summary: `Sprocket gearbox release fact number ${i}; the sprocket stage batches work.`,
    symbols: [], source_files: ['src/sprocket.ts'],
    confidence: 'CONFIRMED', updated_at: '2026-09-01T00:00:00.000Z',
  }));
}
// A different entry count each time changes the file size, so the view rebuilds.
const writeBible = (folder: string, n: number) =>
  fs.writeFileSync(path.join(folder, '.fleet', 'kb-canonical.json'), JSON.stringify({ version: 2, entries: entries(n) }), 'utf-8');

function makeFolder(name: string): string {
  const folder = path.join(scratch, name);
  fs.mkdirSync(path.join(folder, '.fleet'), { recursive: true });
  fs.mkdirSync(path.join(folder, 'src'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'src', 'sprocket.ts'), 'export const s = 1;\n');
  return folder;
}

/** Build (or reuse) the view and let its queue run (it stops: embedder failed). */
async function settledView(anchor: KbAnchor): Promise<SqliteProvider> {
  const v = await getMemberBibleView(anchor);
  expect(await v.waitForEmbeddings(5000)).toBe(true);
  return v;
}

/** Rewrite the bible N times, reading after each; returns every view built. */
async function rewriteAndRead(anchor: KbAnchor, emb: FailingEmbedder): Promise<SqliteProvider[]> {
  const views: SqliteProvider[] = [];
  for (let i = 1; i <= REWRITES; i++) {
    writeBible(anchor.folder, i);
    const v = await settledView(anchor);
    views.push(v);
    // The live view is subscribed; every replaced one has let go.
    expect(emb.listeners.size).toBe(1);
  }
  expect(new Set(views).size).toBe(REWRITES);
  return views;
}

/** After recover(): only the live view embeds; replaced views stay as they were. */
async function expectOnlyLiveViewDrains(views: SqliteProvider[], emb: FailingEmbedder): Promise<void> {
  const live = views[views.length - 1];
  const stale = views.slice(0, -1);
  for (const v of views) expect(v.vectorStore.count()).toBe(0);
  emb.recover();
  expect(await live.waitForEmbeddings(5000)).toBe(true);
  expect(live.vectorStore.count()).toBeGreaterThan(0);
  // Give any stale queue a chance to run (they would be kicked off this stack).
  await new Promise(r => setTimeout(r, 50));
  for (const v of stale) {
    expect(v.vectorStore.count()).toBe(0);
    // The DB stays open: a reader still holding a replaced view can finish.
    expect(v.vectorIndexStatus().pending).toBeGreaterThan(0);
  }
}

beforeAll(() => {
  backupAndResetRegistry();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-view-release-'));
  // No code-link resolver: this file is about embedding subscriptions only.
  prevFactory = setMemberViewCodeResolverFactory(null);
});
afterAll(() => {
  setMemberViewEmbedderSourceForTests(undefined);
  setMemberViewCodeResolverFactory(prevFactory);
  resetMemberBibleViews();
  restoreRegistry();
  fs.rmSync(scratch, { recursive: true, force: true });
});
beforeEach(() => { resetMemberBibleViews(); });

describe('member bible view releases embedder subscriptions of dropped views', () => {
  it('local view: N bible rewrites keep one onReady listener; a later load drains only the live view', async () => {
    const emb = new FailingEmbedder();
    setMemberViewEmbedderSourceForTests(() => emb);
    const anchor: KbAnchor = { folder: makeFolder(`local-${RUN}`) };
    const views = await rewriteAndRead(anchor, emb);
    await expectOnlyLiveViewDrains(views, emb);
  });

  it('remote view: N bible rewrites keep one onReady listener; a later load drains only the live view', async () => {
    const emb = new FailingEmbedder();
    setMemberViewEmbedderSourceForTests(() => emb);
    const folder = makeFolder(`remote-${RUN}`);
    const remoteUrl = `https://example.test/kb-view-release-${RUN}.git`;
    const agent = makeTestAgent({ friendlyName: `kb-view-release-${RUN}`, workFolder: folder, os: 'linux', gitRepos: [remoteUrl] });
    addAgent(agent);
    const anchor: KbAnchor = { folder, remoteUrl, memberId: agent.id };
    const views = await rewriteAndRead(anchor, emb);
    await expectOnlyLiveViewDrains(views, emb);
  });

  it('resetMemberBibleViews releases every cached view', async () => {
    const emb = new FailingEmbedder();
    setMemberViewEmbedderSourceForTests(() => emb);
    const a: KbAnchor = { folder: makeFolder(`reset-a-${RUN}`) };
    const b: KbAnchor = { folder: makeFolder(`reset-b-${RUN}`) };
    writeBible(a.folder, 2);
    writeBible(b.folder, 3);
    const va = await settledView(a);
    const vb = await settledView(b);
    expect(emb.listeners.size).toBe(2);
    resetMemberBibleViews();
    await new Promise(r => setImmediate(r));
    expect(emb.listeners.size).toBe(0);
    emb.recover();
    await new Promise(r => setTimeout(r, 50));
    expect(va.vectorStore.count()).toBe(0);
    expect(vb.vectorStore.count()).toBe(0);
  });
});
