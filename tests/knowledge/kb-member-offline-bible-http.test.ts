import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { addAgent } from '../../src/services/registry.js';
import { runWithSessionMember } from '../../src/services/tool-scope.js';
import { getKbProviders, resetKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { requireSqliteProject } from '../../src/services/knowledge/require-sqlite-project.js';
import { importBibleEntries } from '../../src/services/knowledge/bible-import.js';
import { HttpKbProvider } from '../../src/services/knowledge/http-provider.js';
import type { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { getMemberBibleView, memberBiblePath, resetMemberBibleViews } from '../../src/services/knowledge/member-bible-view.js';
import { kbSetup } from '../../src/tools/kb-setup.js';
import { kbQuery } from '../../src/tools/kb-query.js';
import { kbSessionPrime } from '../../src/tools/kb-session-prime.js';
import { kbContext } from '../../src/tools/kb-context.js';
import { FLEET_DIR } from '../../src/paths.js';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from '../test-helpers.js';

// MEMBER CONFIRMED reads under the http project provider while the KB server
// is unreachable. They are answered from the member's checkout bible, and the
// per-repo DB (the http provider's local fallback store) must be neither read
// nor written -- including by the methods with no remote route:
// relatedClaims (kb_query expand_related), touch (kb_session_prime's
// cold-seed delivery telemetry) and getLinked.
//
// The unreachable server is real: a TCP port bound and then closed, so every
// request fails with ECONNREFUSED. The per-repo DB is seeded with the bible's
// entries plus entries the bible does not have -- one linked to a bible entry
// by a refines edge, and a context-cache entry for a file the bible does not
// cover. Reads are checked by those ids never appearing; writes by every
// per-repo use_count staying unchanged (read through the no-bump list()).
//
// Real member session (runWithSessionMember), real git checkout with an origin
// remote, real kb_setup, real HttpKbProvider, real SQLite stores. No mocks.
//
// Isolation: tests/setup.ts points APRA_FLEET_DATA_DIR at a per-run temp dir
// (KB config and every kb.sqlite land there); the registry is backed up and
// restored; the checkout lives under one mkdtemp scratch root removed in
// afterAll; the origin remote is unique per run so the per-repo DB is fresh.

const KB_CONFIG_PATH = path.join(FLEET_DIR, 'knowledge', 'config.json');
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const ALL_TIERS = ['CONFIRMED', 'INFERRED', 'UNVERIFIED'] as const;

function bibleEntry(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, type: 'knowledge',
    title: `Sprocket bible fact ${id}`,
    summary: `Sprocket bible fact recorded in the checkout bible as ${id}.`,
    symbols: ['Sprocket'], source_files: ['src/sprocket.ts'],
    confidence: 'CONFIRMED', updated_at: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

function coldEntry(id: string): Record<string, unknown> {
  return bibleEntry(id, {
    title: `Flywheel note ${id}`,
    summary: `Flywheel note ${id} about an unrelated module.`,
    symbols: [], source_files: ['src/flywheel.ts'],
  });
}

// The checkout bible: what an offline MEMBER CONFIRMED read may return.
const BIBLE = [
  bibleEntry('bible-1'),
  bibleEntry('bible-ctx', { type: 'context-cache', title: 'Sprocket context', summary: 'Context summary for src/sprocket.ts.', symbols: [] }),
  coldEntry('bible-cold-a'),
  coldEntry('bible-cold-b'),
  coldEntry('bible-cold-c'),
];
const BIBLE_IDS = new Set(BIBLE.map(e => String(e.id)));

// Per-repo DB only: never in the bible, so never in an offline MEMBER result.
const REPO_REFINER = bibleEntry('repo-refiner', {
  title: 'Sprocket refinement held only in the per-repo DB',
  summary: 'Sprocket refinement: the per-repo DB refines bible-1 with a newer framing.',
});
const REPO_CTX = bibleEntry('repo-ctx', {
  type: 'context-cache', title: 'Only-repo context', summary: 'Context summary for src/only-repo.ts.',
  symbols: [], source_files: ['src/only-repo.ts'],
});

let scratch: string;
// AUDN stores the refiner under a fresh id (its refines-link path does not
// keep the preferred id), so it is looked up by title after the import.
let refinerId: string;
let repoOnlyIds: string[];
let repo: string;
let memberId: string;
let unreachablePort: number;
let perRepo: SqliteProvider;

const asMember = <T>(fn: () => Promise<T>): Promise<T> => runWithSessionMember(memberId, fn);
const idsOf = (rows: Array<{ id: string }>) => rows.map(r => r.id);

async function useCounts(): Promise<Record<string, number>> {
  const rows = await perRepo.list({ confidence: [...ALL_TIERS], include_stale: true, limit: 1000 });
  return Object.fromEntries(rows.map(e => [e.id, e.use_count ?? 0]));
}

function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('kb-member-offline-bible-http: probe server did not bind a TCP port'));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

async function configureUnreachableHttp(): Promise<void> {
  // The token only has to be well-formed: nothing ever answers on this port.
  const token = crypto.randomBytes(16).toString('hex');
  const result = JSON.parse(await kbSetup({ provider: 'http', remote: `http://127.0.0.1:${unreachablePort}`, token }, { folder: repo }));
  expect(result.success).toBe(true);
  expect((await getKbProviders(repo)).project).toBeInstanceOf(HttpKbProvider);
}

beforeAll(async () => {
  backupAndResetRegistry();
  resetMemberBibleViews();
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();

  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-member-offline-bible-'));
  repo = path.join(scratch, 'checkout');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.fleet'), { recursive: true });
  for (const file of ['sprocket.ts', 'flywheel.ts', 'only-repo.ts']) {
    fs.writeFileSync(path.join(repo, 'src', file), `export const value = '${file}';\n`);
  }
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', `https://example.test/kb-member-offline-bible-${RUN}.git`], { cwd: repo });
  fs.writeFileSync(memberBiblePath(repo), JSON.stringify({ version: 2, entries: BIBLE }), 'utf-8');

  const agent = makeTestLocalAgent({ friendlyName: `kb-member-offline-bible-${RUN}`, workFolder: repo });
  addAgent(agent);
  memberId = agent.id;

  // Seed the per-repo DB through the shared importer (AUDN on, so the
  // refiner gets its refines edge to bible-1). The same SqliteProvider is the
  // http provider's fallback store once the config selects http.
  perRepo = requireSqliteProject((await getKbProviders(repo)).project, 'kb-member-offline-bible test');
  await importBibleEntries(perRepo, [...BIBLE, REPO_REFINER, REPO_CTX]);
  const seeded = await perRepo.list({ confidence: [...ALL_TIERS], include_stale: true, limit: 1000 });
  const refiner = seeded.find(e => e.title === REPO_REFINER.title);
  if (!refiner) throw new Error('kb-member-offline-bible-http: the refiner entry was not imported into the per-repo DB');
  refinerId = refiner.id;
  repoOnlyIds = [refinerId, 'repo-ctx'];
  expect(idsOf(seeded)).toEqual(expect.arrayContaining([...BIBLE_IDS, ...repoOnlyIds]));
  // Precondition: the per-repo DB, unlike the bible, links the refiner to bible-1.
  expect(idsOf(await perRepo.relatedClaims(['bible-1'], undefined, { confidence: ['CONFIRMED'] }))).toContain(refinerId);

  unreachablePort = await closedPort();
});

beforeEach(async () => {
  resetMemberBibleViews();
  await configureUnreachableHttp();
});

afterAll(() => {
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();
  resetMemberBibleViews();
  restoreRegistry();
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('MEMBER CONFIRMED reads with the KB server unreachable stay on the checkout bible', () => {
  it('kb_query expand_related: related_claims come from the bible, never the per-repo DB', async () => {
    const before = await useCounts();
    const out = JSON.parse(await asMember(() => kbQuery({ query: 'sprocket', confidence: ['CONFIRMED'], expand_related: true })));
    expect(idsOf(out.l1_results)).toContain('bible-1');
    expect(idsOf(out.related_claims)).not.toContain(refinerId);
    const returned = [...idsOf(out.l1_results), ...idsOf(out.l2_expanded), ...idsOf(out.related_claims)];
    for (const id of repoOnlyIds) expect(returned).not.toContain(id);
    expect(await useCounts()).toEqual(before);
  });

  it('kb_session_prime: top_entries come from the bible and the cold-seed touch does not write the per-repo DB', async () => {
    const before = await useCounts();
    const out = JSON.parse(await asMember(() => kbSessionPrime({ hint_modules: ['sprocket'] })));
    const top = out.top_entries as Array<{ id: string; via?: string }>;
    expect(idsOf(top)).toContain('bible-1');
    // The cold-seed block ran, so touch() was called for its additions.
    expect(top.some(e => e.via === 'canonical-bible')).toBe(true);
    for (const id of repoOnlyIds) expect(idsOf(top)).not.toContain(id);
    expect(await useCounts()).toEqual(before);
  });

  it('kb_context: summaries come from the bible; a file only the per-repo DB covers is missing', async () => {
    const before = await useCounts();
    const files = ['src/sprocket.ts', 'src/only-repo.ts'];
    // Explicit CONFIRMED, and the MEMBER default (CONFIRMED plus own captures).
    const reads = [
      () => kbContext({ files, confidence: ['CONFIRMED'] }),
      () => kbContext({ files }),
    ];
    for (const read of reads) {
      const out = JSON.parse(await asMember(read));
      expect(out.missing).toContain('src/only-repo.ts');
      expect(out.missing).not.toContain('src/sprocket.ts');
      const entryIds = [...out.fresh, ...out.stale].map((r: { entry_id?: string }) => r.entry_id);
      expect(entryIds).toContain('bible-ctx');
      expect(entryIds).not.toContain('repo-ctx');
    }
    expect(await useCounts()).toEqual(before);
  });

  it('HttpKbProvider view: after an offline read, getLinked and relatedClaims read the offline store', async () => {
    const base = (await getKbProviders(repo)).project as HttpKbProvider;
    const bibleView = await getMemberBibleView({ folder: repo });
    const view = base.withOfflineReads(async () => bibleView, 'test: offline read answered from the bible view');
    const before = await useCounts();
    expect(idsOf((await view.query({ query: 'sprocket', confidence: ['CONFIRMED'], limit: 10 })).results)).toContain('bible-1');
    expect(idsOf(await view.relatedClaims(['bible-1'], undefined, { confidence: ['CONFIRMED'] }))).not.toContain(refinerId);
    expect(idsOf(await view.getLinked('bible-1'))).not.toContain(refinerId);
    expect(await view.touch(['bible-1', 'bible-cold-a'])).toBe(0);
    expect(await useCounts()).toEqual(before);
  });
});
