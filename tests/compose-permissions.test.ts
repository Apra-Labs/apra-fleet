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
import { composePermissions, deepMerge, resolveConfigDeliveryPath, ConfigDeliveryError } from '../src/tools/compose-permissions.js';
import { ClaudeProvider, MEMBER_MCP_ALLOW_PREFIX, MEMBER_MCP_DENY_RULES } from '../src/providers/claude.js';
import { GeminiProvider } from '../src/providers/gemini.js';
import { NoneProvider } from '../src/providers/none.js';
import { MEMBER_TOOL_ALLOWLIST } from '../src/services/tool-registry.js';
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

/**
 * Stateful in-memory filesystem mock for strategy.execCommand.
 *
 * deliverConfigFile now reads each config file back after writing it and fails
 * loudly if the intended content did not land (apra-fleet-k4sc). A mock that
 * returns empty stdout for every command therefore looks exactly like the
 * silent-no-op bug and (correctly) makes delivery fail. This handler simulates a
 * real member filesystem: it records what the write command persists (POSIX
 * heredoc or Windows WriteAllText) and serves it back on the matching read
 * (cat / Get-Content), so an actually-delivered write verifies as landed.
 *
 * `seed` pre-populates files keyed by the exact path string used in the command
 * (forward slashes for POSIX, back slashes for Windows).
 */
function makeFsHandler(seed: Record<string, string> = {}): (cmd: string, timeout?: number) => Promise<SSHExecResult> {
  const files = new Map<string, string>(Object.entries(seed));
  return async (cmd: string): Promise<SSHExecResult> => {
    // POSIX write (heredoc). The interpolated path is double-quoted (rmkb-bbe.1 D2),
    // so the captured group excludes the surrounding quotes -- keys stay unquoted,
    // matching the seed map and the POSIX read patterns below.
    let m = cmd.match(/^cat > "(.+?)" << 'FLEET_PERMS_EOF'\n([\s\S]*)\nFLEET_PERMS_EOF$/);
    if (m) { files.set(m[1], m[2]); return { stdout: '', stderr: '', code: 0 }; }
    // Windows write (WriteAllText); PowerShell single-quote escaping doubles quotes
    m = cmd.match(/\[System\.IO\.File\]::WriteAllText\("(.+?)", '([\s\S]*)', \(New-Object System\.Text\.UTF8Encoding\(\$false\)\)\)/);
    if (m) { files.set(m[1], m[2].replace(/''/g, "'")); return { stdout: '', stderr: '', code: 0 }; }
    // POSIX read (cat "<path>" 2>/dev/null ...) -- both merge-read and read-back
    m = cmd.match(/^cat "(.+?)" 2>\/dev\/null/);
    if (m) { return { stdout: files.get(m[1]) ?? '', stderr: '', code: 0 }; }
    // Windows read (Get-Content -Raw "<path>" ...)
    m = cmd.match(/Get-Content -Raw "(.+?)"/);
    if (m) { return { stdout: files.get(m[1]) ?? '', stderr: '', code: 0 }; }
    // mkdir, detectStacks (ls), workspace-trust writes/reads, everything else
    return { stdout: '', stderr: '', code: 0 };
  };
}

/** Install a fresh stateful filesystem mock as the execCommand implementation. */
function installFsMock(seed: Record<string, string> = {}): void {
  mockExecCommand.mockImplementation(makeFsHandler(seed));
}

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
    installFsMock();

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
    // settings.local.json must keep the fleet-control surface away from the
    // dispatched agent -- by deny rule since rmkb-3n5.6.1, not by a disabled flag.
    expect(writeCmd).toContain('apra-fleet');
    expect(writeCmd).toContain('mcp__apra-fleet__*');
  });

  it('delivers reviewer config with restricted allow list', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-reviewer', llmProvider: 'claude', os: 'linux' });
    addAgent(member);
    installFsMock();

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
    installFsMock();

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
    installFsMock();

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
// AGY proactive compose
// ---------------------------------------------------------------------------

describe('composePermissions -- AGY proactive', () => {
  it('delivers settings.json with AGY native permission rule objects for doer', async () => {
    const member = makeTestAgent({ friendlyName: 'agy-doer', llmProvider: 'agy', os: 'linux' });
    addAgent(member);
    installFsMock();

    const result = await composePermissions({ member_id: member.id, role: 'doer' });

    expect(result).toContain('agy-doer');
    expect(result).toContain('agy');
    expect(result).toContain('.gemini/antigravity-cli/settings.json');

    const allCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const writes = allCmds.filter(cmd => cmd.includes('cat >'));

    expect(writes.some(cmd => cmd.includes('.gemini/antigravity-cli/settings.json'))).toBe(true);

    const settingsWrite = writes.find(cmd => cmd.includes('.gemini/antigravity-cli/settings.json'))!;
    expect(settingsWrite).toContain('"action": "read_file"');
    expect(settingsWrite).toContain('"action": "write_file"');
    expect(settingsWrite).toContain('"action": "command"');
    expect(settingsWrite).toContain('"target": "git"');
  });
});

// ---------------------------------------------------------------------------
// Codex proactive compose
// ---------------------------------------------------------------------------

describe('composePermissions -- Codex proactive', () => {
  it('delivers config.toml with full-auto for doer', async () => {
    const member = makeTestAgent({ friendlyName: 'codex-doer', llmProvider: 'codex', os: 'linux' });
    addAgent(member);
    installFsMock();

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
    installFsMock();

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
    installFsMock();

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
    installFsMock();

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
    installFsMock();

    const result = await composePermissions({
      member_id: member.id,
      role: 'doer',
      grant: ['Bash(docker:*)'],
    });

    expect(result).toContain('Granted');
    expect(result).toContain('Bash(docker:*)');
    // co-occurrence: docker -> docker-compose + docker buildx
    expect(result).toContain('Bash(docker-compose:*)');

    const allCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    // Should have read the existing file at the work-folder-absolute, quoted
    // path (rmkb-bbe.1 D1) -- not a bare relative path resolved against
    // whatever cwd the member's shell happens to be in.
    expect(allCmds.some(cmd => cmd.includes(`cat "${member.workFolder}/.claude/settings.local.json"`))).toBe(true);
    expect(allCmds.some(cmd => cmd.includes('cat .claude/settings.local.json'))).toBe(false);

    // Write command should include both old and new permissions
    const writes = allCmds.filter(cmd => cmd.includes('cat >'));
    const writeCmd = writes.find(cmd => cmd.includes('.claude/settings.local.json'))!;
    expect(writeCmd).toContain('Read');
    expect(writeCmd).toContain('Bash(docker:*)');
  });

  it('reactive grant on a remote member preserves the previously composed allow list (round-trip, rmkb-bbe.1 D1)', async () => {
    // Regression pin for the read/write asymmetry: the read command MUST target
    // the same work-folder-absolute path deliverConfigFile writes to. Seeding
    // the stateful fs mock keyed by that resolved path means the read only
    // succeeds if compose-permissions.ts resolves it the same way -- against
    // pre-fix code (a bare relative `cat .claude/settings.local.json` read),
    // this mock has no entry at the SSH login cwd, so the read returns "" and
    // the previously composed allow list would be silently clobbered.
    const member = makeTestAgent({
      friendlyName: 'remote-grant-roundtrip',
      llmProvider: 'claude',
      os: 'linux',
      agentType: 'remote',
      workFolder: '/home/remoteuser/proj3',
    });
    addAgent(member);

    const previouslyComposed = JSON.stringify({
      permissions: { allow: ['Read', 'Write', 'Bash(git:*)'] },
    });
    installFsMock({ [`${member.workFolder}/.claude/settings.local.json`]: previouslyComposed });

    const result = await composePermissions({
      member_id: member.id,
      role: 'doer',
      grant: ['Bash(docker:*)'],
    });

    expect(result).toContain('Granted');

    const allCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const writeCmd = allCmds.find(cmd => cmd.includes('cat >') && cmd.includes('.claude/settings.local.json'))!;
    expect(writeCmd).toBeDefined();
    const heredocBody = writeCmd.split("'FLEET_PERMS_EOF'\n")[1].split('\nFLEET_PERMS_EOF')[0];
    const written = JSON.parse(heredocBody);

    // The pre-existing allow entries must survive alongside the new grant --
    // pre-fix, the mismatched read path would return {} here and this array
    // would contain ONLY the new grant.
    expect(written.permissions.allow).toEqual(
      expect.arrayContaining(['Read', 'Write', 'Bash(git:*)', 'Bash(docker:*)']),
    );
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
    installFsMock();

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
// No llmProvider -> defaults to Claude
// ---------------------------------------------------------------------------

describe('composePermissions -- no llmProvider defaults to Claude', () => {
  it('treats member with no llmProvider as Claude', async () => {
    // makeTestAgent without llmProvider -> undefined
    const member = makeTestAgent({ friendlyName: 'legacy-member', os: 'linux' });
    delete (member as any).llmProvider;
    addAgent(member);
    installFsMock();

    const result = await composePermissions({ member_id: member.id, role: 'doer' });

    expect(result).toContain('claude'); // provider name in output

    const allCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const writes = allCmds.filter(cmd => cmd.includes('cat >'));
    // Should write to Claude's path
    expect(writes.some(cmd => cmd.includes('.claude/settings.local.json'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Issue #151, superseded by rmkb-3n5.6.1 -- the fleet-control surface is kept
// away from a dispatched member by permissions.deny, NOT by the old blanket
// mcpServers['apra-fleet'].disabled flag (which sat upstream of the permission
// matcher and made the member-scoped surface unreachable too).
// ---------------------------------------------------------------------------

describe('composePermissions -- fleet-control MCP surface denied in member config (#151, rmkb-3n5.6.1)', () => {
  it('denies mcp__apra-fleet__* (and sets no disabled flag) in Claude settings.local.json (proactive)', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-doer', llmProvider: 'claude', os: 'linux' });
    addAgent(member);
    installFsMock();

    await composePermissions({ member_id: member.id, role: 'doer' });

    const allCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const writeCmd = allCmds.filter(cmd => cmd.includes('cat >')).find(cmd => cmd.includes('.claude/settings.local.json'))!;
    expect(writeCmd).toBeDefined();
    expect(writeCmd).not.toContain('"disabled":');

    const written = JSON.parse(writeCmd.split("'FLEET_PERMS_EOF'\n")[1].split('\nFLEET_PERMS_EOF')[0]);
    expect(written.permissions.deny).toContain('mcp__apra-fleet__*');
    expect(written.permissions.allow).toContain('mcp__apra-fleet-member__kb_query');
  });

  it('denies mcp__apra-fleet__* in Claude settings.local.json (reactive grant)', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-doer', llmProvider: 'claude', os: 'linux' });
    addAgent(member);

    const existing = JSON.stringify({ permissions: { allow: ['Read', 'Write'] } });
    mockExecCommand.mockResolvedValueOnce({ stdout: existing, stderr: '', code: 0 });
    installFsMock();

    await composePermissions({ member_id: member.id, role: 'doer', grant: ['Bash(npm:*)'] });

    const allCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const writeCmd = allCmds.filter(cmd => cmd.includes('cat >')).find(cmd => cmd.includes('.claude/settings.local.json'))!;
    expect(writeCmd).toBeDefined();
    expect(writeCmd).toContain('apra-fleet');
    expect(writeCmd).not.toContain('"disabled":');
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
    // Seed the file exactly as register_member left it; the merge-read returns
    // it, the merged write persists it, and the read-back verifies it landed.
    // Keyed by the work-folder-absolute path: deliverConfigFile resolves its
    // target against agent.workFolder in JS now (rmkb-3n5.2.1), since
    // RemoteStrategy.execCommand passes no cwd -- a bare relative key here
    // would silently miss every read/write command and mask this test.
    installFsMock({ [`${member.workFolder}/.claude/settings.local.json`]: registeredByMember });

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
    // rmkb-3n5.6.1: compose_permissions no longer writes an mcpServers block of
    // its own (the blanket apra-fleet disable is gone, replaced by
    // permissions.deny), so the member entry is the ONLY one and must be intact.
    expect(written.mcpServers['apra-fleet']).toBeUndefined();
    expect(written.permissions.deny).toContain('mcp__apra-fleet__*');
  });
});

// ---------------------------------------------------------------------------
// apra-fleet-k4sc.1 -- deliverConfigFile verifies writes and fails loudly on a
// no-op grant (never reports success when the config did not land)
// ---------------------------------------------------------------------------

describe('composePermissions -- fails loudly when a config write does not land (apra-fleet-k4sc)', () => {
  it('returns an explicit failure (never a success string) when the write command exits nonzero', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-doer', llmProvider: 'claude', os: 'linux' });
    addAgent(member);

    // mkdir/read succeed, but the write reports a hard failure.
    mockExecCommand.mockImplementation(async (cmd: string) => {
      if (cmd.includes('cat >')) return { stdout: '', stderr: 'bash: cannot create: No space left on device', code: 1 };
      return OK;
    });

    const result = await composePermissions({ member_id: member.id, role: 'doer' });

    expect(result).toContain('Failed to persist');
    expect(result).toContain('.claude/settings.local.json');
    expect(result).toContain('exit 1');
    // Must NOT masquerade as success
    expect(result).not.toContain('composed');
    expect(result).not.toContain('Granted');
  });

  it('returns an explicit failure when the write "succeeds" but the file did not land (silent no-op)', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-doer', llmProvider: 'claude', os: 'linux' });
    addAgent(member);

    // Every command reports exit 0 but nothing is ever persisted: the exact
    // silent-no-op shape from the original bug (write reports success, read-back
    // comes back empty).
    mockExecCommand.mockResolvedValue(OK);

    const result = await composePermissions({ member_id: member.id, role: 'doer' });

    expect(result).toContain('Failed to persist');
    expect(result).toContain('read-back verification failed');
    expect(result).not.toContain('composed');
  });

  it('does not update the ledger when a reactive grant fails to persist', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-doer', llmProvider: 'claude', os: 'linux' });
    addAgent(member);

    // Write reports success but read-back is empty -> delivery verification fails.
    mockExecCommand.mockResolvedValue(OK);

    const saveSpy = vi.spyOn(fs, 'writeFileSync');

    const result = await composePermissions({
      member_id: member.id,
      role: 'doer',
      grant: ['Bash(docker:*)'],
      grant_reason: 'sprint needs docker',
      project_folder: '/tmp/fleet-k4sc-nonexistent-project',
    });

    expect(result).toContain('Failed to persist');
    // The ledger (permissions.json) must never be written when delivery failed.
    const wroteLedger = saveSpy.mock.calls.some(c => String(c[0]).endsWith('permissions.json'));
    expect(wroteLedger).toBe(false);

    saveSpy.mockRestore();
  });

  it('reports success only after a verified read-back confirms the content landed', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-doer', llmProvider: 'claude', os: 'linux' });
    addAgent(member);

    // Realistic filesystem: the write is stored and served back on read.
    installFsMock();

    const result = await composePermissions({ member_id: member.id, role: 'doer' });

    expect(result).toContain('composed');
    expect(result).not.toContain('Failed to persist');
  });
});

// ---------------------------------------------------------------------------
// Task T4: deliverConfigFile() BOM-free Windows write (#219)
// ---------------------------------------------------------------------------

describe('deliverConfigFile -- Windows BOM-free write (T4)', () => {
  it('uses WriteAllText with UTF8Encoding($false) on Windows, not Set-Content', async () => {
    const member = makeTestAgent({ friendlyName: 'gemini-win', llmProvider: 'gemini', os: 'windows' });
    addAgent(member);
    installFsMock();

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
    installFsMock();

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
    installFsMock();

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
    installFsMock();
    await composePermissions({ member_id: memberRole.id, role: 'doer' });
    const roleCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const roleWrite = roleCmds.find(cmd => cmd.includes('.claude/settings.local.json') && cmd.includes('FLEET_PERMS_EOF'))!;
    const roleContent = extractWrittenContent(roleWrite);

    vi.clearAllMocks();

    // Run tags:['doer']
    installFsMock();
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
    installFsMock();
    await composePermissions({ member_id: memberRole.id, role: 'reviewer' });
    const roleCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const roleWrite = roleCmds.find(cmd => cmd.includes('.claude/settings.local.json') && cmd.includes('FLEET_PERMS_EOF'))!;
    const roleContent = extractWrittenContent(roleWrite);

    vi.clearAllMocks();

    // Run tags:['reviewer']
    installFsMock();
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
    installFsMock();

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
    installFsMock();
    await composePermissions({ member_id: memberDoer.id, tags: ['doer'] });
    const doerCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const doerWrite = doerCmds.find(cmd => cmd.includes('.claude/settings.local.json') && cmd.includes('FLEET_PERMS_EOF'))!;
    const doerAllow: string[] = JSON.parse(extractWrittenContent(doerWrite)).permissions.allow;

    vi.clearAllMocks();

    // Doer + gpu
    installFsMock();
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
    installFsMock();

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
    installFsMock();
    await composePermissions({ member_id: memberTagsWin.id, role: 'reviewer', tags: ['doer'] });
    const tagsWinCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const tagsWinWrite = tagsWinCmds.find(cmd => cmd.includes('.claude/settings.local.json') && cmd.includes('FLEET_PERMS_EOF'))!;
    const tagsWinAllow: string[] = JSON.parse(extractWrittenContent(tagsWinWrite)).permissions.allow;

    vi.clearAllMocks();

    // role:doer alone for reference
    installFsMock();
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
    installFsMock();

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
    installFsMock();
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
    installFsMock();
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
    installFsMock();
    await composePermissions({ member_id: memberGpuOnly.id, tags: ['gpu'] });
    const noModeCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const noModeWrite = noModeCmds.find(cmd => cmd.includes('.claude/settings.local.json') && cmd.includes('FLEET_PERMS_EOF'))!;
    expect(noModeWrite).toBeDefined();
    const noModeAllow: string[] = JSON.parse(extractWrittenContent(noModeWrite)).permissions.allow;

    vi.clearAllMocks();

    // tags=['doer','gpu'] -> explicit doer+gpu
    installFsMock();
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
    installFsMock();
    await composePermissions({ member_id: memberReviewerFirst.id, tags: ['reviewer', 'doer'] });
    const reviewerFirstCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const reviewerFirstWrite = reviewerFirstCmds.find(cmd => cmd.includes('.claude/settings.local.json') && cmd.includes('FLEET_PERMS_EOF'))!;
    const reviewerFirstAllow: string[] = JSON.parse(extractWrittenContent(reviewerFirstWrite)).permissions.allow;

    vi.clearAllMocks();

    // doer first -> doer mode
    installFsMock();
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
    installFsMock();

    const spy = vi.spyOn(ClaudeProvider.prototype, 'ensureWorkspaceTrusted');

    await composePermissions({ member_id: member.id, role: 'doer' });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('/home/testuser/project', expect.any(Function), 'linux');
    spy.mockRestore();
  });

  it('calls ensureWorkspaceTrusted on reactive grant compose too', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-doer', llmProvider: 'claude', os: 'linux', workFolder: '/home/testuser/project' });
    addAgent(member);
    installFsMock();

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

    // No ~/.claude.json on the member yet (fresh/never-trusted); config delivery
    // verifiably lands (fs mock), so trust seeding is reached afterwards.
    installFsMock();

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
    installFsMock();

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
    installFsMock();

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

// ---------------------------------------------------------------------------
// rmkb-3n5.2 -- deliverConfigFile must resolve the delivery path against the
// member's work folder for remote members, not rely on shell cwd.
//
// RemoteStrategy.execCommand passes NO cwd (src/services/strategy.ts), unlike
// LocalStrategy which passes cwd: agent.workFolder -- so before rmkb-3n5.2.1,
// a bare relative path like ".claude/settings.local.json" landed in the SSH
// login cwd ($HOME) on a remote member instead of the work folder the
// dispatch path `cd`s into before running the provider CLI. The assertions
// below pin the work-folder-absolute path and fail on that pre-fix shape:
// reverting resolveConfigDeliveryPath's join in src/tools/compose-permissions.ts
// (or deleting the call sites so paths[i] is passed to deliverConfigFile
// verbatim) makes the "work-folder-absolute" expectations below fail because
// the captured commands would only contain the bare relative
// ".claude/settings.local.json"/".claude" strings.
// ---------------------------------------------------------------------------
describe('composePermissions -- remote-member config delivery path (rmkb-3n5.2 regression)', () => {
  it('resolves the delivery path to <workFolder>/.claude/settings.local.json for a remote member', async () => {
    const member = makeTestAgent({
      friendlyName: 'remote-cfg-path',
      llmProvider: 'claude',
      os: 'linux',
      agentType: 'remote',
      workFolder: '/home/remoteuser/proj',
    });
    addAgent(member);
    installFsMock();

    await composePermissions({ member_id: member.id, role: 'doer' });

    const allCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const mkdirCmd = allCmds.find(cmd => cmd.includes('mkdir') && cmd.includes('.claude'))!;
    const writeCmd = allCmds.find(cmd => cmd.includes('cat >') && cmd.includes('.claude/settings.local.json'))!;
    expect(mkdirCmd).toBeDefined();
    expect(writeCmd).toBeDefined();

    // Work-folder-absolute: this is what MUST land now.
    expect(mkdirCmd).toContain('/home/remoteuser/proj/.claude');
    expect(writeCmd).toContain('/home/remoteuser/proj/.claude/settings.local.json');

    // Pre-fix shape (bare relative path, resolved only by a shell cwd that
    // RemoteStrategy never sets) must NOT be what is delivered.
    expect(mkdirCmd).not.toBe('mkdir -p .claude');
    expect(writeCmd.startsWith("cat > .claude/settings.local.json")).toBe(false);
  });

  it('keeps local-member delivery landing under the local work folder (unchanged)', async () => {
    const member = makeTestAgent({
      friendlyName: 'local-cfg-path',
      llmProvider: 'claude',
      os: 'linux',
      agentType: 'local',
      workFolder: '/home/localuser/proj',
    });
    addAgent(member);
    installFsMock();

    await composePermissions({ member_id: member.id, role: 'doer' });

    const allCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const writeCmd = allCmds.find(cmd => cmd.includes('cat >') && cmd.includes('.claude/settings.local.json'))!;
    expect(writeCmd).toBeDefined();
    // Still lands under the member's own local work folder.
    expect(writeCmd).toContain('/home/localuser/proj/.claude/settings.local.json');
  });

  it('still deep-merges a pre-existing mcpServers entry for a remote member instead of overwriting it', async () => {
    const member = makeTestAgent({
      friendlyName: 'remote-merge',
      llmProvider: 'claude',
      os: 'linux',
      agentType: 'remote',
      workFolder: '/home/remoteuser/proj2',
    });
    addAgent(member);

    // Simulate the file exactly as register_member leaves it, seeded at the
    // work-folder-absolute path deliverConfigFile now actually reads/writes.
    const registeredByMember = JSON.stringify({
      mcpServers: {
        'apra-fleet-member': {
          type: 'http',
          url: 'http://localhost:1234/mcp?member=xyz-789',
          headers: { Authorization: 'Bearer remote-super-secret-jwt' },
        },
      },
    });
    installFsMock({ [`${member.workFolder}/.claude/settings.local.json`]: registeredByMember });

    await composePermissions({ member_id: member.id, role: 'doer' });

    const allCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const writeCmd = allCmds.find(cmd => cmd.includes('cat >') && cmd.includes('.claude/settings.local.json'))!;
    expect(writeCmd).toBeDefined();

    const heredocBody = writeCmd.split("'FLEET_PERMS_EOF'\n")[1].split('\nFLEET_PERMS_EOF')[0];
    const written = JSON.parse(heredocBody);

    // The register_member entry -- including its live JWT -- must survive the
    // merge on a remote member, exactly as it already does for local members.
    expect(written.mcpServers['apra-fleet-member']).toEqual({
      type: 'http',
      url: 'http://localhost:1234/mcp?member=xyz-789',
      headers: { Authorization: 'Bearer remote-super-secret-jwt' },
    });
    // rmkb-3n5.6.1: compose_permissions no longer writes an mcpServers block of
    // its own (the blanket apra-fleet disable is gone, replaced by
    // permissions.deny), so the member entry is the ONLY one and must be intact.
    expect(written.mcpServers['apra-fleet']).toBeUndefined();
    expect(written.permissions.deny).toContain('mcp__apra-fleet__*');
  });
});

// ---------------------------------------------------------------------------
// rmkb-3n5.6.2 -- the emitted client-side allow/deny profile shape
//
// Pure shape assertions on ClaudeProvider.composePermissionConfig(): no member,
// no MCP server, no strategy. This is the CLIENT half of the member boundary and
// is defense in depth only -- the enforcing half is server-side deny-by-omission
// in registerAllTools (tests/tool-scope.test.ts). What can silently break here
// is subtle rather than loud, hence a universal property instead of spot checks:
//   * a re-added `disabled: true` sits UPSTREAM of the permission matcher and
//     switches the whole member surface off no matter what allow says;
//   * an UNANCHORED allow glob (`mcp__*`) is SKIPPED WITH A WARNING by Claude
//     Code, i.e. it grants nothing while looking generous;
//   * a dropped deny (compose_permissions above all) is a self-escalation hole:
//     an agent that can call it rewrites its own allow list.
// ---------------------------------------------------------------------------

describe('ClaudeProvider.composePermissionConfig -- member MCP allow/deny profile (rmkb-3n5.6.2)', () => {
  const claude = new ClaudeProvider();

  /** The single settings.local.json fragment Claude emits. */
  function fragment(role: 'doer' | 'reviewer' = 'doer', allow: string[] = ['Read', 'Write', 'Bash(git:*)']) {
    const configs = claude.composePermissionConfig(role, allow);
    expect(configs).toHaveLength(1);
    return configs[0] as {
      permissions: { allow: string[]; deny: string[] };
      mcpServers?: Record<string, unknown>;
      skillOverrides?: Record<string, unknown>;
    };
  }

  it('emits NO mcpServers["apra-fleet"].disabled key at all (absence, not a false value)', () => {
    for (const role of ['doer', 'reviewer'] as const) {
      const cfg = fragment(role);
      // Assert the KEY is absent rather than falsy: `disabled: false` would be a
      // regression waiting to happen, and a truthy re-add would silently kill the
      // member surface upstream of every allow rule below.
      const fleetEntry = (cfg.mcpServers ?? {})['apra-fleet'] as Record<string, unknown> | undefined;
      expect(fleetEntry === undefined || !('disabled' in fleetEntry)).toBe(true);
      expect(JSON.stringify(cfg)).not.toContain('"disabled"');
    }
  });

  it('anchors EVERY MCP allow entry after the literal mcp__apra-fleet-member__ prefix (no unanchored glob possible)', () => {
    // Universal property over the whole allow array, including hostile input:
    // callers (the reactive grant path re-reads the member's own file) may hand
    // in unanchored or orchestrator-scoped MCP rules, and none of them may
    // survive into the emitted allow list.
    const cfg = fragment('doer', [
      'Read',
      'mcp__*',
      'mcp__apra-fleet__*',
      'mcp__apra-fleet__execute_prompt',
      'mcp__apra-fleet-member__kb_query',
    ]);
    const mcpAllow = cfg.permissions.allow.filter(rule => rule.startsWith('mcp__'));
    expect(mcpAllow.length).toBeGreaterThan(0);
    for (const rule of mcpAllow) {
      expect(rule.startsWith(MEMBER_MCP_ALLOW_PREFIX)).toBe(true);
    }
    expect(MEMBER_MCP_ALLOW_PREFIX).toBe('mcp__apra-fleet-member__');
    // Non-MCP permissions the caller asked for are untouched.
    expect(cfg.permissions.allow).toContain('Read');
    // ...and the unanchored / orchestrator-scoped ones are gone.
    expect(cfg.permissions.allow).not.toContain('mcp__*');
    expect(cfg.permissions.allow).not.toContain('mcp__apra-fleet__*');
    expect(cfg.permissions.allow).not.toContain('mcp__apra-fleet__execute_prompt');
  });

  it('denies compose_permissions -- the self-escalation hole -- plus mcp__apra-fleet__* and the rest of the deny set', () => {
    const deny = fragment().permissions.deny;
    // compose_permissions first and by name: an agent that can call it rewrites
    // its own allow list, which makes every other rule here advisory.
    expect(deny.some(rule => rule.includes('compose_permissions'))).toBe(true);
    // The orchestrator's OWN server key stays wholly denied.
    expect(deny).toContain('mcp__apra-fleet__*');
    for (const tool of [
      'execute_prompt',
      'execute_command',
      'stop_prompt',
      'compose_permissions',
      'credential_store_',
      'send_files',
      'receive_files',
      'send_email',
      'kb_promote',
      'kb_import',
      'kb_export',
      'kb_setup',
    ]) {
      expect(deny.some(rule => rule.includes(tool))).toBe(true);
    }
    expect(deny).toEqual([...MEMBER_MCP_DENY_RULES]);
  });

  it('derives the allowed tool-name set from MEMBER_TOOL_ALLOWLIST so client and server boundaries cannot drift', () => {
    const cfg = fragment();
    const allowedToolNames = cfg.permissions.allow
      .filter(rule => rule.startsWith(MEMBER_MCP_ALLOW_PREFIX))
      .map(rule => rule.slice(MEMBER_MCP_ALLOW_PREFIX.length))
      .sort();
    // Set equality, not containment: an extra client-side allow would grant a
    // tool the server never registers (dead rule), and a missing one would make
    // a genuinely in-scope tool unusable on the member.
    expect(allowedToolNames).toEqual([...MEMBER_TOOL_ALLOWLIST].sort());
    // The KB and code-intelligence surface plus the two housekeeping tools are
    // what the member is actually there to use -- spot-check the ends.
    expect(allowedToolNames).toContain('kb_session_prime');
    expect(allowedToolNames).toContain('code_graph');
    expect(allowedToolNames).toContain('version');
    expect(allowedToolNames).toContain('report_status');
    // Nothing denied may also be allowed (deny wins on first match, but a rule
    // that needs deny to save it is a bug in the allow list).
    expect(allowedToolNames).not.toContain('compose_permissions');
    expect(allowedToolNames).not.toContain('execute_prompt');
  });

  it('leaves providers with no MCP endpoint unaffected (gemini, none)', () => {
    // Only the Claude fragment carries the member-scoped rules; a provider that
    // has no registerMcpEndpoint() has no apra-fleet-member entry to point at,
    // so its config must not grow mcp__ rules of any kind.
    const gemini = new GeminiProvider();
    expect(gemini.registerMcpEndpoint).toBeUndefined();
    const geminiConfigs = gemini.composePermissionConfig('doer', ['Read', 'Write']);
    expect(geminiConfigs).toHaveLength(2);
    expect(geminiConfigs[0]).toEqual({ mode: 'auto_edit', mcpServers: {} });
    expect(JSON.stringify(geminiConfigs)).not.toContain('mcp__');

    const none = new NoneProvider();
    expect(none.composePermissionConfig('doer', ['Read'])).toEqual([]);
  });

  it('survives the deliverConfigFile deep merge with a pre-existing apra-fleet-member entry (neither side clobbered)', () => {
    // The tunnel/register_member entry (which carries the live JWT) and this
    // fragment are written to the SAME settings.local.json by different code
    // paths, and deliverConfigFile merges them with deepMerge.
    const onMember = {
      mcpServers: {
        'apra-fleet-member': {
          type: 'http',
          url: 'http://127.0.0.1:41234/mcp',
          headers: { Authorization: 'Bearer minted-member-jwt' },
        },
      },
      permissions: { allow: ['Read'] },
    };
    const merged = deepMerge(onMember, fragment() as unknown as Record<string, unknown>);
    const mcpServers = merged.mcpServers as Record<string, unknown>;

    // The JWT-bearing endpoint entry survives untouched...
    expect(mcpServers['apra-fleet-member']).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:41234/mcp',
      headers: { Authorization: 'Bearer minted-member-jwt' },
    });
    // ...no disabled flag is introduced for the orchestrator key by the merge...
    expect(mcpServers['apra-fleet']).toBeUndefined();
    // ...and the composed rules land intact (arrays replace, per deepMerge).
    const permissions = merged.permissions as { allow: string[]; deny: string[] };
    expect(permissions.allow).toContain(`${MEMBER_MCP_ALLOW_PREFIX}kb_query`);
    expect(permissions.deny).toContain('mcp__apra-fleet__*');
  });
});

// ---------------------------------------------------------------------------
// rmkb-bbe.1 D2 -- quoted POSIX interpolation of a work folder containing a space
// rmkb-bbe.1 D3 -- empty/undefined workFolder is rejected, not resolved to "/"
// ---------------------------------------------------------------------------

describe('composePermissions -- quoted POSIX paths and empty-workFolder guard (rmkb-bbe.1)', () => {
  it('quotes mkdir, read and write commands when workFolder contains a space', async () => {
    const member = makeTestAgent({
      friendlyName: 'spaced-workfolder',
      llmProvider: 'claude',
      os: 'linux',
      agentType: 'remote',
      workFolder: '/home/dev/My Repos/proj',
    });
    addAgent(member);
    installFsMock();

    await composePermissions({ member_id: member.id, role: 'doer' });

    const allCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const mkdirCmd = allCmds.find(cmd => cmd.includes('mkdir') && cmd.includes('My Repos'))!;
    const writeCmd = allCmds.find(cmd => cmd.includes('cat >') && cmd.includes('My Repos'))!;
    expect(mkdirCmd).toBeDefined();
    expect(writeCmd).toBeDefined();

    // Unquoted interpolation would split the path on the space (word-split into
    // "mkdir -p /home/dev/My" "Repos/proj/.claude", an "ambiguous redirect"-class
    // failure for cat/write). Quoting keeps the whole path as one argument.
    expect(mkdirCmd).toBe('mkdir -p "/home/dev/My Repos/proj/.claude"');
    expect(writeCmd.startsWith('cat > "/home/dev/My Repos/proj/.claude/settings.local.json"')).toBe(true);
  });

  it('quotes the reactive-grant read command when workFolder contains a space', async () => {
    const member = makeTestAgent({
      friendlyName: 'spaced-workfolder-grant',
      llmProvider: 'claude',
      os: 'linux',
      agentType: 'remote',
      workFolder: '/home/dev/My Repos/proj2',
    });
    addAgent(member);
    installFsMock();

    await composePermissions({ member_id: member.id, role: 'doer', grant: ['Bash(docker:*)'] });

    const allCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const readCmd = allCmds.find(cmd => cmd.startsWith('cat "') && cmd.includes('My Repos'))!;
    expect(readCmd).toBeDefined();
    expect(readCmd).toBe('cat "/home/dev/My Repos/proj2/.claude/settings.local.json" 2>/dev/null || echo "{}"');
  });

  it('rejects an empty workFolder with a ConfigDeliveryError instead of resolving to a filesystem-root path', () => {
    const agent = makeTestAgent({ friendlyName: 'empty-workfolder', llmProvider: 'claude', os: 'linux', workFolder: '' });
    expect(() => resolveConfigDeliveryPath(agent, '.claude/settings.local.json')).toThrow(ConfigDeliveryError);
  });

  it('rejects an undefined workFolder with a ConfigDeliveryError instead of resolving to a filesystem-root path', () => {
    const agent = makeTestAgent({ friendlyName: 'undefined-workfolder', llmProvider: 'claude', os: 'linux' });
    (agent as { workFolder?: string }).workFolder = undefined;
    expect(() => resolveConfigDeliveryPath(agent, '.claude/settings.local.json')).toThrow(ConfigDeliveryError);
  });
});
