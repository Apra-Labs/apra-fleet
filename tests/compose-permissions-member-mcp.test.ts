/**
 * compose_permissions writes the member's PER-FOLDER apra-fleet MCP entry
 * (?member=<uuid>) through each provider's own per-project mechanism, denies
 * exactly the complement of the member allowlist (claude, agy), prunes the
 * retired apra-fleet-member url+bearer entry, never touches deepwiki, and
 * leaves a member clone that tracks .mcp.json with an empty
 * `git status --porcelain`.
 *
 * Runs the REAL LocalStrategy against a real temp git clone and a scratch
 * home: HOME/USERPROFILE and os.homedir() all point into the sandbox, so the
 * real ~/.claude.json (and every other real config) is never touched. No LLM
 * CLI is invoked.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { backupAndResetRegistry, restoreRegistry, makeTestAgent } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { composePermissions } from '../src/tools/compose-permissions.js';
import { MEMBER_DENIED_TOOLS, MEMBER_ALLOWED_TOOLS } from '../src/services/member-tool-allowlist.js';
import type { LlmProvider } from '../src/types.js';
import { pointHomeAt } from './helpers/isolated-home.mjs';
// Restores HOME after pointHomeAt (tests/helpers/isolated-home.mjs).
let restoreHome: (() => void) | undefined;

const HOST_OS: 'macos' | 'linux' = process.platform === 'darwin' ? 'macos' : 'linux';
const AGY_PROJECT_ID = '1afd6dbb-498f-4918-a9d9-6da64b75a204';
const DEEPWIKI = { type: 'http', url: 'https://mcp.deepwiki.com/mcp' };
const LEGACY = { type: 'http', url: 'http://localhost:1234/mcp?member=old', headers: { Authorization: 'Bearer legacy-jwt' } };
const MCP_JSON = JSON.stringify({ mcpServers: { deepwiki: DEEPWIKI } }, null, 2) + '\n';

let root: string;
let home: string;
let cloneSeq = 0;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf-8' });
}

/** A fresh clone-like work folder whose only tracked file is .mcp.json. */
function makeClone(): string {
  const dir = path.join(root, `clone-${++cloneSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, '.mcp.json'), MCP_JSON);
  git(dir, 'add', '.mcp.json');
  git(dir, 'commit', '-q', '-m', 'track .mcp.json');
  expect(git(dir, 'status', '--porcelain')).toBe('');
  return dir;
}

function readJson(p: string): any {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function writeJson(p: string, v: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2));
}

function addMember(provider: LlmProvider, workFolder: string) {
  const member = makeTestAgent({
    friendlyName: `mcp-${provider}-${cloneSeq}`,
    agentType: 'local',
    host: undefined,
    port: undefined,
    username: undefined,
    authType: undefined,
    llmProvider: provider,
    os: HOST_OS,
    workFolder,
    ...(provider === 'agy' ? { agyProjectId: AGY_PROJECT_ID } : {}),
  });
  addAgent(member);
  return member;
}

/** Every file under the sandbox home, for "no stray config written" checks. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p)); else out.push(p);
  }
  return out;
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-member-mcp-'));
  home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  backupAndResetRegistry();
  // One sandbox home for the whole file: LocalStrategy builds (and caches) the
  // member shell's clean env from HOME, and getMemberHomeDir resolves a local
  // member's home from os.homedir().
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

describe.skipIf(process.platform === 'win32')('compose_permissions -- per-folder apra-fleet member MCP entry', () => {
  it('claude: local-scope entry with ?member=<uuid>, allowlist-complement deny rules, legacy pruned, clone stays clean', async () => {
    const wf = makeClone();
    const member = addMember('claude', wf);
    const claudeJson = path.join(home, '.claude.json');
    writeJson(claudeJson, {
      mcpServers: { 'apra-fleet-member': LEGACY, deepwiki: DEEPWIKI },
      projects: { [wf]: { mcpServers: { 'apra-fleet-member': LEGACY, deepwiki: DEEPWIKI }, allowedTools: ['x'] } },
    });
    // A settings.local.json left by an older compose: the blanket disable switch.
    writeJson(path.join(wf, '.claude', 'settings.local.json'), {
      permissions: { allow: ['Read'] },
      mcpServers: { 'apra-fleet': { disabled: true }, 'apra-fleet-member': LEGACY },
    });

    const result = await composePermissions({ member_id: member.id, role: 'doer' });
    expect(result).toContain('Permissions composed');

    const cfg = readJson(claudeJson);
    const project = cfg.projects[wf];
    expect(project.mcpServers['apra-fleet'].url).toMatch(new RegExp(`\\?member=${member.id}$`));
    expect(project.mcpServers['apra-fleet'].type).toBe('http');
    // deepwiki and unrelated project fields survive; legacy entry is gone.
    expect(project.mcpServers.deepwiki).toEqual(DEEPWIKI);
    expect(project.allowedTools).toEqual(['x']);
    expect(cfg.mcpServers).toEqual({ deepwiki: DEEPWIKI });
    expect(JSON.stringify(cfg)).not.toContain('apra-fleet-member');

    const settings = readJson(path.join(wf, '.claude', 'settings.local.json'));
    expect(settings.mcpServers).toBeUndefined();
    expect(JSON.stringify(settings)).not.toContain('apra-fleet-member');
    expect(JSON.stringify(settings)).not.toMatch(/"disabled"/);
    // Deny rules are exactly the complement of the member allowlist.
    expect(settings.permissions.deny).toEqual(MEMBER_DENIED_TOOLS.map(t => `mcp__apra-fleet__${t}`));
    expect(new Set(settings.permissions.deny.map((r: string) => r.replace('mcp__apra-fleet__', '')))).toEqual(
      new Set(['register_member', 'execute_prompt', 'remove_member', ...MEMBER_DENIED_TOOLS]),
    );
    for (const allowed of MEMBER_ALLOWED_TOOLS) expect(settings.permissions.deny).not.toContain(`mcp__apra-fleet__${allowed}`);
    expect(JSON.stringify(settings.permissions.deny)).not.toContain('deepwiki');

    // The tracked .mcp.json is never written; the clone reads clean.
    expect(fs.readFileSync(path.join(wf, '.mcp.json'), 'utf-8')).toBe(MCP_JSON);
    expect(git(wf, 'status', '--porcelain')).toBe('');
    expect(fs.readFileSync(path.join(wf, '.git', 'info', 'exclude'), 'utf-8')).toContain('/.claude/settings.local.json');
  }, 60000);

  it('opencode: <workFolder>/opencode.json carries the ?member=<uuid> entry, is git-excluded, and gets no MCP deny rules', async () => {
    const wf = makeClone();
    const member = addMember('opencode', wf);
    const globalCfg = path.join(home, '.config', 'opencode', 'opencode.json');
    writeJson(globalCfg, { mcp: { 'apra-fleet-member': LEGACY, deepwiki: { type: 'remote', url: DEEPWIKI.url } } });

    const result = await composePermissions({ member_id: member.id, role: 'doer' });
    expect(result).toContain('Permissions composed');

    const project = readJson(path.join(wf, 'opencode.json'));
    expect(project.mcp['apra-fleet']).toEqual({ type: 'remote', url: expect.stringMatching(new RegExp(`\\?member=${member.id}$`)), enabled: true });
    const exclude = fs.readFileSync(path.join(wf, '.git', 'info', 'exclude'), 'utf-8').split('\n');
    expect(exclude).toContain('/opencode.json');

    // opencode relies on the server's reduced tool list: no MCP deny rules.
    const perm = readJson(path.join(wf, '.opencode', 'settings.json'));
    expect(JSON.stringify(perm)).not.toMatch(/mcp|apra-fleet/);

    // Legacy entry pruned from the global config, deepwiki kept.
    const global = readJson(globalCfg);
    expect(global.mcp).toEqual({ deepwiki: { type: 'remote', url: DEEPWIKI.url } });

    expect(fs.readFileSync(path.join(wf, '.mcp.json'), 'utf-8')).toBe(MCP_JSON);
    expect(git(wf, 'status', '--porcelain')).toBe('');
  }, 60000);

  it('agy: no member MCP entry is written, deny rules are the allowlist complement, legacy pruned, clone stays clean', async () => {
    const wf = makeClone();
    const member = addMember('agy', wf);
    const projectFile = path.join(home, '.gemini', 'config', 'projects', `${AGY_PROJECT_ID}.json`);
    writeJson(projectFile, { id: AGY_PROJECT_ID, name: 'p' });
    const mcpConfig = path.join(home, '.gemini', 'config', 'mcp_config.json');
    writeJson(mcpConfig, { mcpServers: { 'apra-fleet-member': LEGACY, deepwiki: DEEPWIKI } });
    const homeBefore = new Set(listFiles(home));

    const result = await composePermissions({ member_id: member.id, role: 'doer' });
    expect(result).toContain('Permissions composed');

    const grants = readJson(projectFile).permissionGrants.permissionGrants;
    expect(grants.deny).toEqual(MEMBER_DENIED_TOOLS.map(t => `mcp(apra-fleet/${t})`));
    expect(JSON.stringify(grants.deny)).not.toContain('deepwiki');

    // No member MCP entry anywhere: mcp_config.json only lost the legacy entry,
    // nothing was added to the work folder, and no new home files appeared.
    expect(readJson(mcpConfig)).toEqual({ mcpServers: { deepwiki: DEEPWIKI } });
    expect(fs.existsSync(path.join(wf, 'opencode.json'))).toBe(false);
    expect(fs.existsSync(path.join(wf, '.claude'))).toBe(false);
    const added = listFiles(home).filter(f => !homeBefore.has(f));
    expect(added).toEqual([]);

    expect(fs.readFileSync(path.join(wf, '.mcp.json'), 'utf-8')).toBe(MCP_JSON);
    expect(git(wf, 'status', '--porcelain')).toBe('');
  }, 60000);
});
