/**
 * Wiring pins for the Windows shell probe in register_member (apra-fleet-7dir.1.3).
 *
 * Everything runs against a faked AgentStrategy, so the whole file is
 * OS-independent: OS detection is driven by the fake `uname`/`ver` output, not
 * by the host this suite happens to run on.
 *
 * The fake probe responses are REAL outputs captured on a Windows 10 box
 * (Git bash -> "MINGW64_NT-10.0-19045"; System32 WSL bash -> "Linux";
 * Windows PowerShell 5.1 -> "PSMAJOR:5").
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { registerMember } from '../src/tools/register-member.js';
import { getAllAgents } from '../src/services/registry.js';
import { WindowsCommands, LinuxCommands } from '../src/os/index.js';
import { buildRemoteBashChannelProbeCommand } from '../src/services/shell-probe.js';
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

const WIN_FOLDER = 'C:\\fleet\\work';

function decodeIfEncoded(command: string): string {
  const m = /-EncodedCommand\s+(\S+)/.exec(command);
  return m ? Buffer.from(m[1], 'base64').toString('utf16le') : command;
}

/** Fake member. `os` drives detection; `bash` decides what the Git-bash probe
 *  finds; nothing else on the box responds usefully. */
function useFakeMember(opts: { os: 'windows' | 'linux'; bash?: 'gitbash' | 'wsl-only' | 'none' }) {
  mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
  mockExecCommand.mockImplementation(async (cmd: string) => {
    // The remote bash-channel confirmation probe is deliberately unwrapped
    // (not -EncodedCommand) -- it stands in for these registrations' member
    // being remote, where a real SSH connection's own DefaultShell is what
    // actually interprets it. Only a genuine gitbash box answers correctly;
    // wsl-only/none never get far enough to send this (no binary was proven).
    if (cmd === buildRemoteBashChannelProbeCommand()) {
      return opts.bash === 'gitbash'
        ? { stdout: 'FLEET_BASH_CHANNEL_MARKER\r\nMINGW64_NT-10.0-19045\r\n', stderr: '', code: 0 }
        : { stdout: '', stderr: 'ParserError', code: 1 };
    }
    const script = decodeIfEncoded(cmd);
    if (cmd === 'uname -s') return { stdout: opts.os === 'linux' ? 'Linux' : '', stderr: '', code: 0 };
    if (cmd === 'ver') return { stdout: opts.os === 'windows' ? 'Microsoft Windows [Version 10.0.19045]' : '', stderr: '', code: 0 };
    if (cmd === 'echo $env:OS') return { stdout: '', stderr: '', code: 0 };
    if (script.includes('BASHCAND:')) {
      const paths = opts.bash === 'gitbash'
        ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Windows\\system32\\bash.exe']
        : opts.bash === 'wsl-only' ? ['C:\\Windows\\system32\\bash.exe'] : [];
      return { stdout: paths.map(p => `BASHCAND:${p}`).join('\r\n'), stderr: '', code: 0 };
    }
    if (script.includes("-lc 'uname -s'")) {
      return script.includes('system32')
        ? { stdout: 'Linux\n', stderr: '', code: 0 }
        : { stdout: 'MINGW64_NT-10.0-19045\n', stderr: '', code: 0 };
    }
    if (script.includes('& pwsh ')) return { stdout: '', stderr: "'pwsh' is not recognized", code: 1 };
    if (script.includes('& powershell ')) return { stdout: 'PSMAJOR:5\r\n', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  });
}

function sentCommands(): string[] {
  return mockExecCommand.mock.calls.map(c => decodeIfEncoded(c[0]));
}

function probeWasRun(): boolean {
  return sentCommands().some(c => c.includes('BASHCAND:') || c.includes('PSMAJOR:') || c.includes('PSEDITION:'));
}

function registeredShell(name: string): string | undefined {
  const agent = getAllAgents().find(a => a.friendlyName === name);
  expect(agent, `member ${name} was not registered`).toBeTruthy();
  return agent!.shell;
}

describe('register_member: Windows shell probe wiring (apra-fleet-7dir.1.3)', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('AC1: records shell=gitbash for a Windows member with Git-for-Windows installed', async () => {
    useFakeMember({ os: 'windows', bash: 'gitbash' });
    const result = await registerMember({
      friendly_name: 'win-gitbash', member_type: 'remote', host: '10.0.0.5', username: 'dev',
      auth_type: 'password', password: 'x', work_folder: WIN_FOLDER, llm_provider: 'none',
    } as never);

    expect(result).toContain('registered successfully');
    expect(registeredShell('win-gitbash')).toBe('gitbash');
  });

  it('AC3/AC4: a System32 WSL bash.exe on PATH never yields gitbash -- falls through to powershell5', async () => {
    useFakeMember({ os: 'windows', bash: 'wsl-only' });
    await registerMember({
      friendly_name: 'win-wsl', member_type: 'remote', host: '10.0.0.6', username: 'dev',
      auth_type: 'password', password: 'x', work_folder: WIN_FOLDER, llm_provider: 'none',
    } as never);

    expect(registeredShell('win-wsl')).toBe('powershell5');
  });

  it('AC9: the registration-time commands are built from the probed shell', async () => {
    useFakeMember({ os: 'windows', bash: 'gitbash' });
    await registerMember({
      friendly_name: 'win-gitbash-cmds', member_type: 'remote', host: '10.0.0.7', username: 'dev',
      auth_type: 'password', password: 'x', work_folder: WIN_FOLDER, llm_provider: 'none',
    } as never);

    // A gitbash member must get POSIX strings for the post-probe registration work.
    expect(sentCommands()).toContain(new LinuxCommands().mkdir(WIN_FOLDER));
  });

  it('AC9: a powershell5 member still gets byte-identical strings to the pre-probe behaviour', async () => {
    useFakeMember({ os: 'windows', bash: 'none' });
    await registerMember({
      friendly_name: 'win-ps5-cmds', member_type: 'remote', host: '10.0.0.8', username: 'dev',
      auth_type: 'password', password: 'x', work_folder: WIN_FOLDER, llm_provider: 'none',
    } as never);

    expect(registeredShell('win-ps5-cmds')).toBe('powershell5');
    expect(sentCommands()).toContain(new WindowsCommands().mkdir(WIN_FOLDER));
  });

  it('AC6: a non-Windows member is unaffected and runs no shell probe at all', async () => {
    useFakeMember({ os: 'linux' });
    await registerMember({
      friendly_name: 'linux-member', member_type: 'remote', host: '10.0.0.9', username: 'dev',
      auth_type: 'password', password: 'x', work_folder: '/srv/work', llm_provider: 'none',
    } as never);

    expect(registeredShell('linux-member')).toBeUndefined();
    expect(probeWasRun()).toBe(false);
    expect(sentCommands()).toContain(new LinuxCommands().mkdir('/srv/work'));
  });

  it('AC7: an operator-supplied shell wins and suppresses the probe entirely', async () => {
    useFakeMember({ os: 'windows', bash: 'gitbash' });
    await registerMember({
      friendly_name: 'win-explicit', member_type: 'remote', host: '10.0.0.10', username: 'dev',
      auth_type: 'password', password: 'x', work_folder: WIN_FOLDER, llm_provider: 'none',
      shell: 'pwsh7',
    } as never);

    expect(registeredShell('win-explicit')).toBe('pwsh7');
    expect(probeWasRun()).toBe(false);
  });

  it('AC8: probe failure degrades to powershell5 with a warning instead of failing registration', async () => {
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockImplementation(async (cmd: string) => {
      if (cmd === 'ver') return { stdout: 'Microsoft Windows [Version 10.0.19045]', stderr: '', code: 0 };
      if (cmd === 'uname -s' || cmd === 'echo $env:OS') return { stdout: '', stderr: '', code: 0 };
      const script = decodeIfEncoded(cmd);
      // Only the probe round trips blow up -- the rest of registration is healthy,
      // so a failed probe must not be what sinks the registration.
      if (script.includes('BASHCAND:') || script.includes('& pwsh ') || script.includes('& powershell ')) {
        throw new Error('connection reset');
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    const result = await registerMember({
      friendly_name: 'win-broken-probe', member_type: 'remote', host: '10.0.0.11', username: 'dev',
      auth_type: 'password', password: 'x', work_folder: WIN_FOLDER, llm_provider: 'none',
    } as never);

    expect(result).toContain('registered successfully');
    expect(result).toContain('Could not verify which Windows shell');
    expect(registeredShell('win-broken-probe')).toBe('powershell5');
  });
});
