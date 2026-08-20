/**
 * apra-fleet-iuc.3: dead-session detection contract.
 *
 * apra-fleet-ekm's forensics showed a session that hit max_turns, died, and
 * was never classified -- it burned 38.5 min to a hard timeout + cold
 * restart. Two independent, defense-in-depth fixes close that hole:
 *   - apra-fleet-iuc.1 (src/providers/claude.ts / provider.ts): a
 *     max_turns-terminated CLI transcript must ALWAYS classify as
 *     max_turns_exhausted, on ANY of the CLI's inconsistent signal channels
 *     -- including a standalone `type: "max_turns_reached"` transcript
 *     event with no accompanying `subtype`/`terminal_reason` at all.
 *   - apra-fleet-iuc.2 (src/services/stall/*): even if a terminal signal is
 *     missed again, a session whose transcript file has genuinely stopped
 *     advancing -- corroborated by the file's own OS mtime, not just content
 *     parsing -- must still be caught and terminated within the configured
 *     stall window, without false-killing a session that is still actively
 *     writing (e.g. a long, content-scan-invisible tool call).
 *
 * This file pins both contract cases end-to-end with fully simulated,
 * deterministic transcripts -- no real CLI invocation, no credentials. It
 * fails against the codebase before apra-fleet-iuc.1/iuc.2 and passes after.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import type { Agent, SSHExecResult } from '../src/types.js';

const mockExecCommand = vi.fn<(cmd: string, timeout?: number, maxTotalMs?: number) => Promise<SSHExecResult>>();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: vi.fn(),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
  readMemberStatus: vi.fn(() => 'idle'),
}));

// Mirrors execute-prompt.test.ts: agent-file provisioning is covered by its
// own suite and would otherwise consume the mockExecCommand queue here.
vi.mock('../src/services/agent-provisioner.js', () => ({
  provisionAgents: vi.fn().mockResolvedValue({ pushed: [] }),
  remoteAgentsDir: vi.fn().mockReturnValue('.claude/agents/pm'),
}));

import { executePrompt, provisionedRemoteAgents } from '../src/tools/execute-prompt.js';
import { StallDetector, type StallEntry } from '../src/services/stall/stall-detector.js';

describe('dead-session detection contract (apra-fleet-iuc.3)', () => {
  describe('a simulated max_turns_reached transcript signal surfaces max_turns_exhausted promptly', () => {
    beforeEach(() => {
      backupAndResetRegistry();
      mockExecCommand.mockReset();
      vi.useFakeTimers();
      provisionedRemoteAgents.clear();
    });

    afterEach(() => {
      restoreRegistry();
      vi.useRealTimers();
    });

    it('classifies a truncated stream ending in a standalone max_turns_reached event -- no result event, no subtype, no terminal_reason -- as max_turns_exhausted on the first attempt', async () => {
      const member = makeTestAgent({ friendlyName: 'dead-session-truncated-stream' });
      addAgent(member);

      mockExecCommand
        .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 }) // writePromptFile
        .mockResolvedValueOnce({
          // A hard-timeout kill truncates the stream before any `type:result`
          // event lands -- the standalone max_turns_reached event is the ONLY
          // signal this transcript ever carries.
          stdout: [
            JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-truncated' }),
            JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working on it...' }] } }),
            JSON.stringify({ type: 'max_turns_reached' }),
          ].join('\n'),
          stderr: '',
          code: 1,
        })
        .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 }); // deletePromptFile

      const result = await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });

      expect(result.structuredContent).toMatchObject({ isError: true, reason: 'max_turns_exhausted' });
      // Promptly: classified from the single dispatch attempt, no retry loop.
      expect(mockExecCommand).toHaveBeenCalledTimes(3);
    });

    it('carries the standalone max_turns_reached signal forward across a later, otherwise-unmarked result event', async () => {
      const member = makeTestAgent({ friendlyName: 'dead-session-signal-carried-forward' });
      addAgent(member);

      mockExecCommand
        .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 }) // writePromptFile
        .mockResolvedValueOnce({
          stdout: [
            JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-carried' }),
            JSON.stringify({ type: 'max_turns_reached' }),
            // The terminating result event itself carries NEITHER subtype nor
            // terminal_reason -- only the earlier standalone event signaled it.
            JSON.stringify({ type: 'result', result: 'stopped', session_id: 'sess-carried' }),
          ].join('\n'),
          stderr: '',
          code: 1,
        })
        .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 }); // deletePromptFile

      const result = await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });

      expect(result.structuredContent).toMatchObject({ isError: true, reason: 'max_turns_exhausted' });
      expect(mockExecCommand).toHaveBeenCalledTimes(3);
    });
  });

  describe('a simulated mtime-frozen transcript triggers the inactivity termination', () => {
    let member: Agent;
    let detector: StallDetector;

    beforeEach(() => {
      backupAndResetRegistry();
      mockExecCommand.mockReset();
      vi.useFakeTimers();
      delete process.env['STALL_THRESHOLD_MS'];
      delete process.env['STALL_POLL_INTERVAL_MS'];
      member = makeTestAgent({ friendlyName: 'stall-contract-member', os: 'linux' });
      addAgent(member);
      detector = new StallDetector();
    });

    afterEach(() => {
      detector.stop();
      restoreRegistry();
      vi.useRealTimers();
      delete process.env['STALL_THRESHOLD_MS'];
      delete process.env['STALL_POLL_INTERVAL_MS'];
    });

    function makeStallEntry(overrides: Partial<StallEntry> = {}): StallEntry {
      return {
        sessionId: 'sess-frozen',
        logFilePath: '/home/user/.claude/projects/proj/sess-frozen.jsonl',
        lastActivityAt: Date.now(),
        consecutiveIdleCycles: 0,
        consecutiveReadFailures: 0,
        memberId: member.id,
        memberName: member.friendlyName,
        provisional: false,
        stallReported: false,
        ...overrides,
      };
    }

    it('a transcript whose content AND OS mtime are both genuinely frozen is terminated within the configured window', async () => {
      const baseTime = Date.now();
      // Both signals point at a moment strictly before the entry's baseline
      // activity time -- the transcript stopped advancing before we ever
      // started watching it.
      const staleContentTs = new Date(baseTime - 5000).toISOString();
      const staleMtimeSeconds = Math.floor((baseTime - 5000) / 1000);

      mockExecCommand.mockImplementation(async (cmd: string) => {
        if (cmd.includes('stat -c')) {
          return { stdout: `${staleMtimeSeconds}\n`, stderr: '', code: 0 };
        }
        return { stdout: JSON.stringify({ type: 'assistant', timestamp: staleContentTs }), stderr: '', code: 0 };
      });

      const onStall = vi.fn();
      detector.add(member.id, makeStallEntry({ lastActivityAt: baseTime, onStall }));

      // Jump past the default 150s stall threshold with the transcript
      // (content and mtime alike) still pinned at its stale values.
      vi.setSystemTime(baseTime + 160_000);
      await detector._poll();

      expect(onStall).toHaveBeenCalledTimes(1);
      expect(detector.getEntry(member.id)?.stallReported).toBe(true);
      // Proves this exercised the OS-mtime channel added by apra-fleet-iuc.2
      // (fetchMtimeMs's `stat -c %Y` call), not just the pre-existing
      // content-timestamp path.
      expect(mockExecCommand.mock.calls.some(([cmd]) => cmd.includes('stat -c'))).toBe(true);
    });

    it('a fresher OS mtime prevents a false stall even though content-timestamp parsing alone looks frozen (long silent tool call)', async () => {
      const baseTime = Date.now();
      const staleContentTs = new Date(baseTime - 5000).toISOString();

      mockExecCommand.mockImplementation(async (cmd: string) => {
        if (cmd.includes('stat -c')) {
          // The transcript file is still being actively rewritten by a long
          // silent tool call every poll, even though the content scan's
          // recognized timestamp field never advances.
          return { stdout: `${Math.floor(Date.now() / 1000)}\n`, stderr: '', code: 0 };
        }
        return { stdout: JSON.stringify({ type: 'assistant', timestamp: staleContentTs }), stderr: '', code: 0 };
      });

      const onStall = vi.fn();
      detector.add(member.id, makeStallEntry({ lastActivityAt: baseTime, onStall }));

      // Same elapsed time as the positive case above -- content parsing
      // alone would have crossed the threshold and false-killed this member.
      vi.setSystemTime(baseTime + 160_000);
      await detector._poll();

      expect(onStall).not.toHaveBeenCalled();
      expect(detector.getEntry(member.id)?.stallReported).toBe(false);
    });
  });
});
