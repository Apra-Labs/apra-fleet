import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry, FLEET_DIR } from './test-helpers.js';
import { addAgent, getAgent } from '../src/services/registry.js';
import { credentialSet, credentialDelete } from '../src/services/credential-store.js';
import { provisionVcsAuth } from '../src/tools/provision-vcs-auth.js';
import type { SSHExecResult } from '../src/types.js';
const GIT_CONFIG_PATH = path.join(FLEET_DIR, 'git-config.json');

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

  it('returns not found for invalid agent ID', async () => {
    const result = await provisionVcsAuth({ member_id: 'nonexistent', provider: 'github' });
    expect(result).toContain('not found');
  });

  it('fails when agent is offline', async () => {
    const agent = makeTestAgent({ friendlyName: 'offline' });
    addAgent(agent);
    mockTestConnection.mockResolvedValue({ ok: false, latencyMs: 0, error: 'Timeout' });

    const result = await provisionVcsAuth({
      member_id: agent.id, provider: 'bitbucket',
      email: 'a@b.com', api_token: 'tok', workspace: 'ws',
    });
    expect(result).toContain('❌');
    expect(result).toContain('offline');
  });

  // --- Bitbucket ---

  it('bitbucket: fails when required fields are missing', async () => {
    const agent = makeTestAgent({ friendlyName: 'bb-missing' });
    addAgent(agent);
    const result = await provisionVcsAuth({ member_id: agent.id, provider: 'bitbucket' });
    expect(result).toContain('❌');
    expect(result).toContain('email');
  });

  it('bitbucket: deploys credentials successfully', async () => {
    const agent = makeTestAgent({ friendlyName: 'bb-ok' });
    addAgent(agent);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const result = await provisionVcsAuth({
      member_id: agent.id, provider: 'bitbucket',
      email: 'dev@co.com', api_token: 'ATBB_xyz', workspace: 'my-ws',
    });
    expect(result).toContain('✅');
    expect(result).toContain('Bitbucket');
    expect(result).toContain('my-ws');
  });

  // --- Azure DevOps ---

  it('azure-devops: fails when required fields are missing', async () => {
    const agent = makeTestAgent({ friendlyName: 'az-missing' });
    addAgent(agent);
    const result = await provisionVcsAuth({ member_id: agent.id, provider: 'azure-devops' });
    expect(result).toContain('❌');
    expect(result).toContain('org_url');
  });

  it('azure-devops: deploys credentials successfully', async () => {
    const agent = makeTestAgent({ friendlyName: 'az-ok' });
    addAgent(agent);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const result = await provisionVcsAuth({
      member_id: agent.id, provider: 'azure-devops',
      org_url: 'https://dev.azure.com/myorg', pat: 'az-pat-999',
    });
    expect(result).toContain('✅');
    expect(result).toContain('Azure DevOps');
  });

  it('azure-devops: accepts token field as alias for pat', async () => {
    const agent = makeTestAgent({ friendlyName: 'az-alias' });
    addAgent(agent);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const result = await provisionVcsAuth({
      member_id: agent.id, provider: 'azure-devops',
      org_url: 'https://dev.azure.com/myorg', token: 'az-pat-via-token',
    });
    expect(result).toContain('✅');
  });

  // --- GitHub ---

  it('github: pat mode deploys successfully', async () => {
    const agent = makeTestAgent({ friendlyName: 'gh-pat' });
    addAgent(agent);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const result = await provisionVcsAuth({
      member_id: agent.id, provider: 'github',
      github_mode: 'pat', token: 'ghp_testtoken123',
    });
    expect(result).toContain('✅');
    expect(result).toContain('PAT');
  });

  it('github: pat mode fails without token', async () => {
    const agent = makeTestAgent({ friendlyName: 'gh-pat-notoken' });
    addAgent(agent);
    const result = await provisionVcsAuth({
      member_id: agent.id, provider: 'github', github_mode: 'pat',
    });
    expect(result).toContain('❌');
    expect(result).toContain('token');
  });

  it('github: github-app mode deploys successfully', async () => {
    const agent = makeTestAgent({ friendlyName: 'gh-app', gitAccess: 'push', gitRepos: ['Org/Repo'] });
    addAgent(agent);
    setGitHubAppConfig();
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockMint.mockResolvedValue({ token: 'ghs_minted123', expiresAt: '2026-03-04T12:00:00Z' });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const result = await provisionVcsAuth({
      member_id: agent.id, provider: 'github',
    });
    expect(result).toContain('✅');
    expect(result).toContain('GitHub App');
    expect(result).toContain('ghs_****');
    expect(result).not.toContain('ghs_minted123');
  });

  // --- Token expiry persistence ---

  it('github-app: persists vcsProvider and vcsTokenExpiresAt in registry after deploy', async () => {
    const agent = makeTestAgent({ friendlyName: 'gh-expiry', gitAccess: 'push', gitRepos: ['Org/Repo'] });
    addAgent(agent);
    setGitHubAppConfig();
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockMint.mockResolvedValue({ token: 'ghs_mint999', expiresAt: '2026-03-24T12:00:00Z' });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    await provisionVcsAuth({ member_id: agent.id, provider: 'github' });

    const updated = getAgent(agent.id)!;
    expect(updated.vcsProvider).toBe('github');
    expect(updated.vcsTokenExpiresAt).toBe('2026-03-24T12:00:00Z');
  });

  it('bitbucket: persists vcsProvider without expiresAt (no expiry for API tokens)', async () => {
    const agent = makeTestAgent({ friendlyName: 'bb-expiry' });
    addAgent(agent);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    await provisionVcsAuth({
      member_id: agent.id, provider: 'bitbucket',
      email: 'dev@co.com', api_token: 'ATBB_xyz', workspace: 'ws',
    });

    const updated = getAgent(agent.id)!;
    expect(updated.vcsProvider).toBe('bitbucket');
    expect(updated.vcsTokenExpiresAt).toBeUndefined();
  });

  // --- {{secure.NAME}} token resolution ---

  it('resolves {{secure.NAME}} token in github pat token field', async () => {
    const agent = makeTestAgent({ friendlyName: 'gh-secure-token' });
    addAgent(agent);
    credentialSet('GH_PAT', 'ghp_resolved_token', { network_policy: 'allow' });
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const result = await provisionVcsAuth({
      member_id: agent.id, provider: 'github',
      github_mode: 'pat', token: '{{secure.GH_PAT}}',
    });
    expect(result).toContain('✅');
    credentialDelete('GH_PAT');
  });

  it('returns error when {{secure.NAME}} token is missing in github pat field', async () => {
    const agent = makeTestAgent({ friendlyName: 'gh-missing-secure' });
    addAgent(agent);

    const result = await provisionVcsAuth({
      member_id: agent.id, provider: 'github',
      github_mode: 'pat', token: '{{secure.MISSING_CRED}}',
    });
    expect(result).toContain('❌');
    expect(result).toContain('MISSING_CRED');
    expect(result).toContain('not found');
  });

  it('resolves {{secure.NAME}} token in bitbucket api_token field', async () => {
    const agent = makeTestAgent({ friendlyName: 'bb-secure-token' });
    addAgent(agent);
    credentialSet('BB_TOKEN', 'ATBB_secure_value', { network_policy: 'allow' });
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const result = await provisionVcsAuth({
      member_id: agent.id, provider: 'bitbucket',
      email: 'dev@co.com', api_token: '{{secure.BB_TOKEN}}', workspace: 'ws',
    });
    expect(result).toContain('✅');
    credentialDelete('BB_TOKEN');
  });

  it('resolves {{secure.NAME}} token in azure-devops pat field', async () => {
    const agent = makeTestAgent({ friendlyName: 'az-secure-token' });
    addAgent(agent);
    credentialSet('AZ_PAT', 'az_resolved_pat', { network_policy: 'allow' });
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const result = await provisionVcsAuth({
      member_id: agent.id, provider: 'azure-devops',
      org_url: 'https://dev.azure.com/myorg', pat: '{{secure.AZ_PAT}}',
    });
    expect(result).toContain('✅');
    credentialDelete('AZ_PAT');
  });

  it('reports deploy failure from provider', async () => {
    const agent = makeTestAgent({ friendlyName: 'deploy-fail' });
    addAgent(agent);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockRejectedValue(new Error('permission denied'));

    const result = await provisionVcsAuth({
      member_id: agent.id, provider: 'bitbucket',
      email: 'a@b.com', api_token: 'tok', workspace: 'ws',
    });
    expect(result).toContain('❌');
    expect(result).toContain('permission denied');
  });
});
