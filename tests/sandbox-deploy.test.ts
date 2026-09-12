import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  safeSandboxId,
  valuesFilePath,
  sandboxRootPath,
  parseValues,
  serializeValues,
  writeValues,
  readValues,
  allocatePorts,
  isPidAlive,
  init,
  teardown,
  // @ts-expect-error -- plain .mjs helper, no type declarations
} from '../scripts/sandbox-deploy.mjs';

// deploy.md's "## Sandbox Deploy" lifecycle (scripts/sandbox-deploy.mjs):
// the values-file discovery channel, the pid-checked teardown order, and
// init's stale-sandbox self-heal -- all against throwaway homes under
// os.tmpdir() and OS-assigned ports, never the real HOME. The live path
// (`up`: real dist/index.js + serve.mjs) is exercised at the end only when
// dist/index.js exists (CI builds before `npm test`).
const REPO_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'scripts', 'sandbox-deploy.mjs');

function mkHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-deploy-test-'));
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

// A stand-in "server": answers GET /health and /api/health with a pid of the
// caller's choosing, so teardown's identity check can be driven both ways.
const FAKE_SERVER = `
const http = require('node:http');
const [port, pidToReport] = process.argv.slice(1);
const pid = pidToReport === 'self' ? process.pid : Number(pidToReport);
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', pid, uptimeSeconds: 1 }));
}).listen(Number(port), '127.0.0.1', () => process.stdout.write('LISTENING\\n'));
`;

interface Fake { child: ChildProcess; pid: number; port: number }
const fakes: Fake[] = [];

function osPort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)); });
  });
}

async function spawnFake(reportPid: 'self' | number): Promise<Fake> {
  const port = await osPort();
  const child = spawn(process.execPath, ['-e', FAKE_SERVER, String(port), String(reportPid)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('fake server did not start')), 5000);
    child.stdout!.on('data', (d: Buffer) => { if (d.toString().includes('LISTENING')) { clearTimeout(t); resolve(); } });
  });
  const fake = { child, pid: child.pid!, port };
  fakes.push(fake);
  return fake;
}

const homes: string[] = [];
afterEach(() => {
  for (const f of fakes.splice(0)) { try { f.child.kill('SIGKILL'); } catch { /* gone */ } }
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

describe('naming: everything derives from the sprintId alone', () => {
  it('is deterministic, filesystem-safe, and collision-free for ids that sanitize alike', () => {
    const a = safeSandboxId('auto-sprint/mock-sprint');
    expect(a).toBe(safeSandboxId('auto-sprint/mock-sprint'));
    expect(a).toMatch(/^auto-sprint-mock-sprint-[0-9a-f]{8}$/);
    expect(safeSandboxId('auto-sprint-mock-sprint')).not.toBe(a);
    expect(safeSandboxId('x'.repeat(200)).length).toBeLessThanOrEqual(49);
    expect(() => safeSandboxId('')).toThrow();
  });

  it('puts the values file OUTSIDE the sandbox root, both under the given home', () => {
    const home = path.join(os.tmpdir(), 'h');
    const file = valuesFilePath('a/b', home);
    const root = sandboxRootPath('a/b', home);
    expect(path.dirname(file)).toBe(home);
    expect(root.startsWith(path.join(home, 'tmp', 'fleet-sandbox-'))).toBe(true);
    expect(file.startsWith(root)).toBe(false);
  });
});

describe('values file: flat KEY=value, round-trips without any shell', () => {
  it('parses and serializes, ignoring comments/blank lines and keeping = inside values', () => {
    const text = '# c\n\nA=1\nB=x=y\nBAD\n';
    expect(parseValues(text)).toEqual({ A: '1', B: 'x=y' });
    expect(parseValues(serializeValues({ A: '1', B: 'x=y', EMPTY: '' }))).toEqual({ A: '1', B: 'x=y' });
  });

  it('write/read against a home dir', () => {
    const home = mkHome(); homes.push(home);
    writeValues('s/1', { APRA_FLEET_PORT: '1234' }, home);
    expect(readValues('s/1', home)).toEqual({ APRA_FLEET_PORT: '1234' });
    expect(readValues('s/2', home)).toBeNull();
  });
});

describe('port allocation', () => {
  it('returns two non-adjacent ports and never a reserved production/test port', async () => {
    // 40002 is rejected for being adjacent to 40001: the observed sandbox
    // collision handed back a consecutive pair.
    const seq = [7523, 8787, 18700, 40001, 40001, 40002, 18701, 40010];
    const ports = await allocatePorts(async () => seq.shift()!);
    expect(ports).toEqual({ fleetPort: 40001, supervisorPort: 40010 });
  });
});

describe('init', () => {
  it('creates root dirs and a values file whose ports are free and distinct', async () => {
    const home = mkHome(); homes.push(home);
    const v = await init('auto-sprint/x', { home });
    expect(fs.existsSync(path.join(v.SANDBOX_ROOT, 'mcp'))).toBe(true);
    expect(fs.existsSync(path.join(v.SANDBOX_ROOT, 'se'))).toBe(true);
    expect(v.APRA_FLEET_DATA_DIR).toBe(path.join(v.SANDBOX_ROOT, 'mcp'));
    expect(v.FLEET_SE_SWEEP_OWNER_DATA_DIR).toBe(v.SANDBOX_ROOT);
    expect(v.APRA_FLEET_PORT).not.toBe(v.SUPERVISOR_PORT);
    expect(await isPortFree(Number(v.APRA_FLEET_PORT))).toBe(true);
    expect(readValues('auto-sprint/x', home)).toEqual(v);
  });

  it('self-heals a stale values file (nothing alive) before re-initializing', async () => {
    const home = mkHome(); homes.push(home);
    const stale = await init('s', { home });
    fs.writeFileSync(path.join(stale.SANDBOX_ROOT, 'stale.txt'), 'x');
    const fresh = await init('s', { home });
    expect(fresh.CREATED_AT).not.toBe(stale.CREATED_AT);
    expect(fs.existsSync(path.join(fresh.SANDBOX_ROOT, 'stale.txt'))).toBe(false);
  });
});

describe('teardown', () => {
  it('no values file: nothing to tear down, exit 0 via the CLI', () => {
    const home = mkHome(); homes.push(home);
    const r = spawnSync(process.execPath, [CLI, 'teardown', '--sprint-id', 'none', '--home', home], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('nothing to tear down');
  });

  it('server.json missing: skips straight to directory removal', async () => {
    const home = mkHome(); homes.push(home);
    const v = await init('s', { home });
    const r = await teardown('s', { home });
    expect(r.removed).toBe(true);
    expect(fs.existsSync(v.SANDBOX_ROOT)).toBe(false);
    expect(fs.existsSync(valuesFilePath('s', home))).toBe(false);
  });

  it('kills the recorded pids when they answer /health as themselves, then removes root + values file', async () => {
    const home = mkHome(); homes.push(home);
    const mcp = await spawnFake('self');
    const sup = await spawnFake('self');
    const v = await init('s', { home });
    fs.writeFileSync(path.join(v.APRA_FLEET_DATA_DIR, 'server.json'), JSON.stringify({ pid: mcp.pid, port: mcp.port }));
    writeValues('s', { ...v, APRA_FLEET_PORT: String(mcp.port), MCP_PID: String(mcp.pid), SUPERVISOR_PORT: String(sup.port), SUPERVISOR_PID: String(sup.pid) }, home);
    const r = await teardown('s', { home });
    expect(r.removed).toBe(true);
    expect(isPidAlive(mcp.pid)).toBe(false);
    expect(isPidAlive(sup.pid)).toBe(false);
    expect(fs.existsSync(v.SANDBOX_ROOT)).toBe(false);
    expect(fs.existsSync(valuesFilePath('s', home))).toBe(false);
  }, 30000); // the fake supervisor ignores POST /api/shutdown, so teardown waits its 5s grace before TERM

  it('refuses to kill a squatter: server.json names a live pid that is neither ours nor answering as itself, and KEEPS the root', async () => {
    const home = mkHome(); homes.push(home);
    // The squatter listens on the sandbox port but reports a different pid.
    const squatter = await spawnFake(1);
    const v = await init('s', { home });
    fs.writeFileSync(path.join(v.APRA_FLEET_DATA_DIR, 'server.json'), JSON.stringify({ pid: squatter.pid, port: squatter.port }));
    writeValues('s', { ...v, APRA_FLEET_PORT: String(squatter.port), MCP_PID: '' }, home);
    await expect(teardown('s', { home })).rejects.toThrow(/not killing a process that may not be ours|still bound/);
    expect(isPidAlive(squatter.pid)).toBe(true);
    expect(fs.existsSync(v.SANDBOX_ROOT)).toBe(true);
    expect(fs.existsSync(valuesFilePath('s', home))).toBe(true);
  }, 30000); // teardown polls the still-bound port for 5s before giving up
});

const DIST = path.join(REPO_ROOT, 'dist', 'index.js');
describe.skipIf(!fs.existsSync(DIST))('live: up / env / teardown across separate invocations', () => {
  it('brings a real isolated pair up, locates it from the sprintId alone, and tears it down', async () => {
    const home = mkHome(); homes.push(home);
    const id = 'auto-sprint/live-test';
    const up = spawnSync(process.execPath, [CLI, 'up', '--sprint-id', id, '--home', home], { encoding: 'utf8', timeout: 90000 });
    try {
      expect(up.status, up.stderr).toBe(0);
      const v = parseValues(up.stdout);
      expect(Number(v.APRA_FLEET_PORT)).not.toBe(7523);
      expect(await isPortFree(Number(v.APRA_FLEET_PORT))).toBe(false);
      const env = spawnSync(process.execPath, [CLI, 'env', '--sprint-id', id, '--home', home], { encoding: 'utf8' });
      expect(env.status).toBe(0);
      expect(parseValues(env.stdout).MCP_PID).toBe(v.MCP_PID);
      const verify = spawnSync(process.execPath, [CLI, 'verify', '--sprint-id', id, '--home', home], { encoding: 'utf8', timeout: 30000 });
      expect(verify.status, verify.stderr).toBe(0);
    } finally {
      const td = spawnSync(process.execPath, [CLI, 'teardown', '--sprint-id', id, '--home', home], { encoding: 'utf8', timeout: 30000 });
      expect(td.status, td.stderr).toBe(0);
    }
    expect(fs.existsSync(valuesFilePath(id, home))).toBe(false);
  }, 150000);
});
