/**
 * Member lifecycle keeps the per-folder member MCP entry in step with the
 * registry:
 *  - update_member that moves a member's work folder re-composes: the NEW
 *    folder gets the ?member= entry (otherwise a session there sees the FULL
 *    user-scope entry until the next compose) and the OLD folder's entry is
 *    removed;
 *  - remove_member removes the per-folder entry (and the fleet permission
 *    keys) before it deletes the member, and reports what it could not remove.
 *
 * REAL LocalStrategy against real temp git clones and a sandbox home
 * (HOME/USERPROFILE/os.homedir), so the real ~/.claude.json is never touched.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { backupAndResetRegistry, restoreRegistry, makeTestAgent } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { composePermissions } from '../src/tools/compose-permissions.js';
import { updateMember } from '../src/tools/update-member.js';
import { removeMember } from '../src/tools/remove-member.js';
import { getAgent } from '../src/services/registry.js';
import type { LlmProvider } from '../src/types.js';
import { pointHomeAt } from './helpers/isolated-home.mjs';
// Restores HOME after pointHomeAt (tests/helpers/isolated-home.mjs).
let restoreHome: (() => void) | undefined;

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
  readMemberStatus: vi.fn(() => 'idle'),
}));

const HOST_OS: 'macos' | 'linux' = process.platform === 'darwin' ? 'macos' : 'linux';
const DEEPWIKI = { type: 'http', url: 'https://mcp.deepwiki.com/mcp' };

let root: string;
let home: string;
let seq = 0;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf-8' });
}

function makeClone(): string {
  const dir = path.join(root, `clone-${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { deepwiki: DEEPWIKI } }, null, 2) + '\n');
  git(dir, 'add', '.mcp.json');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

const readJson = (p: string): any => JSON.parse(fs.readFileSync(p, 'utf-8'));
function writeJson(p: string, v: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2));
}
const excludeLines = (wf: string): string[] =>
  fs.readFileSync(path.join(wf, '.git', 'info', 'exclude'), 'utf-8').split('\n').map(l => l.trim());
const claudeJson = () => path.join(home, '.claude.json');

function addMember(provider: LlmProvider, workFolder: string) {
  const member = makeTestAgent({
    friendlyName: `lifecycle-${provider}-${seq}`,
    agentType: 'local',
    host: undefined,
    port: undefined,
    username: undefined,
    authType: undefined,
    llmProvider: provider,
    os: HOST_OS,
    workFolder,
  });
  addAgent(member);
  return member;
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-member-lifecycle-'));
  home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  backupAndResetRegistry();
  restoreHome = pointHomeAt(home);
  vi.stubEnv('USERPROFILE', home);
  vi.spyOn(os, 'homedir').mockReturnValue(home);
});

afterEach(() => {
  restoreRegistry();
  vi.restoreAllMocks();
  restoreHome?.();
  vi.unstubAllEnvs();
});

const memberUrl = (id: string) => new RegExp(`\\?member=${id}$`);

describe.skipIf(process.platform === 'win32')('update_member -- work folder move re-composes', () => {
  it('claude: the new folder gets the ?member= entry, the old folder entry and permission file are removed', async () => {
    const oldWf = makeClone();
    const newWf = makeClone();
    const member = addMember('claude', oldWf);
    writeJson(claudeJson(), { mcpServers: { deepwiki: DEEPWIKI }, projects: { [oldWf]: { mcpServers: { deepwiki: DEEPWIKI } } } });
    expect(await composePermissions({ member_id: member.id, role: 'doer' })).toContain('Permissions composed');
    expect(readJson(claudeJson()).projects[oldWf].mcpServers['apra-fleet'].url).toMatch(memberUrl(member.id));

    const result = await updateMember({ member_id: member.id, work_folder: newWf });
    expect(result).toContain('updated');
    expect(result).not.toContain('ERROR');
    expect(result).not.toContain('could not remove');

    const projects = readJson(claudeJson()).projects;
    expect(projects[newWf].mcpServers['apra-fleet'].url).toMatch(memberUrl(member.id));
    expect(projects[oldWf].mcpServers['apra-fleet']).toBeUndefined();
    expect(projects[oldWf].mcpServers.deepwiki).toEqual(DEEPWIKI);
    expect(fs.existsSync(path.join(newWf, '.claude', 'settings.local.json'))).toBe(true);
    expect(fs.existsSync(path.join(oldWf, '.claude', 'settings.local.json'))).toBe(false);
    expect(excludeLines(oldWf)).not.toContain('/.claude/settings.local.json');
    expect(git(oldWf, 'status', '--porcelain')).toBe('');
    expect(git(newWf, 'status', '--porcelain')).toBe('');
  }, 60000);

  it('opencode: opencode.json moves from the old folder to the new one', async () => {
    const oldWf = makeClone();
    const newWf = makeClone();
    const member = addMember('opencode', oldWf);
    expect(await composePermissions({ member_id: member.id, role: 'doer' })).toContain('Permissions composed');
    expect(fs.existsSync(path.join(oldWf, 'opencode.json'))).toBe(true);

    const result = await updateMember({ member_id: member.id, work_folder: newWf });
    expect(result).not.toContain('ERROR');

    expect(fs.existsSync(path.join(oldWf, 'opencode.json'))).toBe(false);
    expect(excludeLines(oldWf)).not.toContain('/opencode.json');
    expect(readJson(path.join(newWf, 'opencode.json')).mcp['apra-fleet'].url).toMatch(memberUrl(member.id));
    expect(excludeLines(newWf)).toContain('/opencode.json');
  }, 60000);
});

describe.skipIf(process.platform === 'win32')('remove_member -- member-side cleanup before the member is deleted', () => {
  it('claude: the per-folder ?member= entry and permission file are removed, deepwiki survives', async () => {
    const wf = makeClone();
    const member = addMember('claude', wf);
    writeJson(claudeJson(), { mcpServers: { deepwiki: DEEPWIKI }, projects: { [wf]: { mcpServers: { deepwiki: DEEPWIKI } } } });
    expect(await composePermissions({ member_id: member.id, role: 'doer' })).toContain('Permissions composed');
    expect(readJson(claudeJson()).projects[wf].mcpServers['apra-fleet']).toBeDefined();

    const result = await removeMember({ member_id: member.id });
    expect(result).toContain('has been removed');
    expect(result).not.toContain('Could not remove');
    expect(getAgent(member.id)).toBeUndefined();

    const project = readJson(claudeJson()).projects[wf];
    expect(project.mcpServers['apra-fleet']).toBeUndefined();
    expect(project.mcpServers.deepwiki).toEqual(DEEPWIKI);
    expect(fs.existsSync(path.join(wf, '.claude', 'settings.local.json'))).toBe(false);
    expect(git(wf, 'status', '--porcelain')).toBe('');
  }, 60000);

  it('reports a per-folder config it could not clean up, and still removes the member', async () => {
    const wf = makeClone();
    const member = addMember('opencode', wf);
    expect(await composePermissions({ member_id: member.id, role: 'doer' })).toContain('Permissions composed');
    // A JSONC edit the user made after compose: cleanup must refuse to rewrite it.
    fs.writeFileSync(path.join(wf, 'opencode.json'), '{ // mine\n "mcp": {} }\n');

    const result = await removeMember({ member_id: member.id });
    expect(result).toContain('has been removed');
    expect(result).toMatch(/Could not remove the member's composed config[^\n]*opencode\.json/);
    expect(fs.readFileSync(path.join(wf, 'opencode.json'), 'utf-8')).toContain('// mine');
    expect(getAgent(member.id)).toBeUndefined();
  }, 60000);
});
