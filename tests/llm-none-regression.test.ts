import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, makeTestLocalAgent, backupAndResetRegistry, restoreRegistry, resultText } from './test-helpers.js';
import { addAgent, getAgent, getAllAgents } from '../src/services/registry.js';
import { registerMember } from '../src/tools/register-member.js';
import { updateMember } from '../src/tools/update-member.js';
import { memberDetail } from '../src/tools/member-detail.js';
import { executeCommand } from '../src/tools/execute-command.js';
import { executePrompt } from '../src/tools/execute-prompt.js';
import { stopPrompt } from '../src/tools/stop-prompt.js';
import { provisionAuth } from '../src/tools/provision-auth.js';
import { updateAgentCli } from '../src/tools/update-agent-cli.js';
import type { SSHExecResult } from '../src/types.js';

// Mock the strategy module to handle SSH commands
const mockExecCommand = vi.fn<(cmd: string, timeout?: number, maxTotalMs?: number) => Promise<SSHExecResult>>();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: vi.fn().mockResolvedValue({ ok: true }),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
  readMemberStatus: vi.fn(() => 'idle'),
}));

// Mock agent provisioning
vi.mock('../src/services/agent-provisioner.js', () => ({
  provisionAgents: vi.fn().mockResolvedValue({ pushed: [] }),
  remoteAgentsDir: vi.fn().mockReturnValue(null),
}));

// Mock workspace trust
vi.mock('../src/utils/workspace-trust.js', () => ({
  seedWorkspaceTrust: vi.fn().mockResolvedValue(undefined),
}));

describe('llm_provider: "none" regression tests (apra-fleet-0s6)', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreRegistry();
  });

  describe('update_member accepts "none" and round-trips through member_detail', () => {
    it('updates member to llm_provider: "none" via update_member (Part A entry point)', async () => {
      // Register a member with a real LLM provider first
      const member = makeTestAgent({
        friendlyName: 'test-member',
        llmProvider: 'claude',
      });
      addAgent(member);

      // Update to 'none'
      const updateResult = await updateMember({
        member_id: member.id,
        llm_provider: 'none',
      });

      // Verify success
      expect(resultText(updateResult)).toContain('updated');

      // Verify member_detail reflects the change
      const detailResult = await memberDetail({
        member_id: member.id,
      });

      const updatedMember = getAgent(member.id);
      expect(updatedMember?.llmProvider).toBe('none');
      expect(resultText(detailResult)).toContain('none');
    });

    it('registers member with llm_provider: "none" (Part A entry point)', async () => {
      // Register directly with 'none' provider
      mockExecCommand.mockResolvedValue({
        code: 0,
        stdout: '',
        stderr: ''
      });

      const result = await registerMember({
        friendly_name: 'none-member',
        work_folder: '/tmp/work',
        member_type: 'local',
        llm_provider: 'none',
      });

      expect(resultText(result)).toContain('success');

      // Find the registered member and verify provider
      const agents = getAllAgents();
      const agent = agents.find((a: any) => a.friendlyName === 'none-member');
      expect(agent?.llmProvider).toBe('none');
    });
  });

  describe('execute_prompt rejects llm:none cleanly', () => {
    it('rejects execute_prompt for llm:none member with clean message', async () => {
      const member = makeTestAgent({ llmProvider: 'none' });
      addAgent(member);

      const result = await executePrompt({
        member_id: member.id,
        prompt: 'hello',
        resume: false,
        timeout_s: 5,
      });

      const text = resultText(result);
      expect(text).toContain('[FAIL]');
      expect(text).toContain('no LLM provider');
      expect(text).toContain('plain command executor');
      expect(text).toContain('execute_command');
      // No exception/stack trace
      expect(text).not.toMatch(/NoneProvider|TypeError|Error:/);
    });
  });

  describe('stop_prompt rejects llm:none cleanly for both entry points', () => {
    it('rejects stop_prompt for member registered with llm:none', async () => {
      const member = makeTestAgent({ llmProvider: 'none' });
      addAgent(member);

      const result = await stopPrompt({
        member_id: member.id,
      });

      expect(resultText(result)).toContain('[FAIL]');
      expect(resultText(result)).toContain('no LLM provider');
      expect(resultText(result)).toContain('plain command executor');
      expect(resultText(result)).toContain('execute_command');
    });

    it('rejects stop_prompt for member updated to llm:none', async () => {
      // Start with a real provider
      const member = makeTestAgent({ llmProvider: 'claude' });
      addAgent(member);

      // Update to 'none'
      await updateMember({
        member_id: member.id,
        llm_provider: 'none',
      });

      // Now stop_prompt should reject cleanly
      const result = await stopPrompt({
        member_id: member.id,
      });

      expect(resultText(result)).toContain('[FAIL]');
      expect(resultText(result)).toContain('no LLM provider');
      expect(resultText(result)).toContain('plain command executor');
      expect(resultText(result)).toContain('execute_command');
    });
  });

  describe('provision_llm_auth rejects llm:none cleanly for both entry points', () => {
    it('rejects provision_llm_auth for member registered with llm:none', async () => {
      const member = makeTestAgent({ llmProvider: 'none' });
      addAgent(member);

      const result = await provisionAuth({
        member_id: member.id,
      });

      expect(resultText(result)).toContain('[FAIL]');
      expect(resultText(result)).toContain('no LLM provider');
      expect(resultText(result)).toContain('plain command executor');
      expect(resultText(result)).toContain('execute_command');
    });

    it('rejects provision_llm_auth for member updated to llm:none', async () => {
      // Start with a real provider
      const member = makeTestAgent({ llmProvider: 'claude' });
      addAgent(member);

      // Update to 'none'
      await updateMember({
        member_id: member.id,
        llm_provider: 'none',
      });

      // Now provision_llm_auth should reject cleanly
      const result = await provisionAuth({
        member_id: member.id,
      });

      expect(resultText(result)).toContain('[FAIL]');
      expect(resultText(result)).toContain('no LLM provider');
      expect(resultText(result)).toContain('plain command executor');
      expect(resultText(result)).toContain('execute_command');
    });
  });

  describe('update_llm_cli rejects llm:none cleanly for both entry points', () => {
    it('rejects update_llm_cli for member registered with llm:none', async () => {
      const member = makeTestAgent({ llmProvider: 'none' });
      addAgent(member);

      const result = await updateAgentCli({
        member_id: member.id,
      });

      expect(resultText(result)).toContain('no LLM provider');
      expect(resultText(result)).toContain('plain command executor');
      expect(resultText(result)).toContain('execute_command');
      // No exception/stack trace
      expect(resultText(result)).not.toMatch(/NoneProvider|TypeError|Error:/);
    });

    it('rejects update_llm_cli for member updated to llm:none', async () => {
      // Start with a real provider
      const member = makeTestAgent({ llmProvider: 'claude' });
      addAgent(member);

      // Update to 'none'
      await updateMember({
        member_id: member.id,
        llm_provider: 'none',
      });

      // Now update_llm_cli should reject cleanly
      const result = await updateAgentCli({
        member_id: member.id,
      });

      expect(resultText(result)).toContain('no LLM provider');
      expect(resultText(result)).toContain('plain command executor');
      expect(resultText(result)).toContain('execute_command');
    });
  });

  describe('execute_command remains usable for llm:none member', () => {
    it('executes command successfully on llm:none member', async () => {
      const member = makeTestAgent({ llmProvider: 'none' });
      addAgent(member);

      // Mock a successful command execution
      mockExecCommand.mockResolvedValue({
        code: 0,
        stdout: 'hello from command',
        stderr: '',
      });

      const result = await executeCommand({
        member_id: member.id,
        command: 'echo "hello from command"',
        timeout_s: 5,
      });

      expect(resultText(result)).toContain('hello from command');
      expect(mockExecCommand).toHaveBeenCalled();
    });

    it('executes command successfully on member updated to llm:none', async () => {
      // Start with a real provider
      const member = makeTestAgent({ llmProvider: 'claude' });
      addAgent(member);

      // Update to 'none'
      await updateMember({
        member_id: member.id,
        llm_provider: 'none',
      });

      // Mock a successful command execution
      mockExecCommand.mockResolvedValue({
        code: 0,
        stdout: 'hello from command',
        stderr: '',
      });

      const result = await executeCommand({
        member_id: member.id,
        command: 'echo "hello from command"',
        timeout_s: 5,
      });

      expect(resultText(result)).toContain('hello from command');
    });
  });

  describe('test rejection messages match execute-prompt shape', () => {
    it('stop_prompt rejection matches execute-prompt format', async () => {
      const member = makeTestAgent({ llmProvider: 'none' });
      addAgent(member);

      const promptResult = await executePrompt({
        member_id: member.id,
        prompt: 'test',
        resume: false,
        timeout_s: 5,
      });

      const stopResult = await stopPrompt({
        member_id: member.id,
      });

      const promptText = resultText(promptResult);
      const stopText = resultText(stopResult);

      // Both should have the same core message structure
      expect(promptText).toContain('[FAIL]');
      expect(stopText).toContain('[FAIL]');
      expect(promptText).toContain('no LLM provider');
      expect(stopText).toContain('no LLM provider');
      expect(promptText).toContain('plain command executor');
      expect(stopText).toContain('plain command executor');
    });

    it('provision_llm_auth rejection matches execute-prompt format', async () => {
      const member = makeTestAgent({ llmProvider: 'none' });
      addAgent(member);

      const promptResult = await executePrompt({
        member_id: member.id,
        prompt: 'test',
        resume: false,
        timeout_s: 5,
      });

      const provisionResult = await provisionAuth({
        member_id: member.id,
      });

      const promptText = resultText(promptResult);
      const provisionText = resultText(provisionResult);

      // Both should have the same core message structure
      expect(promptText).toContain('[FAIL]');
      expect(provisionText).toContain('[FAIL]');
      expect(promptText).toContain('no LLM provider');
      expect(provisionText).toContain('no LLM provider');
    });
  });

  describe('no busy-state side-effect on rejection', () => {
    it('execute_prompt rejects without entering busy state', async () => {
      const member = makeTestAgent({ llmProvider: 'none' });
      addAgent(member);

      const { inFlightAgents } = await import('../src/tools/execute-prompt.js');
      expect(inFlightAgents.has(member.id)).toBe(false);

      await executePrompt({
        member_id: member.id,
        prompt: 'test',
        resume: false,
        timeout_s: 5,
      });

      // Should not enter busy state
      expect(inFlightAgents.has(member.id)).toBe(false);
    });

    it('stop_prompt rejects without entering busy state', async () => {
      const member = makeTestAgent({ llmProvider: 'none' });
      addAgent(member);

      const { inFlightAgents } = await import('../src/tools/execute-prompt.js');

      await stopPrompt({
        member_id: member.id,
      });

      // Should not enter busy state
      expect(inFlightAgents.has(member.id)).toBe(false);
    });
  });
});
