/**
 * vcs_credential_exec `secret` + `username`: the token is taken from the fleet
 * credential store by NAME (resolved server-side at call time) instead of the
 * member's deployed credential helper, so a caller can pick one of several
 * stored accounts per call. Asserts against the command the tool actually
 * dispatches and the payload it actually returns.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { escapeShellArgInner, escapePowerShellArgInner } from '../src/utils/shell-escape.js';
import { vcsCredentialExec, isSecretName } from '../src/tools/vcs-credential-exec.js';
import type { SSHExecResult } from '../src/types.js';

const { mockExecCommand, mockResolve } = vi.hoisted(() => ({
  mockExecCommand: vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>(),
  mockResolve: vi.fn(),
}));

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: vi.fn().mockResolvedValue({ ok: true }),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock('../src/services/credential-store.js', () => ({
  credentialResolve: mockResolve,
}));

const TOKEN_A = "SENTINEL-NOT-A-REAL-TOKEN-a'1";
const TOKEN_B = 'SENTINEL-NOT-A-REAL-TOKEN-b2';
const USER = 'sentinel@example.invalid';
const COMMAND = "curl -sS -u '{{vcs_username_inline}}:{{vcs_token_inline}}' https://api.bitbucket.org/2.0/user";

function storeWith(entries: Record<string, { plaintext: string; network_policy?: 'allow' | 'confirm' | 'deny' }>): void {
  mockResolve.mockImplementation((name: string) => {
    const e = entries[name];
    if (!e) return null;
    return { plaintext: e.plaintext, meta: { name, scope: 'persistent', network_policy: e.network_policy ?? 'allow', created_at: '', allowedMembers: '*' } };
  });
}

function unwrapPidCapture(wrapped: string): string {
  const posix = /^\{ ([\s\S]*); \} & _fleet_pid=\$!; printf 'FLEET_PID:%s\\n' "\$_fleet_pid"; wait "\$_fleet_pid"; exit \$\?$/.exec(wrapped);
  if (posix) return posix[1];
  const psh = /^Write-Output "FLEET_PID:\$pid"; ([\s\S]*)$/.exec(wrapped);
  if (psh) return psh[1];
  throw new Error(`not under the FLEET_PID wrapper: ${wrapped}`);
}

describe('vcs_credential_exec: credential-store `secret` source', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockExecCommand.mockResolvedValue({ stdout: '{}\n200', stderr: '', code: 0 });
  });
  afterEach(() => {
    restoreRegistry();
    consoleErrorSpy.mockRestore();
  });

  it('two calls naming two secrets dispatch two different tokens, and never read the helper', async () => {
    const member = makeTestAgent({ friendlyName: 'store-two', os: 'linux' });
    addAgent(member);
    storeWith({ bitbucket_project_a: { plaintext: TOKEN_A }, bitbucket_project_b: { plaintext: TOKEN_B } });

    const a = await vcsCredentialExec({ member_id: member.id, command: COMMAND, secret: 'bitbucket_project_a', username: USER });
    const b = await vcsCredentialExec({ member_id: member.id, command: COMMAND, secret: 'bitbucket_project_b', username: USER });

    expect(a.structuredContent.reason).toBe('ok');
    expect(b.structuredContent.reason).toBe('ok');
    const sent = mockExecCommand.mock.calls.map(([c]) => c as string);
    expect(sent.some((c) => c.includes('.fleet-git-credential'))).toBe(false);
    expect(unwrapPidCapture(sent[0])).toBe(`curl -sS -u '${escapeShellArgInner(USER)}:${escapeShellArgInner(TOKEN_A)}' https://api.bitbucket.org/2.0/user`);
    expect(unwrapPidCapture(sent[1])).toBe(`curl -sS -u '${escapeShellArgInner(USER)}:${escapeShellArgInner(TOKEN_B)}' https://api.bitbucket.org/2.0/user`);
    expect(a.structuredContent.credentialLabel).toBeNull();
    expect(a.structuredContent.credentialSecret).toBe('bitbucket_project_a');
    expect(b.structuredContent.credentialSecret).toBe('bitbucket_project_b');
    expect(mockResolve).toHaveBeenCalledWith('bitbucket_project_a', 'store-two');
  });

  it('PowerShell member gets the doubled-quote interior escaping', async () => {
    const member = makeTestAgent({ friendlyName: 'store-psh', os: 'windows' });
    addAgent(member);
    storeWith({ bb: { plaintext: TOKEN_A } });
    const r = await vcsCredentialExec({ member_id: member.id, command: COMMAND, secret: 'bb', username: USER });
    expect(r.structuredContent.reason).toBe('ok');
    expect(unwrapPidCapture(mockExecCommand.mock.calls[0][0] as string))
      .toBe(`curl -sS -u '${escapePowerShellArgInner(USER)}:${escapePowerShellArgInner(TOKEN_A)}' https://api.bitbucket.org/2.0/user`);
  });

  it('the token and username are redacted out of the returned output', async () => {
    const member = makeTestAgent({ friendlyName: 'store-redact', os: 'linux' });
    addAgent(member);
    storeWith({ bb: { plaintext: TOKEN_B } });
    mockExecCommand.mockResolvedValue({ stdout: `echo ${USER}:${TOKEN_B}`, stderr: TOKEN_B, code: 0 });
    const r = await vcsCredentialExec({ member_id: member.id, command: COMMAND, secret: 'bb', username: USER });
    expect(JSON.stringify(r)).not.toContain(TOKEN_B);
    expect(JSON.stringify(r)).not.toContain(USER);
    expect(r.structuredContent.tokenRedactions).toBe(3);
  });

  it('a missing secret is secret_not_found, names the entry and the command to store it, dispatches nothing', async () => {
    const member = makeTestAgent({ friendlyName: 'store-missing', os: 'linux' });
    addAgent(member);
    storeWith({});
    const r = await vcsCredentialExec({ member_id: member.id, command: COMMAND, secret: 'bitbucket_kumaakh', username: USER });
    expect(r.structuredContent.reason).toBe('secret_not_found');
    expect(r.structuredContent.ok).toBe(false);
    expect(r.text).toContain("no entry named 'bitbucket_kumaakh'");
    expect(r.text).toContain('credential_store_set name=bitbucket_kumaakh');
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('network_policy other than allow is secret_denied (no unattended OOB prompt), dispatches nothing', async () => {
    const member = makeTestAgent({ friendlyName: 'store-confirm', os: 'linux' });
    addAgent(member);
    storeWith({ bb: { plaintext: TOKEN_A, network_policy: 'confirm' } });
    const r = await vcsCredentialExec({ member_id: member.id, command: COMMAND, secret: 'bb', username: USER });
    expect(r.structuredContent.reason).toBe('secret_denied');
    expect(r.text).toContain('credential_store_update name=bb network_policy=allow');
    expect(JSON.stringify(r)).not.toContain(TOKEN_A);
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('a token-shaped `secret` is refused without echoing it or touching the store', async () => {
    const member = makeTestAgent({ friendlyName: 'store-tokenshape', os: 'linux' });
    addAgent(member);
    for (const value of [
      'ATATT3xFfGF0SENTINEL', 'Ab1cD2eF3gH4iJ5kL6mN',
      'a3f9c1e07b2d4f6a8c0e1b3d5f7a9c1e3b5d7f90', 'k2j4h6g8f0d2s4a6p8o0',
      'c2VjcmV0dG9rZW4=', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig', 'me@example.com', 'u:p', 'ghp_SENTINEL',
    ]) {
      const r = await vcsCredentialExec({ member_id: member.id, command: COMMAND, secret: value, username: USER });
      expect(r.structuredContent.reason).toBe('secret_denied');
      expect(JSON.stringify(r)).not.toContain(value);
    }
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('isSecretName accepts ordinary names and matches the fleet-sprint grammar', () => {
    for (const n of ['bitbucket_kumaakh', 'bitbucket_api_token', 'bitbucket-work', 'BitbucketWork', 'bb2', 'acme_bitbucket_2024']) {
      expect(isSecretName(n)).toBe(true);
    }
  });

  it('a member-scoped denial is secret_denied', async () => {
    const member = makeTestAgent({ friendlyName: 'store-scoped', os: 'linux' });
    addAgent(member);
    mockResolve.mockReturnValue({ denied: "Credential 'bb' is not accessible to member 'store-scoped'." });
    const r = await vcsCredentialExec({ member_id: member.id, command: COMMAND, secret: 'bb', username: USER });
    expect(r.structuredContent.reason).toBe('secret_denied');
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('a username placeholder with no `username` is username_empty, dispatches nothing', async () => {
    const member = makeTestAgent({ friendlyName: 'store-nouser', os: 'linux' });
    addAgent(member);
    storeWith({ bb: { plaintext: TOKEN_A } });
    const r = await vcsCredentialExec({ member_id: member.id, command: COMMAND, secret: 'bb' });
    expect(r.structuredContent.reason).toBe('username_empty');
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('without `secret` the deployed helper is read as before', async () => {
    const member = makeTestAgent({ friendlyName: 'helper-path', os: 'linux' });
    addAgent(member);
    mockExecCommand.mockImplementation(async (cmd: string) => (cmd.includes('.fleet-git-credential')
      ? { stdout: `username=${USER}\npassword=${TOKEN_A}\n`, stderr: '', code: 0 }
      : { stdout: '', stderr: '', code: 0 }));
    const r = await vcsCredentialExec({ member_id: member.id, command: COMMAND, label: 'bitbucket' });
    expect(r.structuredContent.reason).toBe('ok');
    expect(r.structuredContent.credentialLabel).toBe('bitbucket');
    expect(r.structuredContent.credentialSecret).toBeNull();
    expect(mockResolve).not.toHaveBeenCalled();
  });
});
