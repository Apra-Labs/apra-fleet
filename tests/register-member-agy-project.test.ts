/**
 * register_member with llm_provider agy creates the member's own agy project
 * (`agy --new-project`) and records exactly that one id as Agent.agyProjectId
 * before the member is persisted; any other outcome refuses registration.
 * Other providers never run it. The member-side exec is mocked; the new-project
 * script itself is exercised for real in tests/agy-project.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { getAllAgents } from '../src/services/registry.js';
import type { SSHExecResult } from '../src/types.js';

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();
vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: vi.fn().mockResolvedValue({ ok: true, latencyMs: 1 }),
    transferFiles: vi.fn().mockResolvedValue({ success: [], failed: [] }),
    close: vi.fn(),
  }),
}));
vi.mock('../src/services/statusline.js', () => ({ writeStatusline: vi.fn(), readMemberStatus: vi.fn(() => 'idle') }));
vi.mock('../src/services/agent-provisioner.js', () => ({
  provisionAgents: vi.fn().mockResolvedValue({ pushed: [] }),
  remoteAgentsDir: vi.fn().mockReturnValue(null),
}));
const mockCompose = vi.fn();
vi.mock('../src/tools/compose-permissions.js', () => ({ composePermissions: (...a: unknown[]) => mockCompose(...a) }));
vi.mock('../src/cli/install.js', () => ({ writeAgyWorkspaceOverlays: vi.fn() }));

/** Member commands are a POSIX heredoc or (Windows host) an encoded PowerShell
 *  script; decode the latter so the mock can recognise the script. */
function plain(cmd: string): string {
  const m = /-EncodedCommand (\S+)/.exec(cmd);
  return m ? Buffer.from(m[1], 'base64').toString('utf16le') : cmd;
}
const isNewProject = (cmd: string) => plain(cmd).includes('FLEET_AGY_NEW_PROJECT:');

const NEW_ID = '1afd6dbb-498f-4918-a9d9-6da64b75a204';
const newProjectOutput = (o: object) => ({ stdout: `FLEET_AGY_NEW_PROJECT:${JSON.stringify(o)}`, stderr: '', code: 0 });

let workFolder: string;
let fakeHome: string;

beforeEach(() => {
  backupAndResetRegistry();
  workFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-reg-agy-work-'));
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-reg-agy-home-'));
  vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  mockExecCommand.mockReset();
  mockCompose.mockReset();
  // register_member treats a compose result starting with U+2705 as success.
  mockCompose.mockResolvedValue(`${String.fromCodePoint(0x2705)} Permissions composed`);
});

afterEach(() => {
  restoreRegistry();
  vi.restoreAllMocks();
  for (const d of [workFolder, fakeHome]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function register(llm_provider: string) {
  const { registerMember } = await import('../src/tools/register-member.js');
  return registerMember({ friendly_name: `reg-${llm_provider}`, member_type: 'local', work_folder: workFolder, llm_provider, vcs_provider: 'none' } as any);
}

describe('register_member -- agy project binding', () => {
  it('stores the single new project id on the registered agy member', async () => {
    mockExecCommand.mockImplementation(async (cmd: string) =>
      isNewProject(cmd)
        ? newProjectOutput({ created: [NEW_ID], logIds: [NEW_ID], status: 0 })
        : { stdout: '1.2.11', stderr: '', code: 0 });

    const result = await register('agy');

    expect(result).toContain('registered successfully');
    expect(result).toContain(`AGY project: ${NEW_ID}`);
    const agents = getAllAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].agyProjectId).toBe(NEW_ID);
    expect(mockExecCommand.mock.calls.filter(c => isNewProject(c[0]))).toHaveLength(1);
  });

  it('refuses registration when agy --new-project does not yield exactly one confirmed id', async () => {
    mockExecCommand.mockImplementation(async (cmd: string) =>
      isNewProject(cmd)
        ? newProjectOutput({ created: [NEW_ID, 'e7160b25-85b1-499b-96bd-525fa3156179'], logIds: [NEW_ID], status: 0 })
        : { stdout: '1.2.11', stderr: '', code: 0 });

    const result = await register('agy');

    expect(result).toContain('ERROR: could not create the agy project');
    expect(result).toContain('found 2');
    expect(result).toContain('Member was NOT registered.');
    expect(getAllAgents()).toHaveLength(0);
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it('never runs agy project provisioning for a claude member', async () => {
    mockExecCommand.mockResolvedValue({ stdout: '2.0.0', stderr: '', code: 0 });
    const result = await register('claude');
    expect(result).toContain('registered successfully');
    expect(mockExecCommand.mock.calls.some(c => plain(c[0]).includes('FLEET_AGY_'))).toBe(false);
    expect(getAllAgents()[0].agyProjectId).toBeUndefined();
  });
});
