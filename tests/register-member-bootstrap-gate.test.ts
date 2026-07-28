import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { backupAndResetRegistry, restoreRegistry } from './test-helpers.js';

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
  readMemberStatus: vi.fn(() => 'idle'),
}));

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
  });

  afterEach(() => {
    restoreRegistry();
    // maxRetries/retryDelay: on Windows, a just-exited child process (spawned
    // during registerMember()'s real connection/version/auth checks) can hold
    // an OS-level file handle open for a brief window after Node reports it
    // exited -- rmSync would otherwise intermittently fail with EBUSY.
    fs.rmSync(workFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    delete process.env.APRA_FLEET_ENABLE_INTERACTIVE_BOOTSTRAP;
    vi.resetModules();
  });

  // Generous timeout (vitest default is 5000ms): registerMember() for a
  // local member runs real subprocess-based connection/version/auth checks
  // unconditionally (strategy.testConnection(), uname/version/ps, etc.) --
  // this test only mocks the interactive-bootstrap piece being asserted on,
  // not those checks. That real subprocess work is measurably slower on
  // Windows CI runners than the default budget allows.
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

      // settings.local.json must not have been written by the (skipped) bootstrap
      const settingsPath = path.join(workFolder, '.claude', 'settings.local.json');
      expect(fs.existsSync(settingsPath)).toBe(false);
    } finally {
      __resetInteractiveBootstrapDeps();
    }
  }, 20000);

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

      const settingsPath = path.join(workFolder, '.claude', 'settings.local.json');
      expect(fs.existsSync(settingsPath)).toBe(false);
    } finally {
      __resetInteractiveBootstrapDeps();
    }
  }, 20000);
});
