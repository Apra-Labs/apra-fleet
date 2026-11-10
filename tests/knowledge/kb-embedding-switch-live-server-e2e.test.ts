/**
 * End-to-end: turning KB semantic search off and switching the model on a
 * REAL running fleet server, with no restart -- through kb_setup and through
 * the `apra-fleet kb embedding` CLI run as a separate process.
 *
 * Real pieces: the built server (dist/index.js) spawned as its own process on
 * a sandboxed data dir (APRA_FLEET_DATA_DIR) and port, a real MCP SDK client,
 * the real Embedder and ModelStore inside the server, the built CLI in child
 * processes, and a real local HTTP server standing in for the model hub
 * (HF_ENDPOINT). Nothing in the server is mocked or stubbed.
 *
 * "No model load attempted" is observed through the hub stand-in: it counts
 * every request. While it serves nothing (404), an enabled embedder that tries
 * to load the default model downloads from it, so a request count that does
 * not move across a kb_query + fleet_status proves no load was attempted.
 * Switching back on must make the count move (a real download attempt).
 *
 * The real default model: when APRA_KB_EVAL_MODELS_DIR holds it (the same
 * convention as the recall eval), the hub stand-in serves those real files
 * once switched back on and the test also waits for the embedding state to
 * reach ready. Without it the stand-in keeps answering 404 and the state
 * leaves disabled for failed -- still a real download attempt, not a stub.
 *
 * Sandbox: every file lives under one mkdtemp folder (data dir, repo, logs,
 * downloaded model) removed in afterAll; the test checks that nothing else
 * under the OS temp dir with its prefix, and nothing in this test process's
 * own data dir, is left or changed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BUILTIN_EMBEDDING_PROFILES, DEFAULT_EMBEDDING_PROFILE } from '../../src/services/knowledge/embedding/profiles.js';
import { MEMBER_ACCESS_SECRET_FILE, MEMBER_SECRET_HEADER, readMemberAccessSecret } from '../../src/services/member-access-secret.js';
import { FLEET_DIR } from '../../src/paths.js';

const ROOT = path.resolve(__dirname, '..', '..');
const DIST_INDEX = path.join(ROOT, 'dist', 'index.js');
const PREFIX = 'kb-embed-switch-e2e-';
const PROFILE = BUILTIN_EMBEDDING_PROFILES[DEFAULT_EMBEDDING_PROFILE];
const ALL_TIERS = ['CONFIRMED', 'INFERRED', 'UNVERIFIED'];
const STEP_TIMEOUT = 180_000;

/** Folder of the real default model under APRA_KB_EVAL_MODELS_DIR, or null. */
function realModelDir(): string | null {
  const base = process.env.APRA_KB_EVAL_MODELS_DIR;
  const src = PROFILE.source;
  if (!base || src.kind !== 'hub') return null;
  const parts = src.repo.split('/');
  parts[parts.length - 1] = `${parts[parts.length - 1]}@${src.revision}`;
  const dir = path.join(base, ...parts);
  return src.files.every((f) => fs.existsSync(path.join(dir, ...f.path.split('/')))) ? dir : null;
}

const REAL_MODEL = realModelDir();

let scratch: string;
let dataDir: string;
let repo: string;
let configPath: string;
let ownConfigBefore: string | null;
let tmpBefore: string[];

// The hub stand-in.
let hub: http.Server;
let hubPort = 0;
let hubRequests = 0;
let hubServes = false;

// The fleet server.
let child: ChildProcess;
let serverPid = 0;
let client: Client;
let serverOut = '';
let keywordId = '';

function tmpEntries(): string[] {
  return fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(PREFIX)).sort();
}

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

function healthOk(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 2000 }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode === 200));
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

/** Serve <repo>/resolve/<rev>/<path> from the real model folder while hubServes, else 404. Counts every request. */
function startHub(): Promise<void> {
  hub = http.createServer((req, res) => {
    hubRequests++;
    const src = PROFILE.source;
    const prefix = src.kind === 'hub' ? `/${src.repo}/resolve/${src.revision}/` : '\0';
    const url = decodeURIComponent((req.url ?? '').split('?')[0]);
    if (hubServes && REAL_MODEL && url.startsWith(prefix)) {
      const rel = url.slice(prefix.length);
      const file = path.join(REAL_MODEL, ...rel.split('/'));
      if (!rel.includes('..') && fs.existsSync(file)) {
        const size = fs.statSync(file).size;
        res.writeHead(200, { 'content-length': String(size), 'content-type': 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
        return;
      }
    }
    res.writeHead(404);
    res.end('not found');
  });
  return new Promise((resolve) => hub.listen(0, '127.0.0.1', () => {
    hubPort = (hub.address() as net.AddressInfo).port;
    resolve();
  }));
}

async function startServer(): Promise<void> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    APRA_FLEET_DATA_DIR: dataDir,
    APRA_FLEET_PORT: String(port),
    HF_ENDPOINT: `http://127.0.0.1:${hubPort}`,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };
  delete env.APRA_FLEET_KB_EMBED; // the real server embeds
  child = spawn(process.execPath, [DIST_INDEX], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout?.on('data', (d) => { serverOut += d; });
  child.stderr?.on('data', (d) => { serverOut += d; });
  const deadline = Date.now() + 60_000;
  while (!(await healthOk(port))) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`server did not start: ${serverOut.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  serverPid = child.pid!;
  const secret = readMemberAccessSecret(path.join(dataDir, MEMBER_ACCESS_SECRET_FILE));
  client = new Client({ name: 'kb-embed-switch-e2e', version: '1.0.0' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: secret ? { [MEMBER_SECRET_HEADER]: secret } : {} },
    reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 100, initialReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 },
  }));
}

async function stopServer(): Promise<void> {
  try { await client?.close(); } catch { /* already gone */ }
  if (child && child.exitCode === null) {
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    child.kill('SIGTERM');
    const t = setTimeout(() => child.kill('SIGKILL'), 10_000);
    await exited;
    clearTimeout(t);
  }
}

async function tool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const r = await client.callTool({ name, arguments: args });
  const text = ((r.content as Array<{ text?: string }>) ?? []).map((c) => c.text ?? '').join('\n');
  return { text, isError: r.isError === true };
}

/** kbHealth.embedding from fleet_status json on the running server. */
async function embeddingState(): Promise<{ state: string; modelId?: string; reason?: string }> {
  const { text, isError } = await tool('fleet_status', { format: 'json' });
  expect(isError, text).toBe(false);
  const parsed = JSON.parse(text) as { kbHealth?: { embedding?: { state: string; modelId?: string; reason?: string } } };
  const e = parsed.kbHealth?.embedding;
  if (!e) throw new Error(`fleet_status json has no kbHealth.embedding: ${text.slice(0, 1500)}`);
  return e;
}

async function queryIds(q: string): Promise<string[]> {
  const { text, isError } = await tool('kb_query', { query: q, confidence: ALL_TIERS, limit: 10 });
  expect(isError, text).toBe(false);
  const parsed = JSON.parse(text) as { l1_results?: { id: string }[]; results?: { id: string }[] };
  return (parsed.l1_results ?? parsed.results ?? []).map((r) => r.id);
}

/** Poll fleet_status until the embedding state satisfies ok (bounded). */
async function waitForState(ok: (s: string) => boolean, timeoutMs: number): Promise<{ state: string; reason?: string }> {
  const deadline = Date.now() + timeoutMs;
  let last = await embeddingState();
  while (!ok(last.state)) {
    if (Date.now() > deadline) throw new Error(`embedding state stuck at ${JSON.stringify(last)}`);
    await new Promise((r) => setTimeout(r, 250));
    last = await embeddingState();
  }
  return last;
}

/** Run the built CLI verb as a separate process against the server's data dir. */
function cli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, APRA_FLEET_DATA_DIR: dataDir, HF_ENDPOINT: `http://127.0.0.1:${hubPort}` };
  const r = spawnSync(process.execPath, [DIST_INDEX, 'kb', 'embedding', ...args], { encoding: 'utf-8', env, timeout: 30_000, cwd: repo });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** The server is the same process that started: alive, and server.json still names its pid. */
function expectSameServer(): void {
  expect(child.exitCode).toBeNull();
  expect(child.pid).toBe(serverPid);
  const info = JSON.parse(fs.readFileSync(path.join(dataDir, 'server.json'), 'utf-8')) as { pid: number };
  expect(info.pid).toBe(serverPid);
}

beforeAll(async () => {
  if (!fs.existsSync(DIST_INDEX)) throw new Error(`built server missing at ${DIST_INDEX}: run npm run build first`);
  tmpBefore = tmpEntries();
  ownConfigBefore = fs.existsSync(path.join(FLEET_DIR, 'knowledge', 'config.json'))
    ? fs.readFileSync(path.join(FLEET_DIR, 'knowledge', 'config.json'), 'utf-8') : null;
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), PREFIX)));
  dataDir = path.join(scratch, 'data');
  repo = path.join(scratch, 'repo');
  configPath = path.join(dataDir, 'knowledge', 'config.json');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'https://example.invalid/acme/kb-embed-switch.git'], { cwd: repo });
  // One local member, so fleet_status renders its KB section (it returns
  // early on an empty registry).
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dataDir, 'registry.json'), JSON.stringify({
    version: '1.0',
    agents: [{
      id: 'kb-embed-switch-local', friendlyName: 'kb-embed-switch-local', agentType: 'local',
      workFolder: repo, createdAt: new Date().toISOString(), icon: 'circle-blue',
    }],
  }, null, 2), { mode: 0o600 });
  await startHub();
  await startServer();
}, STEP_TIMEOUT);

afterAll(async () => {
  await stopServer();
  await new Promise<void>((r) => (hub ? hub.close(() => r()) : r()));
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  // Nothing left outside the sandbox: no stray folder with this prefix, and
  // this test process's own data dir KB config untouched.
  expect(tmpEntries()).toEqual(tmpBefore);
  const ownConfig = path.join(FLEET_DIR, 'knowledge', 'config.json');
  expect(fs.existsSync(ownConfig) ? fs.readFileSync(ownConfig, 'utf-8') : null).toBe(ownConfigBefore);
}, STEP_TIMEOUT);

describe('semantic search off and model switch on a real running server', { timeout: STEP_TIMEOUT }, () => {
  it('1. kb_setup none: the next kb_query is keyword only, with no model load attempted', async () => {
    const captured = JSON.parse((await tool('kb_capture', {
      type: 'learning',
      title: 'Quokka harbour lantern flickers at dusk',
      summary: 'The quokka harbour lantern flickers at dusk until its wick is trimmed.',
      source_files: ['src/a.ts'],
    })).text) as { id: string };
    keywordId = captured.id;
    expect(keywordId).toBeTruthy();
    await tool('kb_capture', {
      type: 'knowledge', title: 'Pelican ferry timetable', summary: 'The pelican ferry leaves on the hour.', source_files: ['src/a.ts'],
    });

    // Default config: the capture starts background embedding, which tries
    // the hub stand-in (404) and fails -- a real load attempt.
    const failed = await waitForState((s) => s === 'failed', 60_000);
    expect(failed.reason ?? '').not.toBe('');
    expect(hubRequests).toBeGreaterThan(0);

    const setup = await tool('kb_setup', { embedding_model: 'none' });
    expect(setup.isError, setup.text).toBe(false);
    expect(JSON.parse(setup.text).steps.some((s: string) => /embedding model to none/.test(s))).toBe(true);

    const before = hubRequests;
    expect(await queryIds('quokka lantern')).toContain(keywordId);
    expect((await embeddingState()).state).toBe('disabled');
    await tool('kb_capture', { type: 'learning', title: 'Wombat burrow drainage', summary: 'Wombat burrows drain after rain.', source_files: ['src/a.ts'] });
    expect(await queryIds('wombat burrow')).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 1000));
    expect(hubRequests, 'a disabled embedder must not try to load a model').toBe(before);
    expectSameServer();
  });

  it('2. kb_setup with the default built-in name re-enables semantic search on the same process', async () => {
    hubServes = true;
    const before = hubRequests;
    const setup = await tool('kb_setup', { embedding_model: DEFAULT_EMBEDDING_PROFILE });
    expect(setup.isError, setup.text).toBe(false);
    expect(await queryIds('quokka lantern')).toContain(keywordId);
    const state = await embeddingState();
    expect(state.state).not.toBe('disabled');
    expect(state.modelId).toBe(PROFILE.modelId);
    // The re-enabled embedder really tries to load the model.
    await waitForState((s) => s !== 'idle', 60_000);
    expect(hubRequests).toBeGreaterThan(before);
    if (REAL_MODEL) {
      await waitForState((s) => s === 'ready', 120_000);
    } else {
      console.warn('[kb-embedding-switch-live-server-e2e] APRA_KB_EVAL_MODELS_DIR has no real default model: checked the download attempt, not a ready load');
    }
    expectSameServer();
  });

  it('3. the CLI verb, run while the server runs: shows, writes, refuses, keeps other keys', async () => {
    const show = cli([]);
    expect(show.status, show.stderr).toBe(0);
    expect(show.stdout.trim()).toBe(`KB embedding model: ${DEFAULT_EMBEDDING_PROFILE}`);

    // Extra keys (a hand edit; the resolved choice is unchanged).
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const extra = { ...config, tool_profile: 'full', bible: { autoCommit: false }, an_unknown_key: { keep: true } };
    fs.writeFileSync(configPath, JSON.stringify(extra, null, 2));

    const bad = fs.readFileSync(configPath);
    const unknown = cli(['no-such-model']);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toMatch(/unknown embedding model "no-such-model"; nothing was written/);
    expect(fs.readFileSync(configPath).equals(bad)).toBe(true);
    // kb_setup refuses a malformed value too, leaving the bytes as they were.
    for (const value of ['no-such-model', { id: 'acme/model', revision: 'main' }]) {
      const r = await tool('kb_setup', { embedding_model: value });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/embedding_model is not valid/);
      expect(fs.readFileSync(configPath).equals(bad)).toBe(true);
    }

    const off = cli(['none']);
    expect(off.status, off.stderr).toBe(0);
    expect(off.stdout).toMatch(new RegExp(`KB embedding model: ${DEFAULT_EMBEDDING_PROFILE} -> none`));
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8'))).toEqual({ ...extra, embedding: { ...extra.embedding, model: 'none' } });
    expectSameServer();
  });

  it('4. a CLI write reaches the already-running server on its next query, both ways, with no restart and no kb_setup', async () => {
    // Start from an enabled state, set over MCP.
    expect((await tool('kb_setup', { embedding_model: DEFAULT_EMBEDDING_PROFILE })).isError).toBe(false);
    expect((await embeddingState()).state).not.toBe('disabled');
    expectSameServer();

    const off = cli(['none']);
    expect(off.status, off.stderr).toBe(0);
    const before = hubRequests;
    expect(await queryIds('quokka lantern')).toContain(keywordId);
    expect((await embeddingState()).state).toBe('disabled');
    await new Promise((r) => setTimeout(r, 1000));
    expect(hubRequests, 'no model load after the CLI turned semantic search off').toBe(before);
    expectSameServer();

    const on = cli([DEFAULT_EMBEDDING_PROFILE]);
    expect(on.status, on.stderr).toBe(0);
    expect(await queryIds('quokka lantern')).toContain(keywordId);
    const state = await embeddingState();
    expect(state.state).not.toBe('disabled');
    expect(state.modelId).toBe(PROFILE.modelId);
    expectSameServer();
  });
});
