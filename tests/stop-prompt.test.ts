import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { setStoredPid, clearStoredPid, getStoredPid } from '../src/utils/agent-helpers.js';
import { stopPrompt } from '../src/tools/stop-prompt.js';
import { inFlightAgents, executePrompt } from '../src/tools/execute-prompt.js';
import { writeStatusline } from '../src/services/statusline.js';
import type { SSHExecResult } from '../src/types.js';

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
  readMemberStatus: vi.fn(() => 'idle'),
}));

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: vi.fn(),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

describe('stop_prompt (T8)', () => {
  let memberId: string;

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreRegistry();
    if (memberId) clearStoredPid(memberId);
  });

  it('returns not-found error for unknown member', async () => {
    const result = await stopPrompt({ member_id: 'nonexistent-id' });
    expect(result).toContain('not found');
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('kills active PID when PID is stored', async () => {
    const member = makeTestAgent({ friendlyName: 'kill-me' });
    memberId = member.id;
    addAgent(member);
    setStoredPid(memberId, 9999);

    mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 }); // kill

    const result = await stopPrompt({ member_id: memberId });

    expect(mockExecCommand).toHaveBeenCalledTimes(1);
    expect(mockExecCommand.mock.calls[0][0]).toContain('9999');
    expect(getStoredPid(memberId)).toBeUndefined();
    expect(result).toContain('9999');
    expect(result).toContain('stopped');
  });

  it('returns stopped message when no PID is stored', async () => {
    const member = makeTestAgent({ friendlyName: 'idle-member' });
    memberId = member.id;
    addAgent(member);

    const result = await stopPrompt({ member_id: memberId });

    expect(mockExecCommand).not.toHaveBeenCalled();
    expect(result).toContain('stopped');
  });

  it('resolves member by friendly name', async () => {
    const member = makeTestAgent({ friendlyName: 'name-lookup-member' });
    memberId = member.id;
    addAgent(member);

    const result = await stopPrompt({ member_name: 'name-lookup-member' });

    expect(result).toContain('name-lookup-member');
  });

  it('kill command uses 5000ms timeout', async () => {
    const member = makeTestAgent({ friendlyName: 'kill-timeout-member' });
    memberId = member.id;
    addAgent(member);
    setStoredPid(memberId, 1234);

    mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });

    await stopPrompt({ member_id: memberId });

    expect(mockExecCommand.mock.calls[0][1]).toBe(5000);
  });
});

describe('stop_prompt busy-clear (T6)', () => {
  let memberId: string;

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreRegistry();
    if (memberId) {
      inFlightAgents.delete(memberId);
      clearStoredPid(memberId);
    }
  });

  it('clears inFlightAgents and calls writeStatusline when pid=none', async () => {
    const member = makeTestAgent({ friendlyName: 'sp-pid-none' });
    memberId = member.id;
    addAgent(member);
    inFlightAgents.add(memberId);

    const result = await stopPrompt({ member_id: memberId });

    expect(inFlightAgents.has(memberId)).toBe(false);
    expect(vi.mocked(writeStatusline)).toHaveBeenCalled();
    expect(result).toContain('stopped');
  });

  it('stop_prompt followed by execute_prompt does not return already-running error', async () => {
    const member = makeTestAgent({ friendlyName: 'sp-redispatch' });
    memberId = member.id;
    addAgent(member);
    inFlightAgents.add(memberId);  // simulate busy with no PID

    await stopPrompt({ member_id: memberId });  // clears inFlightAgents

    mockExecCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ result: 'done', session_id: 'sess-r' }), stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });

    const result = await executePrompt({ member_id: memberId, prompt: 'hi', resume: false, timeout_s: 5 });

    expect(result).not.toContain('already running');
    expect(result).toContain('done');
  });
});
