import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';

// Member bible view end to end over REAL HTTP: the real createHttpTransport,
// registerAllTools per session, a real MCP SDK client, real kb_* handlers.
// Same pattern as kb-self-resolution.test.ts.
//
// Two members of ONE repository (same origin remote, so they share one per-repo
// KB) have checkouts whose .fleet/kb-canonical.json differ, as two branches
// would. MEMBER-session reads come from each member's own checkout bible
// (src/services/knowledge/member-bible-view.ts); FULL sessions keep the
// per-repo DB.
//
// Isolation: tests/setup.ts points APRA_FLEET_DATA_DIR at a per-run temp dir
// (every kb.sqlite lands there); backupAndResetRegistry/restoreRegistry leave
// the registry as found; checkouts live under one scratch root removed in
// afterAll; the origin remote is unique per run so the per-repo KB is fresh.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpTransport, type HttpTransportHandle } from '../../src/services/http-transport.js';
import { registerAllTools } from '../../src/services/tool-registry.js';
import { addAgent } from '../../src/services/registry.js';
import { getKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { requireSqliteProject } from '../../src/services/knowledge/require-sqlite-project.js';
import { importBibleEntries } from '../../src/services/knowledge/bible-import.js';
import {
  memberBiblePath,
  memberBibleViewLoadCount,
  resetMemberBibleViews,
} from '../../src/services/knowledge/member-bible-view.js';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry, memberSecretRequestInit } from '../test-helpers.js';

const RECONNECT = { maxRetries: 0, maxReconnectionDelay: 100, initialReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 };
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const ORIGIN = `https://example.test/kb-bible-view-${RUN}.git`;

let scratch: string;
let handle: HttpTransportHandle;
const clients: Client[] = [];
const members: Record<'a' | 'b', string> = { a: '', b: '' };
const folders: Record<'a' | 'b', string> = { a: '', b: '' };

function bibleEntry(id: string, title: string, confidence = 'CONFIRMED'): Record<string, unknown> {
  return {
    id, type: 'knowledge', title,
    summary: `${title}; recorded in the sprocket checkout bible as ${id}.`,
    // A symbol per entry: AUDN links two entries sharing BOTH a symbol and a
    // file under a fresh id (kb_import semantics), which would hide bible ids.
    symbols: [`sprocket_${id.replace(/-/g, '_')}`], source_files: ['src/sprocket.ts'],
    confidence, updated_at: '2026-09-01T00:00:00.000Z',
  };
}

function checkout(name: string): string {
  const dir = path.join(scratch, name);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.fleet'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'sprocket.ts'), 'export const sprocket = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', ORIGIN], { cwd: dir });
  return dir;
}

function writeBible(folder: string, entries: unknown[]): void {
  fs.writeFileSync(memberBiblePath(folder), JSON.stringify({ version: 2, entries }, null, 2), 'utf-8');
}

async function connect(member?: string): Promise<Client> {
  const url = new URL(`http://127.0.0.1:${handle.port}/mcp`);
  if (member) url.searchParams.set('member', member);
  const client = new Client({ name: 'kb-bible-view-e2e', version: '1.0.0' }, { capabilities: {} });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(url, { reconnectionOptions: RECONNECT, requestInit: memberSecretRequestInit() }));
  return client;
}

async function callJson(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  const text = ((result.content as Array<{ text?: string }>) ?? []).map(c => c.text ?? '').join('\n');
  expect(result.isError === true, `${name} failed: ${text}`).toBe(false);
  return JSON.parse(text);
}

const ids = (rows: Array<{ id: string }>) => rows.map(r => r.id).sort();
const queryIds = async (c: Client) => ids((await callJson(c, 'kb_query', { query: 'sprocket' })).l1_results);
const listIds = async (c: Client) => ids((await callJson(c, 'kb_list')).results);

beforeAll(async () => {
  backupAndResetRegistry();
  resetMemberBibleViews();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-bible-view-e2e-'));
  folders.a = checkout('checkout-a');
  folders.b = checkout('checkout-b');
  // Two branches of one repo: shared entry plus one branch-only entry each.
  writeBible(folders.a, [bibleEntry('shared-1', 'Sprocket gear ratio is fixed'), bibleEntry('a-only', 'Sprocket alpha branch teeth count')]);
  writeBible(folders.b, [bibleEntry('shared-1', 'Sprocket gear ratio is fixed'), bibleEntry('b-only', 'Sprocket beta branch chain pitch')]);
  for (const key of ['a', 'b'] as const) {
    const agent = makeTestLocalAgent({ friendlyName: `kb-bible-view-${key}-${RUN}`, workFolder: folders[key] });
    addAgent(agent);
    members[key] = agent.id;
  }
  // Seed the shared per-repo DB with an entry no bible carries.
  const providers = await getKbProviders(folders.a);
  await importBibleEntries(requireSqliteProject(providers.project, 'test'), [bibleEntry('repo-db-only', 'Sprocket per repo database note')]);
  handle = await createHttpTransport({ registerTools: registerAllTools, preferredPort: 0 });
}, 30_000);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  for (const c of clients.splice(0)) { try { await c.close(); } catch { /* ignore */ } }
  try { await handle?.close(); } catch { /* ignore */ }
  resetMemberBibleViews();
  restoreRegistry();
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('member bible view over real HTTP', () => {
  it('1. two members of one repository on different branches see different CONFIRMED sets (kb_query, kb_list)', async () => {
    const a = await connect(members.a);
    const b = await connect(members.b);
    expect(await queryIds(a)).toEqual(['a-only', 'shared-1']);
    expect(await queryIds(b)).toEqual(['b-only', 'shared-1']);
    expect(await listIds(a)).toEqual(['a-only', 'shared-1']);
    expect(await listIds(b)).toEqual(['b-only', 'shared-1']);
  });

  it('2. replacing a member\'s bible (a pull) is reflected on the next read without a restart; an untouched bible is not reloaded', async () => {
    const a = await connect(members.a);
    const biblePath = memberBiblePath(folders.a);
    await queryIds(a);
    const loadsBefore = memberBibleViewLoadCount(biblePath);
    expect(loadsBefore).toBeGreaterThanOrEqual(1);

    // Untouched: repeated reads reuse the view.
    await queryIds(a);
    await listIds(a);
    expect(memberBibleViewLoadCount(biblePath)).toBe(loadsBefore);

    // Simulated pull: new content; the mtime is pushed forward so the change is
    // visible even on a filesystem with coarse timestamps.
    writeBible(folders.a, [bibleEntry('shared-1', 'Sprocket gear ratio is fixed'), bibleEntry('a-pulled', 'Sprocket alpha branch pulled lubrication rule')]);
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(biblePath, later, later);

    expect(await queryIds(a)).toEqual(['a-pulled', 'shared-1']);
    expect(memberBibleViewLoadCount(biblePath)).toBe(loadsBefore + 1);
    // Member B's view is independent and untouched.
    expect(await queryIds(await connect(members.b))).toEqual(['b-only', 'shared-1']);
  });

  it('3. after a server restart the first read rebuilds the view from the bible', async () => {
    const biblePath = memberBiblePath(folders.b);
    await handle.close();
    resetMemberBibleViews();
    handle = await createHttpTransport({ registerTools: registerAllTools, preferredPort: 0 });
    expect(memberBibleViewLoadCount(biblePath)).toBe(0);

    const b = await connect(members.b);
    expect(await queryIds(b)).toEqual(['b-only', 'shared-1']);
    expect(memberBibleViewLoadCount(biblePath)).toBe(1);
  });

  it('4. kb_stats in a MEMBER session reports the bible\'s CONFIRMED entry count', async () => {
    writeBible(folders.b, [
      bibleEntry('shared-1', 'Sprocket gear ratio is fixed'),
      bibleEntry('b-only', 'Sprocket beta branch chain pitch'),
      bibleEntry('b-third', 'Sprocket beta branch idler offset'),
      bibleEntry('b-inferred', 'Sprocket beta branch unconfirmed hunch', 'INFERRED'),
    ]);
    const later = new Date(Date.now() + 120_000);
    fs.utimesSync(memberBiblePath(folders.b), later, later);
    const stats = await callJson(await connect(members.b), 'kb_stats');
    expect(stats.totals.by_confidence.CONFIRMED).toBe(3);
    expect(stats.bible).toMatchObject({ present: true, entries: 4 });
  });

  it('5. a FULL session still reads the per-repo DB: its entry is visible to FULL and not to the member', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(folders.a);
    const full = await connect();
    const fullIds = await queryIds(full);
    expect(fullIds).toContain('repo-db-only');
    expect(fullIds).not.toContain('a-pulled');

    const memberIds = await queryIds(await connect(members.a));
    expect(memberIds).not.toContain('repo-db-only');
    expect(memberIds).toContain('a-pulled');
  });
});
