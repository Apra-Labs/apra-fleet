import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { registerMember } from '../src/tools/register-member.js';
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

// apra-fleet-us9.14: a member with llm_provider "none" is a plain command
// executor -- registration must never attempt to verify a CLI or authenticate
// one, since NoneProvider.versionCommand() throws by design (there is no CLI).
describe('register_member: no-LLM member (apra-fleet-us9.14)', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: 'Linux', stderr: '', code: 0 });
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('registers successfully with llm_provider "none", never attempting a CLI version/auth check', async () => {
    const result = await registerMember({
      friendly_name: 'plain-executor',
      member_type: 'remote',
      host: '192.168.1.200',
      username: 'exec-user',
      auth_type: 'password',
      password: 'irrelevant-for-this-test',
      work_folder: '/srv/exec',
      llm_provider: 'none',
    } as any);

    expect(result).toContain('registered successfully');
    expect(result).toContain('Provider: none');
    // No CLI-not-found / could-not-verify warnings -- those would only
    // appear if the (skipped) version/auth check had run and failed.
    expect(result).not.toContain('CLI not found');
    expect(result).not.toContain('Could not verify');
    expect(result).not.toContain('CLI not available');

    // execCommand was called for OS detection (uname/ver) but never with a
    // command built from NoneProvider.versionCommand() (which would have
    // thrown synchronously, well before any execCommand call happened).
    const calls = mockExecCommand.mock.calls.map(c => c[0]);
    expect(calls.some(c => c.includes('--version'))).toBe(false);
  });
});
