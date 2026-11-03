/**
 * Bitbucket credential provisioning: fixed token username, optional email,
 * two-channel (REST Bearer + git ls-remote) verification and the 0.4.4
 * upgrade path (helper username = email rewritten on re-provision).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { provisionVcsAuth } from '../src/tools/provision-vcs-auth.js';
import { bitbucketProvider, BITBUCKET_TOKEN_USERNAME, parseBitbucketRemote } from '../src/services/vcs/bitbucket.js';
import { LinuxCommands, MacOSCommands, WindowsCommands } from '../src/os/index.js';
import type { OsCommands } from '../src/os/index.js';
import type { Agent, SSHExecResult } from '../src/types.js';

const mockCollectOobApiKey = vi.fn<(memberName: string, toolName: string, opts?: any) => Promise<{ password?: string; fallback?: string }>>();
vi.mock('../src/services/auth-socket.js', () => ({
  collectOobApiKey: (memberName: string, toolName: string, opts?: any) => mockCollectOobApiKey(memberName, toolName, opts),
}));

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

const TOKEN = 'ATBB_secret_value_123';
const ORIGIN = 'https://bitbucket.org/my-ws/app.git';

type Outcome = { rest: string; git: 'ok' | 'auth' | 'other' };

/** Stub member: answers the origin probe, the REST status probe and the
 *  ls-remote according to `outcome`; every other command succeeds. */
function stubMember(outcome: Outcome): void {
  mockExecCommand.mockImplementation(async (cmd: string) => {
    if (cmd.includes('remote get-url origin')) return { stdout: `${ORIGIN}\n`, stderr: '', code: 0 };
    if (cmd.includes('api.bitbucket.org')) return { stdout: outcome.rest, stderr: '', code: 0 };
    if (cmd.includes('git ls-remote')) {
      if (outcome.git === 'ok') return { stdout: 'abc123\tHEAD\nFLEET_GIT_LS_REMOTE_OK\n', stderr: '', code: 0 };
      if (outcome.git === 'auth') return { stdout: '', stderr: "remote: Invalid credentials\nfatal: Authentication failed for 'https://bitbucket.org/my-ws/app.git/'", code: 128 };
      return { stdout: '', stderr: 'fatal: unable to access: Could not resolve host', code: 128 };
    }
    return { stdout: '', stderr: '', code: 0 };
  });
}

function issued(): string[] {
  return mockExecCommand.mock.calls.map((c) => c[0]);
}

function helperWrites(): string[] {
  return issued().filter((c) => c.includes('.fleet-git-credential') && c.includes('password='));
}

/** The username= value a helper-write command bakes in. */
function writtenUsername(cmd: string): string | null {
  const m = /username=([^"'\\\s]*)/.exec(cmd);
  return m ? m[1] : null;
}

describe('Bitbucket helper write: fixed token username on every OS command set', () => {
  const sets: Array<[string, OsCommands]> = [
    ['linux', new LinuxCommands()],
    ['macos', new MacOSCommands()],
    ['windows', new WindowsCommands()],
  ];
  for (const [os, cmds] of sets) {
    for (const email of [undefined, 'someone@example.com']) {
      it(`${os}: username is ${BITBUCKET_TOKEN_USERNAME} ${email ? 'with' : 'without'} email`, async () => {
        const calls: string[] = [];
        const exec = async (cmd: string) => { calls.push(cmd); return ''; };
        const creds = bitbucketProvider.buildCredentials!({ provider: 'bitbucket', api_token: TOKEN, workspace: 'my-ws', ...(email ? { email } : {}) });
        expect(typeof creds).toBe('object');
        await bitbucketProvider.deploy(makeTestAgent({ os: os as Agent['os'] }), cmds, exec, creds);
        expect(calls).toHaveLength(1);
        expect(writtenUsername(calls[0])).toBe('x-bitbucket-api-token-auth');
        expect(calls[0]).not.toContain('@example.com');
        // No username value anywhere in the command contains '@'.
        expect(calls[0]).not.toMatch(/username=[^"'\s]*@/);
      });
    }
  }
});

describe('parseBitbucketRemote', () => {
  it('parses https, scp and ssh:// forms and drops embedded credentials', () => {
    expect(parseBitbucketRemote('https://me:tok@bitbucket.org/ws/repo.git')).toEqual({ workspace: 'ws', repo: 'repo' });
    expect(parseBitbucketRemote('git@bitbucket.org:ws/repo.git')).toEqual({ workspace: 'ws', repo: 'repo' });
    expect(parseBitbucketRemote('ssh://git@altssh.bitbucket.org:443/ws/repo.git')).toEqual({ workspace: 'ws', repo: 'repo' });
  });
  it('rejects lookalike hosts and unsafe slugs', () => {
    expect(parseBitbucketRemote('https://bitbucket.org.evil.example/ws/repo.git')).toBeNull();
    expect(parseBitbucketRemote('https://github.com/ws/repo.git')).toBeNull();
    expect(parseBitbucketRemote('https://bitbucket.org/ws/re$(id)po.git')).toBeNull();
  });
});

describe('provision_vcs_auth bitbucket', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    mockCollectOobApiKey.mockResolvedValue({ fallback: '[FAIL] OOB cancelled in test.' });
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
  });

  afterEach(() => {
    restoreRegistry();
  });

  function addMember(overrides: Partial<Agent> = {}): Agent {
    const member = makeTestAgent({ friendlyName: `bb-${Math.random().toString(36).slice(2, 8)}`, ...overrides });
    addAgent(member);
    return member;
  }

  it('api_token + workspace without email reaches deploy (no credential_assembly_failed)', async () => {
    const member = addMember();
    stubMember({ rest: '200', git: 'ok' });
    const { structuredContent } = await provisionVcsAuth({
      member_id: member.id, provider: 'bitbucket', api_token: TOKEN, workspace: 'my-ws',
    });
    expect(structuredContent.reason).not.toBe('credential_assembly_failed');
    expect(structuredContent.ok).toBe(true);
    expect(helperWrites()).toHaveLength(1);
    expect(writtenUsername(helperWrites()[0])).toBe('x-bitbucket-api-token-auth');
  });

  it('email, when given, is ignored for auth', async () => {
    const member = addMember();
    stubMember({ rest: '200', git: 'ok' });
    await provisionVcsAuth({
      member_id: member.id, provider: 'bitbucket', api_token: TOKEN, workspace: 'my-ws', email: 'dev@co.com',
    });
    for (const cmd of issued()) expect(cmd).not.toContain('dev@co.com');
  });

  it('REST 200 + git ok -> verified true, reason ok', async () => {
    const member = addMember();
    stubMember({ rest: '200', git: 'ok' });
    const { text, structuredContent } = await provisionVcsAuth({
      member_id: member.id, provider: 'bitbucket', api_token: TOKEN, workspace: 'my-ws',
    });
    expect(structuredContent.reason).toBe('ok');
    expect(structuredContent.verified).toBe(true);
    expect(structuredContent.verificationReason).toBe('ok');
    expect(text).not.toContain(TOKEN);
  });

  it('REST 200 + git auth failure -> not verified, git channel named', async () => {
    const member = addMember();
    stubMember({ rest: '200', git: 'auth' });
    const { text, structuredContent } = await provisionVcsAuth({
      member_id: member.id, provider: 'bitbucket', api_token: TOKEN, workspace: 'my-ws',
    });
    expect(structuredContent.verified).toBe(false);
    expect(structuredContent.reason).toBe('deployed_unverified');
    expect(structuredContent.verificationReason).toBe('git_auth_failed');
    expect(text).toContain('git_auth_failed');
    expect(text).not.toContain(TOKEN);
  });

  it('REST 200 + git non-auth failure -> git_failed', async () => {
    const member = addMember();
    stubMember({ rest: '200', git: 'other' });
    const { structuredContent } = await provisionVcsAuth({
      member_id: member.id, provider: 'bitbucket', api_token: TOKEN, workspace: 'my-ws',
    });
    expect(structuredContent.verified).toBe(false);
    expect(structuredContent.verificationReason).toBe('git_failed');
  });

  it('REST 401 -> not verified, REST channel named (a 401 never reads as success)', async () => {
    const member = addMember();
    stubMember({ rest: '401', git: 'ok' });
    const { text, structuredContent } = await provisionVcsAuth({
      member_id: member.id, provider: 'bitbucket', api_token: TOKEN, workspace: 'my-ws',
    });
    expect(structuredContent.verified).toBe(false);
    expect(structuredContent.reason).toBe('deployed_unverified');
    expect(structuredContent.verificationReason).toBe('rest_unauthorized');
    expect(text).toContain('rest_unauthorized');
    expect(text).not.toContain(TOKEN);
    // The git channel is not reached once REST fails.
    expect(issued().some((c) => c.includes('git ls-remote'))).toBe(false);
  });

  it('REST 404 -> rest_failed', async () => {
    const member = addMember();
    stubMember({ rest: '404', git: 'ok' });
    const { structuredContent } = await provisionVcsAuth({
      member_id: member.id, provider: 'bitbucket', api_token: TOKEN, workspace: 'my-ws',
    });
    expect(structuredContent.verified).toBe(false);
    expect(structuredContent.verificationReason).toBe('rest_failed');
  });

  it('never probes /2.0/user; REST uses Bearer, never -u user:token', async () => {
    for (const os of ['linux', 'windows'] as const) {
      mockExecCommand.mockClear();
      const member = addMember({ os });
      stubMember({ rest: '200', git: 'ok' });
      await provisionVcsAuth({ member_id: member.id, provider: 'bitbucket', api_token: TOKEN, workspace: 'my-ws' });
      const all = issued();
      for (const cmd of all) expect(cmd).not.toContain('api.bitbucket.org/2.0/user');
      const rest = all.filter((c) => c.includes('api.bitbucket.org'));
      expect(rest).toHaveLength(1);
      expect(rest[0]).toContain('https://api.bitbucket.org/2.0/repositories/my-ws/app');
      expect(rest[0]).toMatch(/Authorization[:=\s']+Bearer/);
      expect(rest[0]).not.toMatch(/\s-u\s/);
      const ls = all.filter((c) => c.includes('git ls-remote'));
      expect(ls).toHaveLength(1);
      expect(ls[0]).toContain('GIT_TERMINAL_PROMPT');
      expect(ls[0]).toContain('GCM_INTERACTIVE');
      expect(ls[0]).toContain('https://bitbucket.org/my-ws/app.git');
    }
  });

  it('0.4.4-shaped member (helper username = email) is rewritten to the fixed username', async () => {
    // A member provisioned by 0.4.4: same label and scope, so this is a plain
    // refresh, and its helper on disk still prints username=someone@example.com.
    const member = addMember({
      vcsProvider: 'bitbucket',
      vcsCredentialLabel: 'bitbucket',
      vcsCredentialScopeUrl: 'https://bitbucket.org',
    });
    stubMember({ rest: '200', git: 'ok' });
    const legacyHelper = 'protocol=https\nhost=bitbucket.org\nusername=someone@example.com\npassword=old';
    const readHelper = new LinuxCommands().gitCredentialHelperRead('bitbucket').command;
    const base = mockExecCommand.getMockImplementation()!;
    mockExecCommand.mockImplementation(async (cmd: string, t?: number) => {
      // Anything that reads the existing helper would see the email line.
      if (cmd.trim() === readHelper) return { stdout: legacyHelper, stderr: '', code: 0 };
      return base(cmd, t);
    });

    const { structuredContent } = await provisionVcsAuth({
      member_id: member.id, provider: 'bitbucket', api_token: TOKEN, workspace: 'my-ws',
    });
    expect(structuredContent.ok).toBe(true);
    const writes = helperWrites();
    expect(writes).toHaveLength(1);
    expect(writtenUsername(writes[0])).toBe('x-bitbucket-api-token-auth');
    expect(writes[0]).not.toContain('someone@example.com');
    // Nothing read the old helper: no command executes the helper file itself.
    expect(issued().some((c) => c.trim() === readHelper)).toBe(false);
  });
});
