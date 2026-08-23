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
    const member = makeAgent({ gitAccess: 'push', gitRepos: ['Org/Repo'] });

    const result = await githubProvider.deploy(member, cmds, exec, { type: 'github-app' });

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
    const member = makeAgent({ gitAccess: 'push', gitRepos: ['Org/Repo'] });

    const result = await githubProvider.deploy(member, cmds, exec, { type: 'github-app' });
    expect(result.success).toBe(false);
    expect(result.message).toContain('403 Forbidden');
  });

  it('revoke: calls gitCredentialHelperRemove with github.com host', async () => {
    const execCalls: string[] = [];
    const exec = async (cmd: string) => { execCalls.push(cmd); return ''; };

    const result = await githubProvider.revoke(makeAgent(), cmds, exec);
    expect(result.success).toBe(true);
    expect(execCalls[0]).toContain('fleet-git-credential');
    expect(execCalls[0]).toContain('credential.https://github.com.helper');
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

  it('revoke: calls gitCredentialHelperRemove with bitbucket.org host', async () => {
    const execCalls: string[] = [];
    const exec = async (cmd: string) => { execCalls.push(cmd); return ''; };

    const result = await bitbucketProvider.revoke(makeAgent(), cmds, exec);
    expect(result.success).toBe(true);
    expect(execCalls[0]).toContain('credential.https://bitbucket.org.helper');
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

describe('Multi-label credential isolation', () => {
  it('deploy with different labels creates distinct credential files', async () => {
    const execCalls: string[] = [];
    const exec = async (cmd: string) => { execCalls.push(cmd); return ''; };

    await githubProvider.deploy(
      makeAgent(), cmds, exec,
      { type: 'pat', token: 'ghp_work' },
      'work-github', 'https://github.com/work-org',
    );
    await githubProvider.deploy(
      makeAgent(), cmds, exec,
      { type: 'pat', token: 'ghp_personal' },
      'personal-github', 'https://github.com/personal',
    );

    // Each github PAT deploy also issues a best-effort `gh auth login` call
    // (see the ghCliAuth wiring in deployPat) alongside the credential-helper
    // write, so filter to the writes rather than assuming a fixed index.
    const credWrites = execCalls.filter(cmd => cmd.includes('.fleet-git-credential-'));
    expect(credWrites[0]).toContain('.fleet-git-credential-work-github');
    expect(credWrites[0]).toContain('credential.https://github.com/work-org.helper');
    expect(credWrites[1]).toContain('.fleet-git-credential-personal-github');
    expect(credWrites[1]).toContain('credential.https://github.com/personal.helper');
  });

  it('revoke with label removes only that label file', async () => {
    const execCalls: string[] = [];
    const exec = async (cmd: string) => { execCalls.push(cmd); return ''; };

    await githubProvider.revoke(makeAgent(), cmds, exec, 'work-github', 'https://github.com/work-org');

    expect(execCalls[0]).toContain('.fleet-git-credential-work-github');
    expect(execCalls[0]).toContain('credential.https://github.com/work-org.helper');
    expect(execCalls[0]).not.toContain('personal-github');
  });

  it('deploy without label uses old-style credential file (backward compat)', async () => {
    const execCalls: string[] = [];
    const exec = async (cmd: string) => { execCalls.push(cmd); return ''; };

    await bitbucketProvider.deploy(
      makeAgent(), cmds, exec,
      { email: 'dev@test.com', api_token: 'tok', workspace: 'ws' },
    );

    expect(execCalls[0]).toContain('.fleet-git-credential" &&');
    expect(execCalls[0]).not.toContain('.fleet-git-credential-');
  });

  it('deploy with label on bitbucket uses labeled file', async () => {
    const execCalls: string[] = [];
    const exec = async (cmd: string) => { execCalls.push(cmd); return ''; };

    await bitbucketProvider.deploy(
      makeAgent(), cmds, exec,
      { email: 'dev@test.com', api_token: 'tok', workspace: 'ws' },
      'team-bb', 'https://bitbucket.org/team',
    );

    expect(execCalls[0]).toContain('.fleet-git-credential-team-bb');
    expect(execCalls[0]).toContain('credential.https://bitbucket.org/team.helper');
  });

  it('two providers with different labels coexist in gitconfig', async () => {
    const execCalls: string[] = [];
    const exec = async (cmd: string) => { execCalls.push(cmd); return ''; };

    await githubProvider.deploy(
      makeAgent(), cmds, exec,
      { type: 'pat', token: 'ghp_test' },
      'gh-work', 'https://github.com/org',
    );
    await azureDevOpsProvider.deploy(
      makeAgent(), cmds, exec,
      { org_url: 'https://dev.azure.com/myorg', pat: 'az-pat' },
      'az-work', 'https://dev.azure.com/myorg',
    );

    // github's deploy also issues a best-effort `gh auth login` call after its
    // credential-helper write (see deployPat), so filter to the writes rather
    // than assuming a fixed index -- azure-devops has no such extra call.
    const credWrites = execCalls.filter(cmd => cmd.includes('.fleet-git-credential-'));
    expect(credWrites[0]).toContain('.fleet-git-credential-gh-work');
    expect(credWrites[1]).toContain('.fleet-git-credential-az-work');
    // Different scope URLs
    expect(credWrites[0]).toContain('credential.https://github.com/org.helper');
    expect(credWrites[1]).toContain('credential.https://dev.azure.com/myorg.helper');
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

  it('revoke: calls gitCredentialHelperRemove with dev.azure.com host', async () => {
    const execCalls: string[] = [];
    const exec = async (cmd: string) => { execCalls.push(cmd); return ''; };

    const result = await azureDevOpsProvider.revoke(makeAgent(), cmds, exec);
    expect(result.success).toBe(true);
    expect(execCalls[0]).toContain('credential.https://dev.azure.com.helper');
  });

  it('testConnectivity: succeeds when git ls-remote works against a known gitRepos URL', async () => {
    const execCalls: string[] = [];
    const exec = async (cmd: string) => { execCalls.push(cmd); return 'abc123\tHEAD'; };
    const member = makeAgent({ gitRepos: ['https://dev.azure.com/myorg/myproject/_git/myrepo'] });

    const result = await azureDevOpsProvider.testConnectivity(member, exec);
    expect(result.success).toBe(true);
    expect(result.message).toContain('myrepo');
    expect(execCalls[0]).toBe('git ls-remote https://dev.azure.com/myorg/myproject/_git/myrepo HEAD');
    // The credential comes from the git credential helper deploy() already
    // configured -- never appears in the executed command string.
    expect(execCalls[0]).not.toMatch(/az-pat|pat=|token=/);
  });

  it('testConnectivity: falls back to a repo-scoped scope_url when gitRepos has no usable URL', async () => {
    const execCalls: string[] = [];
    const exec = async (cmd: string) => { execCalls.push(cmd); return 'abc123\tHEAD'; };
    const member = makeAgent({ gitRepos: ['myorg/myproject/myrepo'] });

    const result = await azureDevOpsProvider.testConnectivity(
      member, exec, 'https://dev.azure.com/myorg/myproject/_git/myrepo',
    );
    expect(result.success).toBe(true);
    expect(execCalls[0]).toContain('_git/myrepo');
  });

  it('testConnectivity: fails when git ls-remote throws', async () => {
    const exec = async () => { throw new Error('connection refused'); };
    const member = makeAgent({ gitRepos: ['https://dev.azure.com/myorg/myproject/_git/myrepo'] });

    const result = await azureDevOpsProvider.testConnectivity(member, exec);
    expect(result.success).toBe(false);
  });

  it('testConnectivity: skips with a documented message when no repo is known', async () => {
    const exec = async () => '';
    // No gitRepos entry and scope_url is only the org-level default -- there
    // is no concrete repo to ls-remote against.
    const result = await azureDevOpsProvider.testConnectivity(
      makeAgent(), exec, 'https://dev.azure.com/myorg',
    );
    expect(result.success).toBe(true);
    expect(result.message).toContain('Skipped');
  });

  // apra-fleet-5co8.5.1: the expiry is caller-supplied (Azure DevOps exposes
  // no API to read a PAT's expiry back), so deploy metadata must carry it
  // through when present and be BYTE-IDENTICAL to the old shape when absent --
  // an `expiresAt: undefined` key would still flow into the registry write.
  it('deploy: propagates a supplied expires_at into metadata.expiresAt', async () => {
    const exec = async () => '';
    const result = await azureDevOpsProvider.deploy(
      makeAgent(), cmds, exec,
      { org_url: 'https://dev.azure.com/myorg', pat: 'az-pat-123', expires_at: '2027-08-20T00:00:00Z' },
    );
    expect(result.metadata?.expiresAt).toBe('2027-08-20T00:00:00Z');
  });

  it('deploy: omits expiresAt entirely when no expiry is supplied', async () => {
    const exec = async () => '';
    const result = await azureDevOpsProvider.deploy(
      makeAgent(), cmds, exec,
      { org_url: 'https://dev.azure.com/myorg', pat: 'az-pat-123' },
    );
    expect(result.metadata && 'expiresAt' in result.metadata).toBe(false);
  });
});

// apra-fleet-5co8.5.1: an unparseable pat_expires_at is NOT a harmless typo.
// It is truthy, so it would reach vcsTokenExpiresAt verbatim, make every
// checkVcsTokenExpiry comparison NaN (no warning at all) and make
// scheduleCredentialCleanup fall back to DEFAULT_TTL_MS -- a 55-minute
// auto-revoke of the PAT that was just deployed. Rejected at the boundary.
// apra-fleet-5co8.3.1: the credential-assembly and missing-credential
// descriptors are a VERBATIM move of the provider switch / out-of-band
// if-blocks that still live in src/tools/provision-vcs-auth.ts (the call-site
// rewrite is a separate task). These assertions therefore pin the MOVED logic
// against the behaviour the tool has today -- same defaults, same error
// strings, same prompt text -- so the later rewrite is provably a no-op.
describe('provider credential assembly (apra-fleet-5co8.3.1)', () => {
  it('github: defaults to github-app mode and passes access/repos through', () => {
    expect(githubProvider.buildCredentials!({ provider: 'github', git_access: 'push', repos: ['acme/widgets'] }))
      .toEqual({ type: 'github-app', git_access: 'push', repos: ['acme/widgets'] });
  });

  it('github: pat mode returns the pat credential', () => {
    expect(githubProvider.buildCredentials!({ provider: 'github', github_mode: 'pat', token: 'ghp_x' }))
      .toEqual({ type: 'pat', token: 'ghp_x' });
  });

  it('github: pat mode without a token returns the error string', () => {
    expect(githubProvider.buildCredentials!({ provider: 'github', github_mode: 'pat' }))
      .toBe('GitHub PAT mode requires "token" field.');
  });

  it('bitbucket: returns the credential when all three fields are present', () => {
    expect(bitbucketProvider.buildCredentials!({ provider: 'bitbucket', email: 'd@co.com', api_token: 't', workspace: 'ws' }))
      .toEqual({ email: 'd@co.com', api_token: 't', workspace: 'ws' });
  });

  it('bitbucket: returns the error string when any field is missing', () => {
    for (const input of [
      { provider: 'bitbucket' as const, api_token: 't', workspace: 'ws' },
      { provider: 'bitbucket' as const, email: 'd@co.com', workspace: 'ws' },
      { provider: 'bitbucket' as const, email: 'd@co.com', api_token: 't' },
    ]) {
      expect(bitbucketProvider.buildCredentials!(input)).toBe('Bitbucket requires "email", "api_token", and "workspace" fields.');
    }
  });
});

describe('provider missing-credential descriptors (apra-fleet-5co8.3.1)', () => {
  it('github: prompts only in pat mode with no token', () => {
    const d = githubProvider.missingCredential!;
    expect(d.field).toBe('token');
    expect(d.isMissing({ provider: 'github', github_mode: 'pat' })).toBe(true);
    expect(d.isMissing({ provider: 'github', github_mode: 'pat', token: 'ghp_x' })).toBe(false);
    // github-app mode mints server-side and must never reach a prompt.
    expect(d.isMissing({ provider: 'github' })).toBe(false);
    expect(d.isMissing({ provider: 'github', github_mode: 'github-app' })).toBe(false);
    expect(d.promptFor('alice')).toBe('Enter GitHub personal access token for alice');
  });

  it('bitbucket: prompts whenever api_token is absent', () => {
    const d = bitbucketProvider.missingCredential!;
    expect(d.field).toBe('api_token');
    expect(d.isMissing({ provider: 'bitbucket', email: 'd@co.com', workspace: 'ws' })).toBe(true);
    expect(d.isMissing({ provider: 'bitbucket', api_token: 't' })).toBe(false);
    expect(d.promptFor('bob')).toBe('Enter Bitbucket API token for bob');
  });
});

describe('provisionVcsAuthSchema pat_expires_at', () => {
  it('accepts a parseable ISO 8601 expiry', async () => {
    const { provisionVcsAuthSchema } = await import('../src/tools/provision-vcs-auth.js');
    const result = provisionVcsAuthSchema.safeParse({
      member_id: 'a', provider: 'azure-devops', org_url: 'https://dev.azure.com/myorg',
      pat: 'p', pat_expires_at: '2027-08-20T00:00:00Z',
    });
    expect(result.success).toBe(true);
  });

  it('accepts an omitted expiry', async () => {
    const { provisionVcsAuthSchema } = await import('../src/tools/provision-vcs-auth.js');
    const result = provisionVcsAuthSchema.safeParse({
      member_id: 'a', provider: 'azure-devops', org_url: 'https://dev.azure.com/myorg', pat: 'p',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unparseable expiry', async () => {
    const { provisionVcsAuthSchema } = await import('../src/tools/provision-vcs-auth.js');
    for (const bad of ['not-a-date', '', '2027-13-45']) {
      const result = provisionVcsAuthSchema.safeParse({
        member_id: 'a', provider: 'azure-devops', org_url: 'https://dev.azure.com/myorg',
        pat: 'p', pat_expires_at: bad,
      });
      expect(result.success, `expected rejection for ${JSON.stringify(bad)}`).toBe(false);
    }
  });
});

describe('provisionVcsAuthSchema git_access', () => {
  it('accepts push+pr', async () => {
    const { provisionVcsAuthSchema } = await import('../src/tools/provision-vcs-auth.js');
    const result = provisionVcsAuthSchema.safeParse({ member_id: 'a', provider: 'github', git_access: 'push+pr' });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown git_access level', async () => {
    const { provisionVcsAuthSchema } = await import('../src/tools/provision-vcs-auth.js');
    const result = provisionVcsAuthSchema.safeParse({ member_id: 'a', provider: 'github', git_access: 'bogus' });
    expect(result.success).toBe(false);
  });
});
