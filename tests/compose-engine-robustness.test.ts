import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mergeDenyRules } from '../src/tools/compose-permissions.js';
import { claudeMemberDenyRules } from '../src/services/member-config-io.js';

// compose_permissions engine robustness, against a REAL temp git work folder and
// a REAL temp HOME (no exec mocking; the real local strategy runs the commands):
//   - deny rules merge by union: a user-authored deny rule always survives;
//   - the ledger records exactly what was written: a member MCP sync failure
//     neither drops a grant already on disk nor claims anything unwritten;
//   - the output says, per member, why a member config was not edited;
//   - a successful compose clears a stale compose-owned fleetMcp unavailable.

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const skipLive = process.platform === 'win32';

let scratch: string;
let home: string;
let work: string;
let ledgerDir: string;
let realHome: string | undefined;
let realUserProfile: string | undefined;
let realClaudeDir: string | undefined;
const tmpLeft = () => fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('compose-engine-'));
let tmpBefore: string[];

const git = (...args: string[]) => execFileSync('git', args, { cwd: work, encoding: 'utf8' });
const readJson = (p: string): any => JSON.parse(fs.readFileSync(p, 'utf8'));
const settingsPath = () => path.join(work, '.claude', 'settings.local.json');
const ledgerPath = () => path.join(ledgerDir, 'permissions.json');

async function loadHarness() {
  const helpers = await import('./test-helpers.js');
  const registry = await import('../src/services/registry.js');
  const compose = await import('../src/tools/compose-permissions.js');
  return { ...helpers, ...registry, composePermissions: compose.composePermissions };
}

async function withMember<T>(provider: 'claude' | 'opencode', fn: (h: Awaited<ReturnType<typeof loadHarness>>, id: string) => Promise<T>): Promise<T> {
  const h = await loadHarness();
  h.backupAndResetRegistry();
  try {
    const agent = h.makeTestLocalAgent({ friendlyName: `engine-${provider}`, workFolder: work, llmProvider: provider });
    h.addAgent(agent);
    return await fn(h, agent.id);
  } finally {
    h.restoreRegistry();
  }
}

beforeAll(() => { tmpBefore = tmpLeft(); });

beforeEach(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'compose-engine-')));
  home = path.join(scratch, 'home');
  work = path.join(scratch, 'work');
  ledgerDir = path.join(scratch, 'project');
  fs.mkdirSync(home);
  fs.mkdirSync(work);
  fs.mkdirSync(ledgerDir);
  git('init', '-q');
  git('config', 'user.email', 't@example.invalid');
  git('config', 'user.name', 'T');
  realHome = process.env.HOME;
  realUserProfile = process.env.USERPROFILE;
  realClaudeDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  if (realUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realUserProfile;
  if (realClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = realClaudeDir;
  try { fs.chmodSync(home, 0o755); } catch { /* ignore */ }
  try { fs.chmodSync(path.join(home, '.claude.json'), 0o600); } catch { /* ignore */ }
  fs.rmSync(scratch, { recursive: true, force: true });
});

afterAll(() => {
  expect(tmpLeft()).toEqual(tmpBefore);
});

describe('mergeDenyRules', () => {
  it('keeps every existing rule, appends new ones, and only retires fleet-derived rules compose no longer derives', () => {
    const existing = ['Bash(rm -rf *)', 'mcp__apra-fleet__retired_tool', 'mcp__apra-fleet__kept', 'mcp(apra-fleet/old)', 'mcp__other__x'];
    const composed = ['mcp__apra-fleet__kept', 'mcp__apra-fleet__new'];
    expect(mergeDenyRules(existing, composed)).toEqual(['Bash(rm -rf *)', 'mcp__apra-fleet__kept', 'mcp__other__x', 'mcp__apra-fleet__new']);
  });
});

describe.skipIf(skipLive)('compose engine (live local member)', () => {
  it('deny rules merge by union: a pre-existing user deny rule survives proactive compose and a grant', async () => {
    fs.mkdirSync(path.join(work, '.claude'), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify({
      permissions: { allow: ['Read'], deny: ['Bash(rm -rf *)', 'mcp__apra-fleet__retired_tool'] },
    }, null, 2));
    await withMember('claude', async (h, id) => {
      expect(await h.composePermissions({ member_id: id, role: 'doer' })).toContain('Permissions composed');
      let deny: string[] = readJson(settingsPath()).permissions.deny;
      expect(deny[0]).toBe('Bash(rm -rf *)');
      for (const rule of claudeMemberDenyRules()) expect(deny).toContain(rule);
      expect(deny).not.toContain('mcp__apra-fleet__retired_tool');

      // second proactive compose and a reactive grant keep it too
      expect(await h.composePermissions({ member_id: id, role: 'doer' })).toContain('Permissions composed');
      expect(await h.composePermissions({ member_id: id, role: 'doer', grant: ['Bash(custom-tool:*)'] })).toContain('Granted');
      deny = readJson(settingsPath()).permissions.deny;
      expect(deny).toContain('Bash(rm -rf *)');
      expect(deny.filter(r => r === 'Bash(rm -rf *)')).toHaveLength(1);
    });
  }, 60000);

  it.skipIf(isRoot)('ledger records exactly what was written when the member MCP sync fails', async () => {
    await withMember('claude', async (h, id) => {
      // HOME read-only: ~/.claude.json (the member MCP entry) cannot be written,
      // while the work-folder permission file still can.
      fs.chmodSync(home, 0o555);
      const result = await h.composePermissions({ member_id: id, role: 'doer', grant: ['Bash(custom-tool:*)'], project_folder: ledgerDir });
      fs.chmodSync(home, 0o755);
      expect(result).toContain('[FAIL]');

      const onDisk: string[] = readJson(settingsPath()).permissions.allow;
      expect(onDisk).toContain('Bash(custom-tool:*)');
      const ledger = readJson(ledgerPath());
      const granted = ledger.granted.map((e: { permission: string }) => e.permission);
      expect(granted).toEqual(['Bash(custom-tool:*)']);
      // the ledger claims only permission grants that are on disk -- nothing about the MCP entry
      for (const p of granted) expect(onDisk).toContain(p);
      expect(Object.keys(ledger).sort()).toEqual(['granted', 'stacks']);
      expect(fs.existsSync(path.join(home, '.claude.json'))).toBe(false);
      expect(result).toContain('the apra-fleet member MCP entry was NOT written');
    });
  }, 60000);

  it.skipIf(isRoot)('ledger is untouched when the permission file itself could not be written', async () => {
    fs.mkdirSync(path.join(work, '.claude'), { recursive: true });
    fs.writeFileSync(settingsPath(), '{}');
    fs.chmodSync(settingsPath(), 0o444);
    try {
      await withMember('claude', async (h, id) => {
        const result = await h.composePermissions({ member_id: id, role: 'doer', grant: ['Bash(custom-tool:*)'], project_folder: ledgerDir });
        expect(result).toContain('Failed to persist permissions');
        expect(fs.existsSync(ledgerPath())).toBe(false);
      });
    } finally {
      fs.chmodSync(settingsPath(), 0o644);
    }
  }, 60000);

  it('output states why a member config was not edited: tracked by git', async () => {
    fs.writeFileSync(path.join(work, 'opencode.json'), '{\n  "theme": "dark"\n}\n');
    git('add', 'opencode.json');
    git('commit', '-qm', 'track');
    await withMember('opencode', async (h, id) => {
      const result = await h.composePermissions({ member_id: id, role: 'doer' });
      expect(result).toContain('Permissions composed');
      expect(result).toMatch(/Member MCP config NOT edited: \S*opencode\.json is tracked by git \(fleetMcp unavailable: opencode-config-tracked\)/);
    });
  }, 60000);

  it('output states why a member config was not edited: not strict JSON', async () => {
    fs.writeFileSync(path.join(work, 'opencode.json'), '{\n  // mine\n  "theme": "dark",\n}\n');
    await withMember('opencode', async (h, id) => {
      const result = await h.composePermissions({ member_id: id, role: 'doer' });
      expect(result).toContain('Permissions composed');
      expect(result).toMatch(/Member MCP config NOT edited: \S*opencode\.json is not strict JSON \(fleetMcp unavailable: opencode-config-unparseable\)/);
    });
  }, 60000);

  it.skipIf(isRoot)('output states why a member config was not edited: unreadable', async () => {
    const file = path.join(home, '.claude.json');
    fs.writeFileSync(file, '{}');
    fs.chmodSync(file, 0o000);
    await withMember('claude', async (h, id) => {
      const result = await h.composePermissions({ member_id: id, role: 'doer' });
      expect(result).toContain('Permissions composed');
      expect(result).toMatch(/Member MCP config NOT edited: \S*\.claude\.json is unreadable \(fleetMcp unavailable: member-config-unreadable\)/);
    });
  }, 60000);

  it('a successful compose clears a previously recorded compose-owned fleetMcp unavailable status', async () => {
    await withMember('opencode', async (h, id) => {
      h.recordFleetMcpStatus(id, { state: 'unavailable', reason: 'opencode-config-tracked', checkedAt: new Date().toISOString(), detail: 'was tracked' });
      const result = await h.composePermissions({ member_id: id, role: 'doer' });
      expect(result).toContain('Permissions composed');
      expect(result).toContain('cleared the stale unavailable status (opencode-config-tracked)');
      expect(h.getAgent(id)?.fleetMcp).toBeUndefined();
      expect(readJson(path.join(work, 'opencode.json')).mcp['apra-fleet'].url).toContain(`?member=${id}`);
    });
  }, 60000);

  it('a member-config error records unavailable but keeps the previous fleetInstalledAt', async () => {
    fs.writeFileSync(path.join(work, 'opencode.json'), '{\n  "theme": "dark"\n}\n');
    git('add', 'opencode.json');
    git('commit', '-qm', 'track');
    await withMember('opencode', async (h, id) => {
      const T = '2026-01-02T03:04:05.000Z';
      h.recordFleetMcpStatus(id, { state: 'available', checkedAt: T, fleetInstalledAt: T });
      const result = await h.composePermissions({ member_id: id, role: 'doer' });
      expect(result).toContain('fleetMcp unavailable: opencode-config-tracked');
      expect(h.getAgent(id)?.fleetMcp).toMatchObject({ state: 'unavailable', reason: 'opencode-config-tracked', fleetInstalledAt: T });
    });
  }, 60000);

  it('a member-config error never adds fleetInstalledAt to a member without one', async () => {
    fs.writeFileSync(path.join(work, 'opencode.json'), '{\n  "theme": "dark"\n}\n');
    git('add', 'opencode.json');
    git('commit', '-qm', 'track');
    await withMember('opencode', async (h, id) => {
      await h.composePermissions({ member_id: id, role: 'doer' });
      const st = h.getAgent(id)?.fleetMcp;
      expect(st?.state).toBe('unavailable');
      expect(st?.fleetInstalledAt).toBeUndefined();
    });
  }, 60000);

  it('clearing a stale compose-owned status keeps fleetInstalledAt and no longer reads unavailable', async () => {
    await withMember('opencode', async (h, id) => {
      const T = '2026-01-02T03:04:05.000Z';
      h.recordFleetMcpStatus(id, { state: 'unavailable', reason: 'opencode-config-tracked', checkedAt: T, fleetInstalledAt: T });
      const result = await h.composePermissions({ member_id: id, role: 'doer' });
      expect(result).toContain('cleared the stale unavailable status (opencode-config-tracked)');
      const st = h.getAgent(id)?.fleetMcp;
      expect(st?.fleetInstalledAt).toBe(T);
      expect(st?.state).not.toBe('unavailable');
    });
  }, 60000);

  it('registry.recordFleetMcpStatus carries the stamp forward unless the new status sets its own', async () => {
    await withMember('opencode', async (h, id) => {
      h.recordFleetMcpStatus(id, { state: 'available', checkedAt: 'a', fleetInstalledAt: 'T1' });
      h.recordFleetMcpStatus(id, { state: 'unavailable', reason: 'x', checkedAt: 'b' });
      expect(h.getAgent(id)?.fleetMcp?.fleetInstalledAt).toBe('T1');
      h.recordFleetMcpStatus(id, { state: 'available', checkedAt: 'c', fleetInstalledAt: 'T2' });
      expect(h.getAgent(id)?.fleetMcp?.fleetInstalledAt).toBe('T2');
    });
  }, 60000);

  it('a successful compose leaves a non-compose fleetMcp status (install-failed) for a real re-probe', async () => {
    await withMember('opencode', async (h, id) => {
      const status = { state: 'unavailable' as const, reason: 'install-failed', checkedAt: new Date().toISOString() };
      h.recordFleetMcpStatus(id, status);
      const result = await h.composePermissions({ member_id: id, role: 'doer' });
      expect(result).not.toContain('cleared');
      expect(h.getAgent(id)?.fleetMcp).toEqual(status);
    });
  }, 60000);
});
