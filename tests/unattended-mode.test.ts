import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent, getAgent } from '../src/services/registry.js';
import { updateMember } from '../src/tools/update-member.js';
import { executePrompt } from '../src/tools/execute-prompt.js';
import { ClaudeProvider } from '../src/providers/claude.js';
import { GeminiProvider } from '../src/providers/gemini.js';
import { CodexProvider } from '../src/providers/codex.js';
import { CopilotProvider } from '../src/providers/copilot.js';
import type { SSHExecResult } from '../src/types.js';

const BASE_OPTS = { folder: '/work', promptFile: '.fleet-task.md' };

// ─── Provider unit tests ────────────────────────────────────────────────────

describe('unattended mode — provider CLI args', () => {
  describe('ClaudeProvider', () => {
    const p = new ClaudeProvider();

    it('adds --permission-mode auto for unattended=auto', () => {
      const cmd = p.buildPromptCommand({ ...BASE_OPTS, unattended: 'auto' });
      expect(cmd).toContain('--permission-mode auto');
      expect(cmd).not.toContain('--dangerously-skip-permissions');
    });

    it('adds --dangerously-skip-permissions for unattended=dangerous', () => {
      const cmd = p.buildPromptCommand({ ...BASE_OPTS, unattended: 'dangerous' });
      expect(cmd).toContain('--dangerously-skip-permissions');
      expect(cmd).not.toContain('--permission-mode');
    });

    it('adds no permission flag for unattended=false', () => {
      const cmd = p.buildPromptCommand({ ...BASE_OPTS, unattended: false });
      expect(cmd).not.toContain('--permission-mode');
      expect(cmd).not.toContain('--dangerously-skip-permissions');
    });

    it('adds no permission flag when unattended is undefined', () => {
      const cmd = p.buildPromptCommand({ ...BASE_OPTS });
      expect(cmd).not.toContain('--permission-mode');
      expect(cmd).not.toContain('--dangerously-skip-permissions');
    });
  });

  describe('GeminiProvider', () => {
    const p = new GeminiProvider();

    it('logs warning and adds no flag for unattended=auto', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const cmd = p.buildPromptCommand({ ...BASE_OPTS, unattended: 'auto' });
      expect(cmd).not.toContain('--yolo');
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("unattended='auto' is not supported for Gemini"));
      spy.mockRestore();
    });

    it('logs warning and adds no flag for unattended=dangerous', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const cmd = p.buildPromptCommand({ ...BASE_OPTS, unattended: 'dangerous' });
      expect(cmd).not.toContain('--yolo');
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("unattended='dangerous' is not supported for Gemini"));
      spy.mockRestore();
    });
  });

  describe('CodexProvider', () => {
    const p = new CodexProvider();

    it('adds --ask-for-approval auto-edit for unattended=auto', () => {
      const cmd = p.buildPromptCommand({ ...BASE_OPTS, unattended: 'auto' });
      expect(cmd).toContain('--ask-for-approval auto-edit');
    });

    it('logs warning for unattended=dangerous', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const cmd = p.buildPromptCommand({ ...BASE_OPTS, unattended: 'dangerous' });
      expect(cmd).not.toContain('--sandbox');
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("unattended='dangerous' is not supported for Codex"));
      spy.mockRestore();
    });
  });

  describe('CopilotProvider', () => {
    const p = new CopilotProvider();

    it('logs warning for unattended=auto', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const cmd = p.buildPromptCommand({ ...BASE_OPTS, unattended: 'auto' });
      expect(cmd).not.toContain('--allow-all-tools');
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("unattended='auto' is not supported for Copilot"));
      spy.mockRestore();
    });

    it('logs warning for unattended=dangerous', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const cmd = p.buildPromptCommand({ ...BASE_OPTS, unattended: 'dangerous' });
      expect(cmd).not.toContain('--allow-all-tools');
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("unattended='dangerous' is not supported for Copilot"));
      spy.mockRestore();
    });
  });
});

// ─── Registry persistence tests ─────────────────────────────────────────────

describe('unattended mode — registry persistence', () => {
  beforeEach(() => { backupAndResetRegistry(); });
  afterEach(() => { restoreRegistry(); });

  it('update_member sets unattended=auto on agent record', async () => {
    const agent = makeTestLocalAgent({ friendlyName: 'unatt-test' });
    addAgent(agent);

    const result = await updateMember({ member_id: agent.id, unattended: 'auto' });
    expect(result).toContain('updated');

    const updated = getAgent(agent.id);
    expect(updated?.unattended).toBe('auto');
  });

  it('update_member sets unattended=dangerous on agent record', async () => {
    const agent = makeTestLocalAgent({ friendlyName: 'unatt-test-2' });
    addAgent(agent);

    const result = await updateMember({ member_id: agent.id, unattended: 'dangerous' });
    expect(result).toContain('updated');

    const updated = getAgent(agent.id);
    expect(updated?.unattended).toBe('dangerous');
  });

  it('update_member can reset unattended back to false', async () => {
    const agent = makeTestLocalAgent({ friendlyName: 'unatt-reset', unattended: 'auto' });
    addAgent(agent);

    await updateMember({ member_id: agent.id, unattended: false });

    const updated = getAgent(agent.id);
    expect(updated?.unattended).toBe(false);
  });
});

// ─── execute_prompt deprecation tests ───────────────────────────────────────

const mockExecCommand = vi.fn<(cmd: string, timeout?: number, maxTotalMs?: number) => Promise<SSHExecResult>>();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: vi.fn(),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

describe('execute_prompt dangerously_skip_permissions deprecation', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    restoreRegistry();
    vi.useRealTimers();
  });

  it('returns deprecation warning when dangerously_skip_permissions=true is passed', async () => {
    const agent = makeTestAgent({ friendlyName: 'depr-test' });
    addAgent(agent);

    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'done', session_id: 'sess-1' }),
      stderr: '',
      code: 0,
    });

    const result = await executePrompt({
      member_id: agent.id,
      prompt: 'do something',
      resume: false,
      timeout_ms: 5000,
      dangerously_skip_permissions: true,
    });

    expect(result).toContain('DEPRECATION');
    expect(result).toContain('dangerously_skip_permissions is deprecated and ignored');
  });

  it('does not apply --dangerously-skip-permissions when dangerously_skip_permissions=true is passed', async () => {
    const agent = makeTestAgent({ friendlyName: 'depr-no-flag' });
    addAgent(agent);

    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'done', session_id: 'sess-2' }),
      stderr: '',
      code: 0,
    });

    await executePrompt({
      member_id: agent.id,
      prompt: 'do something',
      resume: false,
      timeout_ms: 5000,
      dangerously_skip_permissions: true,
    });

    const cmd = mockExecCommand.mock.calls[0]?.[0] ?? '';
    expect(cmd).not.toContain('--dangerously-skip-permissions');
  });

  it('does not show deprecation warning when dangerously_skip_permissions is false', async () => {
    const agent = makeTestAgent({ friendlyName: 'no-depr' });
    addAgent(agent);

    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'done', session_id: 'sess-3' }),
      stderr: '',
      code: 0,
    });

    const result = await executePrompt({
      member_id: agent.id,
      prompt: 'do something',
      resume: false,
      timeout_ms: 5000,
      dangerously_skip_permissions: false,
    });

    expect(result).not.toContain('DEPRECATION');
  });
});
