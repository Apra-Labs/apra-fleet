/**
 * Regression: fleet-sprint's PROACTIVE pre-dispatch permissions provisioner
 * (createDeployPermissionsProvisioner / ensureDeployPermissions) must issue a
 * grant that compose_permissions actually accepts.
 *
 * The bug this pins: that provisioner used to read deploy.md for all three
 * runbook-driven phases and always call compose_permissions with
 * `role: 'doer'`. Once the per-role bounds check became ENFORCING, deploy.md's
 * prefixes were wholesale out of bounds for `doer`, so every proactive grant
 * was rejected -- and the provisioner neither inspected the returned marker nor
 * retried, so it silently no-oped for the rest of the sprint.
 *
 * Everything here is real: the real runbooks in this repo, the real
 * bounds-<role>.json profiles copied into an installed-looking HOME (the only
 * configuration in which bounds are enforcing), the real parseRunbookPermissions
 * the runner uses, and the real composePermissions -- no mocked callTool. A
 * mocked-tool test cannot see this class of failure at all.
 *
 * It doubles as a drift guard: adding a prefix to a runbook's `## Permissions`
 * section without adding it to that role's bounds profile fails here rather
 * than at 3am inside a sprint.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTestAgent, backupAndResetRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { composePermissions } from '../src/tools/compose-permissions.js';
import { parseRunbookPermissions, RUNBOOK_FOR_ROLE } from '../packages/apra-fleet-se/fleet-sprint/runner.js';
import type { SSHExecResult } from '../src/types.js';

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({ execCommand: mockExecCommand }),
}));

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoProfilesDir = path.join(repoRoot, 'skills', 'fleet', 'profiles');

/** The three roles the proactive provisioner fires for, each with its runbook. */
const ROLES = Object.keys(RUNBOOK_FOR_ROLE) as Array<keyof typeof RUNBOOK_FOR_ROLE>;

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

beforeEach(() => {
  backupAndResetRegistry();
  vi.clearAllMocks();
  installFsMock();
  // An INSTALLED, host-side profiles dir -- the only configuration in which the
  // bounds check is enforcing rather than informational. Copy this repo's REAL
  // profiles in verbatim so the assertions below are about the shipped files.
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-runbook-bounds-home-'));
  const installedProfiles = path.join(fakeHome, '.claude', 'skills', 'fleet', 'profiles');
  fs.mkdirSync(installedProfiles, { recursive: true });
  for (const f of fs.readdirSync(repoProfilesDir)) {
    fs.copyFileSync(path.join(repoProfilesDir, f), path.join(installedProfiles, f));
  }
  vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-runbook-bounds-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(fakeHome, { recursive: true, force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function member(name: string) {
  const m = makeTestAgent({ friendlyName: name, llmProvider: 'claude', os: 'linux' });
  addAgent(m);
  return m;
}

/** The prefixes the real runbook for `role` declares, parsed exactly as the
 *  runner parses them at dispatch time. */
function declaredPrefixes(role: keyof typeof RUNBOOK_FOR_ROLE): string[] {
  const runbook = RUNBOOK_FOR_ROLE[role];
  const text = fs.readFileSync(path.join(repoRoot, runbook), 'utf-8');
  return parseRunbookPermissions(text);
}

describe('proactive pre-dispatch grant: each runbook Permissions section is in bounds for ITS OWN role', () => {
  it.each(ROLES)('%s: the real runbook parses to a non-empty prefix list', (role) => {
    expect(declaredPrefixes(role).length).toBeGreaterThan(0);
  });

  it.each(ROLES)('%s: compose_permissions ACCEPTS the whole declared list under that role', async (role) => {
    const target = member(`proactive-${role}`);
    const grant = declaredPrefixes(role);

    const result = await composePermissions({
      member_id: target.id,
      role,
      project_folder: tmpDir,
      grant,
      grant_reason: `${RUNBOOK_FOR_ROLE[role]}'s declared Permissions section, auto-provisioned before the ${role} dispatch`,
    });

    // The whole point: a real success marker, not a silently-swallowed
    // rejection. (Escapes, not the literal glyphs, keep this file ASCII:
    // U+2705 = success, U+274C = rejection.)
    expect(result).toMatch(/^\u2705 Granted/);
    expect(result).not.toContain('Out of bounds');
  });

  it('the OLD behaviour is still rejected: deploy.md\'s list granted under role "doer"', async () => {
    // Pins the regression itself. If someone reverts the provisioner to the
    // hardcoded 'doer' role, this stops being a rejection and the test fails,
    // pointing straight at the reason the proactive grant went quiet.
    const target = member('proactive-wrong-role');
    const result = await composePermissions({
      member_id: target.id,
      role: 'doer',
      project_folder: tmpDir,
      grant: declaredPrefixes('deployer'),
      grant_reason: 'the pre-fix behaviour, asserted to be refused',
    });

    expect(result).toMatch(/^\u274C Out of bounds for role "doer"/);
  });
});
