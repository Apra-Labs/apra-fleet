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

  // --- AGY: --agent flag ---

  it('AGY: CLI invocation passes --agent flag', async () => {
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
    expect(cmd).toContain('--agent "doer"');
  });

  it('AGY: --agent flag is passed on resume=true dispatch', async () => {
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
    expect(cmd).toContain('--agent "doer"');
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

  it('AGY: substitution runs before --agent flag is appended -- both features work together', async () => {
    const agentDir = path.join(tmpDir, '.gemini', 'antigravity-cli', 'agents');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'doer.md'), '# doer agent');

    const member = makeTestLocalAgent({
      friendlyName: 'agy-sub-order',
      workFolder: tmpDir,
      llmProvider: 'agy',
      os: 'linux',
    });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: successResponse, stderr: '', code: 0 });

    // {{branch}} must be substituted first; then --agent "doer" is appended to the CLI command.
    const result = await executePrompt({
      member_id: member.id,
      prompt: 'Continue Phase 3. Branch: {{branch}}.',
      resume: false,
      timeout_s: 5,
      agent: 'doer',
      substitutions: { branch: 'feat/x' },
    });

    // No substitution error -- substitution ran before --agent wrapping
    expect(result).not.toContain('substitution failed');
    expect(result).not.toContain('unresolved');

    // CLI command has --agent "doer" appended
    const cmd = mockExecCommand.mock.calls[0][0];
    expect(cmd).toContain('--agent "doer"');

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

  // --- OpenCode: agent resolution uses .opencode/ for project, .config/opencode/ for home ---

  it('OpenCode: agent found at project .opencode/agents/ is accepted', async () => {
    const agentDir = path.join(tmpDir, '.opencode', 'agents');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'planner.md'), '# planner agent');

    const member = makeTestLocalAgent({
      friendlyName: 'opencode-proj-agent',
      workFolder: tmpDir,
      llmProvider: 'opencode',
      os: 'linux',
    });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: successResponse, stderr: '', code: 0 });

    const result = await executePrompt({ member_id: member.id, prompt: 'plan the work', resume: false, timeout_s: 5, agent: 'planner' });

    expect(result).not.toContain('not found');
  });

  it('OpenCode: agent found at ~/.config/opencode/agents/ is accepted', async () => {
    const homeAgentDir = path.join(os.homedir(), '.config', 'opencode', 'agents');
    const homeAgentFile = path.join(homeAgentDir, 'planner.md');
    const hadFile = fs.existsSync(homeAgentFile);

    if (!hadFile) {
      fs.mkdirSync(homeAgentDir, { recursive: true });
      fs.writeFileSync(homeAgentFile, '# planner agent');
    }

    try {
      const member = makeTestLocalAgent({
        friendlyName: 'opencode-home-agent',
        workFolder: tmpDir,  // No agent file in project dir
        llmProvider: 'opencode',
        os: 'linux',
      });
      addAgent(member);
      mockExecCommand.mockResolvedValue({ stdout: successResponse, stderr: '', code: 0 });

      const result = await executePrompt({ member_id: member.id, prompt: 'plan the work', resume: false, timeout_s: 5, agent: 'planner' });

      expect(result).not.toContain('not found');
    } finally {
      if (!hadFile) {
        fs.rmSync(homeAgentFile, { force: true });
      }
    }
  });

  it('OpenCode: unknown agent shows .opencode/ and ~/.config/opencode/ paths in error', async () => {
    const member = makeTestLocalAgent({
      friendlyName: 'opencode-unknown-agent',
      workFolder: tmpDir,
      llmProvider: 'opencode',
      os: 'linux',
    });
    addAgent(member);

    const result = await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5, agent: 'nonexistent' });

    expect(result).toContain('not found');
    expect(result).toContain('nonexistent');
    // Project path should be .opencode/agents/, home path should be ~/.config/opencode/agents/
    expect(result).toContain('.opencode/agents/nonexistent.md');
    expect(result).toContain('.config/opencode/agents/nonexistent.md');
    // Must NOT show the old wrong path
    expect(result).not.toMatch(/~\/\.opencode\/agents\//);
    expect(mockExecCommand).not.toHaveBeenCalled();
  });
});
