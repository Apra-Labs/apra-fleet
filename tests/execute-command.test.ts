import os from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { executeCommand, resolveTilde } from '../src/tools/execute-command.js';
import type { ExecuteCommandResult } from '../src/tools/execute-command.js';
import type { Agent, SSHExecResult } from '../src/types.js';
import { encryptPassword } from '../src/utils/crypto.js';
import { preflightCheck } from '../src/services/preflight-check.js';

const mockPreflight = vi.mocked(preflightCheck);

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: vi.fn(),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

describe('executeCommand', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('returns stdout on success', async () => {
    const member = makeTestAgent({ friendlyName: 'cmd-member' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: 'hello world\n', stderr: '', code: 0 });

    const result = await executeCommand({ member_id: member.id, command: 'echo hello world', timeout_s: 5 });
    expect(result).not.toBeTypeOf('string');
    const { text, structuredContent } = result as Exclude<typeof result, string>;
    expect(text).toContain('Exit code: 0');
    expect(text).toContain('hello world');
    expect(structuredContent).toEqual({ exitCode: 0, stdout: 'hello world\n', stderr: '' });
  });

  it('wraps command with work folder', async () => {
    const member = makeTestAgent({ workFolder: '/home/user/project' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    await executeCommand({ member_id: member.id, command: 'ls', timeout_s: 5 });
    expect(mockExecCommand).toHaveBeenCalledWith(
      expect.stringContaining('/home/user/project'),
      5000,
      undefined,
      expect.any(Function)
    );
  });

  it('uses custom run_from when provided', async () => {
    const member = makeTestAgent({ workFolder: '/home/user/project' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    await executeCommand({ member_id: member.id, command: 'ls', timeout_s: 5, run_from: '/tmp/other' });
    expect(mockExecCommand).toHaveBeenCalledWith(
      expect.stringContaining('/tmp/other'),
      5000,
      undefined,
      expect.any(Function)
    );
    expect(mockExecCommand).toHaveBeenCalledWith(
      expect.not.stringContaining('/home/user/project'),
      5000,
      undefined,
      expect.any(Function)
    );
  });

  it('returns non-zero exit code and stderr', async () => {
    const member = makeTestAgent({ friendlyName: 'fail-member' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: 'command not found', code: 127 });

    const result = await executeCommand({ member_id: member.id, command: 'nonexistent', timeout_s: 5 });
    const { text, structuredContent } = result as Exclude<typeof result, string>;
    expect(text).toContain('Exit code: 127');
    expect(text).toContain('command not found');
    expect(structuredContent).toEqual({ exitCode: 127, stdout: '', stderr: 'command not found' });
  });

  it('returns error message on exception', async () => {
    const member = makeTestAgent({ friendlyName: 'err-member' });
    addAgent(member);
    mockExecCommand.mockRejectedValue(new Error('connection timeout'));

    const result = await executeCommand({ member_id: member.id, command: 'echo hi', timeout_s: 5 });
    expect(result).toContain('Failed to execute command');
    expect(result).toContain('connection timeout');
  });

  it('returns member not found for invalid ID', async () => {
    const result = await executeCommand({ member_id: 'nonexistent', command: 'echo hi', timeout_s: 5 });
    expect(result).toContain('not found');
  });

  it('shows (no output) when stdout and stderr are empty', async () => {
    const member = makeTestAgent();
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const result = await executeCommand({ member_id: member.id, command: 'true', timeout_s: 5 });
    const { text } = result as Exclude<typeof result, string>;
    expect(text).toContain('(no output)');
  });

  it('includes both stdout and stderr when both present', async () => {
    const member = makeTestAgent();
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: 'output', stderr: 'warning', code: 0 });

    const result = await executeCommand({ member_id: member.id, command: 'cmd', timeout_s: 5 });
    const { text, structuredContent } = result as Exclude<typeof result, string>;
    expect(text).toContain('output');
    expect(text).toContain('[stderr]');
    expect(text).toContain('warning');
    // structuredContent.stdout stays clean -- no "[stderr]" marker mixed in,
    // this is exactly the field a JSON-parsing caller like auto-sprint's
    // parseBdJson() should read instead of the display text.
    expect(structuredContent).toEqual({ exitCode: 0, stdout: 'output', stderr: 'warning' });
  });

  it('returns structuredContent with isError on preflight failure', async () => {
    const member = makeTestAgent({ friendlyName: 'offline-member' });
    addAgent(member);
    mockPreflight.mockResolvedValueOnce({
      ok: false,
      connectivity: false,
      authValid: false,
      reason: 'Member "offline-member" is unreachable: ECONNREFUSED',
      code: 'offline',
    });

    const result = await executeCommand({ member_id: member.id, command: 'echo hi', timeout_s: 5 });
    expect(typeof result).not.toBe('string');
    const { text, structuredContent } = result as ExecuteCommandResult;
    expect(text).toContain('[FAIL]');
    expect(text).toContain('offline-member');
    expect(structuredContent).toBeDefined();
    expect(structuredContent!.isError).toBe(true);
    expect(structuredContent!.reason).toBe('preflight_offline');
    expect(structuredContent!.exitCode).toBe(-1);
  });
});

describe('resolveTilde', () => {
  it('expands ~/path to homedir/path', () => {
    expect(resolveTilde('~/git/project')).toBe(os.homedir() + '/git/project');
  });

  it('expands bare ~ to homedir', () => {
    expect(resolveTilde('~')).toBe(os.homedir());
  });

  it('passes through absolute paths unchanged', () => {
    expect(resolveTilde('/absolute/path')).toBe('/absolute/path');
  });

  it('passes through relative paths unchanged', () => {
    expect(resolveTilde('relative/path')).toBe('relative/path');
  });
});

// ---------------------------------------------------------------------------
// F14: member.env injection at the execute_command dispatch sites
// ---------------------------------------------------------------------------

/**
 * The sync path prepends buildEnvPrefix(agent, {os, shell}) -- member.env AND
 * auth env, rendered in the member's ACTUAL shell form. `shell` matters
 * independently of `os`: a Windows member registered as Git-for-Windows bash
 * must get POSIX exports, not PowerShell `$env:` assignments its shell would
 * mis-parse.
 *
 * The long_running path is deliberately different: its env goes INSIDE the
 * generated wrapper script (which persists as a file on the member) and
 * carries member.env ONLY, never decrypted credentials.
 */
describe('execute_command: member.env at the dispatch sites (F14)', () => {
  const MEMBER_ENV = { FLEET_S9_A: "va'l$x", FLEET_S9_B: 'plain' };
  const AUTH_VALUE = 'super-secret-credential';

  const POSIX_PREFIX =
    "export FLEET_S9_A='va'" + String.fromCharCode(92) + "''l$x' && "
    + "export FLEET_S9_B='plain' && "
    + "export API_TOKEN='" + AUTH_VALUE + "' && ";
  const PS_PREFIX =
    "$env:FLEET_S9_A='va''l$x'; "
    + "$env:FLEET_S9_B='plain'; "
    + "$env:API_TOKEN='" + AUTH_VALUE + "'; ";

  function envMember(overrides: Partial<Agent> = {}): Agent {
    return makeTestAgent({
      env: MEMBER_ENV,
      encryptedEnvVars: { API_TOKEN: encryptPassword(AUTH_VALUE) },
      ...overrides,
    });
  }

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it.each([
    ['linux', undefined, 'posix'],
    ['macos', undefined, 'posix'],
    ['windows', undefined, 'powershell'],
    ['windows', 'pwsh7', 'powershell'],
    ['windows', 'powershell5', 'powershell'],
    // The row this feature exists for: os says Windows, shell says POSIX.
    ['windows', 'gitbash', 'posix'],
  ] as Array<[string, string | undefined, 'posix' | 'powershell']>)(
    'sync dispatch for os=%s shell=%s carries member.env in the %s form',
    async (agentOs, shell, form) => {
      const member = envMember({ os: agentOs as Agent['os'], shell: shell as Agent['shell'] });
      addAgent(member);
      mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

      await executeCommand({ member_id: member.id, command: 'ls', timeout_s: 5 });

      const dispatched = mockExecCommand.mock.calls[0][0] as string;
      expect(dispatched.startsWith(form === 'posix' ? POSIX_PREFIX : PS_PREFIX)).toBe(true);
      // ...and NOT the other shell's form.
      expect(dispatched).not.toContain(form === 'posix' ? '$env:FLEET_S9_A=' : 'export FLEET_S9_A=');
    },
  );

  it('no foreign reference: a member.env name appears ONLY in its own assignment', async () => {
    const member = envMember({
      os: 'linux',
      // A value that NAMES another member.env variable must stay inert text,
      // not become a live expansion the member shell resolves.
      env: { FLEET_S9_A: 'one', FLEET_S9_B: '$FLEET_S9_A' },
    });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    await executeCommand({ member_id: member.id, command: 'ls', timeout_s: 5 });
    const dispatched = mockExecCommand.mock.calls[0][0] as string;

    // Exactly two occurrences of the name: its own assignment, and the inert
    // literal inside FLEET_S9_B's single-quoted value (where POSIX performs
    // no expansion at all).
    expect(dispatched.match(/FLEET_S9_A/g)).toHaveLength(2);
    expect(dispatched).toContain("export FLEET_S9_B='$FLEET_S9_A'");
    expect(dispatched).not.toContain('$env:');
  });

  it('a member with no env and no credentials dispatches with no prefix at all', async () => {
    const member = makeTestAgent({ os: 'linux' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    await executeCommand({ member_id: member.id, command: 'ls', timeout_s: 5 });
    const dispatched = mockExecCommand.mock.calls[0][0] as string;
    expect(dispatched).not.toContain('export ');
    expect(dispatched).not.toContain('$env:');
  });

  it('long_running POSIX: run.sh carries member.env and NEVER the auth credential', async () => {
    const member = envMember({ os: 'linux' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    await executeCommand({ member_id: member.id, command: 'python train.py', long_running: true, timeout_s: 5 });

    const launch = mockExecCommand.mock.calls[0][0] as string;
    const b64 = launch.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/)?.[1];
    expect(b64, 'launcher did not carry a base64 run.sh').toBeTruthy();
    const runSh = Buffer.from(b64!, 'base64').toString('utf-8');

    expect(runSh).toContain("export FLEET_S9_B='plain'");
    expect(runSh).toContain("export FLEET_S9_A='va'" + String.fromCharCode(92) + "''l$x'");
    // The script persists as a file on the member -- credentials must not be
    // written into it (the sync path above deliberately DOES carry them).
    expect(runSh).not.toContain(AUTH_VALUE);
    expect(runSh).not.toContain('API_TOKEN');
    // The launcher prefix itself must not leak the credential either.
    expect(launch).not.toContain(AUTH_VALUE);
  });
});
