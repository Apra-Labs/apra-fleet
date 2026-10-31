import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

// fleet_status named-credential signals for an http-provider KB config: the
// secret name, whether it resolves (ok / missing / expired, metadata only, an
// expired record kept), when it was last written, the JWT exp if the value is
// a JWT (nothing else decoded), and the last successful / last rejected KB call
// of this process. A literal-token config gets the cannot-be-refreshed hint; a
// sqlite config gets no credential line at all.
//
// Real credential store and KB config under the per-run APRA_FLEET_DATA_DIR
// (tests/setup.ts); the KB scope root is redirected to a temp dir and member
// probes are stubbed, as in fleet-status-kb-health.test.ts. Call times are
// driven by a real HttpKbProvider against a local stub server.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fleetStatus, jwtExpiry, KB_LITERAL_TOKEN_HINT } from '../src/tools/check-status.js';
import { KB_CONFIG_PATH } from '../src/services/knowledge/kb-config.js';
import { HttpKbProvider } from '../src/services/knowledge/http-provider.js';
import { SqliteProvider } from '../src/services/knowledge/sqlite-provider.js';
import { resetKbHttpAuthState } from '../src/services/knowledge/kb-http-auth-state.js';
import { credentialSet, credentialDelete, lookupServerSecretMeta } from '../src/services/credential-store.js';
import { encryptPassword } from '../src/utils/crypto.js';
import { FLEET_DIR } from '../src/paths.js';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';

const kbRoot = { dir: '' };
vi.mock('../src/services/knowledge/kb-scopes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/knowledge/kb-scopes.js')>();
  return { ...actual, knowledgeRootDir: () => kbRoot.dir };
});

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: vi.fn().mockResolvedValue({ stdout: 'idle', stderr: '', code: 0 }),
    testConnection: vi.fn().mockResolvedValue({ ok: true, latencyMs: 5 }),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const NAME = `KB_STATUS_SECRET_${RUN.replace(/-/g, '_')}`;
const CANARY = `zq-canary-status-${RUN}`;
const SUB_CLAIM = `canary-sub-${RUN}`;
const EMAIL_CLAIM = `canary-${RUN}@example.test`;
const EXP = 2_000_000_000; // 2033-05-18T03:33:20.000Z

const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
// The signature segment carries the canary, so a leak of the whole token shows.
const JWT = `${b64u({ alg: 'RS256', typ: 'JWT' })}.${b64u({ sub: SUB_CLAIM, email: EMAIL_CLAIM, exp: EXP })}.${Buffer.from(CANARY).toString('base64url')}`;
const PLAIN = `${CANARY}-plain`;

let server: http.Server;
let kbUrl: string;
let accepted = PLAIN;
let savedConfig: string | null;
const outputs: string[] = [];

function writeConfig(cfg: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(KB_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(KB_CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
const refConfig = () => writeConfig({ provider: 'http', url: kbUrl, token_ref: `{{secret.${NAME}}}` });

async function status(): Promise<{ compact: string; json: { kbHealth?: { credential?: Record<string, unknown> } }; line: string | undefined }> {
  const compact = await fleetStatus({ format: 'compact' });
  const jsonText = await fleetStatus({ format: 'json' });
  outputs.push(compact, jsonText);
  const line = compact.split('\n').find(l => l.includes('kb credential:'));
  return { compact, json: JSON.parse(jsonText), line };
}

async function driveCapture(): Promise<void> {
  const provider = new HttpKbProvider(kbUrl, { secretName: NAME }, new SqliteProvider(':memory:'));
  try {
    await provider.capture({
      type: 'learning', title: 'Status gear', summary: 'Status gear capture for call times', content: 'x',
      source_files: ['src/gear.ts'], symbols: [], tags: [], content_hash: '', content_hash_type: 'sha256',
      flagged_for_review: false, author: 'test', source: 'session', confidence: 'INFERRED',
    });
  } catch {
    // a rejected call is expected in one case; the auth state records it
  } finally {
    provider.dispose();
  }
}

beforeAll(async () => {
  savedConfig = fs.existsSync(KB_CONFIG_PATH) ? fs.readFileSync(KB_CONFIG_PATH, 'utf-8') : null;
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.headers.authorization !== `Bearer ${accepted}`) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      res.writeHead(201);
      res.end(JSON.stringify({ id: 'srv-1', audn_decision: 'add' }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  kbUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  backupAndResetRegistry();
  // fleet_status renders nothing past "No members registered" without one.
  addAgent(makeTestAgent({ friendlyName: `kb-status-cred-${RUN}` }));
  kbRoot.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-status-cred-'));
  resetKbHttpAuthState();
  accepted = PLAIN;
  credentialSet(NAME, PLAIN, true, 'allow');
  refConfig();
});

afterEach(() => {
  credentialDelete(NAME);
  restoreRegistry();
  fs.rmSync(kbRoot.dir, { recursive: true, force: true });
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (savedConfig === null) fs.rmSync(KB_CONFIG_PATH, { force: true });
  else fs.writeFileSync(KB_CONFIG_PATH, savedConfig);
});

describe('fleet_status KB credential signals', () => {
  it('1a. secret ok: name, resolves ok, last written = created_at', async () => {
    const createdAt = (lookupServerSecretMeta(NAME) as { meta: { created_at: string } }).meta.created_at;
    const { json, line } = await status();
    expect(json.kbHealth?.credential).toMatchObject({
      kind: 'secret', url: kbUrl, secretName: NAME, resolves: 'ok', lastWritten: createdAt,
    });
    expect(line).toContain(`secret ${NAME}`);
    expect(line).toContain('resolves: ok');
    expect(line).toContain(`last written: ${createdAt}`);
  });

  it('1b. secret missing: resolves missing, last written never', async () => {
    credentialDelete(NAME);
    const { json, line } = await status();
    expect(json.kbHealth?.credential).toMatchObject({ resolves: 'missing', lastWritten: null, tokenExpiry: null });
    expect(line).toContain('resolves: missing');
    expect(line).toContain('last written: never');
  });

  it('1c. secret expired: resolves expired, and the record is still in the store afterwards', async () => {
    credentialSet(NAME, JWT, true, 'allow', '*', -60);
    const { json, line } = await status();
    expect(json.kbHealth?.credential).toMatchObject({ resolves: 'expired', tokenExpiry: null });
    expect(json.kbHealth?.credential?.lastWritten).toEqual(expect.any(String));
    expect(line).toContain('resolves: expired');
    expect(lookupServerSecretMeta(NAME).status).toBe('expired');
  });

  it('2a. JWT value: expiry is the decoded exp; no other claim appears', async () => {
    credentialSet(NAME, JWT, true, 'allow');
    const { json, compact } = await status();
    expect(json.kbHealth?.credential?.tokenExpiry).toBe('2033-05-18T03:33:20.000Z');
    expect(compact).toContain('token expiry: 2033-05-18T03:33:20.000Z');
    const both = compact + JSON.stringify(json);
    expect(both).not.toContain(SUB_CLAIM);
    expect(both).not.toContain(EMAIL_CLAIM);
  });

  it('2b. non-JWT value: expiry none', async () => {
    const { json, line } = await status();
    expect(json.kbHealth?.credential?.tokenExpiry).toBeNull();
    expect(line).toContain('token expiry: none');
    expect(jwtExpiry('a.b')).toBeNull();
    expect(jwtExpiry(`${b64u({})}.${b64u({ exp: 'soon' })}.sig`)).toBeNull();
    expect(jwtExpiry(`${b64u({})}.${b64u({ exp: EXP })}.sig`)).toBe('2033-05-18T03:33:20.000Z');
  });

  it('3. call times: never before any call; set after a successful and after a rejected call', async () => {
    let s = await status();
    expect(s.json.kbHealth?.credential).toMatchObject({ lastSuccessfulCall: null, lastRejectedCall: null });
    expect(s.line).toContain('last ok call: never | last rejected call: never');

    await driveCapture();
    s = await status();
    const okAt = s.json.kbHealth?.credential?.lastSuccessfulCall as string;
    expect(Date.parse(okAt)).not.toBeNaN();
    expect(s.json.kbHealth?.credential?.lastRejectedCall).toBeNull();
    expect(s.line).toContain(`last ok call: ${okAt}`);

    accepted = 'something-else';
    await driveCapture();
    s = await status();
    const rejectedAt = s.json.kbHealth?.credential?.lastRejectedCall as string;
    expect(Date.parse(rejectedAt)).not.toBeNaN();
    expect(s.json.kbHealth?.credential?.lastSuccessfulCall).toBe(okAt);
    expect(s.line).toContain(`last rejected call: ${rejectedAt}`);
  });

  it('4a. literal-token config: the cannot-be-refreshed hint line', async () => {
    writeConfig({ provider: 'http', url: kbUrl, token_encrypted: encryptPassword(PLAIN) });
    const { json, line } = await status();
    expect(json.kbHealth?.credential).toMatchObject({ kind: 'literal', hint: KB_LITERAL_TOKEN_HINT });
    expect(json.kbHealth?.credential).not.toHaveProperty('secretName');
    expect(line).toContain('cannot be refreshed');
    expect(line).toContain('{{secret.NAME}}');
  });

  it('4b. sqlite config: no credential line and no credential field', async () => {
    writeConfig({ provider: 'sqlite' });
    // A scope on disk, so the KB section renders its normal lines too.
    const p = new SqliteProvider(path.join(kbRoot.dir, 'githubcom-acme-gear', 'kb.sqlite'));
    fs.mkdirSync(path.join(kbRoot.dir, 'githubcom-acme-gear'), { recursive: true });
    await p.init();
    p.close();
    const { json, compact, line } = await status();
    expect(line).toBeUndefined();
    expect(compact).toContain('kb:');
    expect(json.kbHealth).toBeDefined();
    expect(json.kbHealth).not.toHaveProperty('credential');
  });

  it('4c. corrupt credentials.json: the line still renders with resolves unreadable, no file content shown', async () => {
    const credPath = path.join(process.env.APRA_FLEET_DATA_DIR ?? FLEET_DIR, 'credentials.json');
    const saved = fs.readFileSync(credPath, 'utf-8');
    const garbage = `{"version":"1.0","credentials":{ ${CANARY}-cipher`;
    try {
      fs.writeFileSync(credPath, garbage);
      const { json, compact, line } = await status();
      expect(json.kbHealth?.credential).toMatchObject({
        kind: 'secret', secretName: NAME, resolves: 'unreadable', lastWritten: null, tokenExpiry: null,
      });
      expect(line).toContain(`secret ${NAME} | resolves: unreadable`);
      expect(compact + JSON.stringify(json)).not.toContain(`${CANARY}-cipher`);
    } finally {
      fs.writeFileSync(credPath, saved);
    }
  });

  it('4d. value fails to decrypt: resolves unreadable, last written kept, no ciphertext shown', async () => {
    const credPath = path.join(process.env.APRA_FLEET_DATA_DIR ?? FLEET_DIR, 'credentials.json');
    const saved = fs.readFileSync(credPath, 'utf-8');
    const createdAt = (lookupServerSecretMeta(NAME) as { meta: { created_at: string } }).meta.created_at;
    const file = JSON.parse(saved);
    const enc: string = file.credentials[NAME].encryptedValue;
    // Flip the auth tag so the GCM decrypt throws.
    const [iv, tag, body] = enc.split(':');
    const badTag = (tag[0] === '0' ? '1' : '0') + tag.slice(1);
    file.credentials[NAME].encryptedValue = `${iv}:${badTag}:${body}`;
    try {
      fs.writeFileSync(credPath, JSON.stringify(file));
      const { json, compact, line } = await status();
      expect(json.kbHealth?.credential).toMatchObject({
        kind: 'secret', secretName: NAME, resolves: 'unreadable', lastWritten: createdAt, tokenExpiry: null,
      });
      expect(line).toContain('resolves: unreadable');
      expect(line).toContain(`last written: ${createdAt}`);
      const both = compact + JSON.stringify(json);
      expect(both).not.toContain(body);
      expect(both).not.toContain(badTag);
    } finally {
      fs.writeFileSync(credPath, saved);
    }
  });

  it('5. canary: no secret value ever appears in compact or json output', () => {
    expect(outputs.length).toBeGreaterThan(10);
    for (const text of outputs) {
      expect(text).not.toContain(CANARY);
      expect(text).not.toContain(JWT.split('.')[2]);
    }
  });
});
