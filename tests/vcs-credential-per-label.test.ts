// One member can hold several VCS credential labels at once: the record, the
// helper file and the cleanup timer are per member+label. Every command is
// mocked (no real member, no real token); the registry is the throwaway test
// data dir from tests/setup.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent, getAgent } from '../src/services/registry.js';
import { provisionVcsAuth } from '../src/tools/provision-vcs-auth.js';
import { revokeVcsAuth } from '../src/tools/revoke-vcs-auth.js';
import { _getCleanupTimers, cancelCredentialCleanup, cleanupTimerKey } from '../src/services/credential-cleanup.js';
import { getVcsCredentials, listVcsCredentials } from '../src/services/vcs-credential-record.js';
import { vcsGitEnvPrefix } from '../src/services/vcs-git-env.js';
import type { SSHExecResult } from '../src/types.js';

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

vi.mock('../src/services/auth-socket.js', () => ({
  collectOobApiKey: vi.fn().mockResolvedValue({ fallback: '[FAIL] OOB cancelled in test.' }),
}));

const inOneHour = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

function execCmds(): string[] {
  return mockExecCommand.mock.calls.map(c => String(c[0]));
}

/** A command that removes the per-member helper of `label` (POSIX member: rm -f of its file). */
function revokesLabel(cmd: string, label: string): boolean {
  return cmd.includes('rm -f') && cmd.includes(`.fleet-git-credential-${label}.`);
}

async function provisionAz(memberId: string, label: string, opts: { scope?: string; pat?: string } = {}) {
  return provisionVcsAuth({
    member_id: memberId, provider: 'azure-devops',
    org_url: 'https://dev.azure.com/myorg', pat: opts.pat ?? `pat-${label}`,
    pat_expires_at: inOneHour(), label,
    ...(opts.scope ? { scope_url: opts.scope } : {}),
  });
}

describe('per-label VCS credential record', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });
  });

  afterEach(() => {
    for (const key of Array.from(_getCleanupTimers().keys())) cancelCredentialCleanup(key.split('|')[0]);
    restoreRegistry();
  });

  it('provisioning label A then label B keeps A\'s record, helper file and cleanup timer (no revoke for A)', async () => {
    const member = makeTestAgent({ friendlyName: 'two-labels', os: 'linux' });
    addAgent(member);

    expect((await provisionAz(member.id, 'az-a')).text).toContain('[OK]');
    mockExecCommand.mockClear();
    expect((await provisionAz(member.id, 'az-b')).text).toContain('[OK]');

    expect(execCmds().filter(c => revokesLabel(c, 'az-a'))).toEqual([]);
    expect(execCmds().some(c => c.includes('.fleet-git-credential-az-a'))).toBe(false);

    const map = getVcsCredentials(getAgent(member.id)!);
    expect(Object.keys(map)).toEqual(['az-a', 'az-b']);
    expect(map['az-a'].provider).toBe('azure-devops');
    expect(_getCleanupTimers().has(cleanupTimerKey(member.id, 'az-a'))).toBe(true);
    expect(_getCleanupTimers().has(cleanupTimerKey(member.id, 'az-b'))).toBe(true);
  });

  it('re-provisioning label A with a different scopeUrl re-registers only A (B untouched, old scope gone)', async () => {
    const member = makeTestAgent({ friendlyName: 'rescope', os: 'linux' });
    addAgent(member);
    await provisionAz(member.id, 'az-a', { scope: 'https://dev.azure.com/old-org' });
    await provisionAz(member.id, 'az-b');
    mockExecCommand.mockClear();

    await provisionAz(member.id, 'az-a', { scope: 'https://dev.azure.com/new-org' });

    // A member-scoped helper is one file per member+label: the write
    // overwrites it, and its registration comes from the record, so nothing
    // has to be revoked -- and label B is never touched.
    expect(execCmds().filter(c => c.includes('--unset-all') || c.includes('git config'))).toEqual([]);
    expect(execCmds().some(c => c.includes('.fleet-git-credential-az-b'))).toBe(false);
    const env = vcsGitEnvPrefix(getAgent(member.id)!);
    expect(env).toContain('credential.https://dev.azure.com/new-org.helper');
    expect(env).not.toContain('old-org');
    expect(getVcsCredentials(getAgent(member.id)!)['az-a'].scopeUrl).toBe('https://dev.azure.com/new-org');
    expect(getVcsCredentials(getAgent(member.id)!)['az-b']).toBeDefined();
  });

  it('migration: re-provisioning a label held as a LEGACY entry removes only this member own legacy file and global key, after the deploy', async () => {
    const member = makeTestAgent({
      friendlyName: 'legacy-mig', os: 'linux', host: 'build.example', username: 'ci',
      vcsProvider: 'azure-devops', vcsCredentialLabel: 'az-a', vcsCredentialScopeUrl: 'https://dev.azure.com/old-org',
    });
    addAgent(member);

    expect((await provisionAz(member.id, 'az-a', { scope: 'https://dev.azure.com/new-org' })).text).toContain('[OK]');

    const sent = execCmds();
    const write = sent.findIndex(c => c.includes(`.fleet-git-credential-az-a.${member.id}`) && c.includes('printf'));
    const legacy = sent.findIndex(c => c.includes('--unset-all'));
    expect(write).toBeGreaterThan(-1);
    expect(legacy).toBeGreaterThan(write);
    expect(sent[legacy]).toContain('credential.https://dev.azure.com/old-org.helper');
    expect(sent[legacy]).toContain('rm -f "$HOME/.fleet-git-credential-az-a"');
    expect(sent.filter(c => c.includes('--unset-all'))).toHaveLength(1);
    // The per-member helper the deploy just wrote must survive the migration:
    // no later command may remove .fleet-git-credential-az-a.<memberId>.
    const perMemberFile = `.fleet-git-credential-az-a.${member.id}`;
    expect(sent.slice(write + 1).filter(c => c.includes('rm -f') && c.includes(perMemberFile))).toEqual([]);
    expect(getVcsCredentials(getAgent(member.id)!)['az-a']).toMatchObject({ memberScoped: true, scopeUrl: 'https://dev.azure.com/new-org' });
  });

  it('migration: a legacy entry another member on the same host+user may still use is left in place', async () => {
    const member = makeTestAgent({
      friendlyName: 'legacy-shared', os: 'linux', host: 'build.example', username: 'ci',
      vcsProvider: 'azure-devops', vcsCredentialLabel: 'az-a', vcsCredentialScopeUrl: 'https://dev.azure.com/old-org',
    });
    const sibling = makeTestAgent({ friendlyName: 'sibling', os: 'linux', host: 'build.example', username: 'ci' });
    addAgent(member);
    addAgent(sibling);

    expect((await provisionAz(member.id, 'az-a')).text).toContain('[OK]');

    expect(execCmds().filter(c => c.includes('--unset-all') || c.includes('"$HOME/.fleet-git-credential-az-a"'))).toEqual([]);
    expect(getVcsCredentials(getAgent(member.id)!)['az-a'].memberScoped).toBe(true);
  });

  it('re-provisioning label A with the same scope issues no revoke', async () => {
    const member = makeTestAgent({ friendlyName: 'refresh', os: 'linux' });
    addAgent(member);
    await provisionAz(member.id, 'az-a');
    mockExecCommand.mockClear();
    await provisionAz(member.id, 'az-a', { pat: 'pat-refreshed' });
    expect(execCmds().filter(c => c.includes('--unset-all') || revokesLabel(c, 'az-a'))).toEqual([]);
  });

  it('revoke_vcs_auth with no label revokes every recorded label of that provider, drops the records and cancels their timers', async () => {
    const member = makeTestAgent({ friendlyName: 'revoke-all', os: 'linux' });
    addAgent(member);
    await provisionAz(member.id, 'az-a');
    await provisionAz(member.id, 'az-b');
    mockExecCommand.mockClear();

    const result = await revokeVcsAuth({ member_id: member.id, provider: 'azure-devops' });

    expect(result).toContain('label az-a');
    expect(result).toContain('label az-b');
    expect(execCmds().filter(c => revokesLabel(c, 'az-a'))).toHaveLength(1);
    expect(execCmds().filter(c => revokesLabel(c, 'az-b'))).toHaveLength(1);
    expect(getVcsCredentials(getAgent(member.id)!)).toEqual({});
    expect(getAgent(member.id)!.vcsCredentialLabel).toBeUndefined();
    expect(_getCleanupTimers().has(cleanupTimerKey(member.id, 'az-a'))).toBe(false);
    expect(_getCleanupTimers().has(cleanupTimerKey(member.id, 'az-b'))).toBe(false);
  });

  it('revoke_vcs_auth with a label revokes only that label, at its recorded scope', async () => {
    const member = makeTestAgent({ friendlyName: 'revoke-one', os: 'linux' });
    addAgent(member);
    await provisionAz(member.id, 'az-a', { scope: 'https://dev.azure.com/org-a' });
    await provisionAz(member.id, 'az-b');
    mockExecCommand.mockClear();

    await revokeVcsAuth({ member_id: member.id, provider: 'azure-devops', label: 'az-a' });

    expect(execCmds()).toHaveLength(1);
    expect(revokesLabel(execCmds()[0], 'az-a')).toBe(true);
    expect(execCmds()[0]).not.toContain('git config');
    expect(Object.keys(getVcsCredentials(getAgent(member.id)!))).toEqual(['az-b']);
    expect(getAgent(member.id)!.vcsCredentialLabel).toBe('az-b');
    expect(_getCleanupTimers().has(cleanupTimerKey(member.id, 'az-a'))).toBe(false);
    expect(_getCleanupTimers().has(cleanupTimerKey(member.id, 'az-b'))).toBe(true);
  });
});

describe('legacy single-field registry entries', () => {
  it('a member with only the legacy single fields reads as a one-label map', () => {
    const agent = makeTestAgent({
      vcsProvider: 'github', vcsCredentialLabel: 'work-github',
      vcsCredentialScopeUrl: 'https://github.com/my-org', vcsTokenExpiresAt: '2030-01-01T00:00:00Z',
    });
    expect(getVcsCredentials(agent)).toEqual({
      'work-github': { provider: 'github', scopeUrl: 'https://github.com/my-org', expiresAt: '2030-01-01T00:00:00Z' },
    });
    expect(listVcsCredentials(agent)).toEqual([
      { label: 'work-github', provider: 'github', scopeUrl: 'https://github.com/my-org', expiresAt: '2030-01-01T00:00:00Z' },
    ]);
  });

  it('a legacy label with no recorded scope reads the provider default host URL', () => {
    const agent = makeTestAgent({ vcsProvider: 'bitbucket', vcsCredentialLabel: 'bitbucket' });
    expect(getVcsCredentials(agent)).toEqual({ bitbucket: { provider: 'bitbucket', scopeUrl: 'https://bitbucket.org' } });
  });

  it('a provider with no label reads as one unlabeled entry (revoked as before), not a labeled one', () => {
    const agent = makeTestAgent({ vcsProvider: 'github' });
    expect(getVcsCredentials(agent)).toEqual({});
    expect(listVcsCredentials(agent)).toEqual([{ label: undefined, provider: 'github', scopeUrl: undefined, expiresAt: undefined }]);
  });

  it('the per-label map, when present, wins over the legacy fields', () => {
    const agent = makeTestAgent({
      vcsProvider: 'github', vcsCredentialLabel: 'stale',
      vcsCredentials: { a: { provider: 'github', scopeUrl: 'https://github.com' } },
    });
    expect(Object.keys(getVcsCredentials(agent))).toEqual(['a']);
    expect(listVcsCredentials({ ...agent, vcsCredentials: {} })).toEqual([]);
  });
});
