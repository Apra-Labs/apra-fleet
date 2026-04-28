import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent, getAgent } from '../src/services/registry.js';
import { registerMember } from '../src/tools/register-member.js';
import { updateMember } from '../src/tools/update-member.js';
import { executePrompt } from '../src/tools/execute-prompt.js';
import type { SSHExecResult } from '../src/types.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockExecCommand = vi.fn<(cmd: string, timeout?: number, maxTotalMs?: number) => Promise<SSHExecResult>>();
const mockTestConnection = vi.fn();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: mockTestConnection,
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock('../src/services/onboarding.js', () => ({
  loadOnboardingState: () => ({ bannerShown: true, firstMemberRegistered: true, firstPromptExecuted: true, multiMemberNudgeShown: true }),
  saveOnboardingState: vi.fn(),
  _resetForTest: vi.fn(),
}));

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
}));

// ─── register_member: unattended persistence ──────────────────────────────────

describe('register_member: unattended field persistence', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: 'Linux', stderr: '', code: 0 });
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('persists unattended="auto" on the registered Agent record', async () => {
    await registerMember({
      friendly_name: 'auto-agent',
      member_type: 'remote',
      host: '10.0.0.1',
      port: 22,
      username: 'user',
      auth_type: 'key',
      work_folder: '/home/user/project',
      unattended: 'auto',
    });

    const { getAllAgents } = await import('../src/services/registry.js');
    const registered = getAllAgents().find(a => a.friendlyName === 'auto-agent');
    expect(registered).toBeDefined();
    expect(registered!.unattended).toBe('auto');
  });

  it('persists unattended="dangerous" on the registered Agent record', async () => {
    await registerMember({
      friendly_name: 'dangerous-agent',
      member_type: 'remote',
      host: '10.0.0.2',
      port: 22,
      username: 'user',
      auth_type: 'key',
      work_folder: '/home/user/dangerous',
      unattended: 'dangerous',
    });

    const { getAllAgents } = await import('../src/services/registry.js');
    const registered = getAllAgents().find(a => a.friendlyName === 'dangerous-agent');
    expect(registered).toBeDefined();
    expect(registered!.unattended).toBe('dangerous');
  });

  it('defaults unattended to false when not provided', async () => {
    await registerMember({
      friendly_name: 'default-agent',
      member_type: 'remote',
      host: '10.0.0.3',
      port: 22,
      username: 'user',
      auth_type: 'key',
      work_folder: '/home/user/default',
    });

    const { getAllAgents } = await import('../src/services/registry.js');
    const registered = getAllAgents().find(a => a.friendlyName === 'default-agent');
    expect(registered).toBeDefined();
    expect(registered!.unattended).toBe(false);
  });
});

// ─── update_member: unattended set and change ─────────────────────────────────

describe('update_member: unattended field', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('sets unattended="auto" on a member that previously had false', async () => {
    const agent = makeTestAgent({ unattended: false });
    addAgent(agent);

    const result = await updateMember({ member_id: agent.id, unattended: 'auto' });
    expect(result).toContain('updated');
    expect(getAgent(agent.id)?.unattended).toBe('auto');
  });

  it('changes unattended from "auto" to "dangerous"', async () => {
    const agent = makeTestAgent({ unattended: 'auto' });
    addAgent(agent);

    const result = await updateMember({ member_id: agent.id, unattended: 'dangerous' });
    expect(result).toContain('updated');
    expect(getAgent(agent.id)?.unattended).toBe('dangerous');
  });

  it('resets unattended back to false from "dangerous"', async () => {
    const agent = makeTestAgent({ unattended: 'dangerous' });
    addAgent(agent);

    const result = await updateMember({ member_id: agent.id, unattended: false });
    expect(result).toContain('updated');
    expect(getAgent(agent.id)?.unattended).toBe(false);
  });

  it('does not change unattended when the field is not provided', async () => {
    const agent = makeTestAgent({ unattended: 'auto' });
    addAgent(agent);

    await updateMember({ member_id: agent.id, friendly_name: agent.friendlyName });
    expect(getAgent(agent.id)?.unattended).toBe('auto');
  });
});

// ─── execute_prompt: dangerously_skip_permissions deprecation ─────────────────

describe('execute_prompt: dangerously_skip_permissions deprecation', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    restoreRegistry();
    vi.useRealTimers();
  });

  it('returns deprecation warning when dangerously_skip_permissions=true', async () => {
    const agent = makeTestAgent({ friendlyName: 'dep-agent', unattended: false });
    addAgent(agent);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'done', session_id: 'sess-dep' }),
      stderr: '',
      code: 0,
    });

    const result = await executePrompt({
      member_id: agent.id,
      prompt: 'do something',
      resume: false,
      timeout_ms: 5000,
      dangerously_skip_permissions: true,
    });

    expect(result).toContain('DEPRECATION');
    expect(result).toContain('dangerously_skip_permissions');
    expect(result).toContain('update_member');
  });

  it('does not include deprecation warning when dangerously_skip_permissions is false', async () => {
    const agent = makeTestAgent({ friendlyName: 'no-dep-agent', unattended: false });
    addAgent(agent);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'ok', session_id: 'sess-nodep' }),
      stderr: '',
      code: 0,
    });

    const result = await executePrompt({
      member_id: agent.id,
      prompt: 'do something',
      resume: false,
      timeout_ms: 5000,
      dangerously_skip_permissions: false,
    });

    expect(result).not.toContain('DEPRECATION');
  });

  it('does NOT pass --dangerously-skip-permissions when dangerously_skip_permissions=true but agent.unattended=false', async () => {
    const agent = makeTestAgent({ friendlyName: 'no-bypass-agent', unattended: false });
    addAgent(agent);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'done', session_id: 'sess-nobypass' }),
      stderr: '',
      code: 0,
    });

    await executePrompt({
      member_id: agent.id,
      prompt: 'do something',
      resume: false,
      timeout_ms: 5000,
      dangerously_skip_permissions: true,
    });

    // calls[0]=writePromptFile, calls[1]=main command
    const mainCmd = mockExecCommand.mock.calls[1][0];
    expect(mainCmd).not.toContain('--dangerously-skip-permissions');
    expect(mainCmd).not.toContain('--permission-mode');
  });

  it('passes --dangerously-skip-permissions when agent.unattended="dangerous" regardless of deprecated flag', async () => {
    const agent = makeTestAgent({ friendlyName: 'bypass-via-unattended', unattended: 'dangerous' });
    addAgent(agent);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'done', session_id: 'sess-bypass' }),
      stderr: '',
      code: 0,
    });

    await executePrompt({
      member_id: agent.id,
      prompt: 'do something',
      resume: false,
      timeout_ms: 5000,
      dangerously_skip_permissions: false,
    });

    // calls[0]=writePromptFile, calls[1]=main command
    const mainCmd = mockExecCommand.mock.calls[1][0];
    expect(mainCmd).toContain('--dangerously-skip-permissions');
  });

  it('passes --permission-mode auto when agent.unattended="auto"', async () => {
    const agent = makeTestAgent({ friendlyName: 'auto-via-unattended', unattended: 'auto' });
    addAgent(agent);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'done', session_id: 'sess-auto' }),
      stderr: '',
      code: 0,
    });

    await executePrompt({
      member_id: agent.id,
      prompt: 'do something',
      resume: false,
      timeout_ms: 5000,
    });

    // calls[0]=writePromptFile, calls[1]=main command
    const mainCmd = mockExecCommand.mock.calls[1][0];
    expect(mainCmd).toContain('--permission-mode auto');
  });
});

