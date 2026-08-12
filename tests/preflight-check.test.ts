import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// Undo the global preflight mock from tests/setup.ts so we test the real implementation
vi.unmock('../src/services/preflight-check.js');
import { preflightCheck, invalidatePreflightCache, clearPreflightCache } from '../src/services/preflight-check.js';
import type { Agent } from '../src/types.js';

// ---- Mocks ----
// Mock strategy module
const mockTestConnection = vi.fn();
const mockExecCommand = vi.fn();
vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    testConnection: mockTestConnection,
    execCommand: mockExecCommand,
  }),
}));

// Mock os commands module
vi.mock('../src/os/index.js', () => ({
  getOsCommands: () => ({
    credentialFileCheck: (path: string) => `test -f "${path}" && echo found || echo not-found`,
    readTextFile: (path: string) => `readTextFile "${path}"`,
    apiKeyCheck: (envVar: string) => `echo $${envVar}`,
  }),
}));

// Mock provider
const mockOauthCredentialFiles = vi.fn();
let mockProviderName = 'claude';
vi.mock('../src/providers/index.js', () => ({
  getProvider: () => ({
    get name() { return mockProviderName; },
    authEnvVar: 'ANTHROPIC_API_KEY',
    oauthCredentialFiles: mockOauthCredentialFiles,
  }),
}));

// Mock agent helpers
vi.mock('../src/utils/agent-helpers.js', () => ({
  getAgentOS: () => 'linux',
}));

// Mock log helpers
vi.mock('../src/utils/log-helpers.js', () => ({
  logLine: vi.fn(),
}));
import { logLine as mockLogLine } from '../src/utils/log-helpers.js';
const mockLogLineFn = vi.mocked(mockLogLine);

// ---- Helpers ----
function makeAgent(overrides?: Partial<Agent>): Agent {
  return {
    id: 'test-member-1',
    friendlyName: 'test-dev',
    agentType: 'remote',
    host: '10.0.0.1',
    port: 22,
    username: 'developer',
    workFolder: '/home/developer/workspace',
    createdAt: new Date().toISOString(),
    llmProvider: 'claude',
    ...overrides,
  } as Agent;
}

describe('preflightCheck', () => {
  beforeEach(() => {
    clearPreflightCache();
    vi.clearAllMocks();
    mockProviderName = 'claude';
    mockOauthCredentialFiles.mockReturnValue([
      { localPath: '~/.claude/.credentials.json', remotePath: '~/.claude/.credentials.json' },
    ]);
  });

  afterEach(() => {
    clearPreflightCache();
  });

  // ---- Local members ----
  it('skips all checks for local members', async () => {
    const agent = makeAgent({ agentType: 'local' });
    const result = await preflightCheck(agent);
    expect(result.ok).toBe(true);
    expect(result.connectivity).toBe(true);
    expect(result.authValid).toBe(true);
    expect(mockTestConnection).not.toHaveBeenCalled();
  });

  // ---- Connectivity failures ----
  it('returns offline when testConnection fails', async () => {
    const agent = makeAgent();
    mockTestConnection.mockResolvedValue({ ok: false, latencyMs: 0, error: 'connection refused' });
    const result = await preflightCheck(agent);
    expect(result.ok).toBe(false);
    expect(result.connectivity).toBe(false);
    expect(result.code).toBe('offline');
    expect(result.reason).toContain('offline');
  });

  it('returns offline when testConnection throws', async () => {
    const agent = makeAgent();
    mockTestConnection.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await preflightCheck(agent);
    expect(result.ok).toBe(false);
    expect(result.connectivity).toBe(false);
    expect(result.code).toBe('offline');
  });

  // ---- Auth: OAuth present ----
  it('passes when OAuth credential file exists', async () => {
    const agent = makeAgent();
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 15 });
    mockExecCommand.mockResolvedValueOnce({ stdout: 'found', stderr: '', code: 0 }); // credentialFileCheck
    mockExecCommand.mockResolvedValueOnce({
      stdout: JSON.stringify({ claudeAiOauth: { expiresAt: new Date(Date.now() + 3600_000).toISOString() } }),
      stderr: '',
      code: 0,
    }); // cat credential file
    mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '', code: 1 }); // apiKeyCheck

    const result = await preflightCheck(agent);
    expect(result.ok).toBe(true);
    expect(result.connectivity).toBe(true);
    expect(result.authValid).toBe(true);
  });

  // ---- Auth: OAuth expired (no refresh) ----
  it('fails when OAuth token is expired with no refresh token', async () => {
    const agent = makeAgent();
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 10 });
    mockExecCommand.mockResolvedValueOnce({ stdout: 'found', stderr: '', code: 0 }); // credentialFileCheck
    mockExecCommand.mockResolvedValueOnce({
      stdout: JSON.stringify({ claudeAiOauth: { expiresAt: new Date(Date.now() - 3600_000).toISOString() } }),
      stderr: '',
      code: 0,
    }); // cat credential file (expired, no refreshToken)

    const result = await preflightCheck(agent);
    expect(result.ok).toBe(false);
    expect(result.connectivity).toBe(true);
    expect(result.authValid).toBe(false);
    expect(result.code).toBe('auth_expired');
    expect(result.reason).toContain('expired');
  });

  // ---- Auth: OAuth expired but refreshable ----
  it('passes when OAuth token is expired but has refresh token', async () => {
    const agent = makeAgent();
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 10 });
    mockExecCommand.mockResolvedValueOnce({ stdout: 'found', stderr: '', code: 0 }); // credentialFileCheck
    mockExecCommand.mockResolvedValueOnce({
      stdout: JSON.stringify({
        claudeAiOauth: {
          expiresAt: new Date(Date.now() - 3600_000).toISOString(),
          refreshToken: 'some-refresh-token',
        },
      }),
      stderr: '',
      code: 0,
    }); // cat credential file (expired but refreshable)
    mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '', code: 1 }); // apiKeyCheck (not found)

    const result = await preflightCheck(agent);
    expect(result.ok).toBe(true);
    expect(result.authValid).toBe(true);
  });

  // ---- Auth: API key present ----
  it('passes when API key is present (no OAuth)', async () => {
    const agent = makeAgent();
    mockOauthCredentialFiles.mockReturnValue([
      { localPath: '~/.claude/.credentials.json', remotePath: '~/.claude/.credentials.json' },
    ]);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValueOnce({ stdout: 'not-found', stderr: '', code: 0 }); // credentialFileCheck
    mockExecCommand.mockResolvedValueOnce({ stdout: 'sk-ant-api03-XXXXX', stderr: '', code: 0 }); // apiKeyCheck

    const result = await preflightCheck(agent);
    expect(result.ok).toBe(true);
    expect(result.authValid).toBe(true);
  });

  // ---- Auth: no credentials found ----
  it('fails when no credentials are found at all', async () => {
    const agent = makeAgent();
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValueOnce({ stdout: 'not-found', stderr: '', code: 0 }); // credentialFileCheck
    mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '', code: 1 }); // apiKeyCheck

    const result = await preflightCheck(agent);
    expect(result.ok).toBe(false);
    expect(result.connectivity).toBe(true);
    expect(result.authValid).toBe(false);
    expect(result.code).toBe('auth_missing');
    expect(result.reason).toContain('provision_llm_auth');
  });

  // ---- Auth: stored encrypted env var counts ----
  it('passes when agent has stored encrypted env var for the auth env var', async () => {
    const agent = makeAgent({
      encryptedEnvVars: { ANTHROPIC_API_KEY: 'encrypted-value' },
    });
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValueOnce({ stdout: 'not-found', stderr: '', code: 0 }); // credentialFileCheck
    mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '', code: 1 }); // apiKeyCheck (not in env)

    const result = await preflightCheck(agent);
    expect(result.ok).toBe(true);
    expect(result.authValid).toBe(true);
  });

  // ---- Cache behavior ----
  it('returns cached result for a recently passing member', async () => {
    const agent = makeAgent();
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValueOnce({ stdout: 'found', stderr: '', code: 0 }); // credentialFileCheck
    mockExecCommand.mockResolvedValueOnce({
      stdout: JSON.stringify({ claudeAiOauth: { expiresAt: new Date(Date.now() + 3600_000).toISOString() } }),
      stderr: '',
      code: 0,
    }); // cat
    mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '', code: 1 }); // apiKeyCheck

    // First call
    const result1 = await preflightCheck(agent);
    expect(result1.ok).toBe(true);
    const callCount = mockTestConnection.mock.calls.length;

    // Second call -- should use cache
    const result2 = await preflightCheck(agent);
    expect(result2.ok).toBe(true);
    expect(mockTestConnection.mock.calls.length).toBe(callCount); // no new calls
  });

  it('bypasses cache when skipCache is set', async () => {
    const agent = makeAgent();
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: 'found', stderr: '', code: 0 }); // all exec calls

    // First call populates cache
    await preflightCheck(agent);
    const callCount = mockTestConnection.mock.calls.length;

    // Second call with skipCache
    await preflightCheck(agent, { skipCache: true });
    expect(mockTestConnection.mock.calls.length).toBe(callCount + 1);
  });

  it('invalidatePreflightCache clears a specific member', async () => {
    const agent = makeAgent();
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: 'found', stderr: '', code: 0 });

    // Populate cache
    await preflightCheck(agent);
    const callCount = mockTestConnection.mock.calls.length;

    // Invalidate
    invalidatePreflightCache(agent.id);

    // Next call should re-check
    await preflightCheck(agent);
    expect(mockTestConnection.mock.calls.length).toBe(callCount + 1);
  });

  // ---- skipAuth option ----
  it('skips auth check when skipAuth is true', async () => {
    const agent = makeAgent();
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });

    const result = await preflightCheck(agent, { skipAuth: true });
    expect(result.ok).toBe(true);
    expect(result.authValid).toBe(true);
    // execCommand should not have been called (no credential checks)
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  // ---- F2: skipAuth cache must not satisfy full-auth lookups ----
  it('conn-only cache does not satisfy a subsequent full-auth check', async () => {
    const agent = makeAgent();
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: 'found', stderr: '', code: 0 });

    // First call: conn-only (skipAuth)
    await preflightCheck(agent, { skipAuth: true });
    const connCalls = mockTestConnection.mock.calls.length;

    // Second call: full auth -- must NOT get a cache hit from the conn pass
    await preflightCheck(agent);
    expect(mockTestConnection.mock.calls.length).toBe(connCalls + 1);
  });

  it('full-auth cache satisfies a subsequent conn-only check', async () => {
    const agent = makeAgent();
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: 'found', stderr: '', code: 0 });

    // First call: full auth
    await preflightCheck(agent);
    const fullCalls = mockTestConnection.mock.calls.length;

    // Second call: conn-only -- full cache should satisfy it
    await preflightCheck(agent, { skipAuth: true });
    expect(mockTestConnection.mock.calls.length).toBe(fullCalls);
  });

  // ---- none provider ----
  it('skips auth check for none provider', async () => {
    const agent = makeAgent({ llmProvider: 'none' });
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });

    const result = await preflightCheck(agent);
    expect(result.ok).toBe(true);
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  // ---- F4: non-Claude provider logs a warning instead of silent no-op ----
  it('logs warning for non-Claude provider when OAuth freshness check cannot parse', async () => {
    mockProviderName = 'gemini';
    const agent = makeAgent({ llmProvider: 'gemini' });
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValueOnce({ stdout: 'found', stderr: '', code: 0 }); // credentialFileCheck
    mockExecCommand.mockResolvedValueOnce({
      stdout: JSON.stringify({ geminiOauth: { token: 'some-token' } }),
      stderr: '',
      code: 0,
    }); // readTextFile -- non-Claude shape
    mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '', code: 1 }); // apiKeyCheck

    const result = await preflightCheck(agent);
    expect(result.ok).toBe(true);
    expect(mockLogLineFn).toHaveBeenCalledWith(
      'preflight',
      expect.stringContaining('OAuth freshness check not implemented for provider gemini'),
      agent,
    );
  });

  // ---- F5: readTextFile helper is used (not hand-rolled) ----
  it('uses cmds.readTextFile for reading credential files', async () => {
    const agent = makeAgent();
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValueOnce({ stdout: 'found', stderr: '', code: 0 }); // credentialFileCheck
    mockExecCommand.mockResolvedValueOnce({
      stdout: JSON.stringify({ claudeAiOauth: { expiresAt: new Date(Date.now() + 3600_000).toISOString() } }),
      stderr: '',
      code: 0,
    }); // readTextFile
    mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '', code: 1 }); // apiKeyCheck

    await preflightCheck(agent);

    // The second execCommand call should be the readTextFile helper output,
    // not the hand-rolled powershell/cat command. The mock OS commands module
    // doesn't transform the path, but verifying it was called with a string
    // NOT containing 'powershell' or raw 'cat' confirms the helper is used.
    const readCmd = mockExecCommand.mock.calls[1][0];
    expect(readCmd).not.toContain('powershell -Command');
    expect(readCmd).not.toMatch(/^cat "/);
  });
});
