/**
 * `kb-server --generate-token` end to end: the built CLI in a child process
 * against an isolated fleet data dir. It must write <data dir>/knowledge/
 * kb-server.token, name that path, and exit 0 by itself (never serve). A write
 * failure exits non-zero naming path and reason. Combined with --token-file it
 * is still refused.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIST_INDEX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});
const portStillFree = (port: number) => new Promise<boolean>((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});

describe('built CLI: kb-server --generate-token', () => {
  let root: string;
  beforeAll(() => {
    if (!fs.existsSync(DIST_INDEX)) throw new Error(`built CLI missing at ${DIST_INDEX}: run npm run build first`);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kbs-gen-'));
  });
  afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const run = (dataDir: string, args: string[]) => spawnSync(process.execPath, [DIST_INDEX, 'kb-server', ...args], {
    cwd: root, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, APRA_FLEET_DATA_DIR: dataDir },
  });

  it('writes the token file (creating its folder), names it, exits 0 and serves nothing', async () => {
    const dataDir = path.join(root, 'ok-data');
    fs.mkdirSync(dataDir);
    const tokenPath = path.join(dataDir, 'knowledge', 'kb-server.token');
    expect(fs.existsSync(path.dirname(tokenPath))).toBe(false);
    const port = await freePort();
    const r = run(dataDir, ['--port', String(port), '--generate-token']);
    expect(r.error).toBeUndefined(); // a timeout kill would surface here
    expect(r.status).toBe(0);
    expect(fs.statSync(tokenPath).size).toBeGreaterThan(0);
    const out = r.stdout + r.stderr;
    expect(out).toContain(tokenPath);
    expect(out).toMatch(/KB server token: [0-9a-f]{64}/);
    expect(fs.readFileSync(tokenPath, 'utf8')).not.toContain(out.match(/KB server token: ([0-9a-f]{64})/)![1]);
    expect(fs.readdirSync(path.dirname(tokenPath))).toEqual(['kb-server.token']);
    expect(await portStillFree(port)).toBe(true);
  });

  it('an unwritable knowledge folder exits non-zero naming the path and the reason', async () => {
    const dataDir = path.join(root, 'bad-data');
    fs.mkdirSync(dataDir);
    const knowledge = path.join(dataDir, 'knowledge');
    fs.writeFileSync(knowledge, 'i am a file, not a folder');
    const port = await freePort();
    const r = run(dataDir, ['--port', String(port), '--generate-token']);
    expect(r.error).toBeUndefined();
    expect(r.status).not.toBe(0);
    const out = r.stdout + r.stderr;
    expect(out).toContain(path.join(knowledge, 'kb-server.token'));
    expect(out).toMatch(/ENOTDIR|EEXIST|not a directory/i);
    expect(fs.readFileSync(knowledge, 'utf8')).toBe('i am a file, not a folder');
    expect(await portStillFree(port)).toBe(true);
  });

  it('--generate-token with --token-file is still refused', () => {
    const dataDir = path.join(root, 'refuse-data');
    fs.mkdirSync(dataDir);
    const r = run(dataDir, ['--generate-token', '--token-file', path.join(root, 'tok.txt')]);
    expect(r.error).toBeUndefined();
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('cannot be combined with --token-file');
    expect(fs.existsSync(path.join(dataDir, 'knowledge'))).toBe(false);
  });
});
