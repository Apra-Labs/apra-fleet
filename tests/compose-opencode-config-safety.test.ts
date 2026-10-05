import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pointHomeAt } from './helpers/isolated-home.mjs';
// Restores HOME after pointHomeAt (tests/helpers/isolated-home.mjs).
let restoreHome: (() => void) | undefined;

// opencode compose against a REAL temp git repo as the member work folder and a
// REAL temp HOME (no exec mocking; the real local strategy runs the commands):
//   - a git-TRACKED opencode.json is never rewritten (git status stays clean,
//     fleetMcp unavailable/opencode-config-tracked, compose still succeeds);
//   - a second compose over an already-current entry does not rewrite the file;
//   - a JSONC opencode.json is left byte-identical (fleetMcp
//     unavailable/opencode-config-unparseable, compose still succeeds).

let scratch: string;
let home: string;
let work: string;
let realHome: string | undefined;
let realUserProfile: string | undefined;
const tmpLeft = () => fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('compose-opencode-'));
let tmpBefore: string[];

const git = (...args: string[]) => execFileSync('git', args, { cwd: work, encoding: 'utf8' });

async function loadHarness() {
  const helpers = await import('./test-helpers.js');
  const registry = await import('../src/services/registry.js');
  const compose = await import('../src/tools/compose-permissions.js');
  return { ...helpers, ...registry, composePermissions: compose.composePermissions };
}

beforeAll(() => { tmpBefore = tmpLeft(); });

beforeEach(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'compose-opencode-')));
  home = path.join(scratch, 'home');
  work = path.join(scratch, 'work');
  fs.mkdirSync(home);
  fs.mkdirSync(work);
  git('init', '-q');
  git('config', 'user.email', 't@example.invalid');
  git('config', 'user.name', 'T');
  realHome = process.env.HOME;
  realUserProfile = process.env.USERPROFILE;
  restoreHome = pointHomeAt(home);
});

afterEach(() => {
  restoreHome?.();
  if (realUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realUserProfile;
  fs.rmSync(scratch, { recursive: true, force: true });
});

afterAll(() => {
  expect(tmpLeft()).toEqual(tmpBefore);
});

async function withMember<T>(fn: (h: Awaited<ReturnType<typeof loadHarness>>, id: string) => Promise<T>): Promise<T> {
  const h = await loadHarness();
  h.backupAndResetRegistry();
  try {
    const agent = h.makeTestLocalAgent({ friendlyName: 'oc-member', workFolder: work, llmProvider: 'opencode' });
    h.addAgent(agent);
    return await fn(h, agent.id);
  } finally {
    h.restoreRegistry();
  }
}

describe.skipIf(process.platform === 'win32')('opencode compose leaves tracked / JSONC opencode.json alone and skips no-op writes', () => {
  it('tracked opencode.json: bytes and git status unchanged, fleetMcp unavailable/opencode-config-tracked', async () => {
    const file = path.join(work, 'opencode.json');
    fs.writeFileSync(file, '{\n  "theme": "dark"\n}\n');
    git('add', 'opencode.json');
    git('commit', '-qm', 'track opencode.json');
    const before = fs.readFileSync(file);
    await withMember(async (h, id) => {
      const result = await h.composePermissions({ member_id: id, role: 'doer' });
      expect(result).not.toContain('[FAIL]');
      expect(result).toContain('Permissions composed');
      expect(git('status', '--porcelain').trim()).toBe('');
      expect(fs.readFileSync(file).equals(before)).toBe(true);
      expect(h.getAgent(id)?.fleetMcp).toMatchObject({ state: 'unavailable', reason: 'opencode-config-tracked' });
    });
  });

  it('untracked: the second compose does not rewrite an already-current opencode.json', async () => {
    const file = path.join(work, 'opencode.json');
    await withMember(async (h, id) => {
      await h.composePermissions({ member_id: id, role: 'doer' });
      const first = fs.readFileSync(file);
      expect(JSON.parse(first.toString()).mcp['apra-fleet']).toMatchObject({ type: 'remote', enabled: true });
      const old = new Date(Date.now() - 3_600_000);
      fs.utimesSync(file, old, old);
      const mtime = fs.statSync(file).mtimeMs;
      const result = await h.composePermissions({ member_id: id, role: 'doer' });
      expect(result).not.toContain('[FAIL]');
      expect(fs.statSync(file).mtimeMs).toBe(mtime);
      expect(fs.readFileSync(file).equals(first)).toBe(true);
    });
  });

  it('JSONC opencode.json: compose succeeds, file byte-identical, fleetMcp unavailable/opencode-config-unparseable', async () => {
    const file = path.join(work, 'opencode.json');
    fs.writeFileSync(file, '{\n  // my theme\n  "theme": "dark",\n}\n');
    const before = fs.readFileSync(file);
    await withMember(async (h, id) => {
      const result = await h.composePermissions({ member_id: id, role: 'doer' });
      expect(result).not.toContain('[FAIL]');
      expect(result).toContain('Permissions composed');
      expect(fs.readFileSync(file).equals(before)).toBe(true);
      expect(h.getAgent(id)?.fleetMcp).toMatchObject({ state: 'unavailable', reason: 'opencode-config-unparseable' });
    });
  });

  it('empty tracked opencode.json: bytes and git status unchanged, fleetMcp unavailable/opencode-config-tracked', async () => {
    const file = path.join(work, 'opencode.json');
    fs.writeFileSync(file, '');
    git('add', 'opencode.json');
    git('commit', '-qm', 'track empty opencode.json');
    const before = fs.readFileSync(file);
    await withMember(async (h, id) => {
      const result = await h.composePermissions({ member_id: id, role: 'doer' });
      expect(result).not.toContain('[FAIL]');
      expect(result).toContain('Permissions composed');
      expect(git('status', '--porcelain').trim()).toBe('');
      expect(fs.readFileSync(file).equals(before)).toBe(true);
      expect(h.getAgent(id)?.fleetMcp).toMatchObject({ state: 'unavailable', reason: 'opencode-config-tracked' });
    });
  });

  it('{}-only tracked opencode.json: bytes and git status unchanged, fleetMcp unavailable/opencode-config-tracked', async () => {
    const file = path.join(work, 'opencode.json');
    fs.writeFileSync(file, '{}');
    git('add', 'opencode.json');
    git('commit', '-qm', 'track {}-only opencode.json');
    const before = fs.readFileSync(file);
    await withMember(async (h, id) => {
      const result = await h.composePermissions({ member_id: id, role: 'doer' });
      expect(result).not.toContain('[FAIL]');
      expect(result).toContain('Permissions composed');
      expect(git('status', '--porcelain').trim()).toBe('');
      expect(fs.readFileSync(file).equals(before)).toBe(true);
      expect(h.getAgent(id)?.fleetMcp).toMatchObject({ state: 'unavailable', reason: 'opencode-config-tracked' });
    });
  });
});
