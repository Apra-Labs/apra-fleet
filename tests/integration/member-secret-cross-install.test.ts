/**
 * A session from another user is rejected by a member install over loopback.
 *
 * Two member installs on one host (one per Unix user), simulated with two data
 * dirs (two homes) on this machine: two built servers (dist/index.js run), two
 * ports (each install's marker records its own), two member access secrets
 * (each server creates its own owner-only member-access.key at start). Member B
 * is registered in BOTH installs' registries -- the worst case, where install
 * A knows B's uuid -- so only the secret can tell B's session apart there.
 *
 * B's per-session MCP config is built the way the orchestrator builds it
 * (sessionMcpConfigContent for a remote member carrying B's port and its
 * install's secret). That config's URL and headers:
 *  - pointed at A's port: refused with 401 (no session opened on A);
 *  - against B's own server: a member session that lists kb_* and code_*.
 * Every server is stopped and every temp dir removed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { sessionMcpConfigContent } from '../../src/services/session-mcp-config.js';
import { MEMBER_SECRET_HEADER } from '../../src/services/member-access-secret.js';
import { encryptPassword } from '../../src/utils/crypto.js';
import { isPidAlive } from '../../src/utils/process-utils.js';
import type { Agent } from '../../src/types.js';

const DIST_INDEX = path.resolve(__dirname, '..', '..', 'dist', 'index.js');
const isWin = process.platform === 'win32';
const RECONNECT = { maxRetries: 0, maxReconnectionDelay: 100, initialReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 };

interface Install { home: string; dataDir: string; port: number; child?: ChildProcess; pid?: number; secret?: string }

const tempRoots: string[] = [];
const children: ChildProcess[] = [];
const clients: Client[] = [];

function serverEnv(dataDir: string): NodeJS.ProcessEnv {
  const env = { ...process.env, APRA_FLEET_DATA_DIR: dataDir };
  // The marker alone decides the port (like a service launch with no env).
  delete env.APRA_FLEET_PORT;
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

/** Two free, non-adjacent ports (Windows hands ephemeral ports out sequentially). */
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

/** The member as its OWN install registers it: a local member of that install. */
function registeredMember(id: string, workFolder: string): Agent {
  return { id, friendlyName: `member-${id.slice(0, 8)}`, agentType: 'local', workFolder, createdAt: new Date().toISOString(), llmProvider: 'claude' } as Agent;
}

function makeInstall(port: number, members: Agent[]): Install {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-secret-installs-'));
  tempRoots.push(home);
  const dataDir = path.join(home, '.apra-fleet', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'member-install.json'), JSON.stringify({ version: 'test', installedAt: new Date().toISOString(), port }) + '\n');
  fs.writeFileSync(path.join(dataDir, 'registry.json'), JSON.stringify({ version: '1.0', agents: members }, null, 2));
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
    if (h?.pid === child.pid) {
      inst.pid = child.pid;
      inst.secret = fs.readFileSync(path.join(inst.dataDir, 'member-access.key'), 'utf8').trim();
      return;
    }
    if (child.exitCode !== null) throw new Error(`server for ${inst.dataDir} exited ${child.exitCode}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server for ${inst.dataDir} did not answer /health on ${inst.port}`);
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (isWin) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  else { try { child.kill('SIGKILL'); } catch { /* gone */ } }
}

/** POST an MCP initialize with the given URL and headers; resolves the HTTP status. */
function postInitialize(url: URL, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cross-install', version: '1' } },
  });
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(body), ...headers },
    }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** Member B's per-session config, as the orchestrator builds it for a remote member. */
function sessionConfigFor(memberId: string, inst: Install): { url: URL; headers: Record<string, string> } {
  const asSeenByOrchestrator: Agent = {
    id: memberId, friendlyName: 'b', agentType: 'remote', host: '127.0.0.1', port: 22, username: os.userInfo().username,
    authType: 'password', workFolder: inst.home, createdAt: new Date().toISOString(),
    memberMcpPort: inst.port, encryptedMemberMcpSecret: encryptPassword(inst.secret!),
  };
  const entry = JSON.parse(sessionMcpConfigContent(asSeenByOrchestrator)).mcpServers['apra-fleet'] as { url: string; headers: Record<string, string> };
  // memberMcpUrl names localhost; pin IPv4 loopback, where the servers bind.
  const url = new URL(entry.url);
  url.hostname = '127.0.0.1';
  return { url, headers: entry.headers };
}

const usageDir = path.join(os.homedir(), '.apra-fleet', 'data', 'code-intelligence');
const listing = (d: string) => { try { return fs.readdirSync(d).sort().join(','); } catch { return '<absent>'; } };
let usageBefore = '';

const memberA = crypto.randomUUID();
const memberB = crypto.randomUUID();
let a: Install;
let b: Install;

beforeAll(async () => {
  expect(fs.existsSync(DIST_INDEX), 'dist/ missing -- run npm run build first').toBe(true);
  usageBefore = listing(usageDir);
  const [portA, portB] = await twoPorts();
  a = makeInstall(portA, []);
  b = makeInstall(portB, []);
  // A knows B's uuid too (worst case): only the secret separates them.
  fs.writeFileSync(path.join(a.dataDir, 'registry.json'), JSON.stringify({ version: '1.0', agents: [registeredMember(memberA, a.home), registeredMember(memberB, a.home)] }, null, 2));
  fs.writeFileSync(path.join(b.dataDir, 'registry.json'), JSON.stringify({ version: '1.0', agents: [registeredMember(memberB, b.home)] }, null, 2));
  await startServer(a);
  await startServer(b);
}, 120_000);

afterAll(async () => {
  for (const c of clients) { try { await c.close(); } catch { /* ignore */ } }
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

describe('member installs on one host reject each other\'s sessions over loopback', () => {
  it('each install created its own owner-only secret', () => {
    expect(a.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(b.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(a.secret).not.toBe(b.secret);
    if (!isWin) {
      for (const inst of [a, b]) expect(fs.statSync(path.join(inst.dataDir, 'member-access.key')).mode & 0o777).toBe(0o600);
    }
  });

  it("B's per-session config pointed at A's port is refused with 401", async () => {
    const cfg = sessionConfigFor(memberB, b);
    expect(cfg.headers).toEqual({ [MEMBER_SECRET_HEADER]: b.secret });
    const atA = new URL(cfg.url);
    atA.port = String(a.port);
    const r = await postInitialize(atA, cfg.headers);
    expect(r.status).toBe(401);
    expect(JSON.parse(r.body).error).toBe('member secret required');
    // ... and through a real MCP client the connect fails the same way.
    const client = new Client({ name: 'b-at-a', version: '1.0.0' }, { capabilities: {} });
    clients.push(client);
    await expect(client.connect(new StreamableHTTPClientTransport(atA, { reconnectionOptions: RECONNECT, requestInit: { headers: cfg.headers } })))
      .rejects.toThrow(/member secret required/);
    // A without any secret is refused too.
    expect((await postInitialize(atA, {})).status).toBe(401);
  }, 60_000);

  it("B's per-session config against B's own server opens a member session listing kb_* and code_*", async () => {
    const cfg = sessionConfigFor(memberB, b);
    const client = new Client({ name: 'b-at-b', version: '1.0.0' }, { capabilities: {} });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(cfg.url, { reconnectionOptions: RECONNECT, requestInit: { headers: cfg.headers } }));
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names.some(n => n.startsWith('kb_'))).toBe(true);
    expect(names.some(n => n.startsWith('code_'))).toBe(true);
    await client.close();
  }, 60_000);
  it("a FULL (no ?member=) session: no credential or the other install's secret -> 401; its own secret -> full tool set", async () => {
    const urlA = new URL(`http://127.0.0.1:${a.port}/mcp`);
    const urlB = new URL(`http://127.0.0.1:${b.port}/mcp`);
    const none = await postInitialize(urlA, {});
    expect(none.status).toBe(401);
    expect(JSON.parse(none.body).error).toBe('access secret required');
    // B's secret presented to A, and A's to B, are refused.
    expect((await postInitialize(urlA, { [MEMBER_SECRET_HEADER]: b.secret! })).status).toBe(401);
    expect((await postInitialize(urlB, { [MEMBER_SECRET_HEADER]: a.secret! })).status).toBe(401);
    // Own secret opens a FULL session (execute_command is in the FULL set only).
    const client = new Client({ name: 'full-at-a', version: '1.0.0' }, { capabilities: {} });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(urlA, { reconnectionOptions: RECONNECT, requestInit: { headers: { [MEMBER_SECRET_HEADER]: a.secret! } } }));
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toContain('execute_command');
    await client.close();
  }, 60_000);
});
