import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { backupAndResetRegistry, restoreRegistry } from './test-helpers.js';

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
  readMemberStatus: vi.fn(() => 'idle'),
}));

// my-beads-db-27m.15: this file previously ran the REAL compose_permissions
// step (several real execCommand subprocess round trips, ~15-30s observed --
// see tests/register-member.test.ts / my-beads-db-27m.13) as an unavoidable
// side effect of exercising registerMember() end to end, even though neither
// test here asserts anything about compose_permissions' own behavior -- only
// that the interactive-bootstrap gate (checkRunningInstance/spawn) is never
// reached. That made both tests dependent on real subprocess wall-clock time,
// which was fine in isolation but pushed past budget under full-suite
// parallel load (CPU contention from other files' concurrent real subprocess
// work). Mock it out to a cheap stand-in that still satisfies the one
// contract these tests DO check -- settings.local.json exists afterwards --
// without paying for the real permission-composition work.
const mockComposePermissions = vi.fn();
vi.mock('../src/tools/compose-permissions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tools/compose-permissions.js')>();
  return {
    ...actual,
    composePermissions: (...args: Parameters<typeof actual.composePermissions>) => mockComposePermissions(...args),
  };
});

// apra-fleet-2xs.4 / follow-up: the local-Claude interactive bootstrap in
// register-member.ts does a real HTTP GET (via checkRunningInstance) and, if a
// fleet server happens to be running, spawns a real detached `claude` process
// via the member's provider adapter. It is unconditionally disabled
// (interactiveBootstrapEnabled() always returns false) because remove_member
// never kills that spawned process and there is no register_member input to
// opt out per call -- these tests verify it stays off in every environment,
// including one that previously would have opted it back in.

describe('register-member interactive bootstrap gate', () => {
  let workFolder: string;

  beforeEach(() => {
    backupAndResetRegistry();
    workFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-bootstrap-gate-'));
    mockComposePermissions.mockReset();
    // Cheap stand-in for the real compose_permissions step (my-beads-db-27m.15):
    // writes the same settings.local.json shape these tests assert on, without
    // the real permission-composition subprocess work.
    mockComposePermissions.mockImplementation(async () => {
      const settingsDir = path.join(workFolder, '.claude');
      fs.mkdirSync(settingsDir, { recursive: true });
      fs.writeFileSync(
        path.join(settingsDir, 'settings.local.json'),
        JSON.stringify({ permissions: { allow: ['Bash(git:*)'] } }, null, 2),
      );
      return '✅ composed permissions (mocked -- my-beads-db-27m.15)';
    });
  });

  afterEach(() => {
    restoreRegistry();
    // maxRetries/retryDelay: on Windows, a just-exited child process (spawned
    // during registerMember()'s real connection/version/auth checks) can hold
    // an OS-level file handle open for a brief window after Node reports it
    // exited -- rmSync would otherwise intermittently fail with EBUSY.
    fs.rmSync(workFolder, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    delete process.env.APRA_FLEET_ENABLE_INTERACTIVE_BOOTSTRAP;
    vi.resetModules();
  });

  // Generous timeout (vitest default is 5000ms): registerMember() for a
  // local member still runs real subprocess-based connection/version/auth
  // checks and workspace-trust seeding unconditionally (compose_permissions
  // itself is now mocked -- my-beads-db-27m.15 -- but those other real steps
  // are not, since this test isn't asserting anything about them). That real
  // subprocess work is measurably slower on Windows CI runners than the
  // default budget allows, especially under full-suite parallel load.
  it('does NOT call checkRunningInstance or spawn a process under NODE_ENV=test', async () => {
    expect(process.env.NODE_ENV).toBe('test');
    delete process.env.APRA_FLEET_ENABLE_INTERACTIVE_BOOTSTRAP;

    const { registerMember, __setInteractiveBootstrapDeps, __resetInteractiveBootstrapDeps } =
      await import('../src/tools/register-member.js');

    const checkRunningInstance = vi.fn();
    const spawn = vi.fn();
    __setInteractiveBootstrapDeps({ checkRunningInstance, spawn } as any);

    try {
      const result = await registerMember({
        friendly_name: 'gate-default-test',
        member_type: 'local',
        work_folder: workFolder,
        llm_provider: 'claude',
      } as any);

      expect(result).toContain('registered successfully');
      expect(checkRunningInstance).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();

      // settings.local.json IS now written -- but by the auto-run
      // compose_permissions step (apra-fleet-5oo.1), not by the (skipped)
      // interactive bootstrap. Assert the bootstrap-specific artifact
      // (the mcpServers['apra-fleet-member'] entry it would have written)
      // is absent, rather than asserting the whole file is absent.
      const settingsPath = path.join(workFolder, '.claude', 'settings.local.json');
      expect(fs.existsSync(settingsPath)).toBe(true);
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      expect(settings?.mcpServers?.['apra-fleet-member']).toBeUndefined();
    } finally {
      __resetInteractiveBootstrapDeps();
    }
  }, 30000);

  // Regression guard: interactiveBootstrapEnabled() used to opt back in under
  // APRA_FLEET_ENABLE_INTERACTIVE_BOOTSTRAP=1 -- it no longer does. This proves
  // the env var has no effect anymore, i.e. the feature stays off unconditionally.
  it('stays disabled even with APRA_FLEET_ENABLE_INTERACTIVE_BOOTSTRAP=1 set', async () => {
    process.env.APRA_FLEET_ENABLE_INTERACTIVE_BOOTSTRAP = '1';

    const { registerMember, __setInteractiveBootstrapDeps, __resetInteractiveBootstrapDeps } =
      await import('../src/tools/register-member.js');

    const checkRunningInstance = vi.fn();
    const spawn = vi.fn();
    __setInteractiveBootstrapDeps({ checkRunningInstance, spawn } as any);

    try {
      const result = await registerMember({
        friendly_name: 'gate-env-set-still-off-test',
        member_type: 'local',
        work_folder: workFolder,
        llm_provider: 'claude',
      } as any);

      expect(result).toContain('registered successfully');
      expect(checkRunningInstance).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();

      // Same rationale as above: settings.local.json now legitimately exists
      // (compose_permissions auto-run), but must not carry the bootstrap's
      // mcpServers['apra-fleet-member'] entry.
      const settingsPath = path.join(workFolder, '.claude', 'settings.local.json');
      expect(fs.existsSync(settingsPath)).toBe(true);
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      expect(settings?.mcpServers?.['apra-fleet-member']).toBeUndefined();
    } finally {
      __resetInteractiveBootstrapDeps();
    }
  }, 30000);
});
