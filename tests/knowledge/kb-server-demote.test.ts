import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { startKbServer } from '../../src/commands/kb-server.js';
import { resetKbProviders, getProjectSlug } from '../../src/services/knowledge/kb-providers.js';
import { KbHttpUnsupportedError } from '../../src/services/knowledge/http-provider.js';
import { encryptPassword } from '../../src/utils/crypto.js';
import { FLEET_DIR } from '../../src/paths.js';
import { kbDemote } from '../../src/tools/kb-demote.js';

// POST /api/kb/demote {id, reason, evidence_files} on the bundled kb-server:
// a REAL startKbServer instance serving a real sqlite file (backed by
// SqliteProvider.demote), driven by raw requests and by the real kb_demote
// tool through a real HttpKbProvider selected from an http config file.
// Its own file: kb-server's per-IP rate limit is per process, and
// kb-server.test.ts already spends most of it.

const TOKEN = 'kb-server-demote-test-token';
const KB_CONFIG_PATH = path.join(FLEET_DIR, 'knowledge', 'config.json');
const REASON = 'Re-checked against src/widget.ts: the claim holds for one tenant only.';
const PROMOTE_REASON = 'Checked against src/widget.ts: the widget is exported as described.';

let scratch: string;
let tokenFile: string;
let dbPath: string;
let server: http.Server | undefined;
let port = 0;
let savedConfig: string | null;
let folder: string;

// kb-server serves the project of its working folder, so it is started from
// the tool's checkout (same origin remote, same project slug).
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
    type: 'knowledge', title, summary: `${title} summary for the demote route test`,
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

async function confidenceOf(id: string): Promise<string> {
  const res = await call('GET', `/api/kb/query?ids=${encodeURIComponent(JSON.stringify([id]))}&confidence=CONFIRMED,INFERRED,UNVERIFIED&include_stale=true`);
  expect(res.status).toBe(200);
  const hit = (res.body.results as Array<{ id: string; confidence: string }>).find(r => r.id === id);
  expect(hit, `entry ${id} not returned`).toBeDefined();
  return hit!.confidence;
}

beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-server-demote-'));
  tokenFile = path.join(scratch, 'token');
  fs.writeFileSync(tokenFile, TOKEN);
  dbPath = path.join(scratch, 'kb.db');
  folder = path.join(scratch, 'repo');
  fs.mkdirSync(path.join(folder, 'src'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'src', 'widget.ts'), 'export const widget = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: folder });
  execFileSync('git', ['remote', 'add', 'origin', 'https://example.test/kb-server-demote.git'], { cwd: folder });
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

describe('kb-server POST /api/kb/demote', () => {
  it('lists demote in GET /api/kb/capabilities', async () => {
    const res = await call('GET', '/api/kb/capabilities');
    expect(res.status).toBe(200);
    expect(res.body.routes).toContain('demote');
  });

  it('lowers a CONFIRMED entry to INFERRED and answers {id, previous_confidence, new_confidence}', async () => {
    const id = await confirmedEntry('Demote happy path');
    const res = await call('POST', '/api/kb/demote', { id, reason: REASON, evidence_files: ['src/widget.ts'] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id, previous_confidence: 'CONFIRMED', new_confidence: 'INFERRED' });
    expect(await confidenceOf(id)).toBe('INFERRED');
  });

  it('answers 404 ENTRY_NOT_FOUND for an unknown id', async () => {
    const res = await call('POST', '/api/kb/demote', { id: 'no-such-entry', reason: REASON, evidence_files: ['src/widget.ts'] });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'ENTRY_NOT_FOUND', error: 'Entry not found: no-such-entry' });
  });

  it('answers 422 with the E-DEMOTE-* code for a demote refusal, and changes nothing', async () => {
    const inferred = await captureInferred('Demote refusal not confirmed');
    const notConfirmed = await call('POST', '/api/kb/demote', { id: inferred, reason: REASON, evidence_files: ['src/widget.ts'] });
    expect(notConfirmed.status).toBe(422);
    expect(notConfirmed.body.code).toBe('E-DEMOTE-NOT-CONFIRMED');

    const id = await confirmedEntry('Demote refusal confirmed');
    const shortReason = await call('POST', '/api/kb/demote', { id, reason: 'too short', evidence_files: ['src/widget.ts'] });
    expect(shortReason.status).toBe(422);
    expect(shortReason.body.code).toBe('E-DEMOTE-REASON-REQUIRED');

    const missingFile = await call('POST', '/api/kb/demote', { id, reason: REASON, evidence_files: ['src/no-such-file.ts'] });
    expect(missingFile.status).toBe(422);
    expect(missingFile.body.code).toBe('E-DEMOTE-EVIDENCE-UNRESOLVED');
    expect(await confidenceOf(id)).toBe('CONFIRMED');
  });

  it('rejects an absolute or \'..\' evidence path with 422 E-DEMOTE-EVIDENCE-UNRESOLVED, and changes nothing', async () => {
    const id = await confirmedEntry('Demote bad evidence paths');
    for (const bad of ['/etc/passwd', 'C:\\Windows\\win.ini', '\\\\host\\share\\x.ts', '../outside.ts', 'src/../../outside.ts']) {
      const res = await call('POST', '/api/kb/demote', { id, reason: REASON, evidence_files: ['src/widget.ts', bad] });
      expect(res.status, bad).toBe(422);
      expect(res.body.code, bad).toBe('E-DEMOTE-EVIDENCE-UNRESOLVED');
      expect(res.body.error, bad).toContain(bad);
    }
    expect(await confidenceOf(id)).toBe('CONFIRMED');
  });

  it('answers 400 BAD_REQUEST for a malformed body', async () => {
    for (const body of [
      { reason: REASON, evidence_files: ['src/widget.ts'] },
      { id: 'x', evidence_files: ['src/widget.ts'] },
      { id: 'x', reason: REASON },
      { id: 'x', reason: REASON, evidence_files: [1] },
    ]) {
      const res = await call('POST', '/api/kb/demote', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.code).toBe('BAD_REQUEST');
    }
  });

  it('the kb_demote tool over an http config demotes on this server; an unknown id is entry-not-found', async () => {
    const id = await confirmedEntry('Demote through the tool');
    const out = JSON.parse(await kbDemote({ id, reason: REASON, evidence_files: ['src/widget.ts'] }, { folder }));
    expect(out).toEqual({ id, previous_confidence: 'CONFIRMED', new_confidence: 'INFERRED' });
    expect(await confidenceOf(id)).toBe('INFERRED');

    const err = await kbDemote({ id: 'no-such-entry', reason: REASON, evidence_files: ['src/widget.ts'] }, { folder })
      .then(() => null, (e: unknown) => e);
    expect(err).not.toBeInstanceOf(KbHttpUnsupportedError);
    expect((err as Error).message).toMatch(/^Entry not found: no-such-entry \(the KB server answered HTTP 404/);
  });
});
