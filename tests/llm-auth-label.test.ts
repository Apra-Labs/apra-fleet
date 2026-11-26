/**
 * The LLM credential label list_members (llm_auth) and member_detail
 * (llm_cli.auth) report: one case per credential variable, through BOTH tools,
 * with the real provider adapters and the real OS command builders. Only the
 * member's answers to the probe commands are simulated.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { memberDetail } from '../src/tools/member-detail.js';
import { listMembers } from '../src/tools/list-members.js';
import { getProvider } from '../src/providers/index.js';
import { llmAuthStatusFromSources, providerAuthEnvVars } from '../src/services/llm-auth-label.js';
import type { LlmProvider, SSHExecResult } from '../src/types.js';

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: async () => ({ ok: true, latencyMs: 3 }),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock('../src/services/cloud-sync.js', () => ({
  syncCloudCache: vi.fn(async () => ({ status: 'not-connected' })),
}));

/** What the simulated member has: env vars set (name -> value) and whether the credentials file exists. */
interface MemberState { env: Record<string, string>; credentialsFile: boolean }

const apiKeyChecks: string[] = [];

function simulate(state: MemberState): void {
  apiKeyChecks.length = 0;
  mockExecCommand.mockImplementation(async (cmd: string) => {
    const envProbe = /\$\{([A-Za-z_][A-Za-z0-9_]*):0:10\}/.exec(cmd);
    if (envProbe) {
      apiKeyChecks.push(envProbe[1]);
      return { stdout: (state.env[envProbe[1]] ?? '').slice(0, 10), stderr: '', code: 0 };
    }
    if (cmd.startsWith('test -f ')) return { stdout: state.credentialsFile ? 'found' : 'missing', stderr: '', code: 0 };
    if (cmd.includes('--version')) return { stdout: '1.0.42', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  });
}

async function labelsFor(state: MemberState, llmProvider: LlmProvider = 'claude'): Promise<{ detail: string; detailNote: string | null; list: string; compact: string }> {
  backupAndResetRegistry();
  try {
    const member = makeTestAgent({ friendlyName: 'auth-member', os: 'linux', llmProvider });
    addAgent(member);
    simulate(state);
    const detailJson = JSON.parse(await memberDetail({ member_id: member.id, format: 'json' }));
    const compact = await memberDetail({ member_id: member.id, format: 'compact' });
    const list = JSON.parse(await listMembers({ format: 'json' }));
    const row = list.members.find((m: { id: string }) => m.id === member.id);
    return { detail: detailJson.llm_cli.auth, detailNote: detailJson.llm_cli.authNote, list: row.llm_auth, compact };
  } finally {
    restoreRegistry();
  }
}

const API_KEY = 'sk-ant-api03-xxxxxxxx';
const OAUTH_TOKEN = 'sk-ant-oat01-xxxxxxxx';

describe('llm auth label per credential variable (claude), identical in list_members and member_detail', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => mockExecCommand.mockReset());

  it('CLAUDE_CODE_OAUTH_TOKEN only -> oauth-token (not api-key)', async () => {
    const r = await labelsFor({ env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN }, credentialsFile: false });
    expect(r.detail).toBe('oauth-token');
    expect(r.list).toBe('oauth-token');
    expect(r.detailNote).toBeNull();
  });

  it('ANTHROPIC_API_KEY only -> api-key', async () => {
    const r = await labelsFor({ env: { ANTHROPIC_API_KEY: API_KEY }, credentialsFile: false });
    expect(r.detail).toBe('api-key');
    expect(r.list).toBe('api-key');
    expect(r.detailNote).toBeNull();
  });

  it('credentials file only -> oauth-login', async () => {
    const r = await labelsFor({ env: {}, credentialsFile: true });
    expect(r.detail).toBe('oauth-login');
    expect(r.list).toBe('oauth-login');
  });

  it('OAuth token env + credentials file -> oauth-token+oauth-login, member_detail notes the token wins', async () => {
    const r = await labelsFor({ env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN }, credentialsFile: true });
    expect(r.detail).toBe('oauth-token+oauth-login');
    expect(r.list).toBe('oauth-token+oauth-login');
    expect(r.detailNote).toBe('oauth-token takes precedence over oauth-login');
  });

  it('API key + credentials file -> api-key+oauth-login with the member_detail precedence note', async () => {
    const r = await labelsFor({ env: { ANTHROPIC_API_KEY: API_KEY }, credentialsFile: true });
    expect(r.detail).toBe('api-key+oauth-login');
    expect(r.list).toBe('api-key+oauth-login');
    expect(r.detailNote).toBe('api-key takes precedence over oauth-login');
    expect(r.compact).toContain('auth=api-key+oauth-login (api-key takes precedence over oauth-login)');
  });

  it('every source at once is reported in the fixed order (all env vars probed, not the first hit)', async () => {
    const r = await labelsFor({ env: { ANTHROPIC_API_KEY: API_KEY, CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN }, credentialsFile: true });
    expect(r.detail).toBe('api-key+oauth-token+oauth-login');
    expect(r.list).toBe(r.detail);
    expect(r.detailNote).toBe('api-key takes precedence over oauth-token and oauth-login');
  });

  it('nothing -> none', async () => {
    const r = await labelsFor({ env: {}, credentialsFile: false });
    expect(r.detail).toBe('none');
    expect(r.list).toBe('none');
    expect(r.detailNote).toBeNull();
  });
});

describe('llm auth label for other providers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a non-claude provider with a single auth env var still reports api-key', async () => {
    const r = await labelsFor({ env: { OPENAI_API_KEY: 'sk-proj-xxxxxxxx' }, credentialsFile: false }, 'codex');
    expect(r.detail).toBe('api-key');
    expect(r.list).toBe('api-key');
  });

  it('opencode (authEnvVar empty) never calls apiKeyCheck with an empty name', async () => {
    expect(getProvider('opencode').authEnvVar).toBe('');
    expect(providerAuthEnvVars(getProvider('opencode'))).toEqual([]);
    const r = await labelsFor({ env: {}, credentialsFile: false }, 'opencode');
    expect(apiKeyChecks).toEqual([]);
    expect(r.detail).toBe('none');
    expect(r.list).toBe('none');
  });
});

describe('ProviderAdapter.authEnvVarKind (claude)', () => {
  const claude = getProvider('claude');

  it('classifies CLAUDE_CODE_OAUTH_TOKEN as oauth-token and ANTHROPIC_API_KEY as api-key', () => {
    expect(claude.authEnvVarKind?.('CLAUDE_CODE_OAUTH_TOKEN')).toBe('oauth-token');
    expect(claude.authEnvVarKind?.('ANTHROPIC_API_KEY')).toBe('api-key');
  });

  it('covers every Claude auth env var', () => {
    expect(providerAuthEnvVars(claude).map(n => claude.authEnvVarKind?.(n)).sort()).toEqual(['api-key', 'oauth-token']);
  });

  it('label ordering is fixed regardless of discovery order', () => {
    expect(llmAuthStatusFromSources(['oauth-login', 'api-key']).label).toBe('api-key+oauth-login');
    expect(llmAuthStatusFromSources([]).label).toBe('none');
  });
});
