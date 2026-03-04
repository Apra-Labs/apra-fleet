import { describe, it, expect, vi, beforeEach } from 'vitest';
import { githubProvider } from '../src/services/vcs/github.js';
import { bitbucketProvider } from '../src/services/vcs/bitbucket.js';
import { azureDevOpsProvider } from '../src/services/vcs/azure-devops.js';
import { LinuxCommands } from '../src/os/linux.js';
import type { Agent } from '../src/types.js';

// Mock github-app.ts to avoid real API calls
vi.mock('../src/services/github-app.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/github-app.js')>('../src/services/github-app.js');
  return {
    ...actual,
    mintGitToken: vi.fn(),
    loadPrivateKey: vi.fn().mockReturnValue('-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----'),
  };
});

// Mock git-config.ts
vi.mock('../src/services/git-config.js', () => ({
  getGitHubApp: vi.fn(),
}));

import { mintGitToken } from '../src/services/github-app.js';
import { getGitHubApp } from '../src/services/git-config.js';
const mockMint = vi.mocked(mintGitToken);
const mockGetApp = vi.mocked(getGitHubApp);

const cmds = new LinuxCommands();

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'test-id', friendlyName: 'test', agentType: 'remote',
    host: '1.2.3.4', port: 22, username: 'user', authType: 'key',
    workFolder: '/home/user/project', createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('GitHub provider', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deploy: github-app mode mints token and writes credential helper', async () => {
    mockGetApp.mockReturnValue({
      appId: '123', privateKeyPath: '/tmp/key.pem', installationId: 999,
      createdAt: '2026-01-01T00:00:00Z',
    });
    mockMint.mockResolvedValue({ token: 'ghs_abc123xyz', expiresAt: '2026-03-04T12:00:00Z' });

    const execCalls: string[] = [];
    const exec = async (cmd: string) => { execCalls.push(cmd); return ''; };
    const agent = makeAgent({ gitAccess: 'push', gitRepos: ['Org/Repo'] });

    const result = await githubProvider.deploy(agent, cmds, exec, { type: 'github-app' });

    expect(result.success).toBe(true);
    expect(result.metadata?.mode).toBe('github-app');
    expect(result.metadata?.token).toBe('ghs_****');
    expect(mockMint).toHaveBeenCalledOnce();
    expect(execCalls[0]).toContain('github.com');
    expect(execCalls[0]).toContain('x-access-token');
  });

  it('deploy: pat mode deploys token directly without minting', async () => {
    const execCalls: string[] = [];
    const exec = async (cmd: string) => { execCalls.push(cmd); return ''; };

    const result = await githubProvider.deploy(makeAgent(), cmds, exec, { type: 'pat', token: 'ghp_testtoken' });

    expect(result.success).toBe(true);
    expect(result.metadata?.mode).toBe('pat');
    expect(mockMint).not.toHaveBeenCalled();
    expect(execCalls[0]).toContain('ghp_testtoken');
  });

  it('deploy: github-app fails when app not configured', async () => {
    mockGetApp.mockReturnValue(undefined);
    const exec = async () => '';
    const result = await githubProvider.deploy(makeAgent(), cmds, exec, { type: 'github-app' });
    expect(result.success).toBe(false);
    expect(result.message).toContain('setup_git_app');
  });

  it('deploy: github-app fails when no git_access', async () => {
    mockGetApp.mockReturnValue({
      appId: '123', privateKeyPath: '/tmp/key.pem', installationId: 999,
      createdAt: '2026-01-01T00:00:00Z',
    });
    const exec = async () => '';
    const result = await githubProvider.deploy(makeAgent(), cmds, exec, { type: 'github-app' });
    expect(result.success).toBe(false);
    expect(result.message).toContain('git_access');
  });

  it('deploy: github-app fails when mint throws', async () => {
    mockGetApp.mockReturnValue({
      appId: '123', privateKeyPath: '/tmp/key.pem', installationId: 999,
      createdAt: '2026-01-01T00:00:00Z',
    });
    mockMint.mockRejectedValue(new Error('403 Forbidden'));
    const exec = async () => '';
    const agent = makeAgent({ gitAccess: 'push', gitRepos: ['Org/Repo'] });

    const result = await githubProvider.deploy(agent, cmds, exec, { type: 'github-app' });
    expect(result.success).toBe(false);
    expect(result.message).toContain('403 Forbidden');
  });

  it('revoke: calls gitCredentialHelperRemove', async () => {
    const execCalls: string[] = [];
    const exec = async (cmd: string) => { execCalls.push(cmd); return ''; };

    const result = await githubProvider.revoke(makeAgent(), cmds, exec);
    expect(result.success).toBe(true);
    expect(execCalls[0]).toContain('fleet-git-credential');
    expect(execCalls[0]).toContain('credential.helper');
  });

  it('testConnectivity: succeeds when git ls-remote works', async () => {
    const exec = async () => 'abc123\tHEAD';
    const result = await githubProvider.testConnectivity(makeAgent({ gitRepos: ['Org/Repo'] }), exec);
    expect(result.success).toBe(true);
    expect(result.message).toContain('Org/Repo');
  });

  it('testConnectivity: fails when git ls-remote throws', async () => {
    const exec = async () => { throw new Error('auth failed'); };
    const result = await githubProvider.testConnectivity(makeAgent({ gitRepos: ['Org/Repo'] }), exec);
    expect(result.success).toBe(false);
  });

  it('testConnectivity: skips when no specific repo', async () => {
    const exec = async () => '';
    const result = await githubProvider.testConnectivity(makeAgent({ gitRepos: ['*'] }), exec);
    expect(result.success).toBe(true);
    expect(result.message).toContain('Skipped');
  });
});

describe('Bitbucket provider', () => {
  it('deploy: writes credential helper with email and api_token', async () => {
    const execCalls: string[] = [];
    const exec = async (cmd: string) => { execCalls.push(cmd); return ''; };

    const result = await bitbucketProvider.deploy(
      makeAgent(), cmds, exec,
      { email: 'dev@example.com', api_token: 'ATBB_secret', workspace: 'my-team' },
    );

    expect(result.success).toBe(true);
    expect(result.metadata?.email).toBe('dev@example.com');
    expect(result.metadata?.workspace).toBe('my-team');
    expect(execCalls[0]).toContain('bitbucket.org');
    expect(execCalls[0]).toContain('dev@example.com');
    expect(execCalls[0]).toContain('ATBB_secret');
  });

  it('revoke: calls gitCredentialHelperRemove', async () => {
    const execCalls: string[] = [];
    const exec = async (cmd: string) => { execCalls.push(cmd); return ''; };

    const result = await bitbucketProvider.revoke(makeAgent(), cmds, exec);
    expect(result.success).toBe(true);
    expect(execCalls[0]).toContain('credential.helper');
  });

  it('testConnectivity: succeeds when API responds', async () => {
    const exec = async () => '{"username":"dev"}';
    const result = await bitbucketProvider.testConnectivity(makeAgent(), exec);
    expect(result.success).toBe(true);
  });

  it('testConnectivity: fails when API throws', async () => {
    const exec = async () => { throw new Error('401'); };
    const result = await bitbucketProvider.testConnectivity(makeAgent(), exec);
    expect(result.success).toBe(false);
  });
});

describe('Azure DevOps provider', () => {
  it('deploy: writes credential helper with empty username and PAT', async () => {
    const execCalls: string[] = [];
    const exec = async (cmd: string) => { execCalls.push(cmd); return ''; };

    const result = await azureDevOpsProvider.deploy(
      makeAgent(), cmds, exec,
      { org_url: 'https://dev.azure.com/myorg', pat: 'az-pat-123' },
    );

    expect(result.success).toBe(true);
    expect(result.metadata?.org).toBe('myorg');
    expect(execCalls[0]).toContain('dev.azure.com');
    expect(execCalls[0]).toContain('az-pat-123');
  });

  it('deploy: extracts org from org_url', async () => {
    const exec = async () => '';
    const result = await azureDevOpsProvider.deploy(
      makeAgent(), cmds, exec,
      { org_url: 'https://dev.azure.com/contoso-labs', pat: 'token' },
    );
    expect(result.metadata?.org).toBe('contoso-labs');
  });

  it('revoke: calls gitCredentialHelperRemove', async () => {
    const execCalls: string[] = [];
    const exec = async (cmd: string) => { execCalls.push(cmd); return ''; };

    const result = await azureDevOpsProvider.revoke(makeAgent(), cmds, exec);
    expect(result.success).toBe(true);
    expect(execCalls[0]).toContain('credential.helper');
  });

  it('testConnectivity: succeeds when curl works', async () => {
    const exec = async () => '';
    const result = await azureDevOpsProvider.testConnectivity(makeAgent(), exec);
    expect(result.success).toBe(true);
  });

  it('testConnectivity: fails when curl throws', async () => {
    const exec = async () => { throw new Error('connection refused'); };
    const result = await azureDevOpsProvider.testConnectivity(makeAgent(), exec);
    expect(result.success).toBe(false);
  });
});
