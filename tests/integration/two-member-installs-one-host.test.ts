/**
 * Two member installs on one host each get their own port and URL.
 *
 * A host can carry one member install per Unix user. Each install records its
 * port in its member-install marker, its server listens there (no
 * APRA_FLEET_PORT in the environment -- the marker alone decides, as for a
 * service launch), and the orchestrator resolves that port ON the member to
 * build the member MCP URL. Simulated here with two data dirs (two homes) on
 * this machine -- a real second Unix user is not required:
 *  - two built servers (dist/index.js run) on two OS-assigned ports;
 *  - for a member "registered" in each, resolveMemberMcpPort reads the marker
 *    through the real member read commands (run in this machine's shell) and
 *    memberMcpUrl builds the URL; each URL's origin answers /health with ITS
 *    OWN server's pid;
 *  - a third install whose marker records the first server's port fails to
 *    start, naming the holder pid;
 *  - every server is stopped and every temp dir removed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { resolveMemberMcpPort } from '../../src/services/member-fleet-install.js';
import { memberMcpUrl } from '../../src/services/member-config-io.js';
import { isPidAlive } from '../../src/utils/process-utils.js';
import type { Agent, SSHExecResult } from '../../src/types.js';

const DIST_INDEX = path.resolve(__dirname, '..', '..', 'dist', 'index.js');
const isWin = process.platform === 'win32';

interface Install { home: string; dataDir: string; port: number; child?: ChildProcess; pid?: number }

const tempRoots: string[] = [];
const children: ChildProcess[] = [];

function serverEnv(dataDir: string): NodeJS.ProcessEnv {
  const env = { ...process.env, APRA_FLEET_DATA_DIR: dataDir };
  // The marker alone decides the port (like a service launch with no env).
  delete env.APRA_FLEET_PORT;
  // Not a service-manager launch, whatever runs the tests.
  delete env.APRA_FLEET_SERVICE;
  delete env.INVOCATION_ID;
  delete env.XPC_SERVICE_NAME;
  return env;
}

function listenEphemeral(): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

/** Two OS-assigned free ports that are not adjacent. Some OSes (Windows) hand
 *  ephemeral ports out sequentially, so three are held open at once and the
 *  outer two used. */
async function twoPorts(): Promise<[number, number]> {
  for (let i = 0; i < 20; i++) {
    const held = [await listenEphemeral(), await listenEphemeral(), await listenEphemeral()];
    const ports = held.map(s => (s.address() as net.AddressInfo).port);
    await Promise.all(held.map(s => new Promise<void>(r => s.close(() => r()))));
    const [a, , b] = ports;
    if (Math.abs(a - b) > 1) return [a, b];
  }
  throw new Error('could not pick two non-adjacent free ports');
}

function makeInstall(port: number): Install {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-two-installs-'));
  tempRoots.push(home);
  const dataDir = path.join(home, '.apra-fleet', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'member-install.json'), JSON.stringify({ version: 'test', installedAt: new Date().toISOString(), port }) + '\n');
  return { home, dataDir, port };
}

function getHealth(url: string): Promise<{ pid?: number } | null> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try { resolve(res.statusCode === 200 ? JSON.parse(body) : null); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function startServer(inst: Install): Promise<void> {
  const child = spawn(process.execPath, [DIST_INDEX, 'run'], { env: serverEnv(inst.dataDir), stdio: 'ignore', windowsHide: true });
  children.push(child);
  inst.child = child;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const h = await getHealth(`http://127.0.0.1:${inst.port}/health`);
    if (h?.pid === child.pid) { inst.pid = child.pid; return; }
    if (child.exitCode !== null) throw new Error(`server for ${inst.dataDir} exited ${child.exitCode}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server for ${inst.dataDir} did not answer /health on ${inst.port}`);
}

function runToExit(inst: Install): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DIST_INDEX, 'run'], { env: serverEnv(inst.dataDir), stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    children.push(child);
    let stderr = '';
    child.stderr!.on('data', (d) => { stderr += d; });
    const killer = setTimeout(() => child.kill('SIGKILL'), 45_000);
    child.once('exit', (code) => { clearTimeout(killer); resolve({ code, stderr }); });
  });
}

/** Run a member-bound command in THIS machine's shell (the "member" is this host). */
function localExec(command: string): SSHExecResult {
  const r = isWin
    ? spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true })
    : spawnSync('sh', ['-c', command], { encoding: 'utf8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 1 };
}

function memberOn(id: string): Agent {
  return {
    id, friendlyName: id, agentType: 'remote', host: '127.0.0.1', port: 22, username: os.userInfo().username,
    authType: 'password', workFolder: os.tmpdir(), createdAt: new Date().toISOString(),
    os: isWin ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
    ...(isWin ? { shell: 'powershell5' as const } : {}),
  };
}

async function urlFor(agent: Agent, inst: Install): Promise<string> {
  const r = await resolveMemberMcpPort(agent, inst.home, { exec: async (_a, cmd) => localExec(cmd) });
  expect(r).toMatchObject({ kind: 'resolved', source: 'marker' });
  const port = r.kind === 'resolved' ? r.port : undefined;
  return memberMcpUrl({ ...agent, memberMcpPort: port });
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (isWin) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  else { try { child.kill('SIGKILL'); } catch { /* gone */ } }
}

const usageDir = path.join(os.homedir(), '.apra-fleet', 'data', 'code-intelligence');
const listing = (d: string) => { try { return fs.readdirSync(d).sort().join(','); } catch { return '<absent>'; } };
let usageBefore = '';

let first: Install;
let second: Install;

beforeAll(async () => {
  expect(fs.existsSync(DIST_INDEX), 'dist/ missing -- run npm run build first').toBe(true);
  usageBefore = listing(usageDir);
  const [a, b] = await twoPorts();
  first = makeInstall(a);
  second = makeInstall(b);
  await startServer(first);
  await startServer(second);
}, 120_000);

afterAll(async () => {
  for (const c of children) killTree(c);
  const deadline = Date.now() + 10_000;
  while (children.some(c => c.pid !== undefined && isPidAlive(c.pid)) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  const leftover = children.filter(c => c.pid !== undefined && isPidAlive(c.pid)).map(c => c.pid);
  for (const d of tempRoots) {
    for (let i = 0; i < 20; i++) {
      try { fs.rmSync(d, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 250)); }
    }
  }
  expect(leftover, 'leftover server processes').toEqual([]);
  expect(tempRoots.filter(d => fs.existsSync(d)), 'leftover temp dirs').toEqual([]);
  expect(listing(usageDir), 'code-intelligence usage dir changed').toBe(usageBefore);
}, 60_000);

describe('two member installs on one host', () => {
  it('each member URL reaches its own server', async () => {
    const memberA = memberOn('member-a');
    const memberB = memberOn('member-b');
    const urlA = await urlFor(memberA, first);
    const urlB = await urlFor(memberB, second);
    expect(urlA).toBe(`http://localhost:${first.port}/mcp?member=member-a`);
    expect(urlB).toBe(`http://localhost:${second.port}/mcp?member=member-b`);
    const healthOf = async (u: string) => getHealth(`http://127.0.0.1:${new URL(u).port}/health`);
    expect((await healthOf(urlA))?.pid).toBe(first.pid);
    expect((await healthOf(urlB))?.pid).toBe(second.pid);
    expect(first.pid).not.toBe(second.pid);
  }, 60_000);

  it('a third install on a port the first holds fails loudly, naming the holder pid', async () => {
    const third = makeInstall(first.port);
    const { code, stderr } = await runToExit(third);
    expect(code).toBe(1);
    expect(stderr).toContain(`Port ${first.port} is already in use`);
    expect(stderr).toContain(`pid ${first.pid}`);
    expect(fs.existsSync(path.join(third.dataDir, 'server.json'))).toBe(false);
    // The first server is untouched.
    expect((await getHealth(`http://127.0.0.1:${first.port}/health`))?.pid).toBe(first.pid);
  }, 60_000);
});
