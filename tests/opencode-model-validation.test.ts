import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeTestAgent } from './test-helpers.js';
import { validateOpenCodeModelTiers } from '../src/utils/opencode-model-validation.js';
import type { SSHExecResult } from '../src/types.js';

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: vi.fn(),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

describe('validateOpenCodeModelTiers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns no warnings when all specified models are in available list', async () => {
    const agent = makeTestAgent({ llmProvider: 'opencode' });
    mockExecCommand.mockResolvedValue({
      stdout: 'ollama/qwen3-coder:30b\nollama/llama3:8b\nanthropic/claude-3-5-haiku\n',
      stderr: '',
      code: 0,
    });

    const result = await validateOpenCodeModelTiers(agent, {
      cheap: 'ollama/llama3:8b',
      standard: 'ollama/qwen3-coder:30b',
      premium: 'anthropic/claude-3-5-haiku',
    });

    expect(result.warnings).toHaveLength(0);
  });

  it('returns a warning when one model is not found in available list', async () => {
    const agent = makeTestAgent({ llmProvider: 'opencode' });
    mockExecCommand.mockResolvedValue({
      stdout: 'ollama/qwen3-coder:30b\nollama/llama3:8b\n',
      stderr: '',
      code: 0,
    });

    const result = await validateOpenCodeModelTiers(agent, {
      cheap: 'ollama/llama3:8b',
      premium: 'anthropic/claude-3-5-sonnet',
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('premium="anthropic/claude-3-5-sonnet"');
    expect(result.warnings[0]).toContain('ollama/qwen3-coder:30b');
    expect(result.warnings[0]).toContain('ollama/llama3:8b');
    expect(result.warnings[0]).toContain('update_member');
  });

  it('returns a warning listing all available models when all specified models are invalid', async () => {
    const agent = makeTestAgent({ llmProvider: 'opencode' });
    mockExecCommand.mockResolvedValue({
      stdout: 'ollama/qwen3-coder:30b\nollama/llama3:8b\n',
      stderr: '',
      code: 0,
    });

    const result = await validateOpenCodeModelTiers(agent, {
      cheap: 'bad-model-a',
      standard: 'bad-model-b',
      premium: 'bad-model-c',
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('cheap="bad-model-a"');
    expect(result.warnings[0]).toContain('standard="bad-model-b"');
    expect(result.warnings[0]).toContain('premium="bad-model-c"');
    expect(result.warnings[0]).toContain('ollama/qwen3-coder:30b');
    expect(result.warnings[0]).toContain('ollama/llama3:8b');
  });

  it('returns no warnings when opencode models exits non-zero (silent skip)', async () => {
    const agent = makeTestAgent({ llmProvider: 'opencode' });
    mockExecCommand.mockResolvedValue({
      stdout: '',
      stderr: 'opencode: command not found',
      code: 1,
    });

    const result = await validateOpenCodeModelTiers(agent, {
      cheap: 'some-model',
      premium: 'another-model',
    });

    expect(result.warnings).toHaveLength(0);
  });

  it('returns no warnings when execCommand throws (silent skip)', async () => {
    const agent = makeTestAgent({ llmProvider: 'opencode' });
    mockExecCommand.mockRejectedValue(new Error('SSH connection refused'));

    const result = await validateOpenCodeModelTiers(agent, {
      cheap: 'some-model',
    });

    expect(result.warnings).toHaveLength(0);
  });

  it('returns no warnings when model_tiers has no values (all undefined)', async () => {
    const agent = makeTestAgent({ llmProvider: 'opencode' });
    mockExecCommand.mockResolvedValue({
      stdout: 'ollama/qwen3-coder:30b\n',
      stderr: '',
      code: 0,
    });

    const result = await validateOpenCodeModelTiers(agent, {});

    expect(result.warnings).toHaveLength(0);
  });
});
