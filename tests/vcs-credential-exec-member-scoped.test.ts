// vcs_credential_exec reads a member-scoped credential from the member's OWN
// helper file (`.fleet-git-credential-<label>.<member id>`), on all three
// helper shapes (POSIX script, windows-powershell .bat via the call operator,
// windows-gitbash .bat via bash), and dispatches the command with the member's
// git credential environment. A legacy entry keeps reading the shared file.
// Every command is mocked; no real member and no real token.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { vcsCredentialExec } from '../src/tools/vcs-credential-exec.js';
import type { Agent, SSHExecResult } from '../src/types.js';

const { mockExecCommand } = vi.hoisted(() => ({
  mockExecCommand: vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>(),
}));

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: vi.fn().mockResolvedValue({ ok: true }),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

const shapes: Array<[string, Partial<Agent>, RegExp]> = [
  ['linux', { os: 'linux' }, /^"\$HOME\/\.fleet-git-credential-github\.([\w-]+)"$/],
  ['windows-powershell', { os: 'windows', shell: 'powershell5' }, /^& "\$env:USERPROFILE\\\.fleet-git-credential-github\.([\w-]+)\.bat"$/],
  ['windows-gitbash', { os: 'windows', shell: 'gitbash' }, /^"\$HOME\/\.fleet-git-credential-github\.([\w-]+)\.bat"$/],
];

describe('vcs_credential_exec: member-scoped helper path', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    mockExecCommand.mockImplementation(async (cmd: string) => (
      cmd.includes('.fleet-git-credential-github') && !cmd.includes('GIT_CONFIG_PARAMETERS')
        ? { stdout: 'protocol=https\nhost=github.com\nusername=x-access-token\npassword=fake-token\n', stderr: '', code: 0 }
        : { stdout: '', stderr: '', code: 0 }
    ));
  });
  afterEach(() => restoreRegistry());

  for (const [name, overrides, readShape] of shapes) {
    it(`${name}: reads the member's own helper and dispatches with its git credential environment`, async () => {
      const member = makeTestAgent({
        friendlyName: `scoped-${name}`, ...overrides,
        vcsCredentials: { github: { provider: 'github', scopeUrl: 'https://github.com', memberScoped: true } },
      });
      addAgent(member);

      const res = await vcsCredentialExec({ member_id: member.id, label: 'github', command: 'git push {{vcs_token}}' });
      expect(res.structuredContent?.ok).toBe(true);

      const [readCmd, dispatched] = mockExecCommand.mock.calls.map(c => String(c[0]));
      const m = readShape.exec(readCmd);
      expect(m?.[1]).toBe(member.id);
      expect(dispatched.startsWith(name === 'windows-powershell' ? '$env:GIT_CONFIG_PARAMETERS = ' : 'export GIT_CONFIG_PARAMETERS=')).toBe(true);
      expect(dispatched).toContain(`.fleet-git-credential-github.${member.id}`);
    });

    it(`${name}: a legacy (not member-scoped) entry still reads the shared per-OS-user file`, async () => {
      const member = makeTestAgent({ friendlyName: `legacy-${name}`, ...overrides, vcsProvider: 'github', vcsCredentialLabel: 'github' });
      addAgent(member);

      await vcsCredentialExec({ member_id: member.id, label: 'github', command: 'git push {{vcs_token}}' });

      const [readCmd, dispatched] = mockExecCommand.mock.calls.map(c => String(c[0]));
      expect(readCmd).toContain('.fleet-git-credential-github');
      expect(readCmd).not.toContain(member.id);
      expect(dispatched).not.toContain('GIT_CONFIG_PARAMETERS');
    });
  }
});
