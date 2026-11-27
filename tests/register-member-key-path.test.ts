/**
 * register_member: a remote, non-cloud member with auth_type "key" and no
 * key_path is refused at validation time -- nothing is registered and no SSH
 * connection is attempted (it used to register fine and then fail every SSH
 * call later). Positive control: the same member with a key_path registers.
 * HOME/USERPROFILE point at a temp sandbox; the registry is the isolated test registry.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupAndResetRegistry, restoreRegistry, makeConfigAwareExec } from './test-helpers.js';
import { registerMember } from '../src/tools/register-member.js';
import { getAllAgents } from '../src/services/registry.js';
import type { SSHExecResult } from '../src/types.js';

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();
const mockTestConnection = vi.fn();
const mockGetStrategy = vi.fn();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: (...args: unknown[]) => {
    mockGetStrategy(...args);
    return {
      execCommand: mockExecCommand,
      testConnection: mockTestConnection,
      transferFiles: async (paths: string[]) => ({ success: paths, failed: [] }),
      writeSecretFile: async () => '/home/testuser/.apra-fleet-secret',
      removeSecretFile: async () => undefined,
      close: vi.fn(),
    };
  },
}));
vi.mock('../src/services/statusline.js', () => ({ writeStatusline: vi.fn() }));
vi.mock('../src/services/agent-provisioner.js', () => ({
  provisionAgents: vi.fn().mockResolvedValue({ pushed: [] }),
  remoteAgentsDir: () => '.claude/agents',
}));

const savedEnv: Record<string, string | undefined> = {};
let sandbox: string;
beforeAll(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-regkey-'));
  for (const k of ['HOME', 'USERPROFILE']) savedEnv[k] = process.env[k];
  process.env.HOME = sandbox;
  process.env.USERPROFILE = sandbox;
});
afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(sandbox, { recursive: true, force: true });
});
beforeEach(() => {
  backupAndResetRegistry();
  vi.clearAllMocks();
  mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
  mockExecCommand.mockImplementation(makeConfigAwareExec());
});
afterEach(() => restoreRegistry());

const remote = {
  friendly_name: 'key-auth-test',
  member_type: 'remote' as const,
  host: '192.168.1.50',
  username: 'akhil',
  work_folder: '/home/testuser/git/test',
  auth_type: 'key' as const,
};

describe('register_member: key auth requires key_path', () => {
  it('remote, auth_type key, no key_path -> error naming key_path, nothing registered, no SSH attempted', async () => {
    const result = await registerMember(remote);
    expect(result).toContain('key_path');
    expect(result).toContain('Member was NOT registered');
    expect(getAllAgents()).toHaveLength(0);
    expect(mockTestConnection).not.toHaveBeenCalled();
    expect(mockExecCommand).not.toHaveBeenCalled();
    expect(mockGetStrategy).not.toHaveBeenCalled();
  });

  it('positive control: the same member with a key_path registers', async () => {
    const result = await registerMember({ ...remote, key_path: path.join(sandbox, 'id_test') });
    expect(result).not.toContain('Member was NOT registered');
    expect(getAllAgents()).toHaveLength(1);
    expect(getAllAgents()[0].keyPath).toBe(path.join(sandbox, 'id_test'));
    expect(mockTestConnection).toHaveBeenCalled();
  });
});
