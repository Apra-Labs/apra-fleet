import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// LIVE POSIX case: a real temp HOME whose ~/.claude.json holds a user MCP
// server + onboarding state is chmod 000 (unreadable), then compose_permissions
// runs for a local member against that HOME. The file must stay byte-identical
// (it was previously read as {} and rewritten with only projects[<workFolder>]),
// compose must not fail, and the member's fleetMcp must be recorded
// unavailable/member-config-unreadable. No exec mocking: the real local
// strategy runs the real read/write commands.

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const skip = process.platform === 'win32' || isRoot;

const ORIGINAL = JSON.stringify({
  numStartups: 42,
  hasCompletedOnboarding: true,
  mcpServers: { 'user-server': { type: 'http', url: 'https://example.invalid/mcp' } },
  projects: { '/somewhere/else': { hasTrustDialogAccepted: true } },
}, null, 2);

let scratch: string;
let home: string;
let work: string;
let realHome: string | undefined;
let realUserProfile: string | undefined;
let tmpBefore: string[];
const tmpLeft = () => fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('compose-unreadable-'));

beforeAll(async () => {
  tmpBefore = tmpLeft();
});

afterAll(() => {
  if (home) { try { fs.chmodSync(path.join(home, '.claude.json'), 0o600); } catch { /* ignore */ } }
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  expect(tmpLeft()).toEqual(tmpBefore);
});

describe.skipIf(skip)('unreadable ~/.claude.json (POSIX, non-root only: chmod 000 is not enforced for root or on Windows)', () => {
  it('compose leaves the file byte-identical, succeeds, and records fleetMcp unavailable/member-config-unreadable', async () => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'compose-unreadable-')));
    home = path.join(scratch, 'home');
    work = path.join(scratch, 'work');
    fs.mkdirSync(home);
    fs.mkdirSync(work);
    const file = path.join(home, '.claude.json');
    fs.writeFileSync(file, ORIGINAL);
    const before = fs.readFileSync(file);
    fs.chmodSync(file, 0o000);

    realHome = process.env.HOME;
    realUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    delete process.env.CLAUDE_CONFIG_DIR;
    try {
      const { backupAndResetRegistry, restoreRegistry, makeTestLocalAgent } = await import('./test-helpers.js');
      const { addAgent, getAgent } = await import('../src/services/registry.js');
      const { composePermissions } = await import('../src/tools/compose-permissions.js');
      backupAndResetRegistry();
      try {
        const agent = makeTestLocalAgent({ friendlyName: 'locked-config', workFolder: work, llmProvider: 'claude' });
        addAgent(agent);
        const result = await composePermissions({ member_id: agent.id, role: 'doer' });
        fs.chmodSync(file, 0o600);
        expect(result).not.toContain('[FAIL]');
        expect(result).toContain('Permissions composed');
        expect(fs.readFileSync(file).equals(before)).toBe(true);
        expect(getAgent(agent.id)?.fleetMcp).toMatchObject({ state: 'unavailable', reason: 'member-config-unreadable' });
      } finally {
        restoreRegistry();
      }
    } finally {
      if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
      if (realUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realUserProfile;
    }
  });
});
