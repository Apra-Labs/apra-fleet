/**
 * Real-model end-to-end for MEMBER reads: a member session (registered local
 * member, work folder with a committed checkout bible) gets semantic kb_query
 * results through its in-memory bible view with the REAL default embedding
 * model, and so does the fleet-sprint engine's knowledge injection
 * (createKbWorkClient.knowledgeFor through memberCall, which is
 * member-scoped).
 *
 * Scenario, as the member:
 *   - a paraphrase of a bible entry sharing no keyword with it -> the entry is
 *     in the top 5 (and keyword-only search finds nothing, so only the
 *     semantic list can have put it there);
 *   - a query with a file anchor -> the anchored entry first;
 *   - a nonsense query -> 0 rows (the model's similarity floor);
 *   - knowledgeFor with the paraphrase as its situation -> the entry.
 *
 * Needs the real default model on disk, so it is OPT-IN, like the recall
 * eval and the responsiveness test:
 *   APRA_KB_EVAL_MODELS_DIR=<models folder holding the default profile's
 *   model, e.g. Snowflake/snowflake-arctic-embed-xs@<rev>>
 * Without it every case SKIPS with the reason printed, unless
 * APRA_KB_EVAL_REQUIRE_MODELS=1 (the nightly lane), which FAILS instead (npm test covers the
 * same paths with a deterministic fake embedder in
 * kb-query-hybrid-member.test.ts). Nothing is downloaded. The nightly
 * kb-real-model lane runs it with the models folder the recall eval filled.
 *
 * Isolation: tests/setup.ts points APRA_FLEET_DATA_DIR at a per-run temp dir
 * (the per-repo KB the view reads vectors from lives there); the registry is
 * backed up and restored; the checkout lives under one mkdtemp folder removed
 * in afterAll; the embedder's worker is terminated in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { addAgent } from '../../src/services/registry.js';
import { runWithSessionMember } from '../../src/services/tool-scope.js';
import {
  resetMemberBibleViews, setMemberViewEmbedderSourceForTests,
} from '../../src/services/knowledge/member-bible-view.js';
import { getSelfReadKb } from '../../src/services/knowledge/kb-self.js';
import type { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { Embedder } from '../../src/services/knowledge/embedding/embedder.js';
import { ModelStore } from '../../src/services/knowledge/embedding/model-store.js';
import { BUILTIN_EMBEDDING_PROFILES, DEFAULT_EMBEDDING_PROFILE } from '../../src/services/knowledge/embedding/profiles.js';
import { kbQuery, kbQuerySchema } from '../../src/tools/kb-query.js';
import { createKbWorkClient } from '../../packages/apra-fleet-se/fleet-sprint/kb.mjs';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from '../test-helpers.js';

const PROFILE = BUILTIN_EMBEDDING_PROFILES[DEFAULT_EMBEDDING_PROFILE];
const EMBED_TIMEOUT_MS = 10 * 60 * 1000;

function hubFolder(modelsDir: string): string {
  const src = PROFILE.source;
  if (src.kind !== 'hub') throw new Error('default profile is not a hub model');
  const parts = src.repo.split('/');
  parts[parts.length - 1] = `${parts[parts.length - 1]}@${src.revision}`;
  return path.join(modelsDir, ...parts);
}

/** Why this suite cannot run here, or null. */
function skipReason(): string | null {
  const dir = process.env.APRA_KB_EVAL_MODELS_DIR;
  if (!dir) return 'real embedding model not available: set APRA_KB_EVAL_MODELS_DIR to a models folder holding the default model';
  if (!fs.existsSync(path.join(hubFolder(dir), 'onnx', 'model_quantized.onnx'))) {
    return `real embedding model not under ${hubFolder(dir)}`;
  }
  return null;
}

const SKIP = skipReason();
// The nightly lane sets APRA_KB_EVAL_REQUIRE_MODELS=1 (as for the recall
// eval): there a missing model FAILS instead of skipping.
const REQUIRE_MODEL = process.env.APRA_KB_EVAL_REQUIRE_MODELS === '1';

const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// Bible: one target plus unrelated neighbours, all realistic KB prose.
const TARGET_ID = 'rm-supervisor-detached';
const ANCHOR_ID = 'rm-lockfile-race';
const BIBLE = [
  {
    id: TARGET_ID, type: 'knowledge',
    title: 'Fleet supervisor must be launched detached in the background',
    summary: 'Start the fleet supervisor with nohup and disown on POSIX, or Start-Process on Windows; a supervisor started in the foreground dies with its shell session.',
    symbols: ['startSupervisor'], source_files: ['src/supervisor.ts'],
  },
  {
    id: ANCHOR_ID, type: 'learning',
    title: 'Sprint lock pidfile races between concurrent test files',
    summary: 'Two test processes keyed on the same branch contend for one sprint-lock pidfile and one of them fails with SprintLockHeldError.',
    symbols: ['acquireSprintLock'], source_files: ['src/sprint-lock.ts'],
  },
  {
    id: 'rm-float16', type: 'knowledge',
    title: 'KB vectors are stored as float16 blobs',
    summary: 'entry_vectors keeps each embedding as little-endian float16 bytes tagged with the model id, revision and dimension count.',
    symbols: ['encodeFloat16'], source_files: ['src/vectors.ts'],
  },
  {
    id: 'rm-crlf', type: 'learning',
    title: 'Windows checkouts rewrite shell scripts with CRLF endings',
    summary: 'core.autocrlf turns LF into CRLF in .sh files, and bash then fails with a bad interpreter error; mark them eol=lf in .gitattributes.',
    symbols: [], source_files: ['scripts/install.sh'],
  },
  {
    id: 'rm-token-scope', type: 'knowledge',
    title: 'GitHub App tokens need pull-request permission to open PRs',
    summary: 'A token minted with push access alone gets Resource not accessible by integration when creating a pull request; mint it with push+pr.',
    symbols: ['provisionVcsAuth'], source_files: ['src/vcs-auth.ts'],
  },
].map(e => ({ ...e, confidence: 'CONFIRMED', updated_at: '2026-09-01T00:00:00.000Z' }));

// Shares no keyword with the target entry (checked below against the
// keyword-only path), but means the same thing.
const PARAPHRASE = 'orchestration daemon survives closing terminal tab';
const NONSENSE = 'zorbleflux quantimar plimbo vexnor';

let scratch: string;
let repo: string;
let member: string;
let embedder: Embedder;

type Out = { l1_results: Array<{ id: string }> };
const as = <T>(fn: () => Promise<T>): Promise<T> => runWithSessionMember(member, fn);
const memberQuery = async (args: Record<string, unknown>): Promise<Out> =>
  JSON.parse(await as(() => kbQuery(kbQuerySchema.parse(args))));
const ids = (o: Out) => o.l1_results.map(r => r.id);
const view = async (): Promise<SqliteProvider> => (await as(() => getSelfReadKb())).providers.project as SqliteProvider;

/** Build the member's view afresh with `embedded` deciding the embedder, and wait for its vectors. */
async function freshView(embedded: boolean): Promise<SqliteProvider> {
  setMemberViewEmbedderSourceForTests(embedded ? () => embedder : null);
  resetMemberBibleViews();
  const v = await view();
  expect(await v.waitForEmbeddings(EMBED_TIMEOUT_MS)).toBe(true);
  expect((await v.list({ limit: 100 })).length).toBe(BIBLE.length);
  if (embedded) expect(v.vectorIndexStatus().pending).toBe(0);
  return v;
}

beforeAll(async () => {
  if (SKIP) return;
  backupAndResetRegistry();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-member-real-model-'));
  repo = path.join(scratch, 'checkout');
  fs.mkdirSync(path.join(repo, '.fleet'), { recursive: true });
  // The bible import's basis check needs every source file in the checkout.
  for (const f of new Set(BIBLE.flatMap(e => e.source_files))) {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    fs.writeFileSync(path.join(repo, f), `// ${f}\n`);
  }
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', `https://example.test/kb-member-real-model-${RUN}.git`], { cwd: repo });
  fs.writeFileSync(path.join(repo, '.fleet', 'kb-canonical.json'), JSON.stringify({ version: 2, entries: BIBLE }), 'utf-8');
  const agent = makeTestLocalAgent({ friendlyName: `kb-real-model-${RUN}`, workFolder: repo });
  addAgent(agent);
  member = agent.id;

  const modelsDir = process.env.APRA_KB_EVAL_MODELS_DIR!;
  embedder = new Embedder({
    choice: { kind: 'enabled', profile: PROFILE },
    store: new ModelStore({
      modelsDir,
      download: async () => { throw new Error(`model not available locally under ${modelsDir} (downloads are off)`); },
    }),
    log: () => {},
  });
  const probe = await embedder.embedQuery('probe');
  if (!probe) throw new Error(`real model failed to load: ${JSON.stringify(embedder.state)}`);
}, EMBED_TIMEOUT_MS);

afterAll(async () => {
  if (SKIP) return;
  setMemberViewEmbedderSourceForTests(undefined);
  resetMemberBibleViews();
  restoreRegistry();
  await embedder?.close();
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
}, 60_000);

// Without the model, one test RUNS to say so (a module-level log is not shown
// for a file whose tests all skip), and fails when the model is required.
describe.runIf(SKIP !== null)('real default model availability', () => {
  // The reason is in the title too, so every reporter shows it.
  it(`real-model member cases SKIPPED: ${SKIP}`, () => {
    console.log(`[kb-member-real-model] SKIPPED: ${SKIP}`);
    if (REQUIRE_MODEL) expect.fail(`APRA_KB_EVAL_REQUIRE_MODELS=1 but ${SKIP}`);
  });
});

describe.skipIf(SKIP !== null)(`MEMBER reads with the real default model (${DEFAULT_EMBEDDING_PROFILE})`, () => {
  it('keyword-only (no embedder) the paraphrase does not find the entry: no shared keyword', async () => {
    await freshView(false);
    expect(ids(await memberQuery({ query: PARAPHRASE, limit: 5 }))).not.toContain(TARGET_ID);
  }, EMBED_TIMEOUT_MS);

  it('a paraphrase returns the bible entry in the top 5 as a member', async () => {
    await freshView(true);
    const got = ids(await memberQuery({ query: PARAPHRASE, limit: 5 }));
    expect(got).toContain(TARGET_ID);
  }, EMBED_TIMEOUT_MS);

  it('a query with a file anchor ranks the anchored entry first', async () => {
    await freshView(true);
    const got = ids(await memberQuery({ query: 'test processes fail', files: ['src/sprint-lock.ts'], limit: 5 }));
    expect(got[0]).toBe(ANCHOR_ID);
  }, EMBED_TIMEOUT_MS);

  it('a nonsense query returns 0 rows as a member (similarity floor)', async () => {
    await freshView(true);
    expect(ids(await memberQuery({ query: NONSENSE, limit: 10 }))).toEqual([]);
  }, EMBED_TIMEOUT_MS);

  it('engine knowledge injection (knowledgeFor through memberCall) returns the entry', async () => {
    await freshView(true);
    const memberCall = async (record: { id: string }, tool: string, args: Record<string, unknown>) => {
      if (tool !== 'kb_query') throw new Error(`unexpected tool ${tool}`);
      const text = await runWithSessionMember(record.id, () => kbQuery(kbQuerySchema.parse(args)));
      return { content: [{ type: 'text', text }] };
    };
    const logs: string[] = [];
    const client = createKbWorkClient({ memberCall, log: (m: string) => logs.push(m) });
    const out = await client.knowledgeFor(
      { id: member, name: `kb-real-model-${RUN}` },
      // As the engine builds hints: bead terms plus one situation query per bead.
      { terms: PARAPHRASE.split(' '), situations: [{ kind: 'bead', situation: PARAPHRASE }] },
    );
    expect(logs).toEqual([]);
    expect(out.source).toBe('query');
    expect(out.entries.map((e: { id: string }) => e.id)).toContain(TARGET_ID);
  }, EMBED_TIMEOUT_MS);
});
