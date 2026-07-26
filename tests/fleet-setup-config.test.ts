import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  loadConfig,
  resolveMemberConfigs,
  bdCheckFor,
  doltCheckFor,
  call,
  toyFolderPath,
  deleteFolderCommand,
  cloneAndInitCommand,
  toyRepoUrlFor,
  claudeProjectSlug,
  geminiProjectName,
  collectTranscriptScript,
} from '../.github/e2e/fleet-setup.mjs';

const REPO_ROOT = path.join(process.cwd());

describe('fleet-setup.mjs config resolution', () => {
  it('loads suites.json and members.json', () => {
    const { suites, members } = loadConfig(REPO_ROOT);
    expect(suites.suites).toBeTruthy();
    expect(members.toy_projects).toBeTruthy();
  });

  it('resolves a remote suite (s1) to doer/reviewer with host/username/folder', () => {
    const config = loadConfig(REPO_ROOT);
    const resolved = resolveMemberConfigs('s1', config);

    expect(resolved.doer).toMatchObject({
      name: 'alice',
      tags: ['doer'],
      type: 'remote',
      provider: 'claude',
      host: '192.168.1.102',
      username: 'akhil',
      folder: '/home/akhil/git/apra-fleet-e2e',
      os: 'linux',
    });
    expect(resolved.reviewer).toMatchObject({
      name: 'bella',
      tags: ['reviewer'],
      type: 'remote',
      provider: 'claude',
      host: '192.168.1.13',
      username: 'akhil',
      folder: '/Users/akhil/git/apra-fleet-e2e',
      os: 'macos',
    });
  });

  it('resolves a local suite (s1.2) to local-role-specific members.json keys', () => {
    const config = loadConfig(REPO_ROOT);
    const resolved = resolveMemberConfigs('s1.2', config);

    expect(resolved.doer.type).toBe('local');
    expect(resolved.doer.host).toBe('local');
    expect(resolved.doer.username).toBeUndefined();
    expect(resolved.doer.folder).toBe('/home/akhil/git/apra-fleet-e2e-doer');
    expect(resolved.doer.os).toBe('linux');

    expect(resolved.reviewer.type).toBe('local');
    expect(resolved.reviewer.folder).toBe('/home/akhil/git/apra-fleet-e2e-rev');
    expect(resolved.reviewer.os).toBe('linux');
    // doer and reviewer must never collide on the same local folder
    expect(resolved.doer.folder).not.toBe(resolved.reviewer.folder);
  });

  it('resolves a local windows suite (s1.1) os as "windows", not the "local_doer_windows" raw key', () => {
    const config = loadConfig(REPO_ROOT);
    const resolved = resolveMemberConfigs('s1.1', config);
    expect(resolved.doer.os).toBe('windows');
    expect(resolved.reviewer.os).toBe('windows');
  });

  it('carries each role\'s own llm_provider through, even when it differs from the PM\'s', () => {
    const config = loadConfig(REPO_ROOT);
    const resolved = resolveMemberConfigs('s2', config); // pm=claude, doer/reviewer=agy
    expect(resolved.doer.provider).toBe('agy');
    expect(resolved.reviewer.provider).toBe('agy');
  });

  it('throws a clear error for an unknown suite id', () => {
    const config = loadConfig(REPO_ROOT);
    expect(() => resolveMemberConfigs('does-not-exist', config)).toThrow(/Unknown suite/);
  });
});

describe('fleet-setup.mjs bd/dolt check command selection', () => {
  // execute_command runs the literal string through the member's native
  // shell with no translation -- bash's `||`/`$(...)` syntax is rejected by
  // Windows PowerShell 5.1 ("The token '||' is not a valid statement
  // separator"), so windows members need their own PowerShell command.
  it('uses bash-syntax commands for linux and macos', () => {
    for (const os of ['linux', 'macos']) {
      expect(bdCheckFor(os)).toMatch(/^which bd \|\|/);
      expect(doltCheckFor(os)).toMatch(/^which dolt \|\|/);
      expect(doltCheckFor(os)).not.toContain('Get-Command');
    }
  });

  it('uses PowerShell-syntax commands for windows', () => {
    expect(bdCheckFor('windows')).toMatch(/^if \(Get-Command bd/);
    expect(bdCheckFor('windows')).not.toContain('||');
    expect(doltCheckFor('windows')).toMatch(/^if \(Get-Command dolt/);
    expect(doltCheckFor('windows')).not.toContain('||');
    expect(doltCheckFor('windows')).not.toContain('$(');
  });
});

describe('fleet-setup.mjs teardown toy-folder wipe', () => {
  it('joins with a backslash for windows, forward slash otherwise', () => {
    expect(toyFolderPath('C:\\Users\\akhil\\git\\apra-fleet-e2e-doer', 'windows')).toBe(
      'C:\\Users\\akhil\\git\\apra-fleet-e2e-doer\\fleet-e2e-toy',
    );
    expect(toyFolderPath('/home/akhil/git/apra-fleet-e2e-doer', 'linux')).toBe(
      '/home/akhil/git/apra-fleet-e2e-doer/fleet-e2e-toy',
    );
    expect(toyFolderPath('/Users/akhil/git/apra-fleet-e2e-rev', 'macos')).toBe(
      '/Users/akhil/git/apra-fleet-e2e-rev/fleet-e2e-toy',
    );
  });

  it('uses PowerShell Remove-Item for windows, rm -rf otherwise', () => {
    expect(deleteFolderCommand('C:\\path\\fleet-e2e-toy', 'windows')).toBe(
      'Remove-Item -Recurse -Force -ErrorAction SilentlyContinue "C:\\path\\fleet-e2e-toy"',
    );
    expect(deleteFolderCommand('/home/akhil/fleet-e2e-toy', 'linux')).toBe(
      'rm -rf "/home/akhil/fleet-e2e-toy"',
    );
  });
});

describe('fleet-setup.mjs toy repo bootstrap (clone + bd init)', () => {
  it('resolves the toy repo URL for a known vcs', () => {
    const { members } = loadConfig();
    expect(toyRepoUrlFor('github', members)).toBe('https://github.com/Apra-Labs/fleet-e2e-toy');
  });

  it('throws a clear error for an unknown vcs', () => {
    const { members } = loadConfig();
    expect(() => toyRepoUrlFor('does-not-exist', members)).toThrow(/toy_projects has no entry/);
  });

  it('uses PowerShell Test-Path guards for windows', () => {
    const cmd = cloneAndInitCommand('https://github.com/x/y', 'C:\\work\\fleet-e2e-toy', 'windows');
    expect(cmd).toContain('Test-Path "C:\\work\\fleet-e2e-toy\\.git"');
    expect(cmd).toContain('Test-Path ".beads\\embeddeddolt"');
    expect(cmd).toContain('git clone https://github.com/x/y "C:\\work\\fleet-e2e-toy"');
    expect(cmd).not.toContain('&&');
  });

  it('uses bash -d guards for linux/macos', () => {
    for (const os of ['linux', 'macos']) {
      const cmd = cloneAndInitCommand('https://github.com/x/y', '/work/fleet-e2e-toy', os);
      expect(cmd).toContain('[ -d "/work/fleet-e2e-toy/.git" ]');
      expect(cmd).toContain('[ -d ".beads/embeddeddolt" ]');
      expect(cmd).toContain('git clone https://github.com/x/y "/work/fleet-e2e-toy"');
      expect(cmd).not.toContain('Test-Path');
    }
  });
});

describe('fleet-setup.mjs deterministic session-log collection', () => {
  describe('claudeProjectSlug', () => {
    it('replaces every non-alphanumeric character, not just path separators', () => {
      expect(claudeProjectSlug('/home/user/fleet-work')).toBe('-home-user-fleet-work');
      expect(claudeProjectSlug('C:\\Users\\test\\workspace')).toBe('C--Users-test-workspace');
    });
  });

  describe('geminiProjectName', () => {
    it('takes the final path segment across both separator styles', () => {
      expect(geminiProjectName('/home/user/my-project')).toBe('my-project');
      expect(geminiProjectName('C:\\Users\\test\\workspace')).toBe('workspace');
    });

    it('falls back to "project" for an empty/root path', () => {
      expect(geminiProjectName('/')).toBe('project');
    });
  });

  describe('collectTranscriptScript', () => {
    it('claude: locates by exact project slug + session id under ~/.claude/projects', () => {
      const script = collectTranscriptScript('claude', '/home/user/fleet-work', 'sess-123');
      expect(script).toContain('.claude');
      expect(script).toContain('projects');
      expect(script).toContain('-home-user-fleet-work');
      expect(script).toContain('sess-123');
      expect(script).toContain('copyFileSync');
    });

    it('gemini: locates by project basename + exact session id under ~/.gemini/tmp/<project>/chats', () => {
      const script = collectTranscriptScript('gemini', '/home/user/my-project', 'session-789-ghi');
      expect(script).toContain('.gemini');
      expect(script).toContain('tmp');
      expect(script).toContain('chats');
      expect(script).toContain('my-project');
      expect(script).toContain('session-789-ghi');
    });

    it('agy: looks up by work folder via last_conversations.json, not by the fleet-tracked session id', () => {
      const script = collectTranscriptScript('agy', '/home/user/fleet-work', 'sess-should-not-be-used-for-lookup');
      expect(script).toContain('last_conversations.json');
      expect(script).toContain('antigravity-cli');
      expect(script).toContain('/home/user/fleet-work');
      // the fleet-tracked session id plays no role in agy's own lookup
      expect(script).not.toContain('sess-should-not-be-used-for-lookup');
    });

    it('returns null for providers with no known flat-file transcript', () => {
      for (const provider of ['opencode', 'codex', 'copilot']) {
        expect(collectTranscriptScript(provider, '/home/user/x', 'sess-1')).toBeNull();
      }
    });
  });
});

describe('fleet-setup.mjs call() failure detection', () => {
  // The MCP SDK's own tool dispatch wraps a thrown handler exception as
  // { content, isError: true } (node_modules/@modelcontextprotocol/sdk's
  // McpServer.createToolError()) -- this resolves the request, it does not
  // reject it. Text-only FAIL_MARK sniffing misses that case entirely.
  it('throws when result.isError is true, even with no FAIL_MARK-prefixed text', async () => {
    const fn = async () => ({ content: [{ text: 'Internal error: something broke' }], isError: true });
    await expect(call(fn, {}, 'some_tool')).rejects.toThrow(/some_tool failed/);
  });

  it('throws when the text starts with the FAIL_MARK, even with isError unset', async () => {
    const fn = async () => ({ content: [{ text: '❌ Member not found' }] });
    await expect(call(fn, {}, 'some_tool')).rejects.toThrow(/some_tool failed/);
  });

  it('resolves normally when neither isError nor FAIL_MARK is present', async () => {
    const fn = async () => ({ content: [{ text: 'Member registered successfully' }] });
    const { text } = await call(fn, {}, 'some_tool');
    expect(text).toBe('Member registered successfully');
  });
});
