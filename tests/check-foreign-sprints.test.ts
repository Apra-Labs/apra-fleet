import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseArgs,
  defaultSeDataDir,
  readServiceToken,
  run,
  // @ts-expect-error -- plain .mjs helper, no type declarations
} from '../scripts/check-foreign-sprints.mjs';

// apra-fleet-50j6.3: since the loopback-bearer sprint, every /api/* route on
// the supervisor requires an Authorization: Bearer <token> header, so
// scripts/check-foreign-sprints.mjs must send one -- and, critically, must
// never mistake a 401 (auth failure) for "no live sprints" (its old !res.ok
// branch treated ALL non-2xx responses, including 401, as a clean proceed).
//
// apra-fleet-ky2l.1.2 (DQ-20): readServiceToken() now resolves the token via
// auth.mjs's resolveServiceToken() -- the shared ~/.apra-fleet/fleet.key when
// present, else a mint-or-reuse of <dataDir>/private/token -- rather than a
// direct, non-mutating read of <dataDir>/private/token alone. Every test
// below pins `home` to a fixture with NO fleet.key so it deterministically
// exercises the private/token fallback and never touches (or depends on) the
// real ~/.apra-fleet/fleet.key on the machine running this suite.
//
// run() takes an injected fetchImpl/dataDir/home instead of the real network/
// process.argv/process.exit/os.homedir() that main() uses, so these tests
// drive the exact same logic main() calls without a subprocess or a real
// socket, and without depending on the real machine's fleet.key.

const VALID_TOKEN = 'a'.repeat(64);

const dirs: string[] = [];
afterEach(() => {
  for (const h of dirs.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

function mkSeDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-foreign-sprints-test-'));
  dirs.push(dir);
  return dir;
}

/** A fixture "home" with no ~/.apra-fleet/fleet.key -- pinned via readServiceToken's
 *  `home` option so every test in this file is isolated from the real machine's
 *  fleet.key (apra-fleet-ky2l.1.2). */
function mkHomeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-foreign-sprints-test-home-'));
  dirs.push(dir);
  return dir;
}

function writeToken(seDataDir: string, token: string): void {
  const privateDir = path.join(seDataDir, 'private');
  fs.mkdirSync(privateDir, { recursive: true });
  fs.writeFileSync(path.join(privateDir, 'token'), token, { encoding: 'utf8' });
}

/** A stand-in supervisor `fetch`: 401s any request whose Bearer token isn't `expectedToken`. */
function fakeAuthedFetch(expectedToken: string, sprints: unknown[] = []) {
  return vi.fn(async (_url: string, init?: { headers?: Record<string, string> }) => {
    const auth = init?.headers?.Authorization;
    if (auth !== `Bearer ${expectedToken}`) {
      return { ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) };
    }
    return { ok: true, status: 200, json: async () => ({ sprints }) };
  });
}

function fakeUnreachableFetch() {
  return vi.fn(async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:1');
  });
}

describe('defaultSeDataDir', () => {
  it('honors FLEET_SE_DATA_DIR when set', () => {
    const prev = process.env.FLEET_SE_DATA_DIR;
    try {
      process.env.FLEET_SE_DATA_DIR = path.join(os.tmpdir(), 'custom-se-dir');
      expect(defaultSeDataDir()).toBe(path.resolve(process.env.FLEET_SE_DATA_DIR));
    } finally {
      if (prev === undefined) delete process.env.FLEET_SE_DATA_DIR;
      else process.env.FLEET_SE_DATA_DIR = prev;
    }
  });

  it('falls back to ~/.apra-fleet-se when unset', () => {
    const prev = process.env.FLEET_SE_DATA_DIR;
    try {
      delete process.env.FLEET_SE_DATA_DIR;
      expect(defaultSeDataDir()).toBe(path.join(os.homedir(), '.apra-fleet-se'));
    } finally {
      if (prev !== undefined) process.env.FLEET_SE_DATA_DIR = prev;
    }
  });
});

describe('readServiceToken (apra-fleet-ky2l.1.2: resolves via auth.mjs resolveServiceToken)', () => {
  it('resolves the shared fleet.key when present at the pinned home', () => {
    const dir = mkSeDataDir();
    const home = mkHomeDir();
    fs.mkdirSync(path.join(home, '.apra-fleet'), { recursive: true });
    fs.writeFileSync(path.join(home, '.apra-fleet', 'fleet.key'), VALID_TOKEN, 'utf8');

    expect(readServiceToken(dir, { home })).toBe(VALID_TOKEN);
  });

  it('falls back to the trimmed private/token content when fleet.key is absent', () => {
    const dir = mkSeDataDir();
    const home = mkHomeDir();
    writeToken(dir, `${VALID_TOKEN}\n`);

    expect(readServiceToken(dir, { home })).toBe(VALID_TOKEN);
  });

  it('apra-fleet-ky2l.13: returns undefined and never creates private/token when neither fleet.key nor private/token exist yet', () => {
    const dir = mkSeDataDir();
    const home = mkHomeDir();

    const token = readServiceToken(dir, { home });

    expect(token).toBeUndefined();
    expect(fs.existsSync(path.join(dir, 'private'))).toBe(false);
  });

  it('apra-fleet-ky2l.13: returns undefined for a blank private/token file rather than healing (re-minting) it', () => {
    const dir = mkSeDataDir();
    const home = mkHomeDir();
    writeToken(dir, '   \n');

    const token = readServiceToken(dir, { home });

    expect(token).toBeUndefined();
    // Read-only: the blank file is left exactly as it was, never unlinked/re-minted.
    expect(fs.readFileSync(path.join(dir, 'private', 'token'), 'utf8')).toBe('   \n');
  });
});

describe('parseArgs (unaffected by the auth change)', () => {
  it('still parses --url/--self-sprint-id/--self-child-pid', () => {
    const opts = parseArgs(['--url', 'http://x', '--self-sprint-id', 's1', '--self-child-pid', '42']);
    expect(opts).toEqual({ url: 'http://x', sprintId: 's1', childPid: 42 });
  });
});

describe('run(): 401 is never silently interpreted as an empty sprint list', () => {
  it('apra-fleet-ky2l.13: returns nonzero and reports "no token could be read" (read-only -- never mints) when neither token source exists yet', async () => {
    const seDataDir = mkSeDataDir(); // no token file written
    const home = mkHomeDir(); // no fleet.key
    const fetchImpl = fakeAuthedFetch(VALID_TOKEN);
    const errLines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((msg: string) => { errLines.push(msg); });
    try {
      const code = await run(['--self-sprint-id', 'self-1', '--url', 'http://fake/api/sprints'], { fetchImpl, dataDir: seDataDir, home });

      expect(code).not.toBe(0);
      expect(code).not.toBe(3); // not the "foreign sprint" STOP code either -- this is an auth failure
      const combined = errLines.join('\n');
      expect(combined).toMatch(/401/);
      expect(combined).toMatch(/no token could be read/);
      // The old !res.ok branch's "proceed" wording is what would have leaked
      // through if a 401 were misread as an empty/clean sprint list -- assert
      // that phrasing never appears on this path.
      expect(combined.toLowerCase()).not.toMatch(/proceed/);
      // Read-only (apra-fleet-ky2l.13): this preflight must not mint a
      // credential as a side effect of a failed check.
      expect(fs.existsSync(path.join(seDataDir, 'private'))).toBe(false);
      expect(fetchImpl).toHaveBeenCalledWith('http://fake/api/sprints', { headers: {} });
    } finally {
      spy.mockRestore();
    }
  });

  it('returns nonzero and reports the (unchanged) stale-token message when the on-disk token is stale', async () => {
    const seDataDir = mkSeDataDir();
    const home = mkHomeDir();
    writeToken(seDataDir, 'b'.repeat(64)); // wrong token
    const fetchImpl = fakeAuthedFetch(VALID_TOKEN);
    const errLines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((msg: string) => { errLines.push(msg); });
    try {
      const code = await run(['--self-sprint-id', 'self-1', '--url', 'http://fake/api/sprints'], { fetchImpl, dataDir: seDataDir, home });

      expect(code).not.toBe(0);
      expect(code).not.toBe(3);
      const combined = errLines.join('\n');
      expect(combined).toMatch(/401/);
      expect(combined).toMatch(/may be stale\/rotated/);
      // A token WAS read here, so this must stay the stale-token message, not
      // the "no token could be read" wording that the no-token case above gets.
      expect(combined).not.toMatch(/no token could be read/);
      expect(combined.toLowerCase()).not.toMatch(/proceed/);
    } finally {
      spy.mockRestore();
    }
  });

  it('sends the on-disk token and proceeds normally once authorized', async () => {
    const seDataDir = mkSeDataDir();
    const home = mkHomeDir();
    writeToken(seDataDir, VALID_TOKEN);
    const fetchImpl = fakeAuthedFetch(VALID_TOKEN, [{ sprintId: 'self-1', childPid: 123 }]);
    const outLines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((msg: string) => { outLines.push(msg); });
    try {
      const code = await run(['--self-sprint-id', 'self-1', '--url', 'http://fake/api/sprints'], { fetchImpl, dataDir: seDataDir, home });

      expect(code).toBe(0);
      expect(outLines.join('\n')).toMatch(/own reservation \(not foreign\): self-1/);
      expect(fetchImpl).toHaveBeenCalledWith('http://fake/api/sprints', { headers: { Authorization: `Bearer ${VALID_TOKEN}` } });
    } finally {
      spy.mockRestore();
    }
  });

  it('still proceeds (exit 0) when the supervisor is unreachable at all', async () => {
    const seDataDir = mkSeDataDir();
    const home = mkHomeDir();
    writeToken(seDataDir, VALID_TOKEN);
    const fetchImpl = fakeUnreachableFetch();
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = await run(['--self-sprint-id', 'self-1', '--url', 'http://fake/api/sprints'], { fetchImpl, dataDir: seDataDir, home });
      expect(code).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});
