/**
 * End-to-end verification of the member per-folder apra-fleet MCP config
 * across claude, agy and opencode, driven through the real tools
 * (compose_permissions, update_member) on the REAL LocalStrategy against:
 *  - a sandbox home (HOME, USERPROFILE and os.homedir() all redirected), so
 *    the member's ~/.claude.json, agy and opencode global configs live in the
 *    sandbox -- the real ~/.claude.json is never touched;
 *  - a temp git clone that tracks .mcp.json (with a deepwiki server).
 * No LLM CLI is ever invoked.
 *
 * Observable properties asserted:
 *  - claude: projects[<folder>].mcpServers.apra-fleet.url ends with
 *    ?member=<uuid>, and no {disabled:true} apra-fleet entry exists anywhere;
 *  - opencode: <workFolder>/opencode.json carries the ?member=<uuid> entry,
 *    .git/info/exclude lists opencode.json, and opencode has no MCP deny rules;
 *  - agy: no member MCP entry is written; deny rules = allowlist complement;
 *  - claude deny rules = allowlist complement (computed from
 *    member-tool-allowlist.ts, never a hardcoded copy);
 *  - git status --porcelain is empty after compose, for every provider;
 *  - nothing targets deepwiki; a seeded apra-fleet-member entry is gone from
 *    every config the composing provider owns;
 *  - a provider switch leaves no config for the old provider;
 *  - no source file outside tests still references registerMcpEndpoint;
 *  - no artifact leaks outside the sandbox.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { backupAndResetRegistry, restoreRegistry, makeTestAgent } from './test-helpers.js';
import { addAgent, getAllAgents } from '../src/services/registry.js';
import { composePermissions } from '../src/tools/compose-permissions.js';
import { updateMember } from '../src/tools/update-member.js';
import { MEMBER_DENIED_TOOLS, MEMBER_ALLOWED_TOOLS, REGISTERED_TOOL_NAMES } from '../src/services/member-tool-allowlist.js';
import type { Agent, LlmProvider } from '../src/types.js';

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
  readMemberStatus: vi.fn(() => 'idle'),
}));

// Captured before any spy: the real user's home, used only to prove it is untouched.
const REAL_HOME = os.homedir();
const REPO_ROOT = path.resolve(__dirname, '..');
const HOST_OS: 'macos' | 'linux' = process.platform === 'darwin' ? 'macos' : 'linux';
const AGY_PROJECT_ID = '1afd6dbb-498f-4918-a9d9-6da64b75a204';
const DEEPWIKI = { type: 'http', url: 'https://mcp.deepwiki.com/mcp' };
const LEGACY = { type: 'http', url: 'http://localhost:1234/mcp?member=old', headers: { Authorization: 'Bearer legacy-jwt' } };
const MCP_JSON = JSON.stringify({ mcpServers: { deepwiki: DEEPWIKI } }, null, 2) + '\n';

// The complement, derived here from the allowlist module's own primitives --
// not a hardcoded tool list, and not MEMBER_DENIED_TOOLS re-used blindly.
const COMPLEMENT = REGISTERED_TOOL_NAMES.filter(t => !MEMBER_ALLOWED_TOOLS.includes(t));

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
  fs.writeFileSync(path.join(dir, '.mcp.json'), MCP_JSON);
  git(dir, 'add', '.mcp.json');
  git(dir, 'commit', '-q', '-m', 'track .mcp.json');
  return dir;
}

const readJson = (p: string): any => JSON.parse(fs.readFileSync(p, 'utf-8'));
const readJsonOr = (p: string, fallback: any): any => (fs.existsSync(p) ? readJson(p) : fallback);
function writeJson(p: string, v: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2));
}

const paths = {
  claudeJson: () => path.join(home, '.claude.json'),
  agyProject: () => path.join(home, '.gemini', 'config', 'projects', `${AGY_PROJECT_ID}.json`),
  agyMcp: () => path.join(home, '.gemini', 'config', 'mcp_config.json'),
  opencodeGlobal: () => path.join(home, '.config', 'opencode', 'opencode.json'),
  claudeSettings: (wf: string) => path.join(wf, '.claude', 'settings.local.json'),
  opencodeProject: (wf: string) => path.join(wf, 'opencode.json'),
  opencodeSettings: (wf: string) => path.join(wf, '.opencode', 'settings.json'),
  exclude: (wf: string) => path.join(wf, '.git', 'info', 'exclude'),
};

const excludeLines = (wf: string): string[] => fs.readFileSync(paths.exclude(wf), 'utf-8').split('\n').map(l => l.trim());
const memberUrlRe = (id: string) => new RegExp(`^http://localhost:\\d+/mcp\\?member=${id}$`);

/** Every file under a directory (recursive). */
function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p)); else out.push(p);
  }
  return out;
}

/** Seeds legacy apra-fleet-member + deepwiki entries in every place compose prunes. */
function seedLegacy(wf: string): void {
  writeJson(paths.claudeJson(), {
    mcpServers: { 'apra-fleet-member': LEGACY, deepwiki: DEEPWIKI },
    projects: { [wf]: { mcpServers: { 'apra-fleet-member': LEGACY, deepwiki: DEEPWIKI } } },
  });
  writeJson(paths.agyMcp(), { mcpServers: { 'apra-fleet-member': LEGACY, deepwiki: DEEPWIKI } });
  writeJson(paths.opencodeGlobal(), { mcp: { 'apra-fleet-member': LEGACY, deepwiki: { type: 'remote', url: DEEPWIKI.url } } });
  writeJson(paths.agyProject(), { id: AGY_PROJECT_ID, name: 'sandbox' });
}

function addMember(provider: LlmProvider, wf: string): Agent {
  const member = makeTestAgent({
    friendlyName: `e2e-${provider}-${seq}`,
    agentType: 'local',
    host: undefined,
    port: undefined,
    username: undefined,
    authType: undefined,
    llmProvider: provider,
    os: HOST_OS,
    workFolder: wf,
    // Every member carries the sandbox agy project id, so a switch to agy
    // re-verifies the existing project instead of running the agy CLI.
    agyProjectId: AGY_PROJECT_ID,
  });
  addAgent(member);
  return member;
}

/** No `apra-fleet: {disabled: true}` anywhere in a parsed config tree. */
function hasDisabledFleetSwitch(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
    if (k === 'apra-fleet' && child && typeof child === 'object' && (child as any).disabled === true) return true;
    if (hasDisabledFleetSwitch(child)) return true;
  }
  return false;
}

/** All member-side config the providers own, parsed (missing files -> {}). */
function allConfigs(wf: string): Record<string, any> {
  return {
    claudeJson: readJsonOr(paths.claudeJson(), {}),
    claudeSettings: readJsonOr(paths.claudeSettings(wf), {}),
    agyProject: readJsonOr(paths.agyProject(), {}),
    agyMcp: readJsonOr(paths.agyMcp(), {}),
    opencodeGlobal: readJsonOr(paths.opencodeGlobal(), {}),
    opencodeProject: readJsonOr(paths.opencodeProject(wf), {}),
    opencodeSettings: readJsonOr(paths.opencodeSettings(wf), {}),
  };
}

/** The config files each provider owns -- where its compose prunes the legacy entry. */
const OWNED: Record<'claude' | 'agy' | 'opencode', string[]> = {
  claude: ['claudeJson', 'claudeSettings'],
  agy: ['agyProject', 'agyMcp'],
  opencode: ['opencodeGlobal', 'opencodeProject', 'opencodeSettings'],
};

function assertCommonInvariants(wf: string, provider: 'claude' | 'agy' | 'opencode'): void {
  const cfgs = allConfigs(wf);
  // The seeded legacy url+bearer entry is gone from every config this
  // provider owns (each provider prunes its own MCP config locations).
  for (const key of OWNED[provider]) {
    expect(JSON.stringify(cfgs[key]), key).not.toContain('apra-fleet-member');
    expect(JSON.stringify(cfgs[key]), key).not.toContain('legacy-jwt');
  }
  // No blanket disable switch anywhere.
  expect(hasDisabledFleetSwitch(cfgs)).toBe(false);
  // deepwiki is never pruned, and no deny rule targets it.
  expect(cfgs.claudeJson.mcpServers?.deepwiki).toEqual(DEEPWIKI);
  expect(cfgs.agyMcp.mcpServers?.deepwiki).toEqual(DEEPWIKI);
  expect(cfgs.opencodeGlobal.mcp?.deepwiki).toEqual({ type: 'remote', url: DEEPWIKI.url });
  expect(JSON.stringify(cfgs.claudeSettings.permissions?.deny ?? [])).not.toContain('deepwiki');
  expect(JSON.stringify(cfgs.agyProject.permissionGrants ?? {})).not.toContain('deepwiki');
  // The tracked .mcp.json is never written, and the clone reads clean.
  expect(fs.readFileSync(path.join(wf, '.mcp.json'), 'utf-8')).toBe(MCP_JSON);
  expect(git(wf, 'status', '--porcelain')).toBe('');
}

function assertClaudeConfigured(wf: string, member: Agent): void {
  const cfgs = allConfigs(wf);
  const entry = cfgs.claudeJson.projects[wf].mcpServers['apra-fleet'];
  expect(entry).toEqual({ type: 'http', url: expect.stringMatching(memberUrlRe(member.id)) });
  expect(cfgs.claudeJson.projects[wf].mcpServers.deepwiki).toEqual(DEEPWIKI);
  expect(cfgs.claudeSettings.permissions.deny).toEqual(COMPLEMENT.map(t => `mcp__apra-fleet__${t}`));
  expect(excludeLines(wf)).toContain('/.claude/settings.local.json');
}

function assertClaudeAbsent(wf: string): void {
  const cfgs = allConfigs(wf);
  expect(cfgs.claudeJson.projects?.[wf]?.mcpServers?.['apra-fleet']).toBeUndefined();
  expect(fs.existsSync(paths.claudeSettings(wf))).toBe(false);
  expect(excludeLines(wf)).not.toContain('/.claude/settings.local.json');
}

function assertOpencodeConfigured(wf: string, member: Agent): void {
  const cfgs = allConfigs(wf);
  expect(cfgs.opencodeProject.mcp['apra-fleet']).toEqual({ type: 'remote', url: expect.stringMatching(memberUrlRe(member.id)), enabled: true });
  expect(excludeLines(wf)).toContain('/opencode.json');
  // opencode relies on the server's reduced tool list: no MCP deny rules.
  expect(JSON.stringify(cfgs.opencodeSettings)).not.toMatch(/mcp|apra-fleet|deny\b.*apra/);
}

function assertOpencodeAbsent(wf: string): void {
  expect(fs.existsSync(paths.opencodeProject(wf))).toBe(false);
  expect(fs.existsSync(paths.opencodeSettings(wf))).toBe(false);
  expect(excludeLines(wf)).not.toContain('/opencode.json');
  expect(excludeLines(wf)).not.toContain('/.opencode/settings.json');
}

function assertAgyConfigured(): void {
  const grants = readJson(paths.agyProject()).permissionGrants.permissionGrants;
  expect(grants.deny).toEqual(COMPLEMENT.map(t => `mcp(apra-fleet/${t})`));
  // agy has no per-project MCP config: mcp_config.json holds only deepwiki.
  expect(readJson(paths.agyMcp())).toEqual({ mcpServers: { deepwiki: DEEPWIKI } });
}

function assertAgyAbsent(): void {
  const project = readJson(paths.agyProject());
  expect(project.permissionGrants).toBeUndefined();
  // agy's own project fields are left alone.
  expect(project.id).toBe(AGY_PROJECT_ID);
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-member-mcp-e2e-'));
  home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  expect(fs.existsSync(root)).toBe(false);
});

beforeEach(() => {
  backupAndResetRegistry();
  // One sandbox home for the whole file (LocalStrategy caches the member
  // shell's clean env, built from HOME, per process).
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.spyOn(os, 'homedir').mockReturnValue(home);
});

afterEach(() => {
  restoreRegistry();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe.skipIf(process.platform === 'win32')('member per-folder apra-fleet MCP config -- claude, agy, opencode', () => {
  it('the complement used below is the allowlist module\'s own complement and is non-trivial', () => {
    expect(COMPLEMENT).toEqual([...MEMBER_DENIED_TOOLS]);
    expect(COMPLEMENT).toContain('execute_prompt');
    expect(COMPLEMENT).not.toContain('kb_query');
    expect(COMPLEMENT.some(t => t.includes('deepwiki'))).toBe(false);
  });

  it('claude: compose writes the local-scope ?member=<uuid> entry and complement deny rules; legacy gone; clone clean', async () => {
    const wf = makeClone();
    seedLegacy(wf);
    const member = addMember('claude', wf);
    // A settings.local.json left by an older compose (blanket disable switch).
    writeJson(paths.claudeSettings(wf), { mcpServers: { 'apra-fleet': { disabled: true }, 'apra-fleet-member': LEGACY } });

    expect(await composePermissions({ member_id: member.id, role: 'doer' })).toContain('Permissions composed');

    assertClaudeConfigured(wf, member);
    assertOpencodeAbsent(wf);
    assertCommonInvariants(wf, 'claude');
  }, 60000);

  it('opencode: compose writes <workFolder>/opencode.json (?member=<uuid>), git-excluded, no MCP deny rules; clone clean', async () => {
    const wf = makeClone();
    seedLegacy(wf);
    const member = addMember('opencode', wf);

    expect(await composePermissions({ member_id: member.id, role: 'doer' })).toContain('Permissions composed');

    assertOpencodeConfigured(wf, member);
    expect(allConfigs(wf).claudeJson.projects[wf].mcpServers['apra-fleet']).toBeUndefined();
    assertCommonInvariants(wf, 'opencode');
  }, 60000);

  it('agy: compose writes no member MCP entry and complement deny rules; clone clean', async () => {
    const wf = makeClone();
    seedLegacy(wf);
    const member = addMember('agy', wf);

    expect(await composePermissions({ member_id: member.id, role: 'doer' })).toContain('Permissions composed');

    assertAgyConfigured();
    expect(allConfigs(wf).claudeJson.projects[wf].mcpServers['apra-fleet']).toBeUndefined();
    assertOpencodeAbsent(wf);
    expect(fs.existsSync(path.join(wf, '.claude'))).toBe(false);
    assertCommonInvariants(wf, 'agy');
  }, 60000);

  it('provider switches claude -> agy -> opencode -> claude each leave no config for the old provider', async () => {
    const wf = makeClone();
    seedLegacy(wf);
    const member = addMember('claude', wf);
    expect(await composePermissions({ member_id: member.id, role: 'doer' })).toContain('Permissions composed');
    assertClaudeConfigured(wf, member);

    const switchTo = async (provider: LlmProvider) => {
      const result = await updateMember({ member_id: member.id, llm_provider: provider } as any);
      expect(result).not.toContain('ERROR');
      expect(result).not.toContain('could not remove');
      expect(getAllAgents().find(a => a.id === member.id)!.llmProvider).toBe(provider);
    };

    await switchTo('agy');
    assertClaudeAbsent(wf);
    assertAgyConfigured();
    assertOpencodeAbsent(wf);
    assertCommonInvariants(wf, 'agy');

    await switchTo('opencode');
    assertAgyAbsent();
    assertOpencodeConfigured(wf, member);
    assertClaudeAbsent(wf);
    assertCommonInvariants(wf, 'opencode');

    await switchTo('claude');
    assertOpencodeAbsent(wf);
    assertAgyAbsent();
    assertClaudeConfigured(wf, member);
    assertCommonInvariants(wf, 'claude');
  }, 120000);

  it('no source file outside tests references registerMcpEndpoint', () => {
    const offenders = listFiles(path.join(REPO_ROOT, 'src'))
      .filter(f => !/test/i.test(path.basename(f)))
      .filter(f => fs.readFileSync(f, 'utf-8').includes('registerMcpEndpoint'));
    expect(offenders).toEqual([]);
  });

  it('nothing leaked outside the sandbox: the real ~/.claude.json has no entry for any sandbox folder', () => {
    const realClaudeJson = path.join(REAL_HOME, '.claude.json');
    expect(REAL_HOME).not.toBe(home);
    if (fs.existsSync(realClaudeJson)) {
      const projects = Object.keys(JSON.parse(fs.readFileSync(realClaudeJson, 'utf-8')).projects ?? {});
      expect(projects.filter(k => k.startsWith(root))).toEqual([]);
    }
    // Every file the suite wrote is inside the sandbox root.
    for (const f of listFiles(home)) expect(f.startsWith(root)).toBe(true);
  });
});
