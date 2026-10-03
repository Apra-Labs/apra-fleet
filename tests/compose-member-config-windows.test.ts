import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Windows equivalents of two POSIX-only end-to-end cases:
//   - tests/compose-opencode-config-safety.test.ts "tracked opencode.json"
//   - tests/compose-unreadable-claude-config.test.ts (chmod 000 ~/.claude.json)
// Same shape: a REAL temp git repo as the local member's work folder, a REAL
// temp home (HOME and USERPROFILE -- os.homedir() reads USERPROFILE on
// Windows), no exec mocking -- the real local strategy runs the real
// PowerShell read/write commands. Gated on process.platform ONLY: on a win32
// host these always run.
//
// The temp home is set ONCE for the whole suite, before any compose runs,
// mirroring production (the hub's home is fixed for the life of the process).
// The local strategy snapshots the Windows env on its first exec, and the
// registry's REG_EXPAND_SZ values (TEMP = %USERPROFILE%\AppData\Local\Temp)
// expand against the USERPROFILE of that moment -- a per-test home would make
// later spawned shells create files under an earlier test's deleted home.
//
// "Unreadable" on Windows is a deny-Read ACE for the current user (icacls
// /deny), which -- unlike chmod 000 for root on POSIX -- is enforced for the
// file's owner and for administrators alike, so no extra skip is needed.

const isWin = process.platform === 'win32';
const tmpPrefix = 'compose-win-';
const tmpLeft = () => fs.readdirSync(os.tmpdir()).filter(n => n.startsWith(tmpPrefix));

let suiteScratch: string;
let home: string;
let work: string;
let realHome: string | undefined;
let realUserProfile: string | undefined;
let realClaudeConfigDir: string | undefined;
let tmpBefore: string[];

const git = (...args: string[]) => execFileSync('git', args, { cwd: work, encoding: 'utf8' });
const me = () => os.userInfo().username;
const denyRead = (file: string) => execFileSync('icacls', [file, '/deny', `${me()}:(R)`], { stdio: 'ignore' });
const undenyRead = (file: string) => execFileSync('icacls', [file, '/remove:d', me()], { stdio: 'ignore' });
const trustKey = (folder: string) => folder.replace(/\\/g, '/').replace(/\/+$/, '');

async function withMember<T>(
  llmProvider: 'opencode' | 'claude',
  fn: (h: Awaited<ReturnType<typeof loadHarness>>, id: string) => Promise<T>,
): Promise<T> {
  const h = await loadHarness();
  h.backupAndResetRegistry();
  try {
    const agent = h.makeTestLocalAgent({ friendlyName: `win-${llmProvider}`, workFolder: work, llmProvider });
    h.addAgent(agent);
    return await fn(h, agent.id);
  } finally {
    h.restoreRegistry();
  }
}

async function loadHarness() {
  const helpers = await import('./test-helpers.js');
  const registry = await import('../src/services/registry.js');
  const compose = await import('../src/tools/compose-permissions.js');
  return { ...helpers, ...registry, composePermissions: compose.composePermissions };
}

describe.runIf(isWin)('compose on a Windows local member: tracked opencode.json, ~/.claude.json targeting', () => {
  beforeAll(() => {
    tmpBefore = tmpLeft();
    suiteScratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), tmpPrefix)));
    home = path.join(suiteScratch, 'home');
    fs.mkdirSync(home);
    realHome = process.env.HOME;
    realUserProfile = process.env.USERPROFILE;
    realClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  beforeEach(() => {
    work = fs.mkdtempSync(path.join(suiteScratch, 'work-'));
    git('init', '-q');
    git('config', 'user.email', 't@example.invalid');
    git('config', 'user.name', 'T');
  });

  afterEach(() => {
    const claudeJson = path.join(home, '.claude.json');
    if (fs.existsSync(claudeJson)) {
      try { undenyRead(claudeJson); } catch { /* no deny ACE */ }
      fs.rmSync(claudeJson, { force: true });
    }
    fs.rmSync(work, { recursive: true, force: true });
  });

  afterAll(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    if (realUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realUserProfile;
    if (realClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = realClaudeConfigDir;
    fs.rmSync(suiteScratch, { recursive: true, force: true });
    expect(tmpLeft()).toEqual(tmpBefore);
  });

  it('tracked opencode.json: bytes and git status unchanged, fleetMcp unavailable/opencode-config-tracked', async () => {
    const file = path.join(work, 'opencode.json');
    fs.writeFileSync(file, '{\r\n  "theme": "dark"\r\n}\r\n');
    git('add', 'opencode.json');
    git('commit', '-qm', 'track opencode.json');
    const before = fs.readFileSync(file);
    await withMember('opencode', async (h, id) => {
      const result = await h.composePermissions({ member_id: id, role: 'doer' });
      expect(result).not.toContain('[FAIL]');
      expect(result).toContain('Permissions composed');
      expect(git('status', '--porcelain').trim()).toBe('');
      expect(fs.readFileSync(file).equals(before)).toBe(true);
      expect(h.getAgent(id)?.fleetMcp).toMatchObject({ state: 'unavailable', reason: 'opencode-config-tracked' });
    });
    expect(tmpLeft().sort()).toEqual([...tmpBefore, path.basename(suiteScratch)].sort());
  }, 180_000);

  it('readable ~/.claude.json: the workspace-trust seed lands in THIS member home, merged with the existing content', async () => {
    const file = path.join(home, '.claude.json');
    fs.writeFileSync(file, JSON.stringify({ numStartups: 7, projects: { 'C:/somewhere/else': { hasTrustDialogAccepted: true } } }, null, 2));
    await withMember('claude', async (h, id) => {
      const result = await h.composePermissions({ member_id: id, role: 'doer' });
      expect(result).not.toContain('[FAIL]');
      expect(result).toContain('Permissions composed');
    });
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(written.numStartups).toBe(7);
    expect(written.projects['C:/somewhere/else']).toEqual({ hasTrustDialogAccepted: true });
    expect(written.projects[trustKey(work)]).toMatchObject({ hasTrustDialogAccepted: true });
    // The member entry loads at session start, so a dispatched claude -p sees its tools.
    expect(written.projects[trustKey(work)].mcpServers['apra-fleet']).toEqual({
      type: 'http', url: expect.stringMatching(/\/mcp\?member=\S+$/), alwaysLoad: true,
    });
    // No staging leftovers in the home, and nothing outside this suite's scratch.
    expect(fs.readdirSync(home).filter(n => n.includes('fleet-trust'))).toEqual([]);
    expect(tmpLeft().sort()).toEqual([...tmpBefore, path.basename(suiteScratch)].sort());
  }, 180_000);

  it('unreadable ~/.claude.json: compose leaves it byte-identical, succeeds, fleetMcp unavailable/member-config-unreadable', async () => {
    const file = path.join(home, '.claude.json');
    fs.writeFileSync(file, JSON.stringify({
      numStartups: 42,
      hasCompletedOnboarding: true,
      mcpServers: { 'user-server': { type: 'http', url: 'https://example.invalid/mcp' } },
      projects: { 'C:\\somewhere\\else': { hasTrustDialogAccepted: true } },
    }, null, 2));
    const before = fs.readFileSync(file);
    denyRead(file);
    // The deny ACE really bites for this user (otherwise the case is vacuous).
    expect(() => fs.readFileSync(file)).toThrow();

    const errSpy = vi.spyOn(console, 'error');
    let logged: string[] = [];
    try {
      await withMember('claude', async (h, id) => {
        let result: string;
        try {
          result = await h.composePermissions({ member_id: id, role: 'doer' });
        } finally {
          undenyRead(file);
        }
        expect(result).not.toContain('[FAIL]');
        expect(result).toContain('Permissions composed');
        expect(fs.readFileSync(file).equals(before)).toBe(true);
        expect(h.getAgent(id)?.fleetMcp).toMatchObject({ state: 'unavailable', reason: 'member-config-unreadable' });
      });
      logged = errSpy.mock.calls.map(c => c.map(String).join(' '));
    } finally {
      errSpy.mockRestore();
    }
    // Non-vacuous: the workspace-trust step must have tried THIS file (its
    // path is resolved in JS, so it appears literally in the detail) and
    // refused -- not read some other home as missing and seeded that.
    const refusal = logged.find(l => l.includes('workspace trust: E-MEMBER-CONFIG-UNREADABLE'));
    expect(refusal).toBeDefined();
    expect(refusal!.toLowerCase()).toContain(file.toLowerCase());
    expect(logged.some(l => l.includes('workspace trust: seeded trust'))).toBe(false);
    expect(tmpLeft().sort()).toEqual([...tmpBefore, path.basename(suiteScratch)].sort());
  }, 180_000);
});
