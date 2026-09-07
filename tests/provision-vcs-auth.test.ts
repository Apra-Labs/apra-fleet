import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry, FLEET_DIR } from './test-helpers.js';
import { addAgent, getAgent } from '../src/services/registry.js';
import { credentialSet, credentialDelete } from '../src/services/credential-store.js';
import { encryptPassword } from '../src/utils/crypto.js';
import { provisionVcsAuth } from '../src/tools/provision-vcs-auth.js';
import type { SSHExecResult } from '../src/types.js';
const GIT_CONFIG_PATH = path.join(FLEET_DIR, 'git-config.json');

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

vi.mock('../src/services/github-app.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/github-app.js')>('../src/services/github-app.js');
  return {
    ...actual,
    mintGitToken: vi.fn(),
    loadPrivateKey: vi.fn().mockReturnValue('-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----'),
  };
});

import { mintGitToken } from '../src/services/github-app.js';
const mockMint = vi.mocked(mintGitToken);

let gitConfigBackup: string | null = null;

function setGitHubAppConfig(): void {
  const config = {
    version: '1.0',
    github: { appId: '123', privateKeyPath: '/tmp/test.pem', installationId: 999, createdAt: '2026-01-01T00:00:00Z' },
  };
  fs.writeFileSync(GIT_CONFIG_PATH, JSON.stringify(config, null, 2));
}

describe('provisionVcsAuth', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    mockCollectOobApiKey.mockResolvedValue({ fallback: '[FAIL] OOB cancelled in test.' });
    if (fs.existsSync(GIT_CONFIG_PATH)) {
      gitConfigBackup = fs.readFileSync(GIT_CONFIG_PATH, 'utf-8');
    }
  });

  afterEach(() => {
    restoreRegistry();
    if (gitConfigBackup !== null) {
      fs.writeFileSync(GIT_CONFIG_PATH, gitConfigBackup);
      gitConfigBackup = null;
    } else if (fs.existsSync(GIT_CONFIG_PATH)) {
      fs.unlinkSync(GIT_CONFIG_PATH);
    }
  });

  it('returns not found for invalid member ID', async () => {
    const { text: result } = await provisionVcsAuth({ member_id: 'nonexistent', provider: 'github' });
    expect(result).toContain('not found');
  });

  it('fails when member is offline', async () => {
    const member = makeTestAgent({ friendlyName: 'offline' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: false, latencyMs: 0, error: 'Timeout' });

    const { text: result } = await provisionVcsAuth({
      member_id: member.id, provider: 'bitbucket',
      email: 'a@b.com', api_token: 'tok', workspace: 'ws',
    });
    expect(result).toContain('[FAIL]');
    expect(result).toContain('offline');
  });

  // --- Bitbucket ---

  it('bitbucket: OOB cancellation returns error when api_token is absent', async () => {
    const member = makeTestAgent({ friendlyName: 'bb-missing' });
    addAgent(member);
    const { text: result } = await provisionVcsAuth({ member_id: member.id, provider: 'bitbucket' });
    expect(result).toContain('[FAIL]');
  });

  it('bitbucket: deploys credentials successfully', async () => {
    const member = makeTestAgent({ friendlyName: 'bb-ok' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const { text: result } = await provisionVcsAuth({
      member_id: member.id, provider: 'bitbucket',
      email: 'dev@co.com', api_token: 'ATBB_xyz', workspace: 'my-ws',
    });
    expect(result).toContain('[OK]');
    expect(result).toContain('Bitbucket');
    expect(result).toContain('my-ws');
  });

  // --- Azure DevOps ---

  it('azure-devops: OOB cancellation returns error when pat is absent', async () => {
    const member = makeTestAgent({ friendlyName: 'az-missing' });
    addAgent(member);
    const { text: result } = await provisionVcsAuth({ member_id: member.id, provider: 'azure-devops' });
    expect(result).toContain('[FAIL]');
  });

  it('azure-devops: deploys credentials successfully', async () => {
    const member = makeTestAgent({ friendlyName: 'az-ok' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const { text: result } = await provisionVcsAuth({
      member_id: member.id, provider: 'azure-devops',
      org_url: 'https://dev.azure.com/myorg', pat: 'az-pat-999',
    });
    expect(result).toContain('[OK]');
    expect(result).toContain('Azure DevOps');
    // apra-fleet-5co8.43: this member has no gitRepos and only an org-level
    // scope_url, so testConnectivity() cannot derive a concrete repo and
    // skips -- the user-facing "Verification:" line must render that
    // distinctly (the [SKIP] marker, driven by the `skipped` field), never as a
    // bare passing check that merely happens to mention "Skipped" in its
    // message text.
    expect(result).toMatch(/Verification: \[SKIP\] Skipped:/);
    expect(result).not.toMatch(/Verification: git ls-remote/);
  });

  // apra-fleet-5co8.5.4: azure-devops exposes no API to read a PAT's expiry
  // back, so a caller that omits pat_expires_at must leave the registry
  // exactly as it was before apra-fleet-5co8.5.1 added expiry propagation --
  // same shape as the bitbucket "persists vcsProvider without expiresAt"
  // case above, but pinned for azure-devops specifically since (unlike
  // bitbucket) this provider DOES support an expiry and the omitted-vs-unset
  // distinction (deployResult.metadata?.expiresAt undefined, never an
  // "undefined" string or a stale prior value) matters here.
  it('azure-devops: no-expiry provisioning leaves vcsTokenExpiresAt unset in the registry', async () => {
    const member = makeTestAgent({ friendlyName: 'az-no-expiry' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const { text: result } = await provisionVcsAuth({
      member_id: member.id, provider: 'azure-devops',
      org_url: 'https://dev.azure.com/myorg', pat: 'az-pat-999',
    });

    expect(result).toContain('[OK]');
    const updated = getAgent(member.id)!;
    expect(updated.vcsProvider).toBe('azure-devops');
    expect(updated.vcsTokenExpiresAt).toBeUndefined();
  });

  // apra-fleet-5co8.5.1: tool-registry hands the MCP payload to
  // provisionVcsAuth() with an `as any` cast, so the zod refine on
  // pat_expires_at is not the only line of defence -- buildCredentials must
  // also refuse an unparseable expiry rather than let it silently reach
  // vcsTokenExpiresAt and permanently silence checkVcsTokenExpiry's warning.
  it('azure-devops: rejects an unparseable pat_expires_at before deploying', async () => {
    const member = makeTestAgent({ friendlyName: 'az-bad-expiry' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const { text: result } = await provisionVcsAuth({
      member_id: member.id, provider: 'azure-devops',
      org_url: 'https://dev.azure.com/myorg', pat: 'az-pat-999',
      pat_expires_at: 'whenever',
    } as any);
    expect(result).toContain('[FAIL]');
    expect(result).toContain('pat_expires_at');
    expect(getAgent(member.id)!.vcsTokenExpiresAt).toBeUndefined();
  });

  it('azure-devops: records a valid pat_expires_at in the member registry', async () => {
    const member = makeTestAgent({ friendlyName: 'az-expiry' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const { text: result } = await provisionVcsAuth({
      member_id: member.id, provider: 'azure-devops',
      org_url: 'https://dev.azure.com/myorg', pat: 'az-pat-999',
      pat_expires_at: '2027-08-20T00:00:00Z',
    });
    expect(result).toContain('[OK]');
    expect(getAgent(member.id)!.vcsTokenExpiresAt).toBe('2027-08-20T00:00:00Z');
    expect(getAgent(member.id)!.vcsProvider).toBe('azure-devops');
  });

  it('azure-devops: accepts token field as alias for pat', async () => {
    const member = makeTestAgent({ friendlyName: 'az-alias' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const { text: result } = await provisionVcsAuth({
      member_id: member.id, provider: 'azure-devops',
      org_url: 'https://dev.azure.com/myorg', token: 'az-pat-via-token',
    });
    expect(result).toContain('[OK]');
  });

  // --- GitHub ---

  it('github: pat mode deploys successfully', async () => {
    const member = makeTestAgent({ friendlyName: 'gh-pat' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const { text: result } = await provisionVcsAuth({
      member_id: member.id, provider: 'github',
      github_mode: 'pat', token: 'ghp_testtoken123',
    });
    expect(result).toContain('[OK]');
    expect(result).toContain('PAT');
  });

  it('github: pat mode OOB cancellation returns error when token is absent', async () => {
    const member = makeTestAgent({ friendlyName: 'gh-pat-notoken' });
    addAgent(member);
    const { text: result } = await provisionVcsAuth({
      member_id: member.id, provider: 'github', github_mode: 'pat',
    });
    expect(result).toContain('[FAIL]');
  });

  it('github: github-app mode deploys successfully', async () => {
    const member = makeTestAgent({ friendlyName: 'gh-app', gitAccess: 'push', gitRepos: ['Org/Repo'] });
    addAgent(member);
    setGitHubAppConfig();
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockMint.mockResolvedValue({ token: 'ghs_minted123', expiresAt: '2026-03-04T12:00:00Z' });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const { text: result } = await provisionVcsAuth({
      member_id: member.id, provider: 'github',
    });
    expect(result).toContain('[OK]');
    expect(result).toContain('GitHub App');
    expect(result).toContain('ghs_****');
    expect(result).not.toContain('ghs_minted123');
  });

  // --- Token expiry persistence ---

  it('github-app: persists vcsProvider and vcsTokenExpiresAt in registry after deploy', async () => {
    const member = makeTestAgent({ friendlyName: 'gh-expiry', gitAccess: 'push', gitRepos: ['Org/Repo'] });
    addAgent(member);
    setGitHubAppConfig();
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockMint.mockResolvedValue({ token: 'ghs_mint999', expiresAt: '2026-03-24T12:00:00Z' });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    await provisionVcsAuth({ member_id: member.id, provider: 'github' });

    const updated = getAgent(member.id)!;
    expect(updated.vcsProvider).toBe('github');
    expect(updated.vcsTokenExpiresAt).toBe('2026-03-24T12:00:00Z');
  });

  it('bitbucket: persists vcsProvider without expiresAt (no expiry for API tokens)', async () => {
    const member = makeTestAgent({ friendlyName: 'bb-expiry' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    await provisionVcsAuth({
      member_id: member.id, provider: 'bitbucket',
      email: 'dev@co.com', api_token: 'ATBB_xyz', workspace: 'ws',
    });

    const updated = getAgent(member.id)!;
    expect(updated.vcsProvider).toBe('bitbucket');
    expect(updated.vcsTokenExpiresAt).toBeUndefined();
  });

  // Regression for the credential-cleanup label/scopeUrl bug: the exact
  // label/scopeUrl actually used to deploy must be persisted on the agent
  // record so a later cleanup timer (credential-cleanup.ts) revokes the SAME
  // credential entry, not an unlabeled/default-host guess.
  it('github: persists the deploy label and scopeUrl (default) on the agent record', async () => {
    const member = makeTestAgent({ friendlyName: 'gh-label-default' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    await provisionVcsAuth({
      member_id: member.id, provider: 'github',
      github_mode: 'pat', token: 'ghp_testtoken123',
    });

    const updated = getAgent(member.id)!;
    expect(updated.vcsCredentialLabel).toBe('github');
    expect(updated.vcsCredentialScopeUrl).toBe('https://github.com');
  });

  it('github: persists a custom label and scope_url exactly as supplied', async () => {
    const member = makeTestAgent({ friendlyName: 'gh-label-custom' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    await provisionVcsAuth({
      member_id: member.id, provider: 'github',
      github_mode: 'pat', token: 'ghp_testtoken123',
      label: 'work-github', scope_url: 'https://github.com/my-org',
    });

    const updated = getAgent(member.id)!;
    expect(updated.vcsCredentialLabel).toBe('work-github');
    expect(updated.vcsCredentialScopeUrl).toBe('https://github.com/my-org');
  });

  // Regression: the agent record only tracks ONE active (label, scopeUrl)
  // pair for cleanup purposes. Deploying credential B under a DIFFERENT
  // label than the previously-deployed credential A cancels A's cleanup
  // timer (re-provisioning always does) -- without an explicit revoke here,
  // A's git-config registration and on-disk token file would be silently
  // orphaned forever (never scheduled for cleanup again, never revoked).
  // Assert the superseded credential (label-a) is actually revoked as part
  // of deploying the new one.
  it('github: revokes a superseded credential (different label) when a new one is provisioned', async () => {
    const member = makeTestAgent({ friendlyName: 'gh-supersede' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    await provisionVcsAuth({
      member_id: member.id, provider: 'github',
      github_mode: 'pat', token: 'ghp_token_a', label: 'label-a',
    });
    mockExecCommand.mockClear();

    await provisionVcsAuth({
      member_id: member.id, provider: 'github',
      github_mode: 'pat', token: 'ghp_token_b', label: 'label-b',
    });

    const execCmds = mockExecCommand.mock.calls.map(c => String(c[0]));
    expect(execCmds.some(cmd => cmd.includes('fleet-git-credential-label-a'))).toBe(true);

    const updated = getAgent(member.id)!;
    expect(updated.vcsCredentialLabel).toBe('label-b');
  });

  // Same-label re-provision is a plain refresh (gitCredentialHelperWrite's
  // --replace-all overwrites the existing entry in place) -- it must NOT
  // trigger a superseded-credential revoke against itself.
  it('github: same-label re-provision does not revoke its own just-deployed credential', async () => {
    const member = makeTestAgent({ friendlyName: 'gh-refresh' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    await provisionVcsAuth({
      member_id: member.id, provider: 'github',
      github_mode: 'pat', token: 'ghp_token_v1', label: 'stable-label',
    });
    mockExecCommand.mockClear();

    await provisionVcsAuth({
      member_id: member.id, provider: 'github',
      github_mode: 'pat', token: 'ghp_token_v2', label: 'stable-label',
    });

    const execCmds = mockExecCommand.mock.calls.map(c => String(c[0]));
    // No `rm -f`/`Remove-Item` style revoke command targeting stable-label's
    // own file should appear -- only the legacy-migration remove (unlabeled)
    // and the fresh write.
    expect(execCmds.filter(cmd => cmd.includes('fleet-git-credential-stable-label') && (cmd.includes('rm -f') || cmd.includes('Remove-Item'))).length).toBe(0);
  });

  // --- legacy-migration step must never drop a live credential registration ---
  //
  // Regression for the live 2026-09-11 fleet-lin-dev1 failure. The
  // legacy-migration step that runs BEFORE every deploy used to call
  // gitCredentialHelperRemove(host) with no label, which emits
  // `git config --global --unset-all credential.https://<host>.helper`. That
  // key is HOST-scoped, not label-scoped, so it dropped the registration of
  // whatever credential was currently live -- and because it ran before the
  // deploy, any failure in between left the member with a fresh credential
  // FILE on disk but no git-config registration ("could not read Username"
  // while the token was still valid). Scoping that call to the label would NOT
  // have helped: every variant unsets the same host-scoped key. The step now
  // removes only the legacy unlabeled FILE and touches no git config.

  it('github: the pre-deploy legacy migration never unsets the git-config credential helper key', async () => {
    const member = makeTestAgent({ friendlyName: 'gh-legacy-migration' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    await provisionVcsAuth({
      member_id: member.id, provider: 'github',
      github_mode: 'pat', token: 'ghp_first_ever', label: 'only-label',
    });

    const execCmds = mockExecCommand.mock.calls.map(c => String(c[0]));
    expect(execCmds.some(cmd => cmd.includes('--unset-all'))).toBe(false);
    // ...but the legacy UNLABELED credential file is still cleaned up, so a
    // pre-label install does not keep an orphaned, still-valid token on disk.
    expect(
      execCmds.some(cmd =>
        /\.fleet-git-credential(\.bat)?"/.test(cmd) && (cmd.includes('rm -f') || cmd.includes('Remove-Item'))),
    ).toBe(true);
  });

  it('github: a live credential registration survives a same-label refresh (no --unset-all)', async () => {
    const member = makeTestAgent({ friendlyName: 'gh-registration-survives' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    await provisionVcsAuth({
      member_id: member.id, provider: 'github',
      github_mode: 'pat', token: 'ghp_v1', label: 'live-label',
    });
    mockExecCommand.mockClear();

    await provisionVcsAuth({
      member_id: member.id, provider: 'github',
      github_mode: 'pat', token: 'ghp_v2', label: 'live-label',
    });

    const execCmds = mockExecCommand.mock.calls.map(c => String(c[0]));
    // A plain refresh fires no supersession revoke, so NOTHING in this deploy
    // may unset the host-scoped helper key: the re-registration is done
    // in-place by gitCredentialHelperWrite's own --replace-all + --add.
    expect(execCmds.some(cmd => cmd.includes('--unset-all'))).toBe(false);
    expect(execCmds.some(cmd => cmd.includes('--replace-all') && cmd.includes('--add'))).toBe(true);
  });

  // --- {{secure.NAME}} token resolution ---

  it('resolves {{secure.NAME}} token in github pat token field', async () => {
    const member = makeTestAgent({ friendlyName: 'gh-secure-token' });
    addAgent(member);
    credentialSet('GH_PAT', 'ghp_resolved_token', { network_policy: 'allow' });
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const { text: result } = await provisionVcsAuth({
      member_id: member.id, provider: 'github',
      github_mode: 'pat', token: '{{secure.GH_PAT}}',
    });
    expect(result).toContain('[OK]');
    credentialDelete('GH_PAT');
  });

  it('returns error when {{secure.NAME}} token is missing in github pat field', async () => {
    const member = makeTestAgent({ friendlyName: 'gh-missing-secure' });
    addAgent(member);

    const { text: result } = await provisionVcsAuth({
      member_id: member.id, provider: 'github',
      github_mode: 'pat', token: '{{secure.MISSING_CRED}}',
    });
    expect(result).toContain('[FAIL]');
    expect(result).toContain('MISSING_CRED');
    expect(result).toContain('not found');
  });

  it('resolves {{secure.NAME}} token in bitbucket api_token field', async () => {
    const member = makeTestAgent({ friendlyName: 'bb-secure-token' });
    addAgent(member);
    credentialSet('BB_TOKEN', 'ATBB_secure_value', { network_policy: 'allow' });
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const { text: result } = await provisionVcsAuth({
      member_id: member.id, provider: 'bitbucket',
      email: 'dev@co.com', api_token: '{{secure.BB_TOKEN}}', workspace: 'ws',
    });
    expect(result).toContain('[OK]');
    credentialDelete('BB_TOKEN');
  });

  it('resolves {{secure.NAME}} token in azure-devops pat field', async () => {
    const member = makeTestAgent({ friendlyName: 'az-secure-token' });
    addAgent(member);
    credentialSet('AZ_PAT', 'az_resolved_pat', { network_policy: 'allow' });
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const { text: result } = await provisionVcsAuth({
      member_id: member.id, provider: 'azure-devops',
      org_url: 'https://dev.azure.com/myorg', pat: '{{secure.AZ_PAT}}',
    });
    expect(result).toContain('[OK]');
    credentialDelete('AZ_PAT');
  });

  // --- OOB fallback tests ---

  it('github: pat mode prompts OOB when token is absent', async () => {
    const member = makeTestAgent({ friendlyName: 'gh-oob' });
    addAgent(member);
    mockCollectOobApiKey.mockResolvedValueOnce({ password: encryptPassword('ghp_oob_collected') });
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const { text: result } = await provisionVcsAuth({
      member_id: member.id, provider: 'github', github_mode: 'pat',
    });
    expect(result).toContain('[OK]');
    expect(mockCollectOobApiKey).toHaveBeenCalledWith(
      'gh-oob', 'provision_vcs_auth',
      expect.objectContaining({ prompt: 'Enter GitHub personal access token for gh-oob' }),
    );
  });

  it('bitbucket: prompts OOB when api_token is absent', async () => {
    const member = makeTestAgent({ friendlyName: 'bb-oob' });
    addAgent(member);
    mockCollectOobApiKey.mockResolvedValueOnce({ password: encryptPassword('ATBB_oob_token') });
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const { text: result } = await provisionVcsAuth({
      member_id: member.id, provider: 'bitbucket',
      email: 'dev@co.com', workspace: 'my-ws',
    });
    expect(result).toContain('[OK]');
    expect(mockCollectOobApiKey).toHaveBeenCalledWith(
      'bb-oob', 'provision_vcs_auth',
      expect.objectContaining({ prompt: 'Enter Bitbucket API token for bb-oob' }),
    );
  });

  it('azure-devops: prompts OOB when pat is absent', async () => {
    const member = makeTestAgent({ friendlyName: 'az-oob' });
    addAgent(member);
    mockCollectOobApiKey.mockResolvedValueOnce({ password: encryptPassword('az_oob_pat') });
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const { text: result } = await provisionVcsAuth({
      member_id: member.id, provider: 'azure-devops',
      org_url: 'https://dev.azure.com/myorg',
    });
    expect(result).toContain('[OK]');
    expect(mockCollectOobApiKey).toHaveBeenCalledWith(
      'az-oob', 'provision_vcs_auth',
      expect.objectContaining({ prompt: 'Enter Azure DevOps personal access token for az-oob' }),
    );
  });

  it('reports deploy failure from provider', async () => {
    const member = makeTestAgent({ friendlyName: 'deploy-fail' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockRejectedValue(new Error('permission denied'));

    const { text: result } = await provisionVcsAuth({
      member_id: member.id, provider: 'bitbucket',
      email: 'a@b.com', api_token: 'tok', workspace: 'ws',
    });
    expect(result).toContain('[FAIL]');
    expect(result).toContain('permission denied');
  });
});
