import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { backupAndResetRegistry, restoreRegistry } from './test-helpers.js';

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
  readMemberStatus: vi.fn(() => 'idle'),
}));

// apra-fleet-2xs.4: the local-Claude interactive bootstrap in register-member.ts does a
// real HTTP GET (via checkRunningInstance) and, if a fleet server happens to be
// running, writes settings.local.json and spawns a real `claude` process. These tests
// verify (a) the block is skipped by default in NODE_ENV=test, and (b) when explicitly
// enabled via APRA_FLEET_ENABLE_INTERACTIVE_BOOTSTRAP=1, injected fakes are used
// instead of a real network probe / real process spawn.

describe('register-member interactive bootstrap gate', () => {
  let workFolder: string;

  beforeEach(() => {
    backupAndResetRegistry();
    workFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-bootstrap-gate-'));
  });

  afterEach(() => {
    restoreRegistry();
    fs.rmSync(workFolder, { recursive: true, force: true });
    delete process.env.APRA_FLEET_ENABLE_INTERACTIVE_BOOTSTRAP;
    vi.resetModules();
  });

  it('does NOT call checkRunningInstance or spawn a process by default under NODE_ENV=test', async () => {
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
  });

  it('uses injected fakes (no real network/spawn) when explicitly opted in via env', async () => {
    process.env.APRA_FLEET_ENABLE_INTERACTIVE_BOOTSTRAP = '1';

    const { registerMember, __setInteractiveBootstrapDeps, __resetInteractiveBootstrapDeps } =
      await import('../src/tools/register-member.js');

    const checkRunningInstance = vi.fn().mockResolvedValue({
      running: true,
      url: 'http://127.0.0.1:19999/mcp',
      pid: 12345,
    });
    const fakeProc = { pid: 424242, unref: vi.fn() };
    const spawn = vi.fn().mockReturnValue(fakeProc);
    __setInteractiveBootstrapDeps({ checkRunningInstance, spawn } as any);

    try {
      const result = await registerMember({
        friendly_name: 'gate-enabled-test',
        member_type: 'local',
        work_folder: workFolder,
        llm_provider: 'claude',
      } as any);

      expect(result).toContain('registered successfully');
      expect(checkRunningInstance).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn.mock.calls[0][0]).toBe('claude');

      const settingsPath = path.join(workFolder, '.claude', 'settings.local.json');
      expect(fs.existsSync(settingsPath)).toBe(true);
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      expect(settings.mcpServers['apra-fleet-member'].url).toContain('19999');
    } finally {
      __resetInteractiveBootstrapDeps();
    }
  });
});
