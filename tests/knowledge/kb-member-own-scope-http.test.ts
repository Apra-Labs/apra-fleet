import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';

// Member-tagged writes and own-scope operations end to end over REAL HTTP: the
// real createHttpTransport, registerAllTools per session, a real MCP SDK
// client, real kb_* handlers. Same pattern as kb-member-bible-view-http.test.ts.
//
// Two members of ONE repository on ONE host (two checkouts, same origin remote,
// so they share one per-repo DB). Only the member:<uuid> own-scope rule keeps
// their unconfirmed captures apart.
//
// Isolation: tests/setup.ts points APRA_FLEET_DATA_DIR at a per-run temp dir
// (every kb.sqlite lands there); backupAndResetRegistry/restoreRegistry leave
// the registry as found; checkouts live under one scratch root removed in
// afterAll; the origin remote is unique per run so the per-repo DB is fresh.

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
import { resetMemberBibleViews } from '../../src/services/knowledge/member-bible-view.js';
import type { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry, memberSecretRequestInit } from '../test-helpers.js';

const RECONNECT = { maxRetries: 0, maxReconnectionDelay: 100, initialReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 };
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const ORIGIN = `https://example.test/kb-own-scope-${RUN}.git`;
const REASON = 'Verified against src/widget.ts: the widget stage batches work per tick.';

let scratch: string;
let handle: HttpTransportHandle;
let db: SqliteProvider;
const clients: Client[] = [];
const members: Record<'a' | 'b', string> = { a: '', b: '' };
const folders: Record<'a' | 'b', string> = { a: '', b: '' };

interface Row {
  id: string;
  confidence: string;
  tags: string;
  stale: number;
  flagged_for_review: number;
  superseded_at: string | null;
  content: string;
}

function rawDb(): { prepare(s: string): { get(...a: unknown[]): unknown } } {
  return (db as unknown as { getDb(): { prepare(s: string): { get(...a: unknown[]): unknown } } }).getDb();
}
const row = (id: string) => rawDb().prepare('SELECT * FROM entries WHERE id = ?').get(id) as Row | undefined;
const rowCount = () => (rawDb().prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number }).n;

function checkout(name: string): string {
  const dir = path.join(scratch, name);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'widget.ts'), 'export const widget = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', ORIGIN], { cwd: dir });
  return dir;
}

async function connect(member?: string): Promise<Client> {
  const url = new URL(`http://127.0.0.1:${handle.port}/mcp`);
  if (member) url.searchParams.set('member', member);
  const client = new Client({ name: 'kb-own-scope-e2e', version: '1.0.0' }, { capabilities: {} });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(url, { reconnectionOptions: RECONNECT, requestInit: memberSecretRequestInit() }));
  return client;
}

async function callRaw(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string }> {
  const result = await client.callTool({ name, arguments: args });
  const text = ((result.content as Array<{ text?: string }>) ?? []).map(c => c.text ?? '').join('\n');
  return { isError: result.isError === true, text };
}

async function callJson(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const { isError, text } = await callRaw(client, name, args);
  expect(isError, `${name} failed: ${text}`).toBe(false);
  return JSON.parse(text);
}

async function capture(client: Client, title: string, symbol: string): Promise<string> {
  const out = await callJson(client, 'kb_capture', {
    type: 'knowledge',
    title,
    summary: `${title}: the widget stage batches work per tick.`,
    content: `${title}: the widget stage batches work per tick, observed in src/widget.ts.`,
    source_files: ['src/widget.ts'],
    // Distinct symbols keep AUDN from linking the two members' captures.
    symbols: [symbol],
  });
  return out.id as string;
}

const inferredIds = async (c: Client) =>
  ((await callJson(c, 'kb_query', { query: 'widget', confidence: ['INFERRED'] })).l1_results as Array<{ id: string }>).map(r => r.id).sort();

let a: Client;
let b: Client;
let aEntry: string;
let bEntry: string;

beforeAll(async () => {
  backupAndResetRegistry();
  resetMemberBibleViews();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-own-scope-e2e-'));
  folders.a = checkout('checkout-a');
  folders.b = checkout('checkout-b');
  for (const key of ['a', 'b'] as const) {
    const agent = makeTestLocalAgent({ friendlyName: `kb-own-scope-${key}-${RUN}`, workFolder: folders[key] });
    addAgent(agent);
    members[key] = agent.id;
  }
  db = requireSqliteProject((await getKbProviders(folders.a)).project, 'test');
  handle = await createHttpTransport({ registerTools: registerAllTools, preferredPort: 0 });
  a = await connect(members.a);
  b = await connect(members.b);
  aEntry = await capture(a, 'Widget alpha batching fact', 'widgetAlpha');
  bEntry = await capture(b, 'Widget bravo batching fact', 'widgetBravo');
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

describe('member-tagged writes and own-scope operations over real HTTP', () => {
  it('1. kb_capture in a MEMBER session stores the entry in the per-repo DB tagged member:<caller uuid>', () => {
    // Both members share one per-repo DB (same origin): both rows are in it.
    expect(JSON.parse(row(aEntry)!.tags)).toEqual([`member:${members.a}`]);
    expect(JSON.parse(row(bEntry)!.tags)).toEqual([`member:${members.b}`]);
    expect(row(aEntry)!.confidence).toBe('INFERRED');
  });

  it('2. an INFERRED capture is returned to its own member\'s explicit INFERRED query and not to the other member on the same host', async () => {
    expect(await inferredIds(a)).toEqual([aEntry]);
    expect(await inferredIds(b)).toEqual([bEntry]);
  });

  it('3. kb_promote confirms an own entry; promoting another member\'s entry is a typed not-found and leaves it unchanged', async () => {
    const before = row(bEntry)!;
    const refused = await callRaw(a, 'kb_promote', { id: bEntry, reason: REASON });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(`Entry not found: ${bEntry}`);
    // Same shape as an id that never existed.
    const unknown = await callRaw(a, 'kb_promote', { id: 'no-such-entry', reason: REASON });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('Entry not found: no-such-entry');
    expect(row(bEntry)).toEqual(before);

    const promoted = await callJson(a, 'kb_promote', { id: aEntry, reason: REASON });
    expect(promoted).toMatchObject({ id: aEntry, previous_confidence: 'INFERRED', new_confidence: 'CONFIRMED' });
    expect(row(aEntry)!.confidence).toBe('CONFIRMED');
  });

  it('4. kb_feedback in a MEMBER session returns E-MEMBER-VIEW-READ-ONLY and changes nothing', async () => {
    const countBefore = rowCount();
    const before = row(bEntry)!;
    const res = await callRaw(b, 'kb_feedback', { id: bEntry, reason: 'This entry proved wrong in practice.', role: 'reviewer' });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('E-MEMBER-VIEW-READ-ONLY');
    expect(rowCount()).toBe(countBefore);
    expect(row(bEntry)).toEqual(before);
  });

  it('5. a FULL session still reads the per-repo DB: its explicit INFERRED read sees every member\'s capture', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(folders.a);
    const full = await connect();
    const list = await callJson(full, 'kb_list', { confidence: ['INFERRED', 'CONFIRMED'] });
    const fullIds = (list.results as Array<{ id: string }>).map(r => r.id);
    expect(fullIds).toEqual(expect.arrayContaining([aEntry, bEntry]));
  });

  it('6. kb_invalidate {ids} discards an own entry (row kept, superseded_at set); another member\'s id is not_found and unchanged', async () => {
    const aSecond = await capture(a, 'Widget alpha retry fact', 'widgetAlphaRetry');
    expect(await inferredIds(a)).toEqual([aSecond]);

    const own = await callJson(a, 'kb_invalidate', { ids: [aSecond] });
    expect(own).toMatchObject({ discarded: [aSecond], not_found: [], already_discarded: [] });
    expect(await inferredIds(a)).toEqual([]);
    expect(row(aSecond)).toBeDefined();
    expect(row(aSecond)!.superseded_at).not.toBeNull();

    const before = row(bEntry)!;
    const other = await callJson(a, 'kb_invalidate', { ids: [bEntry] });
    expect(other).toMatchObject({ discarded: [], not_found: [bEntry], already_discarded: [] });
    expect(row(bEntry)).toEqual(before);
    expect(await inferredIds(b)).toEqual([bEntry]);
  });
});
