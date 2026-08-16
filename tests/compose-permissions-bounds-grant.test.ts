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

  it('trailing-wildcard bounds entry covers a matching grant (apra-fleet-ivxi.2)', async () => {
    const member = makeTestAgent({ friendlyName: 'doer-wildcard-trailing', llmProvider: 'claude', os: 'linux' });
    addAgent(member);

    // bounds-doer.json has "Bash(npm run build*)" -- a bare "Bash(npm run build)"
    // grant must be recognised as in-bounds, not exact-string mismatched.
    await composePermissions({
      member_id: member.id,
      role: 'doer',
      project_folder: tmpDir,
      grant: ['Bash(npm run build)'],
    });

    const ledger = loadLedger(tmpDir);
    const entry = ledger.granted.find(e => e.permission === 'Bash(npm run build)');
    expect(entry).toBeDefined();
    expect(entry!.outOfBounds).toBeUndefined();
    expect(entry!.requestedByRole).toBeUndefined();
  });

  it('mid-string wildcard bounds entry covers a matching grant (apra-fleet-ivxi.2)', async () => {
    const member = makeTestAgent({ friendlyName: 'deployer-wildcard-midstring', llmProvider: 'claude', os: 'linux' });
    addAgent(member);

    // bounds-deployer.json has "Bash(*apra-fleet* run *)".
    await composePermissions({
      member_id: member.id,
      role: 'deployer',
      project_folder: tmpDir,
      grant: ['Bash(npx apra-fleet-cli run sprint)'],
    });

    const ledger = loadLedger(tmpDir);
    const entry = ledger.granted.find(e => e.permission === 'Bash(npx apra-fleet-cli run sprint)');
    expect(entry).toBeDefined();
    expect(entry!.outOfBounds).toBeUndefined();
    expect(entry!.requestedByRole).toBeUndefined();
  });

  it('a genuinely out-of-bounds grant is still flagged when wildcard matching is in play (apra-fleet-ivxi.2)', async () => {
    const member = makeTestAgent({ friendlyName: 'deployer-genuinely-oob', llmProvider: 'claude', os: 'linux' });
    addAgent(member);

    // "Bash(rm -rf /)" matches none of bounds-deployer.json's patterns.
    const result = await composePermissions({
      member_id: member.id,
      role: 'deployer',
      project_folder: tmpDir,
      grant: ['Bash(rm -rf /)'],
    });
    expect(result).not.toMatch(/^❌/);

    const ledger = loadLedger(tmpDir);
    const entry = ledger.granted.find(e => e.permission === 'Bash(rm -rf /)');
    expect(entry).toBeDefined();
    expect(entry!.outOfBounds).toBe(true);
    expect(entry!.requestedByRole).toBe('deployer');
  });

  it('a CO_OCCURRENCE-expanded permission the caller never explicitly requested is still individually bounds-checked', async () => {
    const member = makeTestAgent({ friendlyName: 'doer-cooccurrence', llmProvider: 'claude', os: 'linux' });
    addAgent(member);

    // Requesting Bash(docker:*) expands (CO_OCCURRENCE) to also grant
    // Bash(docker-compose:*) and Bash(docker buildx:*), neither of which the
    // caller listed explicitly nor which bounds-doer.json covers.
    await composePermissions({
      member_id: member.id,
      role: 'doer',
      project_folder: tmpDir,
      grant: ['Bash(docker:*)'],
    });

    const ledger = loadLedger(tmpDir);
    const composeEntry = ledger.granted.find(e => e.permission === 'Bash(docker-compose:*)');
    expect(composeEntry).toBeDefined();
    expect(composeEntry!.outOfBounds).toBe(true);
    expect(composeEntry!.requestedByRole).toBe('doer');

    const buildxEntry = ledger.granted.find(e => e.permission === 'Bash(docker buildx:*)');
    expect(buildxEntry).toBeDefined();
    expect(buildxEntry!.outOfBounds).toBe(true);
    expect(buildxEntry!.requestedByRole).toBe('doer');
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
