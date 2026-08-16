/**
 * apra-fleet-ivxi.1.5: compose_permissions bounds check -- discrete assertions
 * for the five required cases (in-bounds, out-of-bounds, no-role, denylist,
 * and old-shape ledger replay). loadBounds/isWithinBounds (ivxi.1.1), the
 * ledger's outOfBounds/requestedByRole fields (ivxi.1.2), and the grant-path
 * wiring (ivxi.1.3) are exercised elsewhere too (compose-permissions-bounds.test.ts,
 * compose-permissions-bounds-grant.test.ts, compose-permissions-ledger-shape.test.ts)
 * -- this file collects all five cases from the acceptance criteria together so
 * each is a single, unambiguous, independently-named assertion.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTestAgent, backupAndResetRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { composePermissions, loadLedger, saveLedger } from '../src/tools/compose-permissions.js';
import type { SSHExecResult } from '../src/types.js';

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
  }),
}));

/** Stateful in-memory filesystem mock -- same shape as the sibling bounds test files. */
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
  // Force findProfilesDir() to fall through to this repo's skills/fleet/profiles
  // rather than a possibly-stale installed copy (same rationale as the sibling
  // bounds test files).
  vi.spyOn(os, 'homedir').mockReturnValue('/nonexistent-test-home');
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-bounds-matrix-'));
});

describe('compose_permissions bounds check matrix (apra-fleet-ivxi.1.5)', () => {
  it('case 1: in-bounds grant for a known role -- ledger entry has no outOfBounds field', async () => {
    const member = makeTestAgent({ friendlyName: 'matrix-inbounds', llmProvider: 'claude', os: 'linux' });
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
    expect(entry, 'invariant: in-bounds grant must be recorded').toBeDefined();
    expect(entry!.outOfBounds, 'invariant: in-bounds grant must not carry outOfBounds').toBeUndefined();
    expect(entry!.requestedByRole, 'invariant: in-bounds grant must not carry requestedByRole').toBeUndefined();
  });

  it('case 2: out-of-bounds grant for a known role -- still granted AND ledger entry flagged outOfBounds+requestedByRole', async () => {
    const member = makeTestAgent({ friendlyName: 'matrix-outofbounds', llmProvider: 'claude', os: 'linux' });
    addAgent(member);

    // Bash(docker:*) is not in bounds-doer.json.
    const result = await composePermissions({
      member_id: member.id,
      role: 'doer',
      project_folder: tmpDir,
      grant: ['Bash(docker:*)'],
      grant_reason: 'need docker mid-sprint',
    });

    expect(result, 'invariant: out-of-bounds permission must still be granted, not blocked').toContain('Bash(docker:*)');
    expect(result, 'invariant: out-of-bounds grant must not be reported as a denylist rejection').not.toMatch(/^❌/);

    const ledger = loadLedger(tmpDir);
    const entry = ledger.granted.find(e => e.permission === 'Bash(docker:*)');
    expect(entry, 'invariant: out-of-bounds grant must be recorded').toBeDefined();
    expect(entry!.outOfBounds, 'invariant: out-of-bounds grant must be flagged outOfBounds:true').toBe(true);
    expect(entry!.requestedByRole, 'invariant: out-of-bounds grant must record the requesting role').toBe('doer');
  });

  it('case 3: grant with no role -- identical output/ledger shape to pre-change behaviour (no bounds fields at all)', async () => {
    const member = makeTestAgent({ friendlyName: 'matrix-norole', llmProvider: 'claude', os: 'linux' });
    addAgent(member);

    // No role field; tags carries the primary mode instead, so no bounds file is consulted.
    const result = await composePermissions({
      member_id: member.id,
      tags: ['doer'],
      project_folder: tmpDir,
      grant: ['Bash(docker:*)'],
    });

    expect(result, 'invariant: a no-role grant must still succeed').toContain('Bash(docker:*)');

    const ledger = loadLedger(tmpDir);
    const entry = ledger.granted.find(e => e.permission === 'Bash(docker:*)');
    expect(entry, 'invariant: no-role grant must be recorded').toBeDefined();
    expect(entry!.outOfBounds, 'invariant: no-role grant must never be bounds-checked').toBeUndefined();
    expect(entry!.requestedByRole, 'invariant: no-role grant must never record a requesting role').toBeUndefined();
  });

  it('case 4: NEVER_AUTO_GRANT prefix requested by a role -- still hard-rejected even though no bounds file would list it as covered', async () => {
    const member = makeTestAgent({ friendlyName: 'matrix-denylist', llmProvider: 'claude', os: 'linux' });
    addAgent(member);

    const result = await composePermissions({
      member_id: member.id,
      role: 'doer',
      project_folder: tmpDir,
      grant: ['Bash(sudo:*)'],
    });

    expect(result, 'invariant: NEVER_AUTO_GRANT must reject before any bounds check runs').toMatch(/^❌ Cannot auto-grant dangerous permissions/);
    expect(fs.existsSync(path.join(tmpDir, 'permissions.json')), 'invariant: a rejected grant must never touch the ledger').toBe(false);
    expect(mockExecCommand, 'invariant: a rejected grant must never attempt delivery').not.toHaveBeenCalled();
  });

  it('case 5: loading an existing old-shape permissions.json succeeds and its grants replay unchanged', async () => {
    // Pre-seed an old-shape ledger: granted entries with only permission/reason/date,
    // no outOfBounds/requestedByRole fields at all (as written by a pre-bounds version).
    const oldShape = {
      stacks: ['node'],
      granted: [
        { permission: 'Bash(docker:*)', reason: 'needed for build', date: '2026-01-01' },
      ],
    };
    fs.writeFileSync(path.join(tmpDir, 'permissions.json'), JSON.stringify(oldShape, null, 2));

    // Loading it directly must succeed with no error and no spuriously-added fields.
    const loaded = loadLedger(tmpDir);
    expect(loaded.granted, 'invariant: old-shape ledger must load without error').toHaveLength(1);
    expect(loaded.granted[0].outOfBounds, 'invariant: old-shape entries must not gain a spurious outOfBounds flag').toBeUndefined();
    expect(loaded.granted[0].requestedByRole, 'invariant: old-shape entries must not gain a spurious requestedByRole').toBeUndefined();

    // Round-tripping through save/load must also replay the grant unchanged.
    saveLedger(tmpDir, loaded);
    const reloaded = loadLedger(tmpDir);
    expect(reloaded.granted[0]).toEqual(loaded.granted[0]);

    // A full proactive compose_permissions run (which merges ledger.granted into
    // the delivered allow list) must succeed against this old-shape ledger too --
    // no exception, no dropped grant.
    const member = makeTestAgent({ friendlyName: 'matrix-oldshape', llmProvider: 'claude', os: 'linux' });
    addAgent(member);
    const result = await composePermissions({
      member_id: member.id,
      role: 'doer',
      project_folder: tmpDir,
    });
    expect(result, 'invariant: proactive compose must succeed against an old-shape ledger').not.toMatch(/^❌/);

    const finalLedger = loadLedger(tmpDir);
    const replayed = finalLedger.granted.find(e => e.permission === 'Bash(docker:*)');
    expect(replayed, 'invariant: the old-shape grant must still be present after a compose run').toBeDefined();
    expect(replayed!.reason, 'invariant: the old-shape grant fields must replay unchanged').toBe('needed for build');
    expect(replayed!.date, 'invariant: the old-shape grant fields must replay unchanged').toBe('2026-01-01');
    expect(replayed!.outOfBounds, 'invariant: replaying an old-shape grant must not retroactively flag it').toBeUndefined();
  });
});
