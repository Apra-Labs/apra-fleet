#!/usr/bin/env node
// Sandbox Deploy lifecycle for deploy.md's "## Sandbox Deploy" section: an
// isolated fleet MCP server + fleet-sprint supervisor pair that coexists with
// this machine's production instance (separate data dirs, OS-assigned ports,
// no installer, no OS auto-start registration -- see isNonDefaultInstance()
// in src/paths.ts).
//
// Why a script and not inline shell: a dispatched agent runs every command
// as its own stateless shell, so an `export` in one step is gone by the next.
// Everything a step needs is therefore persisted in ONE values file whose
// path is derived from the sprintId alone, and every subcommand re-reads it:
//
//   values file : <home>/.fleet-sandbox-<safe-id>.env      (KEY=value lines)
//   sandbox root: <home>/tmp/fleet-sandbox-<safe-id>
//   safe-id     : sanitized(sprintId) + '-' + sha1(sprintId)[0:8]
//
// <home> is os.homedir() (USERPROFILE on Windows), so a LATER, separately
// dispatched phase (integ-test-runner) that knows only the sprintId can
// reconstruct the same path and find the same sandbox.
//
// CLI:
//   node scripts/sandbox-deploy.mjs up       --sprint-id "<id>"   init + start + verify + smoke (tears down on failure)
//   node scripts/sandbox-deploy.mjs init     --sprint-id "<id>"   allocate ports/dirs, write the values file
//   node scripts/sandbox-deploy.mjs start    --sprint-id "<id>"   launch server + supervisor, identity-checked
//   node scripts/sandbox-deploy.mjs verify   --sprint-id "<id>"   isolation proof + production-unchanged check
//   node scripts/sandbox-deploy.mjs smoke    --sprint-id "<id>"   /health of the RUNNING sandbox server
//   node scripts/sandbox-deploy.mjs env      --sprint-id "<id>"   print the values file (discovery for later phases)
//   node scripts/sandbox-deploy.mjs teardown --sprint-id "<id>"   pid-checked kill, port-free confirm, then rm -rf
//
// Exit codes: 0 ok, 1 failure (reason on stderr). Never touches ~/.apra-fleet,
// ~/.apra-fleet-se, the installer, `apra-fleet stop`, or any process it
// cannot prove is its own (pid recorded by THIS recipe AND answering /health
// with that pid).
//
// `--home <dir>` overrides <home> (tests only -- every phase must agree on
// it, so never pass it in a real dispatch).

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRODUCTION_FLEET_PORT = 7523;
const PRODUCTION_SUPERVISOR_PORT = 8787;
const RESERVED_PORTS = new Set([PRODUCTION_FLEET_PORT, PRODUCTION_SUPERVISOR_PORT, 18700, 18701]);
// An OS-assigned port is released before the spawned child binds it, so under a
// concurrent test suite another process can win it (TOCTOU). `up` recovers by
// re-allocating and re-launching, but only this many times and only when the
// failure is PROVEN to be a lost port race -- never as a blind retry.
const MAX_PORT_BIND_ATTEMPTS = 3;
const PORT_CONFLICT_RE = /EADDRINUSE|address already in use/i;
// A process we just killed can hold its listener for a moment after its pid
// is gone (Windows especially) -- both teardown's port-free wait and
// lostPortRace's port-probe fallback poll for this same grace window instead
// of trusting a single immediate probe (apra-fleet-3swo.48).
const PORT_RELEASE_GRACE_MS = 5000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.error(`[sandbox-deploy] ${msg}`);

export class SandboxDeployError extends Error {}

// ---------------------------------------------------------------------------
// Naming (pure, deterministic from the sprintId alone)
// ---------------------------------------------------------------------------

/** Filesystem-safe id: sanitized prefix for readability, short hash for
 *  uniqueness (so `a/b` and `a-b` never share a sandbox). */
export function safeSandboxId(sprintId) {
  if (typeof sprintId !== 'string' || !sprintId.trim()) throw new SandboxDeployError('--sprint-id is required');
  const sanitized = sprintId.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40) || 'sprint';
  const hash = crypto.createHash('sha1').update(sprintId).digest('hex').slice(0, 8);
  return `${sanitized}-${hash}`;
}

export function valuesFilePath(sprintId, home = os.homedir()) {
  return path.join(home, `.fleet-sandbox-${safeSandboxId(sprintId)}.env`);
}

export function sandboxRootPath(sprintId, home = os.homedir()) {
  return path.join(home, 'tmp', `fleet-sandbox-${safeSandboxId(sprintId)}`);
}

// ---------------------------------------------------------------------------
// Values file (flat KEY=value, one per line; no shell quoting)
// ---------------------------------------------------------------------------

export function parseValues(text) {
  const out = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  return out;
}

export function serializeValues(values) {
  return Object.entries(values)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${String(v).replace(/\r?\n/g, ' ')}`)
    .join('\n') + '\n';
}

export function readValues(sprintId, home) {
  const file = valuesFilePath(sprintId, home);
  if (!fs.existsSync(file)) return null;
  return parseValues(fs.readFileSync(file, 'utf8'));
}

export function writeValues(sprintId, values, home) {
  const file = valuesFilePath(sprintId, home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serializeValues(values));
  return file;
}

// ---------------------------------------------------------------------------
// Process / port / HTTP helpers
// ---------------------------------------------------------------------------

export function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (err) { return err && err.code === 'EPERM'; }
}

function killPid(pid, force) {
  const n = Number(pid);
  try {
    if (process.platform === 'win32') {
      if (force) execFileSync('taskkill', ['/F', '/PID', String(n)], { stdio: 'ignore' });
      else process.kill(n);
    } else {
      process.kill(n, force ? 'SIGKILL' : 'SIGTERM');
    }
  } catch { /* already gone, or unkillable -- the caller re-checks liveness */ }
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (isPidAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(250);
  }
  return true;
}

/** Terminate a pid this recipe owns: graceful, then forced. Returns true once dead. */
export async function stopPid(pid) {
  if (!isPidAlive(pid)) return true;
  killPid(pid, false);
  if (await waitForExit(pid, 5000)) return true;
  killPid(pid, true);
  return waitForExit(pid, 5000);
}

export function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

/** Tag an error as "this port was taken between allocation and bind" so `up`
 *  can re-allocate and re-launch instead of giving up. */
function portConflictError(role, port, message) {
  const err = new SandboxDeployError(message);
  err.portConflict = { role, port };
  return err;
}

/** True when a child that never came up lost the allocate-then-bind race:
 *  either its log says so, or -- with our own pid already dead -- the port is
 *  STILL bound after a grace window, which can only be a foreign holder.
 *  Never a bare guess.
 *
 *  The port-probe fallback is only reached when the log shows no EADDRINUSE,
 *  which also covers a child that DID bind the port and only failed for a
 *  reason unrelated to ports (crashed after listening, never wrote
 *  server.json, answered /health with the wrong pid). By the time this runs,
 *  the caller has already stopPid()'d that child, but its listener can
 *  briefly outlive its pid (Windows especially -- the same reason teardown's
 *  own port-free wait polls instead of probing once). A single immediate
 *  probe cannot tell that apart from a genuine foreign winner, so this polls
 *  for the SAME grace window teardown uses: the port is ours (not a lost
 *  race) if it frees up anywhere within that window, since a real foreign
 *  winner keeps holding it for the whole window. */
export async function lostPortRace(logPath, port) {
  try {
    if (PORT_CONFLICT_RE.test(fs.readFileSync(logPath, 'utf8'))) return true;
  } catch { /* no log to read: fall through to the port probe */ }
  for (const deadline = Date.now() + PORT_RELEASE_GRACE_MS; ;) {
    if (await isPortFree(port)) return false;
    if (Date.now() >= deadline) return true;
    await sleep(250);
  }
}

function osAssignedPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Two OS-assigned free ports: never a reserved production/test port, never a
 *  port a previous `up` attempt already lost (nor ADJACENT to one), and never
 *  adjacent to each other. Both adjacency rules exist for the same reason --
 *  the observed collision handed back a consecutive pair, so one process
 *  sweeping upward from its own port lands on the next one. The intra-pair
 *  rule guards the two ports THIS call returns against each other; the
 *  exclude-adjacency rule guards a RETRY (`up`'s lostPorts -> excludePorts)
 *  against the single most likely next target of whatever process just swept
 *  into a port this sandbox already lost -- an exact-match-only exclude would
 *  happily hand back lostPort +/- 1, which is exactly the hazard the
 *  intra-pair rule was added to prevent, just on the retry path instead of
 *  within one call. This widened rule deliberately does NOT extend to
 *  RESERVED_PORTS: those are static production/test ports, not a live race
 *  signal from a sweeping foreign process, and 18700/18701 are already an
 *  intentionally-adjacent reserved pair -- banning a 4-port neighborhood
 *  around each of them would cost candidate ports for no evidenced benefit.
 *  Widening the filter means a single `pick()` attempt can reject more
 *  candidates than before, but the 20-attempt cap and the
 *  'could not allocate two free ports' failure mode are unchanged; see
 *  tests/sandbox-deploy.test.ts's port-race recovery/exhaustion cases, which
 *  exercise the retry path through `up` and pin that this filter does not
 *  turn a previously-succeeding scenario into an allocation failure. */
export async function allocatePorts(pick = osAssignedPort, exclude = []) {
  const excludeNums = exclude.map(Number);
  const banned = new Set([...RESERVED_PORTS, ...excludeNums]);
  const chosen = [];
  for (let attempt = 0; attempt < 20 && chosen.length < 2; attempt += 1) {
    const port = await pick();
    if (!Number.isInteger(port) || banned.has(port)) continue;
    if (excludeNums.some((e) => Math.abs(e - port) <= 1)) continue;
    if (chosen.some((p) => Math.abs(p - port) <= 1)) continue;
    chosen.push(port);
  }
  if (chosen.length < 2) throw new SandboxDeployError('could not allocate two free ports');
  return { fleetPort: chosen[0], supervisorPort: chosen[1] };
}

export async function getJson(url, timeoutMs = 2000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function postJson(url, timeoutMs = 2000) {
  try {
    const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function spawnDetached(args, env, logFile) {
  const fd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    env,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  fs.closeSync(fd);
  return child.pid;
}

// ---------------------------------------------------------------------------
// Production snapshot (so verify/teardown can prove production was untouched)
// ---------------------------------------------------------------------------

export async function snapshotProduction(home = os.homedir()) {
  const snap = {};
  const info = readJsonFile(path.join(home, '.apra-fleet', 'data', 'server.json'));
  if (info && info.pid) {
    snap.PROD_MCP_PID = String(info.pid);
    snap.PROD_MCP_PORT = String(info.port ?? '');
  }
  const health = await getJson(`http://127.0.0.1:${PRODUCTION_SUPERVISOR_PORT}/api/health`);
  if (health && health.pid) {
    snap.PROD_SUPERVISOR_PID = String(health.pid);
    snap.PROD_SUPERVISOR_UPTIME = String(health.uptimeSeconds ?? 0);
  }
  return snap;
}

/** Returns a list of human-readable problems (empty = production untouched). */
export async function checkProductionUnchanged(values, home = os.homedir()) {
  const problems = [];
  if (values.PROD_MCP_PID) {
    const info = readJsonFile(path.join(home, '.apra-fleet', 'data', 'server.json'));
    if (!info || String(info.pid) !== values.PROD_MCP_PID) {
      problems.push(`production fleet server pid changed (was ${values.PROD_MCP_PID}, now ${info?.pid ?? 'absent'})`);
    }
  }
  if (values.PROD_SUPERVISOR_PID) {
    const health = await getJson(`http://127.0.0.1:${PRODUCTION_SUPERVISOR_PORT}/api/health`);
    if (!health || String(health.pid) !== values.PROD_SUPERVISOR_PID) {
      problems.push(`production supervisor pid changed (was ${values.PROD_SUPERVISOR_PID}, now ${health?.pid ?? 'unreachable'})`);
    } else if (Number(health.uptimeSeconds) < Number(values.PROD_SUPERVISOR_UPTIME)) {
      problems.push(`production supervisor uptime reset (${values.PROD_SUPERVISOR_UPTIME}s -> ${health.uptimeSeconds}s)`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

export async function init(sprintId, { home = os.homedir(), pickPort, excludePorts = [] } = {}) {
  const existing = readValues(sprintId, home);
  if (existing) {
    log(`values file for this sprint already exists (${valuesFilePath(sprintId, home)}) -- tearing the stale sandbox down first`);
    await teardown(sprintId, { home });
  }
  const root = sandboxRootPath(sprintId, home);
  const { fleetPort, supervisorPort } = await allocatePorts(pickPort, excludePorts);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'mcp'), { recursive: true });
  fs.mkdirSync(path.join(root, 'se'), { recursive: true });
  const values = {
    SPRINT_ID: sprintId,
    SANDBOX_ID: safeSandboxId(sprintId),
    SANDBOX_ROOT: root,
    REPO_ROOT,
    APRA_FLEET_DATA_DIR: path.join(root, 'mcp'),
    APRA_FLEET_PORT: String(fleetPort),
    FLEET_SE_DATA_DIR: path.join(root, 'se'),
    FLEET_SE_SWEEP_OWNER_DATA_DIR: root,
    SUPERVISOR_PORT: String(supervisorPort),
    CREATED_AT: new Date().toISOString(),
    ...(await snapshotProduction(home)),
  };
  const file = writeValues(sprintId, values, home);
  log(`initialized: root=${root} fleetPort=${fleetPort} supervisorPort=${supervisorPort}`);
  log(`values file: ${file}`);
  return values;
}

function requireValues(sprintId, home) {
  const values = readValues(sprintId, home);
  if (!values) {
    throw new SandboxDeployError(`no values file at ${valuesFilePath(sprintId, home)} -- run 'init' (or 'up') first`);
  }
  return values;
}

export async function start(sprintId, { home = os.homedir() } = {}) {
  const values = requireValues(sprintId, home);
  const root = values.SANDBOX_ROOT;
  const fleetPort = Number(values.APRA_FLEET_PORT);
  const supervisorPort = Number(values.SUPERVISOR_PORT);
  const repoRoot = values.REPO_ROOT || REPO_ROOT;
  const distIndex = path.join(repoRoot, 'dist', 'index.js');
  if (!fs.existsSync(distIndex)) throw new SandboxDeployError(`${distIndex} not found -- run 'npm run build' first`);
  if (values.MCP_PID && isPidAlive(values.MCP_PID)) throw new SandboxDeployError(`sandbox fleet server already running (pid ${values.MCP_PID}) -- teardown first`);

  const env = {
    ...process.env,
    APRA_FLEET_DATA_DIR: values.APRA_FLEET_DATA_DIR,
    APRA_FLEET_PORT: values.APRA_FLEET_PORT,
    FLEET_SE_DATA_DIR: values.FLEET_SE_DATA_DIR,
    FLEET_SE_SWEEP_OWNER_DATA_DIR: values.FLEET_SE_SWEEP_OWNER_DATA_DIR,
  };

  // 1. Fleet MCP server. Spawned directly (what `apra-fleet start` does
  //    internally for a non-default instance) so the pid is known here.
  if (!(await isPortFree(fleetPort))) {
    throw portConflictError('fleet', fleetPort, `fleet port ${fleetPort} is no longer free -- re-run 'init'`);
  }
  const mcpPid = spawnDetached([distIndex, '--transport', 'http'], env, path.join(root, 'fleet-server.log'));
  values.MCP_PID = String(mcpPid);
  writeValues(sprintId, values, home);
  const serverJsonPath = path.join(values.APRA_FLEET_DATA_DIR, 'server.json');
  let info = null;
  for (const deadline = Date.now() + 20000; Date.now() < deadline; await sleep(250)) {
    if (!isPidAlive(mcpPid)) break;
    info = readJsonFile(serverJsonPath);
    if (info && info.pid) break;
  }
  if (!info || !info.pid) {
    await stopPid(mcpPid);
    const fleetLog = path.join(root, 'fleet-server.log');
    const msg = `sandbox fleet server did not write ${serverJsonPath} -- see ${fleetLog}`;
    if (await lostPortRace(fleetLog, fleetPort)) throw portConflictError('fleet', fleetPort, msg);
    throw new SandboxDeployError(msg);
  }
  if (String(info.pid) !== String(mcpPid)) {
    await stopPid(mcpPid);
    throw new SandboxDeployError(`server.json pid ${info.pid} is not the process just launched (${mcpPid}) -- refusing to adopt a foreign server`);
  }
  if (Number(info.port) !== fleetPort) {
    // EADDRINUSE silent-rebind (src/services/http-transport.ts): kill what we
    // started rather than proceed against the wrong port.
    await stopPid(mcpPid);
    throw portConflictError('fleet', fleetPort, `sandbox fleet server bound ${info.port}, not ${fleetPort} (port was taken between allocation and bind) -- torn down; re-run 'init'`);
  }
  const health = await getJson(`http://127.0.0.1:${fleetPort}/health`, 5000);
  if (!health || String(health.pid) !== String(mcpPid)) {
    await stopPid(mcpPid);
    throw new SandboxDeployError(`/health on ${fleetPort} did not answer with pid ${mcpPid}`);
  }
  values.MCP_VERSION = String(health.version ?? info.version ?? '');
  writeValues(sprintId, values, home);
  log(`fleet server up: pid=${mcpPid} port=${fleetPort} version=${values.MCP_VERSION}`);

  // 2. Supervisor. Finds the sandbox server solely via
  //    <APRA_FLEET_DATA_DIR>/server.json (server-resolution.mjs), so the env
  //    above is what makes it a sandbox supervisor.
  if (!(await isPortFree(supervisorPort))) {
    await stopPid(mcpPid);
    throw portConflictError('supervisor', supervisorPort, `supervisor port ${supervisorPort} is no longer free -- torn down; re-run 'init'`);
  }
  const serve = path.join(repoRoot, 'packages', 'apra-fleet-se', 'bin', 'serve.mjs');
  const supPid = spawnDetached([serve, '--port', String(supervisorPort)], env, path.join(root, 'supervisor.log'));
  values.SUPERVISOR_PID = String(supPid);
  writeValues(sprintId, values, home);
  let supHealth = null;
  for (const deadline = Date.now() + 30000; Date.now() < deadline; await sleep(500)) {
    if (!isPidAlive(supPid)) break;
    supHealth = await getJson(`http://127.0.0.1:${supervisorPort}/api/health`);
    if (supHealth && String(supHealth.pid) === String(supPid)) break;
    supHealth = null;
  }
  if (!supHealth) {
    await stopPid(supPid);
    await stopPid(mcpPid);
    const supLog = path.join(root, 'supervisor.log');
    const msg = `sandbox supervisor did not answer /api/health with pid ${supPid} on ${supervisorPort} (EADDRINUSE, or crashed) -- torn down; see ${supLog}`;
    if (await lostPortRace(supLog, supervisorPort)) throw portConflictError('supervisor', supervisorPort, msg);
    throw new SandboxDeployError(msg);
  }
  log(`supervisor up: pid=${supPid} port=${supervisorPort}`);
  return values;
}

export async function verify(sprintId, { home = os.homedir() } = {}) {
  const values = requireValues(sprintId, home);
  const problems = [];
  const fleetPort = Number(values.APRA_FLEET_PORT);
  const supervisorPort = Number(values.SUPERVISOR_PORT);

  const health = await getJson(`http://127.0.0.1:${fleetPort}/health`);
  if (!health || String(health.pid) !== values.MCP_PID) problems.push(`sandbox fleet server: /health on ${fleetPort} did not answer with pid ${values.MCP_PID}`);
  const supHealth = await getJson(`http://127.0.0.1:${supervisorPort}/api/health`);
  if (!supHealth || String(supHealth.pid) !== values.SUPERVISOR_PID) problems.push(`sandbox supervisor: /api/health on ${supervisorPort} did not answer with pid ${values.SUPERVISOR_PID}`);
  // Isolation: the sandbox supervisor must see the sandbox's EMPTY registry,
  // never production's members.
  const members = await getJson(`http://127.0.0.1:${supervisorPort}/api/members`, 10000);
  const list = Array.isArray(members?.members) ? members.members : (Array.isArray(members) ? members : null);
  if (!list) problems.push(`sandbox supervisor: /api/members unreadable (${JSON.stringify(members)})`);
  else if (list.length !== 0) problems.push(`sandbox supervisor sees ${list.length} member(s) -- it is attached to a NON-empty registry (production?)`);
  const sbInfo = readJsonFile(path.join(values.APRA_FLEET_DATA_DIR, 'server.json'));
  if (!sbInfo || String(sbInfo.pid) !== values.MCP_PID || Number(sbInfo.port) !== fleetPort) problems.push('sandbox server.json does not match the recorded pid/port');
  problems.push(...await checkProductionUnchanged(values, home));

  if (problems.length) throw new SandboxDeployError(`isolation check failed:\n  - ${problems.join('\n  - ')}`);
  log(`verified: sandbox pids ${values.MCP_PID}/${values.SUPERVISOR_PID} on ${fleetPort}/${supervisorPort}, empty registry, production unchanged`);
  return values;
}

export async function smoke(sprintId, { home = os.homedir() } = {}) {
  const values = requireValues(sprintId, home);
  const fleetPort = Number(values.APRA_FLEET_PORT);
  const health = await getJson(`http://127.0.0.1:${fleetPort}/health`);
  if (!health || String(health.pid) !== values.MCP_PID) {
    throw new SandboxDeployError(`smoke: the RUNNING sandbox server (pid ${values.MCP_PID}, port ${fleetPort}) did not answer /health`);
  }
  const built = readJsonFile(path.join(values.REPO_ROOT || REPO_ROOT, 'version.json'));
  const expected = built && built.version ? `v${built.version}` : null;
  if (expected && !String(health.version).startsWith(expected)) {
    throw new SandboxDeployError(`smoke: running sandbox reports version ${health.version}, checkout is ${expected}`);
  }
  log(`smoke ok: pid=${health.pid} version=${health.version} uptime=${health.uptime}s`);
  return health;
}

/** Kill only a process this recipe can prove is its own. Returns a problem
 *  string, or null when the process is gone. */
async function stopOwned({ label, pid, port, healthPath, expectedPid }) {
  if (!pid || !isPidAlive(pid)) return null;
  const health = port ? await getJson(`http://127.0.0.1:${port}${healthPath}`) : null;
  const answersAsSelf = health && String(health.pid) === String(pid);
  const isRecorded = expectedPid && String(pid) === String(expectedPid);
  if (!answersAsSelf && !isRecorded) {
    return `${label}: pid ${pid} is alive but is neither the pid this recipe launched nor answering ${healthPath} on ${port} -- not killing a process that may not be ours`;
  }
  if (await stopPid(pid)) return null;
  return `${label}: pid ${pid} is still alive after SIGTERM/SIGKILL`;
}

/** `foreignPorts`: ports PROVEN to be held by another process (a lost
 *  allocate-then-bind race). Their listener is not ours to wait on, so it is
 *  not a teardown failure -- every pid check still applies unchanged. */
export async function teardown(sprintId, { home = os.homedir(), foreignPorts = [] } = {}) {
  const file = valuesFilePath(sprintId, home);
  const values = readValues(sprintId, home);
  if (!values) {
    log(`nothing to tear down (no ${file})`);
    return { removed: false };
  }
  const problems = [];
  const supervisorPort = Number(values.SUPERVISOR_PORT);
  const fleetPort = Number(values.APRA_FLEET_PORT);

  // 1. Supervisor: graceful shutdown only if the port answers with OUR pid.
  if (values.SUPERVISOR_PID && isPidAlive(values.SUPERVISOR_PID)) {
    const h = await getJson(`http://127.0.0.1:${supervisorPort}/api/health`);
    if (h && String(h.pid) === values.SUPERVISOR_PID) {
      await postJson(`http://127.0.0.1:${supervisorPort}/api/shutdown`);
      await waitForExit(values.SUPERVISOR_PID, 5000);
    }
    const p = await stopOwned({ label: 'supervisor', pid: values.SUPERVISOR_PID, port: supervisorPort, healthPath: '/api/health', expectedPid: values.SUPERVISOR_PID });
    if (p) problems.push(p);
  }

  // 2. Fleet server: read server.json BEFORE anything is deleted; the pid
  //    there and the recorded MCP_PID are the only candidates.
  const info = readJsonFile(path.join(values.APRA_FLEET_DATA_DIR || '', 'server.json'));
  const candidates = [...new Set([info?.pid, values.MCP_PID].filter(Boolean).map(String))];
  for (const pid of candidates) {
    const p = await stopOwned({ label: 'fleet server', pid, port: fleetPort, healthPath: '/health', expectedPid: values.MCP_PID });
    if (p) problems.push(p);
  }

  // 3. Ports must actually be free before the directory goes. A just-killed
  //    process can hold its listener for a moment after the pid is gone
  //    (Windows especially), so poll briefly instead of a single probe.
  for (const [label, port] of [['fleet', fleetPort], ['supervisor', supervisorPort]]) {
    if (!Number.isInteger(port) || port <= 0) continue;
    if (foreignPorts.map(Number).includes(port)) {
      log(`${label} port ${port} is held by the process that won it, not by us -- not waiting for it`);
      continue;
    }
    let free = false;
    for (const deadline = Date.now() + PORT_RELEASE_GRACE_MS; Date.now() < deadline && !(free = await isPortFree(port)); await sleep(250));
    if (!free) problems.push(`${label} port ${port} is still bound`);
  }
  if (problems.length) {
    throw new SandboxDeployError(`teardown incomplete -- sandbox root and values file KEPT for a retry:\n  - ${problems.join('\n  - ')}`);
  }

  // 4. Only now remove the sandbox root and the values file.
  if (values.SANDBOX_ROOT && values.SANDBOX_ROOT.includes('fleet-sandbox-')) {
    fs.rmSync(values.SANDBOX_ROOT, { recursive: true, force: true });
  }
  fs.rmSync(file, { force: true });
  const prod = await checkProductionUnchanged(values, home);
  for (const p of prod) log(`WARNING: ${p}`);
  log(`torn down: ${values.SANDBOX_ROOT} removed, ${file} removed`);
  return { removed: true, productionProblems: prod };
}

export async function up(sprintId, opts = {}) {
  // Recovery for the allocate-then-bind window ONLY: a failure is retried iff
  // start() proved the port was taken by someone else (err.portConflict), each
  // retry re-allocates ports that exclude every port already lost, and the
  // whole thing is bounded by MAX_PORT_BIND_ATTEMPTS. Any other failure -- and
  // any teardown that did not fully succeed -- propagates immediately, so a
  // half-up sandbox can never be reported as success.
  const lostPorts = [];
  const triedPairs = [];
  for (let attempt = 1; ; attempt += 1) {
    const allocated = await init(sprintId, { ...opts, excludePorts: lostPorts });
    triedPairs.push(`${allocated.APRA_FLEET_PORT}/${allocated.SUPERVISOR_PORT}`);
    try {
      await start(sprintId, opts);
      await verify(sprintId, opts);
      await smoke(sprintId, opts);
      break;
    } catch (err) {
      log(`FAILED (${err.message}) -- tearing down what was started`);
      const conflict = err && err.portConflict;
      let tornDown = true;
      try {
        // A port we lost is still bound by its winner; that is not our leak.
        await teardown(sprintId, { ...opts, foreignPorts: conflict ? [conflict.port] : [] });
      } catch (tdErr) { tornDown = false; log(tdErr.message); }
      if (!conflict || !tornDown) throw err;
      lostPorts.push(conflict.port);
      if (attempt >= MAX_PORT_BIND_ATTEMPTS) {
        throw new SandboxDeployError(
          `sandbox could not bind its ports in ${MAX_PORT_BIND_ATTEMPTS} attempts `
          + `(tried fleet/supervisor ${triedPairs.join(', ')}; lost ${conflict.role} port ${conflict.port} last) `
          + `-- torn down; last failure: ${err.message}`,
        );
      }
      log(`${conflict.role} port ${conflict.port} was taken between allocation and bind -- re-allocating (attempt ${attempt + 1} of ${MAX_PORT_BIND_ATTEMPTS})`);
    }
  }
  const values = readValues(sprintId, opts.home);
  log('sandbox is UP and stays up for the test phase. Locate it later with:');
  log(`  node scripts/sandbox-deploy.mjs env --sprint-id "${sprintId}"`);
  return values;
}

export function envText(sprintId, { home = os.homedir() } = {}) {
  const values = requireValues(sprintId, home);
  return serializeValues(values);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const next = () => {
      const v = rest[i + 1];
      if (v === undefined) throw new SandboxDeployError(`Missing value for ${arg}`);
      i += 1;
      return v;
    };
    if (arg === '--sprint-id') opts.sprintId = next();
    else if (arg === '--home') opts.home = next();
    else throw new SandboxDeployError(`Unknown argument "${arg}"`);
  }
  return opts;
}

const COMMANDS = { up, init, start, verify, smoke, teardown };

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
    if (!opts.command || (!COMMANDS[opts.command] && opts.command !== 'env')) {
      throw new SandboxDeployError(`usage: node scripts/sandbox-deploy.mjs <up|init|start|verify|smoke|env|teardown> --sprint-id "<id>"`);
    }
    if (!opts.sprintId) throw new SandboxDeployError('--sprint-id is required');
    const run = { home: opts.home };
    if (opts.command === 'env') {
      process.stdout.write(envText(opts.sprintId, run));
    } else {
      await COMMANDS[opts.command](opts.sprintId, run);
      if (opts.command === 'up' || opts.command === 'init' || opts.command === 'start') {
        process.stdout.write(envText(opts.sprintId, run));
      }
    }
    process.exit(0);
  } catch (err) {
    log(err instanceof SandboxDeployError ? err.message : (err && err.stack ? err.stack : String(err)));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
