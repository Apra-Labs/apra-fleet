import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { startKbServer } from '../../src/commands/kb-server.js';
import { resetKbProviders, getProjectSlug, getKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { HttpKbProvider } from '../../src/services/knowledge/http-provider.js';
import { encryptPassword } from '../../src/utils/crypto.js';
import { FLEET_DIR } from '../../src/paths.js';

// POST /api/kb/withdraw on the bundled kb-server: a REAL startKbServer
// instance serving a real sqlite file (SqliteProvider.applyBibleWithdrawal),
// driven by raw requests and by a real HttpKbProvider selected from an http
// config file. Its own file: kb-server's per-IP rate limit is per process.
//
// FALSIFICATION: on a tree without the route the server answers 404 to
// POST /api/kb/withdraw and its capabilities do not list withdraw, so every
// test below fails (checked by running this file against the previous commit's
// src/commands/kb-server.ts and src/services/knowledge/http-provider.ts).

const TOKEN = 'kb-server-withdraw-test-token';
const KB_CONFIG_PATH = path.join(FLEET_DIR, 'knowledge', 'config.json');
const PROMOTE_REASON = 'Checked against src/widget.ts: the widget is exported as described.';
const NOTE = 'the cited guard was removed when the reader was rewritten';
const LONG_AGO = '2000-01-01T00:00:00.000Z';

let scratch: string;
let tokenFile: string;
let dbPath: string;
let server: http.Server | undefined;
let port = 0;
let savedConfig: string | null;
let folder: string;

async function listen(): Promise<void> {
  const cwd = process.cwd();
  process.chdir(folder);
  try {
    server = await startKbServer(port, false, dbPath, tokenFile);
  } finally {
    process.chdir(cwd);
  }
  port = (server.address() as AddressInfo).port;
}

function stop(): Promise<void> {
  const s = server;
  server = undefined;
  if (!s) return Promise.resolve();
  return new Promise<void>(resolve => { s.close(() => resolve()); s.closeAllConnections(); });
}

function call(method: string, urlPath: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'X-KB-Project': getProjectSlug(folder),
    };
    if (data) headers['Content-Length'] = Buffer.byteLength(data).toString();
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method, headers, agent: false }, res => {
      let raw = '';
      res.on('data', (c: Buffer) => { raw += c.toString(); });
      res.on('end', () => resolve({ status: res.statusCode!, body: raw ? JSON.parse(raw) : undefined }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function captureInferred(title: string): Promise<string> {
  const res = await call('POST', '/api/kb/capture', {
    type: 'knowledge', title, summary: `${title} summary for the withdraw route test`,
    content: `${title} content`, source_files: ['src/widget.ts'], symbols: [], tags: [],
    content_hash: '', content_hash_type: 'sha256', flagged_for_review: false,
    author: 'test', source: 'doer', confidence: 'INFERRED',
  });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function confirmedEntry(title: string): Promise<string> {
  const id = await captureInferred(title);
  const promoted = await call('POST', '/api/kb/promote', { id, reason: PROMOTE_REASON });
  expect(promoted.body).toEqual({ id, previous_confidence: 'INFERRED', new_confidence: 'CONFIRMED' });
  return id;
}

async function entryOf(id: string): Promise<{ confidence: string; content: string }> {
  const res = await call('GET', `/api/kb/query?ids=${encodeURIComponent(JSON.stringify([id]))}&confidence=CONFIRMED,INFERRED,UNVERIFIED&include_stale=true`);
  expect(res.status).toBe(200);
  const hit = (res.body.results as Array<{ id: string; confidence: string; content: string }>).find(r => r.id === id);
  expect(hit, `entry ${id} not returned`).toBeDefined();
  return hit!;
}

function withdraw(withdrawals: unknown): Promise<{ status: number; body: any }> {
  return call('POST', '/api/kb/withdraw', { withdrawals });
}

beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-server-withdraw-'));
  tokenFile = path.join(scratch, 'token');
  fs.writeFileSync(tokenFile, TOKEN);
  dbPath = path.join(scratch, 'kb.db');
  folder = path.join(scratch, 'repo');
  fs.mkdirSync(path.join(folder, 'src'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'src', 'widget.ts'), 'export const widget = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: folder });
  execFileSync('git', ['remote', 'add', 'origin', 'https://example.test/kb-server-withdraw.git'], { cwd: folder });
  savedConfig = fs.existsSync(KB_CONFIG_PATH) ? fs.readFileSync(KB_CONFIG_PATH, 'utf-8') : null;
});

afterAll(async () => {
  await stop();
  resetKbProviders();
  if (savedConfig === null) fs.rmSync(KB_CONFIG_PATH, { force: true });
  else fs.writeFileSync(KB_CONFIG_PATH, savedConfig);
  fs.rmSync(scratch, { recursive: true, force: true });
});

beforeEach(async () => {
  resetKbProviders();
  await listen();
  fs.mkdirSync(path.dirname(KB_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(KB_CONFIG_PATH, JSON.stringify(
    { provider: 'http', url: `http://127.0.0.1:${port}`, token_encrypted: encryptPassword(TOKEN) }, null, 2));
});

afterEach(async () => {
  await stop();
  resetKbProviders();
});

describe('kb-server POST /api/kb/withdraw', () => {
  it('lists withdraw in GET /api/kb/capabilities', async () => {
    const res = await call('GET', '/api/kb/capabilities');
    expect(res.status).toBe(200);
    expect(res.body.routes).toContain('withdraw');
  });

  it('applies the one re-promotion rule: a tombstone older than the promotion leaves it CONFIRMED, a newer one lowers it', async () => {
    const id = await confirmedEntry('Withdraw re-promotion rule');
    const older = await withdraw([{ id, at: LONG_AGO, reason: 'withdrawn', note: NOTE }]);
    expect(older.status).toBe(200);
    expect(older.body).toEqual({ results: [{ id, outcome: 'repromoted' }] });
    expect((await entryOf(id)).confidence).toBe('CONFIRMED');

    // A future time is clamped to now, so it postdates the promotion.
    const newer = await withdraw([{ id, at: '2999-01-01T00:00:00.000Z', reason: 'withdrawn', note: NOTE, evidence_files: ['src/widget.ts'] }]);
    expect(newer.body).toEqual({ results: [{ id, outcome: 'withdrawn' }] });
    const after = await entryOf(id);
    expect(after.confidence).toBe('INFERRED');
    expect(after.content).toContain('withdrawn in the project bible: ' + NOTE);
    expect(after.content).toContain('evidence: src/widget.ts');
  });

  it('is idempotent and never raises confidence: a repeat and an INFERRED entry answer not_confirmed; unknown is not_found', async () => {
    const id = await confirmedEntry('Withdraw idempotent');
    const inferred = await captureInferred('Withdraw never raises');
    const now = new Date().toISOString();
    const first = await withdraw([{ id, at: now, reason: 'withdrawn' }]);
    expect(first.body.results).toEqual([{ id, outcome: 'withdrawn' }]);
    const content = (await entryOf(id)).content;

    const again = await withdraw([
      { id, at: now, reason: 'withdrawn' },
      { id: inferred, at: LONG_AGO, reason: 'withdrawn' },
      { id: 'no-such-entry', at: now, reason: 'withdrawn' },
    ]);
    expect(again.status).toBe(200);
    expect(again.body.results).toEqual([
      { id, outcome: 'not_confirmed' },
      { id: inferred, outcome: 'not_confirmed' },
      { id: 'no-such-entry', outcome: 'not_found' },
    ]);
    expect(await entryOf(id)).toMatchObject({ confidence: 'INFERRED', content });
    expect((await entryOf(inferred)).confidence).toBe('INFERRED');
  });

  it('a demoted tombstone uses the bible demotion note; evidence is optional', async () => {
    const id = await confirmedEntry('Withdraw demoted reason');
    const res = await withdraw([{ id, at: new Date().toISOString(), reason: 'demoted' }]);
    expect(res.body.results).toEqual([{ id, outcome: 'withdrawn' }]);
    expect((await entryOf(id)).content).toContain('[Demoted: demoted in the project bible -- ');
  });

  it('refuses an absolute or \'..\' evidence path with 422 E-DEMOTE-EVIDENCE-UNRESOLVED and applies nothing', async () => {
    const id = await confirmedEntry('Withdraw bad evidence');
    const now = new Date().toISOString();
    for (const bad of ['/etc/passwd', 'C:\\Windows\\win.ini', '\\\\host\\share\\x.ts', '../outside.ts', 'src/../../outside.ts']) {
      const res = await withdraw([{ id, at: now, reason: 'withdrawn', evidence_files: ['src/widget.ts', bad] }]);
      expect(res.status, bad).toBe(422);
      expect(res.body.code, bad).toBe('E-DEMOTE-EVIDENCE-UNRESOLVED');
      expect(res.body.error, bad).toContain(bad);
    }
    // Unresolved but repo-relative evidence is accepted (a cited file may be gone).
    expect((await entryOf(id)).confidence).toBe('CONFIRMED');
    const ok = await withdraw([{ id, at: now, reason: 'withdrawn', evidence_files: ['src/deleted-since.ts'] }]);
    expect(ok.body.results).toEqual([{ id, outcome: 'withdrawn' }]);
  });

  it('answers 400 BAD_REQUEST for a malformed body', async () => {
    const at = new Date().toISOString();
    for (const withdrawals of [
      undefined,
      'x',
      [{ at, reason: 'withdrawn' }],
      [{ id: 'x', reason: 'withdrawn' }],
      [{ id: 'x', at: 'not a time', reason: 'withdrawn' }],
      [{ id: 'x', at }],
      [{ id: 'x', at, reason: 'withdrawn', note: 3 }],
      [{ id: 'x', at, reason: 'withdrawn', evidence_files: [1] }],
    ]) {
      const res = await withdraw(withdrawals);
      expect(res.status, JSON.stringify(withdrawals)).toBe(400);
      expect(res.body.code).toBe('BAD_REQUEST');
    }
  });

  it('HttpKbProvider.withdraw sends the tombstones to this server and returns its outcomes', async () => {
    const id = await confirmedEntry('Withdraw through the provider');
    const provider = (await getKbProviders(folder)).project;
    expect(provider).toBeInstanceOf(HttpKbProvider);
    const out = await (provider as HttpKbProvider).withdraw([
      { id, at: new Date().toISOString(), reason: 'withdrawn', note: NOTE, evidence_files: ['src/widget.ts'] },
      { id: 'no-such-entry', at: LONG_AGO, reason: 'withdrawn' },
    ]);
    expect(out).toEqual([{ id, outcome: 'withdrawn' }, { id: 'no-such-entry', outcome: 'not_found' }]);
    expect((await entryOf(id)).confidence).toBe('INFERRED');
  });
});
