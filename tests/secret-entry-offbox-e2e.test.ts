/**
 * apra-fleet-i9ag.11.13 -- off-box end-to-end acceptance for the bug fixed by
 * this streak: a browser that is NOT on the server machine must be able to
 * set a secret through the console (Add credential -> secret-entry submit),
 * and the collection URL/value must never leak.
 *
 * Everything below runs through a REAL node:http.Server whose request
 * listener delegates straight to handleConsoleRequest (src/console/server.ts)
 * -- the exact entry point the real HTTP transport uses -- so the console
 * guard, the /api/fleet/credential-store-set + credential-store-list routes
 * (src/console/routes/fleet.ts) and the /api/secret-entry/* routes
 * (src/console/routes/secret-entry.ts) are all the shipped code, never a
 * reimplementation.
 *
 * "Off-box" is simulated the only way a unit-test process safely can: the
 * client TCP-connects to 127.0.0.1 (this file has to run somewhere), but
 * every request explicitly overrides its Host header to a foreign,
 * non-loopback name and every later request reuses that same foreign Host.
 * Nothing in handleConsoleRequest's dispatch reads req.headers.host at all
 * (confirmed by reading src/console/server.ts) -- the fix this test pins is
 * that the collection URL credential_store_set hands back is a
 * console-RELATIVE path (no scheme/host/port baked in), so it resolves
 * correctly against whatever origin the browser actually used to reach the
 * console, instead of a loopback ephemeral-port URL only an on-box browser
 * could open.
 *
 * The credential store, the secret-entry registry and the console cookie are
 * all real (unmocked) -- only logLine/logError are spied (not mocked) so the
 * leakage sweep can assert on what was actually logged, matching the pattern
 * tests/console-secret-entry.test.ts already uses for this same seam.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import type net from 'node:net';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { handleConsoleRequest } from '../src/console/server.js';
import { getOrCreateKey } from '../src/services/jwt.js';
import * as logHelpers from '../src/utils/log-helpers.js';
import { __resetSecretEntriesForTest } from '../src/services/secret-entry.js';

const SENTINEL = 'OFFBOX-SENTINEL-DO-NOT-LEAK-7f2a';
const CRED_NAME = 'offbox-console-cred';
/** Deliberately NOT loopback and NOT a name the server is bound to -- exactly
 *  the kind of Host header a remote browser reaching the console over a LAN
 *  address, a tunnel, or a reverse proxy would send. */
const FOREIGN_HOST = 'fleet-lin1.example.internal:7650';

const INDEX_HTML = '<html><body>fleet console shell</body></html>';

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

// -----------------------------------------------------------------------------
// Lifecycle: an isolated HOME (fleet key + console cookie derivation) and an
// isolated APRA_FLEET_DATA_DIR (credential store), a temp shell dist so
// GET /ui can actually answer 200, and a real http.Server bound to an
// OS-assigned loopback port whose listener is exactly handleConsoleRequest.
// -----------------------------------------------------------------------------
let realHome: string | undefined;
let realUserProfile: string | undefined;
let realDataDir: string | undefined;
let realConsoleBaseUrl: string | undefined;
let tempHome: string;
let tempDataDir: string;
let tempDistDir: string;
let server: http.Server;
let serverPort: number;
let sockets: net.Socket[] = [];

async function mkTmp(prefix: string): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

beforeEach(async () => {
  vi.clearAllMocks();
  __resetSecretEntriesForTest();

  realHome = process.env.HOME;
  realUserProfile = process.env.USERPROFILE;
  realDataDir = process.env.APRA_FLEET_DATA_DIR;
  realConsoleBaseUrl = process.env.APRA_FLEET_CONSOLE_BASE_URL;

  tempHome = await mkTmp('secret-entry-offbox-home-');
  tempDataDir = await mkTmp('secret-entry-offbox-data-');
  tempDistDir = await mkTmp('secret-entry-offbox-dist-');
  fs.writeFileSync(path.join(tempDistDir, 'index.html'), INDEX_HTML, 'utf8');

  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  process.env.APRA_FLEET_DATA_DIR = tempDataDir;
  // Neutralize the ambient environment: credential-store-set.ts's return_url
  // branch reads APRA_FLEET_CONSOLE_BASE_URL through resolveConsoleBaseUrl()
  // (src/paths.ts) and fails loudly with [FAIL] text if it happens to be set
  // to a malformed value on the machine running this suite. Without this,
  // that implicit environment state would decide this test's outcome and the
  // failure would point at the wrong assertion entirely -- delete it so this
  // test always exercises the documented bound-origin fallback, exactly like
  // APRA_FLEET_DATA_DIR above.
  delete process.env.APRA_FLEET_CONSOLE_BASE_URL;

  server = http.createServer((req, res) => {
    handleConsoleRequest(req, res, { shellDistDir: tempDistDir })
      .then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      })
      .catch((err) => {
        if (!res.headersSent) res.writeHead(500);
        res.end(String(err));
      });
  });
  server.on('connection', (s) => sockets.push(s));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  serverPort = (server.address() as net.AddressInfo).port;
});

afterEach(async () => {
  __resetSecretEntriesForTest();
  vi.restoreAllMocks();

  for (const socket of sockets.splice(0)) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));

  process.env.HOME = realHome;
  process.env.USERPROFILE = realUserProfile;
  if (realDataDir === undefined) delete process.env.APRA_FLEET_DATA_DIR;
  else process.env.APRA_FLEET_DATA_DIR = realDataDir;
  if (realConsoleBaseUrl === undefined) delete process.env.APRA_FLEET_CONSOLE_BASE_URL;
  else process.env.APRA_FLEET_CONSOLE_BASE_URL = realConsoleBaseUrl;

  for (const dir of [tempHome, tempDataDir, tempDistDir]) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// -----------------------------------------------------------------------------
// HTTP helper -- always connects over 127.0.0.1 (this process has to run
// somewhere) but lets the caller override the Host header explicitly, which
// is the only thing distinguishing an "off-box" request from an on-box one
// from the server's point of view.
// -----------------------------------------------------------------------------
function request(
  method: string,
  urlPath: string,
  { headers = {}, body }: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const outHeaders: Record<string, string> = { ...headers };
    if (payload) {
      outHeaders['content-type'] = 'application/json';
      outHeaders['content-length'] = String(payload.length);
    }
    const req = http.request(
      { hostname: '127.0.0.1', port: serverPort, path: urlPath, method, headers: outHeaders },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Every request in this file sends the SAME foreign, non-loopback Host --
 *  never the real bound loopback origin -- exactly as a remote browser
 *  would. */
function offBoxHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { host: FOREIGN_HOST, ...extra };
}

function bearerHeaders(): Record<string, string> {
  return offBoxHeaders({ authorization: `Bearer ${getOrCreateKey()}` });
}

describe('apra-fleet-i9ag.11.13: off-box console credential entry, end to end', () => {
  it('a remote browser can add a credential and submit its secret through the real console routes, with no loopback URL and no leaked value anywhere', async () => {
    const logLineSpy = vi.spyOn(logHelpers, 'logLine');
    const logErrorSpy = vi.spyOn(logHelpers, 'logError');
    const bodies: string[] = [];

    // --- (2) GET /ui over a foreign Host -> 200 + Set-Cookie ----------------
    const uiRes = await request('GET', '/ui', { headers: offBoxHeaders() });
    bodies.push(uiRes.body);
    expect(uiRes.status).toBe(200);
    expect(uiRes.body).toBe(INDEX_HTML);
    const rawCookie = uiRes.headers['set-cookie'];
    const cookieHeader = Array.isArray(rawCookie) ? rawCookie[0] : rawCookie;
    expect(cookieHeader, 'expected a Set-Cookie header from GET /ui').toBeDefined();
    const cookie = cookieHeader!.split(';')[0];
    expect(cookie).toContain('apra_console_token=');
    const cookieHeaders = () => offBoxHeaders({ cookie });

    // --- (3) POST /api/fleet/credential-store-set with a REAL, unmocked ----
    //     credential store pointed at the temp data dir.
    const setRes = await request('POST', '/api/fleet/credential-store-set', {
      headers: cookieHeaders(),
      body: { name: CRED_NAME, prompt: 'Enter the off-box secret' },
    });
    bodies.push(setRes.body);
    expect(setRes.status, `body: ${setRes.body}`).toBe(200);
    const setPayload = JSON.parse(setRes.body) as { url?: unknown; expiresAt?: unknown };
    expect(typeof setPayload.url).toBe('string');
    expect(typeof setPayload.expiresAt).toBe('string');
    const url = setPayload.url as string;

    // The assertion the bug is actually about: no scheme, no loopback
    // address, no localhost, and no ':<port>' anywhere in the collection URL.
    // The port check is a REGEX for "a colon followed by digits" rather than
    // excluding only this server's own serverPort -- a regression that
    // stamped some OTHER port into the URL would slip past a check that only
    // knew to exclude the one port this test happens to be bound to.
    expect(url).not.toContain('://');
    expect(url).not.toContain('127.0.0.1');
    expect(url.toLowerCase()).not.toContain('localhost');
    expect(url).not.toMatch(/:\d+/);
    expect(url.startsWith('/')).toBe(true);

    // --- (4) Extract the token from the url fragment ------------------------
    const tokenMatch = url.match(/#\/secret-entry\/([0-9a-f]{64})/);
    expect(tokenMatch, `no secret-entry token found in url: ${url}`).not.toBeNull();
    const token = tokenMatch![1];

    const promptRes = await request('POST', '/api/secret-entry/prompt', {
      headers: cookieHeaders(),
      body: { token },
    });
    bodies.push(promptRes.body);
    expect(promptRes.status, `body: ${promptRes.body}`).toBe(200);
    const promptPayload = JSON.parse(promptRes.body) as { name?: unknown; prompt?: unknown };
    expect(promptPayload.name).toBe(CRED_NAME);
    expect(typeof promptPayload.prompt).toBe('string');

    const submitRes = await request('POST', '/api/secret-entry/submit', {
      headers: cookieHeaders(),
      body: { token, value: SENTINEL },
    });
    bodies.push(submitRes.body);
    expect(submitRes.status, `body: ${submitRes.body}`).toBe(200);
    expect(JSON.parse(submitRes.body)).toEqual({ ok: true });

    // --- (5) POST /api/fleet/credential-store-list -> the NAME is present, --
    //     never a "value" key on any entry.
    const listRes = await request('POST', '/api/fleet/credential-store-list', {
      headers: cookieHeaders(),
      body: {},
    });
    bodies.push(listRes.body);
    expect(listRes.status, `body: ${listRes.body}`).toBe(200);
    const listPayload = JSON.parse(listRes.body) as { credentials?: Array<Record<string, unknown>> };
    expect(Array.isArray(listPayload.credentials)).toBe(true);
    const entry = listPayload.credentials!.find((e) => e.name === CRED_NAME);
    expect(entry, `no "${CRED_NAME}" entry in ${JSON.stringify(listPayload.credentials)}`).toBeDefined();
    for (const e of listPayload.credentials!) {
      expect(Object.keys(e)).not.toContain('value');
    }

    // --- (6) Re-POST the same token -> 404 (single use survives the real ----
    //     path).
    const secondSubmitRes = await request('POST', '/api/secret-entry/submit', {
      headers: cookieHeaders(),
      body: { token, value: 'second-attempt-value' },
    });
    bodies.push(secondSubmitRes.body);
    expect(secondSubmitRes.status).toBe(404);

    // --- (7) LEAKAGE SWEEP: the sentinel appears in none of the response ----
    //     bodies collected above, and nothing written to the fleet log.
    for (const body of bodies) {
      expect(body).not.toContain(SENTINEL);
    }
    const loggedText = [...logLineSpy.mock.calls, ...logErrorSpy.mock.calls]
      .map((call) => JSON.stringify(call))
      .join('\n');
    // Anti-vacuity: prove the spies actually captured something from the
    // real submit route (src/console/routes/secret-entry.ts's logLine call),
    // so this sweep cannot pass vacuously if that log call is ever removed
    // and there is nothing left to sweep for a leak in the first place.
    expect(logLineSpy.mock.calls.length + logErrorSpy.mock.calls.length).toBeGreaterThan(0);
    expect(loggedText).toContain('secret_entry');
    expect(loggedText).toContain('submit');
    expect(loggedText).not.toContain(SENTINEL);
    expect(loggedText).not.toContain(token);

    // --- (8) Without the cookie/bearer, POST /api/secret-entry/submit -> ----
    //     401 (the off-box path did not open a new unauthenticated door).
    const unauthedRes = await request('POST', '/api/secret-entry/submit', {
      headers: offBoxHeaders(),
      body: { token, value: 'irrelevant' },
    });
    expect(unauthedRes.status).toBe(401);
  });

  it('the bearer credential path also works off-box (no cookie needed)', async () => {
    const setRes = await request('POST', '/api/fleet/credential-store-set', {
      headers: bearerHeaders(),
      body: { name: 'offbox-bearer-cred', prompt: 'Enter another secret' },
    });
    expect(setRes.status, `body: ${setRes.body}`).toBe(200);
    const { url } = JSON.parse(setRes.body) as { url: string };
    expect(url).not.toContain('://');
    expect(url).not.toContain('127.0.0.1');
  });
});
