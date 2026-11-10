import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';

// fleet_status and kb_session_prime while the embedding model is downloading,
// failed or off, against the real handlers, real KB, real Embedder and a real
// ModelStore downloading over HTTP from a local server. Nothing stubs the
// embedder state: downloading is a response the server holds open, failed is a
// 404 or a wrong-hash body, off is the real kb_setup embedding_model none.
//
// Isolation: APRA_FLEET_DATA_DIR points at one mkdtemp sandbox before any
// module reads it, so the registry, KB, config, models folder and log all live
// inside it. The sandbox config pins embedding.model none, so nothing here can
// reach the default model download.

const sandbox = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsH = require('node:fs') as typeof import('node:fs');
  const osH = require('node:os') as typeof import('node:os');
  const pathH = require('node:path') as typeof import('node:path');
  const before = fsH.readdirSync(osH.tmpdir()).filter((n) => n.startsWith('fleet-embed-state-e2e-'));
  const root = fsH.mkdtempSync(pathH.join(osH.tmpdir(), 'fleet-embed-state-e2e-'));
  const saved = process.env.APRA_FLEET_DATA_DIR;
  process.env.APRA_FLEET_DATA_DIR = pathH.join(root, 'data');
  return { root, saved, before };
});

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: vi.fn().mockResolvedValue({ stdout: 'idle', stderr: '', code: 0 }),
    testConnection: vi.fn().mockResolvedValue({ ok: true, latencyMs: 5 }),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { fleetStatus } from '../src/tools/check-status.js';
import { kbSetup } from '../src/tools/kb-setup.js';
import { kbCapture } from '../src/tools/kb-capture.js';
import { kbQuery } from '../src/tools/kb-query.js';
import { kbSessionPrime } from '../src/tools/kb-session-prime.js';
import { Embedder, _setEmbedderForTest } from '../src/services/knowledge/embedding/embedder.js';
import { ModelStore } from '../src/services/knowledge/embedding/model-store.js';
import { BUILTIN_EMBEDDING_PROFILES, DEFAULT_EMBEDDING_PROFILE, type EmbeddingProfile } from '../src/services/knowledge/embedding/profiles.js';
import { FLEET_DIR } from '../src/paths.js';
import { getGlobalKbProvider, getProjectSqliteProvider, resetKbProviders } from '../src/services/knowledge/kb-providers.js';
import { isolateGitConfig } from './knowledge/isolate-git-config.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const REV = 'state0123';
const bodies: Record<string, string> = {
  'config.json': '{"hidden_size":4}',
  'tokenizer.json': '{"model":{"vocab":{}}}',
  'onnx/model_quantized.onnx': 'ONNX-'.repeat(400),
};
const profile: EmbeddingProfile = {
  ...BUILTIN_EMBEDDING_PROFILES[DEFAULT_EMBEDDING_PROFILE],
  source: {
    kind: 'hub', repo: 'Test/state-model', revision: REV,
    files: Object.entries(bodies).map(([p, b]) => ({ path: p, sha256: sha(b) })),
  },
};

type Mode = 'ok' | 'not-found' | 'bad-hash' | 'hold';
let server: http.Server;
let sockets: Set<net.Socket>;
let port: number;
let mode: Mode;
let held: http.ServerResponse[];

async function startServer(): Promise<void> {
  sockets = new Set();
  held = [];
  server = http.createServer((req, res) => {
    const file = decodeURIComponent((req.url ?? '').split(`/resolve/${REV}/`)[1] ?? '');
    const body = bodies[file];
    if (mode === 'not-found' || body === undefined) { res.writeHead(404); res.end('nope'); return; }
    if (mode === 'bad-hash') { res.writeHead(200); res.end('tampered ' + body); return; }
    if (mode === 'hold') {
      res.writeHead(200, { 'content-length': String(body.length) });
      res.write(body.slice(0, 1));
      held.push(res); // never finished until the server is torn down
      return;
    }
    res.writeHead(200, { 'content-length': String(body.length) });
    res.end(body);
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
}

const configPath = path.join(FLEET_DIR, 'knowledge', 'config.json');
let repo: string;
let restoreGitConfig: () => void;
let embedder: Embedder | null;

const listSandboxes = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('fleet-embed-state-e2e-'));

beforeEach(async () => {
  restoreGitConfig = isolateGitConfig();
  backupAndResetRegistry();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ embedding: { model: 'none' } }));
  repo = path.join(sandbox.root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'wombat.ts'), 'export const wombat = 1;\n');
  _setEmbedderForTest(null);
  embedder = null;
  mode = 'ok';
  await startServer();
});

afterEach(async () => {
  _setEmbedderForTest(null);
  // Release the held download first: close() waits for an in-flight load.
  for (const r of held) r.destroy();
  for (const s of sockets) s.destroy();
  await embedder?.close();
  await new Promise<void>((r) => server.close(() => r()));
  restoreRegistry();
  restoreGitConfig();
  // The cached KB providers hold kb.sqlite open; Windows refuses to delete an
  // open file, so close them and drop the cache before removing the data
  // folder. Each case then starts from an empty data folder and fresh providers.
  (await getProjectSqliteProvider(repo)).close();
  (await getGlobalKbProvider()).close();
  resetKbProviders();
  fs.rmSync(path.join(sandbox.root, 'data'), { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(sandbox.root, { recursive: true, force: true });
  if (sandbox.saved === undefined) delete process.env.APRA_FLEET_DATA_DIR;
  else process.env.APRA_FLEET_DATA_DIR = sandbox.saved;
  // Nothing may be left behind in the system temp folder.
  expect(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('fleet-embed-state-e2e-'))).toEqual(sandbox.before);
});

function pinEmbedder(withFakeRuntime = false): Embedder {
  const store = new ModelStore({
    modelsDir: path.join(FLEET_DIR, 'models'),
    hubEndpoint: `http://127.0.0.1:${port}`,
    releaseBaseUrl: null,
  });
  embedder = new Embedder({
    choice: { kind: 'enabled', profile },
    store,
    log: () => {},
    ...(withFakeRuntime ? {
      runtimeFactory: async () => ({ dims: 4, embed: async (t: string[]) => t.map(() => new Float32Array(4)) }),
    } : {}),
  });
  _setEmbedderForTest(embedder);
  return embedder;
}

async function until(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function captureOne(): Promise<void> {
  const out = JSON.parse(await kbCapture({
    type: 'knowledge', title: 'Wombat habits', summary: 'Wombats dig burrows near quokka colonies.',
    confidence: 'CONFIRMED', source_files: ['src/wombat.ts'],
  }, { folder: repo }));
  expect(out.error).toBeUndefined();
}

async function expectKeywordHit(): Promise<void> {
  const out = JSON.parse(await kbQuery({ query: 'wombat burrows', confidence: ['CONFIRMED', 'INFERRED', 'UNVERIFIED'] }, { folder: repo }));
  expect(JSON.stringify(out.l1_results ?? [])).toContain('Wombat habits');
}

const FIX = /apra-fleet kb model import|apra-fleet kb embedding|kb_setup/;
const NOTICE_LINE = /semantic search/;

interface Seen { compact: string; json: any }
async function seen(): Promise<Seen> {
  return {
    compact: await fleetStatus({ format: 'compact' } as never),
    json: JSON.parse(await fleetStatus({ format: 'json' } as never)),
  };
}

function expectNotice(s: Seen, state: string, reasonPart: RegExp): void {
  const lines = s.compact.split('\n').filter((l) => NOTICE_LINE.test(l));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(reasonPart);
  expect(lines[0]).toMatch(FIX);
  const e = s.json.kbHealth.embedding;
  expect(e.state).toBe(state);
  expect(typeof e.reason).toBe('string');
  expect(e.reason).toMatch(reasonPart);
  expect(e.fix).toMatch(FIX);
}

async function primeOk(expectWarning: boolean): Promise<void> {
  const out = JSON.parse(await kbSessionPrime({}, { folder: repo }));
  expect(Array.isArray(out.top_entries)).toBe(true);
  if (expectWarning) expect(out.embedding_warning).toMatch(NOTICE_LINE);
  else expect(out.embedding_warning).toBeUndefined();
}

const withMembers = [false, true];

describe.each(withMembers)('embedding notices (member registered: %s)', (hasMember) => {
  beforeEach(() => {
    if (hasMember) addAgent(makeTestAgent({ friendlyName: 'embed-state-member' }));
  });

  it('off: kb_setup embedding_model none shows state and how to change it; no prime warning', async () => {
    const res = JSON.parse(await kbSetup({ embedding_model: 'none' }, { folder: repo }));
    expect(res.success).toBe(true);
    await captureOne();
    const s = await seen();
    expectNotice(s, 'disabled', /embedding\.model is none/);
    // A deliberate off is stated, never urged back on.
    expect(s.compact).not.toMatch(/back on/);
    expect(s.json.kbHealth.embedding.fix).not.toMatch(/back on/);
    await primeOk(false);
    await expectKeywordHit();
  });

  it.each<[string, Mode, RegExp]>([
    ['404', 'not-found', /404/],
    ['wrong hash', 'bad-hash', /sha256 mismatch/],
  ])('failed (%s): model endpoint refusing the model shows state, reason and fix', async (_n, m, reason) => {
    mode = m;
    const e = pinEmbedder();
    await captureOne();
    e.warmUp();
    await until(() => e.state.state === 'failed', 'failed state');
    expectNotice(await seen(), 'failed', reason);
    await primeOk(true);
    await expectKeywordHit();
  });

  it('downloading: a server holding the response open shows state, reason and fix', async () => {
    mode = 'hold';
    const e = pinEmbedder();
    await captureOne();
    e.warmUp();
    await until(() => e.state.state === 'downloading' && held.length > 0, 'downloading state with bytes flowing');
    expectNotice(await seen(), 'downloading', /downloading/);
    expect((await seen()).compact).toMatch(/keyword and anchor search serve meanwhile/);
    await primeOk(true);
    await expectKeywordHit();
  });

  it('healthy (ready): none of the notice lines appear', async () => {
    const e = pinEmbedder(true);
    await captureOne();
    e.warmUp();
    await until(() => e.state.state === 'ready', 'ready state');
    const s = await seen();
    expect(s.compact).not.toMatch(NOTICE_LINE);
    if (hasMember) {
      expect(s.json.kbHealth.embedding.state).toBe('ready');
      expect(s.json.kbHealth.embedding.fix).toBeUndefined();
      expect(s.json.kbHealth.embedding.reason).toBeUndefined();
    } else {
      // No members and nothing to report: the short form carries no KB section.
      expect(s.json.kbHealth).toBeUndefined();
      expect(s.compact).toBe('No members registered. Use register_member to add one.');
    }
    await primeOk(false);
  });
});

describe('sandbox hygiene', () => {
  it('keeps every file inside the sandbox', () => {
    expect(FLEET_DIR.startsWith(sandbox.root)).toBe(true);
    expect(listSandboxes().filter((n) => !sandbox.before.includes(n))).toEqual([path.basename(sandbox.root)]);
  });
});
