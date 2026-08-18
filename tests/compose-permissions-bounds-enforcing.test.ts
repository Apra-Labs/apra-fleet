/**
 * apra-fleet PR#416 review, finding 3 (option 3B): per-role bounds are
 * ENFORCING on the autonomous grant path.
 *
 * The sibling files (compose-permissions-bounds-grant / -matrix) deliberately
 * point `os.homedir()` at a nonexistent path so findProfilesDir() falls
 * through to this repo's own skills/fleet/profiles. That dev fallback is NOT a
 * trust boundary -- in a dogfood configuration it resolves inside the checkout
 * a sprint can write to -- so the bounds check downgrades itself to
 * informational there, which is exactly why those files still observe the old
 * non-blocking behavior and are still correct.
 *
 * This file installs a real profiles directory under a temporary HOME, which
 * is the configuration the enforcement is designed for.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTestAgent, backupAndResetRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { composePermissions, loadLedger } from '../src/tools/compose-permissions.js';
import type { SSHExecResult } from '../src/types.js';

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({ execCommand: mockExecCommand }),
}));

/** Same stateful in-memory member filesystem the sibling bounds tests use. */
function installFsMock(): void {
  const files = new Map<string, string>();
  mockExecCommand.mockImplementation(async (cmd: string): Promise<SSHExecResult> => {
    let m = cmd.match(/^cat > (.+?) << 'FLEET_PERMS_EOF'\n([\s\S]*)\nFLEET_PERMS_EOF$/);
    if (m) { files.set(m[1]!, m[2]!); return { stdout: '', stderr: '', code: 0 }; }
    m = cmd.match(/^cat (.+?) 2>\/dev\/null/);
    if (m) { return { stdout: files.get(m[1]!) ?? '', stderr: '', code: 0 }; }
    return { stdout: '', stderr: '', code: 0 };
  });
}

let fakeHome: string;
let tmpDir: string;
let profilesDir: string;

beforeEach(() => {
  backupAndResetRegistry();
  vi.clearAllMocks();
  installFsMock();
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-bounds-home-'));
  profilesDir = path.join(fakeHome, '.claude', 'skills', 'fleet', 'profiles');
  fs.mkdirSync(profilesDir, { recursive: true });
  // An INSTALLED, host-side bounds profile -- the real trust boundary.
  fs.writeFileSync(
    path.join(profilesDir, 'bounds-deployer.json'),
    JSON.stringify(['Bash(npm ci)', 'Bash(npm run build*)', 'Bash(docker:*)']),
  );
  vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-bounds-enforcing-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(fakeHome, { recursive: true, force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function deployer(name: string) {
  const member = makeTestAgent({ friendlyName: name, llmProvider: 'claude', os: 'linux' });
  addAgent(member);
  return member;
}

describe('compose_permissions -- enforcing per-role bounds (installed profiles dir)', () => {
  it('REJECTS an out-of-bounds grant for a role that has a bounds file', async () => {
    const member = deployer('deployer-oob');
    const result = await composePermissions({
      member_id: member.id,
      role: 'deployer',
      project_folder: tmpDir,
      grant: ['Bash(npm ci)', 'Bash(terraform apply *)'],
      grant_reason: 'heal',
    });

    expect(result).toMatch(/^❌ Out of bounds for role "deployer"/);
    expect(result).toContain('Bash(terraform apply *)');
    // The in-bounds sibling must NOT be named as a violation.
    expect(result).not.toContain('Bash(npm ci),');
    // Nothing was delivered and nothing was written to the ledger: the whole
    // request is refused, not partially applied.
    expect(loadLedger(tmpDir).granted).toHaveLength(0);
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('grants an in-bounds request normally, with no outOfBounds flag', async () => {
    const member = deployer('deployer-inbounds');
    const result = await composePermissions({
      member_id: member.id,
      role: 'deployer',
      project_folder: tmpDir,
      grant: ['Bash(npm run build:binary)'],
      grant_reason: 'heal',
    });

    expect(result).toMatch(/^✅ Granted/);
    const granted = loadLedger(tmpDir).granted;
    expect(granted).toHaveLength(1);
    expect(granted[0]!.permission).toBe('Bash(npm run build:binary)');
    expect(granted[0]!.outOfBounds).toBeUndefined();
  });

  it('allow_out_of_bounds: true downgrades the rejection to the informational ledger flag (operator escalation)', async () => {
    const member = deployer('deployer-override');
    const result = await composePermissions({
      member_id: member.id,
      role: 'deployer',
      project_folder: tmpDir,
      grant: ['Bash(terraform apply *)'],
      grant_reason: 'deliberate operator grant',
      allow_out_of_bounds: true,
    });

    expect(result).toMatch(/^✅ Granted/);
    const entry = loadLedger(tmpDir).granted.find(e => e.permission === 'Bash(terraform apply *)');
    expect(entry?.outOfBounds).toBe(true);
    expect(entry?.requestedByRole).toBe('deployer');
  });

  it('a role-less (manual) grant is never bounds-checked -- the denylist is its only gate', async () => {
    const member = deployer('norole-manual');
    const result = await composePermissions({
      member_id: member.id,
      tags: ['doer'],
      project_folder: tmpDir,
      grant: ['Bash(terraform apply *)'],
      grant_reason: 'manual',
    });

    expect(result).toMatch(/^✅ Granted/);
    const entry = loadLedger(tmpDir).granted.find(e => e.permission === 'Bash(terraform apply *)');
    expect(entry?.outOfBounds).toBeUndefined();
  });

  it('a role with NO bounds file is never bounds-checked (defined-empty means no check, not deny-all)', async () => {
    const member = deployer('reviewer-nobounds');
    // Only bounds-deployer.json was installed above.
    const result = await composePermissions({
      member_id: member.id,
      role: 'reviewer',
      project_folder: tmpDir,
      grant: ['Bash(terraform apply *)'],
      grant_reason: 'manual',
    });

    expect(result).toMatch(/^✅ Granted/);
  });

  it('the NEVER_AUTO_GRANT denylist still runs FIRST -- before any bounds lookup', async () => {
    const member = deployer('deployer-denylist');
    // Deliberately widen the bounds file so only the denylist can reject this.
    fs.writeFileSync(path.join(profilesDir, 'bounds-deployer.json'), JSON.stringify(['Bash(*)', 'Bash(sudo *)']));
    const result = await composePermissions({
      member_id: member.id,
      role: 'deployer',
      project_folder: tmpDir,
      grant: ['Bash(sudo apt-get install *)'],
      grant_reason: 'heal',
      // Even an operator override must not get past the denylist.
      allow_out_of_bounds: true,
    });

    expect(result).toMatch(/^❌ Cannot auto-grant dangerous permissions/);
  });

  it('an out-of-bounds CO_OCCURRENCE expansion is DROPPED, not turned into a rejection', async () => {
    const member = deployer('deployer-cooccurrence');
    // Bash(docker:*) is in bounds; its expansions (docker-compose, buildx) are not.
    const result = await composePermissions({
      member_id: member.id,
      role: 'deployer',
      project_folder: tmpDir,
      grant: ['Bash(docker:*)'],
      grant_reason: 'heal',
    });

    expect(result).toMatch(/^✅ Granted/);
    expect(result).toContain('dropped 2 co-occurrence expansion(s)');
    const permissions = loadLedger(tmpDir).granted.map(e => e.permission);
    expect(permissions).toContain('Bash(docker:*)');
    expect(permissions).not.toContain('Bash(docker-compose:*)');
    expect(permissions).not.toContain('Bash(docker buildx:*)');
  });
});

describe('compose_permissions -- the repo-relative dev fallback is NOT a trust boundary', () => {
  it('warns loudly and downgrades bounds to informational when no installed profiles dir exists', async () => {
    // No installed skill: force findProfilesDir() onto its dev fallback, which
    // in a dogfood configuration resolves inside the sprint-writable checkout.
    vi.spyOn(os, 'homedir').mockReturnValue(path.join(fakeHome, 'no-such-home'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const member = deployer('deployer-devfallback');

    const result = await composePermissions({
      member_id: member.id,
      role: 'deployer',
      project_folder: tmpDir,
      // Out of THIS repo's bounds-deployer.json, which the fallback resolves to.
      grant: ['Bash(terraform apply *)'],
      grant_reason: 'heal',
    });

    expect(result).toMatch(/^✅ Granted/);
    const entry = loadLedger(tmpDir).granted.find(e => e.permission === 'Bash(terraform apply *)');
    expect(entry?.outOfBounds).toBe(true);
    const warned = warn.mock.calls.map(c => String(c[0])).join('\n');
    expect(warned).toContain('REPO-RELATIVE dev path');
    expect(warned).toContain('not a trust boundary');
  });
});
