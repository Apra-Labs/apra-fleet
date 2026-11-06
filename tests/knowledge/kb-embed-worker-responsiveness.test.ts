/**
 * Real-model end-to-end: the BUILT server stays responsive while the KB
 * rebuilds its vectors with the real default embedding model, semantic search
 * comes back after a restart without any write, and the SEA binary embeds
 * through its worker.
 *
 * Scenario: a KB with 630 realistic entries (summaries, content, recall cues,
 * error signatures) that all need embedding; start dist/index.js on it; the
 * first kb call opens the KB and starts the rebuild in the embed worker.
 * While it runs, kb_query / kb_list calls and GET /health go out repeatedly
 * and a 5 ms interval preloaded into the server's main thread (NODE_OPTIONS
 * --import, test-only) records every gap. Then: stop, restart with no write,
 * and a paraphrase query must get semantic results.
 *
 * Needs the real model on disk, so it is OPT-IN, like the recall eval:
 *   APRA_KB_EVAL_MODELS_DIR=<models folder holding Xenova/bge-small-en-v1.5@<rev>>
 *   (or APRA_KB_EVAL_ALLOW_DOWNLOAD=1 to download it into the test sandbox)
 * plus a built dist/index.js (npm run build). Without them every case SKIPS
 * with the reason printed. The SEA case also needs npm run build:binary.
 * Everything it writes lives under one mkdtemp folder removed in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { resolveProjectSlug } from '../../src/services/knowledge/project-slug.js';
import { ModelStore } from '../../src/services/knowledge/embedding/model-store.js';
import { BUILTIN_EMBEDDING_PROFILES, DEFAULT_EMBEDDING_PROFILE } from '../../src/services/knowledge/embedding/profiles.js';
import { MEMBER_ACCESS_SECRET_FILE, MEMBER_SECRET_HEADER, readMemberAccessSecret } from '../../src/services/member-access-secret.js';

const ROOT = path.resolve(__dirname, '..', '..');
const DIST_INDEX = path.join(ROOT, 'dist', 'index.js');
const SEA_BINARY = path.join(ROOT, 'dist', `apra-fleet-installer-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`);
const PROFILE = BUILTIN_EMBEDDING_PROFILES[DEFAULT_EMBEDDING_PROFILE];
const ENTRY_COUNT = 630;
const HEALTH_BUDGET_MS = 2000; // src/services/singleton.ts HEALTH_TIMEOUT_MS
const ALL_TIERS = ['CONFIRMED', 'INFERRED', 'UNVERIFIED'];
const REBUILD_TIMEOUT_MS = 25 * 60 * 1000;

function hubFolder(modelsDir: string): string {
  const src = PROFILE.source;
  if (src.kind !== 'hub') throw new Error('default profile is not a hub model');
  const parts = src.repo.split('/');
  parts[parts.length - 1] = `${parts[parts.length - 1]}@${src.revision}`;
  return path.join(modelsDir, ...parts);
}

/** Why this suite cannot run here, or null. */
function skipReason(): string | null {
  if (!fs.existsSync(DIST_INDEX)) return `dist/index.js not built (run npm run build)`;
  const dir = process.env.APRA_KB_EVAL_MODELS_DIR;
  if (process.env.APRA_KB_EVAL_ALLOW_DOWNLOAD === '1') return null;
  if (!dir) return 'real embedding model not available: set APRA_KB_EVAL_MODELS_DIR (or APRA_KB_EVAL_ALLOW_DOWNLOAD=1)';
  if (!fs.existsSync(path.join(hubFolder(dir), 'onnx', 'model_quantized.onnx'))) {
    return `real embedding model not under ${hubFolder(dir)}`;
  }
  return null;
}

const SKIP = skipReason();
if (SKIP) console.warn(`[kb-embed-worker-responsiveness] SKIPPED: ${SKIP}`);

// ---------------------------------------------------------------------------
// Realistic KB content
// ---------------------------------------------------------------------------

const SUBSYSTEMS = ['ssh transport', 'dolt sync', 'sprint runner', 'beads tracker', 'member registry', 'credential store',
  'workflow engine', 'install script', 'code index', 'knowledge bank', 'http transport', 'statusline', 'idle manager',
  'git sync', 'provider adapter', 'deploy playbook', 'supervisor api', 'event watchdog', 'model store', 'vector queue'];
const PROBLEMS = ['times out after a host suspend', 'leaks a file handle on retry', 'loses the lock when two clones race',
  'reports success although the child exited non-zero', 'drops the last line of output', 'rereads the config on every call',
  'fails on paths with spaces', 'hangs when stderr is not drained', 'misreads a CRLF line ending', 'keeps a stale cache after upgrade',
  'retries forever on a 401', 'ignores the per-member shell', 'double counts token usage', 'writes non-ASCII to a log',
  'blocks the event loop on a large payload', 'skips cleanup when aborted', 'races the heartbeat writer', 'truncates a long branch name',
  'treats an empty response as success', 'resolves the wrong home folder'];
const FIXES = ['wrap the call in a bounded timeout and surface the reason', 'release the handle in a finally block',
  'claim the lock in a BEGIN IMMEDIATE transaction', 'check the exit code before reading the output', 'flush the stream before closing',
  'cache the parsed config keyed by its content hash', 'quote the path for the member shell', 'pipe stderr into the log',
  'normalize line endings before parsing', 'invalidate the cache on a version change', 'stop after one retry and raise a typed error',
  'resolve the command through the member OS adapter', 'record usage once per dispatch', 'map the glyph to its ASCII form',
  'stream the payload in chunks', 'run cleanup in the abort handler', 'serialize the writers', 'hash the name into a short slug',
  'treat an empty response as a dispatch failure', 'read the home folder from the member probe'];

function entryFor(i: number) {
  const sub = SUBSYSTEMS[i % SUBSYSTEMS.length];
  const prob = PROBLEMS[Math.floor(i / SUBSYSTEMS.length) % PROBLEMS.length];
  const fix = FIXES[(i * 7) % FIXES.length];
  const tag = `case${i}`;
  return {
    type: 'learning' as const,
    title: `${sub} ${prob} (${tag})`,
    summary: `When the ${sub} ${prob}, ${fix}. Seen in ${tag} on a busy member.`,
    content: [
      `The ${sub} ${prob}. It shows up under load, usually after a long idle period, and the operator sees a stalled dispatch.`,
      `Root cause: the ${sub} assumed the previous step had finished, so the follow-up read raced it.`,
      `Fix: ${fix}. Add a regression test that drives the real code path, not a re-derivation.`,
      `Verification: run the scenario twice in isolation and once under the full suite; record the timings (${tag}).`,
    ].join(' '),
    recall_cues: [`${sub} stalls`, `${sub} flaky`, `${tag}`],
    error_signatures: [`E-${sub.replace(/\s+/g, '-').toUpperCase()}-${i}: ${prob}`],
    source_files: ['src/a.ts'], symbols: [`Sub${i}.run`], tags: [], content_hash: '', content_hash_type: 'sha256' as const,
    flagged_for_review: false, author: 't', source: 'doer' as const, confidence: 'INFERRED' as const,
  };
}

/** The paraphrase target and a query sharing no keyword with it. */
const TARGET = {
  type: 'learning' as const,
  title: 'Car engine stalls on cold mornings',
  summary: 'Replace the idle air control valve; the motor then starts in frost.',
  content: 'Car engine stalls on cold mornings. Replace the idle air control valve; the motor then starts in frost.',
  source_files: ['src/a.ts'], symbols: [], tags: [], content_hash: '', content_hash_type: 'sha256' as const,
  flagged_for_review: false, author: 't', source: 'doer' as const, confidence: 'INFERRED' as const,
};
const PARAPHRASE = 'automobile dies chilly weather';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let scratch: string;
let dataDir: string;
let repo: string;
let kbFile: string;
let probeFile: string;
let modelsCache: string;
let targetId = '';
let server: { child: ChildProcess; port: number; client: Client } | null = null;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

function getHealth(port: number): Promise<{ status: number; ms: number }> {
  const started = performance.now();
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: HEALTH_BUDGET_MS }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, ms: performance.now() - started }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, ms: performance.now() - started }); });
    req.on('error', () => resolve({ status: 0, ms: performance.now() - started }));
  });
}

async function startServer(): Promise<{ child: ChildProcess; port: number; client: Client }> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    APRA_FLEET_DATA_DIR: dataDir,
    APRA_FLEET_PORT: String(port),
    NODE_OPTIONS: `--import=${pathToFileURL(path.join(scratch, 'loop-probe.mjs')).href}`,
    KB_LOOP_PROBE_FILE: probeFile,
  };
  delete env.APRA_FLEET_KB_EMBED; // the real server embeds
  const child = spawn(process.execPath, [DIST_INDEX], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout?.on('data', (d) => { out += d; });
  child.stderr?.on('data', (d) => { out += d; });
  const deadline = Date.now() + 60_000;
  while ((await getHealth(port)).status !== 200) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`server did not start: ${out.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  const secret = readMemberAccessSecret(path.join(dataDir, MEMBER_ACCESS_SECRET_FILE));
  const client = new Client({ name: 'kb-responsiveness', version: '1.0.0' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: secret ? { [MEMBER_SECRET_HEADER]: secret } : {} },
    reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 100, initialReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 },
  }));
  return { child, port, client };
}

async function stopServer(): Promise<void> {
  if (!server) return;
  const { child, client } = server;
  server = null;
  try { await client.close(); } catch { /* already gone */ }
  if (child.exitCode === null) {
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    child.kill('SIGTERM');
    const t = setTimeout(() => child.kill('SIGKILL'), 10_000);
    await exited;
    clearTimeout(t);
  }
}

async function tool(name: string, args: Record<string, unknown>): Promise<{ ms: number; text: string; isError: boolean }> {
  const started = performance.now();
  const r = await server!.client.callTool({ name, arguments: args });
  const text = ((r.content as Array<{ text?: string }>) ?? []).map((c) => c.text ?? '').join('\n');
  return { ms: performance.now() - started, text, isError: r.isError === true };
}

function rebuildState(): { pending: number; owner: string | null; vectors: number } {
  const db = new DatabaseSync(kbFile, { readOnly: true });
  try {
    const pending = Number((db.prepare('SELECT COUNT(*) AS n FROM kb_embed_pending').get() as { n: number }).n);
    const owner = (db.prepare("SELECT value FROM kb_index_meta WHERE key = 'vec_rebuild_owner'").get() as { value: string | null } | undefined)?.value ?? null;
    const vectors = Number((db.prepare('SELECT COUNT(*) AS n FROM entry_vectors').get() as { n: number }).n);
    return { pending, owner, vectors };
  } finally {
    db.close();
  }
}

/** Main-thread loop gaps the probe recorded in the server process between t0 and t1 (epoch ms). */
function loopGaps(pid: number, t0: number, t1: number): { maxGap: number; samples: number; top: string } {
  const file = `${probeFile}.${pid}`;
  const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as { gaps: [number, number][]; ticks: [number, number][] };
  const inWindow = data.gaps.filter(([at]) => at >= t0 && at <= t1);
  const ticks = data.ticks.filter(([at]) => at >= t0 && at <= t1).reduce((n, [, c]) => n + c, 0);
  const top = [...inWindow].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([at, g]) => `${g} ms at +${((at - t0) / 1000).toFixed(1)} s`).join(', ');
  return { maxGap: inWindow.reduce((m, [, g]) => Math.max(m, g), 0), samples: ticks, top };
}

function p95(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
}

function resultIds(text: string): string[] {
  const parsed = JSON.parse(text) as { l1_results?: { id: string }[]; results?: { id: string }[] };
  return (parsed.l1_results ?? parsed.results ?? []).map((r) => r.id);
}

beforeAll(async () => {
  if (SKIP) return;
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kb-resp-')));
  dataDir = path.join(scratch, 'data');
  repo = path.join(scratch, 'repo');
  probeFile = path.join(scratch, 'loop-probe.json');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'https://example.invalid/acme/kb-responsiveness.git'], { cwd: repo });

  // Test-only main-thread probe: a 5 ms interval recording every gap over 20 ms
  // and a tick count per 250 ms, flushed to <probeFile>.<pid> (main thread only).
  fs.writeFileSync(path.join(scratch, 'loop-probe.mjs'), `
import fs from 'node:fs';
import { isMainThread } from 'node:worker_threads';
const file = process.env.KB_LOOP_PROBE_FILE;
if (file && isMainThread) {
  const gaps = []; const ticks = [];
  let last = performance.now(); let count = 0; let bucket = Date.now();
  setInterval(() => {
    const now = performance.now(); const gap = now - last; last = now; count++;
    if (gap > 20) gaps.push([Date.now(), Math.round(gap)]);
    if (Date.now() - bucket >= 250) { ticks.push([Date.now(), count]); count = 0; bucket = Date.now(); }
  }, 5).unref();
  setInterval(() => { try { fs.writeFileSync(file + '.' + process.pid, JSON.stringify({ gaps, ticks })); } catch {} }, 200).unref();
}
`);

  // The real default model in the server's models folder (never downloaded by the server).
  modelsCache = process.env.APRA_KB_EVAL_MODELS_DIR || path.join(scratch, 'model-cache');
  if (!fs.existsSync(path.join(hubFolder(modelsCache), 'onnx', 'model_quantized.onnx'))) {
    const st = await new ModelStore({ modelsDir: modelsCache, hubEndpoint: 'https://huggingface.co' })
      .ensure({ kind: 'enabled', profile: PROFILE });
    if (st.state !== 'ready') throw new Error(`model download failed: ${st.state === 'failed' ? st.reason : st.state}`);
  }
  fs.cpSync(hubFolder(modelsCache), hubFolder(path.join(dataDir, 'models')), { recursive: true });

  // The KB the server will open for this repo, with every entry waiting to be embedded.
  kbFile = path.join(dataDir, 'knowledge', resolveProjectSlug(repo), 'kb.sqlite');
  fs.mkdirSync(path.dirname(kbFile), { recursive: true });
  const seed = new SqliteProvider(kbFile, repo);
  await seed.init();
  targetId = (await seed.capture(TARGET)).id;
  for (let i = 0; i < ENTRY_COUNT - 1; i++) await seed.capture(entryFor(i));
  seed.close();
}, 10 * 60 * 1000);

afterAll(async () => {
  await stopServer();
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
}, 60_000);

describe.skipIf(SKIP !== null)('real-model KB rebuild in the built server', () => {
  it('seeded a KB whose entries all need embedding', () => {
    const st = rebuildState();
    expect(st.pending).toBe(ENTRY_COUNT);
    expect(st.vectors).toBe(0);
  });

  it('during the rebuild: /health always answers 200 within 2 s, tool p95 < 500 ms, no main-thread gap over 100 ms', async () => {
    server = await startServer();
    const pid = server.child.pid!;
    const t0 = Date.now();
    // The first kb call opens the KB: the queue claims the rebuild and the worker loads the model.
    await tool('kb_list', { limit: 5 });

    const health: { status: number; ms: number }[] = [];
    const toolMs: number[] = [];
    const queries = ['ssh transport times out', 'dolt sync lock race', 'flaky stderr drain', 'config cache upgrade', 'member shell quoting'];
    let i = 0;
    let st = rebuildState();
    const deadline = Date.now() + REBUILD_TIMEOUT_MS;
    let sawRebuild = false;
    while (st.pending > 0 || st.owner !== null) {
      if (Date.now() > deadline) throw new Error(`rebuild did not finish: ${JSON.stringify(st)}`);
      if (st.owner !== null) sawRebuild = true;
      const [h, q, l] = await Promise.all([
        getHealth(server.port),
        tool('kb_query', { query: queries[i % queries.length], confidence: ALL_TIERS, limit: 10 }),
        tool('kb_list', { confidence: ALL_TIERS, limit: 10 }),
      ]);
      expect(q.isError).toBe(false);
      expect(l.isError).toBe(false);
      health.push(h);
      toolMs.push(q.ms, l.ms);
      i++;
      await new Promise((r) => setTimeout(r, 100));
      st = rebuildState();
    }
    const t1 = Date.now();
    await new Promise((r) => setTimeout(r, 400)); // let the probe flush
    const loop = loopGaps(pid, t0, t1);

    const healthWorst = Math.max(...health.map((h) => h.ms));
    console.log(`[kb-embed-worker-responsiveness] rebuild of ${ENTRY_COUNT} entries took ${((t1 - t0) / 1000).toFixed(1)} s, ` +
      `${st.vectors} vectors; ${health.length} /health probes (worst ${healthWorst.toFixed(0)} ms), ` +
      `${toolMs.length} tool calls (p95 ${p95(toolMs).toFixed(0)} ms, max ${Math.max(...toolMs).toFixed(0)} ms); ` +
      `main-thread 5 ms interval: max gap ${loop.maxGap} ms over ${loop.samples} ticks (largest: ${loop.top || 'none over 20 ms'})`);

    expect(sawRebuild || i > 0).toBe(true);
    expect(st.vectors).toBeGreaterThanOrEqual(ENTRY_COUNT);
    expect(health.every((h) => h.status === 200 && h.ms < HEALTH_BUDGET_MS)).toBe(true);
    expect(p95(toolMs)).toBeLessThan(500);
    expect(loop.samples).toBeGreaterThan(100);
    expect(loop.maxGap).toBeLessThan(100);
  }, REBUILD_TIMEOUT_MS + 120_000);

  it('after a restart with no write, a paraphrase query returns semantic results', async () => {
    await stopServer();
    const before = rebuildState();
    server = await startServer();
    const deadline = Date.now() + 120_000;
    let ids: string[] = [];
    // The model loads in the background after open; poll until the semantic list is there.
    while (Date.now() < deadline) {
      const r = await tool('kb_query', { query: PARAPHRASE, confidence: ALL_TIERS, limit: 5 });
      expect(r.isError).toBe(false);
      ids = resultIds(r.text);
      if (ids.includes(targetId)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(ids.slice(0, 3)).toContain(targetId);
    // No write happened: nothing was queued or re-embedded.
    const after = rebuildState();
    expect(after.pending).toBe(0);
    expect(after.vectors).toBe(before.vectors);
    await stopServer();

    // Control: keyword search alone does not find the target for this query.
    const p = new SqliteProvider(kbFile, repo);
    await p.init();
    try {
      const kw = await p.query({ query: PARAPHRASE, confidence: ALL_TIERS as never, limit: 20, disable_lists: ['semantic'] });
      expect(kw.results.map((e) => e.id)).not.toContain(targetId);
    } finally {
      p.close();
    }
  }, 300_000);
});

describe.skipIf(SKIP !== null || !fs.existsSync(SEA_BINARY))('the SEA binary embeds through its worker', () => {
  it('kb embed-check returns a vector of the model dims (origin sea-asset)', () => {
    const r = spawnSync(SEA_BINARY, ['kb', 'embed-check', '--model-dir', hubFolder(modelsCache)], {
      encoding: 'utf-8',
      env: { ...process.env, APRA_FLEET_DATA_DIR: path.join(scratch, 'sea-data') },
      timeout: 120_000,
      windowsHide: true,
    });
    const line = r.stdout.trim().split('\n').pop() ?? '';
    const out = JSON.parse(line) as { ok: boolean; origin: string; dims: number };
    expect(out).toMatchObject({ ok: true, origin: 'sea-asset', dims: PROFILE.dims });
  }, 180_000);
});
