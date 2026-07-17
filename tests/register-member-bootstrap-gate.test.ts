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
  }, 20000);

  // Same real-subprocess-work rationale as the test above.
  it('uses injected fakes (no real network/spawn/CLI call) when explicitly opted in via env', async () => {
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
    // apra-fleet-fnz.1: registration now goes through the provider's own
    // registerMcpEndpoint() (real Claude implementation shells out to
    // `claude mcp add`) instead of hand-writing settings.local.json -- inject
    // a fake provider so this test never spawns a real `claude` CLI process.
    const registerMcpEndpoint = vi.fn().mockResolvedValue({ mechanism: 'cli-verb', detail: 'fake' });
    const getProvider = vi.fn().mockReturnValue({ name: 'claude', registerMcpEndpoint });
    __setInteractiveBootstrapDeps({ checkRunningInstance, spawn, getProvider } as any);

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
      expect(registerMcpEndpoint).toHaveBeenCalledTimes(1);

      const call = registerMcpEndpoint.mock.calls[0][0];
      expect(call.url).toContain('19999');
      expect(call.scope).toBe('project');
      expect(call.workFolder).toBe(workFolder);

      // apra-fleet-2xs.2: identity is keyed on the member UUID -- the URL
      // fallback param must be the UUID, not the friendly name, and the JWT
      // must carry the workspace_id hard boundary minted by the local issuer.
      const { findAgentByName } = await import('../src/services/registry.js');
      const agent = findAgentByName('gate-enabled-test');
      expect(agent).toBeDefined();
      expect(call.url).toBe(`http://127.0.0.1:19999/mcp?member=${agent!.id}`);

      const { verify } = await import('../src/services/jwt.js');
      const { localWorkspaceId } = await import('../src/services/token-issuer.js');
      const claims = verify(call.token);
      expect(claims).not.toBeNull();
      expect(claims!.member_id).toBe(agent!.id);
      expect(claims!.workspace_id).toBe(localWorkspaceId());

      // settings.local.json must NOT be hand-written anymore -- registration
      // now goes exclusively through the provider adapter.
      const settingsPath = path.join(workFolder, '.claude', 'settings.local.json');
      expect(fs.existsSync(settingsPath)).toBe(false);
    } finally {
      __resetInteractiveBootstrapDeps();
    }
  }, 20000);
});
