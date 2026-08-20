/**
 * Pins the auto-provisioning behaviour added in apra-fleet-5oo.1 (register_member
 * auto-runs compose_permissions for the member's role/tags) so it cannot silently
 * regress back to requiring a separate manual compose_permissions call.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupAndResetRegistry, restoreRegistry } from './test-helpers.js';

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
  readMemberStatus: vi.fn(() => 'idle'),
}));

// Wrap the real compose-permissions module in a spy so tests can both observe
// call arguments (AC1) and override the resolved value for a single case
// (AC2), while other cases fall through to the real implementation to exercise
// the actual settings-file write (AC1, AC3).
const mockComposePermissions = vi.fn();
vi.mock('../src/tools/compose-permissions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tools/compose-permissions.js')>();
  return {
    ...actual,
    composePermissions: (...args: Parameters<typeof actual.composePermissions>) => mockComposePermissions(...args),
  };
});

describe('register_member: auto-runs compose_permissions (apra-fleet-5oo.1 / apra-fleet-5oo.2)', () => {
  let workFolder: string;
  let actualCompose: typeof import('../src/tools/compose-permissions.js')['composePermissions'];

  beforeEach(async () => {
    backupAndResetRegistry();
    workFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-regmember-compose-'));
    mockComposePermissions.mockReset();
    const actual = await vi.importActual<typeof import('../src/tools/compose-permissions.js')>('../src/tools/compose-permissions.js');
    actualCompose = actual.composePermissions;
  });

  afterEach(() => {
    restoreRegistry();
    // my-beads-db-27m.13: registerMember/compose_permissions spawn several real
    // subprocesses with cwd=workFolder (LocalStrategy.execCommand); on Windows the
    // OS can briefly hold the directory handle past the child's reported exit,
    // producing a transient EBUSY on rmdir. maxRetries=5/retryDelay=100 (500ms
    // total) was not enough headroom -- widen it rather than let a timing race
    // fail the next test in the file.
    fs.rmSync(workFolder, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    vi.resetModules();
  });

  it('AC1: invokes compose_permissions with the member role/tags and writes the composed allowlist to settings', async () => {
    mockComposePermissions.mockImplementation((input: any) => actualCompose(input));

    const { registerMember } = await import('../src/tools/register-member.js');

    const result = await registerMember({
      friendly_name: 'compose-ac1-test',
      member_type: 'local',
      work_folder: workFolder,
      llm_provider: 'claude',
      tags: ['doer', 'gpu'],
    } as any);

    expect(result).toContain('registered successfully');
    expect(mockComposePermissions).toHaveBeenCalledTimes(1);
    const callArg = mockComposePermissions.mock.calls[0][0];
    expect(callArg.role).toBe('doer');
    expect(callArg.tags).toEqual(['doer', 'gpu']);
    expect(typeof callArg.member_id).toBe('string');
    expect(callArg.member_id.length).toBeGreaterThan(0);

    const settingsPath = path.join(workFolder, '.claude', 'settings.local.json');
    expect(fs.existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(Array.isArray(settings.permissions?.allow)).toBe(true);
    expect(settings.permissions.allow.length).toBeGreaterThan(0);
    // base-dev profile entry -- confirms the composed allowlist actually landed
    // in settings, not just an empty/placeholder array.
    expect(settings.permissions.allow).toContain('Bash(git:*)');
  // my-beads-db-27m.13: registerMember's real subprocess work (workspace-trust
  // seeding + compose_permissions' several real execCommand round trips) measured
  // 15-21s on a stock Windows dev host -- comfortably over the old 15000ms budget,
  // which made this a deterministic (not flaky) failure. 45000ms leaves >2x margin.
  }, 45000);

  it('AC2: reports "member not provisioned" instead of success when compose_permissions fails', async () => {
    mockComposePermissions.mockResolvedValue('compose_permissions threw: boom');

    const { registerMember } = await import('../src/tools/register-member.js');

    const result = await registerMember({
      friendly_name: 'compose-ac2-test',
      member_type: 'local',
      work_folder: workFolder,
      llm_provider: 'claude',
    } as any);

    expect(result).toContain('ERROR: member not provisioned');
    expect(result).not.toContain('registered successfully');
    expect(result).toContain('boom');

    // Refusal, not success-with-caveat: no settings file should have been
    // partially written by a later step that assumed provisioning succeeded.
    const settingsPath = path.join(workFolder, '.claude', 'settings.local.json');
    expect(fs.existsSync(settingsPath)).toBe(false);
  // my-beads-db-27m.13: composePermissions is mocked here, but registerMember's own
  // pre-compose real subprocess work (connection/version checks, agent provisioning,
  // workspace-trust seeding) still measured ~8s on a stock Windows dev host --
  // already over vitest's 5000ms default. 20000ms leaves >2x margin.
  }, 20000);

  it('AC3: re-running compose_permissions for the same member is idempotent -- no duplicate allow entries, unrelated settings keys preserved', async () => {
    // Runs a full registerMember() (which itself invokes the real compose_permissions
    // and workspace-trust seeding) plus a second real compose_permissions call --
    // measured ~33s on a stock Windows dev host, comfortably exceeding vitest's
    // 5000ms default. 60000ms leaves ~2x margin (my-beads-db-27m.13).
    mockComposePermissions.mockImplementation((input: any) => actualCompose(input));

    const { registerMember } = await import('../src/tools/register-member.js');

    const result = await registerMember({
      friendly_name: 'compose-ac3-test',
      member_type: 'local',
      work_folder: workFolder,
      llm_provider: 'claude',
      tags: ['doer'],
    } as any);
    expect(result).toContain('registered successfully');

    const settingsPath = path.join(workFolder, '.claude', 'settings.local.json');
    const before = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));

    // Seed an unrelated settings key (as another tool sharing this file might)
    // that a re-run of compose_permissions must preserve, not clobber.
    before.mcpServers = { ...(before.mcpServers ?? {}), 'apra-fleet-member': { unrelated: true } };
    fs.writeFileSync(settingsPath, JSON.stringify(before, null, 2));

    // Simulate re-registration (or any later re-run) invoking compose_permissions
    // again for the same member/role/tags.
    await actualCompose({ member_name: 'compose-ac3-test', role: 'doer', tags: ['doer'] });

    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const uniqueAllow = new Set(after.permissions.allow);
    expect(after.permissions.allow.length).toBe(uniqueAllow.size);
    expect(after.permissions.allow.length).toBe(before.permissions.allow.length);
    expect(after.mcpServers['apra-fleet-member']).toEqual({ unrelated: true });
  }, 60000);
});
