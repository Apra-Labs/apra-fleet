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
import type { SSHExecResult } from '../src/types.js';
import fs from 'node:fs';

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
});

afterEach(() => {
  restoreRegistry();
});

// ---------------------------------------------------------------------------
// Claude proactive compose
// ---------------------------------------------------------------------------

describe('composePermissions — Claude proactive', () => {
  it('delivers settings.local.json with JSON allow list', async () => {
    const agent = makeTestAgent({ friendlyName: 'claude-doer', llmProvider: 'claude', os: 'linux' });
    addAgent(agent);

    // detectStacks: ls markers + *.sln/*.csproj
    mockExecCommand.mockResolvedValue(OK);

    const result = await composePermissions({ member_id: agent.id, role: 'doer' });

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
  });

  it('delivers reviewer config with restricted allow list', async () => {
    const agent = makeTestAgent({ friendlyName: 'claude-reviewer', llmProvider: 'claude', os: 'linux' });
    addAgent(agent);
    mockExecCommand.mockResolvedValue(OK);

    const result = await composePermissions({ member_id: agent.id, role: 'reviewer' });
    expect(result).toContain('reviewer');

    const writes = mockExecCommand.mock.calls.map(c => c[0] as string).filter(cmd => cmd.includes('cat >'));
    expect(writes.some(cmd => cmd.includes('.claude/settings.local.json'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Gemini proactive compose
// ---------------------------------------------------------------------------

describe('composePermissions — Gemini proactive', () => {
  it('delivers settings.json + fleet.toml for doer', async () => {
    const agent = makeTestAgent({ friendlyName: 'gemini-doer', llmProvider: 'gemini', os: 'linux' });
    addAgent(agent);
    mockExecCommand.mockResolvedValue(OK);

    const result = await composePermissions({ member_id: agent.id, role: 'doer' });

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

    // fleet.toml should have [policy] section
    const tomlWrite = writes.find(cmd => cmd.includes('fleet.toml'))!;
    expect(tomlWrite).toContain('[policy]');
    expect(tomlWrite).toContain('auto_edit');
  });

  it('delivers default mode for reviewer', async () => {
    const agent = makeTestAgent({ friendlyName: 'gemini-reviewer', llmProvider: 'gemini', os: 'linux' });
    addAgent(agent);
    mockExecCommand.mockResolvedValue(OK);

    await composePermissions({ member_id: agent.id, role: 'reviewer' });

    const allCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const writes = allCmds.filter(cmd => cmd.includes('cat >'));

    const settingsWrite = writes.find(cmd => cmd.includes('.gemini/settings.json'))!;
    expect(settingsWrite).toContain('"default"');
  });
});

// ---------------------------------------------------------------------------
// Codex proactive compose
// ---------------------------------------------------------------------------

describe('composePermissions — Codex proactive', () => {
  it('delivers config.toml with full-auto for doer', async () => {
    const agent = makeTestAgent({ friendlyName: 'codex-doer', llmProvider: 'codex', os: 'linux' });
    addAgent(agent);
    mockExecCommand.mockResolvedValue(OK);

    const result = await composePermissions({ member_id: agent.id, role: 'doer' });

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
    const agent = makeTestAgent({ friendlyName: 'codex-reviewer', llmProvider: 'codex', os: 'linux' });
    addAgent(agent);
    mockExecCommand.mockResolvedValue(OK);

    await composePermissions({ member_id: agent.id, role: 'reviewer' });

    const allCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const tomlWrite = allCmds.filter(cmd => cmd.includes('cat >')).find(cmd => cmd.includes('.codex/config.toml'))!;
    expect(tomlWrite).toContain('suggest');
  });
});

// ---------------------------------------------------------------------------
// Copilot proactive compose
// ---------------------------------------------------------------------------

describe('composePermissions — Copilot proactive', () => {
  it('delivers settings.local.json with allow-all-tools for doer', async () => {
    const agent = makeTestAgent({ friendlyName: 'copilot-doer', llmProvider: 'copilot', os: 'linux' });
    addAgent(agent);
    mockExecCommand.mockResolvedValue(OK);

    const result = await composePermissions({ member_id: agent.id, role: 'doer' });

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
    const agent = makeTestAgent({ friendlyName: 'copilot-reviewer', llmProvider: 'copilot', os: 'linux' });
    addAgent(agent);
    mockExecCommand.mockResolvedValue(OK);

    await composePermissions({ member_id: agent.id, role: 'reviewer' });

    const allCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const jsonWrite = allCmds.filter(cmd => cmd.includes('cat >')).find(cmd => cmd.includes('.github/copilot/settings.local.json'))!;
    expect(jsonWrite).toContain('"deny"');
  });
});

// ---------------------------------------------------------------------------
// Reactive grant: Claude — merges existing allow list
// ---------------------------------------------------------------------------

describe('composePermissions — Claude reactive grant', () => {
  it('reads existing settings.local.json and merges new grants', async () => {
    const agent = makeTestAgent({ friendlyName: 'claude-doer', llmProvider: 'claude', os: 'linux' });
    addAgent(agent);

    const existing = JSON.stringify({ permissions: { allow: ['Read', 'Write', 'Bash(git:*)'] } });
    // First call is the read of existing settings.local.json
    mockExecCommand.mockResolvedValueOnce({ stdout: existing, stderr: '', code: 0 });
    // mkdir + write calls
    mockExecCommand.mockResolvedValue(OK);

    const result = await composePermissions({
      member_id: agent.id,
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
    const agent = makeTestAgent({ friendlyName: 'claude-doer', llmProvider: 'claude', os: 'linux' });
    addAgent(agent);

    const result = await composePermissions({
      member_id: agent.id,
      role: 'doer',
      grant: ['Bash(sudo:*)'],
    });

    expect(result).toContain('Cannot auto-grant');
    expect(result).toContain('Bash(sudo:*)');
    expect(mockExecCommand).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Reactive grant: Gemini — TOML policy updated with grants
// ---------------------------------------------------------------------------

describe('composePermissions — Gemini reactive grant', () => {
  it('delivers updated TOML policy with granted tools', async () => {
    const agent = makeTestAgent({ friendlyName: 'gemini-doer', llmProvider: 'gemini', os: 'linux' });
    addAgent(agent);
    mockExecCommand.mockResolvedValue(OK);

    const result = await composePermissions({
      member_id: agent.id,
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
    const agent = makeTestAgent({ friendlyName: 'gemini-doer', llmProvider: 'gemini', os: 'linux' });
    addAgent(agent);

    const result = await composePermissions({
      member_id: agent.id,
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

describe('composePermissions — no llmProvider defaults to Claude', () => {
  it('treats member with no llmProvider as Claude', async () => {
    // makeTestAgent without llmProvider → undefined
    const agent = makeTestAgent({ friendlyName: 'legacy-agent', os: 'linux' });
    delete (agent as any).llmProvider;
    addAgent(agent);
    mockExecCommand.mockResolvedValue(OK);

    const result = await composePermissions({ member_id: agent.id, role: 'doer' });

    expect(result).toContain('claude'); // provider name in output

    const allCmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    const writes = allCmds.filter(cmd => cmd.includes('cat >'));
    // Should write to Claude's path
    expect(writes.some(cmd => cmd.includes('.claude/settings.local.json'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fresh/empty permissions.json — no crash (#88)
// ---------------------------------------------------------------------------

describe('composePermissions — fresh/empty permissions.json', () => {
  it('does not crash when permissions.json exists but contains only {}', async () => {
    const agent = makeTestAgent({ friendlyName: 'claude-doer', llmProvider: 'claude', os: 'linux' });
    addAgent(agent);
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
        member_id: agent.id,
        role: 'doer',
        project_folder: '/fake/project',
      })
    ).resolves.toBeDefined();

    existsSpy.mockRestore();
    readSpy.mockRestore();
  });
});
