import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// HttpKbProvider with a live-secret-backed named credential: the token
// cache (one helper run, shared by concurrent requests, refreshed before
// expiry), the backoff after a helper failure, the 401 drop-rerun-retry rule,
// and the fleet_status credential block. Real pieces only: a real node helper
// script registered in the real credential store, a real local KB HTTP server,
// the real KB config file.
//
// Every token the helper mints carries PREFIX in plain text, and the helper
// writes PREFIX to its own stderr, so one substring check proves no token or
// helper output reached a result, error, stderr, the fleet log, fleet_status
// or the environment.

import { HttpKbProvider, KbHttpAuthError } from '../../src/services/knowledge/http-provider.js';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { KB_CONFIG_PATH, readKbConfigFromDisk } from '../../src/services/knowledge/kb-config.js';
import { resetKbHttpAuthState } from '../../src/services/knowledge/kb-http-auth-state.js';
import { prepareLiveSecret, saveLiveSecret, credentialDelete } from '../../src/services/credential-store.js';
import {
  resetLiveTokenCache,
  liveRefreshAt,
  liveBackoffMs,
  LIVE_BACKOFF_BASE_MS,
  LIVE_BACKOFF_MAX_MS,
} from '../../src/services/live-secret-cache.js';
import { kbHttpCredentialHealth, kbCredentialCompactLine } from '../../src/tools/check-status.js';
import { getActiveLogFile } from '../../src/utils/log-helpers.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';
import { makeTempDir } from './token-command-helpers.js';
import {
  writeCountingHelper,
  startStubKbServer,
  helperRunOf,
  type CountingHelper,
  type StubKbServer,
} from './kb-live-secret-fixture.js';

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const NAME = `KB_LIVE_${RUN}`;
const PREFIX = `zqcanary-kblive-${RUN}`;

let stub: StubKbServer;
let tmp: string;
let helper: CountingHelper;
let provider: HttpKbProvider;
let savedConfig: string | null;
const errorTexts: string[] = [];
const resultTexts: string[] = [];
const stderrChunks: string[] = [];
const originalStderrWrite = process.stderr.write;

function register(): void {
  saveLiveSecret(prepareLiveSecret(NAME, { program: helper.launch.program, args: helper.launch.args, env: [] }));
}

function newProvider(): HttpKbProvider {
  return new HttpKbProvider(stub.url, { secretName: NAME }, new SqliteProvider(path.join(tmp, 'fallback.sqlite')));
}

function entry(title: string): KBEntryInput {
  return {
    type: 'learning', title, summary: `${title} -- summary for the credential helper suite`,
    content: `${title} content`, source_files: ['src/gear.ts'], symbols: [], tags: [],
    content_hash: '', content_hash_type: 'sha256', flagged_for_review: false,
    author: 'test', source: 'session', confidence: 'INFERRED',
  };
}

async function query(): Promise<void> {
  resultTexts.push(JSON.stringify(await provider.query({ query: 'gear' })));
}

async function expectAuthError(p: Promise<unknown>, reason: string): Promise<KbHttpAuthError> {
  let caught: unknown;
  try { await p; } catch (err) { caught = err; }
  expect(caught).toBeInstanceOf(KbHttpAuthError);
  const err = caught as KbHttpAuthError;
  errorTexts.push(err.message, err.stack ?? '');
  expect(err.code).toBe('E-KB-HTTP-AUTH');
  expect(err.reason).toBe(reason);
  expect(err.secretName).toBe(NAME);
  expect(err.message).toContain(`live secret "${NAME}"`);
  expect(err.message).toContain(`apra-fleet secret --live ${NAME}`);
  return err;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

beforeAll(async () => {
  stub = await startStubKbServer();
  savedConfig = fs.existsSync(KB_CONFIG_PATH) ? fs.readFileSync(KB_CONFIG_PATH, 'utf-8') : null;
  const passthrough = originalStderrWrite.bind(process.stderr);
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    stderrChunks.push(String(chunk));
    return (passthrough as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
});

beforeEach(() => {
  tmp = makeTempDir('kb-http-cred-helper-');
  helper = writeCountingHelper(tmp, PREFIX);
  register();
  resetLiveTokenCache();
  resetKbHttpAuthState();
  stub.requests.length = 0;
  stub.accept = (token) => token.includes(PREFIX);
  provider = newProvider();
});

afterEach(() => {
  provider.dispose();
  credentialDelete(NAME);
  fs.rmSync(tmp, { recursive: true, force: true });
});

afterAll(async () => {
  process.stderr.write = originalStderrWrite;
  await stub.close();
  if (savedConfig === null) fs.rmSync(KB_CONFIG_PATH, { force: true });
  else fs.writeFileSync(KB_CONFIG_PATH, savedConfig);
});

describe('refresh point and backoff schedule', () => {
  it('refreshes at expires_at minus the smaller of 10 minutes and 10% of the lifetime', () => {
    expect(liveRefreshAt(0, 10_000_000)).toBe(10_000_000 - 600_000); // 10% = 16 min -> 10 min cap
    expect(liveRefreshAt(0, 3_600_000)).toBe(3_600_000 - 360_000); // 10% = 6 min
    expect(liveRefreshAt(1_000, 1_000)).toBe(1_000); // zero lifetime: no margin
  });

  it('backs off 10 s, doubling per consecutive failure, capped at 5 minutes', () => {
    expect(liveBackoffMs(1)).toBe(LIVE_BACKOFF_BASE_MS);
    expect(liveBackoffMs(2)).toBe(2 * LIVE_BACKOFF_BASE_MS);
    expect(liveBackoffMs(3)).toBe(4 * LIVE_BACKOFF_BASE_MS);
    expect(liveBackoffMs(50)).toBe(LIVE_BACKOFF_MAX_MS);
  });
});

describe('HttpKbProvider with a credential helper', () => {
  it('runs the helper once for the first request and reuses the token after it', async () => {
    await query();
    await query();
    await provider.capture(entry('Helper gear'));
    expect(helper.runs()).toEqual([{ credential: NAME }]);
    expect(stub.requests).toHaveLength(3);
    expect(stub.requests.every(r => r.authorized && helperRunOf(r.token, PREFIX) === 1)).toBe(true);
  });

  it('10 concurrent requests share one helper run', async () => {
    helper.setControl({ delayMs: 400 });
    await Promise.all(Array.from({ length: 10 }, () => query()));
    expect(helper.runs()).toHaveLength(1);
    expect(stub.requests).toHaveLength(10);
    expect(stub.requests.every(r => r.authorized)).toBe(true);
  });

  it('a token past its refresh point is replaced before the request; the server never sees an expired token', async () => {
    helper.setControl({ lifetimeMs: 3_000 }); // refresh point: 300 ms before expiry
    await query();
    expect(helper.runs()).toHaveLength(1);
    await sleep(2_850);
    await query();
    expect(helper.runs()).toHaveLength(2);
    expect(stub.requests.map(r => helperRunOf(r.token, PREFIX))).toEqual([1, 2]);
    for (const r of stub.requests) {
      expect(r.atMs).toBeLessThan(helper.expiresAtOf(helperRunOf(r.token, PREFIX)));
    }
  });

  it('a failing helper raises E-KB-HTTP-AUTH and is not run again inside the backoff window; re-registering clears it', async () => {
    helper.setControl({ mode: 'fail' });
    const first = await expectAuthError(provider.query({ query: 'gear' }), 'live-secret-failed');
    expect(first.message).toContain('exit code 3');
    expect(helper.runs()).toHaveLength(1);

    const second = await expectAuthError(provider.query({ query: 'gear' }), 'live-secret-failed');
    expect(second.message).toContain('not run again until');
    const queued = await expectAuthError(provider.capture(entry('Queued while failing')), 'live-secret-failed');
    expect(queued.queued).toBe(true);
    expect(provider.offlineQueue).toHaveLength(1);
    expect(helper.runs()).toHaveLength(1);
    expect(stub.requests).toHaveLength(0);

    // Re-registering the helper starts a fresh cache entry: no backoff.
    helper.setControl({ mode: 'ok' });
    await sleep(5); // a distinct created_at
    register();
    await query();
    expect(helper.runs()).toHaveLength(2);
    expect(provider.offlineQueue).toHaveLength(0); // the queued capture was flushed first
    expect(stub.requests.map(r => r.path)).toEqual(['/api/kb/capture', '/api/kb/query']);
  });

  it('401: drops the cached token, runs the helper once more and the retry succeeds', async () => {
    stub.accept = (token) => helperRunOf(token, PREFIX) >= 2;
    await query();
    expect(helper.runs()).toHaveLength(2);
    expect(stub.requests.map(r => [helperRunOf(r.token, PREFIX), r.authorized])).toEqual([[1, false], [2, true]]);
  });

  it('kb_feedback goes the same way: a 401 re-mints once and the retry succeeds; a second 401 queues it', async () => {
    stub.accept = (token) => helperRunOf(token, PREFIX) >= 2;
    await provider.feedback('e1', 'wrong in practice', 'doer');
    expect(helper.runs()).toHaveLength(2);
    expect(stub.requests.map(r => [r.path, helperRunOf(r.token, PREFIX), r.authorized]))
      .toEqual([['/api/kb/feedback', 1, false], ['/api/kb/feedback', 2, true]]);
    stub.accept = () => false;
    const err = await expectAuthError(provider.feedback('e2', 'wrong again', 'doer'), 'rejected');
    expect(err.queued).toBe(true);
    expect(provider.offlineQueue).toEqual([{ op: 'feedback', id: 'e2', reason: 'wrong again', role: 'doer' }]);
  });

  it('a second 401 raises E-KB-HTTP-AUTH after exactly one helper re-run', async () => {
    stub.accept = () => false;
    const err = await expectAuthError(provider.query({ query: 'gear' }), 'rejected');
    expect(err.message).toContain('HTTP 401');
    expect(helper.runs()).toHaveLength(2);
    expect(stub.requests).toHaveLength(2);
  });

  it('a server that rejects every token: the replacement is kept through a cool-down, so later calls run no script and stay rejected', async () => {
    stub.accept = () => false;
    await expectAuthError(provider.query({ query: 'gear' }), 'rejected');
    expect([helper.runs().length, stub.requests.length]).toEqual([2, 2]);
    for (let i = 1; i <= 3; i++) {
      const err = await expectAuthError(provider.query({ query: 'gear' }), 'rejected');
      expect([helper.runs().length, stub.requests.length]).toEqual([2, 2 + i]);
      expect(err.message).toContain('no new token is minted before');
    }
    // Past the 10 s cool-down: one new mint, then a 20 s cool-down for that one.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + LIVE_BACKOFF_BASE_MS + 1000);
      await expectAuthError(provider.query({ query: 'gear' }), 'rejected');
      expect([helper.runs().length, stub.requests.length]).toEqual([3, 7]);
      vi.setSystemTime(Date.now() + LIVE_BACKOFF_BASE_MS + 1000);
      await expectAuthError(provider.query({ query: 'gear' }), 'rejected');
      expect([helper.runs().length, stub.requests.length]).toEqual([3, 8]);
    } finally {
      vi.useRealTimers();
    }
    // Accepted once: the count resets, so a later rejection gets its one re-mint.
    stub.accept = (token) => token.includes(PREFIX);
    await query();
    stub.accept = (token) => helperRunOf(token, PREFIX) >= 4;
    await query();
    expect(helper.runs()).toHaveLength(4);
  });

  it('concurrent 401s share one re-run', async () => {
    stub.accept = (token) => helperRunOf(token, PREFIX) >= 2;
    helper.setControl({ delayMs: 200 });
    await query(); // run 1 rejected, run 2 accepted
    stub.accept = (token) => helperRunOf(token, PREFIX) >= 3;
    await Promise.all(Array.from({ length: 5 }, () => query()));
    expect(helper.runs()).toHaveLength(3);
  });
});

describe('fleet_status credential block for a live secret', () => {
  function health() {
    fs.mkdirSync(path.dirname(KB_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(KB_CONFIG_PATH, JSON.stringify({ provider: 'http', url: stub.url, token_ref: `{{secret.${NAME}}}` }));
    const block = kbHttpCredentialHealth(readKbConfigFromDisk());
    resultTexts.push(JSON.stringify(block));
    return block;
  }

  it('shows the secret name, resolve state, last minted, JWT exp and call times; never the token', async () => {
    const before = health();
    expect(before).toMatchObject({ kind: 'live', secretName: NAME, resolves: 'not run', lastMinted: null });

    await query();
    const after = health();
    if (after?.kind !== 'live') throw new Error(`expected a live block, got ${after?.kind}`);
    expect(after.resolves).toBe('ok');
    expect(after.lastMinted).not.toBeNull();
    const expSeconds = Math.floor(helper.expiresAtOf(1) / 1000);
    expect(after.tokenExpiry).toBe(new Date(expSeconds * 1000).toISOString());
    expect(after.lastSuccessfulCall).not.toBeNull();
    const line = kbCredentialCompactLine(after);
    resultTexts.push(line);
    expect(line).toContain(`kb credential: live secret ${NAME} | resolves: ok`);
    expect(line).toContain(`last minted: ${after.lastMinted}`);
  });

  it('shows a failed live secret with its reason and retry time', async () => {
    helper.setControl({ mode: 'fail' });
    await expectAuthError(provider.query({ query: 'gear' }), 'live-secret-failed');
    const block = health();
    if (block?.kind !== 'live') throw new Error(`expected a live block, got ${block?.kind}`);
    expect(block.resolves).toBe('failed');
    expect(block.lastFailure).toBe('exit code 3');
    expect(block.retryAfter).not.toBeNull();
    expect(kbCredentialCompactLine(block)).toContain('| last failure: exit code 3 | next run after: ');
  });
});

describe('canary', () => {
  it('no token or helper output appears in results, errors, stderr, the fleet log, fleet_status or the environment', () => {
    expect(resultTexts.length).toBeGreaterThan(0);
    expect(errorTexts.length).toBeGreaterThan(0);
    for (const text of [...resultTexts, ...errorTexts, ...stderrChunks]) {
      expect(text).not.toContain(PREFIX);
    }
    const logFile = getActiveLogFile();
    if (logFile && fs.existsSync(logFile)) {
      expect(fs.readFileSync(logFile, 'utf-8')).not.toContain(PREFIX);
    }
    for (const value of Object.values(process.env)) {
      expect(value ?? '').not.toContain(PREFIX);
    }
  });
});
