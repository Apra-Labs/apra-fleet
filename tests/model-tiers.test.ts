import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveModelForTier } from '../src/tools/execute-prompt.js';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent, getAgent, getAllAgents } from '../src/services/registry.js';
import { executePrompt } from '../src/tools/execute-prompt.js';
import { registerMember } from '../src/tools/register-member.js';
import { OpenCodeProvider } from '../src/providers/opencode.js';
import { ClaudeProvider } from '../src/providers/claude.js';
import type { SSHExecResult } from '../src/types.js';

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
  readMemberStatus: vi.fn(() => 'idle'),
}));

const mockExecCommand = vi.fn<(cmd: string, timeout?: number, maxTotalMs?: number) => Promise<SSHExecResult>>();

const mockTestConnection = vi.fn();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: mockTestConnection,
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

// -- resolveModelForTier unit tests --

describe('resolveModelForTier', () => {
  const opencode = new OpenCodeProvider();
  const claude = new ClaudeProvider();

  it('resolves each tier from a full model_tiers map', () => {
    const agent = makeTestAgent({
      modelTiers: {
        cheap: 'ollama/small:7b',
        standard: 'ollama/medium:14b',
        premium: 'ollama/large:70b',
      },
    });

    expect(resolveModelForTier(agent, 'cheap', opencode)).toBe('ollama/small:7b');
    expect(resolveModelForTier(agent, 'standard', opencode)).toBe('ollama/medium:14b');
    expect(resolveModelForTier(agent, 'premium', opencode)).toBe('ollama/large:70b');
  });

  it('single-model map (all tiers identical) resolves correctly', () => {
    const agent = makeTestAgent({
      modelTiers: {
        cheap: 'ollama/only-model:30b',
        standard: 'ollama/only-model:30b',
        premium: 'ollama/only-model:30b',
      },
    });

    expect(resolveModelForTier(agent, 'cheap', opencode)).toBe('ollama/only-model:30b');
    expect(resolveModelForTier(agent, 'standard', opencode)).toBe('ollama/only-model:30b');
    expect(resolveModelForTier(agent, 'premium', opencode)).toBe('ollama/only-model:30b');
  });

  it('falls back to standard when requested tier is missing', () => {
    const agent = makeTestAgent({
      modelTiers: {
        standard: 'ollama/fallback:14b',
      },
    });

    expect(resolveModelForTier(agent, 'cheap', opencode)).toBe('ollama/fallback:14b');
    expect(resolveModelForTier(agent, 'premium', opencode)).toBe('ollama/fallback:14b');
  });

  it('falls back to cheap when standard is also missing', () => {
    const agent = makeTestAgent({
      modelTiers: {
        cheap: 'ollama/cheap-only:7b',
      },
    });

    expect(resolveModelForTier(agent, 'standard', opencode)).toBe('ollama/cheap-only:7b');
    expect(resolveModelForTier(agent, 'premium', opencode)).toBe('ollama/cheap-only:7b');
  });

  it('falls back to first non-empty value as last resort', () => {
    const agent = makeTestAgent({
      modelTiers: {
        premium: 'ollama/premium-only:70b',
      },
    });

    expect(resolveModelForTier(agent, 'cheap', opencode)).toBe('ollama/premium-only:70b');
    expect(resolveModelForTier(agent, 'standard', opencode)).toBe('ollama/premium-only:70b');
  });

  it('falls back to adapter defaults when modelTiers is undefined', () => {
    const agent = makeTestAgent({ modelTiers: undefined });

    expect(resolveModelForTier(agent, 'cheap', opencode)).toBe('ollama/qwen3-coder:30b');
    expect(resolveModelForTier(agent, 'standard', opencode)).toBe('ollama/qwen3-coder:30b');
    expect(resolveModelForTier(agent, 'premium', opencode)).toBe('ollama/MichelRosselli/GLM-4.5-Air:Q4_K_M');
  });

  it('falls back to claude adapter modelForTier when modelTiers is undefined', () => {
    const agent = makeTestAgent({ modelTiers: undefined });

    expect(resolveModelForTier(agent, 'cheap', claude)).toBe(claude.modelForTier('cheap'));
    expect(resolveModelForTier(agent, 'mid', claude)).toBe(claude.modelForTier('mid'));
    expect(resolveModelForTier(agent, 'premium', claude)).toBe(claude.modelForTier('premium'));
  });
});

// -- executePrompt integration: model_tiers dispatch --

describe('executePrompt model_tiers dispatch', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    restoreRegistry();
    vi.useRealTimers();
  });

  it('resolves tier "standard" from member model_tiers instead of adapter default', async () => {
    const member = makeTestAgent({
      friendlyName: 'mt-standard',
      llmProvider: 'opencode',
      modelTiers: {
        cheap: 'ollama/small:7b',
        standard: 'ollama/medium:14b',
        premium: 'ollama/large:70b',
      },
    });
    addAgent(member);
    mockExecCommand.mockResolvedValue({
      stdout: '{"type":"text","sessionID":"ses_t","part":{"text":"ok"}}\n{"type":"step_finish","sessionID":"ses_t","part":{"reason":"stop","tokens":{"total":10,"input":8,"output":2,"reasoning":0,"cache":{"write":0,"read":0}},"cost":0}}',
      stderr: '',
      code: 0,
    });

    await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5, model: 'standard' });

    const cmd = mockExecCommand.mock.calls[1][0];
    expect(cmd).toContain('ollama/medium:14b');
    expect(cmd).not.toContain('ollama/qwen3-coder:30b');
  });

  it('resolves tier "cheap" from member model_tiers', async () => {
    const member = makeTestAgent({
      friendlyName: 'mt-cheap',
      llmProvider: 'opencode',
      modelTiers: {
        cheap: 'ollama/small:7b',
        standard: 'ollama/medium:14b',
        premium: 'ollama/large:70b',
      },
    });
    addAgent(member);
    mockExecCommand.mockResolvedValue({
      stdout: '{"type":"text","sessionID":"ses_t","part":{"text":"ok"}}\n{"type":"step_finish","sessionID":"ses_t","part":{"reason":"stop","tokens":{"total":10,"input":8,"output":2,"reasoning":0,"cache":{"write":0,"read":0}},"cost":0}}',
      stderr: '',
      code: 0,
    });

    await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5, model: 'cheap' });

    const cmd = mockExecCommand.mock.calls[1][0];
    expect(cmd).toContain('ollama/small:7b');
  });

  it('resolves tier "premium" from member model_tiers', async () => {
    const member = makeTestAgent({
      friendlyName: 'mt-premium',
      llmProvider: 'opencode',
      modelTiers: {
        cheap: 'ollama/small:7b',
        standard: 'ollama/medium:14b',
        premium: 'ollama/large:70b',
      },
    });
    addAgent(member);
    mockExecCommand.mockResolvedValue({
      stdout: '{"type":"text","sessionID":"ses_t","part":{"text":"ok"}}\n{"type":"step_finish","sessionID":"ses_t","part":{"reason":"stop","tokens":{"total":10,"input":8,"output":2,"reasoning":0,"cache":{"write":0,"read":0}},"cost":0}}',
      stderr: '',
      code: 0,
    });

    await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5, model: 'premium' });

    const cmd = mockExecCommand.mock.calls[1][0];
    expect(cmd).toContain('ollama/large:70b');
  });

  it('falls back to adapter defaults when member has no model_tiers', async () => {
    const member = makeTestAgent({
      friendlyName: 'mt-fallback',
      llmProvider: 'opencode',
    });
    addAgent(member);
    mockExecCommand.mockResolvedValue({
      stdout: '{"type":"text","sessionID":"ses_t","part":{"text":"ok"}}\n{"type":"step_finish","sessionID":"ses_t","part":{"reason":"stop","tokens":{"total":10,"input":8,"output":2,"reasoning":0,"cache":{"write":0,"read":0}},"cost":0}}',
      stderr: '',
      code: 0,
    });

    await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5, model: 'standard' });

    const cmd = mockExecCommand.mock.calls[1][0];
    expect(cmd).toContain('ollama/qwen3-coder:30b');
  });
});

// -- register_member model_tiers validation --

describe('register_member model_tiers normalization', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: 'Linux', stderr: '', code: 0 });
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('single model fills all three tiers', async () => {
    const result = await registerMember({
      friendly_name: 'mt-single-test',
      member_type: 'local',
      work_folder: `/tmp/mt-single-${Date.now()}`,
      llm_provider: 'opencode',
      model_tiers: { standard: 'ollama/qwen3-coder:30b' },
    });

    expect(result).toContain('registered successfully');
    const agents = getAllAgents();
    const created = agents.find(a => a.friendlyName === 'mt-single-test');
    expect(created).toBeDefined();
    expect(created!.modelTiers).toEqual({
      cheap: 'ollama/qwen3-coder:30b',
      standard: 'ollama/qwen3-coder:30b',
      premium: 'ollama/qwen3-coder:30b',
    });
  });

  it('rejects empty model_tiers', async () => {
    const result = await registerMember({
      friendly_name: 'mt-empty-test',
      member_type: 'local',
      work_folder: `/tmp/mt-empty-${Date.now()}`,
      llm_provider: 'opencode',
      model_tiers: {},
    });

    expect(result).toContain('no models');
    expect(result).toContain('NOT registered');
  });

  it('fills missing tiers with fallback from standard', async () => {
    const result = await registerMember({
      friendly_name: 'mt-partial-test',
      member_type: 'local',
      work_folder: `/tmp/mt-partial-${Date.now()}`,
      llm_provider: 'opencode',
      model_tiers: { cheap: 'ollama/small:7b', standard: 'ollama/medium:14b' },
    });

    expect(result).toContain('registered successfully');
    const agents = getAllAgents();
    const created = agents.find(a => a.friendlyName === 'mt-partial-test');
    expect(created).toBeDefined();
    expect(created!.modelTiers!.cheap).toBe('ollama/small:7b');
    expect(created!.modelTiers!.standard).toBe('ollama/medium:14b');
    expect(created!.modelTiers!.premium).toBe('ollama/medium:14b');
  });

  it('stores full model_tiers map on member record', async () => {
    const result = await registerMember({
      friendly_name: 'mt-full-test',
      member_type: 'local',
      work_folder: `/tmp/mt-full-${Date.now()}`,
      llm_provider: 'opencode',
      model_tiers: {
        cheap: 'ollama/small:7b',
        standard: 'ollama/medium:14b',
        premium: 'ollama/large:70b',
      },
    });

    expect(result).toContain('registered successfully');
    expect(result).toContain('Model Tiers');
    const agents = getAllAgents();
    const created = agents.find(a => a.friendlyName === 'mt-full-test');
    expect(created).toBeDefined();
    expect(created!.modelTiers).toEqual({
      cheap: 'ollama/small:7b',
      standard: 'ollama/medium:14b',
      premium: 'ollama/large:70b',
    });
  });

  it('opencode member without model_tiers emits warning but registers', async () => {
    const result = await registerMember({
      friendly_name: 'mt-warn-test',
      member_type: 'local',
      work_folder: `/tmp/mt-warn-${Date.now()}`,
      llm_provider: 'opencode',
    });

    expect(result).toContain('registered successfully');
    expect(result).toContain('adapter defaults');
  });
});
