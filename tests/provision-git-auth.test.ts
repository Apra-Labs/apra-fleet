import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { provisionGitAuth } from '../src/tools/provision-git-auth.js';
import type { SSHExecResult } from '../src/types.js';

const FLEET_DIR = path.join(os.homedir(), '.claude-fleet');
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

// Mock mintGitToken to avoid real API calls
vi.mock('../src/services/github-app.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/github-app.js')>('../src/services/github-app.js');
  return {
    ...actual,
    mintGitToken: vi.fn(),
    loadPrivateKey: vi.fn().mockReturnValue('-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----'),
  };
});

import { mintGitToken } from '../src/services/github-app.js';
const mockMintGitToken = vi.mocked(mintGitToken);

let gitConfigBackup: string | null = null;

function setGitHubAppConfig(): void {
  const config = {
    version: '1.0',
    github: {
      appId: '12345',
      privateKeyPath: '/tmp/test.pem',
      installationId: 99999,
      createdAt: '2026-03-03T00:00:00Z',
    },
  };
  fs.writeFileSync(GIT_CONFIG_PATH, JSON.stringify(config, null, 2));
}

describe('provisionGitAuth', () => {
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

  it('fails when GitHub App is not configured', async () => {
    const agent = makeTestAgent({ friendlyName: 'no-app' });
    addAgent(agent);
    // Ensure no git config exists
    if (fs.existsSync(GIT_CONFIG_PATH)) fs.unlinkSync(GIT_CONFIG_PATH);

    const result = await provisionGitAuth({ agent_id: agent.id });
    expect(result).toContain('❌');
    expect(result).toContain('setup_git_app');
  });

  it('fails when no git_access is set and none provided', async () => {
    const agent = makeTestAgent({ friendlyName: 'no-access' });
    addAgent(agent);
    setGitHubAppConfig();

    const result = await provisionGitAuth({ agent_id: agent.id });
    expect(result).toContain('❌');
    expect(result).toContain('git_access');
  });

  it('fails when no git_repos is set and none provided', async () => {
    const agent = makeTestAgent({ friendlyName: 'no-repos', gitAccess: 'push' });
    addAgent(agent);
    setGitHubAppConfig();

    const result = await provisionGitAuth({ agent_id: agent.id });
    expect(result).toContain('❌');
    expect(result).toContain('git_repos');
  });

  it('fails when agent is offline', async () => {
    const agent = makeTestAgent({ friendlyName: 'offline', gitAccess: 'push', gitRepos: ['Org/Repo'] });
    addAgent(agent);
    setGitHubAppConfig();
    mockTestConnection.mockResolvedValue({ ok: false, latencyMs: 0, error: 'Timeout' });

    const result = await provisionGitAuth({ agent_id: agent.id });
    expect(result).toContain('❌');
    expect(result).toContain('offline');
  });

  it('input overrides take precedence over agent config', async () => {
    const agent = makeTestAgent({ friendlyName: 'override', gitAccess: 'read', gitRepos: ['Org/OldRepo'] });
    addAgent(agent);
    setGitHubAppConfig();
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockMintGitToken.mockResolvedValue({ token: 'ghs_test123456', expiresAt: '2026-03-03T16:00:00Z' });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const result = await provisionGitAuth({
      agent_id: agent.id,
      git_access: 'admin',
      repos: ['Org/NewRepo'],
    });

    expect(result).toContain('✅');
    expect(result).toContain('admin');
    expect(result).toContain('Org/NewRepo');

    // Verify mintGitToken was called with overridden values
    const mintCall = mockMintGitToken.mock.calls[0];
    expect(mintCall[3]).toEqual(['Org/NewRepo']);
    expect(mintCall[4]).toHaveProperty('administration');
  });

  it('deploys credentials and returns masked token on success', async () => {
    const agent = makeTestAgent({ friendlyName: 'success', gitAccess: 'push', gitRepos: ['Apra-Labs/ApraPipes'] });
    addAgent(agent);
    setGitHubAppConfig();
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockMintGitToken.mockResolvedValue({ token: 'ghs_abcdefghijklmnop', expiresAt: '2026-03-03T16:00:00Z' });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const result = await provisionGitAuth({ agent_id: agent.id });

    expect(result).toContain('✅');
    expect(result).toContain('push');
    expect(result).toContain('Apra-Labs/ApraPipes');
    expect(result).toContain('ghs_****');
    expect(result).not.toContain('ghs_abcdefghijklmnop');
    expect(result).toContain('2026-03-03T16:00:00Z');

    // Verify credential helper was written
    const cmds = mockExecCommand.mock.calls.map(c => c[0]);
    expect(cmds.some(c => c.includes('fleet-git-credential') || c.includes('credential.helper'))).toBe(true);
  });

  it('returns error when token minting fails', async () => {
    const agent = makeTestAgent({ friendlyName: 'mint-fail', gitAccess: 'push', gitRepos: ['Org/Repo'] });
    addAgent(agent);
    setGitHubAppConfig();
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockMintGitToken.mockRejectedValue(new Error('Token mint failed (403): Resource not accessible'));

    const result = await provisionGitAuth({ agent_id: agent.id });
    expect(result).toContain('❌');
    expect(result).toContain('Token mint failed');
  });

  it('returns not found for invalid agent ID', async () => {
    setGitHubAppConfig();
    const result = await provisionGitAuth({ agent_id: 'nonexistent-id' });
    expect(result).toContain('not found');
  });
});
