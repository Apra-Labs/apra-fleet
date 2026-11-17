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
import { memberBiblePath, resetMemberBibleViews } from '../../src/services/knowledge/member-bible-view.js';
import { kbSetup } from '../../src/tools/kb-setup.js';
import { kbQuery } from '../../src/tools/kb-query.js';
import { kbSessionPrime } from '../../src/tools/kb-session-prime.js';
import { kbContext } from '../../src/tools/kb-context.js';
import { kbList } from '../../src/tools/kb-list.js';
import { FLEET_DIR } from '../../src/paths.js';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from '../test-helpers.js';

// MEMBER reads under the http project provider while the KB server is
// unreachable. The KB server is the only source of truth: every read fails
// with E-KB-HTTP-UNREACHABLE, and neither the member's checkout bible nor the
// per-repo DB answers -- the per-repo DB is neither read nor written,
// including by the methods with no remote route (relatedClaims, touch,
// getLinked), which answer empty without touching any local store.
//
// The unreachable server is real: a TCP port bound and then closed, so every
// request fails with ECONNREFUSED. The checkout bible and the per-repo DB are
// both seeded, so a read answered from either would succeed; writes are
// checked by every per-repo use_count staying unchanged (read through the
// no-bump list()).
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
        reject(new Error('kb-member-unreachable-http: probe server did not bind a TCP port'));
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
  if (!refiner) throw new Error('kb-member-unreachable-http: the refiner entry was not imported into the per-repo DB');
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

describe('MEMBER reads with the KB server unreachable fail with E-KB-HTTP-UNREACHABLE', () => {
  it('kb_query, kb_session_prime, kb_context and kb_list: typed error, never the checkout bible or the per-repo DB', async () => {
    const before = await useCounts();
    const reads = [
      () => kbQuery({ query: 'sprocket', confidence: ['CONFIRMED'], expand_related: true }),
      () => kbQuery({ query: 'sprocket', confidence: ['CONFIRMED', 'INFERRED'] }),
      () => kbSessionPrime({ hint_modules: ['sprocket'] }),
      () => kbContext({ files: ['src/sprocket.ts', 'src/only-repo.ts'], confidence: ['CONFIRMED'] }),
      () => kbContext({ files: ['src/sprocket.ts'] }),
      () => kbList({}),
    ];
    for (const read of reads) {
      const err = await asMember(read).then(() => null, (e: unknown) => e);
      expect((err as { code?: string }).code).toBe('E-KB-HTTP-UNREACHABLE');
      expect((err as Error).message).toMatch(/no local store or bible is used instead/);
    }
    expect(await useCounts()).toEqual(before);
  });

  it('HttpKbProvider: getLinked, relatedClaims and touch answer empty and never read or write the per-repo DB', async () => {
    const http = (await getKbProviders(repo)).project as HttpKbProvider;
    const before = await useCounts();
    expect(await http.relatedClaims(['bible-1'], undefined, { confidence: ['CONFIRMED'] })).toEqual([]);
    expect(await http.getLinked('bible-1')).toEqual([]);
    expect(await http.touch(['bible-1', 'bible-cold-a'])).toBe(0);
    expect(() => http.getLiveConfirmedState(['bible-1'])).toThrow(/E-KB-HTTP-UNSUPPORTED/);
    expect(await useCounts()).toEqual(before);
  });
});
