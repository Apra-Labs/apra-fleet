import { describe, it, expect } from 'vitest';
import {
  azureDevOpsProvider,
  parseAzureDevOpsRemote,
  extractAzureDevOpsOrg,
  credentialHostForScope,
  AZURE_DEVOPS_HOST_RE,
} from '../src/services/vcs/azure-devops.js';
import { detectVcsProviderFromRemoteUrl } from '../src/utils/vcs-provider-detect.js';
import { getOsCommands } from '../src/os/index.js';
import type { Agent } from '../src/types.js';

// GitHub issue #502: Azure DevOps repos on the legacy `<org>.visualstudio.com`
// host. The server side had NO org/project/repo parser at all (only an
// anchored dev.azure.com repo-URL allowlist for the connectivity probe) and
// bound the PAT's git credential helper to dev.azure.com unconditionally, so
// a push to the legacy host never saw the fleet-deployed PAT. Pinned here:
// the shared parser matrix, org extraction from either org URL, and the
// scope-driven credential-host binding on deploy/revoke.

const CANON = { org: 'apralabs', project: 'e2e-fleet-testing', repo: 'fleet-e2e-toy' };

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1', friendlyName: 'test-member', host: 'localhost', port: 22,
    sshUser: 'u', os: 'linux', tags: [], registeredAt: new Date().toISOString(),
    ...overrides,
  } as Agent;
}

describe('parseAzureDevOpsRemote (issue #502)', () => {
  it.each([
    ['modern https', 'https://dev.azure.com/apralabs/e2e-fleet-testing/_git/fleet-e2e-toy', { host: 'dev.azure.com', transport: 'https', legacy: false }],
    ['modern https + userinfo + .git + slash', 'https://apralabs@dev.azure.com/apralabs/e2e-fleet-testing/_git/fleet-e2e-toy.git/', { host: 'dev.azure.com', transport: 'https', legacy: false }],
    ['legacy https with collection', 'https://apralabs.visualstudio.com/DefaultCollection/e2e-fleet-testing/_git/fleet-e2e-toy', { host: 'apralabs.visualstudio.com', transport: 'https', legacy: true }],
    ['legacy https without collection', 'https://apralabs.visualstudio.com/e2e-fleet-testing/_git/fleet-e2e-toy', { host: 'apralabs.visualstudio.com', transport: 'https', legacy: true }],
    ['legacy https mixed-case org label', 'https://ApraLabs.visualstudio.com/defaultcollection/e2e-fleet-testing/_git/fleet-e2e-toy', { host: 'apralabs.visualstudio.com', transport: 'https', legacy: true }],
    ['modern ssh scp-like', 'git@ssh.dev.azure.com:v3/apralabs/e2e-fleet-testing/fleet-e2e-toy', { host: 'ssh.dev.azure.com', transport: 'ssh', legacy: false }],
    ['modern ssh scheme', 'ssh://git@ssh.dev.azure.com:22/v3/apralabs/e2e-fleet-testing/fleet-e2e-toy', { host: 'ssh.dev.azure.com', transport: 'ssh', legacy: false }],
    ['legacy ssh scp-like', 'apralabs@vs-ssh.visualstudio.com:v3/apralabs/e2e-fleet-testing/fleet-e2e-toy', { host: 'vs-ssh.visualstudio.com', transport: 'ssh', legacy: true }],
  ])('%s', (_label, url, expected) => {
    expect(parseAzureDevOpsRemote(url)).toEqual({ ...CANON, ...expected });
  });

  it('percent-decodes a project name with spaces on both hosts', () => {
    expect(parseAzureDevOpsRemote('https://apralabs.visualstudio.com/DefaultCollection/My%20Project/_git/fleet-e2e-toy')?.project).toBe('My Project');
    expect(parseAzureDevOpsRemote('https://dev.azure.com/apralabs/My%20Project/_git/fleet-e2e-toy')?.project).toBe('My Project');
    expect(parseAzureDevOpsRemote('git@ssh.dev.azure.com:v3/apralabs/My%20Project/fleet-e2e-toy')?.project).toBe('My Project');
  });

  it('takes the repo name as the project for the project-omitted shorthand', () => {
    expect(parseAzureDevOpsRemote('https://dev.azure.com/apralabs/_git/fleet-e2e-toy')).toMatchObject({ org: 'apralabs', project: 'fleet-e2e-toy', repo: 'fleet-e2e-toy' });
    expect(parseAzureDevOpsRemote('https://apralabs.visualstudio.com/DefaultCollection/_git/fleet-e2e-toy')).toMatchObject({ org: 'apralabs', project: 'fleet-e2e-toy', repo: 'fleet-e2e-toy' });
  });

  it.each([
    null, undefined, '', '   ', 42, 'not a url',
    'https://github.com/Apra-Labs/apra-fleet.git',
    'git@github.com:Apra-Labs/apra-fleet.git',
    'https://dev.azure.com.evil.example/apralabs/proj/_git/repo',
    'https://visualstudio.com/proj/_git/repo',
    'https://dev.azure.com',
    'https://dev.azure.com/apralabs/proj/no-git-marker',
    'https://dev.azure.com/apralabs/proj/_git/repo/extra',
    'https://apralabs.visualstudio.com/Other/proj/_git/repo',
    'apralabs@vs-ssh.visualstudio.com:v3/apralabs/repo',
    'https://dev.azure.com/v3/apralabs/proj/repo',
    'file:///tmp/bare.git',
  ])('rejects %s', (url) => {
    expect(parseAzureDevOpsRemote(url)).toBeNull();
  });

  it('agrees with the registration-time host detector on every host it accepts', () => {
    for (const url of [
      'https://dev.azure.com/a/b/_git/c',
      'https://a.visualstudio.com/b/_git/c',
      'git@ssh.dev.azure.com:v3/a/b/c',
      'a@vs-ssh.visualstudio.com:v3/a/b/c',
    ]) {
      expect(detectVcsProviderFromRemoteUrl(url)).toBe('azure-devops');
      expect(AZURE_DEVOPS_HOST_RE.test(parseAzureDevOpsRemote(url)!.host)).toBe(true);
    }
  });
});

describe('extractAzureDevOpsOrg', () => {
  it.each([
    ['https://dev.azure.com/myorg', 'myorg'],
    ['https://dev.azure.com/myorg/', 'myorg'],
    ['https://myorg.visualstudio.com', 'myorg'],
    ['https://myorg.visualstudio.com/DefaultCollection', 'myorg'],
    ['https://MyOrg.visualstudio.com/', 'MyOrg'],
    ['plain-text', 'plain-text'],
  ])('%s -> %s', (input, org) => {
    expect(extractAzureDevOpsOrg(input)).toBe(org);
  });
});

describe('credentialHostForScope', () => {
  it.each([
    [undefined, 'dev.azure.com'],
    ['https://dev.azure.com', 'dev.azure.com'],
    ['https://dev.azure.com/myorg', 'dev.azure.com'],
    ['https://myorg.visualstudio.com', 'myorg.visualstudio.com'],
    ['https://myorg.visualstudio.com/DefaultCollection/proj/_git/repo', 'myorg.visualstudio.com'],
    ['https://visualstudio.com', 'dev.azure.com'],
    ['https://vs-ssh.visualstudio.com', 'dev.azure.com'],
    ['https://github.com/org', 'dev.azure.com'],
    ['not a url', 'dev.azure.com'],
  ])('%s -> %s', (scope, host) => {
    expect(credentialHostForScope(scope)).toBe(host);
  });
});

describe('azureDevOpsProvider: legacy-host credential binding (issue #502)', () => {
  const cmds = getOsCommands('linux');

  it('deploy: a legacy-host scope_url binds the helper and the git-config key to that host', async () => {
    const execCalls: string[] = [];
    const exec = async (cmd: string) => { execCalls.push(cmd); return ''; };
    const result = await azureDevOpsProvider.deploy(
      makeAgent(), cmds, exec,
      { org_url: 'https://dev.azure.com/myorg', pat: 'az-pat-123' },
      'azure-devops', 'https://myorg.visualstudio.com',
    );
    expect(result.success).toBe(true);
    expect(result.metadata?.org).toBe('myorg');
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]).toContain('host=myorg.visualstudio.com');
    expect(execCalls[0]).toContain('credential.https://myorg.visualstudio.com.helper');
    expect(execCalls[0]).not.toContain('host=dev.azure.com');
  });

  it('deploy: the default scope keeps binding to dev.azure.com (unchanged for modern remotes)', async () => {
    const execCalls: string[] = [];
    const exec = async (cmd: string) => { execCalls.push(cmd); return ''; };
    await azureDevOpsProvider.deploy(
      makeAgent(), cmds, exec,
      { org_url: 'https://dev.azure.com/myorg', pat: 'az-pat-123' },
      'azure-devops', 'https://dev.azure.com',
    );
    expect(execCalls[0]).toContain('host=dev.azure.com');
    expect(execCalls[0]).toContain('credential.https://dev.azure.com.helper');
  });

  it('deploy: a legacy org_url still yields the org in metadata', async () => {
    const exec = async () => '';
    const result = await azureDevOpsProvider.deploy(
      makeAgent(), cmds, exec,
      { org_url: 'https://contoso.visualstudio.com', pat: 'token' },
    );
    expect(result.metadata?.org).toBe('contoso');
  });

  it.each([
    ['windows (PowerShell)', getOsCommands('windows')],
    ['windows (gitbash)', getOsCommands('windows', 'gitbash')],
    ['macos', getOsCommands('macos')],
  ] as const)('deploy on %s: the legacy host reaches the generated helper script', async (_label, osCmds) => {
    const execCalls: string[] = [];
    const exec = async (cmd: string) => { execCalls.push(cmd); return ''; };
    await azureDevOpsProvider.deploy(
      makeAgent(), osCmds, exec,
      { org_url: 'https://dev.azure.com/myorg', pat: 'az-pat-123' },
      'azure-devops', 'https://myorg.visualstudio.com',
    );
    const script = execCalls.find((c) => c.includes('.fleet-git-credential-'));
    expect(script).toBeDefined();
    expect(script!).toContain('myorg.visualstudio.com');
    expect(script!).toContain('credential.https://myorg.visualstudio.com.helper');
  });

  it('revoke: removes the git-config key for the same legacy host deploy wrote', async () => {
    const execCalls: string[] = [];
    const exec = async (cmd: string) => { execCalls.push(cmd); return ''; };
    const result = await azureDevOpsProvider.revoke(makeAgent(), cmds, exec, 'azure-devops', 'https://myorg.visualstudio.com');
    expect(result.success).toBe(true);
    expect(execCalls[0]).toContain('credential.https://myorg.visualstudio.com.helper');
  });

  it('testConnectivity: probes a legacy-host repo URL with git ls-remote', async () => {
    const execCalls: string[] = [];
    const exec = async (cmd: string) => { execCalls.push(cmd); return ''; };
    const member = makeAgent({ gitRepos: ['https://myorg.visualstudio.com/DefaultCollection/proj/_git/repo'] });
    const result = await azureDevOpsProvider.testConnectivity(member, exec);
    expect(result.success).toBe(true);
    expect(result.skipped).toBeUndefined();
    expect(execCalls[0]).toBe('git ls-remote https://myorg.visualstudio.com/DefaultCollection/proj/_git/repo HEAD');
  });

  it('testConnectivity: a percent-encoded project name is accepted; a bare % or shell metachar is not', async () => {
    const execCalls: string[] = [];
    const exec = async (cmd: string) => { execCalls.push(cmd); return ''; };
    const ok = await azureDevOpsProvider.testConnectivity(
      makeAgent(), exec, 'https://dev.azure.com/myorg/My%20Project/_git/repo',
    );
    expect(ok.skipped).toBeUndefined();
    expect(execCalls[0]).toBe('git ls-remote https://dev.azure.com/myorg/My%20Project/_git/repo HEAD');

    const bad = await azureDevOpsProvider.testConnectivity(
      makeAgent(), exec, 'https://myorg.visualstudio.com/proj/_git/x; echo pwned',
    );
    expect(bad.skipped).toBe(true);
    expect(execCalls).toHaveLength(1);
  });

  it('testConnectivity: an ssh remote is skipped, never ls-remoted with the PAT', async () => {
    const execCalls: string[] = [];
    const exec = async (cmd: string) => { execCalls.push(cmd); return ''; };
    const member = makeAgent({ gitRepos: ['git@ssh.dev.azure.com:v3/myorg/proj/repo'] });
    const result = await azureDevOpsProvider.testConnectivity(member, exec);
    expect(result.skipped).toBe(true);
    expect(execCalls).toHaveLength(0);
  });
});
