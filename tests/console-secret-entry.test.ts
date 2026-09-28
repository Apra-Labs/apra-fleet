/**
 * Console secret-entry routes (apra-fleet-i9ag.11.5), lane i9ag11-console-route
 * streakOrder 2.
 *
 * Proves POST /api/secret-entry/prompt and POST /api/secret-entry/submit
 * (src/console/routes/secret-entry.ts) are guarded, single-use,
 * token-oracle-free and value-leak-free. Every case dispatches through
 * handleConsoleRequest -- the same entry point the HTTP transport uses --
 * never by calling secretEntryRoutes' handlers directly.
 *
 * The fakeReq/fakeRes/post test doubles below intentionally mirror the ones
 * tests/console-routes-fleet.test.ts and tests/console-server.test.ts
 * already use for this same seam, rather than importing them: those are
 * `.test.ts` modules, and importing one from another pulls its top-level
 * `describe`/`it` calls (and its own vi.mock() registrations) into THIS
 * file's collection too, corrupting both suites -- confirmed by trying it.
 * The console cookie itself is never re-derived by hand (no
 * reimplementation of src/console/server.ts's private deriveConsoleCookieToken
 * HMAC) -- fetchConsoleCookie() below obtains it from the real GET /ui code
 * path, exactly as tests/console-auth.test.ts does over a real listening
 * server, just through this file's fake request/response doubles instead.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type http from 'node:http';
import { Readable } from 'node:stream';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { handleConsoleRequest } from '../src/console/server.js';
import { getOrCreateKey } from '../src/services/jwt.js';
import * as logHelpers from '../src/utils/log-helpers.js';
import * as secretEntryService from '../src/services/secret-entry.js';
import { createSecretEntry, SECRET_ENTRY_TTL_MS, __resetSecretEntriesForTest } from '../src/services/secret-entry.js';

const SENTINEL = 'SENTINEL-SECRET-DO-NOT-LEAK';
const PROMPT_PATH = '/api/secret-entry/prompt';
const SUBMIT_PATH = '/api/secret-entry/submit';

// ---------------------------------------------------------------------------
// Test doubles for the node http request/response pair -- see the file
// header for why these are duplicated here rather than imported.
// ---------------------------------------------------------------------------

interface CapturedRes {
  res: http.ServerResponse;
  status: number | null;
  headers: Record<string, string>;
  setHeaders: Record<string, string | string[]>;
  body: string;
  writes: number;
}

function fakeRes(): CapturedRes {
  const captured: CapturedRes = {
    res: null as unknown as http.ServerResponse,
    status: null,
    headers: {},
    setHeaders: {},
    body: '',
    writes: 0,
  };
  const stub = {
    headersSent: false,
    setHeader(name: string, value: string | string[]) {
      captured.setHeaders[name] = value;
      return stub;
    },
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      captured.headers = headers ?? {};
      captured.writes += 1;
      stub.headersSent = true;
      return stub;
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) captured.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    },
  };
  captured.res = stub as unknown as http.ServerResponse;
  return captured;
}

/** A real Readable so the routes' body reader has a stream to drain. Every
 *  /api/* request passes through the console auth guard, so a request built
 *  here carries the fleet-key bearer by default -- pass headers explicitly
 *  to exercise the guard itself. */
function fakeReq(url: string, method = 'GET', body?: string, headers?: Record<string, string>): http.IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(body, 'utf8')]);
  const req = stream as unknown as http.IncomingMessage & { url: string; method: string; headers: Record<string, string> };
  req.url = url;
  req.method = method;
  req.headers = headers ?? { authorization: `Bearer ${getOrCreateKey()}` };
  return req;
}

async function dispatch(url: string, method: string, body?: string, headers?: Record<string, string>): Promise<CapturedRes> {
  const out = fakeRes();
  const handled = await handleConsoleRequest(fakeReq(url, method, body, headers), out.res, {});
  expect(handled).toBe(true);
  return out;
}

/** POST a JSON body through the console seam with the default (valid
 *  bearer) credential, and return what was written. */
async function post(urlPath: string, body: unknown): Promise<CapturedRes> {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return dispatch(urlPath, 'POST', raw);
}

function bearerHeaders(): Record<string, string> {
  return { authorization: `Bearer ${getOrCreateKey()}` };
}

/** Derives the real console cookie via the real GET /ui code path -- the
 *  cookie is set unconditionally at the top of the /ui branch in
 *  handleConsoleRequest, before any static-serving happens, so this works
 *  even with no shell dist present in this test environment. */
async function fetchConsoleCookie(): Promise<string> {
  const out = fakeRes();
  const handled = await handleConsoleRequest(fakeReq('/ui', 'GET', undefined, {}), out.res, {});
  expect(handled).toBe(true);
  const raw = out.setHeaders['Set-Cookie'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) throw new Error('expected a Set-Cookie header from GET /ui, got none');
  return value.split(';')[0];
}

function makeEntry(onSubmit: (value: string) => { ok: boolean; error?: string } = () => ({ ok: true })) {
  return createSecretEntry({ name: 'member-x', prompt: 'Enter the thing', onSubmit });
}

// -----------------------------------------------------------------------------
// Test isolation: every /api/* request goes through the console auth guard,
// keyed on the real fleet.key under HOME (see src/services/jwt.ts). Point
// HOME (and, on Windows, USERPROFILE) at a fresh temp dir per test so
// getOrCreateKey() here is never the real developer's key -- same pattern as
// tests/console-routes-fleet.test.ts and tests/console-auth.test.ts.
// -----------------------------------------------------------------------------
let realHome: string | undefined;
let realUserProfile: string | undefined;
let tempHome: string;

beforeEach(async () => {
  vi.clearAllMocks();
  __resetSecretEntriesForTest();
  realHome = process.env.HOME;
  realUserProfile = process.env.USERPROFILE;
  tempHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'console-secret-entry-home-'));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
});

afterEach(async () => {
  __resetSecretEntriesForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.env.HOME = realHome;
  process.env.USERPROFILE = realUserProfile;
  await fsp.rm(tempHome, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------
// GUARD
// ---------------------------------------------------------------------------

describe('console secret-entry routes: auth guard', () => {
  it('POST prompt with no authorization header and no cookie -> 401, getSecretEntryPrompt never called', async () => {
    const promptSpy = vi.spyOn(secretEntryService, 'getSecretEntryPrompt');
    const entry = makeEntry();

    const out = await dispatch(PROMPT_PATH, 'POST', JSON.stringify({ token: entry.token }), {});
    expect(out.status).toBe(401);
    expect(JSON.parse(out.body)).toEqual({ error: 'unauthorized' });
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it('POST submit with no authorization header and no cookie -> 401, submitSecretEntry never called', async () => {
    const submitSpy = vi.spyOn(secretEntryService, 'submitSecretEntry');
    const entry = makeEntry();

    const out = await dispatch(SUBMIT_PATH, 'POST', JSON.stringify({ token: entry.token, value: 'x' }), {});
    expect(out.status).toBe(401);
    expect(JSON.parse(out.body)).toEqual({ error: 'unauthorized' });
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('a valid bearer fleet key passes the guard (prompt -> 200)', async () => {
    const entry = makeEntry();
    const out = await dispatch(PROMPT_PATH, 'POST', JSON.stringify({ token: entry.token }), bearerHeaders());
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body)).toEqual({ name: 'member-x', prompt: 'Enter the thing' });
  });

  it('the derived apra_console_token cookie passes the guard (prompt -> 200)', async () => {
    const cookie = await fetchConsoleCookie();
    const entry = makeEntry();
    const out = await dispatch(PROMPT_PATH, 'POST', JSON.stringify({ token: entry.token }), { cookie });
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body)).toEqual({ name: 'member-x', prompt: 'Enter the thing' });
  });
});

// ---------------------------------------------------------------------------
// PROMPT
// ---------------------------------------------------------------------------

describe('console secret-entry routes: POST /api/secret-entry/prompt', () => {
  it('live token -> 200 {name, prompt} with no "value" key anywhere in the body', async () => {
    const entry = makeEntry();
    const out = await post(PROMPT_PATH, { token: entry.token });
    expect(out.status).toBe(200);
    const parsed = JSON.parse(out.body);
    expect(parsed).toEqual({ name: 'member-x', prompt: 'Enter the thing' });
    expect(Object.keys(parsed)).not.toContain('value');
    expect(out.body).not.toContain('"value"');
  });

  it('unknown token -> 404', async () => {
    const out = await post(PROMPT_PATH, { token: '0'.repeat(64) });
    expect(out.status).toBe(404);
    expect(JSON.parse(out.body)).toEqual({ error: 'not found' });
  });

  it('expired token -> 404 with the SAME (byte-identical) body as an unknown token -- no token oracle', async () => {
    vi.useFakeTimers();
    const entry = makeEntry();
    vi.advanceTimersByTime(SECRET_ENTRY_TTL_MS + 1);

    const expired = await post(PROMPT_PATH, { token: entry.token });
    vi.useRealTimers();
    const unknown = await post(PROMPT_PATH, { token: '1'.repeat(64) });

    expect(expired.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(expired.body).toBe(unknown.body);
  });
});

// ---------------------------------------------------------------------------
// SUBMIT
// ---------------------------------------------------------------------------

describe('console secret-entry routes: POST /api/secret-entry/submit', () => {
  it('happy path -> 200 {ok: true} and the callback receives the exact value', async () => {
    const onSubmit = vi.fn(() => ({ ok: true }));
    const entry = makeEntry(onSubmit);

    const out = await post(SUBMIT_PATH, { token: entry.token, value: SENTINEL });
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body)).toEqual({ ok: true });
    expect(onSubmit).toHaveBeenCalledWith(SENTINEL);
  });

  it('second use of the same token -> 404', async () => {
    const entry = makeEntry();
    const first = await post(SUBMIT_PATH, { token: entry.token, value: 'first-value' });
    expect(first.status).toBe(200);

    const second = await post(SUBMIT_PATH, { token: entry.token, value: 'second-value' });
    expect(second.status).toBe(404);
    expect(JSON.parse(second.body)).toEqual({ error: 'not found' });
  });

  it('empty value -> 400 and the service is never called', async () => {
    const submitSpy = vi.spyOn(secretEntryService, 'submitSecretEntry');
    const onSubmit = vi.fn(() => ({ ok: true }));
    const entry = makeEntry(onSubmit);

    const out = await post(SUBMIT_PATH, { token: entry.token, value: '' });
    expect(out.status).toBe(400);
    expect(submitSpy).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('malformed JSON body -> 400', async () => {
    const out = await post(SUBMIT_PATH, '{not valid json');
    expect(out.status).toBe(400);
  });

  it('a non-hex token -> 400, never 500', async () => {
    const out = await post(SUBMIT_PATH, { token: 'z'.repeat(64), value: 'x' });
    expect(out.status).toBe(400);
  });

  it('an oversized token -> 400, never 500', async () => {
    const out = await post(SUBMIT_PATH, { token: '0'.repeat(128), value: 'x' });
    expect(out.status).toBe(400);
  });

  it('an onSubmit rejection -> 422 carrying the server error text', async () => {
    const onSubmit = vi.fn(() => ({ ok: false, error: 'store is full' }));
    const entry = makeEntry(onSubmit);

    const out = await post(SUBMIT_PATH, { token: entry.token, value: 'x' });
    expect(out.status).toBe(422);
    expect(JSON.parse(out.body)).toEqual({ error: 'store is full' });
  });

  it('a throwing onSubmit -> 500 "submit failed", never echoing the thrown message', async () => {
    const onSubmit = vi.fn(() => {
      throw new Error(SENTINEL);
    });
    const entry = makeEntry(onSubmit);

    const out = await post(SUBMIT_PATH, { token: entry.token, value: 'x' });
    expect(out.status).toBe(500);
    expect(JSON.parse(out.body)).toEqual({ error: 'submit failed' });
    expect(out.body).not.toContain(SENTINEL);
  });
});

// ---------------------------------------------------------------------------
// METHOD / PATH
// ---------------------------------------------------------------------------

describe('console secret-entry routes: method/path behaviour', () => {
  it('GET /api/secret-entry/submit -> 405', async () => {
    const out = await dispatch(SUBMIT_PATH, 'GET', undefined, bearerHeaders());
    expect(out.status).toBe(405);
  });

  it('POST /api/secret-entry/unknown -> 404', async () => {
    const out = await dispatch('/api/secret-entry/unknown', 'POST', '{}', bearerHeaders());
    expect(out.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// NON-LEAKAGE: the submitted value and the token must never appear in any
// response body across the matrix above, nor in anything captured from a
// spied logLine.
// ---------------------------------------------------------------------------

describe('console secret-entry routes: non-leakage', () => {
  it('a submitted sentinel value never appears in any response body, success or otherwise', async () => {
    const logLineSpy = vi.spyOn(logHelpers, 'logLine');

    const happyEntry = makeEntry(vi.fn(() => ({ ok: true })));
    const rejectedEntry = makeEntry(vi.fn(() => ({ ok: false, error: 'nope' })));
    const throwingEntry = makeEntry(
      vi.fn(() => {
        throw new Error(SENTINEL);
      }),
    );

    const promptOut = await post(PROMPT_PATH, { token: happyEntry.token });
    const submitOk = await post(SUBMIT_PATH, { token: happyEntry.token, value: SENTINEL });
    const submitSecondUse = await post(SUBMIT_PATH, { token: happyEntry.token, value: SENTINEL });
    const submitRejected = await post(SUBMIT_PATH, { token: rejectedEntry.token, value: SENTINEL });
    const submitEmpty = await post(SUBMIT_PATH, { token: rejectedEntry.token, value: '' });
    const submitUnknown = await post(SUBMIT_PATH, { token: '2'.repeat(64), value: SENTINEL });
    const submitThrows = await post(SUBMIT_PATH, { token: throwingEntry.token, value: 'irrelevant' });

    const bodies = [
      promptOut.body,
      submitOk.body,
      submitSecondUse.body,
      submitRejected.body,
      submitEmpty.body,
      submitUnknown.body,
      submitThrows.body,
    ];
    for (const body of bodies) {
      expect(body).not.toContain(SENTINEL);
    }

    const loggedText = logLineSpy.mock.calls.flat().map((a) => JSON.stringify(a)).join('\n');
    // Anti-vacuity: prove the spy actually captured something from the real
    // submit route (src/console/routes/secret-entry.ts's logLine call), so
    // this sweep cannot pass vacuously if that log call is ever removed and
    // there is nothing left to sweep for a leak in the first place.
    expect(logLineSpy.mock.calls.length).toBeGreaterThan(0);
    expect(loggedText).toContain('secret_entry');
    expect(loggedText).toContain('submit');
    expect(loggedText).not.toContain(SENTINEL);
    expect(loggedText).not.toContain(happyEntry.token);
    expect(loggedText).not.toContain(rejectedEntry.token);
    expect(loggedText).not.toContain(throwingEntry.token);
  });
});
