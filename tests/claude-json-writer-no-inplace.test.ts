/**
 * Local writers of ~/.claude.json and registry.json never write the live file
 * in place: a rename that keeps failing (another process holding the file,
 * e.g. Claude Code or an antivirus scan on Windows) is retried with backoff
 * for a bounded few seconds, then the write fails naming the file, which is
 * left byte-identical. A lock held for about a second no longer fails a save.
 *
 * HOME/USERPROFILE point at a fresh temp dir and CLAUDE_CONFIG_DIR is unset;
 * registry.json lives in the per-run sandbox data dir (scripts/test-sandbox.mjs).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerClaudeHttpMcp } from '../src/cli/install.js';
import { refreshClaudeLocalScopeEntries } from '../src/services/claude-local-scope-mcp.js';
import { RENAME_RETRY_BUDGET_MS } from '../src/cli/config.js';
import { sameWin32Path } from '../src/cli/uninstall.js';
import { addAgent, getAllAgents, updateAgent } from '../src/services/registry.js';
import { makeTestAgent, REGISTRY_PATH, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';

const HEADER = 'X-Apra-Fleet-Member-Secret';
const URL_ = 'http://localhost:7523/mcp';

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-no-inplace-'));
  vi.stubEnv('HOME', tmpHome);
  vi.stubEnv('USERPROFILE', tmpHome);
  vi.stubEnv('CLAUDE_CONFIG_DIR', '');
  delete process.env.CLAUDE_CONFIG_DIR;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const busy = () => Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' });
const perm = () => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });

describe('~/.claude.json writers never fall back to an in-place write', () => {
  it('registerClaudeHttpMcp: a rename failing on every attempt throws naming the file, which stays byte-identical', () => {
    const f = path.join(tmpHome, '.claude.json');
    const seed = JSON.stringify({ numStartups: 3, projects: { a: {} } }, null, 2);
    fs.writeFileSync(f, seed);
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw busy(); });
    const write = vi.spyOn(fs, 'writeFileSync');
    const t0 = Date.now();
    expect(() => registerClaudeHttpMcp(URL_, { [HEADER]: 's' })).toThrow(/could not replace .*\.claude\.json after \d+ attempts over \d+ ms/);
    expect(Date.now() - t0).toBeLessThan(RENAME_RETRY_BUDGET_MS + 2000);
    expect(rename.mock.calls.length).toBeGreaterThan(5);
    // No write ever opened the live file.
    expect(write.mock.calls.some(c => path.resolve(String(c[0])) === path.resolve(fs.realpathSync(f)))).toBe(false);
    vi.restoreAllMocks();
    expect(fs.readFileSync(f, 'utf8')).toBe(seed);
    expect(fs.readdirSync(tmpHome)).toEqual(['.claude.json']);
  });

  it('refreshClaudeLocalScopeEntries: same, with EPERM', () => {
    const f = path.join(tmpHome, '.claude.json');
    const seed = JSON.stringify({ projects: { '/w': { mcpServers: { 'apra-fleet': { type: 'http', url: URL_ } } } } }, null, 2);
    fs.writeFileSync(f, seed);
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw perm(); });
    expect(() => refreshClaudeLocalScopeEntries(f, URL_, { [HEADER]: 's' })).toThrow(/could not replace .*\.claude\.json/);
    vi.restoreAllMocks();
    expect(fs.readFileSync(f, 'utf8')).toBe(seed);
    expect(fs.readdirSync(tmpHome)).toEqual(['.claude.json']);
  });
});

describe('registry.json strict writer: a few seconds of bounded backoff', () => {
  let a: ReturnType<typeof makeTestAgent>;
  beforeEach(() => {
    backupAndResetRegistry();
    a = makeTestAgent({ friendlyName: 'one' });
    addAgent(a);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    restoreRegistry();
  });

  it('a lock released after about 1 s does not fail the save', () => {
    const real = fs.renameSync;
    let firstFailure = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to).endsWith('registry.json')) {
        if (!firstFailure) firstFailure = Date.now();
        if (Date.now() - firstFailure < 1000) throw busy();
      }
      return real(from, to);
    }) as typeof fs.renameSync);
    updateAgent(a.id, { friendlyName: 'renamed' });
    expect(Date.now() - firstFailure).toBeGreaterThanOrEqual(1000);
    vi.restoreAllMocks();
    expect(getAllAgents().map(x => x.friendlyName)).toEqual(['renamed']);
    expect(fs.readdirSync(path.dirname(REGISTRY_PATH)).filter(n => n.endsWith('.tmp'))).toEqual([]);
  });

  it('a lock that is never released fails within the bounded budget, naming attempts and elapsed time', () => {
    const seed = fs.readFileSync(REGISTRY_PATH);
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw busy(); });
    const t0 = Date.now();
    expect(() => updateAgent(a.id, { friendlyName: 'renamed' })).toThrow(/could not replace .*registry\.json after \d+ attempts over \d+ ms/);
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(1500);
    expect(took).toBeLessThan(RENAME_RETRY_BUDGET_MS + 2000);
    vi.restoreAllMocks();
    expect(fs.readFileSync(REGISTRY_PATH).equals(seed)).toBe(true);
  });
});

describe('sameWin32Path', () => {
  it('compares case-insensitively with separators normalised', () => {
    expect(sameWin32Path('C:\\Program Files\\x\\a.exe', 'c:/program files/X/A.EXE')).toBe(true);
    expect(sameWin32Path('C:\\a\\b.exe', 'C:\\a\\c.exe')).toBe(false);
  });

  it.runIf(process.platform === 'win32')('treats an 8.3 short name and its long name as the same file', () => {
    const dir = fs.mkdtempSync(path.join(tmpHome, 'long directory name '));
    const long = path.join(dir, 'a long file name.exe');
    fs.writeFileSync(long, '');
    // The path travels in an env var, so no command-line quoting is involved.
    const short = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(New-Object -ComObject Scripting.FileSystemObject).GetFile($env:FLEET_LONG_PATH).ShortPath'],
      { encoding: 'utf8', env: { ...process.env, FLEET_LONG_PATH: long } }).trim();
    if (short.toLowerCase() === long.toLowerCase()) return; // 8.3 name generation is off on this volume
    expect(sameWin32Path(short, long)).toBe(true);
    expect(sameWin32Path(long, short)).toBe(true);
  });
});
