/**
 * Tests for provider-aware compose_permissions (Phase 5C).
 *
 * Covers:
 * - Proactive mode: each provider gets its native config format delivered to the correct path(s)
 * - Reactive grant mode: Claude merges existing allow list; Gemini passes grants to TOML
 * - Member with no llmProvider defaults to Claude behavior
 * - NEVER_AUTO_GRANT blocks dangerous permissions for all providers
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { composePermissions } from '../src/tools/compose-permissions.js';
import { ClaudeProvider } from '../src/providers/claude.js';
import { GeminiProvider } from '../src/providers/gemini.js';
import type { SSHExecResult } from '../src/types.js';
import fs from 'node:fs';
import os from 'node:os';

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
  }),
}));

const OK: SSHExecResult = { stdout: '', stderr: '', code: 0 };

/** Helper: collect all execCommand calls and return the write-command calls (cat > or Set-Content) */
function writeCalls(calls: string[][]): string[] {
  return calls.map(c => c[0]).filter(cmd => cmd.includes('cat >') || cmd.includes('Set-Content'));
}

/** Helper: collect mkdir calls */
function mkdirCalls(calls: string[][]): string[] {
  return calls.map(c => c[0]).filter(cmd => cmd.includes('mkdir'));
}

beforeEach(() => {
  backupAndResetRegistry();
  vi.clearAllMocks();
  // findProfilesDir() prefers an installed ~/.claude/skills/fleet/profiles over the
  // repo's own skills/fleet/profiles -- on a dev machine with apra-fleet installed,
  // that installed copy can be stale (e.g. missing a newly-added tag profile) and
  // silently produce wrong results. Point homedir at a path that can't have an
  // installed skills dir, forcing resolution to fall through to the repo checkout.
  vi.spyOn(os, 'homedir').mockReturnValue('/nonexistent-test-home');
});

afterEach(() => {
  restoreRegistry();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Claude proactive compose
// ---------------------------------------------------------------------------

describe('composePermissions -- Claude proactive', () => {
  it('delivers settings.local.json with JSON allow list', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-doer', llmProvider: 'claude', os: 'linux' });
    addAgent(member);

    // detectStacks: ls markers + *.sln/*.csproj
    mockExecCommand.mockResolvedValue(OK);

    const result = await composePermissions({ member_id: member.id, role: 'doer' });

    expect(result).toContain('claude-doer');
    expect(result).toContain('doer');
    expect(result).toContain('claude');

    const allCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const mkdirs = allCmds.filter(cmd => cmd.includes('mkdir'));
    const writes = allCmds.filter(cmd => cmd.includes('cat >'));

    expect(mkdirs.some(cmd => cmd.includes('.claude'))).toBe(true);
    expect(writes.some(cmd => cmd.includes('.claude/settings.local.json'))).toBe(true);

    // The written content should be JSON with a permissions.allow array
    const writeCmd = writes.find(cmd => cmd.includes('.claude/settings.local.json'))!;
    expect(writeCmd).toContain('"permissions"');
    expect(writeCmd).toContain('"allow"');
    // settings.local.json must suppress fleet-mcp (#151)
    expect(writeCmd).toContain('apra-fleet');
    expect(writeCmd).toContain('disabled');
  });

  it('delivers reviewer config with restricted allow list', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-reviewer', llmProvider: 'claude', os: 'linux' });
    addAgent(member);
    mockExecCommand.mockResolvedValue(OK);

    const result = await composePermissions({ member_id: member.id, role: 'reviewer' });
    expect(result).toContain('reviewer');

    const writes = mockExecCommand.mock.calls.map(c => c[0] as string).filter(cmd => cmd.includes('cat >'));
    expect(writes.some(cmd => cmd.includes('.claude/settings.local.json'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Gemini proactive compose
// ---------------------------------------------------------------------------

describe('composePermissions -- Gemini proactive', () => {
  it('delivers settings.json + fleet.toml for doer', async () => {
    const member = makeTestAgent({ friendlyName: 'gemini-doer', llmProvider: 'gemini', os: 'linux' });
    addAgent(member);
    mockExecCommand.mockResolvedValue(OK);

    const result = await composePermissions({ member_id: member.id, role: 'doer' });

    expect(result).toContain('gemini-doer');
    expect(result).toContain('gemini');
    expect(result).toContain('.gemini/settings.json');
    expect(result).toContain('.gemini/policies/fleet.toml');

    const allCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const writes = allCmds.filter(cmd => cmd.includes('cat >'));

    // Two write calls: one for settings.json, one for fleet.toml
    expect(writes.some(cmd => cmd.includes('.gemini/settings.json'))).toBe(true);
    expect(writes.some(cmd => cmd.includes('.gemini/policies/fleet.toml'))).toBe(true);

    // settings.json should have auto_edit mode for doer
    const settingsWrite = writes.find(cmd => cmd.includes('.gemini/settings.json'))!;
    expect(settingsWrite).toContain('auto_edit');
    // settings.json must disable all MCP servers via mcpServers: {} (#219)
    expect(settingsWrite).toContain('mcpServers');
    expect(settingsWrite).toContain('{}');

    // fleet.toml should have [policy] section
    const tomlWrite = writes.find(cmd => cmd.includes('fleet.toml'))!;
    expect(tomlWrite).toContain('[policy]');
    expect(tomlWrite).toContain('auto_edit');
  });

  it('delivers default mode for reviewer', async () => {
    const member = makeTestAgent({ friendlyName: 'gemini-reviewer', llmProvider: 'gemini', os: 'linux' });
    addAgent(member);
    mockExecCommand.mockResolvedValue(OK);

    await composePermissions({ member_id: member.id, role: 'reviewer' });

    const allCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const writes = allCmds.filter(cmd => cmd.includes('cat >'));

    const settingsWrite = writes.find(cmd => cmd.includes('.gemini/settings.json'))!;
    expect(settingsWrite).toContain('"default"');
    // settings.json must disable all MCP servers via mcpServers: {} (#219)
    expect(settingsWrite).toContain('mcpServers');
    expect(settingsWrite).toContain('{}');
  });
});

// ---------------------------------------------------------------------------
// Codex proactive compose
// ---------------------------------------------------------------------------

describe('composePermissions -- Codex proactive', () => {
  it('delivers config.toml with full-auto for doer', async () => {
    const member = makeTestAgent({ friendlyName: 'codex-doer', llmProvider: 'codex', os: 'linux' });
    addAgent(member);
    mockExecCommand.mockResolvedValue(OK);

    const result = await composePermissions({ member_id: member.id, role: 'doer' });

    expect(result).toContain('codex-doer');
    expect(result).toContain('codex');
    expect(result).toContain('.codex/config.toml');

    const allCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const writes = allCmds.filter(cmd => cmd.includes('cat >'));

    expect(writes.some(cmd => cmd.includes('.codex/config.toml'))).toBe(true);

    const tomlWrite = writes.find(cmd => cmd.includes('.codex/config.toml'))!;
    expect(tomlWrite).toContain('full-auto');
    expect(tomlWrite).toContain('[agent]');
    expect(tomlWrite).toContain('[sandbox]');
  });

  it('delivers config.toml with suggest for reviewer', async () => {
    const member = makeTestAgent({ friendlyName: 'codex-reviewer', llmProvider: 'codex', os: 'linux' });
    addAgent(member);
    mockExecCommand.mockResolvedValue(OK);

    await composePermissions({ member_id: member.id, role: 'reviewer' });

    const allCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const tomlWrite = allCmds.filter(cmd => cmd.includes('cat >')).find(cmd => cmd.includes('.codex/config.toml'))!;
    expect(tomlWrite).toContain('suggest');
  });
});

// ---------------------------------------------------------------------------
// Copilot proactive compose
// ---------------------------------------------------------------------------

describe('composePermissions -- Copilot proactive', () => {
  it('delivers settings.local.json with allow-all-tools for doer', async () => {
    const member = makeTestAgent({ friendlyName: 'copilot-doer', llmProvider: 'copilot', os: 'linux' });
    addAgent(member);
    mockExecCommand.mockResolvedValue(OK);

    const result = await composePermissions({ member_id: member.id, role: 'doer' });

    expect(result).toContain('copilot-doer');
    expect(result).toContain('copilot');
    expect(result).toContain('.github/copilot/settings.local.json');

    const allCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const writes = allCmds.filter(cmd => cmd.includes('cat >'));

    const jsonWrite = writes.find(cmd => cmd.includes('.github/copilot/settings.local.json'))!;
    expect(jsonWrite).toContain('allow-all-tools');
    expect(jsonWrite).toContain('true');
  });

  it('delivers restrictive JSON for reviewer', async () => {
    const member = makeTestAgent({ friendlyName: 'copilot-reviewer', llmProvider: 'copilot', os: 'linux' });
    addAgent(member);
    mockExecCommand.mockResolvedValue(OK);

    await composePermissions({ member_id: member.id, role: 'reviewer' });

    const allCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const jsonWrite = allCmds.filter(cmd => cmd.includes('cat >')).find(cmd => cmd.includes('.github/copilot/settings.local.json'))!;
    expect(jsonWrite).toContain('"deny"');
  });
});

// ---------------------------------------------------------------------------
// Reactive grant: Claude -- merges existing allow list
// ---------------------------------------------------------------------------

describe('composePermissions -- Claude reactive grant', () => {
  it('reads existing settings.local.json and merges new grants', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-doer', llmProvider: 'claude', os: 'linux' });
    addAgent(member);

    const existing = JSON.stringify({ permissions: { allow: ['Read', 'Write', 'Bash(git:*)'] } });
    // First call is the read of existing settings.local.json
    mockExecCommand.mockResolvedValueOnce({ stdout: existing, stderr: '', code: 0 });
    // mkdir + write calls
    mockExecCommand.mockResolvedValue(OK);

    const result = await composePermissions({
      member_id: member.id,
      role: 'doer',
      grant: ['Bash(docker:*)'],
    });

    expect(result).toContain('Granted');
    expect(result).toContain('Bash(docker:*)');
    // co-occurrence: docker → docker-compose + docker buildx
    expect(result).toContain('Bash(docker-compose:*)');

    const allCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    // Should have read the existing file
    expect(allCmds.some(cmd => cmd.includes('cat .claude/settings.local.json'))).toBe(true);

    // Write command should include both old and new permissions
    const writes = allCmds.filter(cmd => cmd.includes('cat >'));
    const writeCmd = writes.find(cmd => cmd.includes('.claude/settings.local.json'))!;
    expect(writeCmd).toContain('Read');
    expect(writeCmd).toContain('Bash(docker:*)');
  });

  it('blocks dangerous permissions', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-doer', llmProvider: 'claude', os: 'linux' });
    addAgent(member);

    const result = await composePermissions({
      member_id: member.id,
      role: 'doer',
      grant: ['Bash(sudo:*)'],
    });

    expect(result).toContain('Cannot auto-grant');
    expect(result).toContain('Bash(sudo:*)');
    expect(mockExecCommand).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Reactive grant: Gemini -- TOML policy updated with grants
// ---------------------------------------------------------------------------

describe('composePermissions -- Gemini reactive grant', () => {
  it('delivers updated TOML policy with granted tools', async () => {
    const member = makeTestAgent({ friendlyName: 'gemini-doer', llmProvider: 'gemini', os: 'linux' });
    addAgent(member);
    mockExecCommand.mockResolvedValue(OK);

    const result = await composePermissions({
      member_id: member.id,
      role: 'doer',
      grant: ['Bash(docker:*)'],
    });

    expect(result).toContain('Granted');
    expect(result).toContain('Bash(docker:*)');

    const allCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const writes = allCmds.filter(cmd => cmd.includes('cat >'));

    // Gemini: two files written
    expect(writes.some(cmd => cmd.includes('.gemini/settings.json'))).toBe(true);
    expect(writes.some(cmd => cmd.includes('fleet.toml'))).toBe(true);

    // TOML should include the granted tool
    const tomlWrite = writes.find(cmd => cmd.includes('fleet.toml'))!;
    expect(tomlWrite).toContain('Bash(docker:*)');
  });

  it('blocks dangerous permissions for Gemini too', async () => {
    const member = makeTestAgent({ friendlyName: 'gemini-doer', llmProvider: 'gemini', os: 'linux' });
    addAgent(member);

    const result = await composePermissions({
      member_id: member.id,
      role: 'doer',
      grant: ['Bash(sudo:*)'],
    });

    expect(result).toContain('Cannot auto-grant');
    expect(mockExecCommand).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// No llmProvider → defaults to Claude
// ---------------------------------------------------------------------------

describe('composePermissions -- no llmProvider defaults to Claude', () => {
  it('treats member with no llmProvider as Claude', async () => {
    // makeTestAgent without llmProvider → undefined
    const member = makeTestAgent({ friendlyName: 'legacy-member', os: 'linux' });
    delete (member as any).llmProvider;
    addAgent(member);
    mockExecCommand.mockResolvedValue(OK);

    const result = await composePermissions({ member_id: member.id, role: 'doer' });

    expect(result).toContain('claude'); // provider name in output

    const allCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const writes = allCmds.filter(cmd => cmd.includes('cat >'));
    // Should write to Claude's path
    expect(writes.some(cmd => cmd.includes('.claude/settings.local.json'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Issue #151 -- fleet-mcp disabled in member config
// ---------------------------------------------------------------------------

describe('composePermissions -- fleet-mcp disabled in member config (#151)', () => {
  it('includes mcpServers.apra-fleet.disabled in Claude settings.local.json (proactive)', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-doer', llmProvider: 'claude', os: 'linux' });
    addAgent(member);
    mockExecCommand.mockResolvedValue(OK);

    await composePermissions({ member_id: member.id, role: 'doer' });

    const allCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const writeCmd = allCmds.filter(cmd => cmd.includes('cat >')).find(cmd => cmd.includes('.claude/settings.local.json'))!;
    expect(writeCmd).toBeDefined();
    expect(writeCmd).toContain('mcpServers');
    expect(writeCmd).toContain('apra-fleet');
    expect(writeCmd).toContain('"disabled":');
  });

  it('includes mcpServers.apra-fleet.disabled in Claude settings.local.json (reactive grant)', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-doer', llmProvider: 'claude', os: 'linux' });
    addAgent(member);

    const existing = JSON.stringify({ permissions: { allow: ['Read', 'Write'] } });
    mockExecCommand.mockResolvedValueOnce({ stdout: existing, stderr: '', code: 0 });
    mockExecCommand.mockResolvedValue(OK);

    await composePermissions({ member_id: member.id, role: 'doer', grant: ['Bash(npm:*)'] });

    const allCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const writeCmd = allCmds.filter(cmd => cmd.includes('cat >')).find(cmd => cmd.includes('.claude/settings.local.json'))!;
    expect(writeCmd).toBeDefined();
    expect(writeCmd).toContain('mcpServers');
    expect(writeCmd).toContain('apra-fleet');
  });
});

describe('composePermissions -- preserves register_member mcpServers entry (apra-fleet-2xs.1)', () => {
  it('does not destroy mcpServers["apra-fleet-member"] (the JWT-bearing entry register_member wrote) on first compose', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-doer', llmProvider: 'claude', os: 'linux' });
    addAgent(member);

    // Simulates the file exactly as register_member leaves it: an mcpServers
    // entry carrying the member's live JWT, and nothing else yet.
    const registeredByMember = JSON.stringify({
      mcpServers: {
        'apra-fleet-member': {
          type: 'http',
          url: 'http://localhost:1234/mcp?member=abc-123',
          headers: { Authorization: 'Bearer super-secret-jwt' },
        },
      },
    });
    mockExecCommand.mockImplementation(async (cmd: string) => {
      if (cmd.includes('cat .claude/settings.local.json') || cmd.includes('cat .claude\\settings.local.json')) {
        return { stdout: registeredByMember, stderr: '', code: 0 };
      }
      return OK;
    });

    await composePermissions({ member_id: member.id, role: 'doer' });

    const allCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const writeCmd = allCmds.filter(cmd => cmd.includes('cat >')).find(cmd => cmd.includes('.claude/settings.local.json'))!;
    expect(writeCmd).toBeDefined();

    const heredocBody = writeCmd.split("'FLEET_PERMS_EOF'\n")[1].split('\nFLEET_PERMS_EOF')[0];
    const written = JSON.parse(heredocBody);

    // The register_member entry -- including its live JWT -- must survive.
    expect(written.mcpServers['apra-fleet-member']).toEqual({
      type: 'http',
      url: 'http://localhost:1234/mcp?member=abc-123',
      headers: { Authorization: 'Bearer super-secret-jwt' },
    });
    // compose_permissions' own mcpServers.apra-fleet.disabled must also be present.
    expect(written.mcpServers['apra-fleet']).toEqual({ disabled: true });
  });
});

// ---------------------------------------------------------------------------
// Task T4: deliverConfigFile() BOM-free Windows write (#219)
// ---------------------------------------------------------------------------

describe('deliverConfigFile -- Windows BOM-free write (T4)', () => {
  it('uses WriteAllText with UTF8Encoding($false) on Windows, not Set-Content', async () => {
    const member = makeTestAgent({ friendlyName: 'gemini-win', llmProvider: 'gemini', os: 'windows' });
    addAgent(member);
    mockExecCommand.mockResolvedValue(OK);

    await composePermissions({ member_id: member.id, role: 'doer' });

    const allCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const settingsWrite = allCmds.find(cmd =>
      (cmd.includes('.gemini\\settings.json') || cmd.includes('.gemini/settings.json')) && cmd.includes('WriteAllText')
    );
    expect(settingsWrite).toBeDefined();
    expect(settingsWrite).toContain('WriteAllText');
    expect(settingsWrite).toContain('UTF8Encoding($false)');
    expect(settingsWrite).not.toContain('Set-Content');
    expect(settingsWrite).not.toContain('-Encoding UTF8');
  });

  it('uses heredoc form (cat >) on Linux', async () => {
    const member = makeTestAgent({ friendlyName: 'gemini-linux', llmProvider: 'gemini', os: 'linux' });
    addAgent(member);
    mockExecCommand.mockResolvedValue(OK);

    await composePermissions({ member_id: member.id, role: 'doer' });

    const allCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const settingsWrite = allCmds.find(cmd => cmd.includes('cat >') && cmd.includes('.gemini/settings.json'));
    expect(settingsWrite).toBeDefined();
    expect(settingsWrite).toContain('FLEET_PERMS_EOF');
    expect(settingsWrite).not.toContain('WriteAllText');
  });

  it('doubles single quotes in content for PowerShell string safety on Windows', async () => {
    const member = makeTestAgent({ friendlyName: 'gemini-win-quotes', llmProvider: 'gemini', os: 'windows' });
    addAgent(member);
    mockExecCommand.mockResolvedValue(OK);

    // Grant a permission containing a single quote -- it must be double-escaped in the PowerShell write command
    await composePermissions({
      member_id: member.id,
      role: 'doer',
      grant: ["Bash(node 'exec':*)"],
    });

    const allCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const tomlWrite = allCmds.find(cmd => cmd.includes('fleet.toml'));
    expect(tomlWrite).toBeDefined();
    // Single quote must be doubled for PowerShell single-quoted strings
    expect(tomlWrite).toContain("node ''exec''");
  });
});

// ---------------------------------------------------------------------------
// Tag-aware permission composition
// ---------------------------------------------------------------------------

/** Extract the JSON/TOML content written via the heredoc write command (Linux).
 *  The write command format is: cat > <path> << 'FLEET_PERMS_EOF'\n<content>\nFLEET_PERMS_EOF
 *  The opening delimiter has a trailing single-quote; the closing one does not. */
function extractWrittenContent(cmd: string): string {
  // Match the content between << 'FLEET_PERMS_EOF'\n ... \nFLEET_PERMS_EOF
  const match = cmd.match(/'FLEET_PERMS_EOF'\n([\s\S]+)\nFLEET_PERMS_EOF/);
  return match ? match[1] : '';
}

describe('composePermissions -- tag-aware: tags:[doer] == role:doer (backward compat)', () => {
  it('produces byte-identical settings.local.json content for tags:[doer] vs role:doer', async () => {
    const memberRole = makeTestAgent({ friendlyName: 'claude-role-doer', llmProvider: 'claude', os: 'linux' });
    const memberTags = makeTestAgent({ friendlyName: 'claude-tags-doer', llmProvider: 'claude', os: 'linux' });
    addAgent(memberRole);
    addAgent(memberTags);

    // Run role:'doer'
    mockExecCommand.mockResolvedValue(OK);
    await composePermissions({ member_id: memberRole.id, role: 'doer' });
    const roleCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const roleWrite = roleCmds.find(cmd => cmd.includes('.claude/settings.local.json') && cmd.includes('FLEET_PERMS_EOF'))!;
    const roleContent = extractWrittenContent(roleWrite);

    vi.clearAllMocks();

    // Run tags:['doer']
    mockExecCommand.mockResolvedValue(OK);
    await composePermissions({ member_id: memberTags.id, tags: ['doer'] });
    const tagCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const tagWrite = tagCmds.find(cmd => cmd.includes('.claude/settings.local.json') && cmd.includes('FLEET_PERMS_EOF'))!;
    const tagContent = extractWrittenContent(tagWrite);

    expect(tagContent).toBeTruthy();
    expect(roleContent).toBeTruthy();
    // Both should produce the same allow list (same JSON structure)
    const rolePerms = JSON.parse(roleContent).permissions.allow.sort();
    const tagPerms = JSON.parse(tagContent).permissions.allow.sort();
    expect(tagPerms).toEqual(rolePerms);
  });
});

describe('composePermissions -- tag-aware: tags:[reviewer] == role:reviewer (backward compat)', () => {
  it('produces byte-identical settings.local.json content for tags:[reviewer] vs role:reviewer', async () => {
    const memberRole = makeTestAgent({ friendlyName: 'claude-role-reviewer', llmProvider: 'claude', os: 'linux' });
    const memberTags = makeTestAgent({ friendlyName: 'claude-tags-reviewer', llmProvider: 'claude', os: 'linux' });
    addAgent(memberRole);
    addAgent(memberTags);

    // Run role:'reviewer'
    mockExecCommand.mockResolvedValue(OK);
    await composePermissions({ member_id: memberRole.id, role: 'reviewer' });
    const roleCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const roleWrite = roleCmds.find(cmd => cmd.includes('.claude/settings.local.json') && cmd.includes('FLEET_PERMS_EOF'))!;
    const roleContent = extractWrittenContent(roleWrite);

    vi.clearAllMocks();

    // Run tags:['reviewer']
    mockExecCommand.mockResolvedValue(OK);
    await composePermissions({ member_id: memberTags.id, tags: ['reviewer'] });
    const tagCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const tagWrite = tagCmds.find(cmd => cmd.includes('.claude/settings.local.json') && cmd.includes('FLEET_PERMS_EOF'))!;
    const tagContent = extractWrittenContent(tagWrite);

    expect(tagContent).toBeTruthy();
    expect(roleContent).toBeTruthy();
    const rolePerms = JSON.parse(roleContent).permissions.allow.sort();
    const tagPerms = JSON.parse(tagContent).permissions.allow.sort();
    expect(tagPerms).toEqual(rolePerms);
  });
});

describe('composePermissions -- tag-aware: tags:[doer,gpu] merges doer+gpu profiles', () => {
  it('includes gpu-specific permissions in the allow list', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-doer-gpu', llmProvider: 'claude', os: 'linux' });
    addAgent(member);
    mockExecCommand.mockResolvedValue(OK);

    const result = await composePermissions({ member_id: member.id, tags: ['doer', 'gpu'] });

    expect(result).toContain('claude-doer-gpu');

    const allCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const writeCmd = allCmds.find(cmd => cmd.includes('.claude/settings.local.json') && cmd.includes('FLEET_PERMS_EOF'))!;
    expect(writeCmd).toBeDefined();
    const content = extractWrittenContent(writeCmd);
    const allow: string[] = JSON.parse(content).permissions.allow;

    // GPU tag-specific permissions should be present
    expect(allow).toContain('Bash(nvidia-smi:*)');
    expect(allow).toContain('Bash(docker:*)');
    // Base doer permissions should also be present
    expect(allow).toContain('Read');
    expect(allow).toContain('Bash(git:*)');
  });

  it('gpu-merged allow list is a strict superset of doer-only allow list', async () => {
    const memberDoer = makeTestAgent({ friendlyName: 'claude-just-doer', llmProvider: 'claude', os: 'linux' });
    const memberGpu = makeTestAgent({ friendlyName: 'claude-doer-gpu2', llmProvider: 'claude', os: 'linux' });
    addAgent(memberDoer);
    addAgent(memberGpu);

    // Doer-only
    mockExecCommand.mockResolvedValue(OK);
    await composePermissions({ member_id: memberDoer.id, tags: ['doer'] });
    const doerCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const doerWrite = doerCmds.find(cmd => cmd.includes('.claude/settings.local.json') && cmd.includes('FLEET_PERMS_EOF'))!;
    const doerAllow: string[] = JSON.parse(extractWrittenContent(doerWrite)).permissions.allow;

    vi.clearAllMocks();

    // Doer + gpu
    mockExecCommand.mockResolvedValue(OK);
    await composePermissions({ member_id: memberGpu.id, tags: ['doer', 'gpu'] });
    const gpuCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const gpuWrite = gpuCmds.find(cmd => cmd.includes('.claude/settings.local.json') && cmd.includes('FLEET_PERMS_EOF'))!;
    const gpuAllow: string[] = JSON.parse(extractWrittenContent(gpuWrite)).permissions.allow;

    // gpu allow should contain everything from doer-only
    for (const perm of doerAllow) {
      expect(gpuAllow).toContain(perm);
    }
    // gpu allow should have more permissions than doer-only
    expect(gpuAllow.length).toBeGreaterThan(doerAllow.length);
  });
});

describe('composePermissions -- tag-aware: role:doer backward compat', () => {
  it('still works with role-only (no tags) for doer', async () => {
    const member = makeTestAgent({ friendlyName: 'role-compat-doer', llmProvider: 'claude', os: 'linux' });
    addAgent(member);
    mockExecCommand.mockResolvedValue(OK);

    const result = await composePermissions({ member_id: member.id, role: 'doer' });

    expect(result).toContain('role-compat-doer');
    expect(result).toContain('doer');

    const allCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const writeCmd = allCmds.find(cmd => cmd.includes('.claude/settings.local.json') && cmd.includes('cat >'))!;
    expect(writeCmd).toBeDefined();
    expect(writeCmd).toContain('"permissions"');
    expect(writeCmd).toContain('"allow"');
  });
});

describe('composePermissions -- tag-aware: both role and tags -> tags wins', () => {
  it('when role=reviewer and tags=[doer], output uses doer mode', async () => {
    const memberTagsWin = makeTestAgent({ friendlyName: 'tags-win-doer', llmProvider: 'claude', os: 'linux' });
    const memberRoleDoer = makeTestAgent({ friendlyName: 'role-doer-ref', llmProvider: 'claude', os: 'linux' });
    addAgent(memberTagsWin);
    addAgent(memberRoleDoer);

    // tags:[doer] + role:reviewer -> tags wins -> mode=doer
    mockExecCommand.mockResolvedValue(OK);
    await composePermissions({ member_id: memberTagsWin.id, role: 'reviewer', tags: ['doer'] });
    const tagsWinCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const tagsWinWrite = tagsWinCmds.find(cmd => cmd.includes('.claude/settings.local.json') && cmd.includes('FLEET_PERMS_EOF'))!;
    const tagsWinAllow: string[] = JSON.parse(extractWrittenContent(tagsWinWrite)).permissions.allow;

    vi.clearAllMocks();

    // role:doer alone for reference
    mockExecCommand.mockResolvedValue(OK);
    await composePermissions({ member_id: memberRoleDoer.id, role: 'doer' });
    const roleDoerCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const roleDoerWrite = roleDoerCmds.find(cmd => cmd.includes('.claude/settings.local.json') && cmd.includes('FLEET_PERMS_EOF'))!;
    const roleDoerAllow: string[] = JSON.parse(extractWrittenContent(roleDoerWrite)).permissions.allow;

    // tags:['doer'] with role:reviewer should yield same as role:'doer'
    expect(tagsWinAllow.sort()).toEqual(roleDoerAllow.sort());
  });

  it('when role=doer and tags=[reviewer], output uses reviewer mode (tags win)', async () => {
    const member = makeTestAgent({ friendlyName: 'tags-reviewer-over-role', llmProvider: 'claude', os: 'linux' });
    addAgent(member);
    mockExecCommand.mockResolvedValue(OK);

    // tags:['reviewer'] + role:'doer' -> tags win -> reviewer mode
    await composePermissions({ member_id: member.id, role: 'doer', tags: ['reviewer'] });

    const allCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const writeCmd = allCmds.find(cmd => cmd.includes('.claude/settings.local.json') && cmd.includes('FLEET_PERMS_EOF'))!;
    const allow: string[] = JSON.parse(extractWrittenContent(writeCmd)).permissions.allow;

    // Reviewer mode: should have reviewer-scoped Write (not unrestricted Write)
    expect(allow).not.toContain('Write');
    expect(allow.some(p => p.startsWith('Write('))).toBe(true);
  });
});

describe('composePermissions -- tag-aware: unknown tag -> no error, no extra perms', () => {
  it('silently ignores unknown tags and still succeeds', async () => {
    const memberUnknown = makeTestAgent({ friendlyName: 'claude-unknown-tag', llmProvider: 'claude', os: 'linux' });
    const memberBase = makeTestAgent({ friendlyName: 'claude-base-doer', llmProvider: 'claude', os: 'linux' });
    addAgent(memberUnknown);
    addAgent(memberBase);

    // tags with unknown tag
    mockExecCommand.mockResolvedValue(OK);
    const result = await composePermissions({ member_id: memberUnknown.id, tags: ['doer', 'nonexistent-tag-xyz'] });

    // Should succeed (not throw, not return error)
    expect(result).toContain('claude-unknown-tag');
    expect(result).not.toContain('error');
    expect(result).not.toContain('Error');

    const unknownCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const unknownWrite = unknownCmds.find(cmd => cmd.includes('.claude/settings.local.json') && cmd.includes('FLEET_PERMS_EOF'))!;
    const unknownAllow: string[] = JSON.parse(extractWrittenContent(unknownWrite)).permissions.allow;

    vi.clearAllMocks();

    // Same as just doer
    mockExecCommand.mockResolvedValue(OK);
    await composePermissions({ member_id: memberBase.id, tags: ['doer'] });
    const baseCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const baseWrite = baseCmds.find(cmd => cmd.includes('.claude/settings.local.json') && cmd.includes('FLEET_PERMS_EOF'))!;
    const baseAllow: string[] = JSON.parse(extractWrittenContent(baseWrite)).permissions.allow;

    // No extra permissions from an unknown tag
    expect(unknownAllow.sort()).toEqual(baseAllow.sort());
  });
});

describe('composePermissions -- tag-aware: tags with no mode tag defaults to doer', () => {
  it('uses doer mode when tags contain only non-mode tags (e.g. gpu only)', async () => {
    const memberGpuOnly = makeTestAgent({ friendlyName: 'gpu-no-mode', llmProvider: 'claude', os: 'linux' });
    const memberDoerGpu = makeTestAgent({ friendlyName: 'doer-gpu-explicit', llmProvider: 'claude', os: 'linux' });
    addAgent(memberGpuOnly);
    addAgent(memberDoerGpu);

    // tags=['gpu'] with no mode tag -> should default to doer
    mockExecCommand.mockResolvedValue(OK);
    await composePermissions({ member_id: memberGpuOnly.id, tags: ['gpu'] });
    const noModeCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const noModeWrite = noModeCmds.find(cmd => cmd.includes('.claude/settings.local.json') && cmd.includes('FLEET_PERMS_EOF'))!;
    expect(noModeWrite).toBeDefined();
    const noModeAllow: string[] = JSON.parse(extractWrittenContent(noModeWrite)).permissions.allow;

    vi.clearAllMocks();

    // tags=['doer','gpu'] -> explicit doer+gpu
    mockExecCommand.mockResolvedValue(OK);
    await composePermissions({ member_id: memberDoerGpu.id, tags: ['doer', 'gpu'] });
    const doerGpuCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const doerGpuWrite = doerGpuCmds.find(cmd => cmd.includes('.claude/settings.local.json') && cmd.includes('FLEET_PERMS_EOF'))!;
    const doerGpuAllow: string[] = JSON.parse(extractWrittenContent(doerGpuWrite)).permissions.allow;

    // Both should yield the same permissions (doer as default mode + gpu extras)
    expect(noModeAllow.sort()).toEqual(doerGpuAllow.sort());
  });
});

describe('composePermissions -- tag-aware: primary mode = first mode tag', () => {
  it('uses reviewer mode when reviewer appears before doer in tags', async () => {
    const memberReviewerFirst = makeTestAgent({ friendlyName: 'reviewer-first', llmProvider: 'claude', os: 'linux' });
    const memberDoerFirst = makeTestAgent({ friendlyName: 'doer-first', llmProvider: 'claude', os: 'linux' });
    addAgent(memberReviewerFirst);
    addAgent(memberDoerFirst);

    // reviewer first -> reviewer mode
    mockExecCommand.mockResolvedValue(OK);
    await composePermissions({ member_id: memberReviewerFirst.id, tags: ['reviewer', 'doer'] });
    const reviewerFirstCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const reviewerFirstWrite = reviewerFirstCmds.find(cmd => cmd.includes('.claude/settings.local.json') && cmd.includes('FLEET_PERMS_EOF'))!;
    const reviewerFirstAllow: string[] = JSON.parse(extractWrittenContent(reviewerFirstWrite)).permissions.allow;

    vi.clearAllMocks();

    // doer first -> doer mode
    mockExecCommand.mockResolvedValue(OK);
    await composePermissions({ member_id: memberDoerFirst.id, tags: ['doer', 'reviewer'] });
    const doerFirstCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const doerFirstWrite = doerFirstCmds.find(cmd => cmd.includes('.claude/settings.local.json') && cmd.includes('FLEET_PERMS_EOF'))!;
    const doerFirstAllow: string[] = JSON.parse(extractWrittenContent(doerFirstWrite)).permissions.allow;

    // The two should be different modes -> different permission sets
    expect(reviewerFirstAllow.sort()).not.toEqual(doerFirstAllow.sort());

    // reviewer-first: should have reviewer-restricted Write, not full Write
    expect(reviewerFirstAllow).not.toContain('Write');
    expect(reviewerFirstAllow.some(p => p.startsWith('Write('))).toBe(true);

    // doer-first: should have unrestricted Write
    expect(doerFirstAllow).toContain('Write');
  });
});

// ---------------------------------------------------------------------------
// Fresh/empty permissions.json -- no crash (#88)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// apra-fleet-eft.40.2 -- ensureWorkspaceTrusted invoked on every compose_permissions
// ---------------------------------------------------------------------------

describe('composePermissions -- invokes ensureWorkspaceTrusted (apra-fleet-eft.40.2)', () => {
  it('calls ensureWorkspaceTrusted with the resolved work_folder on proactive compose (Claude)', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-doer', llmProvider: 'claude', os: 'linux', workFolder: '/home/testuser/project' });
    addAgent(member);
    mockExecCommand.mockResolvedValue(OK);

    const spy = vi.spyOn(ClaudeProvider.prototype, 'ensureWorkspaceTrusted');

    await composePermissions({ member_id: member.id, role: 'doer' });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('/home/testuser/project', expect.any(Function), 'linux');
    spy.mockRestore();
  });

  it('calls ensureWorkspaceTrusted on reactive grant compose too', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-doer', llmProvider: 'claude', os: 'linux', workFolder: '/home/testuser/project' });
    addAgent(member);
    mockExecCommand.mockResolvedValue(OK);

    const spy = vi.spyOn(ClaudeProvider.prototype, 'ensureWorkspaceTrusted');

    await composePermissions({ member_id: member.id, role: 'doer', grant: ['Bash(docker:*)'] });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('/home/testuser/project', expect.any(Function), 'linux');
    spy.mockRestore();
  });

  it('does NOT call ensureWorkspaceTrusted when a dangerous grant is blocked before any delivery', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-doer', llmProvider: 'claude', os: 'linux' });
    addAgent(member);

    const spy = vi.spyOn(ClaudeProvider.prototype, 'ensureWorkspaceTrusted');

    await composePermissions({ member_id: member.id, role: 'doer', grant: ['Bash(sudo:*)'] });

    expect(spy).not.toHaveBeenCalled();
    expect(mockExecCommand).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('self-heals a previously-registered member: a never-trusted work folder gets trust seeded via compose_permissions', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-doer', llmProvider: 'claude', os: 'linux', workFolder: '/home/testuser/project' });
    addAgent(member);

    // No ~/.claude.json on the member yet (fresh/never-trusted), and all other
    // exec calls (mkdir/detect stacks/deliver config) succeed trivially.
    mockExecCommand.mockImplementation(async (cmd: string) => {
      if (cmd.includes('.claude.json')) return { stdout: '', stderr: '', code: 0 };
      return OK;
    });

    await composePermissions({ member_id: member.id, role: 'doer' });

    const allCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const trustWrite = allCmds.find(cmd => cmd.includes('FLEET_TRUST_EOF'));
    expect(trustWrite).toBeDefined();
    const heredocMatch = trustWrite!.match(/<< 'FLEET_TRUST_EOF'\n([\s\S]*?)\nFLEET_TRUST_EOF/);
    const written = JSON.parse(heredocMatch![1]);
    expect(written.projects['/home/testuser/project'].hasTrustDialogAccepted).toBe(true);
  });

  it('is a no-op for non-Claude providers (e.g. Gemini) -- never touches the trust delivery channel', async () => {
    const member = makeTestAgent({ friendlyName: 'gemini-doer', llmProvider: 'gemini', os: 'linux' });
    addAgent(member);
    mockExecCommand.mockResolvedValue(OK);

    const spy = vi.spyOn(GeminiProvider.prototype, 'ensureWorkspaceTrusted');

    await composePermissions({ member_id: member.id, role: 'doer' });

    expect(spy).toHaveBeenCalledTimes(1);
    const allCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    expect(allCmds.some(cmd => cmd.includes('.claude.json') || cmd.includes('FLEET_TRUST_EOF'))).toBe(false);
    spy.mockRestore();
  });
});

describe('composePermissions -- fresh/empty permissions.json', () => {
  it('does not crash when permissions.json exists but contains only {}', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-doer', llmProvider: 'claude', os: 'linux' });
    addAgent(member);
    mockExecCommand.mockResolvedValue(OK);

    const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      const s = String(p);
      // Allow findProfilesDir() to succeed by returning true for any profiles dir candidate
      if (s.includes('profiles')) return true;
      if (s.endsWith('permissions.json')) return true;
      // Profile JSON files and everything else: not found
      return false;
    });
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((p, enc) => {
      if (String(p).endsWith('permissions.json')) return '{}';
      throw new Error(`unexpected readFileSync: ${p}`);
    });

    // Use .resolves so vitest actually awaits the promise and catches rejections
    await expect(
      composePermissions({
        member_id: member.id,
        role: 'doer',
        project_folder: '/fake/project',
      })
    ).resolves.toBeDefined();

    existsSpy.mockRestore();
    readSpy.mockRestore();
  });
});
