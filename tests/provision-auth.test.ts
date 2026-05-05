import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { credentialSet, credentialDelete } from '../src/services/credential-store.js';
import { encryptPassword } from '../src/utils/crypto.js';
import { provisionAuth } from '../src/tools/provision-auth.js';
import type { SSHExecResult } from '../src/types.js';

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

// Mock fs to control whether master credentials exist
const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: (...args: any[]) => {
        if (typeof args[0] === 'string' && args[0].includes('.credentials.json')) {
          return mockExistsSync(...args);
        }
        return actual.existsSync(...args);
      },
      readFileSync: (...args: any[]) => {
        if (typeof args[0] === 'string' && args[0].includes('.credentials.json')) {
          return mockReadFileSync(...args);
        }
        return actual.readFileSync(...args);
      },
    },
  };
});

describe('provisionAuth', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('rejects offline agents before attempting either flow', async () => {
    const member = makeTestAgent({ friendlyName: 'down-box' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: false, latencyMs: 0, error: 'Connection refused' });

    const result = await provisionAuth({ member_id: member.id });
    expect(result).toContain('offline');
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('routes to API key flow when api_key is provided', async () => {
    const member = makeTestAgent({ friendlyName: 'apikey-member' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const result = await provisionAuth({ member_id: member.id, api_key: 'sk-ant-api03-TESTKEY' });
    expect(result).toContain('API key provisioned');

    const cmds = mockExecCommand.mock.calls.map(c => c[0]);
    expect(cmds.some(c => c.includes('ANTHROPIC_API_KEY'))).toBe(true);
  });

  it('deploys master credentials when no api_key and creds exist', async () => {
    const member = makeTestAgent({ friendlyName: 'oauth-member' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{"claudeAiOauth":{"accessToken":"sk-ant-oat01-test"}}');

    // All commands succeed — including the `claude -p "hello"` verification
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const result = await provisionAuth({ member_id: member.id });
    expect(result).toContain('OAuth credentials for claude deployed');

    // Should write credentials file, not set env vars
    const cmds = mockExecCommand.mock.calls.map(c => c[0]);
    expect(cmds.some(c => c.includes('.credentials.json'))).toBe(true);
  });

  it('reports error when no master credentials and no api_key', async () => {
    const member = makeTestAgent({ friendlyName: 'no-creds' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExistsSync.mockReturnValue(false);

    const result = await provisionAuth({ member_id: member.id });
    expect(result).toContain('Could not find local credential file');
  });

  it('blocks deployment when token is expired with no refresh token', async () => {
    const member = makeTestAgent({ friendlyName: 'expired-member' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      claudeAiOauth: { accessToken: 'sk-ant-oat01-test', expiresAt: '2020-01-01T00:00:00Z' },
    }));

    const result = await provisionAuth({ member_id: member.id });
    expect(result).toContain('expired');
    expect(result).toContain('/login');
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('deploys with auto-refresh note when token is expired but refreshable', async () => {
    const member = makeTestAgent({ friendlyName: 'refresh-member' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-test',
        expiresAt: '2020-01-01T00:00:00Z',
        refreshToken: 'rt-test',
      },
    }));
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const result = await provisionAuth({ member_id: member.id });
    expect(result).toContain('OAuth credentials for claude deployed');
    expect(result).toContain('auto-refresh');
  });

  // --- {{secure.NAME}} token resolution ---

  it('resolves {{secure.NAME}} token in api_key field', async () => {
    const member = makeTestAgent({ friendlyName: 'secure-key-member' });
    addAgent(member);
    credentialSet('MY_API_KEY', 'sk-ant-api03-RESOLVED', { network_policy: 'allow' });
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const result = await provisionAuth({ member_id: member.id, api_key: '{{secure.MY_API_KEY}}' });
    expect(result).toContain('API key provisioned');
    credentialDelete('MY_API_KEY');
  });

  it('returns error when {{secure.NAME}} token is missing in api_key field', async () => {
    const member = makeTestAgent({ friendlyName: 'missing-secure-member' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });

    const result = await provisionAuth({ member_id: member.id, api_key: '{{secure.NONEXISTENT_KEY}}' });
    expect(result).toContain('❌');
    expect(result).toContain('NONEXISTENT_KEY');
    expect(result).toContain('not found');
  });

  it('prompts OOB when api_key is absent for non-OAuth provider', async () => {
    const member = makeTestAgent({ friendlyName: 'codex-member', llmProvider: 'codex' });
    addAgent(member);
    mockCollectOobApiKey.mockResolvedValueOnce({ password: encryptPassword('sk-openai-oob-collected') });
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const result = await provisionAuth({ member_id: member.id });
    expect(result).toContain('API key provisioned');
    expect(mockCollectOobApiKey).toHaveBeenCalledWith(
      'codex-member', 'provision_llm_auth',
      expect.objectContaining({ prompt: 'Enter API key for codex on codex-member' }),
    );
  });

  it('deploys with near-expiry warning when token is close to expiry', async () => {
    const member = makeTestAgent({ friendlyName: 'expiring-member' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-test',
        expiresAt: new Date(Date.now() + 30 * 60000).toISOString(), // 30 min
        refreshToken: 'rt-test',
      },
    }));
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const result = await provisionAuth({ member_id: member.id });
    expect(result).toContain('OAuth credentials for claude deployed');
    expect(result).toMatch(/expires in ~\d+ minute/);
  });
});
