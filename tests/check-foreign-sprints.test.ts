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
// run() takes an injected fetchImpl/dataDir instead of the real network/
// process.argv/process.exit that main() uses, so these tests drive the exact
// same logic main() calls without a subprocess or a real socket.

const VALID_TOKEN = 'a'.repeat(64);

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

function mkSeDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-foreign-sprints-test-'));
  homes.push(dir);
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

describe('readServiceToken', () => {
  it('returns null when the token file does not exist', () => {
    const dir = mkSeDataDir();
    expect(readServiceToken(dir)).toBeNull();
  });

  it('returns the trimmed token when the file exists', () => {
    const dir = mkSeDataDir();
    writeToken(dir, `${VALID_TOKEN}\n`);
    expect(readServiceToken(dir)).toBe(VALID_TOKEN);
  });

  it('throws when the token file exists but is blank', () => {
    const dir = mkSeDataDir();
    writeToken(dir, '   \n');
    expect(() => readServiceToken(dir)).toThrow(/empty/i);
  });
});

describe('parseArgs (unaffected by the auth change)', () => {
  it('still parses --url/--self-sprint-id/--self-child-pid', () => {
    const opts = parseArgs(['--url', 'http://x', '--self-sprint-id', 's1', '--self-child-pid', '42']);
    expect(opts).toEqual({ url: 'http://x', sprintId: 's1', childPid: 42 });
  });
});

describe('run(): 401 is never silently interpreted as an empty sprint list', () => {
  it('returns nonzero and reports the auth failure when the token file is missing', async () => {
    const seDataDir = mkSeDataDir(); // no token file written
    const fetchImpl = fakeAuthedFetch(VALID_TOKEN);
    const errLines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((msg: string) => { errLines.push(msg); });
    try {
      const code = await run(['--self-sprint-id', 'self-1', '--url', 'http://fake/api/sprints'], { fetchImpl, dataDir: seDataDir });

      expect(code).not.toBe(0);
      expect(code).not.toBe(3); // not the "foreign sprint" STOP code either -- this is an auth failure
      const combined = errLines.join('\n');
      expect(combined).toMatch(/401/);
      // The old !res.ok branch's "proceed" wording is what would have leaked
      // through if a 401 were misread as an empty/clean sprint list -- assert
      // that phrasing never appears on this path.
      expect(combined.toLowerCase()).not.toMatch(/proceed/);
    } finally {
      spy.mockRestore();
    }
  });

  it('returns nonzero and reports the auth failure when the on-disk token is stale', async () => {
    const seDataDir = mkSeDataDir();
    writeToken(seDataDir, 'b'.repeat(64)); // wrong token
    const fetchImpl = fakeAuthedFetch(VALID_TOKEN);
    const errLines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((msg: string) => { errLines.push(msg); });
    try {
      const code = await run(['--self-sprint-id', 'self-1', '--url', 'http://fake/api/sprints'], { fetchImpl, dataDir: seDataDir });

      expect(code).not.toBe(0);
      expect(code).not.toBe(3);
      const combined = errLines.join('\n');
      expect(combined).toMatch(/401/);
      expect(combined.toLowerCase()).not.toMatch(/proceed/);
    } finally {
      spy.mockRestore();
    }
  });

  it('sends the on-disk token and proceeds normally once authorized', async () => {
    const seDataDir = mkSeDataDir();
    writeToken(seDataDir, VALID_TOKEN);
    const fetchImpl = fakeAuthedFetch(VALID_TOKEN, [{ sprintId: 'self-1', childPid: 123 }]);
    const outLines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((msg: string) => { outLines.push(msg); });
    try {
      const code = await run(['--self-sprint-id', 'self-1', '--url', 'http://fake/api/sprints'], { fetchImpl, dataDir: seDataDir });

      expect(code).toBe(0);
      expect(outLines.join('\n')).toMatch(/own reservation \(not foreign\): self-1/);
      expect(fetchImpl).toHaveBeenCalledWith('http://fake/api/sprints', { headers: { Authorization: `Bearer ${VALID_TOKEN}` } });
    } finally {
      spy.mockRestore();
    }
  });

  it('still proceeds (exit 0) when the supervisor is unreachable at all', async () => {
    const seDataDir = mkSeDataDir();
    writeToken(seDataDir, VALID_TOKEN);
    const fetchImpl = fakeUnreachableFetch();
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = await run(['--self-sprint-id', 'self-1', '--url', 'http://fake/api/sprints'], { fetchImpl, dataDir: seDataDir });
      expect(code).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});
