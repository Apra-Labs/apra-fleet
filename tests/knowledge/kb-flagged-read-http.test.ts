import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { addAgent } from '../../src/services/registry.js';
import { runWithSessionMember } from '../../src/services/tool-scope.js';
import { getKbProviders, getProjectSlug, resetKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { HttpKbProvider } from '../../src/services/knowledge/http-provider.js';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { memberBiblePath, resetMemberBibleViews } from '../../src/services/knowledge/member-bible-view.js';
import { startKbServer } from '../../src/commands/kb-server.js';
import { kbSetup } from '../../src/tools/kb-setup.js';
import { kbQuery } from '../../src/tools/kb-query.js';
import { FLEET_DIR } from '../../src/paths.js';
import { encryptPassword } from '../../src/utils/crypto.js';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from '../test-helpers.js';

// kb_query flagged_only over the http project provider, against fleet's own
// KB server (startKbServer, serving a scratch SQLite file).
//
// A MEMBER flagged read must keep main's SQLite behaviour exactly: it is
// answered from the member's checkout bible view plus the global KB, never by
// the KB server -- the server holds every member's captures at every tier,
// and a flagged listing carries no owner tag. A FULL (non-member) flagged read
// is answered by the server, which now honours flagged_only on the wire.
//
// The server is seeded through its own /api/kb/capture route: a user-directive
// capture becomes a flagged pending proposal, so each member gets one flagged
// entry, plus one plain (non-flagged) entry each. The checkout bible carries a
// plain entry and a directive, which the bible view loads as a flagged pending
// proposal, so the member flagged read has something to return.
//
// Real member session (runWithSessionMember), real git checkout, real
// kb_setup, real HttpKbProvider, real kb-server. No mocks.
//
// Isolation: tests/setup.ts points APRA_FLEET_DATA_DIR at a per-run temp dir
// (KB config, server token and every kb.sqlite land there); the registry is
// backed up and restored; the checkout and the server database live under one
// mkdtemp scratch root removed in afterAll. The server token is generated at
// run time, never stored in source.

const KB_CONFIG_PATH = path.join(FLEET_DIR, 'knowledge', 'config.json');
const TOKEN_PATH = path.join(FLEET_DIR, 'knowledge', 'kb-server.token');
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const OTHER_TAG = `member:other-${RUN}`;

type Entry = { id: string; tags?: string[]; flagged_for_review?: boolean; contradiction_of?: string | null };

let scratch: string;
let repo: string;
let memberId: string;
let ownTag: string;
let token: string;
let server: http.Server;
let port: number;
let projectSlug: string;
const seeded: Record<'ownFlagged' | 'otherFlagged' | 'ownPlain' | 'otherPlain', string> = {
  ownFlagged: '', otherFlagged: '', ownPlain: '', otherPlain: '',
};

const asMember = <T>(fn: () => Promise<T>): Promise<T> => runWithSessionMember(memberId, fn);
const isFlagged = (e: Entry) => Boolean(e.flagged_for_review || e.contradiction_of);
const idsOf = (rows: Entry[]) => rows.map(e => e.id).sort();

function bibleEntry(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, type: 'knowledge',
    title: `Sprocket bible fact ${id}`,
    summary: `Sprocket bible fact recorded in the checkout bible as ${id}.`,
    symbols: [], source_files: ['src/sprocket.ts'],
    confidence: 'CONFIRMED', updated_at: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

function post(urlPath: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path: urlPath, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data).toString(),
        Authorization: `Bearer ${token}`,
        'X-KB-Project': projectSlug,
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) as Record<string, unknown> }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function captureOnServer(type: 'knowledge' | 'user-directive', ownerTag: string, label: string): Promise<string> {
  const marker = crypto.randomUUID();
  const res = await post('/api/kb/capture', {
    type,
    title: `Sprocket server ${label} ${marker}`,
    summary: `Sprocket server entry ${label} ${marker} seeded for the flagged read test.`,
    content: `Sprocket server content ${label} ${marker}.`,
    source_files: type === 'knowledge' ? ['src/sprocket.ts'] : [],
    symbols: [], tags: [ownerTag], content_hash: '', content_hash_type: 'sha256',
    flagged_for_review: false, author: 'test', source: 'doer', confidence: 'INFERRED',
  });
  if (res.status !== 201) throw new Error(`seed capture ${label} failed: HTTP ${res.status} ${JSON.stringify(res.body)}`);
  return String(res.body.id);
}

async function configureHttp(): Promise<void> {
  const result = JSON.parse(await kbSetup({ provider: 'http', remote: `http://127.0.0.1:${port}`, token }, { folder: repo }));
  expect(result.success).toBe(true);
  expect((await getKbProviders(repo)).project).toBeInstanceOf(HttpKbProvider);
}

function useSqlite(): void {
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();
}

async function memberFlaggedRead(): Promise<Entry[]> {
  const out = JSON.parse(await asMember(() => kbQuery({ flagged_only: true })));
  return out.flagged_entries as Entry[];
}

beforeAll(async () => {
  backupAndResetRegistry();
  resetMemberBibleViews();
  useSqlite();

  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-flagged-read-http-'));
  repo = path.join(scratch, 'checkout');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.fleet'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'sprocket.ts'), 'export const sprocket = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', `https://example.test/kb-flagged-read-http-${RUN}.git`], { cwd: repo });
  fs.writeFileSync(memberBiblePath(repo), JSON.stringify({
    version: 2,
    entries: [
      bibleEntry('bible-plain'),
      bibleEntry('bible-directive', { type: 'user-directive', source_files: [] }),
    ],
  }), 'utf-8');
  projectSlug = getProjectSlug(repo);

  const agent = makeTestLocalAgent({ friendlyName: `kb-flagged-read-http-${RUN}`, workFolder: repo });
  addAgent(agent);
  memberId = agent.id;
  ownTag = `member:${memberId}`;

  // The server serves the project of its working folder, so it is started
  // from the member checkout (same origin remote, same project slug).
  token = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
  fs.writeFileSync(TOKEN_PATH, encryptPassword(token), { mode: 0o600 });
  const cwd = process.cwd();
  process.chdir(repo);
  try {
    server = await startKbServer(0, false, path.join(scratch, 'server-kb.sqlite'));
  } finally {
    process.chdir(cwd);
  }
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('kb-flagged-read-http: kb-server did not bind a TCP port');
  port = address.port;

  seeded.ownFlagged = await captureOnServer('user-directive', ownTag, 'own-flagged');
  seeded.otherFlagged = await captureOnServer('user-directive', OTHER_TAG, 'other-flagged');
  seeded.ownPlain = await captureOnServer('knowledge', ownTag, 'own-plain');
  seeded.otherPlain = await captureOnServer('knowledge', OTHER_TAG, 'other-plain');
});

afterEach(() => {
  useSqlite();
  resetMemberBibleViews();
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  useSqlite();
  resetMemberBibleViews();
  restoreRegistry();
  fs.rmSync(TOKEN_PATH, { force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('kb_query flagged_only over the http provider (real kb-server)', () => {
  it('a MEMBER flagged read never returns another member\'s entries or non-flagged entries', async () => {
    await configureHttp();
    const flagged = await memberFlaggedRead();
    const ids = flagged.map(e => e.id);
    expect(flagged.filter(e => (e.tags ?? []).includes(OTHER_TAG))).toEqual([]);
    expect(ids).not.toContain(seeded.otherFlagged);
    expect(ids).not.toContain(seeded.otherPlain);
    expect(ids).not.toContain('bible-plain');
    expect(ids).not.toContain(seeded.ownPlain);
    expect(flagged.filter(e => !isFlagged(e))).toEqual([]);
    expect(ids).toContain('bible-directive');
  });

  it('the same MEMBER flagged read returns the same ids over SQLite and over http', async () => {
    useSqlite();
    const overSqlite = idsOf(await memberFlaggedRead());
    await configureHttp();
    const overHttp = idsOf(await memberFlaggedRead());
    expect(overSqlite).toContain('bible-directive');
    expect(overHttp).toEqual(overSqlite);
  });

  it('a FULL (non-member) flagged read over http returns only the server\'s flagged entries', async () => {
    await configureHttp();
    const out = JSON.parse(await kbQuery({ flagged_only: true }, { folder: repo }));
    const flagged = out.flagged_entries as Entry[];
    const ids = flagged.map(e => e.id);
    expect(ids).toEqual(expect.arrayContaining([seeded.ownFlagged, seeded.otherFlagged]));
    expect(ids).not.toContain(seeded.ownPlain);
    expect(ids).not.toContain(seeded.otherPlain);
    expect(flagged.filter(e => !isFlagged(e))).toEqual([]);
  });

  it('HttpKbProvider forwards flagged_only and the kb-server answers with flagged entries only', async () => {
    const provider = new HttpKbProvider(`http://127.0.0.1:${port}`, token, new SqliteProvider(':memory:'), { projectSlug });
    try {
      const result = await provider.query({ flagged_only: true, include_stale: true, limit: 100 });
      const ids = result.results.map(e => e.id);
      expect(ids).toEqual(expect.arrayContaining([seeded.ownFlagged, seeded.otherFlagged]));
      expect(ids).not.toContain(seeded.ownPlain);
      expect(ids).not.toContain(seeded.otherPlain);
      expect(result.results.filter(e => !isFlagged(e))).toEqual([]);
    } finally {
      provider.dispose();
    }
  });
});
