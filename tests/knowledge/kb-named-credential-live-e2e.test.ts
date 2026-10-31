import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HttpKbProvider, KbHttpAuthError } from '../../src/services/knowledge/http-provider.js';
import { getKbProviders, resetKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { KB_CONFIG_PATH } from '../../src/services/knowledge/kb-config.js';
import { resetKbHttpAuthState } from '../../src/services/knowledge/kb-http-auth-state.js';
import { kbHealthSummary, kbCredentialCompactLine } from '../../src/tools/check-status.js';
import { kbCapture } from '../../src/tools/kb-capture.js';
import { credentialDelete } from '../../src/services/credential-store.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';
import { isolateGitConfig } from './isolate-git-config.js';

// Live end-to-end check of a named KB credential (kb_setup token
// {{secret.NAME}}) against the BUILT kb-server running as a separate process
// with --token-file, with secrets set through the real `apra-fleet secret`
// CLI in yet another process (the cross-process atomic-write path). The
// provider and KB tools run in this process. Nothing here is OS specific:
// every command is an argv array built in JS, no shell is involved.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = path.resolve(__dirname, '..', '..', 'dist', 'index.js');
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const NAME = `KB_LIVE_${RUN}`;
const CANARY = `zq-canary-live-${RUN}`;
const TOKEN_A = `${CANARY}-A`;
const TOKEN_B = `${CANARY}-B`;
const ORIGIN = `https://example.test/kb-live-${RUN}.git`;

let scratch: string;
let repo: string;
let tokenFile: string;
let kbUrl: string;
let child: ChildProcess | undefined;
let childPid = 0;
let savedConfig: string | null;
let restoreGitConfig: () => void;
const childLogs: string[] = [];
const outputs: string[] = [];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

function killTree(c: ChildProcess | undefined): void {
  if (!c || !c.pid || c.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      c.kill('SIGKILL');
    }
  } catch { /* already gone */ }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function secretCli(args: string[], stdin?: string): void {
  const r = execFileSync(process.execPath, [DIST_INDEX, 'secret', ...args], {
    input: stdin, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], env: process.env, timeout: 30000,
  });
  outputs.push(String(r));
}

const setSecret = (value: string) => secretCli(['--set', NAME, '--persist', '-y'], `${value}\n`);

function probe(token: string): Promise<number> {
  return new Promise((resolve) => {
    const req = http.get(`${kbUrl}/api/kb/query?query=probe`, { headers: { Authorization: `Bearer ${token}` } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', () => resolve(0));
  });
}

async function waitFor(cond: () => Promise<boolean>, what: string, ms = 15000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function entry(title: string): KBEntryInput {
  return {
    type: 'learning', title, summary: `${title} -- summary for the live named credential check`,
    content: `${title} content`, source_files: ['src/gear.ts'], symbols: [], tags: [],
    content_hash: '', content_hash_type: 'sha256', flagged_for_review: false,
    author: 'test', source: 'session', confidence: 'INFERRED',
  };
}

async function provider(): Promise<HttpKbProvider> {
  const p = (await getKbProviders(repo)).project;
  expect(p).toBeInstanceOf(HttpKbProvider);
  return p as HttpKbProvider;
}

async function expectAuth(p: Promise<unknown>, reason: string): Promise<KbHttpAuthError> {
  let caught: unknown;
  try { await p; } catch (err) { caught = err; }
  expect(caught).toBeInstanceOf(KbHttpAuthError);
  const err = caught as KbHttpAuthError;
  outputs.push(err.message, err.stack ?? '');
  expect(err.code).toBe('E-KB-HTTP-AUTH');
  expect(err.reason).toBe(reason);
  expect(err.message).toContain(`"${NAME}"`);
  return err;
}

beforeAll(async () => {
  if (!fs.existsSync(DIST_INDEX)) throw new Error(`built CLI missing at ${DIST_INDEX}: run npm run build first`);
  restoreGitConfig = isolateGitConfig();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-live-'));
  repo = path.join(scratch, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.fleet'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'gear.ts'), 'export const gear = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', ORIGIN], { cwd: repo });

  tokenFile = path.join(scratch, 'kb-token.txt');
  fs.writeFileSync(tokenFile, `${TOKEN_A}\n`);
  const port = await freePort();
  kbUrl = `http://127.0.0.1:${port}`;
  // The kb-server child gets its own data dir so it never shares state with
  // this process's fleet data dir (where the secret lives).
  const serverData = path.join(scratch, 'server-data');
  fs.mkdirSync(serverData, { recursive: true });
  child = spawn(process.execPath, [
    DIST_INDEX, 'kb-server', '--port', String(port), '--db', path.join(scratch, 'kb.sqlite'), '--token-file', tokenFile,
  ], { cwd: repo, env: { ...process.env, APRA_FLEET_DATA_DIR: serverData }, stdio: ['ignore', 'pipe', 'pipe'] });
  childPid = child.pid ?? 0;
  child.stdout?.on('data', (d: Buffer) => childLogs.push(String(d)));
  child.stderr?.on('data', (d: Buffer) => childLogs.push(String(d)));
  await waitFor(async () => (await probe(TOKEN_A)) === 200, 'kb-server to accept token A');

  savedConfig = fs.existsSync(KB_CONFIG_PATH) ? fs.readFileSync(KB_CONFIG_PATH, 'utf-8') : null;
  fs.mkdirSync(path.dirname(KB_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(KB_CONFIG_PATH, JSON.stringify({ provider: 'http', url: kbUrl, token_ref: `{{secret.${NAME}}}` }, null, 2));
  resetKbProviders();
  resetKbHttpAuthState();
}, 60000);

afterAll(async () => {
  resetKbProviders();
  killTree(child);
  if (child && child.exitCode === null) {
    await new Promise<void>(resolve => { child!.once('exit', () => resolve()); setTimeout(resolve, 5000); });
  }
  try { credentialDelete(NAME); } catch { /* best effort */ }
  if (savedConfig === null) fs.rmSync(KB_CONFIG_PATH, { force: true });
  else if (savedConfig !== undefined) fs.writeFileSync(KB_CONFIG_PATH, savedConfig);
  fs.rmSync(scratch, { recursive: true, force: true });
  restoreGitConfig?.();
  // No leftover process or files after the run.
  await waitFor(async () => !pidAlive(childPid), 'kb-server process to exit', 5000);
  expect(fs.existsSync(scratch)).toBe(false);
});

describe('named KB credential: live rotation against the built kb-server', () => {
  it('rotates, expires and goes missing without restarting the server or provider', async () => {
    // 1. server file = A, secret = A: capture OK
    setSecret(TOKEN_A);
    const p = await provider();
    const first = await p.capture(entry('Live gear one'));
    expect(first.id).toBeTruthy();

    // 2. rotate the server file to B: 401 -> E-KB-HTTP-AUTH naming NAME, queued
    fs.writeFileSync(tokenFile, `${TOKEN_B}\n`);
    await waitFor(async () => (await probe(TOKEN_B)) === 200, 'kb-server to pick up token B');
    const rejected = await expectAuth(p.capture(entry('Live gear queued')), 'rejected');
    expect(rejected.queued).toBe(true);
    expect(p.offlineQueue).toHaveLength(1);

    // 3. secret set to B through the CLI process: next capture OK, queue flushes,
    // same provider instance, same kb-server process
    setSecret(TOKEN_B);
    expect(await provider()).toBe(p);
    await p.capture(entry('Live gear after rotation'));
    expect(p.offlineQueue).toHaveLength(0);
    expect(child!.pid).toBe(childPid);
    expect(child!.exitCode).toBeNull();
    expect(pidAlive(childPid)).toBe(true);

    // 5. fleet_status credential line
    const health = await kbHealthSummary({ repoPath: repo });
    const cred = health?.credential;
    expect(cred?.kind).toBe('secret');
    if (cred?.kind === 'secret') {
      expect(cred.secretName).toBe(NAME);
      expect(cred.resolves).toBe('ok');
      expect(cred.lastSuccessfulCall).toBeTruthy();
      expect(cred.lastRejectedCall).toBeTruthy();
      expect(kbCredentialCompactLine(cred)).toContain(`secret ${NAME} | resolves: ok`);
      outputs.push(kbCredentialCompactLine(cred), JSON.stringify(health));
    }

    // 4a. expired secret (ttl through the CLI), then 4b. deleted secret
    secretCli(['--update', NAME, '--ttl', '1']);
    await new Promise(r => setTimeout(r, 1500));
    await expectAuth(p.capture(entry('Live gear expired')), 'expired');
    secretCli(['--delete', NAME]);
    await expectAuth(p.capture(entry('Live gear missing')), 'missing');

    // 6. the canary as a token never shows in tool output, errors or logs
    setSecret(TOKEN_A); // server now wants B: rejected
    try {
      await kbCapture({ type: 'learning', title: 'Live tool level gear', summary: 'Tool level capture under auth failure', content: 'x', source_files: ['src/gear.ts'] } as never, { folder: repo });
    } catch (err) {
      outputs.push((err as Error).message, (err as Error).stack ?? '');
    }
    const all = [...outputs, ...childLogs].join('\n');
    expect(all).not.toContain(CANARY);
  }, 90000);
});
