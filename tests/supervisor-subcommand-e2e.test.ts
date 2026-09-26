import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveServiceToken } from '../packages/apra-fleet-se/src/supervisor/auth.mjs';
import { getOrCreateKey } from '../src/services/jwt.js';

// apra-fleet-i9ag.2.2.2 (end-to-end half) -- ONE real boot of the installed
// supervisor THROUGH `apra-fleet supervisor`, proving the launcher actually
// starts a working supervisor rather than merely calling a function.
//
// Isolation, in full (nothing here may touch the operator's real state):
//  - HOME/USERPROFILE point at a temp home, so the child's own
//    src/cli/config.ts (which captures os.homedir() at module load) resolves
//    <FLEET_BASE> inside the temp dir.
//  - The "installed" fleet-sprint tree is a symlink (junction on Windows) from
//    <tmpHome>/.apra-fleet/workflows/fleet-sprint to packages/apra-fleet-se.
//    That is deliberately NOT a packaging test -- packaging fidelity of the
//    installed tree is already owned by
//    packages/apra-fleet-se/test/installed-supervisor.test.mjs. What is under
//    test here is the LAUNCHER: path resolution, env defaults, single boot,
//    exit-code propagation.
//  - FLEET_SE_DATA_DIR / APRA_FLEET_DATA_DIR are fresh temp dirs, and
//    FLEET_SE_SWEEP_OWNER_DATA_DIR scopes the supervisor's dolt-orphan sweep to
//    this instance's data dir so it can never kill another instance's server.
//  - cwd is an unrelated temp dir with no .beads, so the supervisor takes its
//    documented "beads identity unknown" warning path instead of attaching to
//    any real tracker.
//  - The bearer is resolved the way the product resolves it --
//    resolveServiceToken() with `home` pointed at the temp home -- after
//    minting the shared fleet.key there with the product's own
//    getOrCreateKey(), so this asserts the fleet.key branch and never reads or
//    creates a token in the real ~/.apra-fleet.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST_INDEX = path.join(ROOT, 'dist', 'index.js');
const SE_PACKAGE = path.join(ROOT, 'packages', 'apra-fleet-se');

/** Never bind serve.mjs's DEFAULT_SERVICE_PORT, nor the reserved staging ports. */
const FORBIDDEN_PORTS = [8787, 7601, 8801];

const tmpDirs: string[] = [];
const children: ChildProcess[] = [];

async function mkTmp(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  // Resolve symlinks (macOS /var -> /private/var) so every path comparison and
  // every "is this inside my temp dir" check below is apples-to-apples.
  return fsp.realpath(dir);
}

/** Bind :0, read the port back, release it. Never returns a FORBIDDEN_PORT. */
function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => {
        if (FORBIDDEN_PORTS.includes(port)) {
          allocatePort().then(resolve, reject);
          return;
        }
        resolve(port);
      });
    });
  });
}

/** Resolves the listen error code, or null when the bind succeeded (port free). */
function tryBind(port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? 'EUNKNOWN'));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(null)));
  });
}

function request(
  port: number,
  pathname: string,
  method: string,
  token: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method,
        timeout: 5000,
        headers: { authorization: `Bearer ${token}` },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    req.end();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Booted {
  child: ChildProcess;
  port: number;
  token: string;
  tokenSource: string;
  output: () => string;
  exited: () => boolean;
  exitCode: () => number | null;
  seDataDir: string;
}

let booted: Booted | null = null;
let realFleetKeyBefore: { exists: boolean; mtimeMs: number };

function snapshotRealFleetKey(): { exists: boolean; mtimeMs: number } {
  const p = path.join(os.homedir(), '.apra-fleet', 'fleet.key');
  try {
    return { exists: true, mtimeMs: fs.statSync(p).mtimeMs };
  } catch {
    return { exists: false, mtimeMs: 0 };
  }
}

beforeAll(async () => {
  if (!fs.existsSync(DIST_INDEX)) {
    throw new Error(
      `dist/index.js not found at ${DIST_INDEX}. Run "npm run build" before "npm test" ` +
      `(CI's build step runs before tests).`,
    );
  }

  realFleetKeyBefore = snapshotRealFleetKey();

  const tmpHome = await mkTmp('supervisor-subcommand-home-');
  const seDataDir = await mkTmp('supervisor-subcommand-se-data-');
  const fleetDataDir = await mkTmp('supervisor-subcommand-fleet-data-');
  const cwd = await mkTmp('supervisor-subcommand-cwd-');

  // Stage the "installed" tree the launcher is contracted to find.
  const workflowsDir = path.join(tmpHome, '.apra-fleet', 'workflows');
  await fsp.mkdir(workflowsDir, { recursive: true });
  await fsp.symlink(
    SE_PACKAGE,
    path.join(workflowsDir, 'fleet-sprint'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  expect(fs.existsSync(path.join(workflowsDir, 'fleet-sprint', 'bin', 'serve.mjs'))).toBe(true);

  // Mint the SHARED fleet.key inside the temp home with the product's own
  // minting code (src/services/jwt.ts getOrCreateKey(), which resolves
  // os.homedir() lazily on every call -- see its header comment), then resolve
  // the bearer exactly as the supervisor does. Doing this BEFORE the spawn also
  // avoids racing the child's own first resolve.
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  let token: string;
  let tokenSource: string;
  try {
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    getOrCreateKey();
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  }
  const resolved = resolveServiceToken(seDataDir, { home: tmpHome });
  token = resolved.token;
  tokenSource = resolved.source;

  const port = await allocatePort();

  const child = spawn(process.execPath, [DIST_INDEX, 'supervisor', '--port', String(port)], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      FLEET_SE_DATA_DIR: seDataDir,
      APRA_FLEET_DATA_DIR: fleetDataDir,
      // Keep the dolt-orphan sweep from reaching any other instance on this machine.
      FLEET_SE_SWEEP_OWNER_DATA_DIR: seDataDir,
    },
  });
  children.push(child);

  let output = '';
  child.stdout?.on('data', (c) => { output += String(c); });
  child.stderr?.on('data', (c) => { output += String(c); });
  let exited = false;
  let exitCode: number | null = null;
  child.once('exit', (code) => { exited = true; exitCode = code; });

  booted = {
    child,
    port,
    token,
    tokenSource,
    seDataDir,
    output: () => output,
    exited: () => exited,
    exitCode: () => exitCode,
  };

  // Bounded boot wait; fail fast (with the captured output) if the child dies.
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (exited) {
      throw new Error(
        `'apra-fleet supervisor' exited (code=${exitCode}) before /api/health answered.\noutput:\n${output}`,
      );
    }
    const health = await request(port, '/api/health', 'GET', token).catch(() => null);
    if (health && health.status === 200) break;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for /api/health on port ${port}.\noutput so far:\n${output}`);
    }
    await sleep(200);
  }
}, 180_000);

afterAll(async () => {
  // Tear down even when an assertion above failed: no surviving child, no
  // leftover temp dirs.
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }
  children.length = 0;
  for (const dir of tmpDirs) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs.length = 0;
}, 30_000);

describe("'apra-fleet supervisor' end-to-end (apra-fleet-i9ag.2.2.2)", () => {
  it('uses neither serve.mjs DEFAULT_SERVICE_PORT (8787) nor the reserved staging ports (7601, 8801)', () => {
    expect(booted).not.toBeNull();
    expect(FORBIDDEN_PORTS).not.toContain(booted!.port);
  });

  it('boots the installed supervisor and answers GET /api/health 200 with the fleet.key bearer', async () => {
    const { port, token, tokenSource } = booted!;
    // The bearer really came from <tmpHome>/.apra-fleet/fleet.key, not from a
    // private/token fallback -- otherwise this would not be the "fleet.key
    // bearer" the acceptance criteria name.
    expect(tokenSource).toBe('fleet-key');

    const health = await request(port, '/api/health', 'GET', token);
    expect(health.status).toBe(200);
    const body = JSON.parse(health.body);
    expect(String(body.pid)).toBe(String(booted!.child.pid));
    expect(booted!.output()).not.toContain('ERR_MODULE_NOT_FOUND');
  }, 30_000);

  it('rejects a corrupted bearer with 401 (the guard is really on)', async () => {
    const { port, token } = booted!;
    const corrupted = (token[0] === '0' ? '1' : '0') + token.slice(1);
    const res = await request(port, '/api/health', 'GET', corrupted);
    expect(res.status).toBe(401);
  }, 30_000);

  it('created EXACTLY ONE listener: one "listening on" line, and a second bind on the same port is refused while the child is up', async () => {
    const { port } = booted!;
    expect(booted!.exited()).toBe(false);

    // The supervisor announces every bind it makes. Exactly one, ever.
    const listenLines = booted!.output().split('\n').filter((l) => l.includes('listening on'));
    expect(listenLines).toHaveLength(1);
    expect(listenLines[0]).toContain(String(port));

    const code = await tryBind(port);
    expect(code).toBe('EADDRINUSE');
    expect(booted!.output()).not.toContain('EADDRINUSE');

    // NOTE on what this test can and cannot prove. The installed tree here is a
    // symlink, and Node resolves an ES module's import.meta.url through
    // realpath -- so serve.mjs's own isMainModule() (import.meta.url vs
    // pathToFileURL(process.argv[1]).href) can never match through it, whatever
    // the launcher does with argv. The double-boot trap is therefore pinned
    // STRUCTURALLY in tests/supervisor-subcommand.test.ts, whose fake module
    // re-implements that guard exactly; reverting src/cli/supervisor.ts to the
    // double-boot form (argv[1] rewrite + explicit serveMain()) fails 6 tests
    // there. What this assertion adds is the real-process evidence that the
    // shipped launcher binds once and owns the port.
  }, 30_000);

  it('POST /api/shutdown exits the process 0 and frees the port again', async () => {
    const { port, token } = booted!;
    const res = await request(port, '/api/shutdown', 'POST', token);
    expect(res.status).toBe(200);

    const deadline = Date.now() + 30_000;
    while (!booted!.exited() && Date.now() < deadline) await sleep(100);
    expect(booted!.exited()).toBe(true);
    expect(booted!.exitCode()).toBe(0);

    expect(await tryBind(port)).toBeNull();
  }, 60_000);

  it('left no artifacts outside the test temp dirs: the real ~/.apra-fleet/fleet.key is untouched', () => {
    // Measured before the spawn in beforeAll and again now. The supervisor wrote
    // its ledger/history/logs, and the token resolution ran -- all of it must
    // have landed in the temp dirs.
    const after = snapshotRealFleetKey();
    expect(after.exists).toBe(realFleetKeyBefore.exists);
    expect(after.mtimeMs).toBe(realFleetKeyBefore.mtimeMs);

    // Positive side: the supervisor's own data root (a temp dir) DID get
    // written, so the isolation above is not vacuously true.
    expect(fs.existsSync(path.join(booted!.seDataDir, 'logs'))).toBe(true);
  });
});
