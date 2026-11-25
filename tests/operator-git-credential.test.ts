/**
 * Operator git helper and gh token provider (src/cli/operator-auth.ts) mint a
 * fresh GitHub App installation token once the cached one is within 5 minutes
 * of expiry -- the no-hourly-401 property. Everything runs in-process: fetch
 * and the clock are stubbed, HOME/USERPROFILE/GIT_CONFIG_GLOBAL point at a temp
 * dir, FLEET_DIR is the per-run test data dir. No network, no real credential,
 * no real home or global git config.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { FLEET_DIR } from './test-helpers.js';

// Every child process the code under test starts, recorded (then really run).
const { spawned } = vi.hoisted(() => ({ spawned: [] as string[][] }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: ((file: string, args?: readonly string[], opts?: unknown) => {
      spawned.push([file, ...(args ?? [])]);
      return (actual.execFileSync as (...a: unknown[]) => unknown)(file, args, opts);
    }) as typeof actual.execFileSync,
    spawn: ((file: string, args?: readonly string[], opts?: unknown) => {
      spawned.push([file, ...(args ?? [])]);
      return (actual.spawn as (...a: unknown[]) => unknown)(file, args, opts);
    }) as typeof actual.spawn,
  };
});

import { runGitCredential, runOperatorAuth, operatorTokenCachePath, REFRESH_MARGIN_MS } from '../src/cli/operator-auth.js';

const GIT_CONFIG_PATH = path.join(FLEET_DIR, 'git-config.json');
// The operator record lives in a per-file temp dir, never the shared test
// FLEET_DIR: its presence changes every local member's dispatch prefix
// (vcs-git-env.ts), which other test files running in parallel assert on.
const recordState = vi.hoisted(() => ({ path: '' }));
vi.mock('../src/services/operator-auth-record.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/operator-auth-record.js')>()),
  operatorAuthRecordPath: () => recordState.path,
}));
let RECORD_PATH = '';
const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-01-01T00:00:00Z');

let tmp: string;
let savedEnv: Record<string, string | undefined>;
let gitConfigBackup: string | null = null;
let clock = T0;
let mints = 0;
const minted: string[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

function io(stdinText = '') {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out, err,
    io: {
      readStdin: async () => stdinText,
      stdout: (s: string) => { out.push(s); },
      stderr: (s: string) => { err.push(s); },
      now: () => clock,
      selfCommand: [path.join(tmp, 'bin', 'apra-fleet')],
    },
  };
}

const GET_GITHUB = 'protocol=https\nhost=github.com\n\n';

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'op-git-cred-'));
  RECORD_PATH = path.join(tmp, 'operator-auth.json');
  recordState.path = RECORD_PATH;
  savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL };
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.GIT_CONFIG_GLOBAL = path.join(tmp, 'gitconfig');
  fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');

  if (fs.existsSync(GIT_CONFIG_PATH)) gitConfigBackup = fs.readFileSync(GIT_CONFIG_PATH, 'utf8');
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const keyPath = path.join(tmp, 'app.pem');
  fs.writeFileSync(keyPath, privateKey);
  fs.mkdirSync(FLEET_DIR, { recursive: true });
  fs.writeFileSync(GIT_CONFIG_PATH, JSON.stringify({
    version: '1.0',
    github: { appId: '123456', privateKeyPath: keyPath, installationId: 4242, createdAt: new Date(T0).toISOString() },
  }));
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  if (gitConfigBackup !== null) fs.writeFileSync(GIT_CONFIG_PATH, gitConfigBackup);
  else fs.rmSync(GIT_CONFIG_PATH, { force: true });
  fs.rmSync(RECORD_PATH, { force: true });
  fs.rmSync(operatorTokenCachePath('github'), { force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  clock = T0;
  mints = 0;
  minted.length = 0;
  spawned.length = 0;
  fs.rmSync(operatorTokenCachePath('github'), { force: true });
  fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
    expect(url).toBe('https://api.github.com/app/installations/4242/access_tokens');
    expect(init?.method).toBe('POST');
    mints++;
    const token = `ghs_stubTOKEN${mints}xyz`;
    minted.push(token);
    return {
      ok: true, status: 201,
      json: async () => ({ token, expires_at: new Date(clock + HOUR).toISOString() }),
    };
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('operator git-credential helper', () => {
  it('needs the operator record: git-credential and operator-auth exec exit non-zero naming the setup command', async () => {
    fs.rmSync(RECORD_PATH, { force: true });
    const a = io(GET_GITHUB);
    expect(await runGitCredential(['get'], a.io)).not.toBe(0);
    expect(a.out.join('')).toBe('');
    expect(a.err.join('')).toContain('apra-fleet operator-auth github');

    const b = io();
    const runChild = vi.fn(async () => 0);
    expect(await runOperatorAuth(['exec', '--', 'gh', 'pr', 'list'], { ...b.io, runChild })).not.toBe(0);
    expect(runChild).not.toHaveBeenCalled();
    expect(b.out.join('')).toBe('');
    expect(b.err.join('')).toContain('apra-fleet operator-auth github');
    expect(mints).toBe(0);
  });

  it('sets up the operator record', async () => {
    const a = io();
    expect(await runOperatorAuth(['github'], a.io)).toBe(0);
    expect(fs.existsSync(RECORD_PATH)).toBe(true);
    expect(mints).toBe(0);
  });

  it('1-3: get mints once, reuses the cache, and re-mints once the token is within 5 minutes of expiry', async () => {
    // 1. first get mints exactly once.
    const first = io(GET_GITHUB);
    expect(await runGitCredential(['--label', 'github', 'get'], first.io)).toBe(0);
    expect(mints).toBe(1);
    const out1 = first.out.join('');
    expect(out1).toContain('username=x-access-token\n');
    expect(out1).toContain(`password=${minted[0]}\n`);

    // 2. inside the cache window: no new mint, same token.
    clock = T0 + HOUR - REFRESH_MARGIN_MS - 60_000;
    const second = io(GET_GITHUB);
    expect(await runGitCredential(['--label', 'github', 'get'], second.io)).toBe(0);
    expect(mints).toBe(1);
    expect(second.out.join('')).toContain(`password=${minted[0]}\n`);

    // 3. past (expiry - 5 min): a new token, never the expiring one.
    clock = T0 + HOUR - REFRESH_MARGIN_MS + 1_000;
    const third = io(GET_GITHUB);
    expect(await runGitCredential(['--label', 'github', 'get'], third.io)).toBe(0);
    expect(mints).toBe(2);
    expect(third.out.join('')).toContain(`password=${minted[1]}\n`);
    expect(third.out.join('')).not.toContain(minted[0]);
  });

  it('4: another host prints nothing, exits 0 and mints nothing', async () => {
    const a = io('protocol=https\nhost=gitlab.example.com\n\n');
    expect(await runGitCredential(['get'], a.io)).toBe(0);
    expect(a.out.join('')).toBe('');
    expect(a.err.join('')).toBe('');
    expect(mints).toBe(0);
  });

  it('store and erase are no-ops', async () => {
    for (const action of ['store', 'erase']) {
      const a = io('protocol=https\nhost=github.com\nusername=x\npassword=y\n\n');
      expect(await runGitCredential([action], a.io)).toBe(0);
      expect(a.out.join('')).toBe('');
    }
    expect(mints).toBe(0);
  });

  it('5: operator-auth exec gives the child GH_TOKEN in its env only; nothing is printed or returned; a new token after expiry', async () => {
    const seen: Array<{ command: string; args: string[]; token: string | undefined }> = [];
    const runChild = async (command: string, args: string[], env: NodeJS.ProcessEnv) => {
      seen.push({ command, args, token: env.GH_TOKEN });
      return 7;
    };
    const a = io();
    // The child's exit code is the only result; flags after `--` are the child's.
    expect(await runOperatorAuth(['exec', '--', 'gh', 'pr', 'list', '--label', 'x'], { ...a.io, runChild })).toBe(7);
    expect(seen).toEqual([{ command: 'gh', args: ['pr', 'list', '--label', 'x'], token: minted[0] }]);
    expect(a.out.join('') + a.err.join('')).toBe('');
    expect(process.env.GH_TOKEN).not.toBe(minted[0]);

    clock = T0 + HOUR - REFRESH_MARGIN_MS + 1_000;
    const b = io();
    expect(await runOperatorAuth(['exec', '--', 'gh'], { ...b.io, runChild })).toBe(7);
    expect(mints).toBe(2);
    expect(seen[1].token).toBe(minted[1]);
    expect(b.out.join('') + b.err.join('')).toBe('');
  });

  it('exec redacts the token in the child output: gh-auth-token-style stdout, and a token split across chunks on stderr', async () => {
    const MARK = '[REDACTED:vcs_token]';
    const a = io();
    const runChild = async (_c: string, _a: string[], env: NodeJS.ProcessEnv,
      onStdout: (c: Buffer | string) => void, onStderr: (c: Buffer | string) => void) => {
      const t = env.GH_TOKEN!;
      onStdout(Buffer.from(`${t}\n`)); // what `gh auth token` prints
      onStderr('GH_TOKEN=' + t.slice(0, 5));
      onStderr(Buffer.from(t.slice(5) + ' done\n'));
      return 0;
    };
    expect(await runOperatorAuth(['exec', '--', 'gh', 'auth', 'token'], { ...a.io, runChild })).toBe(0);
    expect(a.out.join('')).toBe(`${MARK}\n`);
    expect(a.err.join('')).toBe(`GH_TOKEN=${MARK} done\n`);
    expect(a.out.join('') + a.err.join('')).not.toContain(minted[0]);
  });

  it('exec redacts a real child that echoes GH_TOKEN on stdout and stderr', async () => {
    const MARK = '[REDACTED:vcs_token]';
    const a = io();
    const script = 'process.stdout.write(process.env.GH_TOKEN + "\\n"); process.stderr.write("tok:" + process.env.GH_TOKEN)';
    const { runChild: _omit, ...aio } = a.io as typeof a.io & { runChild?: unknown };
    expect(await runOperatorAuth(['exec', '--', process.execPath, '-e', script], aio)).toBe(0);
    expect(a.out.join('')).toBe(`${MARK}\n`);
    expect(a.err.join('')).toBe(`tok:${MARK}`);
  });

  it('exec without a command after -- is a usage error and mints nothing', async () => {
    const before = mints;
    for (const argv of [['exec'], ['exec', '--'], ['exec', 'gh']]) {
      const a = io();
      const runChild = vi.fn(async () => 0);
      expect(await runOperatorAuth(argv, { ...a.io, runChild })).toBe(2);
      expect(runChild).not.toHaveBeenCalled();
      expect(a.err.join('')).toContain("after '--'");
    }
    expect(mints).toBe(before);
  });

  it('the token subcommand is gone', async () => {
    const a = io();
    expect(await runOperatorAuth(['token'], a.io)).toBe(2);
    expect(a.out.join('')).toBe('');
  });

  it('6: the cache is owner-only and the token never reaches argv, stderr or logs', async () => {
    const logged: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(m =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); }));
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { logged.push(String(chunk)); return true; });
    try {
      const a = io(GET_GITHUB);
      expect(await runGitCredential(['get'], a.io)).toBe(0);
      // A real child (default spawn, no shell) receives the token in its env
      // and reports only whether it matched, through a file.
      const marker = path.join(tmp, 'child-saw-token');
      const b = io();
      const childScript = 'require("fs").writeFileSync(process.argv[1], process.env.GH_TOKEN === undefined ? "unset" : "len=" + process.env.GH_TOKEN.length)';
      const { runChild: _omit, ...bio } = b.io as typeof b.io & { runChild?: unknown };
      expect(await runOperatorAuth(['exec', '--', process.execPath, '-e', childScript, marker], bio)).toBe(0);
      expect(fs.readFileSync(marker, 'utf8')).toBe(`len=${minted[0].length}`);
      expect(b.out.join('')).toBe('');
      // Re-run setup too: it spawns git/sh/powershell.
      const c = io();
      expect(await runOperatorAuth(['github'], c.io)).toBe(0);

      const token = minted[0];
      expect(token).toBeTruthy();
      expect(spawned.length).toBeGreaterThan(0);
      for (const argv of spawned) expect(argv.join(' ')).not.toContain(token);
      expect(a.err.join('') + b.err.join('') + c.err.join('') + c.out.join('')).not.toContain(token);
      for (const line of logged) expect(line).not.toContain(token);

      const cache = operatorTokenCachePath('github');
      expect(fs.existsSync(cache)).toBe(true);
      if (process.platform !== 'win32') {
        expect(fs.statSync(cache).mode & 0o777).toBe(0o600);
      }
    } finally {
      for (const s of spies) s.mockRestore();
      errSpy.mockRestore();
    }
  });
});
