/**
 * Claude Code keys LOCAL-scope MCP servers (~/.claude.json projects[<key>].mcpServers)
 * by the git repository ROOT of the folder it runs in, and by the exact folder only
 * outside a git repo. The member MCP entry writer (ClaudeProvider.syncMemberMcpEntry)
 * and the fleetMcp probe (readMemberMcpEntryUrl) must therefore use ONE resolver,
 * resolveClaudeProjectKey, or a nested work folder gets an entry the CLI never reads
 * while the probe reports it available (apra-fleet-b4g.100).
 *
 * Trust seeding (hasTrustDialogAccepted, ensureWorkspaceTrusted) is deliberately NOT
 * moved to the repo root: it stays keyed by the exact work folder. Whether the CLI keys
 * the trust flag by repo root is unverified; the CLI also honours trust recorded on the
 * folder itself, and writing trust on the repo root would widen trust to sibling
 * folders the operator never granted.
 *
 * The real-git tests execute the resolver's actual git command in a temp repo.
 */

import { describe, it, expect, vi } from 'vitest';
import { exec as nodeExec, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeProvider } from '../src/providers/claude.js';
import {
  resolveClaudeProjectKey,
  memberRepoRootCommand,
  normalizeProjectKey,
  memberMcpUrl,
  MEMBER_MCP_SERVER_NAME,
} from '../src/services/member-config-io.js';
import { readMemberMcpEntryUrl } from '../src/services/member-fleet-install.js';
import type { SSHExecResult } from '../src/types.js';
import { makeTestAgent } from './test-helpers.js';

const isWin = process.platform === 'win32';

function realExec(cmd: string, cwd?: string): Promise<SSHExecResult> {
  return new Promise((resolve) => {
    nodeExec(cmd, { cwd, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ stdout: String(stdout), stderr: String(stderr), code: err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0 });
    });
  });
}

function git(cwd: string, args: string): void {
  execSync(`git ${args}`, { cwd, stdio: 'pipe' });
}

describe('memberRepoRootCommand: no shell-level expansion on any OS/shell', () => {
  const folder = 'C:\\Users\\me\\work $x `y` "z"';
  const cases: Array<[string, boolean, boolean]> = [
    ['windows/powershell', true, false],
    ['windows/gitbash', true, true],
    ['posix', false, true],
  ];
  for (const [name, isWindows, posix] of cases) {
    it(`${name}: the command carries a quoted resolved path only`, () => {
      const cmd = memberRepoRootCommand(isWindows ? folder : '/home/me/work $x `y` "z"', isWindows, posix);
      expect(cmd.startsWith('git -C "')).toBe(true);
      expect(cmd.endsWith('" rev-parse --show-toplevel')).toBe(true);
      // Every $ and backtick that is part of the path is escaped for its shell.
      const inner = cmd.slice('git -C "'.length, -'" rev-parse --show-toplevel'.length);
      expect(inner.replace(/(\\|`)[$`"\\]/g, '')).not.toMatch(/[$`"]/);
      expect(cmd).not.toContain('~');
    });
    it(`${name}: a plain path has no $, ~ or backtick at all`, () => {
      const cmd = memberRepoRootCommand(isWindows ? 'C:\\work\\repo\\sub' : '/work/repo/sub', isWindows, posix);
      expect(cmd).not.toMatch(/[$~`]/);
    });
  }

  it('a PowerShell member gets a backslash path, gitbash and posix a forward-slash one', () => {
    expect(memberRepoRootCommand('C:/work/repo', true, false)).toBe('git -C "C:\\work\\repo" rev-parse --show-toplevel');
    expect(memberRepoRootCommand('C:\\work\\repo', true, true)).toBe('git -C "C:/work/repo" rev-parse --show-toplevel');
    expect(memberRepoRootCommand('/work/repo', false, true)).toBe('git -C "/work/repo" rev-parse --show-toplevel');
  });
});

describe('resolveClaudeProjectKey', () => {
  it('returns the repo root git reports', async () => {
    const exec = vi.fn(async () => ({ stdout: 'C:/work/repo\n', stderr: '', code: 0 }));
    expect(await resolveClaudeProjectKey(exec, 'C:\\work\\repo\\sub\\dir', true, false)).toBe('C:/work/repo');
  });
  it('falls back to the exact (normalised) folder outside a git repo, with git missing, or on garbage', async () => {
    const notRepo = vi.fn(async () => ({ stdout: '', stderr: 'fatal: not a git repository', code: 128 }));
    expect(await resolveClaudeProjectKey(notRepo, 'C:\\work\\plain\\', true, false)).toBe('C:/work/plain');
    const throws = vi.fn(async () => { throw new Error('spawn failed'); });
    expect(await resolveClaudeProjectKey(throws, '/work/plain/', false, true)).toBe('/work/plain');
    const garbage = vi.fn(async () => ({ stdout: 'warning: banner text\n', stderr: '', code: 0 }));
    expect(await resolveClaudeProjectKey(garbage, '/work/plain', false, true)).toBe('/work/plain');
  });
  it('normalizeProjectKey: forward slashes, no trailing slash', () => {
    expect(normalizeProjectKey('C:\\a\\b\\')).toBe('C:/a/b');
  });
});

describe('writer and probe share the resolver (real git)', () => {
  const tmpRoot = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'fleet-claude-key-'));
  const home = path.join(tmpRoot, 'home');
  const repo = path.join(tmpRoot, 'repo');
  const nested = path.join(repo, 'sub', 'dir');
  const plain = path.join(tmpRoot, 'plain', 'folder');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(plain, { recursive: true });
  git(repo, 'init -q');

  const agentOs = isWin ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
  const expectedRepoKey = normalizeProjectKey(fs.realpathSync.native(repo));

  /** A member whose fs is this machine: real git, real files under `home`. */
  function localMember() {
    const commands: string[] = [];
    const exec = async (cmd: string): Promise<SSHExecResult> => {
      commands.push(cmd);
      if (cmd.startsWith('git -C ')) return realExec(cmd);
      const read = cmd.match(/^if test -e "([^"]+)"; then cat "[^"]+"; fi$/) ?? cmd.match(/^if \(Test-Path -LiteralPath "([^"]+)"\) \{ Get-Content/);
      if (read) {
        const f = read[1];
        return { stdout: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '', stderr: '', code: 0 };
      }
      const move = cmd.match(/^(?:mv|Move-Item -Force) "([^"]+)" "([^"]+)"$/);
      if (move) { fs.renameSync(move[1], move[2]); return { stdout: '', stderr: '', code: 0 }; }
      // CLAUDE_CONFIG_DIR probe: unset.
      return { stdout: '', stderr: '', code: 0 };
    };
    const transport = {
      writeHomeFile: async (rel: string, content: string) => { fs.writeFileSync(path.join(home, rel), content, 'utf8'); },
    };
    return { commands, exec, transport };
  }

  function agentFor(workFolder: string) {
    return makeTestAgent({ llmProvider: 'claude', agentType: 'local', os: agentOs, workFolder, ...(isWin ? { shell: 'powershell5' as const } : {}) } as any);
  }

  async function sync(workFolder: string) {
    const m = localMember();
    const agent = agentFor(workFolder);
    const url = memberMcpUrl(agent);
    await new ClaudeProvider().syncMemberMcpEntry({
      agent, execCommand: m.exec, memberHomeDir: home, agentOs, shell: (agent as any).shell, transport: m.transport, url,
    });
    const config = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    const probed = await readMemberMcpEntryUrl(agent, home, { exec: (_a, cmd) => m.exec(cmd) });
    return { config, url, probed, commands: m.commands };
  }

  it('nested work folder: the entry is written under the REPO ROOT key and the probe returns that url', async () => {
    const { config, url, probed, commands } = await sync(nested);
    expect(Object.keys(config.projects)).toEqual([expectedRepoKey]);
    expect(config.projects[expectedRepoKey].mcpServers[MEMBER_MCP_SERVER_NAME]).toEqual({ type: 'http', url });
    expect(config.projects[normalizeProjectKey(nested)]).toBeUndefined();
    expect(probed).toBe(url);
    // Writer and probe issued the identical resolver command.
    const resolverCmds = commands.filter((c) => c.startsWith('git -C '));
    expect(resolverCmds.length).toBe(2);
    expect(new Set(resolverCmds).size).toBe(1);
  });

  it('nested work folder: what an older compose left under the exact-folder key is cleaned up (own entry + legacy), another member\'s entry is kept', async () => {
    const folderKey = normalizeProjectKey(nested);
    const agent = agentFor(nested);
    const other = { type: 'http', url: 'http://localhost:7523/mcp?member=someone-else' };
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
      projects: {
        [folderKey]: { mcpServers: { [MEMBER_MCP_SERVER_NAME]: { type: 'http', url: memberMcpUrl(agent) }, 'apra-fleet-member': { type: 'http', url: 'x' }, deepwiki: { type: 'http', url: 'd' } } },
      },
    }));
    const m = localMember();
    // Removal (url null), as for a local member: the resolved key has no entry,
    // only the exact-folder spelling does.
    await new ClaudeProvider().syncMemberMcpEntry({
      agent, execCommand: m.exec, memberHomeDir: home, agentOs, shell: (agent as any).shell, transport: m.transport, url: null, removeOnlyOwnEntry: true,
    } as any);
    let config = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    expect(config.projects[folderKey].mcpServers).toEqual({ deepwiki: { type: 'http', url: 'd' } });

    // Someone else's apra-fleet entry under that spelling is never touched.
    config.projects[folderKey].mcpServers[MEMBER_MCP_SERVER_NAME] = other;
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(config));
    await new ClaudeProvider().syncMemberMcpEntry({
      agent, execCommand: m.exec, memberHomeDir: home, agentOs, shell: (agent as any).shell, transport: m.transport, url: null, removeOnlyOwnEntry: true,
    } as any);
    config = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    expect(config.projects[folderKey].mcpServers[MEMBER_MCP_SERVER_NAME]).toEqual(other);
    fs.rmSync(path.join(home, '.claude.json'), { force: true });
  });

  it('non-git work folder: the exact folder is the key, for the writer and the probe', async () => {
    fs.rmSync(path.join(home, '.claude.json'), { force: true });
    const { config, url, probed } = await sync(plain);
    const key = normalizeProjectKey(plain);
    expect(Object.keys(config.projects)).toEqual([key]);
    expect(config.projects[key].mcpServers[MEMBER_MCP_SERVER_NAME].url).toBe(url);
    expect(probed).toBe(url);
  });

  it('cleanup', () => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    expect(fs.existsSync(tmpRoot)).toBe(false);
  });
});
