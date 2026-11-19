// The gh CLI keeps ONE login per OS user, unlike the per-member, per-label git
// credential helper. A GitHub deploy logs gh in only for label 'github' on a
// remote member no other registered member shares, unless the caller passes
// gh_login. Mint and exec are mocked: no command runs, nothing is minted.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Agent } from '../src/types.js';

const { mockGetAllAgents } = vi.hoisted(() => ({ mockGetAllAgents: vi.fn<() => Agent[]>() }));

vi.mock('../src/services/registry.js', () => ({
  getAllAgents: mockGetAllAgents,
  getAgent: (id: string) => mockGetAllAgents().find(a => a.id === id),
}));

vi.mock('../src/services/github-app.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/github-app.js')>('../src/services/github-app.js');
  return {
    ...actual,
    mintGitToken: vi.fn(),
    loadPrivateKey: vi.fn().mockReturnValue('-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----'),
  };
});

vi.mock('../src/services/git-config.js', () => ({ getGitHubApp: vi.fn() }));

import { githubProvider, ghLoginDecision } from '../src/services/vcs/github.js';
import { LinuxCommands } from '../src/os/linux.js';
import { mintGitToken } from '../src/services/github-app.js';
import { getGitHubApp } from '../src/services/git-config.js';

const cmds = new LinuxCommands();
const mockMint = vi.mocked(mintGitToken);

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'm-a', friendlyName: 'member-a', agentType: 'remote',
    host: 'build.example', port: 22, username: 'ci', authType: 'key',
    workFolder: '/home/ci/a', createdAt: new Date().toISOString(),
    gitAccess: 'push', gitRepos: ['acme/widgets'],
    ...overrides,
  };
}

async function deployApp(agent: Agent, label: string, ghLogin?: boolean, access: Agent['gitAccess'] = 'push') {
  const calls: string[] = [];
  mockMint.mockResolvedValueOnce({ token: 'ghs_new_token', expiresAt: new Date(Date.now() + 3600_000).toISOString() });
  const result = await githubProvider.deploy(agent, cmds, async (c) => { calls.push(c); return ''; },
    { type: 'github-app', git_access: access, repos: ['acme/widgets'], ghLogin }, label, 'https://github.com');
  return { result, ghLogins: calls.filter(c => c.includes('gh auth login')) };
}

describe('GitHub deploy: gh CLI login is OS-user-wide and gated', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getGitHubApp).mockReturnValue({ appId: '1', privateKeyPath: '/tmp/k.pem', installationId: 2, createdAt: '2026-01-01T00:00:00Z' });
  });

  it('logs gh in for label github on a remote member nobody shares', async () => {
    const a = makeAgent();
    mockGetAllAgents.mockReturnValue([a, makeAgent({ id: 'm-b', host: 'other.example' })]);
    const { result, ghLogins } = await deployApp(a, 'github');
    expect(ghLogins).toHaveLength(1);
    expect(result.metadata?.ghCliAuth).toBe('ok');
  });

  it('a different label (another access level) does not touch the host gh login', async () => {
    const a = makeAgent();
    mockGetAllAgents.mockReturnValue([a]);
    const { result, ghLogins } = await deployApp(a, 'github-issues', undefined, 'issues');
    expect(ghLogins).toHaveLength(0);
    expect(result.success).toBe(true);
    expect(result.metadata?.ghCliAuth).toMatch(/^skipped \(label 'github-issues'/);
    expect(result.metadata?.ghCliAuth).toContain('gh_login: true');
  });

  it('a local member never swaps the operator gh login by default', async () => {
    const local = makeAgent({ agentType: 'local', host: undefined, username: undefined });
    mockGetAllAgents.mockReturnValue([local]);
    const { result, ghLogins } = await deployApp(local, 'github');
    expect(ghLogins).toHaveLength(0);
    expect(result.metadata?.ghCliAuth).toMatch(/^skipped \(local member/);
  });

  it('a new member on a shared host user (scoped to another repo) does not narrow the shared gh login', async () => {
    const a = makeAgent();
    const b = makeAgent({ id: 'm-b', friendlyName: 'member-b', workFolder: '/home/ci/b' });
    mockGetAllAgents.mockReturnValue([a, b]);
    const { result, ghLogins } = await deployApp(b, 'github');
    expect(ghLogins).toHaveLength(0);
    expect(result.metadata?.ghCliAuth).toContain("member 'member-a' runs as the same user on this host");
  });

  it('gh_login: true logs gh in even for a local member; false never does', async () => {
    const local = makeAgent({ agentType: 'local', host: undefined, username: undefined });
    mockGetAllAgents.mockReturnValue([local]);
    expect((await deployApp(local, 'github-issues', true)).ghLogins).toHaveLength(1);
    const a = makeAgent();
    mockGetAllAgents.mockReturnValue([a]);
    const off = await deployApp(a, 'github', false);
    expect(off.ghLogins).toHaveLength(0);
    expect(off.result.metadata?.ghCliAuth).toMatch(/^skipped \(gh_login was false/);
  });

  it('PAT mode follows the same rule', async () => {
    const local = makeAgent({ agentType: 'local', host: undefined, username: undefined });
    mockGetAllAgents.mockReturnValue([local]);
    const calls: string[] = [];
    const result = await githubProvider.deploy(local, cmds, async (c) => { calls.push(c); return ''; },
      { type: 'pat', token: 'ghp_x' }, 'github', 'https://github.com');
    expect(calls.some(c => c.includes('gh auth login'))).toBe(false);
    expect(result.metadata?.ghCliAuth).toMatch(/^skipped/);
  });

  it('buildCredentials carries gh_login through to the deploy', () => {
    expect(githubProvider.buildCredentials!({ provider: 'github', gh_login: true })).toMatchObject({ type: 'github-app', ghLogin: true });
    expect(githubProvider.buildCredentials!({ provider: 'github', github_mode: 'pat', token: 't', gh_login: false })).toMatchObject({ type: 'pat', ghLogin: false });
  });

  it('ghLoginDecision: default rule', () => {
    mockGetAllAgents.mockReturnValue([]);
    expect(ghLoginDecision(makeAgent(), 'github', undefined)).toEqual({ login: true });
    expect(ghLoginDecision(makeAgent(), 'work', undefined).login).toBe(false);
  });
});
