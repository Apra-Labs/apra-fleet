/**
 * Tests for wiring the per-role bounds check into the compose_permissions
 * reactive grant path (apra-fleet-ivxi.1.3). loadBounds (ivxi.1.1) and the
 * ledger's outOfBounds/requestedByRole fields (ivxi.1.2) already exist and
 * are tested elsewhere -- this file covers only the grant-path wiring:
 *
 * - A grant matching the calling role's bounds lands in the ledger exactly
 *   as today (no outOfBounds field).
 * - A grant outside the role's bounds is still granted, but its ledger
 *   entry carries outOfBounds:true and requestedByRole.
 * - A grant with no role behaves exactly as today (no bounds check at all).
 * - NEVER_AUTO_GRANT still hard-rejects even when the request carries a
 *   role with a permissive bounds file (bounds never loosen the denylist).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTestAgent, backupAndResetRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { composePermissions, loadLedger } from '../src/tools/compose-permissions.js';
import type { SSHExecResult } from '../src/types.js';

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
  }),
}));

/**
 * Stateful in-memory filesystem mock for strategy.execCommand -- same
 * approach as compose-permissions.test.ts's makeFsHandler. deliverConfigFile
 * reads each config file back after writing it, so a mock that always
 * returns empty stdout looks like a failed (silent no-op) delivery.
 */
function installFsMock(): void {
  const files = new Map<string, string>();
  mockExecCommand.mockImplementation(async (cmd: string): Promise<SSHExecResult> => {
    let m = cmd.match(/^cat > (.+?) << 'FLEET_PERMS_EOF'\n([\s\S]*)\nFLEET_PERMS_EOF$/);
    if (m) { files.set(m[1], m[2]); return { stdout: '', stderr: '', code: 0 }; }
    m = cmd.match(/\[System\.IO\.File\]::WriteAllText\("(.+?)", '([\s\S]*)', \(New-Object System\.Text\.UTF8Encoding\(\$false\)\)\)/);
    if (m) { files.set(m[1], m[2].replace(/''/g, "'")); return { stdout: '', stderr: '', code: 0 }; }
    m = cmd.match(/^cat (.+?) 2>\/dev\/null/);
    if (m) { return { stdout: files.get(m[1]) ?? '', stderr: '', code: 0 }; }
    m = cmd.match(/Get-Content -Raw "(.+?)"/);
    if (m) { return { stdout: files.get(m[1]) ?? '', stderr: '', code: 0 }; }
    return { stdout: '', stderr: '', code: 0 };
  });
}

let tmpDir: string;

beforeEach(() => {
  backupAndResetRegistry();
  vi.clearAllMocks();
  installFsMock();
  // Same rationale as compose-permissions.test.ts: force findProfilesDir()
  // to fall through to this repo's skills/fleet/profiles rather than an
  // installed (possibly stale) copy.
  vi.spyOn(os, 'homedir').mockReturnValue('/nonexistent-test-home');
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-bounds-grant-'));
});

describe('composePermissions -- bounds-aware reactive grant (apra-fleet-ivxi.1.3)', () => {
  it('in-bounds grant: ledger entry has no outOfBounds field (recorded exactly as today)', async () => {
    const member = makeTestAgent({ friendlyName: 'doer-inbounds', llmProvider: 'claude', os: 'linux' });
    addAgent(member);

    // Bash(git:*) is listed in skills/fleet/profiles/bounds-doer.json.
    await composePermissions({
      member_id: member.id,
      role: 'doer',
      project_folder: tmpDir,
      grant: ['Bash(git:*)'],
      grant_reason: 'need git for rebase',
    });

    const ledger = loadLedger(tmpDir);
    const entry = ledger.granted.find(e => e.permission === 'Bash(git:*)');
    expect(entry).toBeDefined();
    expect(entry!.outOfBounds).toBeUndefined();
    expect(entry!.requestedByRole).toBeUndefined();
  });

  it('out-of-bounds grant: still granted, but the ledger entry is flagged outOfBounds with requestedByRole', async () => {
    const member = makeTestAgent({ friendlyName: 'doer-outofbounds', llmProvider: 'claude', os: 'linux' });
    addAgent(member);

    // Bash(docker:*) is not in bounds-doer.json.
    const result = await composePermissions({
      member_id: member.id,
      role: 'doer',
      project_folder: tmpDir,
      grant: ['Bash(docker:*)'],
      grant_reason: 'need docker mid-sprint',
    });

    // Still granted -- bounds never filter, only flag.
    expect(result).toContain('Bash(docker:*)');
    expect(result).not.toMatch(/^❌/);

    const ledger = loadLedger(tmpDir);
    const entry = ledger.granted.find(e => e.permission === 'Bash(docker:*)');
    expect(entry).toBeDefined();
    expect(entry!.outOfBounds).toBe(true);
    expect(entry!.requestedByRole).toBe('doer');
  });

  it('no role supplied: legacy path unchanged -- no bounds check, no outOfBounds flag ever', async () => {
    const member = makeTestAgent({ friendlyName: 'no-role', llmProvider: 'claude', os: 'linux' });
    addAgent(member);

    // No role field at all; tags carries the primary mode instead.
    await composePermissions({
      member_id: member.id,
      tags: ['doer'],
      project_folder: tmpDir,
      grant: ['Bash(docker:*)'],
    });

    const ledger = loadLedger(tmpDir);
    const entry = ledger.granted.find(e => e.permission === 'Bash(docker:*)');
    expect(entry).toBeDefined();
    expect(entry!.outOfBounds).toBeUndefined();
    expect(entry!.requestedByRole).toBeUndefined();
  });

  it('NEVER_AUTO_GRANT still hard-rejects a denylisted permission even with a role/bounds present', async () => {
    const member = makeTestAgent({ friendlyName: 'doer-sudo', llmProvider: 'claude', os: 'linux' });
    addAgent(member);

    const result = await composePermissions({
      member_id: member.id,
      role: 'doer',
      project_folder: tmpDir,
      grant: ['Bash(sudo:*)'],
    });

    expect(result).toMatch(/^❌ Cannot auto-grant dangerous permissions/);
    // Nothing written to the ledger, and no delivery attempted.
    expect(fs.existsSync(path.join(tmpDir, 'permissions.json'))).toBe(false);
    expect(mockExecCommand).not.toHaveBeenCalled();
  });
});
