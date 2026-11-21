/**
 * The local ~/.claude.json writers (install's user-scope registration and the
 * local-scope entry refresh) are compare-and-swap: the replace only happens
 * while the file still holds the bytes that were read, so an edit another
 * process saves in between is kept together with the fleet delta. The
 * install-time prune removes exactly the project keys older test runs leaked.
 *
 * Every file lives in a fresh temp dir; HOME/USERPROFILE point there and
 * CLAUDE_CONFIG_DIR is unset. The real ~/.claude.json is never touched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerClaudeHttpMcp } from '../src/cli/install.js';
import {
  refreshClaudeLocalScopeEntries, updateClaudeConfigFile, pruneLeakedTestProjectKeys, CLAUDE_CONFIG_CAS_ATTEMPTS,
} from '../src/services/claude-local-scope-mcp.js';

const HEADER = 'X-Apra-Fleet-Member-Secret';
const URL_ = 'http://localhost:7523/mcp';

let tmpHome: string;
let file: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-local-cas-'));
  vi.stubEnv('HOME', tmpHome);
  vi.stubEnv('USERPROFILE', tmpHome);
  delete process.env.CLAUDE_CONFIG_DIR;
  file = path.join(tmpHome, '.claude.json');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

/**
 * Makes another process "save" the config right after the fleet staged its
 * temp file (i.e. between the fleet's read and its replace), `times` times.
 */
function concurrentSaveAfterStaging(times: number, edit: (json: any, n: number) => void): { saves: () => number } {
  const real = fs.writeFileSync;
  let n = 0;
  vi.spyOn(fs, 'writeFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, data: any, opts?: any) => {
    real(p, data, opts);
    if (typeof p === 'string' && path.basename(p).includes('.claude.json.') && p.endsWith('.tmp') && n < times) {
      n++;
      const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
      edit(cur, n);
      real(file, JSON.stringify(cur, null, 2));
    }
  }) as typeof fs.writeFileSync);
  return { saves: () => n };
}

describe('local claude.json writers keep a concurrent edit made between read and replace', () => {
  it('registerClaudeHttpMcp', () => {
    fs.writeFileSync(file, JSON.stringify({ numStartups: 1, projects: {} }, null, 2));
    const c = concurrentSaveAfterStaging(1, (j) => { j.numStartups = 2; j.projects['/w/other'] = { allowedTools: ['Bash'] }; });
    registerClaudeHttpMcp(URL_, { [HEADER]: 's1' });
    vi.restoreAllMocks();
    expect(c.saves()).toBe(1);
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(j.numStartups).toBe(2);
    expect(j.projects['/w/other']).toEqual({ allowedTools: ['Bash'] });
    expect(j.mcpServers['apra-fleet']).toEqual({ type: 'http', url: URL_, headers: { [HEADER]: 's1' } });
    expect(fs.readdirSync(tmpHome)).toEqual(['.claude.json']);
  });

  it('refreshClaudeLocalScopeEntries', () => {
    fs.writeFileSync(file, JSON.stringify({ projects: { '/w/p': { mcpServers: { 'apra-fleet': { type: 'http', url: URL_ } } } } }, null, 2));
    const c = concurrentSaveAfterStaging(1, (j) => { j.tipsHistory = { shown: 1 }; });
    expect(refreshClaudeLocalScopeEntries(file, URL_, { [HEADER]: 's1' })).toEqual(['/w/p']);
    vi.restoreAllMocks();
    expect(c.saves()).toBe(1);
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(j.tipsHistory).toEqual({ shown: 1 });
    expect(j.projects['/w/p'].mcpServers['apra-fleet'].headers).toEqual({ [HEADER]: 's1' });
  });

  it('a file that keeps changing fails loudly after the bounded retries, naming the file; the other writer\'s content stays', () => {
    fs.writeFileSync(file, JSON.stringify({ projects: {} }, null, 2));
    const c = concurrentSaveAfterStaging(99, (j, n) => { j.counter = n; });
    expect(() => registerClaudeHttpMcp(URL_, { [HEADER]: 's1' })).toThrow(/\.claude\.json was changed by another writer .* on 5 attempts in a row/);
    vi.restoreAllMocks();
    expect(c.saves()).toBe(CLAUDE_CONFIG_CAS_ATTEMPTS);
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(j.counter).toBe(CLAUDE_CONFIG_CAS_ATTEMPTS);
    expect(j.mcpServers).toBeUndefined();
    expect(fs.readdirSync(tmpHome)).toEqual(['.claude.json']);
  });

  it('a file created by someone else after a read that found none is not overwritten', () => {
    const c = { n: 0 };
    const real = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, data: any, opts?: any) => {
      real(p, data, opts);
      if (typeof p === 'string' && p.endsWith('.tmp') && c.n++ === 0) real(file, JSON.stringify({ createdBy: 'claude-code' }));
    }) as typeof fs.writeFileSync);
    expect(updateClaudeConfigFile(file, (raw) => JSON.stringify({ ...(raw ? JSON.parse(raw) : {}), fleet: true }))).toBe(true);
    vi.restoreAllMocks();
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ createdBy: 'claude-code', fleet: true });
  });
});

describe('pruneLeakedTestProjectKeys', () => {
  const tmp = os.tmpdir();
  const fixture = () => {
    const leaked = [
      path.join(tmp, 'apra-fleet-regmember-compose-a1B2c3'),
      path.join(tmp, 'apra-fleet-bootstrap-gate-Zz9yX8'),
      // Claude Code keys use forward slashes on Windows too.
      path.join(tmp, 'apra-fleet-regmember-compose-q7W8e9').replace(/\\/g, '/'),
    ];
    const kept: Record<string, unknown> = {
      [path.join(tmp, 'my-project')]: { hasTrustDialogAccepted: true },
      [path.join(tmp, 'xapra-fleet-bootstrap-gate-abc123')]: {},
      [path.join(tmpHome, 'not-temp-root-check')]: {},
      '/home/someone/apra-fleet-regmember-compose-realwork': { history: [1] },
      'C:/work/apra-fleet-bootstrap-gate-repo': {},
    };
    const projects: Record<string, unknown> = { ...kept };
    for (const k of leaked) projects[k] = { hasTrustDialogAccepted: true, mcpServers: {} };
    fs.writeFileSync(file, JSON.stringify({ numStartups: 9, projects, mcpServers: { x: { type: 'http', url: 'u' } } }, null, 2));
    return { leaked, kept };
  };

  it('removes exactly the leaked keys, reports the count, and is idempotent', () => {
    const { leaked, kept } = fixture();
    // tmpHome is itself under the OS temp dir; a key there whose basename does
    // not carry a leaked prefix must stay.
    expect(pruneLeakedTestProjectKeys(file)).toBe(leaked.length);
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(j.projects).toEqual(kept);
    expect(j.numStartups).toBe(9);
    expect(j.mcpServers).toEqual({ x: { type: 'http', url: 'u' } });
    const after = fs.readFileSync(file);
    expect(pruneLeakedTestProjectKeys(file)).toBe(0);
    expect(fs.readFileSync(file).equals(after)).toBe(true);
  });

  it('leaves a missing, empty or unparseable file alone', () => {
    expect(pruneLeakedTestProjectKeys(file)).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
    for (const content of ['', '{ not json']) {
      fs.writeFileSync(file, content);
      expect(pruneLeakedTestProjectKeys(file)).toBe(0);
      expect(fs.readFileSync(file, 'utf8')).toBe(content);
    }
  });
});
