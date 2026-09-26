/**
 * apra-fleet-i9ag.3.4 -- CONSOLE SIDE of "Sprints page reachable and live
 * through the console /ext hop".
 *
 * The end-to-end check for the Sprints-in-the-console feature, driven entirely
 * through REAL components:
 *
 *   - the REAL apra-fleet console/MCP server (`createHttpTransport`), so the
 *     console guard, the `/api/workflow-packages` route and the `/ext/<id>`
 *     reverse proxy are the shipped ones, not re-implementations;
 *   - the REAL workflow-package registry service, populated by the REAL
 *     supervisor SELF-REGISTERING over HTTP on boot -- nothing here hand-writes
 *     a registry entry or a manifest, so a manifest field the supervisor stops
 *     sending (or a registration call that never lands) fails this file;
 *   - the REAL `packages/apra-fleet-se/bin/serve.mjs` supervisor, as a
 *     subprocess on an OS-assigned port.
 *
 * The supervisor-side half of the same feature (registration URL/manifest, the
 * mount-prefix render, the supervisor's own guard, clean-stop unregister) lives
 * in packages/apra-fleet-se/test/i9ag34-sprints-console-hop-e2e.test.mjs. The
 * split is by language/runtime, not by importance: neither side has to import
 * the other's internals. Both files are additive -- no suite an impl task in
 * this sprint owns (tests/console-proxy.test.ts, registration.test.mjs, the
 * supervisor dashboard/launch-form suites) is touched.
 *
 * WHY THE SUPERVISOR IS A REAL SUBPROCESS AND NOT A STUB UPSTREAM
 * --------------------------------------------------------------
 * Every criterion here is a CROSS-COMPONENT property: the console derives a
 * per-package credential and the supervisor must accept exactly that value; the
 * console stamps a mount-path header and the supervisor must render against
 * exactly that; the console probes the manifest's health path and the
 * supervisor must answer 200 there. A stub upstream would be written to agree
 * with the console by construction, which is precisely the agreement under
 * test, so it could not falsify any of them.
 *
 * DETERMINISM (runs under the bounded runner on Linux, macOS and Windows CI)
 *  - every listener binds port 0 and reads the assigned port back; no port
 *    literal anywhere, and the reserved staging ports are never touched;
 *  - no fixed sleeps: every wait is a bounded poll on a real condition, and the
 *    bound is a FAILURE bound a passing run never reaches;
 *  - nothing POSIX-only. The supervisor is stopped through its own in-band
 *    POST /api/shutdown, with SIGKILL only as the afterAll backstop;
 *  - no shell-level variable expansion in the spawned command: the script path
 *    and every env value are resolved in JavaScript and passed to spawn() as
 *    structured argv/env;
 *  - HOME/USERPROFILE are redirected to a per-run temp dir, so the fleet key
 *    this file mints (and hands the supervisor) is never the developer's own;
 *  - the supervisor subprocess runs in a FRESH TEMP CWD, never the checkout:
 *    the dashboard renders whatever tracker it discovers from cwd, so running
 *    it in the repo would embed this clone's live backlog (megabytes of rows
 *    that change every sprint) into the document under test.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createHttpTransport, type HttpTransportHandle } from '../src/services/http-transport.js';
import { getOrCreateKey } from '../src/services/jwt.js';
import { FLEET_DIR } from '../src/paths.js';
import { MOUNT_PATH_HEADER } from '../src/console/proxy.js';
import {
  workflowPackageService,
  createWorkflowPackageService,
  OFFLINE_THRESHOLD_MS,
} from '../src/services/workflow-packages.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

function noop(_server: McpServer): void {
  // no tools registered -- this suite never opens an /mcp session
}

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname_, '..');
const SERVE_BIN = path.join(REPO_ROOT, 'packages', 'apra-fleet-se', 'bin', 'serve.mjs');

/**
 * The workflow-package id the supervisor registers itself under. Deliberately a
 * literal here rather than imported from the supervisor package: from the
 * console's side this id is WIRE INPUT that arrives over HTTP from a
 * third-party package, and asserting it against a constant imported from that
 * same package would make the assertion unfalsifiable (both sides would move
 * together). If the supervisor ever changes its id, this file SHOULD fail --
 * that is a breaking change to the registered nav/mount path.
 */
const PACKAGE_ID = 'se';
const MOUNT_PREFIX = `/ext/${PACKAGE_ID}`;
/** The manifest nav path the Sprints entry is expected to declare -- wire input
 *  for the same reason as PACKAGE_ID above. */
const SPRINTS_NAV_PATH = '/ui/sprints';

/** FAILURE bound on every poll below. A passing run never waits for it. */
const POLL_TIMEOUT_MS = 60_000;

// -----------------------------------------------------------------------------
// Lifecycle
// -----------------------------------------------------------------------------
let realHome: string | undefined;
let realUserProfile: string | undefined;
let tempHome: string;
let tempDirs: string[] = [];
let fleetKey: string;
let consoleHandle: HttpTransportHandle;
let consoleSockets: net.Socket[] = [];
let supervisor: ChildProcess | undefined;
let supervisorPort: number;
let supervisorExited = false;
let supervisorOutput = '';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function mkTmp(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Allocate a currently-free TCP port by binding to 0 and reading it back. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** One HTTP round trip against 127.0.0.1:<port>. JSON-encodes `body`. */
function request(
  port: number,
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
      { hostname: '127.0.0.1', port, path: urlPath, method, headers: outHeaders },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** The console credential a browser/CLI presents. The bearer path accepts the
 *  raw fleet key (src/console/server.ts), which is what CLI callers use. */
function consoleAuth(): Record<string, string> {
  return { authorization: `Bearer ${fleetKey}` };
}

/** Poll until `pred()` is truthy, or fail with a message that names what was
 *  being waited on plus the supervisor's own output. */
async function waitFor(pred: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    if (supervisorExited) {
      throw new Error(`${label}: the supervisor subprocess exited early.\nsupervisor output:\n${supervisorOutput}`);
    }
    if (await pred()) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${POLL_TIMEOUT_MS}ms waiting for ${label}.\nsupervisor output:\n${supervisorOutput}`);
    }
    await sleep(150);
  }
}

/** The registry as the CONSOLE reports it over HTTP, with the health poll the
 *  route performs on every call. */
async function listPackagesViaConsole(): Promise<Array<Record<string, unknown>>> {
  const res = await request(consoleHandle.port, 'GET', '/api/workflow-packages', { headers: consoleAuth() });
  expect(res.status).toBe(200);
  return (JSON.parse(res.body) as { packages: Array<Record<string, unknown>> }).packages;
}

/**
 * Every absolute app-path the rendered dashboard EMITS: the target of an
 * `href="..."`/`action="..."`/`src="..."` attribute, a `fetch('...')` call, a
 * `new EventSource('...')` construction, or a `link.href = '...'` assignment.
 * Only literals rooted at '/' are collected.
 */
function emittedAppPaths(html: string): string[] {
  const sweep = /(?:href="|action="|src="|fetch\('|new EventSource\('|link\.href = ')(\/[A-Za-z0-9._~/%-]*)/g;
  return Array.from(html.matchAll(sweep)).map((m) => m[1]);
}

beforeAll(async () => {
  // Mirrors tests/console-proxy.test.ts's guard: this file REGISTERS packages
  // (the supervisor does, over HTTP), which writes workflow-packages.json under
  // FLEET_DIR. Prove FLEET_DIR resolved to the per-run isolated temp dir before
  // anything is written, so an import-order break can never have this file
  // write into a developer's real ~/.apra-fleet/data.
  if (!process.env.APRA_FLEET_DATA_DIR || FLEET_DIR !== process.env.APRA_FLEET_DATA_DIR) {
    throw new Error(
      `Refusing to write under FLEET_DIR ("${FLEET_DIR}"): it does not match the isolated ` +
      `APRA_FLEET_DATA_DIR ("${process.env.APRA_FLEET_DATA_DIR}"), so it may resolve under the ` +
      'real home directory instead of a per-run isolated temp dir.',
    );
  }

  realHome = process.env.HOME;
  realUserProfile = process.env.USERPROFILE;
  tempHome = await mkTmp('i9ag34-console-home-');
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;

  // ONE fleet key, minted through the real accessor into the temp home. The
  // console verifies its guard against it, derives the per-package credential
  // from it, and the supervisor reads the SAME file as its own service token --
  // which is what makes the whole hop work without any value being copied
  // between the two by this test.
  fleetKey = getOrCreateKey();
  expect(fleetKey).toHaveLength(64);

  consoleHandle = await createHttpTransport({ registerTools: noop, preferredPort: 0 });
  consoleHandle.httpServer.on('connection', (s) => consoleSockets.push(s));

  // The supervisor discovers its apra-fleet server exactly as in production:
  // through <its own data dir>/server.json, whose `url` is the MCP endpoint.
  // Written verbatim in the real server's shape (src/index.ts) -- including the
  // '/mcp' suffix -- so this test exercises the real resolution path rather
  // than a convenient fiction.
  const supervisorFleetDataDir = await mkTmp('i9ag34-sv-fleet-data-');
  const supervisorSeDataDir = await mkTmp('i9ag34-sv-se-data-');
  const supervisorCwd = await mkTmp('i9ag34-sv-cwd-');
  await fsp.writeFile(
    path.join(supervisorFleetDataDir, 'server.json'),
    JSON.stringify({ pid: process.pid, port: consoleHandle.port, url: consoleHandle.url }),
    'utf8',
  );

  supervisorPort = await getFreePort();
  supervisor = spawn(process.execPath, [SERVE_BIN, '--port', String(supervisorPort)], {
    cwd: supervisorCwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      APRA_FLEET_DATA_DIR: supervisorFleetDataDir,
      FLEET_SE_DATA_DIR: supervisorSeDataDir,
      HOME: tempHome,
      USERPROFILE: tempHome,
    },
  });
  supervisor.stdout?.on('data', (c: Buffer) => { supervisorOutput += c.toString('utf8'); });
  supervisor.stderr?.on('data', (c: Buffer) => { supervisorOutput += c.toString('utf8'); });
  supervisor.on('exit', () => { supervisorExited = true; });

  await waitFor(async () => {
    try {
      // /api/health sits behind the supervisor's own guard, so an
      // unauthenticated 401 is as good a liveness signal as a 200.
      const res = await request(supervisorPort, 'GET', '/api/health');
      return res.status === 200 || res.status === 401;
    } catch {
      return false;
    }
  }, 'the supervisor subprocess to answer /api/health');

  // Self-registration lands over HTTP against the real console route; nothing
  // here writes the registry entry.
  await waitFor(
    async () => (await listPackagesViaConsole()).some((p) => p.id === PACKAGE_ID),
    `the supervisor to self-register as workflow package "${PACKAGE_ID}" with the console`,
  );
}, 180_000);

afterAll(async () => {
  if (supervisor?.pid && !supervisorExited) {
    try { process.kill(supervisor.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  for (const socket of consoleSockets.splice(0)) socket.destroy();
  if (consoleHandle) {
    try { await consoleHandle.close(); } catch { /* already down */ }
  }
  await workflowPackageService.unregister(PACKAGE_ID).catch(() => undefined);
  process.env.HOME = realHome;
  if (realUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = realUserProfile;
  for (const dir of tempDirs.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// =============================================================================
// The tests run in declaration order within this file, and the LAST one stops
// the supervisor (that is the property it asserts). It re-asserts liveness at
// its own start, so if the order ever changed it would fail loudly rather than
// pass vacuously against an already-dead supervisor.
// =============================================================================

describe('apra-fleet-i9ag.3.4: Sprints page reachable and live through the console /ext hop', () => {
  // ---------------------------------------------------------------------------
  // (1) The registry lists the supervisor, online, with its Sprints nav entry.
  // ---------------------------------------------------------------------------

  it('GET /api/workflow-packages lists the registered supervisor with offline:false and a Sprints nav entry', async () => {
    const packages = await listPackagesViaConsole();
    const pkg = packages.find((p) => p.id === PACKAGE_ID);
    expect(pkg, `no "${PACKAGE_ID}" entry in ${JSON.stringify(packages)}`).toBeDefined();

    // Registered at runtime (not config-declared) and pointing at the real
    // supervisor we spawned -- not some other listener that happened to answer.
    expect(pkg!.configDeclared).toBe(false);
    expect(pkg!.configError).toBeNull();
    expect(pkg!.baseUrl).toBe(`http://127.0.0.1:${supervisorPort}`);
    expect(pkg!.offline).toBe(false);

    // The manifest survived the round trip: the console persisted, re-validated
    // on read, and re-served the health path and the nav entry the shell needs
    // to render a Sprints item at all.
    expect(pkg!.health).toBe('/api/health');
    expect(pkg!.nav).toEqual(
      expect.arrayContaining([{ label: 'Sprints', path: SPRINTS_NAV_PATH }]),
    );
    // Unscoped: a scope:'project' entry would be dropped by the shell nav until
    // a project is selected, so the Sprints item would not render at all.
    const sprints = (pkg!.nav as Array<Record<string, unknown>>).find((e) => e.label === 'Sprints');
    expect(sprints).not.toHaveProperty('scope');

    // The health poll actually RAN (the route refreshes on every call).
    expect(pkg!.lastCheckedAt).toBeTypeOf('number');
  });

  it('offline:false is earned by a real credentialed probe of the manifest health path, not by the offline threshold not having elapsed', async () => {
    // `offline` only flips true once a probe has been FAILING for
    // OFFLINE_THRESHOLD_MS, so a bare `offline: false` a moment after boot
    // would also hold if every probe had been 401ing. Pin the difference with
    // an injected clock over the SAME registry file the console just wrote:
    // probe once for real, then jump the clock well past the threshold. Still
    // online => the probe genuinely SUCCEEDED (the failure streak is empty).
    // Had the supervisor rejected the console's derived credential, the same
    // jump would report offline:true.
    let now = Date.now();
    const service = createWorkflowPackageService({ now: () => now });
    await service.refreshHealth();
    expect(service.list().find((p) => p.id === PACKAGE_ID)?.offline).toBe(false);

    now += OFFLINE_THRESHOLD_MS * 2;
    const afterJump = service.list().find((p) => p.id === PACKAGE_ID);
    expect(afterJump?.offline).toBe(false);
    expect(afterJump?.baseUrl).toBe(`http://127.0.0.1:${supervisorPort}`);
  });

  it('GET /api/workflow-packages is 401 without a console credential', async () => {
    const res = await request(consoleHandle.port, 'GET', '/api/workflow-packages');
    expect(res.status).toBe(401);
  });

  // ---------------------------------------------------------------------------
  // (2) The Sprints page renders through the hop, fully re-rooted under /ext/se.
  // ---------------------------------------------------------------------------

  it(`GET ${MOUNT_PREFIX}${SPRINTS_NAV_PATH} answers 200 with the real dashboard and every app-path rooted under ${MOUNT_PREFIX}`, async () => {
    // Exactly what the shell's iframe requests: the registry nav path, appended
    // to the package's /ext mount point.
    const res = await request(consoleHandle.port, 'GET', `${MOUNT_PREFIX}${SPRINTS_NAV_PATH}`, {
      headers: consoleAuth(),
    });
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/html');

    // The REAL dashboard, not the /ui placeholder the supervisor answers every
    // other /ui path with.
    for (const marker of [
      'Fleet-Sprint Supervisor',
      'Sprint Stack',
      'id="sprint-stack"',
      'Launch Sprint',
      'id="launch-sprint-form"',
    ]) {
      expect(res.body, `real dashboard marker missing: ${marker}`).toContain(marker);
    }

    // Nothing is still rooted at the console root, and nothing is double-
    // prefixed. A path left at '/x' would 404 against the console; a '/ext/se/
    // ext/se/x' would 404 against the supervisor.
    const paths = emittedAppPaths(res.body);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      expect(p, `left rooted at '/': ${p}`).toMatch(new RegExp(`^${MOUNT_PREFIX}/`));
      expect(p.indexOf(MOUNT_PREFIX, 1), `prefixed more than once: ${p}`).toBe(-1);
    }

    // The live view must stay live once the page is running: the client-side
    // refresh re-renders rows in the browser, so both the resolved prefix and
    // the helper that applies it have to reach the document.
    expect(res.body).toContain(`var MOUNT_PREFIX = '${MOUNT_PREFIX}';`);
    expect(res.body).toContain('function mountHref(mountPrefix, appPath)');
    // The prefix the page received is the proxy's own computed mount path.
    expect(MOUNT_PATH_HEADER).toBe('x-apra-fleet-mount-path');
  });

  it('a client-supplied mount-path header cannot move the mount point -- the proxy strips it and its own value wins', async () => {
    const res = await request(consoleHandle.port, 'GET', `${MOUNT_PREFIX}${SPRINTS_NAV_PATH}`, {
      headers: { ...consoleAuth(), [MOUNT_PATH_HEADER]: '/ext/spoofed' },
    });
    expect(res.status).toBe(200);
    expect(res.body).not.toContain('/ext/spoofed');
    expect(res.body).toContain(`var MOUNT_PREFIX = '${MOUNT_PREFIX}';`);
  });

  // ---------------------------------------------------------------------------
  // (3) The credentialed hop: 200 with a console credential, 401 without.
  // ---------------------------------------------------------------------------

  it(`GET ${MOUNT_PREFIX}/api/health answers 200 with the console credential and 401 without any credential`, async () => {
    const authorized = await request(consoleHandle.port, 'GET', `${MOUNT_PREFIX}/api/health`, {
      headers: consoleAuth(),
    });
    expect(authorized.status, `body: ${authorized.body}`).toBe(200);
    // The answer came from the supervisor, not from the console.
    const health = JSON.parse(authorized.body) as Record<string, unknown>;
    expect(health).toHaveProperty('status');

    // GET /ext/* is intentionally NOT 401ed by the console guard, but an
    // uncredentialed GET is proxied WITHOUT the derived per-package credential
    // -- so the supervisor's own guard is what answers 401 here. That 401 is
    // the whole point: it proves the 200 above was earned by a credential the
    // console attached, not by an unguarded route.
    const anonymous = await request(consoleHandle.port, 'GET', `${MOUNT_PREFIX}/api/health`);
    expect(anonymous.status).toBe(401);
  });

  it('an unknown package id is 404 through the same hop -- a 200 above is not the proxy answering for anything', async () => {
    const res = await request(consoleHandle.port, 'GET', '/ext/no-such-package/api/health', {
      headers: consoleAuth(),
    });
    expect(res.status).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // (4) The launch form's POST target: routed and authorised, nothing launched.
  // ---------------------------------------------------------------------------

  it("the launch form's POST target is reachable and authorised through the same /ext hop (no sprint is launched)", async () => {
    // Read the submit target out of the page the hop actually served, rather
    // than hardcoding it, so this asserts the path the rendered form posts to.
    const page = await request(consoleHandle.port, 'GET', `${MOUNT_PREFIX}${SPRINTS_NAV_PATH}`, {
      headers: consoleAuth(),
    });
    expect(page.status).toBe(200);
    const submitPath = emittedAppPaths(page.body).find((p) => p.endsWith('/api/sprints'));
    expect(submitPath, 'the rendered launch form emits no /api/sprints target').toBe(`${MOUNT_PREFIX}/api/sprints`);

    const listBefore = await request(consoleHandle.port, 'GET', `${MOUNT_PREFIX}/api/sprints`, {
      headers: consoleAuth(),
    });
    expect(listBefore.status).toBe(200);

    // Routed AND authorised: an empty body is rejected by the supervisor's own
    // launch-request validator (400, naming the offending field), which only
    // runs after the /ext hop resolved the package, forwarded the derived
    // credential, and the supervisor's guard accepted it. A 401 would mean the
    // credential never made it; a 404 would mean the route was never reached.
    // Deliberately invalid input -- this asserts routing and auth, and must
    // never start a real sprint.
    const routed = await request(consoleHandle.port, 'POST', submitPath!, {
      headers: consoleAuth(),
      body: {},
    });
    expect(routed.status, `body: ${routed.body}`).toBe(400);
    expect(JSON.parse(routed.body)).toMatchObject({ field: 'issue' });

    // Without a credential the console guard itself refuses: a non-GET /ext
    // request is guarded, so this 401 comes from the console, before the
    // supervisor is ever contacted.
    const anonymous = await request(consoleHandle.port, 'POST', submitPath!, { body: {} });
    expect(anonymous.status).toBe(401);

    // Nothing was launched.
    const listAfter = await request(consoleHandle.port, 'GET', `${MOUNT_PREFIX}/api/sprints`, {
      headers: consoleAuth(),
    });
    expect(listAfter.status).toBe(200);
    expect(JSON.parse(listAfter.body)).toEqual(JSON.parse(listBefore.body));
  });

  // ---------------------------------------------------------------------------
  // (5) Clean stop: the entry is removed; and the offline threshold is honoured.
  // MUST BE LAST -- it stops the shared supervisor.
  // ---------------------------------------------------------------------------

  it('after a clean supervisor stop the registry entry is removed, and a still-registered dead package reads offline only once the documented threshold elapses', async () => {
    // Ordering guard: if this test ever ran before the others, it would be
    // asserting against an already-dead supervisor. Fail loudly instead.
    expect(supervisorExited, 'this case must run last -- the supervisor is already gone').toBe(false);
    expect((await listPackagesViaConsole()).some((p) => p.id === PACKAGE_ID)).toBe(true);

    // --- the "reads offline within the documented threshold" branch ---------
    // Asserted on an ISOLATED registry file (its own temp dir) so it does not
    // disturb the real registry the removal branch below checks. The entry
    // points at the supervisor's port; once the process is gone, the probe
    // fails -- but the package must NOT read offline until the failure streak
    // has actually lasted OFFLINE_THRESHOLD_MS. A transient blip is not an
    // outage, and reporting one as such is exactly what the threshold exists
    // to prevent.
    const isolatedRegistryDir = await mkTmp('i9ag34-threshold-registry-');
    let now = Date.now();
    const thresholdService = createWorkflowPackageService({
      filePath: path.join(isolatedRegistryDir, 'workflow-packages.json'),
      now: () => now,
    });
    expect(await thresholdService.register({
      id: PACKAGE_ID,
      baseUrl: `http://127.0.0.1:${supervisorPort}`,
      apraFleetApi: '*',
      health: '/api/health',
    })).toEqual({ ok: true });

    // --- the "entry is removed" branch -------------------------------------
    // The supervisor's own clean-shutdown path DELETEs its registry entry
    // against the real console route. Driven through the supervisor's in-band
    // POST /api/shutdown (the documented clean stop) -- not a signal, so this
    // is identical on Windows.
    const shutdown = await request(supervisorPort, 'POST', '/api/shutdown', {
      headers: { authorization: `Bearer ${fleetKey}` },
    });
    expect(shutdown.status, `body: ${shutdown.body}`).toBe(200);

    const exitDeadline = Date.now() + POLL_TIMEOUT_MS;
    while (!supervisorExited) {
      if (Date.now() > exitDeadline) {
        throw new Error(`the supervisor did not exit after POST /api/shutdown.\noutput:\n${supervisorOutput}`);
      }
      await sleep(150);
    }

    const removalDeadline = Date.now() + POLL_TIMEOUT_MS;
    for (;;) {
      const listed = await listPackagesViaConsole();
      if (!listed.some((p) => p.id === PACKAGE_ID)) break;
      if (Date.now() > removalDeadline) {
        throw new Error(
          `"${PACKAGE_ID}" was still registered ${POLL_TIMEOUT_MS}ms after a clean stop: ` +
          `${JSON.stringify(listed)}\nsupervisor output:\n${supervisorOutput}`,
        );
      }
      await sleep(150);
    }

    // Now the threshold branch, against the (now certainly dead) port.
    await thresholdService.refreshHealth();
    expect(
      thresholdService.list().find((p) => p.id === PACKAGE_ID)?.offline,
      'a single failed probe must not immediately read as offline',
    ).toBe(false);

    now += OFFLINE_THRESHOLD_MS - 1;
    await thresholdService.refreshHealth();
    expect(
      thresholdService.list().find((p) => p.id === PACKAGE_ID)?.offline,
      'must not read offline before the documented threshold has elapsed',
    ).toBe(false);

    now += 1;
    expect(
      thresholdService.list().find((p) => p.id === PACKAGE_ID)?.offline,
      'must read offline once the failure streak reaches the documented threshold',
    ).toBe(true);
  }, 180_000);
});
