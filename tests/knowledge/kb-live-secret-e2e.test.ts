import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// End to end through the real KB tool path with a live-secret-backed
// named credential: the helper is registered through the registration API
// (prepareLiveSecret + saveLiveSecret, what `apra-fleet secret --live` calls), kb_setup
// stores token_ref {{secret.NAME}}, and kb_query / kb_capture / fleet_status
// run as the tool handlers. The KB server is a real local HTTP server that
// accepts only the tokens a test allows and answers 401 otherwise; the helper
// is a real node script that appends one line per run to a counter file and
// prints a canary token with a test-controlled expires_at. No mocks.

import { kbSetup } from '../../src/tools/kb-setup.js';
import { kbQuery } from '../../src/tools/kb-query.js';
import { kbCapture } from '../../src/tools/kb-capture.js';
import { fleetStatus } from '../../src/tools/check-status.js';
import { KbHttpAuthError } from '../../src/services/knowledge/http-provider.js';
import { resetKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { KB_CONFIG_PATH } from '../../src/services/knowledge/kb-config.js';
import { resetKbHttpAuthState } from '../../src/services/knowledge/kb-http-auth-state.js';
import { resetLiveTokenCache } from '../../src/services/live-secret-cache.js';
import { prepareLiveSecret, saveLiveSecret, credentialSet, credentialDelete } from '../../src/services/credential-store.js';
import { addAgent } from '../../src/services/registry.js';
import { getActiveLogFile } from '../../src/utils/log-helpers.js';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from '../test-helpers.js';
import { isolateGitConfig } from './isolate-git-config.js';
import { makeTempDir } from './token-command-helpers.js';
import {
  writeCountingHelper,
  startStubKbServer,
  helperRunOf,
  type CountingHelper,
  type StubKbServer,
} from './kb-live-secret-fixture.js';

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const NAME = `KB_LIVE_E2E_${RUN}`;
const STATIC_NAME = `KB_STATIC_E2E_${RUN}`;
const PREFIX = `zqcanary-kblive-e2e-${RUN}`;
const STATIC_TOKEN = `${PREFIX}-static`;
const ORIGIN = `https://example.test/kb-helper-e2e-${RUN}.git`;

let stub: StubKbServer;
let scratch: string;
let repo: string;
let helperDir: string;
let helper: CountingHelper;
let savedConfig: string | null;
let restoreGitConfig: () => void;
const toolTexts: string[] = [];
const errorTexts: string[] = [];
const statusTexts: string[] = [];
const stderrChunks: string[] = [];
const originalStderrWrite = process.stderr.write;

async function setupKb(name: string): Promise<void> {
  const out = await kbSetup({ provider: 'http', remote: stub.url, token: `{{secret.${name}}}` }, { folder: repo });
  toolTexts.push(out);
  expect(JSON.parse(out).success).toBe(true);
  expect(JSON.parse(fs.readFileSync(KB_CONFIG_PATH, 'utf-8')).token_ref).toBe(`{{secret.${name}}}`);
}

async function query(): Promise<void> {
  toolTexts.push(await kbQuery({ query: 'gear' } as never, { folder: repo }));
}

async function capture(title: string): Promise<void> {
  toolTexts.push(await kbCapture({
    type: 'learning', title, summary: `${title} -- capture through the credential helper`, content: 'x',
    source_files: ['src/gear.ts'],
  } as never, { folder: repo }));
}

async function expectAuthError(p: Promise<unknown>, reason: string): Promise<KbHttpAuthError> {
  let caught: unknown;
  try { await p; } catch (err) { caught = err; }
  expect(caught).toBeInstanceOf(KbHttpAuthError);
  const err = caught as KbHttpAuthError;
  errorTexts.push(err.message, err.stack ?? '');
  expect(err.code).toBe('E-KB-HTTP-AUTH');
  expect(err.reason).toBe(reason);
  expect(err.message).toContain(`live secret "${NAME}"`);
  return err;
}

async function status(): Promise<{ line: string; credential: Record<string, unknown> }> {
  const compact = await fleetStatus({ format: 'compact' });
  const jsonText = await fleetStatus({ format: 'json' });
  statusTexts.push(compact, jsonText);
  const line = compact.split('\n').find(l => l.includes('kb credential:'));
  if (!line) throw new Error(`fleet_status has no kb credential line:\n${compact}`);
  const credential = (JSON.parse(jsonText) as { kbHealth?: { credential?: Record<string, unknown> } }).kbHealth?.credential;
  if (!credential) throw new Error('fleet_status json has no kbHealth.credential');
  return { line, credential };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

beforeAll(async () => {
  restoreGitConfig = isolateGitConfig();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-helper-e2e-'));
  repo = path.join(scratch, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'gear.ts'), 'export const gear = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', ORIGIN], { cwd: repo });
  savedConfig = fs.existsSync(KB_CONFIG_PATH) ? fs.readFileSync(KB_CONFIG_PATH, 'utf-8') : null;
  stub = await startStubKbServer();
  backupAndResetRegistry();
  addAgent(makeTestLocalAgent({ friendlyName: `kb-helper-e2e-${RUN}`, workFolder: repo }));
  const passthrough = originalStderrWrite.bind(process.stderr);
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    stderrChunks.push(String(chunk));
    return (passthrough as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
});

beforeEach(async () => {
  helperDir = makeTempDir('kb-helper-e2e-run-');
  helper = writeCountingHelper(helperDir, PREFIX);
  saveLiveSecret(prepareLiveSecret(NAME, { program: helper.launch.program, args: helper.launch.args, env: [] }));
  resetKbProviders();
  resetLiveTokenCache();
  resetKbHttpAuthState();
  stub.requests.length = 0;
  stub.accept = (token) => token.startsWith('ey') && token.includes(PREFIX);
  await setupKb(NAME);
});

afterEach(() => {
  resetKbProviders();
  credentialDelete(NAME);
  credentialDelete(STATIC_NAME);
  fs.rmSync(helperDir, { recursive: true, force: true });
});

afterAll(async () => {
  process.stderr.write = originalStderrWrite;
  resetKbProviders();
  restoreRegistry();
  await stub.close();
  if (savedConfig === null) fs.rmSync(KB_CONFIG_PATH, { force: true });
  else fs.writeFileSync(KB_CONFIG_PATH, savedConfig);
  fs.rmSync(scratch, { recursive: true, force: true });
  restoreGitConfig();
});

describe('KB tools with a credential-helper-backed named credential', () => {
  it('several sequential KB tool calls run the helper exactly once', async () => {
    await query();
    await capture('Sequential gear');
    await query();
    expect(helper.runs()).toEqual([{ credential: NAME }]);
    expect(stub.requests.length).toBeGreaterThanOrEqual(3);
    expect(stub.requests.every(r => r.authorized && helperRunOf(r.token, PREFIX) === 1)).toBe(true);
  });

  it('10 concurrent KB tool calls run the helper once', async () => {
    helper.setControl({ delayMs: 400 });
    await Promise.all(Array.from({ length: 10 }, () => query()));
    expect(helper.runs()).toHaveLength(1);
    expect(stub.requests.length).toBeGreaterThanOrEqual(10);
    expect(stub.requests.every(r => r.authorized)).toBe(true);
  });

  it('a short-lived token is replaced before the request once past the refresh threshold; the server never sees an expired token', async () => {
    helper.setControl({ lifetimeMs: 3_000 }); // refresh threshold: 300 ms before expiry
    await query();
    expect(helper.runs()).toHaveLength(1);
    await sleep(2_850);
    await query();
    expect(helper.runs()).toHaveLength(2);
    const runsSeen = stub.requests.map(r => helperRunOf(r.token, PREFIX));
    expect(runsSeen[0]).toBe(1);
    expect(runsSeen[runsSeen.length - 1]).toBe(2);
    for (const r of stub.requests) {
      expect(r.atMs).toBeLessThan(helper.expiresAtOf(helperRunOf(r.token, PREFIX)));
    }
  });

  it('a failing helper raises E-KB-HTTP-AUTH naming the credential; a second call inside the backoff window does not run it', async () => {
    helper.setControl({ mode: 'fail' });
    const first = await expectAuthError(query(), 'live-secret-failed');
    expect(first.secretName).toBe(NAME);
    expect(helper.runs()).toHaveLength(1);
    await expectAuthError(query(), 'live-secret-failed');
    expect(helper.runs()).toHaveLength(1);
    expect(stub.requests).toHaveLength(0);
  });

  it('a server that rejects the first token: one helper re-run, then the retry succeeds', async () => {
    stub.accept = (token) => helperRunOf(token, PREFIX) >= 2;
    await query();
    expect(helper.runs()).toHaveLength(2);
    expect(stub.requests[0]).toMatchObject({ authorized: false });
    expect(stub.requests.slice(1).every(r => r.authorized && helperRunOf(r.token, PREFIX) === 2)).toBe(true);
  });

  it('a server that rejects every token: E-KB-HTTP-AUTH after exactly one re-run', async () => {
    stub.accept = () => false;
    await expectAuthError(query(), 'rejected');
    expect(helper.runs()).toHaveLength(2);
    expect(stub.requests).toHaveLength(2);
  });

  it('fleet_status shows the live secret name and last minted time', async () => {
    await query();
    const { line, credential } = await status();
    expect(credential).toMatchObject({ kind: 'live', secretName: NAME, resolves: 'ok' });
    expect(typeof credential.lastMinted).toBe('string');
    expect(line).toContain(`kb credential: live secret ${NAME} | resolves: ok`);
    expect(line).toContain(`last minted: ${credential.lastMinted as string}`);
  }, 30_000);

  it('a static named secret in the same setup behaves as before; the helper never runs', async () => {
    credentialSet(STATIC_NAME, STATIC_TOKEN, true, 'allow', '*');
    await setupKb(STATIC_NAME);
    stub.accept = (token) => token === STATIC_TOKEN;
    await query();
    await capture('Static gear');
    expect(helper.runs()).toHaveLength(0);
    expect(stub.requests.length).toBeGreaterThanOrEqual(2);
    expect(stub.requests.every(r => r.authorized)).toBe(true);
    const { credential } = await status();
    expect(credential).toMatchObject({ kind: 'secret', secretName: STATIC_NAME, resolves: 'ok' });
  });
});

describe('canary', () => {
  it('no token appears in tool results, errors, stderr, the fleet log, fleet_status, the KB config or process.env', () => {
    expect(toolTexts.length).toBeGreaterThan(0);
    expect(errorTexts.length).toBeGreaterThan(0);
    expect(statusTexts.length).toBeGreaterThan(0);
    for (const text of [...toolTexts, ...errorTexts, ...statusTexts, ...stderrChunks]) {
      expect(text).not.toContain(PREFIX);
    }
    const logFile = getActiveLogFile();
    if (logFile && fs.existsSync(logFile)) {
      expect(fs.readFileSync(logFile, 'utf-8')).not.toContain(PREFIX);
    }
    for (const value of Object.values(process.env)) {
      expect(value ?? '').not.toContain(PREFIX);
    }
    expect(fs.readFileSync(KB_CONFIG_PATH, 'utf-8')).not.toContain(PREFIX);
  });
});
