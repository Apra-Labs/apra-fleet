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
    mockCollectOobApiKey.mockResolvedValue({ fallback: '❌ OOB cancelled in test.' });
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
    const result = await provisionVcsAuth({ member_id: 'nonexistent', provider: 'github' });
    expect(result).toContain('not found');
  });

  it('fails when member is offline', async () => {
    const member = makeTestAgent({ friendlyName: 'offline' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: false, latencyMs: 0, error: 'Timeout' });

    const result = await provisionVcsAuth({
      member_id: member.id, provider: 'bitbucket',
      email: 'a@b.com', api_token: 'tok', workspace: 'ws',
    });
    expect(result).toContain('❌');
    expect(result).toContain('offline');
  });

  // --- Bitbucket ---

  it('bitbucket: OOB cancellation returns error when api_token is absent', async () => {
    const member = makeTestAgent({ friendlyName: 'bb-missing' });
    addAgent(member);
    const result = await provisionVcsAuth({ member_id: member.id, provider: 'bitbucket' });
    expect(result).toContain('❌');
  });

  it('bitbucket: deploys credentials successfully', async () => {
    const member = makeTestAgent({ friendlyName: 'bb-ok' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const result = await provisionVcsAuth({
      member_id: member.id, provider: 'bitbucket',
      email: 'dev@co.com', api_token: 'ATBB_xyz', workspace: 'my-ws',
    });
    expect(result).toContain('✅');
    expect(result).toContain('Bitbucket');
    expect(result).toContain('my-ws');
  });

  // --- Azure DevOps ---

  it('azure-devops: OOB cancellation returns error when pat is absent', async () => {
    const member = makeTestAgent({ friendlyName: 'az-missing' });
    addAgent(member);
    const result = await provisionVcsAuth({ member_id: member.id, provider: 'azure-devops' });
    expect(result).toContain('❌');
  });

  it('azure-devops: deploys credentials successfully', async () => {
    const member = makeTestAgent({ friendlyName: 'az-ok' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const result = await provisionVcsAuth({
      member_id: member.id, provider: 'azure-devops',
      org_url: 'https://dev.azure.com/myorg', pat: 'az-pat-999',
    });
    expect(result).toContain('✅');
    expect(result).toContain('Azure DevOps');
  });

  it('azure-devops: accepts token field as alias for pat', async () => {
    const member = makeTestAgent({ friendlyName: 'az-alias' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const result = await provisionVcsAuth({
      member_id: member.id, provider: 'azure-devops',
      org_url: 'https://dev.azure.com/myorg', token: 'az-pat-via-token',
    });
    expect(result).toContain('✅');
  });

  // --- GitHub ---

  it('github: pat mode deploys successfully', async () => {
    const member = makeTestAgent({ friendlyName: 'gh-pat' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const result = await provisionVcsAuth({
      member_id: member.id, provider: 'github',
      github_mode: 'pat', token: 'ghp_testtoken123',
    });
    expect(result).toContain('✅');
    expect(result).toContain('PAT');
  });

  it('github: pat mode OOB cancellation returns error when token is absent', async () => {
    const member = makeTestAgent({ friendlyName: 'gh-pat-notoken' });
    addAgent(member);
    const result = await provisionVcsAuth({
      member_id: member.id, provider: 'github', github_mode: 'pat',
    });
    expect(result).toContain('❌');
  });

  it('github: github-app mode deploys successfully', async () => {
    const member = makeTestAgent({ friendlyName: 'gh-app', gitAccess: 'push', gitRepos: ['Org/Repo'] });
    addAgent(member);
    setGitHubAppConfig();
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockMint.mockResolvedValue({ token: 'ghs_minted123', expiresAt: '2026-03-04T12:00:00Z' });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const result = await provisionVcsAuth({
      member_id: member.id, provider: 'github',
    });
    expect(result).toContain('✅');
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

  // --- {{secure.NAME}} token resolution ---

  it('resolves {{secure.NAME}} token in github pat token field', async () => {
    const member = makeTestAgent({ friendlyName: 'gh-secure-token' });
    addAgent(member);
    credentialSet('GH_PAT', 'ghp_resolved_token', { network_policy: 'allow' });
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const result = await provisionVcsAuth({
      member_id: member.id, provider: 'github',
      github_mode: 'pat', token: '{{secure.GH_PAT}}',
    });
    expect(result).toContain('✅');
    credentialDelete('GH_PAT');
  });

  it('returns error when {{secure.NAME}} token is missing in github pat field', async () => {
    const member = makeTestAgent({ friendlyName: 'gh-missing-secure' });
    addAgent(member);

    const result = await provisionVcsAuth({
      member_id: member.id, provider: 'github',
      github_mode: 'pat', token: '{{secure.MISSING_CRED}}',
    });
    expect(result).toContain('❌');
    expect(result).toContain('MISSING_CRED');
    expect(result).toContain('not found');
  });

  it('resolves {{secure.NAME}} token in bitbucket api_token field', async () => {
    const member = makeTestAgent({ friendlyName: 'bb-secure-token' });
    addAgent(member);
    credentialSet('BB_TOKEN', 'ATBB_secure_value', { network_policy: 'allow' });
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const result = await provisionVcsAuth({
      member_id: member.id, provider: 'bitbucket',
      email: 'dev@co.com', api_token: '{{secure.BB_TOKEN}}', workspace: 'ws',
    });
    expect(result).toContain('✅');
    credentialDelete('BB_TOKEN');
  });

  it('resolves {{secure.NAME}} token in azure-devops pat field', async () => {
    const member = makeTestAgent({ friendlyName: 'az-secure-token' });
    addAgent(member);
    credentialSet('AZ_PAT', 'az_resolved_pat', { network_policy: 'allow' });
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const result = await provisionVcsAuth({
      member_id: member.id, provider: 'azure-devops',
      org_url: 'https://dev.azure.com/myorg', pat: '{{secure.AZ_PAT}}',
    });
    expect(result).toContain('✅');
    credentialDelete('AZ_PAT');
  });

  // --- OOB fallback tests ---

  it('github: pat mode prompts OOB when token is absent', async () => {
    const member = makeTestAgent({ friendlyName: 'gh-oob' });
    addAgent(member);
    mockCollectOobApiKey.mockResolvedValueOnce({ password: encryptPassword('ghp_oob_collected') });
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const result = await provisionVcsAuth({
      member_id: member.id, provider: 'github', github_mode: 'pat',
    });
    expect(result).toContain('✅');
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

    const result = await provisionVcsAuth({
      member_id: member.id, provider: 'bitbucket',
      email: 'dev@co.com', workspace: 'my-ws',
    });
    expect(result).toContain('✅');
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

    const result = await provisionVcsAuth({
      member_id: member.id, provider: 'azure-devops',
      org_url: 'https://dev.azure.com/myorg',
    });
    expect(result).toContain('✅');
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

    const result = await provisionVcsAuth({
      member_id: member.id, provider: 'bitbucket',
      email: 'a@b.com', api_token: 'tok', workspace: 'ws',
    });
    expect(result).toContain('❌');
    expect(result).toContain('permission denied');
  });
});
