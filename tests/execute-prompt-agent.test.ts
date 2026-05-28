/**
 * Tests for execute_prompt agent parameter (Task 2 done criteria).
 *
 * Uses local agents with a real tmpdir so agent file existence checks
 * (fs.existsSync) work without extra SSH mock calls.  Forces os='linux'
 * so tests are platform-independent -- the Linux buildAgentPromptCommand
 * delegates to provider.buildPromptCommand which already handles agentName.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { executePrompt } from '../src/tools/execute-prompt.js';
import type { SSHExecResult } from '../src/types.js';

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
  readMemberStatus: vi.fn(() => 'idle'),
}));

const mockExecCommand = vi.fn<(cmd: string, timeout?: number, maxTotalMs?: number) => Promise<SSHExecResult>>();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: vi.fn(),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

const successResponse = JSON.stringify({ result: 'done', session_id: 'sess-agent' });

describe('execute_prompt -- agent parameter', () => {
  let tmpDir: string;

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-agent-test-'));
  });

  afterEach(() => {
    restoreRegistry();
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- Claude: CLI includes --agent <name> ---

  it('Claude: CLI invocation includes --agent <name>', async () => {
    const agentDir = path.join(tmpDir, '.claude', 'agents');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'doer.md'), '# doer agent');

    const member = makeTestLocalAgent({
      friendlyName: 'claude-agent-test',
      workFolder: tmpDir,
      llmProvider: 'claude',
      os: 'linux',
    });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: successResponse, stderr: '', code: 0 });

    await executePrompt({ member_id: member.id, prompt: 'do the task', resume: false, timeout_s: 5, agent: 'doer' });

    // For local agents: no writePromptFile exec call, so calls[0] is the main command.
    const cmd = mockExecCommand.mock.calls[0][0];
    expect(cmd).toContain('--agent "doer"');
  });

  // --- Gemini: prompt has @<name> prepended ---

  it('Gemini: CLI invocation prepends @<name> to the prompt', async () => {
    const agentDir = path.join(tmpDir, '.gemini', 'agents');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'doer.md'), '# doer agent');

    const member = makeTestLocalAgent({
      friendlyName: 'gemini-agent-test',
      workFolder: tmpDir,
      llmProvider: 'gemini',
      os: 'linux',
    });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: successResponse, stderr: '', code: 0 });

    await executePrompt({ member_id: member.id, prompt: 'do the task', resume: false, timeout_s: 5, agent: 'doer' });

    const cmd = mockExecCommand.mock.calls[0][0];
    expect(cmd).toContain('@doer ');
  });

  // --- Gemini: @name prepend on resume=true ---

  it('Gemini: @name prepend happens on resume=true dispatch', async () => {
    const agentDir = path.join(tmpDir, '.gemini', 'agents');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'doer.md'), '# doer agent');

    const member = makeTestLocalAgent({
      friendlyName: 'gemini-resume-agent-test',
      workFolder: tmpDir,
      llmProvider: 'gemini',
      os: 'linux',
      sessionId: 'existing-session-abc123',
    });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: successResponse, stderr: '', code: 0 });

    await executePrompt({ member_id: member.id, prompt: 'continue the task', resume: true, timeout_s: 5, agent: 'doer' });

    const cmd = mockExecCommand.mock.calls[0][0];
    expect(cmd).toContain('@doer ');
  });

  // --- Unknown agent: error before CLI invoked ---

  it('unknown agent name: returns clear error, no CLI invoked', async () => {
    // No agent file in tmpDir -- validation must fail
    const member = makeTestLocalAgent({
      friendlyName: 'unknown-agent-test',
      workFolder: tmpDir,
      llmProvider: 'claude',
      os: 'linux',
    });
    addAgent(member);

    const result = await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5, agent: 'nonexistent' });

    expect(result).toContain('not found');
    expect(result).toContain('nonexistent');
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('unknown agent: error message names expected locations', async () => {
    const member = makeTestLocalAgent({
      friendlyName: 'unknown-locations-test',
      workFolder: tmpDir,
      llmProvider: 'claude',
      os: 'linux',
    });
    addAgent(member);

    const result = await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5, agent: 'myagent' });

    expect(result).toContain('.claude/agents/myagent.md');
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('Gemini: unknown agent name returns clear error, no CLI invoked', async () => {
    // No agent file in tmpDir -- validation must fail for Gemini provider
    const member = makeTestLocalAgent({
      friendlyName: 'gemini-unknown-agent-test',
      workFolder: tmpDir,
      llmProvider: 'gemini',
      os: 'linux',
    });
    addAgent(member);

    const result = await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5, agent: 'nonexistent' });

    expect(result).toContain('not found');
    expect(result).toContain('nonexistent');
    expect(result).toContain('.gemini/agents/nonexistent.md');
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  // --- AGY: @name prepend (same as Gemini) ---

  it('AGY: CLI invocation prepends @<name> to the prompt', async () => {
    const agentDir = path.join(tmpDir, '.gemini', 'antigravity-cli', 'agents');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'doer.md'), '# doer agent');

    const member = makeTestLocalAgent({
      friendlyName: 'agy-agent-test',
      workFolder: tmpDir,
      llmProvider: 'agy',
      os: 'linux',
    });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: successResponse, stderr: '', code: 0 });

    await executePrompt({ member_id: member.id, prompt: 'do the task', resume: false, timeout_s: 5, agent: 'doer' });

    const cmd = mockExecCommand.mock.calls[0][0];
    expect(cmd).toContain('@doer ');
  });

  it('AGY: @name prepend happens on resume=true dispatch', async () => {
    const agentDir = path.join(tmpDir, '.gemini', 'antigravity-cli', 'agents');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'doer.md'), '# doer agent');

    const member = makeTestLocalAgent({
      friendlyName: 'agy-resume-agent-test',
      workFolder: tmpDir,
      llmProvider: 'agy',
      os: 'linux',
      sessionId: 'existing-session-agy123',
    });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: successResponse, stderr: '', code: 0 });

    await executePrompt({ member_id: member.id, prompt: 'continue the task', resume: true, timeout_s: 5, agent: 'doer' });

    const cmd = mockExecCommand.mock.calls[0][0];
    expect(cmd).toContain('@doer ');
  });

  it('AGY: unknown agent name returns clear error with antigravity-cli path, no CLI invoked', async () => {
    // No agent file in tmpDir -- validation must fail for AGY provider
    const member = makeTestLocalAgent({
      friendlyName: 'agy-unknown-agent-test',
      workFolder: tmpDir,
      llmProvider: 'agy',
      os: 'linux',
    });
    addAgent(member);

    const result = await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5, agent: 'nonexistent' });

    expect(result).toContain('not found');
    expect(result).toContain('nonexistent');
    expect(result).toContain('.gemini/antigravity-cli/agents/nonexistent.md');
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  // --- Substitution-then-prepend ordering ---

  it('Gemini: substitution runs before @name prepend -- both features work together', async () => {
    const agentDir = path.join(tmpDir, '.gemini', 'agents');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'doer.md'), '# doer agent');

    const member = makeTestLocalAgent({
      friendlyName: 'gemini-sub-order',
      workFolder: tmpDir,
      llmProvider: 'gemini',
      os: 'linux',
    });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: successResponse, stderr: '', code: 0 });

    // {{branch}} must be substituted first; then @doer is prepended to the CLI instruction.
    const result = await executePrompt({
      member_id: member.id,
      prompt: 'Continue Phase 3. Branch: {{branch}}.',
      resume: false,
      timeout_s: 5,
      agent: 'doer',
      substitutions: { branch: 'feat/x' },
    });

    // No substitution error -- substitution ran before @name wrapping
    expect(result).not.toContain('substitution failed');
    expect(result).not.toContain('unresolved');

    // CLI command has @doer prepended to the instruction string
    const cmd = mockExecCommand.mock.calls[0][0];
    expect(cmd).toContain('@doer ');

    // Prompt file written with substitution applied (local agent writes directly)
    const promptPath = path.join(tmpDir, '.fleet-task.md');
    // File is deleted by the finally block after executePrompt returns,
    // so capture content via the written file before cleanup -- but since
    // deletePromptFile (local) runs in finally which completes before the
    // await resolves, we verify via the absence of the unresolved token
    // in the result and the absence of an error instead.
    expect(result).not.toContain('{{branch}}');
  });

  // --- Agent file found at user-level path ---

  it('agent found at home directory path is accepted', async () => {
    // Write agent file to user-level path: ~/.claude/agents/myagent.md
    const homeAgentDir = path.join(os.homedir(), '.claude', 'agents');
    const homeAgentFile = path.join(homeAgentDir, 'myagent.md');
    const hadFile = fs.existsSync(homeAgentFile);

    if (!hadFile) {
      fs.mkdirSync(homeAgentDir, { recursive: true });
      fs.writeFileSync(homeAgentFile, '# myagent');
    }

    try {
      const member = makeTestLocalAgent({
        friendlyName: 'home-agent-test',
        workFolder: tmpDir,  // No agent file in project dir
        llmProvider: 'claude',
        os: 'linux',
      });
      addAgent(member);
      mockExecCommand.mockResolvedValue({ stdout: successResponse, stderr: '', code: 0 });

      const result = await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5, agent: 'myagent' });

      // Should succeed (agent found at home path)
      expect(result).not.toContain('not found');
      const cmd = mockExecCommand.mock.calls[0][0];
      expect(cmd).toContain('--agent "myagent"');
    } finally {
      if (!hadFile) {
        fs.rmSync(homeAgentFile, { force: true });
      }
    }
  });
});
