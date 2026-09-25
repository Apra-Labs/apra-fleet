/**
 * Workflow-package registry: round-trip, version gate, offline health and
 * config merge (apra-fleet-iywi.3.3) -- the lane-level check for the
 * registry lane (apra-fleet-iywi.3: service + routes + config key).
 *
 * Two layers:
 *  - Direct construction of the service (createWorkflowPackageService) with
 *    every piece of I/O injected (clock, fetch, fs, server version, config
 *    packages) -- used for anything that needs a fake clock or a stub
 *    upstream (the offline-after-10-minutes case, the tmp+rename crash
 *    case, the version-gate cases), so nothing here depends on wall-clock
 *    time or a real network.
 *  - The REAL http-transport server (createHttpTransport) for the seam-level
 *    guarantees: register/list/unregister round trip over HTTP, the guard
 *    coupling (one unauthenticated 401), and the parameterised-route
 *    matcher not shadowing a literal sibling.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createHttpTransport, type HttpTransportHandle } from '../src/services/http-transport.js';
import { getOrCreateKey } from '../src/services/jwt.js';
import { FLEET_DIR } from '../src/paths.js';
import { _resetCache as resetUserConfigCache } from '../src/services/user-config.js';
import {
  createWorkflowPackageService,
  satisfiesVersionRange,
  normalizeServerVersion,
  validateWorkflowPackageBaseUrlScheme,
  OFFLINE_THRESHOLD_MS,
  DEFAULT_HEALTH_PATH,
  MAX_MANIFEST_ARRAY_ENTRIES,
} from '../src/services/workflow-packages.js';
import { deriveUpstreamCredential } from '@apralabs/apra-fleet-client/auth/local-token';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

function noop(_server: McpServer): void {
  // no tools registered -- this suite never opens an /mcp session
}

// Every mkdtemp'd registry dir this file creates, so the module-level
// afterEach below can remove them -- no leaked temp dirs after the suite.
const tmpRegistryDirs: string[] = [];

async function tmpRegistryPath(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wf-packages-'));
  tmpRegistryDirs.push(dir);
  return path.join(dir, 'workflow-packages.json');
}

afterEach(async () => {
  for (const dir of tmpRegistryDirs.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

function okResponse(): Response {
  return { ok: true, status: 200 } as Response;
}

function failResponse(status = 503): Response {
  return { ok: false, status } as Response;
}

// -----------------------------------------------------------------------------
// Layer 1: direct service construction, fully injected I/O.
// -----------------------------------------------------------------------------

describe('workflow-package registry service: version gate', () => {
  it('accepts a compatible range and rejects an incompatible one against a v-prefixed, hash-suffixed server version', async () => {
    const filePath = await tmpRegistryPath();
    const compatible = createWorkflowPackageService({
      filePath, now: () => 1000, getServerVersion: () => 'v0.5.0_ab12cd', getConfigPackages: () => [],
    });
    expect(await compatible.register({ id: 'pkg-a', baseUrl: 'http://localhost:9001', apraFleetApi: '^0.5.0' })).toEqual({ ok: true });

    const incompatible = createWorkflowPackageService({
      filePath: await tmpRegistryPath(), now: () => 1000, getServerVersion: () => 'v0.5.0_ab12cd', getConfigPackages: () => [],
    });
    const result = await incompatible.register({ id: 'pkg-b', baseUrl: 'http://localhost:9002', apraFleetApi: '^0.6.0' });
    expect(result).toEqual({ ok: false, reason: 'incompatible', message: expect.stringContaining('0.5.0') });
  });

  it('reverting version normalisation would make the v-prefixed/hash-suffixed case fail -- pinned directly against normalizeServerVersion', () => {
    // This is the exact regression normalizeServerVersion exists to prevent:
    // without stripping "v" and "_<hash>", "v0.5.0_ab12cd" would fail
    // parseVersion entirely (not a bare MAJOR.MINOR.PATCH string).
    expect(normalizeServerVersion('v0.5.0_ab12cd')).toBe('0.5.0');
    expect(satisfiesVersionRange(normalizeServerVersion('v0.5.0_ab12cd'), '^0.5.0')).toBe(true);
    expect(() => satisfiesVersionRange('v0.5.0_ab12cd', '^0.5.0')).toThrow(/Unsupported/);
  });

  it('rejects an unsupported range syntax with a clear error rather than accepting it', async () => {
    const filePath = await tmpRegistryPath();
    const svc = createWorkflowPackageService({ filePath, now: () => 1000, getServerVersion: () => 'v1.0.0', getConfigPackages: () => [] });
    const result = await svc.register({ id: 'pkg-a', baseUrl: 'http://localhost:9001', apraFleetApi: '^1.0.0 || ^2.0.0' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid-range');
      expect(result.message).toMatch(/Unsupported/);
    }
    expect(svc.list()).toEqual([]);
  });
});

describe('workflow-package registry service: atomic persistence', () => {
  it('writes via tmp file + rename; the tmp path never survives a successful write', async () => {
    const filePath = await tmpRegistryPath();
    const svc = createWorkflowPackageService({ filePath, now: () => 1000, getServerVersion: () => 'v1.0.0', getConfigPackages: () => [] });

    expect(await svc.register({ id: 'pkg-a', baseUrl: 'http://localhost:9001', apraFleetApi: '*' })).toEqual({ ok: true });
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.existsSync(`${filePath}.tmp`)).toBe(false);
  });

  it('a crash between write and rename leaves the previous file intact', async () => {
    const filePath = await tmpRegistryPath();
    const first = createWorkflowPackageService({ filePath, now: () => 1000, getServerVersion: () => 'v1.0.0', getConfigPackages: () => [] });
    await first.register({ id: 'pkg-a', baseUrl: 'http://localhost:9001', apraFleetApi: '*' });
    const beforeCrash = fs.readFileSync(filePath, 'utf-8');

    let renameCalls = 0;
    const crashing = createWorkflowPackageService({
      filePath,
      now: () => 2000,
      getServerVersion: () => 'v1.0.0',
      getConfigPackages: () => [],
      fs: {
        mkdirSync: fs.mkdirSync,
        readFileSync: fs.readFileSync,
        writeFileSync: fs.writeFileSync,
        renameSync: () => {
          renameCalls += 1;
          throw new Error('simulated crash before rename completes');
        },
      },
    });

    await expect(
      crashing.register({ id: 'pkg-b', baseUrl: 'http://localhost:9002', apraFleetApi: '*' }),
    ).rejects.toThrow('simulated crash');
    expect(renameCalls).toBe(1);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(beforeCrash);
  });
});

describe('workflow-package registry service: config merge and unregister refusal', () => {
  it('merges config-declared entries with registered ones in list output', async () => {
    const filePath = await tmpRegistryPath();
    const svc = createWorkflowPackageService({
      filePath, now: () => 1000, getServerVersion: () => 'v1.0.0',
      getConfigPackages: () => [{ id: 'pkg-static', baseUrl: 'http://localhost:9100' }],
    });
    await svc.register({ id: 'pkg-a', baseUrl: 'http://localhost:9001', apraFleetApi: '*' });

    const ids = svc.list().map((p) => p.id).sort();
    expect(ids).toEqual(['pkg-a', 'pkg-static']);
    expect(svc.list().find((p) => p.id === 'pkg-static')).toMatchObject({ configDeclared: true, apraFleetApi: null });
    expect(svc.list().find((p) => p.id === 'pkg-a')).toMatchObject({ configDeclared: false, apraFleetApi: '*' });
  });

  it('refuses to unregister a config-declared package', async () => {
    const filePath = await tmpRegistryPath();
    const svc = createWorkflowPackageService({
      filePath, now: () => 1000, getServerVersion: () => 'v1.0.0',
      getConfigPackages: () => [{ id: 'pkg-static', baseUrl: 'http://localhost:9100' }],
    });
    expect(await svc.unregister('pkg-static')).toEqual({ ok: false, reason: 'config-declared' });
  });

  it('answers not-found for an id that was never registered', async () => {
    const filePath = await tmpRegistryPath();
    const svc = createWorkflowPackageService({ filePath, now: () => 1000, getServerVersion: () => 'v1.0.0', getConfigPackages: () => [] });
    expect(await svc.unregister('nope')).toEqual({ ok: false, reason: 'not-found' });
  });
});

describe('workflow-package registry service: health polling (fake clock, stub fetch)', () => {
  it('a poll rejection never propagates out of the service (never surfaces as a thrown error)', async () => {
    const filePath = await tmpRegistryPath();
    const svc = createWorkflowPackageService({
      filePath, now: () => 1000, getServerVersion: () => 'v1.0.0', getConfigPackages: () => [],
      fetchImpl: (async () => { throw new Error('network is down'); }) as unknown as typeof fetch,
    });
    await svc.register({ id: 'pkg-a', baseUrl: 'http://localhost:9001', apraFleetApi: '*' });
    await expect(svc.refreshHealth()).resolves.toBeUndefined();
    expect(svc.list()[0].offline).toBe(false); // just started failing, not yet 10 minutes
  });

  it('reports offline once a package has failed for 10 simulated minutes, and not before -- driven entirely by the fake clock', async () => {
    const filePath = await tmpRegistryPath();
    let clock = 0;
    const svc = createWorkflowPackageService({
      filePath, now: () => clock, getServerVersion: () => 'v1.0.0', getConfigPackages: () => [],
      fetchImpl: (async () => failResponse()) as unknown as typeof fetch,
    });
    await svc.register({ id: 'pkg-a', baseUrl: 'http://localhost:9001', apraFleetApi: '*' });

    clock = 1000;
    await svc.refreshHealth();
    expect(svc.list()[0].offline).toBe(false);

    clock = 1000 + OFFLINE_THRESHOLD_MS - 1;
    await svc.refreshHealth();
    expect(svc.list()[0].offline).toBe(false);

    clock = 1000 + OFFLINE_THRESHOLD_MS;
    await svc.refreshHealth();
    expect(svc.list()[0].offline).toBe(true);
  });

  it('a success resets the failure streak', async () => {
    const filePath = await tmpRegistryPath();
    let clock = 0;
    let healthy = false;
    const svc = createWorkflowPackageService({
      filePath, now: () => clock, getServerVersion: () => 'v1.0.0', getConfigPackages: () => [],
      fetchImpl: (async () => (healthy ? okResponse() : failResponse())) as unknown as typeof fetch,
    });
    await svc.register({ id: 'pkg-a', baseUrl: 'http://localhost:9001', apraFleetApi: '*' });

    clock = 1000;
    await svc.refreshHealth();
    clock = 1000 + OFFLINE_THRESHOLD_MS - 1;
    healthy = true;
    await svc.refreshHealth();
    expect(svc.list()[0].offline).toBe(false);

    clock = 1000 + OFFLINE_THRESHOLD_MS + 1;
    healthy = false;
    await svc.refreshHealth(); // streak restarts here, not from the original failure
    expect(svc.list()[0].offline).toBe(false);
  });
});

describe('workflow-package registry service: config-declared baseUrl scheme validation (apra-fleet-iywi.9/.12)', () => {
  it('a config-declared entry with a non-http(s) baseUrl is not silently dropped, and reports a distinct error from a genuinely unreachable http:// package', async () => {
    const filePath = await tmpRegistryPath();
    let clock = 0;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const svc = createWorkflowPackageService({
        filePath, now: () => clock, getServerVersion: () => 'v1.0.0',
        getConfigPackages: () => [
          { id: 'pkg-bad-scheme', baseUrl: 'ftp://localhost:9998' },
          { id: 'pkg-unreachable-http', baseUrl: 'http://localhost:9999' },
        ],
        // Drives the offline half through this injected fetch -- never a
        // real socket -- and OFFLINE_THRESHOLD_MS through the injected
        // clock above -- never real wall-clock time.
        fetchImpl: (async () => failResponse()) as unknown as typeof fetch,
      });

      // Not silently dropped: the misconfigured entry is present in list()
      // immediately, before refreshHealth() has ever run, with a specific
      // error naming the package id and the offending baseUrl.
      const badBeforePoll = svc.list().find((p) => p.id === 'pkg-bad-scheme');
      expect(badBeforePoll).toBeDefined();
      expect(badBeforePoll?.offline).toBe(true);
      expect(badBeforePoll?.configError).toContain('pkg-bad-scheme');
      expect(badBeforePoll?.configError).toContain('ftp://localhost:9998');
      expect(badBeforePoll?.configError).toMatch(/ftp:/);

      // A genuinely unreachable http:// package is NOT yet offline before
      // its first probe -- it carries no configError at all.
      const unreachableBeforePoll = svc.list().find((p) => p.id === 'pkg-unreachable-http');
      expect(unreachableBeforePoll?.configError).toBeNull();

      // Run the health poll past OFFLINE_THRESHOLD_MS via the fake clock so
      // the genuinely-unreachable http:// package ages into offline too --
      // the two must still be distinguishable at that point.
      clock = 1000;
      await svc.refreshHealth();
      clock = 1000 + OFFLINE_THRESHOLD_MS;
      await svc.refreshHealth();

      const bad = svc.list().find((p) => p.id === 'pkg-bad-scheme');
      const unreachable = svc.list().find((p) => p.id === 'pkg-unreachable-http');
      expect(bad?.offline).toBe(true);
      expect(unreachable?.offline).toBe(true);
      // Both report offline, but only the misconfigured one carries a
      // configError -- this is the observable difference the operator sees.
      expect(bad?.configError).not.toBeNull();
      expect(unreachable?.configError).toBeNull();

      // "Loud": refreshHealth() also logs the error, naming id and baseUrl,
      // rather than only degrading it into the ordinary offline health poll.
      expect(errorSpy.mock.calls.some(
        (call) => typeof call[0] === 'string' && call[0].includes('pkg-bad-scheme') && call[0].includes('ftp://localhost:9998'),
      )).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('reverting scheme validation would make the case above fail -- pinned directly against the shared validator', () => {
    // This is the exact regression validateWorkflowPackageBaseUrlScheme
    // exists to prevent: an ftp:// baseUrl parses fine as a WHATWG URL, so
    // only an explicit protocol check (not mere parsability) catches it.
    expect(validateWorkflowPackageBaseUrlScheme('http://localhost:9000')).toBeNull();
    expect(validateWorkflowPackageBaseUrlScheme('https://localhost:9000')).toBeNull();
    expect(validateWorkflowPackageBaseUrlScheme('ftp://localhost:9000')).toMatchObject({ scheme: 'ftp:' });
    expect(validateWorkflowPackageBaseUrlScheme('file:///etc/passwd')).toMatchObject({ scheme: 'file:' });
    expect(validateWorkflowPackageBaseUrlScheme('localhost:9000')).toMatchObject({ scheme: 'localhost:' });
  });
});

// -----------------------------------------------------------------------------
// Layer 2: the real HTTP surface (createHttpTransport).
// -----------------------------------------------------------------------------

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function rawRequest(port: number, method: string, urlPath: string, headers: Record<string, string> = {}, body?: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function bearerHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

const REGISTRY_FILE = path.join(FLEET_DIR, 'workflow-packages.json');
const CONFIG_FILE = path.join(FLEET_DIR, 'config.json');

let realHome: string | undefined;
let tempHome: string;
let registryBackup: string | null;
let configBackup: string | null;
const handles: HttpTransportHandle[] = [];

function backupFile(p: string): string | null {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return null; }
}

function restoreFile(p: string, backup: string | null): void {
  if (backup !== null) {
    fs.writeFileSync(p, backup, 'utf-8');
  } else {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }
  try { fs.unlinkSync(`${p}.tmp`); } catch { /* ignore */ }
}

beforeEach(async () => {
  // apra-fleet-iywi.8: gate the delete-then-restore-later cycle below behind an
  // explicit proof that FLEET_DIR resolved to the per-run isolated temp dir
  // (tests/setup.ts asserts this at import time and fails the whole run loudly if
  // not -- this is a second, local check so this file never unlinks a path that
  // could resolve under os.homedir() even if that guard were ever bypassed).
  if (!process.env.APRA_FLEET_DATA_DIR || FLEET_DIR !== process.env.APRA_FLEET_DATA_DIR) {
    throw new Error(
      `Refusing to delete files under FLEET_DIR ("${FLEET_DIR}"): it does not match the ` +
        `isolated APRA_FLEET_DATA_DIR ("${process.env.APRA_FLEET_DATA_DIR}"), so it may ` +
        'resolve under the real home directory instead of a per-run isolated temp dir.',
    );
  }

  realHome = process.env.HOME;
  tempHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'console-workflow-packages-home-'));
  process.env.HOME = tempHome;

  if (!fs.existsSync(FLEET_DIR)) fs.mkdirSync(FLEET_DIR, { recursive: true });
  registryBackup = backupFile(REGISTRY_FILE);
  configBackup = backupFile(CONFIG_FILE);
  try { fs.unlinkSync(REGISTRY_FILE); } catch { /* ignore */ }
  try { fs.unlinkSync(CONFIG_FILE); } catch { /* ignore */ }
  resetUserConfigCache();
});

afterEach(async () => {
  for (const handle of handles.splice(0)) {
    try { await handle.close(); } catch { /* ignore */ }
  }
  restoreFile(REGISTRY_FILE, registryBackup);
  restoreFile(CONFIG_FILE, configBackup);
  resetUserConfigCache();
  process.env.HOME = realHome;
  await fsp.rm(tempHome, { recursive: true, force: true }).catch(() => {});
});

async function startServer(): Promise<HttpTransportHandle> {
  const handle = await createHttpTransport({ registerTools: noop, preferredPort: 0 });
  handles.push(handle);
  return handle;
}

describe('workflow-package routes: register / list / unregister round trip over HTTP', () => {
  it('registers, lists and unregisters a package', async () => {
    const handle = await startServer();
    const fleetKey = getOrCreateKey();

    const registerRes = await rawRequest(
      handle.port, 'POST', '/api/workflow-packages/register', bearerHeader(fleetKey),
      JSON.stringify({ id: 'pkg-roundtrip', baseUrl: 'http://localhost:9201', apraFleetApi: '*' }),
    );
    expect(registerRes.status).toBe(200);

    const listRes = await rawRequest(handle.port, 'GET', '/api/workflow-packages', bearerHeader(fleetKey));
    expect(listRes.status).toBe(200);
    const listed = JSON.parse(listRes.body) as { packages: Array<{ id: string; baseUrl: string }> };
    expect(listed.packages.find((p) => p.id === 'pkg-roundtrip')).toMatchObject({ id: 'pkg-roundtrip', baseUrl: 'http://localhost:9201' });

    const unregisterRes = await rawRequest(handle.port, 'DELETE', '/api/workflow-packages/pkg-roundtrip', bearerHeader(fleetKey));
    expect(unregisterRes.status).toBe(200);

    const listAfter = await rawRequest(handle.port, 'GET', '/api/workflow-packages', bearerHeader(fleetKey));
    const listedAfter = JSON.parse(listAfter.body) as { packages: Array<{ id: string }> };
    expect(listedAfter.packages.find((p) => p.id === 'pkg-roundtrip')).toBeUndefined();
  });

  it('answers 409 for an incompatible apraFleetApi range', async () => {
    const handle = await startServer();
    const fleetKey = getOrCreateKey();
    const res = await rawRequest(
      handle.port, 'POST', '/api/workflow-packages/register', bearerHeader(fleetKey),
      JSON.stringify({ id: 'pkg-incompat-http', baseUrl: 'http://localhost:9202', apraFleetApi: '>=999.0.0' }),
    );
    expect(res.status).toBe(409);
  });

  it.each([
    ['an ftp:// baseUrl', 'ftp://localhost:9210', 'ftp:'],
    ['a file:/// baseUrl', 'file:///etc/passwd', 'file:'],
    ["a scheme-less 'localhost:9000' baseUrl", 'localhost:9000', 'localhost:'],
  ])('answers 400 naming the offending scheme for %s', async (_label, baseUrl, expectedScheme) => {
    const handle = await startServer();
    const fleetKey = getOrCreateKey();
    const res = await rawRequest(
      handle.port, 'POST', '/api/workflow-packages/register', bearerHeader(fleetKey),
      JSON.stringify({ id: 'pkg-bad-scheme-register', baseUrl, apraFleetApi: '*' }),
    );
    expect(res.status).toBe(400);
    const body = JSON.parse(res.body) as { error: string; field?: string };
    expect(body.field).toBe('baseUrl');
    expect(body.error).toContain(expectedScheme);

    // Never persisted -- confirms the rejected package can never reach the
    // registry file, and therefore never the /ext proxy.
    const listRes = await rawRequest(handle.port, 'GET', '/api/workflow-packages', bearerHeader(fleetKey));
    const listed = JSON.parse(listRes.body) as { packages: Array<{ id: string }> };
    expect(listed.packages.find((p) => p.id === 'pkg-bad-scheme-register')).toBeUndefined();
  });

  it.each([
    ['an http:// baseUrl', 'http://localhost:9211'],
    ['an https:// baseUrl', 'https://localhost:9212'],
  ])('still registers successfully with %s', async (_label, baseUrl) => {
    const handle = await startServer();
    const fleetKey = getOrCreateKey();
    const res = await rawRequest(
      handle.port, 'POST', '/api/workflow-packages/register', bearerHeader(fleetKey),
      JSON.stringify({ id: `pkg-good-scheme-${baseUrl.startsWith('https') ? 'https' : 'http'}`, baseUrl, apraFleetApi: '*' }),
    );
    expect(res.status).toBe(200);
  });

  it('answers 404 unregistering an id that was never registered', async () => {
    const handle = await startServer();
    const fleetKey = getOrCreateKey();
    const res = await rawRequest(handle.port, 'DELETE', '/api/workflow-packages/pkg-never-registered', bearerHeader(fleetKey));
    expect(res.status).toBe(404);
  });

  it('a config-declared package cannot be removed through the unregister route', async () => {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ workflowPackages: [{ id: 'pkg-static-http', baseUrl: 'http://localhost:9300' }] }), 'utf-8');
    resetUserConfigCache();

    const handle = await startServer();
    const fleetKey = getOrCreateKey();

    const listRes = await rawRequest(handle.port, 'GET', '/api/workflow-packages', bearerHeader(fleetKey));
    const listed = JSON.parse(listRes.body) as { packages: Array<{ id: string; configDeclared: boolean }> };
    expect(listed.packages.find((p) => p.id === 'pkg-static-http')).toMatchObject({ configDeclared: true });

    const deleteRes = await rawRequest(handle.port, 'DELETE', '/api/workflow-packages/pkg-static-http', bearerHeader(fleetKey));
    expect(deleteRes.status).toBe(409);
  });

  it('config-declared entries merge with registered ones in the list output', async () => {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ workflowPackages: [{ id: 'pkg-static-merge', baseUrl: 'http://localhost:9301' }] }), 'utf-8');
    resetUserConfigCache();

    const handle = await startServer();
    const fleetKey = getOrCreateKey();
    await rawRequest(
      handle.port, 'POST', '/api/workflow-packages/register', bearerHeader(fleetKey),
      JSON.stringify({ id: 'pkg-registered-merge', baseUrl: 'http://localhost:9302', apraFleetApi: '*' }),
    );

    const listRes = await rawRequest(handle.port, 'GET', '/api/workflow-packages', bearerHeader(fleetKey));
    const listed = JSON.parse(listRes.body) as { packages: Array<{ id: string }> };
    const ids = listed.packages.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['pkg-static-merge', 'pkg-registered-merge']));
  });

  it('a failing health poll never surfaces as a 500 on the list route', async () => {
    const handle = await startServer();
    const fleetKey = getOrCreateKey();
    await rawRequest(
      handle.port, 'POST', '/api/workflow-packages/register', bearerHeader(fleetKey),
      // Port 1 is a reserved/unroutable port -- the connection fails fast,
      // no real network round trip.
      JSON.stringify({ id: 'pkg-unreachable-http', baseUrl: 'http://127.0.0.1:1', apraFleetApi: '*' }),
    );
    const res = await rawRequest(handle.port, 'GET', '/api/workflow-packages', bearerHeader(fleetKey));
    expect(res.status).toBe(200);
    const listed = JSON.parse(res.body) as { packages: Array<{ id: string }> };
    expect(listed.packages.find((p) => p.id === 'pkg-unreachable-http')).toBeDefined();
  });
});

describe('workflow-package routes: guard coupling', () => {
  it('GET /api/workflow-packages with no credential answers 401 (the console guard covers this route automatically)', async () => {
    const handle = await startServer();
    const res = await rawRequest(handle.port, 'GET', '/api/workflow-packages');
    expect(res.status).toBe(401);
  });
});

describe('workflow-package routes: parameterised-path matcher', () => {
  it('the parameterised DELETE route resolves the captured id', async () => {
    const handle = await startServer();
    const fleetKey = getOrCreateKey();
    await rawRequest(
      handle.port, 'POST', '/api/workflow-packages/register', bearerHeader(fleetKey),
      JSON.stringify({ id: 'pkg-param-resolve', baseUrl: 'http://localhost:9401', apraFleetApi: '*' }),
    );
    const res = await rawRequest(handle.port, 'DELETE', '/api/workflow-packages/pkg-param-resolve', bearerHeader(fleetKey));
    expect(res.status).toBe(200);
  });

  it('a literal route sharing the same path shape as the parameterised DELETE route is never shadowed by it', async () => {
    const handle = await startServer();
    const fleetKey = getOrCreateKey();
    // DELETE /api/workflow-packages/register shares its exact pathname with
    // the literal, POST-only /api/workflow-packages/register route. If the
    // parameterised :id route wrongly captured it, this would attempt to
    // unregister a package literally named "register" and answer 404
    // (not-found). The literal route must win instead, answering 405
    // (method not allowed) since it never declares a DELETE handler.
    const res = await rawRequest(handle.port, 'DELETE', '/api/workflow-packages/register', bearerHeader(fleetKey));
    expect(res.status).toBe(405);
  });

  it('an unmatched path under the namespace still answers 404', async () => {
    const handle = await startServer();
    const fleetKey = getOrCreateKey();
    const res = await rawRequest(handle.port, 'GET', '/api/workflow-packages/some-id/extra-segment', bearerHeader(fleetKey));
    expect(res.status).toBe(404);
  });
});

describe('workflow-package routes: malformed percent-escape in a parameterised segment (apra-fleet-iywi.3.2)', () => {
  it('a malformed percent-escape answers 404, a well-formed one still decodes, and the server survives to answer the next request', async () => {
    const handle = await startServer();
    const fleetKey = getOrCreateKey();

    // A well-formed percent-encoded id must still decode to exactly the
    // value it decoded to before the guard -- so the fix cannot have been
    // satisfied by refusing to decode at all.
    await rawRequest(
      handle.port, 'POST', '/api/workflow-packages/register', bearerHeader(fleetKey),
      JSON.stringify({ id: 'pkg with space', baseUrl: 'http://localhost:9501', apraFleetApi: '*' }),
    );
    const wellFormedRes = await rawRequest(handle.port, 'DELETE', '/api/workflow-packages/pkg%20with%20space', bearerHeader(fleetKey));
    expect(wellFormedRes.status).toBe(200);

    // '%zz' is not a valid percent-escape (not two hex digits) --
    // decodeURIComponent throws URIError on it. Before the fix this was an
    // UNHANDLED REJECTION that killed the process before any response was
    // written; assert on the received status and body, never merely on "no
    // exception was thrown here" (an unhandled rejection cannot be awaited
    // by this test body at all).
    const malformedRes = await rawRequest(handle.port, 'DELETE', '/api/workflow-packages/%zz', bearerHeader(fleetKey));
    expect(malformedRes.status).toBe(404);
    expect(malformedRes.body.length).toBeGreaterThan(0);

    // A second malformed shape -- a trailing bare '%' with no hex digits
    // after it -- behaves identically.
    const trailingPercentRes = await rawRequest(handle.port, 'DELETE', '/api/workflow-packages/trailing%', bearerHeader(fleetKey));
    expect(trailingPercentRes.status).toBe(404);
    expect(trailingPercentRes.body.length).toBeGreaterThan(0);

    // The point of this case: the server SURVIVES. A test asserting only
    // the two 404s above would still pass against a process that dies a
    // moment later (an unhandled rejection has no synchronous relationship
    // to the client's response promise). Issue a normal request on the
    // SAME handle afterwards and require it to succeed.
    const survivedRes = await rawRequest(handle.port, 'GET', '/api/workflow-packages', bearerHeader(fleetKey));
    expect(survivedRes.status).toBe(200);
  });
});

// -----------------------------------------------------------------------------
// Manifest fields, credentialed health probe, and the holds/owner-ref consults.
//
// Split deliberately: the manifest round-trip and the 400-per-field rejections
// run over the REAL HTTP route (that is where the {error, field} contract
// lives), while the probe/consult cases run against a directly-constructed
// service with fetch, clock and fleet key all injected -- so no case here
// opens a socket to a package or depends on wall-clock time.
// -----------------------------------------------------------------------------

/** A baseUrl that fails to connect immediately (port 1 is unroutable), used
 *  where a case does not care about the probe result. */
const UNREACHABLE_BASE_URL = 'http://127.0.0.1:1';

const FULL_MANIFEST = {
  name: 'Example Package',
  process: 'example-process',
  version: '2.1.0',
  health: '/healthz',
  nav: [
    { label: 'Overview', path: '/ui/overview' },
    { label: 'Project View', path: '/ui/project', scope: 'project' },
  ],
  panels: [{ slot: 'member-detail', path: '/ui/panel' }],
  ownerRefs: '/api/owner-refs',
  holds: '/api/holds/:id',
};

describe('workflow-package manifest: register round trip over HTTP', () => {
  it('registers a full manifest and returns every optional field through GET /api/workflow-packages', async () => {
    const handle = await startServer();
    const fleetKey = getOrCreateKey();

    const registerRes = await rawRequest(
      handle.port, 'POST', '/api/workflow-packages/register', bearerHeader(fleetKey),
      JSON.stringify({ id: 'pkg-manifest', baseUrl: UNREACHABLE_BASE_URL, apraFleetApi: '*', ...FULL_MANIFEST }),
    );
    expect(registerRes.status).toBe(200);

    const listRes = await rawRequest(handle.port, 'GET', '/api/workflow-packages', bearerHeader(fleetKey));
    expect(listRes.status).toBe(200);
    const listed = JSON.parse(listRes.body) as { packages: Array<Record<string, unknown>> };
    const pkg = listed.packages.find((p) => p.id === 'pkg-manifest');

    expect(pkg).toMatchObject({
      id: 'pkg-manifest',
      name: 'Example Package',
      version: '2.1.0',
      health: '/healthz',
      ownerRefs: '/api/owner-refs',
      holds: '/api/holds/:id',
      panels: [{ slot: 'member-detail', path: '/ui/panel' }],
    });
    // nav round-trips with its per-entry scope intact -- the absent-scope and
    // 'project'-scope entries must stay distinguishable.
    expect(pkg?.nav).toEqual([
      { label: 'Overview', path: '/ui/overview' },
      { label: 'Project View', path: '/ui/project', scope: 'project' },
    ]);
  });

  it('re-registering the same id replaces the stored manifest rather than merging it', async () => {
    const handle = await startServer();
    const fleetKey = getOrCreateKey();

    await rawRequest(
      handle.port, 'POST', '/api/workflow-packages/register', bearerHeader(fleetKey),
      JSON.stringify({ id: 'pkg-replace', baseUrl: UNREACHABLE_BASE_URL, apraFleetApi: '*', ...FULL_MANIFEST }),
    );
    // Re-register WITHOUT the manifest (the supervisor re-registers on every
    // start; a dropped field must actually disappear, not linger).
    await rawRequest(
      handle.port, 'POST', '/api/workflow-packages/register', bearerHeader(fleetKey),
      JSON.stringify({ id: 'pkg-replace', baseUrl: UNREACHABLE_BASE_URL, apraFleetApi: '*' }),
    );

    const listRes = await rawRequest(handle.port, 'GET', '/api/workflow-packages', bearerHeader(fleetKey));
    const listed = JSON.parse(listRes.body) as { packages: Array<Record<string, unknown>> };
    const pkg = listed.packages.find((p) => p.id === 'pkg-replace');
    expect(pkg).toMatchObject({ name: null, version: null, health: null, ownerRefs: null, holds: null });
    expect(pkg?.nav).toEqual([]);
    expect(pkg?.panels).toEqual([]);
  });
});

describe('workflow-package manifest: a malformed optional field answers 400 and persists nothing', () => {
  it.each([
    ['a health path with no leading slash', { health: 'healthz' }, 'health'],
    ['a health path containing a ".." segment', { health: '/a/../../etc' }, 'health'],
    ['an ownerRefs given as an absolute URL', { ownerRefs: 'https://evil.example/refs' }, 'ownerRefs'],
    ['a protocol-relative holds path', { holds: '//evil.example/holds/:id' }, 'holds'],
    ['a holds path missing the ":id" placeholder', { holds: '/api/holds' }, 'holds'],
    ['an unknown nav scope', { nav: [{ label: 'X', path: '/x', scope: 'global' }] }, 'nav[0].scope'],
    ['a nav entry with an empty label', { nav: [{ label: '', path: '/x' }] }, 'nav[0].label'],
    [
      'an oversize nav array',
      { nav: Array.from({ length: MAX_MANIFEST_ARRAY_ENTRIES + 1 }, (_, i) => ({ label: `L${i}`, path: `/p${i}` })) },
      'nav',
    ],
    [
      'an oversize panels array',
      { panels: Array.from({ length: MAX_MANIFEST_ARRAY_ENTRIES + 1 }, (_, i) => ({ slot: `s${i}`, path: `/p${i}` })) },
      'panels',
    ],
  ])('answers 400 naming the offending field for %s', async (_label, badManifest, expectedField) => {
    const handle = await startServer();
    const fleetKey = getOrCreateKey();

    // Register a good package FIRST so the registry file exists and has
    // content -- otherwise "nothing was written" would be trivially true.
    await rawRequest(
      handle.port, 'POST', '/api/workflow-packages/register', bearerHeader(fleetKey),
      JSON.stringify({ id: 'pkg-untouched', baseUrl: UNREACHABLE_BASE_URL, apraFleetApi: '*' }),
    );
    const fileBefore = fs.readFileSync(REGISTRY_FILE, 'utf-8');

    const res = await rawRequest(
      handle.port, 'POST', '/api/workflow-packages/register', bearerHeader(fleetKey),
      JSON.stringify({ id: 'pkg-bad-manifest', baseUrl: UNREACHABLE_BASE_URL, apraFleetApi: '*', ...badManifest }),
    );
    expect(res.status).toBe(400);
    const body = JSON.parse(res.body) as { error: string; field?: string };
    expect(body.field).toBe(expectedField);
    expect(body.error).toBeTruthy();

    // NOTHING persisted: the registry file is byte-identical, so the rejected
    // package was never partially written and the good entry is untouched.
    expect(fs.readFileSync(REGISTRY_FILE, 'utf-8')).toBe(fileBefore);
    expect(fileBefore).not.toContain('pkg-bad-manifest');
  });
});

describe('workflow-package manifest: backward compatibility with a pre-manifest registry file', () => {
  it('a legacy workflow-packages.json without the new fields still loads and lists, with the fields null/[]', async () => {
    const filePath = await tmpRegistryPath();
    // Exactly the shape the registry wrote BEFORE the manifest fields
    // existed -- no name/version/health/nav/panels/ownerRefs/holds keys at all.
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        packages: [{ id: 'pkg-legacy', baseUrl: 'http://localhost:9600', apraFleetApi: '^1.0.0', registeredAt: 123 }],
      }),
      'utf-8',
    );

    const svc = createWorkflowPackageService({
      filePath, now: () => 1000, getServerVersion: () => 'v1.0.0', getConfigPackages: () => [],
      getFleetKey: () => 'k'.repeat(64),
    });

    const listed = svc.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: 'pkg-legacy',
      baseUrl: 'http://localhost:9600',
      apraFleetApi: '^1.0.0',
      name: null,
      version: null,
      health: null,
      ownerRefs: null,
      holds: null,
    });
    expect(listed[0].nav).toEqual([]);
    expect(listed[0].panels).toEqual([]);
  });
});

interface RecordedCall {
  url: string;
  authorization: string | undefined;
}

/** Build an injected fetch that records every call's URL and Authorization
 *  header and answers with `responder`. */
function recordingFetch(
  calls: RecordedCall[],
  responder: (url: string) => Response,
): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, authorization: headers.authorization });
    return responder(url);
  }) as unknown as typeof fetch;
}

const TEST_FLEET_KEY = 'f'.repeat(64);

describe('workflow-package health probe: manifest path + derived credential', () => {
  it('probes the manifest health path with Authorization Bearer set to the package-derived credential', async () => {
    const filePath = await tmpRegistryPath();
    const calls: RecordedCall[] = [];
    const svc = createWorkflowPackageService({
      filePath, now: () => 1000, getServerVersion: () => 'v1.0.0', getConfigPackages: () => [],
      getFleetKey: () => TEST_FLEET_KEY,
      fetchImpl: recordingFetch(calls, () => okResponse()),
    });
    await svc.register({ id: 'pkg-probe', baseUrl: 'http://localhost:9700', apraFleetApi: '*', health: '/custom/health' });

    await svc.refreshHealth();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://localhost:9700/custom/health');
    // The credential is the DERIVED, per-package one -- never the raw fleet key.
    expect(calls[0].authorization).toBe(`Bearer ${deriveUpstreamCredential(TEST_FLEET_KEY, 'pkg-probe')}`);
    expect(calls[0].authorization).not.toContain(TEST_FLEET_KEY);
    expect(svc.list()[0].offline).toBe(false);
  });

  it(`falls back to ${DEFAULT_HEALTH_PATH} when the manifest declares no health field`, async () => {
    const filePath = await tmpRegistryPath();
    const calls: RecordedCall[] = [];
    const svc = createWorkflowPackageService({
      filePath, now: () => 1000, getServerVersion: () => 'v1.0.0', getConfigPackages: () => [],
      getFleetKey: () => TEST_FLEET_KEY,
      fetchImpl: recordingFetch(calls, () => okResponse()),
    });
    await svc.register({ id: 'pkg-default-health', baseUrl: 'http://localhost:9701', apraFleetApi: '*' });

    await svc.refreshHealth();

    expect(calls[0].url).toBe(`http://localhost:9701${DEFAULT_HEALTH_PATH}`);
  });

  it('a 401 answer counts as a failed probe and ages into offline, exactly like an unreachable package', async () => {
    const filePath = await tmpRegistryPath();
    let clock = 0;
    const svc = createWorkflowPackageService({
      filePath, now: () => clock, getServerVersion: () => 'v1.0.0', getConfigPackages: () => [],
      getFleetKey: () => TEST_FLEET_KEY,
      // A guarded health route that REFUSES the credential. This must not be
      // mistaken for "the package answered, so it is up".
      fetchImpl: (async () => failResponse(401)) as unknown as typeof fetch,
    });
    await svc.register({ id: 'pkg-401', baseUrl: 'http://localhost:9702', apraFleetApi: '*', health: '/guarded' });

    clock = 1000;
    await svc.refreshHealth();
    expect(svc.list()[0].offline).toBe(false); // failing, but not yet 10 minutes

    clock = 1000 + OFFLINE_THRESHOLD_MS;
    await svc.refreshHealth();
    expect(svc.list()[0].offline).toBe(true);
  });
});

describe('workflow-package consultHolds', () => {
  async function holdsService(filePath: string, responder: (url: string) => Response, calls: RecordedCall[] = []) {
    const svc = createWorkflowPackageService({
      filePath, now: () => 1000, getServerVersion: () => 'v1.0.0', getConfigPackages: () => [],
      getFleetKey: () => TEST_FLEET_KEY,
      fetchImpl: recordingFetch(calls, responder),
    });
    return svc;
  }

  it('reports a held package, a not-held package, and replaces ":id" with the URL-encoded member id', async () => {
    const calls: RecordedCall[] = [];
    const svc = await holdsService(
      await tmpRegistryPath(),
      (url) => ({
        ok: true,
        status: 200,
        json: async () => (url.includes('9801') ? { held: true, reason: 'running a job' } : { held: false }),
      }) as unknown as Response,
      calls,
    );
    await svc.register({ id: 'pkg-holding', baseUrl: 'http://localhost:9801', apraFleetApi: '*', holds: '/api/holds/:id' });
    await svc.register({ id: 'pkg-free', baseUrl: 'http://localhost:9802', apraFleetApi: '*', holds: '/api/holds/:id' });

    const results = await svc.consultHolds('member/one?x');

    expect(results.find((r) => r.packageId === 'pkg-holding')).toEqual({
      packageId: 'pkg-holding', held: true, reason: 'running a job',
    });
    expect(results.find((r) => r.packageId === 'pkg-free')).toEqual({ packageId: 'pkg-free', held: false });

    // URL-encoded: a member id containing '/' or '?' must not change the
    // path shape or graft a query string onto the package's URL.
    const holdingCall = calls.find((c) => c.url.includes('9801'));
    expect(holdingCall?.url).toBe(`http://localhost:9801/api/holds/${encodeURIComponent('member/one?x')}`);
    expect(holdingCall?.url).not.toContain('?x');
    expect(holdingCall?.authorization).toBe(`Bearer ${deriveUpstreamCredential(TEST_FLEET_KEY, 'pkg-holding')}`);
  });

  it('an unreachable package comes back as an error entry rather than throwing or reading as "not held"', async () => {
    const svc = await holdsService(await tmpRegistryPath(), () => {
      throw new Error('connection refused');
    });
    await svc.register({ id: 'pkg-down', baseUrl: 'http://localhost:9803', apraFleetApi: '*', holds: '/api/holds/:id' });

    const results = await svc.consultHolds('member-1');

    expect(results).toHaveLength(1);
    expect(results[0].packageId).toBe('pkg-down');
    expect(results[0].error).toMatch(/connection refused/);
    // held is false ONLY because nothing is known -- the error is what says so.
    expect(results[0].held).toBe(false);
  });

  it('a non-ok HTTP answer is an error entry, not a verdict', async () => {
    const svc = await holdsService(await tmpRegistryPath(), () => failResponse(500));
    await svc.register({ id: 'pkg-500', baseUrl: 'http://localhost:9804', apraFleetApi: '*', holds: '/api/holds/:id' });

    const results = await svc.consultHolds('member-1');
    expect(results[0].error).toMatch(/500/);
  });

  it('a member id that cannot be URL-encoded (lone surrogate) degrades to an error entry rather than rejecting', async () => {
    const calls: RecordedCall[] = [];
    const svc = await holdsService(await tmpRegistryPath(), () => okResponse(), calls);
    await svc.register({ id: 'pkg-bad-id', baseUrl: 'http://localhost:9807', apraFleetApi: '*', holds: '/api/holds/:id' });

    // A lone surrogate is reachable straight off a JSON HTTP body: JSON.parse
    // of a "\udXXX" escape yields exactly this string, and encodeURIComponent
    // throws URIError on it. consultHolds is contracted never to throw, so
    // this must come back as this package's error entry.
    const loneSurrogate = JSON.parse('"\\ud800"') as string;

    const results = await svc.consultHolds(loneSurrogate);

    expect(results).toHaveLength(1);
    expect(results[0].packageId).toBe('pkg-bad-id');
    expect(results[0].error).toMatch(/URI malformed/i);
    // held is false ONLY because nothing is known -- never a verdict.
    expect(results[0].held).toBe(false);
    // The package was never contacted, so no half-formed URL escaped.
    expect(calls).toEqual([]);
  });

  it('a package that declares no holds path is skipped entirely, never reported as "not held"', async () => {
    const calls: RecordedCall[] = [];
    const svc = await holdsService(await tmpRegistryPath(), () => okResponse(), calls);
    await svc.register({ id: 'pkg-no-holds', baseUrl: 'http://localhost:9805', apraFleetApi: '*' });

    const results = await svc.consultHolds('member-1');

    // Absent from the results AND never contacted -- silence from a package
    // that was never asked must not read as consent.
    expect(results).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('an offline package is skipped, so a package known to be down cannot silently clear a hold', async () => {
    const filePath = await tmpRegistryPath();
    let clock = 0;
    const calls: RecordedCall[] = [];
    const svc = createWorkflowPackageService({
      filePath, now: () => clock, getServerVersion: () => 'v1.0.0', getConfigPackages: () => [],
      getFleetKey: () => TEST_FLEET_KEY,
      fetchImpl: recordingFetch(calls, () => failResponse(503)),
    });
    await svc.register({ id: 'pkg-offline', baseUrl: 'http://localhost:9806', apraFleetApi: '*', holds: '/api/holds/:id' });

    // Age it past the offline threshold on the fake clock.
    clock = 1000;
    await svc.refreshHealth();
    clock = 1000 + OFFLINE_THRESHOLD_MS;
    await svc.refreshHealth();
    expect(svc.list()[0].offline).toBe(true);

    calls.length = 0;
    const results = await svc.consultHolds('member-1');

    expect(results).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('workflow-package checkOwnerRef', () => {
  function ownerRefService(filePath: string, responder: (url: string) => Response, calls: RecordedCall[] = []) {
    return createWorkflowPackageService({
      filePath, now: () => 1000, getServerVersion: () => 'v1.0.0', getConfigPackages: () => [],
      getFleetKey: () => TEST_FLEET_KEY,
      fetchImpl: recordingFetch(calls, responder),
    });
  }

  const refsResponse = () => ({
    ok: true,
    status: 200,
    json: async () => ({ refs: [{ id: 'ref-known', name: 'Known Ref' }, { id: 'ref-other', name: 'Other' }] }),
  }) as unknown as Response;

  it('answers known: true for a ref the package lists, and known: false for one it does not', async () => {
    const calls: RecordedCall[] = [];
    const svc = ownerRefService(await tmpRegistryPath(), refsResponse, calls);
    await svc.register({ id: 'pkg-refs', baseUrl: 'http://localhost:9901', apraFleetApi: '*', ownerRefs: '/api/owner-refs' });

    expect(await svc.checkOwnerRef('pkg-refs', 'ref-known')).toEqual({ known: true });
    expect(await svc.checkOwnerRef('pkg-refs', 'ref-missing')).toEqual({ known: false });

    expect(calls[0].url).toBe('http://localhost:9901/api/owner-refs');
    expect(calls[0].authorization).toBe(`Bearer ${deriveUpstreamCredential(TEST_FLEET_KEY, 'pkg-refs')}`);
  });

  it('an unreachable package answers {error}, never a bare {known: false}', async () => {
    const svc = ownerRefService(await tmpRegistryPath(), () => {
      throw new Error('connection refused');
    });
    await svc.register({ id: 'pkg-refs-down', baseUrl: 'http://localhost:9902', apraFleetApi: '*', ownerRefs: '/api/owner-refs' });

    const result = await svc.checkOwnerRef('pkg-refs-down', 'ref-known');

    // "Could not ask" must be distinguishable from "asked, and the answer is
    // no" -- collapsing them would silently accept an unknown owner ref.
    expect(result).toHaveProperty('error');
    expect(result).not.toHaveProperty('known');
    expect((result as { error: string }).error).toMatch(/connection refused/);
  });

  it('an unregistered package, and one declaring no ownerRefs path, both answer {error}', async () => {
    const calls: RecordedCall[] = [];
    const svc = ownerRefService(await tmpRegistryPath(), refsResponse, calls);
    await svc.register({ id: 'pkg-no-refs', baseUrl: 'http://localhost:9903', apraFleetApi: '*' });

    expect(await svc.checkOwnerRef('pkg-never-registered', 'ref-known')).toMatchObject({
      error: expect.stringContaining('pkg-never-registered'),
    });
    expect(await svc.checkOwnerRef('pkg-no-refs', 'ref-known')).toMatchObject({
      error: expect.stringContaining('ownerRefs'),
    });
    // Neither case contacted anything.
    expect(calls).toEqual([]);
  });

  it('a response without a refs array is an error, not a silent known: false', async () => {
    const svc = ownerRefService(
      await tmpRegistryPath(),
      () => ({ ok: true, status: 200, json: async () => ({ unexpected: true }) }) as unknown as Response,
    );
    await svc.register({ id: 'pkg-bad-refs', baseUrl: 'http://localhost:9904', apraFleetApi: '*', ownerRefs: '/api/owner-refs' });

    const result = await svc.checkOwnerRef('pkg-bad-refs', 'ref-known');
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toMatch(/refs/);
  });
});
