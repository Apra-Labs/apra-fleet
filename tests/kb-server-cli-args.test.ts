/**
 * kb-server argument handling: --help/-h prints usage and exits 0; unknown flags,
 * value-less flags and an invalid --port fail with a usage error. In every such
 * case nothing may listen. Parser unit tests plus the built CLI in a child process
 * (temp cwd and data dir, short timeout, a port that must still be free after).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseKbServerArgs, KB_SERVER_USAGE } from '../src/commands/kb-server.js';
import { topLevelHelp } from '../src/cli/top-level-help.js';

const DIST_INDEX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const FLAGS = ['--port <n>', '--generate-token', '--db <path>', '--token-file <path>', '--help', '-h'];

describe('parseKbServerArgs', () => {
  it('--help and -h give a help result', () => {
    expect(parseKbServerArgs(['--help']).help).toBe(true);
    expect(parseKbServerArgs(['-h']).help).toBe(true);
    expect(parseKbServerArgs(['--bogus', '--help']).help).toBe(true);
    expect(parseKbServerArgs(['--help']).error).toBeUndefined();
  });
  it.each([
    [['--bogus']], [['--port']], [['--db']], [['--token-file']],
    [['--port', 'abc']], [['--port', '0']], [['--port', '70000']], [['--port', '80x']], [['--port', '--db', 'x']],
  ])('%j is a usage error', (argv) => {
    const r = parseKbServerArgs(argv);
    expect(r.error).toBeTruthy();
    expect(r.help).toBe(false);
  });
  it('valid flags parse as before', () => {
    expect(parseKbServerArgs([])).toMatchObject({ port: 7878, generateToken: false, help: false });
    expect(parseKbServerArgs(['--port', '9000', '--generate-token', '--db', '/d', '--token-file', '/t']))
      .toEqual({ port: 9000, generateToken: true, dbPath: '/d', tokenFile: '/t', help: false });
    expect(parseKbServerArgs(['--port', '65535']).port).toBe(65535);
  });
});

describe('help texts', () => {
  it('kb-server usage names every flag', () => {
    for (const f of FLAGS) expect(KB_SERVER_USAGE).toContain(f);
  });
  it('top-level help lists kb-server and its flags', () => {
    const h = topLevelHelp('9.9.9');
    expect(h).toContain('kb-server');
    for (const f of ['--port', '--generate-token', '--db', '--token-file']) expect(h).toContain(f);
  });
});

describe('built CLI: no listener for help or bad args', () => {
  let cwd: string;
  let dataDir: string;
  beforeAll(() => {
    if (!fs.existsSync(DIST_INDEX)) throw new Error(`built CLI missing at ${DIST_INDEX}: run npm run build first`);
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kbs-cwd-'));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbs-data-'));
  });

  const freePort = () => new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
  const run = (args: string[]) => spawnSync(process.execPath, [DIST_INDEX, 'kb-server', ...args], {
    cwd, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, APRA_FLEET_DATA_DIR: dataDir },
  });
  const portStillFree = (port: number) => new Promise<boolean>((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });

  it.each(['--help', '-h'])('%s exits 0 with every flag listed and binds nothing', async (h) => {
    const port = await freePort();
    const r = run(['--port', String(port), h]);
    expect(r.status).toBe(0);
    for (const f of FLAGS) expect(r.stdout).toContain(f);
    expect(await portStillFree(port)).toBe(true);
  });

  it.each([
    [['--bogus']], [['--port']], [['--db']], [['--token-file']], [['--port', 'abc']], [['--port', '0']], [['--port', '70000']],
  ])('%j fails with a usage error and binds nothing', async (argv) => {
    const r = run(argv);
    expect(r.status).not.toBe(0);
    expect(r.status).not.toBeNull(); // null = killed by the timeout, i.e. it started serving
    expect(r.stderr).toContain('Usage: apra-fleet kb-server');
  });

  it('a bogus flag next to a free --port leaves that port free', async () => {
    const port = await freePort();
    const r = run(['--port', String(port), '--bogus']);
    expect(r.status).not.toBe(0);
    expect(await portStillFree(port)).toBe(true);
  });
});
