/**
 * register_member fails loudly when git refuses the work folder (dubious
 * ownership) from the server's context, and still accepts a pre-clone folder
 * (apra-fleet-wgpx). Faked AgentStrategy, same approach as
 * register-member-vcs-provider.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { registerMember } from '../src/tools/register-member.js';
import { getAllAgents } from '../src/services/registry.js';
import { LinuxCommands } from '../src/os/index.js';
import type { SSHExecResult } from '../src/types.js';

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();
const mockTestConnection = vi.fn();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: mockTestConnection,
    transferFiles: vi.fn(),
    receiveFiles: vi.fn(),
    deleteFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
}));

// compose_permissions writes (and reads back) a settings file ON THE MEMBER via
// the strategy above; against a fake strategy that read-back can never succeed,
// and register_member correctly refuses to report success when it fails. That
// axis is already covered by register-member.test.ts -- stub it to a success
// here so these cases test the VCS-provider axis alone. The literal is written
// as an escape so this source file stays ASCII (repo convention).
vi.mock('../src/tools/compose-permissions.js', () => ({
  composePermissions: vi.fn(async () => '\u2705 Permissions composed (test stub).'),
}));

// Provisioning role-agent files and seeding workspace trust are separate,
// already-covered SSH round trips that a fake strategy makes slow and
// meaningless here.
vi.mock('../src/services/agent-provisioner.js', () => ({
  provisionAgents: vi.fn(async () => ({ pushed: [], skipped: [], warning: undefined })),
}));
vi.mock('../src/utils/workspace-trust.js', () => ({
  seedWorkspaceTrust: vi.fn(async () => undefined),
}));

import { WindowsCommands } from '../src/os/index.js';
import { classifyGitProbeOutput } from '../src/services/git-access.js';

const FOLDER = '/srv/work';
const PROBE_CMD = new LinuxCommands().gitRepoAccessProbe(FOLDER);
const REMOTE_CMD = new LinuxCommands().gitRemoteOrigin(FOLDER);
const DUBIOUS = `fatal: detected dubious ownership in repository at '${FOLDER}'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory ${FOLDER}`;

function useFakeMember(probeOut: string, remote = '') {
  mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
  mockExecCommand.mockImplementation(async (cmd: string) => {
    if (cmd === 'uname -s') return { stdout: 'Linux', stderr: '', code: 0 };
    if (cmd === PROBE_CMD) return { stdout: probeOut, stderr: '', code: 0 };
    if (cmd === REMOTE_CMD) return { stdout: remote, stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  });
}

const base = {
  member_type: 'remote', host: '10.0.0.5', username: 'dev', auth_type: 'password', password: 'x', work_folder: FOLDER,
};

describe('register_member: git-refused work folder (apra-fleet-wgpx)', () => {
  beforeEach(() => { backupAndResetRegistry(); vi.clearAllMocks(); });
  afterEach(() => { restoreRegistry(); });

  it('refuses a dubious-ownership folder, names both remedies, registers no member', async () => {
    useFakeMember(DUBIOUS);
    const result = await registerMember({ ...base, friendly_name: 'refused' } as never);
    expect(result).toMatch(/^ERROR/);
    expect(result).toContain('dubious ownership');
    expect(result).toContain('safe.directory');
    expect(result).toMatch(/icacls .* \/setowner/);
    expect(result).toContain('chown');
    expect(getAllAgents().find(a => a.friendlyName === 'refused')).toBeUndefined();
  });

  it('still runs the ownership check when vcs_provider is explicit', async () => {
    useFakeMember(DUBIOUS);
    const result = await registerMember({ ...base, friendly_name: 'refused2', vcs_provider: 'github' } as never);
    expect(result).toMatch(/^ERROR/);
    expect(getAllAgents().find(a => a.friendlyName === 'refused2')).toBeUndefined();
  });

  it.each([
    ['empty output (a healthy repo)', ''],
    ['not a git repository (register before clone)', 'fatal: not a git repository (or any of the parent directories): .git'],
    ['folder missing', "fatal: cannot change to '/srv/work': No such file or directory"],
  ])('registers successfully for %s, keeping the VCS warning when no remote', async (_n, out) => {
    useFakeMember(out);
    const result = await registerMember({ ...base, friendly_name: 'ok-member' } as never);
    expect(result).toContain('registered successfully');
    expect(result).toMatch(/VCS provider could not be determined/);
    expect(getAllAgents().find(a => a.friendlyName === 'ok-member')).toBeTruthy();
  });

  it('a normal repo with an origin remote registers and auto-detects the provider', async () => {
    useFakeMember('', 'https://github.com/acme/widgets.git');
    const result = await registerMember({ ...base, friendly_name: 'normal' } as never);
    expect(result).toContain('registered successfully');
    expect(result).toContain('(auto-detected from origin)');
  });
});

describe('gitRepoAccessProbe command builders make the failure observable', () => {
  it('POSIX: folds stderr into stdout and prints it on failure; exit code is not the signal', () => {
    const cmd = new LinuxCommands().gitRepoAccessProbe('/a b/c');
    expect(cmd).toContain('rev-parse --git-dir 2>&1');
    expect(cmd).toContain('|| printf');
    expect(cmd).not.toContain('2>/dev/null');
    expect(cmd).not.toMatch(/\|\| true/);
  });

  it('PowerShell: captures stderr via 2>&1 and writes it when LASTEXITCODE is non-zero', () => {
    const cmd = new WindowsCommands().gitRepoAccessProbe('C:\\work\\repo');
    expect(cmd).toContain('rev-parse --git-dir 2>&1');
    expect(cmd).toContain('$LASTEXITCODE -ne 0');
    expect(cmd).toContain('Write-Output');
    expect(cmd).not.toContain('2>$null');
  });

  it('the old remote probe still swallows (unchanged), which is why this probe exists', () => {
    expect(new LinuxCommands().gitRemoteOrigin('/x')).toContain('|| true');
  });
});

describe('classifyGitProbeOutput', () => {
  it('classifies ok / benign / refusal', () => {
    expect(classifyGitProbeOutput('').ok).toBe(true);
    expect(classifyGitProbeOutput('fatal: not a git repository').ok).toBe(true);
    const v = classifyGitProbeOutput(DUBIOUS);
    expect(v.ok).toBe(false);
    expect(!v.ok && v.dubiousOwnership).toBe(true);
    const other = classifyGitProbeOutput('fatal: unsafe repository or corrupt index');
    expect(other.ok).toBe(false);
  });
});
