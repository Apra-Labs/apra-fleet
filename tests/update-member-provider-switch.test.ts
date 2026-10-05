/**
 * update_member: a provider change removes exactly what compose_permissions
 * wrote for the OLD provider (permission file, per-folder apra-fleet MCP
 * entry, .git/info/exclude lines) and re-composes for the NEW provider;
 * unrelated MCP entries (deepwiki, user-added servers) survive; an update that
 * does not change the provider runs no cleanup.
 *
 * REAL LocalStrategy against a real temp git clone and a sandbox home
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
    friendlyName: `switch-${provider}-${seq}`,
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-provider-switch-'));
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

describe.skipIf(process.platform === 'win32')('update_member -- provider switch cleanup', () => {
  it('claude -> opencode: the claude entry and permission file are gone, the opencode entry exists, deepwiki survives', async () => {
    const wf = makeClone();
    const member = addMember('claude', wf);
    writeJson(claudeJson(), { mcpServers: { deepwiki: DEEPWIKI }, projects: { [wf]: { mcpServers: { deepwiki: DEEPWIKI } } } });
    expect(await composePermissions({ member_id: member.id, role: 'doer' })).toContain('Permissions composed');
    expect(readJson(claudeJson()).projects[wf].mcpServers['apra-fleet']).toBeDefined();
    expect(fs.existsSync(path.join(wf, '.claude', 'settings.local.json'))).toBe(true);

    const result = await updateMember({ member_id: member.id, llm_provider: 'opencode' });
    expect(result).not.toContain('ERROR');
    expect(result).not.toContain('could not remove');

    const project = readJson(claudeJson()).projects[wf];
    expect(project.mcpServers['apra-fleet']).toBeUndefined();
    expect(project.mcpServers.deepwiki).toEqual(DEEPWIKI);
    expect(readJson(claudeJson()).mcpServers).toEqual({ deepwiki: DEEPWIKI });
    expect(fs.existsSync(path.join(wf, '.claude', 'settings.local.json'))).toBe(false);
    expect(excludeLines(wf)).not.toContain('/.claude/settings.local.json');

    const oc = readJson(path.join(wf, 'opencode.json'));
    expect(oc.mcp['apra-fleet'].url).toMatch(new RegExp(`\\?member=${member.id}$`));
    expect(excludeLines(wf)).toContain('/opencode.json');
    expect(git(wf, 'status', '--porcelain')).toBe('');
  }, 60000);

  it('opencode -> claude: the compose-created opencode.json and its exclude line are removed, the claude entry exists', async () => {
    const wf = makeClone();
    const member = addMember('opencode', wf);
    expect(await composePermissions({ member_id: member.id, role: 'doer' })).toContain('Permissions composed');
    expect(fs.existsSync(path.join(wf, 'opencode.json'))).toBe(true);
    expect(excludeLines(wf)).toContain('/opencode.json');

    const result = await updateMember({ member_id: member.id, llm_provider: 'claude' });
    expect(result).not.toContain('ERROR');

    expect(fs.existsSync(path.join(wf, 'opencode.json'))).toBe(false);
    expect(fs.existsSync(path.join(wf, '.opencode', 'settings.json'))).toBe(false);
    expect(excludeLines(wf)).not.toContain('/opencode.json');
    expect(excludeLines(wf)).not.toContain('/.opencode/settings.json');

    expect(readJson(claudeJson()).projects[wf].mcpServers['apra-fleet'].url).toMatch(new RegExp(`\\?member=${member.id}$`));
    expect(git(wf, 'status', '--porcelain')).toBe('');
  }, 60000);

  it('opencode -> claude keeps user-added servers in opencode.json (only the apra-fleet entry is removed)', async () => {
    const wf = makeClone();
    const member = addMember('opencode', wf);
    writeJson(path.join(wf, 'opencode.json'), { mcp: { 'my-server': { type: 'local', command: ['x'] }, deepwiki: { type: 'remote', url: DEEPWIKI.url } } });
    expect(await composePermissions({ member_id: member.id, role: 'doer' })).toContain('Permissions composed');
    expect(readJson(path.join(wf, 'opencode.json')).mcp['apra-fleet']).toBeDefined();

    await updateMember({ member_id: member.id, llm_provider: 'claude' });

    expect(readJson(path.join(wf, 'opencode.json'))).toEqual({
      mcp: { 'my-server': { type: 'local', command: ['x'] }, deepwiki: { type: 'remote', url: DEEPWIKI.url } },
    });
  }, 60000);

  it('an update that does not change the provider runs no cleanup and no re-compose', async () => {
    const wf = makeClone();
    const member = addMember('claude', wf);
    expect(await composePermissions({ member_id: member.id, role: 'doer' })).toContain('Permissions composed');
    // A reactive grant lives only in settings.local.json (no ledger): a cleanup
    // plus re-compose would silently drop it, so it must survive untouched.
    expect(await composePermissions({ member_id: member.id, role: 'doer', grant: ['Bash(custom-tool:*)'] })).toContain('Granted');
    // A stale opencode.json a provider-switch cleanup WOULD touch if it ran.
    const staleOc = { mcp: { 'apra-fleet': { type: 'remote', url: 'http://localhost:7523/mcp?member=stale', enabled: true } } };
    writeJson(path.join(wf, 'opencode.json'), staleOc);
    const settingsBefore = fs.readFileSync(path.join(wf, '.claude', 'settings.local.json'), 'utf-8');
    const claudeEntryBefore = readJson(claudeJson()).projects[wf].mcpServers['apra-fleet'];

    const result = await updateMember({ member_id: member.id, llm_provider: 'claude', friendly_name: `renamed-${seq}` });
    expect(result).toContain('updated');

    expect(readJson(path.join(wf, 'opencode.json'))).toEqual(staleOc);
    expect(fs.readFileSync(path.join(wf, '.claude', 'settings.local.json'), 'utf-8')).toBe(settingsBefore);
    expect(readJson(path.join(wf, '.claude', 'settings.local.json')).permissions.allow).toContain('Bash(custom-tool:*)');
    expect(readJson(claudeJson()).projects[wf].mcpServers['apra-fleet']).toEqual(claudeEntryBefore);
  }, 60000);
});
