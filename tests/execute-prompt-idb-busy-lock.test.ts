import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, makeTestLocalAgent, backupAndResetRegistry, restoreRegistry, resultText } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { executePrompt, inFlightAgents } from '../src/tools/execute-prompt.js';
import { setStoredPid, clearStoredPid } from '../src/utils/agent-helpers.js';
import { writeStatusline } from '../src/services/statusline.js';
import { sessionRegistry } from '../src/services/session-registry.js';
import { localWorkspaceId } from '../src/services/token-issuer.js';
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

vi.mock('../src/services/agent-provisioner.js', () => ({
  provisionAgents: vi.fn().mockResolvedValue({ pushed: [] }),
  remoteAgentsDir: vi.fn().mockReturnValue('.claude/agents/pm'),
}));

/**
 * apra-fleet-idb / apra-fleet-iuc.5: Regression test for orphaned busy-locks.
 *
 * An inFlightAgents entry can outlive its process (child reaped without
 * cleanup, or client disconnect). On a busy rejection, execute_prompt now
 * verifies the locked session's backing process is still alive before
 * honoring it -- a confirmed-dead pid releases the stale lock (self-heal)
 * instead of wedging the member forever; a confirmed-alive pid still returns
 * 'busy'.
 *
 * Both cases are pinned deterministically here with no real CLI (all mocked).
 */
describe('orphaned busy-lock regression (apra-fleet-idb / apra-fleet-iuc.5)', () => {
  let memberId: string;
  const workspaceId = localWorkspaceId();

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    restoreRegistry();
    vi.useRealTimers();
    if (memberId) {
      inFlightAgents.delete(memberId);
      clearStoredPid(memberId);
      sessionRegistry.unregister(workspaceId, memberId);
    }
  });

  describe('Case 1: Orphaned lock self-heals (remote subprocess dead)', () => {
    it('releases stale lock on inFlightAgents when remote subprocess pid is confirmed dead', async () => {
      const member = makeTestAgent({ friendlyName: 'orphaned-remote-dead' });
      memberId = member.id;
      addAgent(member);

      // Simulate an orphaned lock: entry in inFlightAgents but the backing
      // process is dead on the remote machine
      inFlightAgents.add(memberId);
      setStoredPid(memberId, 54321);

      mockExecCommand.mockImplementation(async (cmd: string) => {
        // The liveness probe (kill -0) confirms the pid is DEAD
        if (cmd.includes('kill -0')) {
          return { stdout: 'DEAD\n', stderr: '', code: 0 };
        }
        // The dispatch itself should proceed after self-heal
        return {
          stdout: JSON.stringify({ result: 'self-healed', session_id: 'sess-healed-remote' }),
          stderr: '',
          code: 0,
        };
      });

      const result = await executePrompt({ member_id: memberId, prompt: 'test prompt', resume: false, timeout_s: 5 });

      // Must not return 'busy' -- the orphaned lock was detected and healed
      expect(resultText(result)).not.toContain('already running');
      expect(resultText(result)).toContain('self-healed');

      // The lock must have been released
      expect(inFlightAgents.has(memberId)).toBe(false);

      // The dispatch genuinely proceeded (not just the busy-check probe):
      // writePromptFile + liveness probe + main dispatch + deletePromptFile
      expect(mockExecCommand).toHaveBeenCalled();
      expect(vi.mocked(writeStatusline).mock.calls.some(
        c => c[0] instanceof Map && c[0].get(memberId) === 'idle'
      )).toBe(true);
    });

    it('releases stale lock when local subprocess pid is confirmed dead (no SSH probe needed)', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-idb-local-dead-'));
      try {
        const member = makeTestLocalAgent({ friendlyName: 'orphaned-local-dead', workFolder: tmpDir, os: 'linux' });
        memberId = member.id;
        addAgent(member);

        inFlightAgents.add(memberId);
        // An obviously-nonexistent pid -- process.kill(pid, 0) reads ESRCH
        setStoredPid(memberId, 999_999);

        mockExecCommand.mockResolvedValue({
          stdout: JSON.stringify({ result: 'self-healed-local', session_id: 'sess-healed-local' }),
          stderr: '',
          code: 0,
        });

        const result = await executePrompt({ member_id: memberId, prompt: 'test', resume: false, timeout_s: 5 });

        expect(resultText(result)).not.toContain('already running');
        expect(resultText(result)).toContain('self-healed-local');
        expect(inFlightAgents.has(memberId)).toBe(false);
        expect(mockExecCommand).toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('releases stale lock for interactive session with confirmed-dead launch pid', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-idb-interactive-dead-'));
      try {
        const member = makeTestLocalAgent({ friendlyName: 'orphaned-interactive-dead', workFolder: tmpDir, os: 'linux' });
        memberId = member.id;
        addAgent(member);

        inFlightAgents.add(memberId);
        // Register an interactive session with a dead launch pid
        sessionRegistry.register({
          member_id: memberId,
          workspace_id: workspaceId,
          role: 'doer',
          work_folder: tmpDir,
          server: null,
          pid: 999_998, // Obviously-dead pid
          status: 'busy',
        });

        mockExecCommand.mockResolvedValue({
          stdout: JSON.stringify({ result: 'self-healed-interactive', session_id: 'sess-healed-interactive' }),
          stderr: '',
          code: 0,
        });

        const result = await executePrompt({ member_id: memberId, prompt: 'test', resume: false, timeout_s: 5 });

        expect(resultText(result)).not.toContain('already running');
        expect(resultText(result)).toContain('self-healed-interactive');
        expect(inFlightAgents.has(memberId)).toBe(false);
        expect(mockExecCommand).toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('Case 2: Genuinely-busy member still rejects (confirmed alive)', () => {
    it('rejects with reason "busy" when remote subprocess pid is confirmed ALIVE', async () => {
      const member = makeTestAgent({ friendlyName: 'genuinely-busy-remote' });
      memberId = member.id;
      addAgent(member);

      // Simulate genuinely-busy: inFlightAgents entry with a LIVE backing process
      inFlightAgents.add(memberId);
      setStoredPid(memberId, 54322);

      mockExecCommand.mockImplementation(async (cmd: string) => {
        // The liveness probe (kill -0) confirms the pid is ALIVE
        if (cmd.includes('kill -0')) {
          return { stdout: 'ALIVE\n', stderr: '', code: 0 };
        }
        // Should never reach here (no dispatch attempt on genuinely-busy)
        return {
          stdout: JSON.stringify({ result: 'should-not-run', session_id: 'sess-x' }),
          stderr: '',
          code: 0,
        };
      });

      const result = await executePrompt({ member_id: memberId, prompt: 'second dispatch', resume: false, timeout_s: 5 });

      // Must return 'busy' error
      expect(resultText(result)).toContain('already running');
      if (typeof result !== 'string' && result.structuredContent) {
        expect(result.structuredContent.reason).toBe('busy');
      }

      // Only the liveness probe ran -- no dispatch attempt
      expect(mockExecCommand).toHaveBeenCalledTimes(1);
      expect(mockExecCommand.mock.calls[0][0]).toContain('kill -0');

      // The ORIGINAL lock must still be held (not healed)
      expect(inFlightAgents.has(memberId)).toBe(true);
    });

    it('rejects with reason "busy" when no pid is captured at all (conservative default)', async () => {
      const member = makeTestAgent({ friendlyName: 'no-pid-busy' });
      memberId = member.id;
      addAgent(member);

      // Simulate conservative no-pid case: inFlightAgents entry but no stored pid
      // This means the dispatch hasn't yet reached its pid-capture step.
      inFlightAgents.add(memberId);
      // No setStoredPid call -- no pid at all

      mockExecCommand.mockResolvedValue({
        stdout: JSON.stringify({ result: 'should-not-run', session_id: 'sess-x' }),
        stderr: '',
        code: 0,
      });

      const result = await executePrompt({ member_id: memberId, prompt: 'dispatch', resume: false, timeout_s: 5 });

      // Must return 'busy' (conservative: no pid = still busy)
      expect(resultText(result)).toContain('already running');
      if (typeof result !== 'string' && result.structuredContent) {
        expect(result.structuredContent.reason).toBe('busy');
      }

      // No execCommand was called at all (no liveness probe, no dispatch)
      expect(mockExecCommand).not.toHaveBeenCalled();

      // The lock stays intact
      expect(inFlightAgents.has(memberId)).toBe(true);
    });
  });

  describe('Edge case: fleet_status and dispatch gate agreement (apra-fleet-iub acceptance criterion)', () => {
    it('agrees that a member with orphaned lock should report idle (fleet_status) and dispatch successfully (dispatch gate)', async () => {
      const member = makeTestAgent({ friendlyName: 'agreement-orphaned' });
      memberId = member.id;
      addAgent(member);

      inFlightAgents.add(memberId);
      setStoredPid(memberId, 54323);

      mockExecCommand.mockImplementation(async (cmd: string) => {
        if (cmd.includes('kill -0')) {
          return { stdout: 'DEAD\n', stderr: '', code: 0 };
        }
        return {
          stdout: JSON.stringify({ result: 'ok', session_id: 'sess-ok' }),
          stderr: '',
          code: 0,
        };
      });

      const result = await executePrompt({ member_id: memberId, prompt: 'hi', resume: false, timeout_s: 5 });

      // Dispatch gate allows it through (orphaned lock healed)
      expect(resultText(result)).toContain('ok');
      expect(inFlightAgents.has(memberId)).toBe(false);

      // Implicit agreement: writeStatusline was called with 'idle'
      expect(vi.mocked(writeStatusline).mock.calls.some(
        c => c[0] instanceof Map && c[0].get(memberId) === 'idle'
      )).toBe(true);
    });

    it('agrees that a genuinely-busy member should report busy on both gate paths', async () => {
      const member = makeTestAgent({ friendlyName: 'agreement-busy' });
      memberId = member.id;
      addAgent(member);

      inFlightAgents.add(memberId);
      setStoredPid(memberId, 54324);

      mockExecCommand.mockImplementation(async (cmd: string) => {
        if (cmd.includes('kill -0')) {
          return { stdout: 'ALIVE\n', stderr: '', code: 0 };
        }
        return { stdout: JSON.stringify({ result: 'should-not-run' }), stderr: '', code: 0 };
      });

      const result = await executePrompt({ member_id: memberId, prompt: 'dispatch', resume: false, timeout_s: 5 });

      // Dispatch gate rejects with 'busy'
      expect(resultText(result)).toContain('already running');
      if (typeof result !== 'string' && result.structuredContent) {
        expect(result.structuredContent.reason).toBe('busy');
      }

      // Lock stays held (consistency with the busy rejection)
      expect(inFlightAgents.has(memberId)).toBe(true);
    });
  });
});
