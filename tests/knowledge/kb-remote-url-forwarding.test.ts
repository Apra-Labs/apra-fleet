import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveProjectSlug } from '../../src/services/knowledge/project-slug.js';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import type { KbProviders } from '../../src/services/knowledge/kb-providers.js';
import type { KBEntry, KBEntryInput } from '../../src/services/knowledge/types.js';
import type { KbAnchor } from '../../src/services/knowledge/kb-self.js';

// KB anchor wiring for every kb_* tool that resolves providers (kb_setup never
// calls getKbProviders). No kb_* request declares a scope field -- the KB is
// the calling session's own (src/services/knowledge/kb-self.ts). The one way
// to name a repo is the in-process KbAnchor passed as the handler's second
// argument (execute_prompt's post-dispatch harvest, the kb CLIs), which no MCP
// request can carry. This file pins, per tool: (1) the schema declares no scope
// field and strips one sent anyway; (2) the anchor's folder AND remoteUrl reach
// getKbProviders; (3) an anchor without remoteUrl injects no default.
//
// TABLE-DRIVEN: adding a tool requires no new assertion code, only a new TOOLS
// entry. kb_export and kb_import check the anchor folder against the real
// filesystem before ever reaching the mocked getKbProviders, so those two
// entries anchor on real tmpdir fixtures instead of an arbitrary string.

const mockGetKbProviders = vi.hoisted(() => vi.fn());

vi.mock('../../src/services/knowledge/kb-providers.js', () => ({
  getKbProviders: mockGetKbProviders,
}));

import { kbCaptureSchema, kbCapture } from '../../src/tools/kb-capture.js';
import { kbHarvestSchema, kbHarvest } from '../../src/tools/kb-harvest.js';
import { kbSessionPrimeSchema, kbSessionPrime } from '../../src/tools/kb-session-prime.js';
import { kbListSchema, kbList } from '../../src/tools/kb-list.js';
import { kbInvalidateSchema, kbInvalidate } from '../../src/tools/kb-invalidate.js';
import { kbResolveContradictionSchema, kbResolveContradiction } from '../../src/tools/kb-resolve-contradiction.js';
import { kbReconcilePrefilterSchema, kbReconcilePrefilter } from '../../src/tools/kb-reconcile-prefilter.js';
import { kbContextSchema, kbContext } from '../../src/tools/kb-context.js';
import { kbFreshnessSweepSchema, kbFreshnessSweep } from '../../src/tools/kb-freshness-sweep.js';
import { kbFeedbackSchema, kbFeedback } from '../../src/tools/kb-feedback.js';
import { kbPromoteSchema, kbPromote } from '../../src/tools/kb-promote.js';
import { kbQuerySchema, kbQuery } from '../../src/tools/kb-query.js';
import { kbImportSchema, kbImport } from '../../src/tools/kb-import.js';
import { kbStatsSchema, kbStats } from '../../src/tools/kb-stats.js';
import { kbExportSchema, kbExport } from '../../src/tools/kb-export.js';

// kb_export writes <folder>/.fleet/kb-canonical.json; kb_import reads it.
// Both validate the anchor folder against the real filesystem before the mocked
// getKbProviders is ever reached, so each needs its own real tmpdir.
const exportTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-export-fwd-'));
const importTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-import-fwd-'));
fs.mkdirSync(path.join(importTmpDir, '.fleet'), { recursive: true });
fs.writeFileSync(path.join(importTmpDir, '.fleet', 'kb-canonical.json'), '[]');

// requireSqliteProject-guarded tools (kb_list, kb_feedback, kb_freshness_sweep,
// kb_reconcile_prefilter, kb_resolve_contradiction, kb_stats, kb_export,
// kb_import) narrow providers.project with `instanceof SqliteProvider`, so an
// object-literal stub throws before the forwarding assertion under test ever
// runs. CLAUDE.md forbids mocks/stubs for exactly this reason: each of these
// gets a REAL SqliteProvider, rooted in its own per-case (per ToolCase) temp
// dir -- never a no-arg `new SqliteProvider()`, which kb-single-accessor.test.ts
// would otherwise need to police for a call site under tests/.
function realProjectProvider(prefix: string): SqliteProvider {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // capture()'s basis check (assertCheckableBasis) rejects any cited
  // source_files entry that does not resolve under repoPath, so any provider
  // seeded via capture() (feedbackProvider, resolveContradictionProvider)
  // needs a real file here to cite.
  fs.writeFileSync(path.join(tmpDir, 'fixture.ts'), '// kb-remote-url-forwarding fixture\n');
  return new SqliteProvider(path.join(tmpDir, 'kb.sqlite'), tmpDir);
}

const listProvider = realProjectProvider('kb-list-fwd-');
const feedbackProvider = realProjectProvider('kb-feedback-fwd-');
const resolveContradictionProvider = realProjectProvider('kb-resolve-contradiction-fwd-');
const reconcilePrefilterProvider = realProjectProvider('kb-reconcile-prefilter-fwd-');
const freshnessSweepProvider = realProjectProvider('kb-freshness-sweep-fwd-');
const statsProvider = realProjectProvider('kb-stats-fwd-');
const exportProjectProvider = realProjectProvider('kb-export-project-fwd-');
const importProjectProvider = realProjectProvider('kb-import-project-fwd-');

const REAL_PROVIDERS = [
  listProvider,
  feedbackProvider,
  resolveContradictionProvider,
  reconcilePrefilterProvider,
  freshnessSweepProvider,
  statsProvider,
  exportProjectProvider,
  importProjectProvider,
];

function seedEntry(overrides: Partial<KBEntryInput> & { symbols: string[] }): KBEntryInput {
  return {
    type: 'knowledge',
    title: 'seed title',
    summary: 'seed summary',
    content: 'seed content',
    source_files: ['fixture.ts'],
    tags: [],
    content_hash: '',
    content_hash_type: 'sha256',
    flagged_for_review: false,
    author: 'doer',
    source: 'session',
    confidence: 'INFERRED',
    ...overrides,
  };
}

// kb_resolve_contradiction refuses (throws) unless winnerId/loserId form a
// GENUINE linked contradiction pair, and refuses again if either side is
// already superseded (sqlite-provider.ts resolveContradiction). Case 2 and
// case 3 below both invoke the real handler against the SAME ids, and a
// successful resolution supersedes the loser -- so the pair must be torn down
// and recaptured before every case, not just once in beforeAll.
//
// capture()'s preferredId is honored ONLY on the pure 'add' path
// (sqlite-provider.ts capture(), comment at line ~910-915) -- AUDN's
// update/flagged branches always mint a fresh randomUUID, so an AUDN-triggered
// contradiction pair (as in kb-reconcile.test.ts) cannot land on caller-chosen
// ids 'w1'/'l1'. Both entries are therefore captured on distinct, non-matching
// content/symbols so AUDN finds no candidates and each keeps its preferredId,
// then contradiction_of is set directly (the same raw-SQL fixture technique
// kb-reconcile.test.ts uses to simulate post-capture state, e.g. its
// stale-member and superseded-member liveness tests).
async function reseedResolveContradictionPair(): Promise<void> {
  const db = (resolveContradictionProvider as unknown as { getDb(): { prepare(sql: string): { run(...args: unknown[]): unknown } } }).getDb();
  db.prepare('DELETE FROM entries WHERE id IN (?, ?)').run('w1', 'l1');
  await resolveContradictionProvider.capture(seedEntry({
    title: 'resolveContradictionFwdWinner entry',
    summary: 'winner side of a resolve_contradiction forwarding fixture',
    content: 'resolveContradictionFwdWinner content.',
    symbols: ['resolveContradictionFwdWinner'],
  }), { preferredId: 'w1' });
  await resolveContradictionProvider.capture(seedEntry({
    title: 'resolveContradictionFwdLoser entry',
    summary: 'loser side of a resolve_contradiction forwarding fixture',
    content: 'resolveContradictionFwdLoser content.',
    symbols: ['resolveContradictionFwdLoser'],
  }), { preferredId: 'l1' });
  db.prepare("UPDATE entries SET contradiction_of = 'w1', flagged_for_review = 1 WHERE id = 'l1'").run();
}

beforeAll(async () => {
  for (const provider of REAL_PROVIDERS) {
    await provider.init();
  }
  // kb_feedback's minimalInput targets id 'id1'; feedback() only requires the
  // entry to exist (it re-applies cleanly on repeat calls), so a one-time seed
  // covers every case in that tool's describe block.
  await feedbackProvider.capture(seedEntry({ title: 'feedback fixture entry', symbols: ['feedbackFwdSym'] }), { preferredId: 'id1' });
});

afterAll(() => {
  fs.rmSync(exportTmpDir, { recursive: true, force: true });
  fs.rmSync(importTmpDir, { recursive: true, force: true });
  for (const provider of REAL_PROVIDERS) {
    provider.close();
    if (provider.repoPath) fs.rmSync(provider.repoPath, { recursive: true, force: true });
  }
});

function entry(id: string): KBEntry {
  return {
    id,
    type: 'knowledge',
    title: id,
    summary: `summary-${id}`,
    content: '',
    source_files: ['src/fixture.ts'],
    symbols: [],
    tags: [],
    content_hash: '',
    content_hash_type: 'sha256',
    stale: false,
    flagged_for_review: false,
    author: '',
    source: 'doer',
    confidence: 'CONFIRMED',
    created_at: '2026-01-01T00:00:00.000Z',
    use_count: 0,
  };
}

// >= COLD_KB_MAX (3) so kb_session_prime's canonical-bible cold-seed blocks
// never fire -- keeps this file's providers stub the only thing under test.
function primedContext() {
  return {
    session_warm: true,
    stale_files: [],
    top_entries: [entry('a'), entry('b'), entry('c')],
    fresh_summaries: [],
    recommended_code_calls: [],
    token_estimate: 0,
  };
}

interface ToolCase {
  name: string;
  schema: z.ZodTypeAny;
  call: (input: unknown, anchor: KbAnchor) => Promise<string>;
  // Anchor folder; defaults to a fake path the mocked getKbProviders never checks.
  folder?: string;
  // Fields needed to satisfy the schema
  // and to make the handler actually reach getKbProviders (kb_harvest early-
  // returns before calling it when session_transcript is absent).
  minimalInput: Record<string, unknown>;
  // Stub returned by the mocked getKbProviders for this tool's call path.
  providersStub: () => KbProviders;
  // Optional per-test reset hook, awaited in beforeEach before providersStub()
  // is read. Only kb_resolve_contradiction needs this (see
  // reseedResolveContradictionPair above); every other entry leaves it unset.
  resetFixture?: () => Promise<void>;
}

const TOOLS: ToolCase[] = [
  {
    name: 'kb_capture',
    schema: kbCaptureSchema,
    call: (input, anchor) => kbCapture(input as Parameters<typeof kbCapture>[0], anchor),
    minimalInput: { type: 'knowledge', title: 't', summary: 's', content: 'c' },
    providersStub: () => ({
      project: { capture: vi.fn().mockResolvedValue({ id: 'id1', audn_decision: 'add' }) } as any,
      global: { capture: vi.fn() } as any,
      projectSlug: 'slug',
    }),
  },
  {
    name: 'kb_harvest',
    schema: kbHarvestSchema,
    call: (input, anchor) => kbHarvest(input as Parameters<typeof kbHarvest>[0], anchor),
    // A plain sentence yields no LEARNING_PATTERNS match, so provider.capture
    // is never invoked -- only the early-return guard (session_transcript
    // absent) needs to be avoided.
    minimalInput: { session_transcript: 'This is a plain sentence with nothing to extract.' },
    providersStub: () => ({
      project: { capture: vi.fn() } as any,
      global: {} as any,
      projectSlug: 'slug',
    }),
  },
  {
    name: 'kb_session_prime',
    schema: kbSessionPrimeSchema,
    call: (input, anchor) => kbSessionPrime(input as Parameters<typeof kbSessionPrime>[0], anchor),
    minimalInput: {},
    providersStub: () => ({
      project: { prime: vi.fn().mockResolvedValue(primedContext()) } as any,
      global: { query: vi.fn() } as any,
      projectSlug: 'slug',
    }),
  },
  {
    name: 'kb_list',
    schema: kbListSchema,
    call: (input, anchor) => kbList(input as Parameters<typeof kbList>[0], anchor),
    minimalInput: {},
    providersStub: () => ({
      project: listProvider,
      global: {} as any,
      projectSlug: 'slug',
    }),
  },
  {
    name: 'kb_invalidate',
    schema: kbInvalidateSchema,
    call: (input, anchor) => kbInvalidate(input as Parameters<typeof kbInvalidate>[0], anchor),
    minimalInput: { files: ['src/fixture.ts'] },
    providersStub: () => ({
      project: { invalidate: vi.fn().mockResolvedValue({ invalidated: 0 }) } as any,
      global: {} as any,
      projectSlug: 'slug',
    }),
  },
  {
    name: 'kb_resolve_contradiction',
    schema: kbResolveContradictionSchema,
    call: (input, anchor) => kbResolveContradiction(input as Parameters<typeof kbResolveContradiction>[0], anchor),
    minimalInput: { winnerId: 'w1', loserId: 'l1', evidence: 'e' },
    providersStub: () => ({
      project: resolveContradictionProvider,
      global: {} as any,
      projectSlug: 'slug',
    }),
    resetFixture: reseedResolveContradictionPair,
  },
  {
    name: 'kb_reconcile_prefilter',
    schema: kbReconcilePrefilterSchema,
    call: (input, anchor) => kbReconcilePrefilter(input as Parameters<typeof kbReconcilePrefilter>[0], anchor),
    minimalInput: {},
    providersStub: () => ({
      project: reconcilePrefilterProvider,
      global: {} as any,
      projectSlug: 'slug',
    }),
  },
  {
    name: 'kb_context',
    schema: kbContextSchema,
    call: (input, anchor) => kbContext(input as Parameters<typeof kbContext>[0], anchor),
    minimalInput: { files: ['src/fixture.ts'] },
    providersStub: () => ({
      // status 'fresh' short-circuits before the global fallback is reached.
      project: { context: vi.fn().mockResolvedValue([{ file: 'src/fixture.ts', status: 'fresh' }]) } as any,
      global: { context: vi.fn() } as any,
      projectSlug: 'slug',
    }),
  },
  {
    name: 'kb_freshness_sweep',
    schema: kbFreshnessSweepSchema,
    call: (input, anchor) => kbFreshnessSweep(input as Parameters<typeof kbFreshnessSweep>[0], anchor),
    minimalInput: {},
    providersStub: () => ({
      project: freshnessSweepProvider,
      global: {} as any,
      projectSlug: 'slug',
    }),
  },
  {
    name: 'kb_feedback',
    schema: kbFeedbackSchema,
    call: (input, anchor) => kbFeedback(input as Parameters<typeof kbFeedback>[0], anchor),
    minimalInput: { id: 'id1', reason: 'wrong in practice' },
    providersStub: () => ({
      project: feedbackProvider,
      global: {} as any,
      projectSlug: 'slug',
    }),
  },
  {
    name: 'kb_promote',
    schema: kbPromoteSchema,
    call: (input, anchor) => kbPromote(input as Parameters<typeof kbPromote>[0], anchor),
    minimalInput: { id: 'id1' },
    providersStub: () => ({
      project: { promote: vi.fn().mockResolvedValue({ id: 'id1', confidence_before: 'INFERRED', confidence_after: 'CONFIRMED' }) } as any,
      global: {} as any,
      projectSlug: 'slug',
    }),
  },
  {
    name: 'kb_query',
    schema: kbQuerySchema,
    call: (input, anchor) => kbQuery(input as Parameters<typeof kbQuery>[0], anchor),
    // Empty results keep top5Ids empty, so the L2 fetch branch is never reached.
    minimalInput: { query: 'test' },
    providersStub: () => ({
      project: { query: vi.fn().mockResolvedValue({ results: [] }) } as any,
      global: { query: vi.fn().mockResolvedValue({ results: [] }) } as any,
      projectSlug: 'slug',
    }),
  },
  {
    name: 'kb_stats',
    schema: kbStatsSchema,
    call: (input, anchor) => kbStats(input as Parameters<typeof kbStats>[0], anchor),
    minimalInput: {},
    providersStub: () => ({
      project: statsProvider,
      global: {} as any,
      projectSlug: 'slug',
    }),
  },
  {
    name: 'kb_export',
    schema: kbExportSchema,
    call: (input, anchor) => kbExport(input as Parameters<typeof kbExport>[0], anchor),
    // The anchor folder must exist on the real filesystem (requireLocalFolder),
    // and is not a git repo so the auto-commit path never shells out to git.
    minimalInput: {},
    folder: exportTmpDir,
    providersStub: () => ({
      project: exportProjectProvider,
      global: { list: vi.fn().mockResolvedValue([]) } as any,
      projectSlug: 'slug',
    }),
  },
  {
    name: 'kb_import',
    schema: kbImportSchema,
    call: (input, anchor) => kbImport(input as Parameters<typeof kbImport>[0], anchor),
    // The anchor folder is a real tmpdir seeded with an empty bible array so
    // the entry loop is a no-op and only the getKbProviders forwarding, plus
    // the trailing freshnessSweep() call, are exercised.
    minimalInput: {},
    folder: importTmpDir,
    providersStub: () => ({
      project: importProjectProvider,
      global: {} as any,
      projectSlug: 'slug',
    }),
  },
];

const SCOPE_FIELDS = ['repo', 'repo_path', 'repo_remote_url'];
const FAKE_FOLDER = '/kb-anchor-wiring/not-a-real-folder';

describe.each(TOOLS)('$name KB anchor wiring', ({ schema, call, minimalInput, folder, providersStub, resetFixture }) => {
  beforeEach(async () => {
    await resetFixture?.();
    mockGetKbProviders.mockReset();
    mockGetKbProviders.mockResolvedValue(providersStub());
  });

  it('schema declares no scope field, and strips one sent anyway', () => {
    const shape = (schema as unknown as z.ZodObject<z.ZodRawShape>).shape;
    for (const field of SCOPE_FIELDS) expect(Object.keys(shape)).not.toContain(field);
    const parsed = schema.parse({
      ...minimalInput,
      repo_path: '/elsewhere',
      repo_remote_url: 'https://example.com/acme/repo.git',
    }) as Record<string, unknown>;
    for (const field of SCOPE_FIELDS) expect(parsed[field]).toBeUndefined();
  });

  it('forwards the in-process anchor folder and remoteUrl to getKbProviders', async () => {
    const anchorFolder = folder ?? FAKE_FOLDER;
    await call({ ...minimalInput }, { folder: anchorFolder, remoteUrl: 'https://example.com/acme/repo.git' });

    expect(mockGetKbProviders).toHaveBeenCalledTimes(1);
    expect(mockGetKbProviders.mock.calls[0][0]).toBe(anchorFolder);
    expect(mockGetKbProviders.mock.calls[0][1]).toBe('https://example.com/acme/repo.git');
  });

  it('an anchor without remoteUrl injects no default', async () => {
    await call({ ...minimalInput }, { folder: folder ?? FAKE_FOLDER });

    expect(mockGetKbProviders).toHaveBeenCalledTimes(1);
    expect(mockGetKbProviders.mock.calls[0][1]).toBeUndefined();
  });
});

// Case 4: slug resolution for a nonexistent remote-style folder. Uses the
// REAL kb-providers module (bypassing the vi.mock above via importActual) so
// resolveProjectSlug's remote-URL short-circuit is genuinely exercised --
// NOT a capture-then-read round trip, since sqlite-provider.ts:323 rejects
// any capture whose source files cannot resolve under a repoPath that does
// not exist on disk, before or after this sprint's fixes (that end-to-end
// case belongs to apra-fleet-b4g.1.5, which uses a real tmpdir fixture).
describe('slug resolution: nonexistent remote-style folder + fake remote URL', () => {
  afterEach(async () => {
    const real = await vi.importActual<typeof import('../../src/services/knowledge/kb-providers.js')>(
      '../../src/services/knowledge/kb-providers.js',
    );
    real.resetKbProviders();
  });

  it('resolves to the URL-derived slug, not "default"', async () => {
    const real = await vi.importActual<typeof import('../../src/services/knowledge/kb-providers.js')>(
      '../../src/services/knowledge/kb-providers.js',
    );
    const remoteUrl = `git@github.com:acme/does-not-exist-${crypto.randomUUID()}.git`;
    const fakeRepoPath = `/definitely/does/not/exist/${crypto.randomUUID()}`;

    const providers = await real.getKbProviders(fakeRepoPath, remoteUrl);

    expect(providers.projectSlug).not.toBe('default');
    expect(providers.projectSlug).toBe(resolveProjectSlug(undefined, remoteUrl));
  });
});
