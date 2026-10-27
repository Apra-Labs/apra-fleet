import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addAgent } from '../../src/services/registry.js';
import { runWithSessionMember } from '../../src/services/tool-scope.js';
import { resetKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { resetMemberBibleViews } from '../../src/services/knowledge/member-bible-view.js';
import { kbSetup } from '../../src/tools/kb-setup.js';
import { kbQuery } from '../../src/tools/kb-query.js';
import { FLEET_DIR } from '../../src/paths.js';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from '../test-helpers.js';

// kb_query's unsplit L2 fetch asks the project provider for the top five L1
// ids (GET /api/kb/query?ids=[...]) and must keep only those ids, whatever the
// server answers. The KB server here is a local http.Server stand-in that
// IGNORES the ids parameter: it answers every query, the L2 one included, with
// its whole listing, and adds an entry to the L2 answer that no L1 result
// carries. Without the fleet-side id filter both the sixth L1 row and that
// injected entry would land in l2_expanded.
//
// The read is a MEMBER CONFIRMED-only (default) kb_query under the http
// provider, which takes the unsplit path (getSelfReadKb serverRecall).
//
// What is real: the kb_query handler, kb-self routing, kb_setup, the KB config,
// HttpKbProvider, and a local http.Server. No vi.mock. The token comes from an
// env var or a gitignored fixture, never source. Isolation: tests/setup.ts
// points APRA_FLEET_DATA_DIR at a per-run temp dir; the registry is backed up
// and restored; the checkout lives under one mkdtemp root removed in afterAll.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_ENV_VAR = 'APRA_FLEET_TEST_KB_HTTP_TOKEN';
const TOKEN_FIXTURE_PATH = path.join(__dirname, 'fixtures', 'kb-http-test-token.txt');

function loadTestToken(): string {
  const fromEnv = process.env[TOKEN_ENV_VAR];
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  if (fs.existsSync(TOKEN_FIXTURE_PATH)) {
    const fromFile = fs.readFileSync(TOKEN_FIXTURE_PATH, 'utf-8').trim();
    if (fromFile.length > 0) return fromFile;
  }
  throw new Error(`Missing test KB token: set ${TOKEN_ENV_VAR} or provide a non-empty ${TOKEN_FIXTURE_PATH}`);
}

const KB_CONFIG_PATH = path.join(FLEET_DIR, 'knowledge', 'config.json');
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const INJECTED_ID = 'injected-not-requested';

type ServerEntry = Record<string, unknown> & { id: string };

let server: http.Server | null = null;
let token = '';
let root: string;
let memberId: string;
const idsParams: string[] = [];

function entry(id: string): ServerEntry {
  const now = new Date().toISOString();
  return {
    id, type: 'knowledge', title: `Sprocket fact ${id}`, summary: `Sprocket fact ${id}: the sprocket stage batches work.`,
    content: `Sprocket fact ${id} full content.`, source_files: ['src/sprocket.ts'], symbols: ['sprocket'], tags: [],
    confidence: 'CONFIRMED', stale: false, flagged_for_review: false, contradiction_of: null,
    created_at: now, updated_at: now,
  };
}

// Six rows: one more than kb_query expands to L2.
const LISTING = ['s1', 's2', 's3', 's4', 's5', 's6'].map(entry);

function startServer(): Promise<number> {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://stand-in');
    let status = 404;
    let payload: unknown = { error: 'not found' };
    if (req.headers.authorization !== `Bearer ${token}`) {
      status = 401;
      payload = { error: 'Unauthorized' };
    } else if (req.method === 'GET' && url.pathname === '/api/kb/query') {
      const ids = url.searchParams.get('ids');
      // The ids parameter is recorded but ignored: an L2 request gets the whole
      // listing plus an entry it never asked for.
      if (ids !== null) idsParams.push(ids);
      const results = ids !== null ? [...LISTING, entry(INJECTED_ID)] : LISTING;
      status = 200;
      payload = { results, total: results.length };
    }
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  return new Promise<number>((resolve, reject) => {
    server!.listen(0, '127.0.0.1', () => {
      const address = server!.address();
      if (address === null || typeof address === 'string') reject(new Error('kb-query-l2-ids-http: stand-in did not bind a TCP port'));
      else resolve(address.port);
    });
  });
}

beforeAll(async () => {
  token = loadTestToken();
  backupAndResetRegistry();
  resetMemberBibleViews();
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();

  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-query-l2-ids-http-'));
  const repo = path.join(root, 'checkout');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'sprocket.ts'), 'export const sprocket = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', `https://example.test/kb-query-l2-ids-http-${RUN}.git`], { cwd: repo });

  const agent = makeTestLocalAgent({ friendlyName: `kb-l2-ids-http-${RUN}`, workFolder: repo });
  addAgent(agent);
  memberId = agent.id;

  const port = await startServer();
  const setup = JSON.parse(await kbSetup({ provider: 'http', remote: `http://127.0.0.1:${port}`, token }, { folder: repo }));
  expect(setup.success).toBe(true);
});

beforeEach(() => {
  idsParams.length = 0;
});

afterAll(async () => {
  const current = server;
  server = null;
  if (current) await new Promise<void>(resolve => current.close(() => resolve()));
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();
  resetMemberBibleViews();
  restoreRegistry();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('kb_query unsplit L2 fetch over http keeps only the requested ids', () => {
  it('drops entries a server that ignores ids returns beyond the top five L1 ids', async () => {
    const out = JSON.parse(await runWithSessionMember(memberId, () => kbQuery({ query: 'sprocket' }))) as {
      l1_results: Array<{ id: string }>; l2_expanded: Array<{ id: string; content: string }>;
    };
    const top5 = out.l1_results.slice(0, 5).map(e => e.id);
    expect(out.l1_results.map(e => e.id)).toEqual(LISTING.map(e => e.id));
    // The L2 request named exactly the top five ids, and the server ignored it.
    expect(idsParams).toEqual([JSON.stringify(top5)]);
    expect(out.l2_expanded.map(e => e.id)).toEqual(top5);
    expect(out.l2_expanded.map(e => e.id)).not.toContain(INJECTED_ID);
    expect(out.l2_expanded.map(e => e.id)).not.toContain('s6');
    // Still the L2 copy, with full content.
    expect(out.l2_expanded[0].content).toBe('Sprocket fact s1 full content.');
  });
});
