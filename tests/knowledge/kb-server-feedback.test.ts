import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi, inject } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { startKbServer } from '../../src/commands/kb-server.js';
import { resetKbProviders, getProjectSlug } from '../../src/services/knowledge/kb-providers.js';
import { getSelfKbProviders } from '../../src/services/knowledge/kb-self.js';
import { HttpKbProvider } from '../../src/services/knowledge/http-provider.js';
import { encryptPassword } from '../../src/utils/crypto.js';
import { FLEET_DIR } from '../../src/paths.js';
import { kbFeedback } from '../../src/tools/kb-feedback.js';
import { releaseFileDataDir, fileDataDirViolations } from '../helpers/file-kb-data-dir.js';
import { FLEET_DIR as ISOLATED_FLEET_DIR } from '../../src/paths.js';
import { KB_CONFIG_PATH as ISOLATED_KB_CONFIG_PATH } from '../../src/services/knowledge/kb-config.js';

// This file's OWN fleet data dir, claimed before any src module loads
// (src/paths.ts fixes FLEET_DIR at import). The per-run data dir tests/setup.ts
// provides is shared by every file of the run, and so is the KB config file
// in it (<data dir>/knowledge/config.json), which this file writes and the
// code under test reads.
const fileDataDir = await vi.hoisted(async () =>
  (await import('../helpers/file-kb-data-dir.js')).claimFileDataDir('kb-server-feedback'));
afterAll(() => releaseFileDataDir(fileDataDir));

// ISOLATION GUARD: fails if this suite reads the run-shared data dir again --
// the hoisted claim removed, moved below the imports (FLEET_DIR is then fixed
// to the shared dir), or the dir not unique to this file.
describe('isolation guard', () => {
  it('this suite reads its own fleet data dir and KB config file, not the run-shared ones', () => {
    expect(fileDataDirViolations({
      label: 'kb-server-feedback', claimed: fileDataDir, fleetDir: ISOLATED_FLEET_DIR,
      kbConfigPath: ISOLATED_KB_CONFIG_PATH, runSharedDir: inject('APRA_FLEET_TEST_DATA_DIR'),
    })).toEqual([]);
  });
});

// POST /api/kb/feedback on the bundled kb-server: a REAL startKbServer
// instance serving a real sqlite file, driven by the real kbFeedback tool
// through a real HttpKbProvider selected from an http config file.

const TOKEN = 'kb-server-feedback-test-token';
const KB_CONFIG_PATH = path.join(FLEET_DIR, 'knowledge', 'config.json');

let scratch: string;
let tokenFile: string;
let dbPath: string;
let server: http.Server | undefined;
let port = 0;
let savedConfig: string | null;
let folder: string;

// kb-server serves the project of its working folder and refuses any other
// X-KB-Project with 409, so it is started from the tool's checkout (same
// origin remote, same project slug) and raw calls name that project.
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

// Sends `raw` as the request body byte-for-byte (no JSON.stringify), so a
// malformed JSON body can reach the server.
function callRaw(method: string, urlPath: string, raw: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'X-KB-Project': getProjectSlug(folder),
      'Content-Length': Buffer.byteLength(raw).toString(),
    };
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method, headers, agent: false }, res => {
      let text = '';
      res.on('data', (c: Buffer) => { text += c.toString(); });
      res.on('end', () => resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : undefined }));
    });
    req.on('error', reject);
    req.write(raw);
    req.end();
  });
}

async function captureEntry(title: string): Promise<string> {
  const res = await call('POST', '/api/kb/capture', {
    type: 'learning', title, summary: `${title} summary for the feedback route test`,
    content: `${title} content`, source_files: ['src/widget.ts'], symbols: [], tags: [],
    content_hash: '', content_hash_type: 'sha256', flagged_for_review: false,
    author: 'test', source: 'doer', confidence: 'INFERRED',
  });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

function writeHttpConfig(): void {
  fs.mkdirSync(path.dirname(KB_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(KB_CONFIG_PATH, JSON.stringify(
    { provider: 'http', url: `http://127.0.0.1:${port}`, token_encrypted: encryptPassword(TOKEN) }, null, 2));
}

beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-server-feedback-'));
  tokenFile = path.join(scratch, 'token');
  fs.writeFileSync(tokenFile, TOKEN);
  dbPath = path.join(scratch, 'kb.db');
  folder = path.join(scratch, 'repo');
  fs.mkdirSync(path.join(folder, 'src'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'src', 'widget.ts'), 'export const widget = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: folder });
  execFileSync('git', ['remote', 'add', 'origin', 'https://example.test/kb-server-feedback.git'], { cwd: folder });
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
  writeHttpConfig();
});

afterEach(async () => {
  await stop();
  resetKbProviders();
});

describe('kb-server POST /api/kb/feedback', () => {
  it('kb_feedback over an http config marks the entry stale and flagged, confidence unchanged', async () => {
    const id = await captureEntry('Online feedback entry');
    const out = JSON.parse(await kbFeedback({ id, reason: 'Wrong in practice.', role: 'reviewer' }, { folder }));
    expect(out).toEqual({ id, stale: true, flagged_for_review: true, confidence: 'INFERRED' });
    const gone = await call('GET', `/api/kb/query?query=${encodeURIComponent('Online feedback entry')}&confidence=INFERRED`);
    expect((gone.body.results as any[]).some(r => r.id === id)).toBe(false); // stale entries are excluded by default
  });

  it('a feedback while the server is down is E-KB-HTTP-UNREACHABLE and is not applied when the server starts again', async () => {
    const id = await captureEntry('Unsent feedback entry');
    const providers = await getSelfKbProviders({ folder });
    const provider = providers.project as HttpKbProvider;
    expect(provider).toBeInstanceOf(HttpKbProvider);
    const dead = port;
    await stop();
    await expect(kbFeedback({ id, reason: 'Stale advice.', role: 'planner' }, { folder }))
      .rejects.toMatchObject({ code: 'E-KB-HTTP-UNREACHABLE' });

    // Restart on the same port, same database: nothing was kept to replay,
    // so the entry is untouched until the caller repeats the feedback.
    port = dead;
    await listen();
    await provider.query({ query: 'anything' });
    const kept = await call('GET', `/api/kb/query?query=${encodeURIComponent('Unsent feedback entry')}&confidence=INFERRED`);
    expect((kept.body.results as any[]).some(r => r.id === id)).toBe(true);

    await kbFeedback({ id, reason: 'Stale advice.', role: 'planner' }, { folder });
    const gone = await call('GET', `/api/kb/query?query=${encodeURIComponent('Unsent feedback entry')}&confidence=INFERRED`);
    expect((gone.body.results as any[]).some(r => r.id === id)).toBe(false);
  });

  it('an unknown id returns 404 ENTRY_NOT_FOUND', async () => {
    const res = await call('POST', '/api/kb/feedback', { id: 'no-such-entry', reason: 'x', role: 'doer' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ENTRY_NOT_FOUND');
  });

  it('a missing reason is a 400 BAD_REQUEST', async () => {
    const res = await call('POST', '/api/kb/feedback', { id: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });

  // A body that is not JSON is the caller's fault on every JSON route: the
  // server's outer catch maps the SyntaxError to 400 BAD_REQUEST, never to
  // 500 INTERNAL_ERROR.
  it.each(['/api/kb/feedback', '/api/kb/capture'])('a malformed JSON body to POST %s is a 400 BAD_REQUEST, not a 500', async route => {
    const res = await callRaw('POST', route, '{"id": "x", "reason": ');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Request body is not valid JSON', code: 'BAD_REQUEST' });
  });
});
