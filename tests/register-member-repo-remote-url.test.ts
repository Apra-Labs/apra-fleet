/**
 * apra-fleet-tm7.9.1, wiring half: register_member must actually STORE the
 * origin URL it resolves, or the whole mechanism is inert.
 *
 * This is the gap that matters. resolveRepoRemoteUrl() and knownRepoRemoteUrl()
 * are both well covered in isolation (kb-harvest-remote-identity.test.ts), but
 * they only change behaviour if registration persists the result onto the agent
 * record -- and unit tests of the two functions stay green whether or not that
 * happens. Deleting the register_member call site leaves every other test in
 * this repo passing, which is precisely the "wired in tests, dead in
 * production" shape this pins shut.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import type { SSHExecResult } from '../src/types.js';

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
  readMemberStatus: vi.fn(() => 'idle'),
}));

const ORIGIN_URL = 'https://github.com/acme/widget.git';

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();
const mockTestConnection = vi.fn<() => Promise<{ ok: boolean; latencyMs: number; error?: string }>>();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: mockTestConnection,
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

/**
 * Registration issues several probes (OS detection, CLI version) alongside the
 * origin probe, so answer by command shape rather than by call order -- ordering
 * here is an implementation detail and pinning it would make this test brittle.
 */
function mockRemoteHost(originStdout: string, originCode = 0): void {
  mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 3 });
  mockExecCommand.mockImplementation(async (cmd: string) => {
    if (/remote get-url origin/.test(cmd)) return { stdout: originStdout, stderr: '', code: originCode };
    if (/uname/.test(cmd)) return { stdout: 'Linux\n', stderr: '', code: 0 };
    if (/--version/.test(cmd)) return { stdout: '2.1.0\n', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 1 };
  });
}

async function registerRemote(name: string): Promise<void> {
  const { registerMember } = await import('../src/tools/register-member.js');
  await registerMember({
    friendly_name: name,
    member_type: 'remote',
    host: '192.168.1.50',
    username: 'dev',
    auth_type: 'password',
    password: 'secret',
    work_folder: '/home/dev/widget',
    llm_provider: 'claude',
  } as any);
}

async function storedUrlFor(name: string): Promise<string | undefined> {
  const { getAllAgents } = await import('../src/services/registry.js');
  return getAllAgents().find(a => a.friendlyName === name)?.repoRemoteUrl;
}

describe('register_member persists the resolved repo origin URL (apra-fleet-tm7.9.1)', () => {
  let workFolder: string;

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    workFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-regmember-url-'));
  });

  afterEach(() => {
    restoreRegistry();
    fs.rmSync(workFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    vi.resetModules();
  });

  it('stores the URL on the member record so dispatch can read it without an exec', async () => {
    const { clearRepoRemoteUrlCache } = await import('../src/services/member-remote-url.js');
    clearRepoRemoteUrlCache();
    mockRemoteHost(`${ORIGIN_URL}\n`);

    await registerRemote('tm791-stores-url');

    expect(await storedUrlFor('tm791-stores-url')).toBe(ORIGIN_URL);
  });

  it('registers successfully with no URL when the member is not a git clone', async () => {
    const { clearRepoRemoteUrlCache } = await import('../src/services/member-remote-url.js');
    clearRepoRemoteUrlCache();
    mockRemoteHost('fatal: not a git repository\n', 128);

    await registerRemote('tm791-no-git');

    // The member still exists -- a failed probe must never block a registration.
    const { getAllAgents } = await import('../src/services/registry.js');
    expect(getAllAgents().some(a => a.friendlyName === 'tm791-no-git')).toBe(true);
    expect(await storedUrlFor('tm791-no-git')).toBeUndefined();
  });
});
