/**
 * rmkb-3n5.5.2: register_member must probe SSH remote (reverse) port
 * forwarding ONCE for a remote member and record the answer on the agent
 * record, so the dispatch path can decide whether to open a tunnel by reading
 * the flag instead of re-probing per prompt.
 *
 * The probe is exercised through the injectable dependency
 * (__setTcpForwardingProbeDeps) -- registration's own gate skips the real
 * ssh2 call under NODE_ENV=test unless a fake has been injected, so no unit
 * test ever opens a real SSH connection to a fixture host.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { backupAndResetRegistry, restoreRegistry, makeConfigAwareExec } from './test-helpers.js';
import {
  registerMember,
  __setTcpForwardingProbeDeps,
  __resetTcpForwardingProbeDeps,
} from '../src/tools/register-member.js';
import { TcpForwardingRefusedError, ReverseTunnelTransportError } from '../src/services/ssh.js';
import { getAllAgents } from '../src/services/registry.js';
import type { SSHExecResult } from '../src/types.js';

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();
const mockTestConnection = vi.fn();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: mockTestConnection,
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
}));

vi.mock('../src/services/agent-provisioner.js', () => ({
  provisionAgents: vi.fn(async () => ({ pushed: [] })),
}));

vi.mock('../src/utils/workspace-trust.js', () => ({
  seedWorkspaceTrust: vi.fn(async () => undefined),
}));

const REMOTE_INPUT = {
  friendly_name: 'fwd-probe-remote',
  member_type: 'remote' as const,
  host: '10.102.10.65',
  username: 'developer',
  work_folder: '/home/developer/apra-fleet',
  auth_type: 'password' as const,
  password: 'pw',
};

describe('register_member: SSH TCP-forwarding capability probe (rmkb-3n5.5.2)', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 7 });
    mockExecCommand.mockImplementation(makeConfigAwareExec());
  });

  afterEach(() => {
    __resetTcpForwardingProbeDeps();
    restoreRegistry();
  });

  it('probes exactly once for a remote member and records the capability as true', async () => {
    const close = vi.fn(async () => undefined);
    const openReverseTunnel = vi.fn(async () => ({ remotePort: 41234, localPort: 7523, close }));
    __setTcpForwardingProbeDeps({ openReverseTunnel: openReverseTunnel as any });

    const result = await registerMember({ ...REMOTE_INPUT } as any);

    expect(result).toContain('Member registered successfully');
    expect(result).toContain('Tunnel:  SSH TCP forwarding available');

    // Once -- not per dispatch, and not once per registration step.
    expect(openReverseTunnel).toHaveBeenCalledTimes(1);
    // The probe leaves nothing behind.
    expect(close).toHaveBeenCalledTimes(1);

    const agent = getAllAgents().find(a => a.friendlyName === 'fwd-probe-remote')!;
    expect(agent.sshTcpForwarding).toBe(true);
    expect(typeof agent.sshTcpForwardingProbedAt).toBe('string');
  });

  it('records false with a surfaced warning (and still registers) when the sshd refuses forwarding', async () => {
    const openReverseTunnel = vi.fn(async () => {
      throw new TcpForwardingRefusedError('refused the SSH remote port-forward request');
    });
    __setTcpForwardingProbeDeps({ openReverseTunnel: openReverseTunnel as any });

    const result = await registerMember({ ...REMOTE_INPUT } as any);

    // Registration still succeeds -- the refusal is recorded, not thrown.
    expect(result).toContain('Member registered successfully');
    expect(result).toContain('Tunnel:  SSH TCP forwarding unavailable');
    // The warning is surfaced to the caller, not swallowed.
    expect(result).toContain('Warnings:');
    expect(result).toContain('AllowTcpForwarding yes');

    const agent = getAllAgents().find(a => a.friendlyName === 'fwd-probe-remote')!;
    expect(agent.sshTcpForwarding).toBe(false);
    expect(agent.sshTcpForwardingProbedAt).toBeDefined();
  });

  it('records false with a warning when the probe fails for a transport reason', async () => {
    const openReverseTunnel = vi.fn(async () => {
      throw new ReverseTunnelTransportError('Failed to open reverse tunnel: Host unreachable');
    });
    __setTcpForwardingProbeDeps({ openReverseTunnel: openReverseTunnel as any });

    const result = await registerMember({ ...REMOTE_INPUT } as any);

    expect(result).toContain('Member registered successfully');
    expect(result).toContain('Could not probe SSH TCP forwarding');
    const agent = getAllAgents().find(a => a.friendlyName === 'fwd-probe-remote')!;
    expect(agent.sshTcpForwarding).toBe(false);
  });

  it('records false when the sshd binds but reports no usable port', async () => {
    const close = vi.fn(async () => undefined);
    const openReverseTunnel = vi.fn(async () => ({ remotePort: 0, localPort: 7523, close }));
    __setTcpForwardingProbeDeps({ openReverseTunnel: openReverseTunnel as any });

    const result = await registerMember({ ...REMOTE_INPUT } as any);

    expect(result).toContain('Member registered successfully');
    expect(result).toContain('bound no usable port');
    expect(close).toHaveBeenCalledTimes(1);
    const agent = getAllAgents().find(a => a.friendlyName === 'fwd-probe-remote')!;
    expect(agent.sshTcpForwarding).toBe(false);
  });

  it('registers successfully even if the probe helper itself rejects unexpectedly (non-fatal)', async () => {
    const openReverseTunnel = vi.fn(async () => { throw new Error('boom'); });
    __setTcpForwardingProbeDeps({ openReverseTunnel: openReverseTunnel as any });

    const result = await registerMember({ ...REMOTE_INPUT } as any);
    expect(result).toContain('Member registered successfully');
    const agent = getAllAgents().find(a => a.friendlyName === 'fwd-probe-remote')!;
    expect(agent.sshTcpForwarding).toBe(false);
  });

  it('does NOT probe a local member and leaves the capability unrecorded', async () => {
    const openReverseTunnel = vi.fn(async () => ({ remotePort: 41234, localPort: 7523, close: vi.fn() }));
    __setTcpForwardingProbeDeps({ openReverseTunnel: openReverseTunnel as any });

    const result = await registerMember({
      friendly_name: 'fwd-probe-local',
      member_type: 'local',
      work_folder: process.cwd(),
    } as any);

    expect(result).toContain('Member registered successfully');
    expect(openReverseTunnel).not.toHaveBeenCalled();
    expect(result).not.toContain('SSH TCP forwarding');

    const agent = getAllAgents().find(a => a.friendlyName === 'fwd-probe-local')!;
    expect(agent.sshTcpForwarding).toBeUndefined();
    expect(agent.sshTcpForwardingProbedAt).toBeUndefined();
  });

  it('issues no member-bound shell command for the probe (ssh2 forward request only)', async () => {
    const close = vi.fn(async () => undefined);
    const openReverseTunnel = vi.fn(async () => ({ remotePort: 41234, localPort: 7523, close }));
    __setTcpForwardingProbeDeps({ openReverseTunnel: openReverseTunnel as any });

    await registerMember({ ...REMOTE_INPUT } as any);

    // Nothing the probe does shows up as a command on the member -- so there is
    // no shell-level $VAR/~ expansion that could break on a PowerShell member.
    const commands = mockExecCommand.mock.calls.map(c => String(c[0]));
    for (const cmd of commands) {
      expect(cmd).not.toMatch(/AllowTcpForwarding|sshd_config|ssh -R/);
    }
  });
});
