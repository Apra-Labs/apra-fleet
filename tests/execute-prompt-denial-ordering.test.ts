/**
 * execute_prompt permission-denial ordering matrix and the early-return
 * bookkeeping (round-4 judge follow-ups).
 *
 * 1. A TYPED failure (max_turns, auth, server, overloaded,
 *    workspace_not_trusted) that also carries a denial keeps its own reason
 *    with the denial attached as permissionDenied -- with the strict flag on
 *    and (for auth) with it off; Claude and AGY alike.
 * 2. The permission_denied early return runs the same session-id mismatch
 *    handling and stall-detector update as the success path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { AgyProvider } from '../src/providers/agy.js';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent, getAgent } from '../src/services/registry.js';
import { isKnownSession, recordKnownSession } from '../src/services/known-sessions.js';
import { getStallDetector } from '../src/services/stall/index.js';
import { executePrompt } from '../src/tools/execute-prompt.js';
import type { SSHExecResult } from '../src/types.js';

const RESULT = fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-permission-denied', 'result.json'), 'utf-8').trim();
const SESSION = '7f3f3564-c1ab-496c-b07d-f11f463e1679';
const run = (stdout: string, stderr = '', code = 0): SSHExecResult => ({ stdout, stderr, code });
const claudeErr = (result: string, stderr: string, extra: Record<string, unknown> = {}) =>
  run(JSON.stringify({ ...JSON.parse(RESULT), is_error: true, result, ...extra }), stderr, 1);

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();
vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({ execCommand: mockExecCommand, testConnection: vi.fn(), transferFiles: vi.fn(), close: vi.fn() }),
}));
vi.mock('../src/services/agent-provisioner.js', () => ({
  provisionAgents: vi.fn().mockResolvedValue({ pushed: [] }),
  remoteAgentsDir: vi.fn().mockReturnValue('.claude/agents/pm'),
}));
vi.mock('../src/services/agy-project.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/agy-project.js')>()),
  ensureAgyProject: vi.fn(async () => ({ projectId: '1afd6dbb-498f-4918-a9d9-6da64b75a204' })),
}));

beforeEach(() => { backupAndResetRegistry(); vi.clearAllMocks(); });
afterEach(() => { restoreRegistry(); vi.restoreAllMocks(); });

const claudeMember = (name: string) => { const m = makeTestAgent({ friendlyName: name, llmProvider: 'claude' }); addAgent(m); return m; };
const agyMember = (name: string) => { const m = makeTestAgent({ friendlyName: name, llmProvider: 'agy' }); addAgent(m); return m; };

describe('Claude: a typed failure that also carries a denial keeps its own reason (flag on)', () => {
  const cases: Array<[string, string, SSHExecResult]> = [
    ['server', 'server', claudeErr('API Error: 500 internal server error', '500 internal server error')],
    ['overloaded', 'overloaded', claudeErr('API Error: 529 overloaded_error', '529 overloaded')],
    ['workspace_not_trusted', 'workspace_not_trusted', claudeErr('This workspace has not been trusted', 'this workspace has not been trusted')],
  ];
  for (const [label, reason, out] of cases) {
    it(`${label} + denial -> ${reason} with permissionDenied attached`, async () => {
      const m = claudeMember(`claude-${label}`);
      mockExecCommand.mockResolvedValue(out);
      // server / overloaded retry once after SERVER_RETRY_DELAY_MS (5s): skip the real wait.
      const retries = reason === 'server' || reason === 'overloaded';
      let r: any;
      if (retries) vi.useFakeTimers({ toFake: ['setTimeout'] });
      try {
        const pending = executePrompt({ member_id: m.id, prompt: 'do it', resume: false, timeout_s: 5, fail_on_permission_denial: true });
        if (retries) await vi.advanceTimersByTimeAsync(6000);
        r = await pending;
      } finally {
        vi.useRealTimers();
      }
      expect(r.structuredContent.isError).toBe(true);
      expect(r.structuredContent.reason).toBe(reason);
      expect(r.structuredContent.permissionDenied?.actions).toEqual(['Bash']);
    });
  }

  it('auth + denial WITHOUT the flag keeps reason auth with permissionDenied attached', async () => {
    const m = claudeMember('claude-auth-nonstrict');
    mockExecCommand.mockResolvedValue(claudeErr('Failed to authenticate. OAuth session expired.', 'Failed to authenticate: OAuth session expired'));
    const r: any = await executePrompt({ member_id: m.id, prompt: 'do it', resume: false, timeout_s: 5 });
    expect(r.structuredContent.reason).toBe('auth');
    expect(r.structuredContent.permissionDenied?.actions).toEqual(['Bash']);
  });
});

describe('AGY: a typed failure that also carries a denial keeps its own reason', () => {
  const DENIAL = {
    actions: ['command'],
    denials: [{ action: 'command', target: 'git status', suggestedGrants: ['Bash(git:*)'] }],
    suggestedGrants: ['Bash(git:*)'],
    hint: 'agy auto-denied command "git status"',
    signals: ['transcript'] as Array<'transcript'>,
  };

  it('auth + denial -> auth with permissionDenied attached', async () => {
    const m = agyMember('agy-auth');
    mockExecCommand.mockResolvedValue(run('', 'unauthenticated: please log in', 1));
    vi.spyOn(AgyProvider.prototype, 'parseResponse').mockImplementation(() => ({ result: '', sessionId: undefined, permissionDenial: DENIAL }) as any);
    const r: any = await executePrompt({ member_id: m.id, prompt: 'do it', resume: false, timeout_s: 5, fail_on_permission_denial: true });
    expect(r.structuredContent.reason).toBe('auth');
    expect(r.structuredContent.permissionDenied?.actions).toEqual(['command']);
  });

  it('max_turns + denial -> max_turns_exhausted with permissionDenied attached', async () => {
    const m = agyMember('agy-maxturns');
    mockExecCommand.mockResolvedValue(run('x', 'Reached max turns', 1));
    vi.spyOn(AgyProvider.prototype, 'parseResponse').mockImplementation(() => ({ result: 'partial', sessionId: undefined, terminalReason: 'max_turns', permissionDenial: DENIAL }) as any);
    const r: any = await executePrompt({ member_id: m.id, prompt: 'do it', resume: false, timeout_s: 5 });
    expect(r.structuredContent.reason).toBe('max_turns_exhausted');
    expect(r.structuredContent.permissionDenied?.actions).toEqual(['command']);
  });
});

describe('permission_denied early return: session-id mismatch and stall detector', () => {
  it('a returned session id that differs from the minted one is not persisted, but is recorded as known and reaches the stall detector (as on the success path)', async () => {
    const m = claudeMember('claude-denied-mismatch');
    const updateSpy = vi.spyOn(getStallDetector(), 'update');
    mockExecCommand.mockImplementation(async (cmd: string) => (/--session-id/.test(cmd) ? run(RESULT) : run('')));
    const r: any = await executePrompt({ member_id: m.id, prompt: 'review', resume: false, timeout_s: 5, fail_on_permission_denial: true });
    expect(r.structuredContent.reason).toBe('permission_denied');
    // The CLI returned SESSION, not the minted id: the mismatch is not persisted as the member's session ...
    expect(getAgent(m.id)!.sessionId).not.toBe(SESSION);
    // ... but the landed session is known/resumable and the stall detector was told about it.
    expect(isKnownSession(m.id, SESSION)).toBe(true);
    expect(updateSpy.mock.calls.some(([id, partial]) => id === m.id && (partial as any).sessionId === SESSION)).toBe(true);
  });

  it('an explicit resume answered by a different session is the terminal session_not_found, with the denial attached', async () => {
    const m = claudeMember('claude-denied-terminal');
    const REQUESTED = '11111111-2222-4333-8444-555555555555';
    recordKnownSession(m.id, REQUESTED);
    mockExecCommand.mockResolvedValue(run(RESULT));
    const r: any = await executePrompt({ member_id: m.id, prompt: 'review', resume: REQUESTED, timeout_s: 5, fail_on_permission_denial: true });
    expect(r.structuredContent.reason).toBe('session_not_found');
    expect(r.structuredContent.sessionId).toBe(REQUESTED);
    expect(r.structuredContent.returnedSessionId).toBe(SESSION);
    expect(r.structuredContent.permissionDenied?.actions).toEqual(['Bash']);
  });

  it('a matching session id is persisted and the stall detector receives it', async () => {
    const m = claudeMember('claude-denied-match');
    const updateSpy = vi.spyOn(getStallDetector(), 'update');
    let minted = '';
    mockExecCommand.mockImplementation(async (cmd: string) => {
      const mm = cmd.match(/--session-id "?([0-9a-f-]{36})"?/);
      if (!mm) return run('');
      minted = mm[1];
      return run(RESULT.replaceAll(SESSION, minted));
    });
    const r: any = await executePrompt({ member_id: m.id, prompt: 'review', resume: false, timeout_s: 5, fail_on_permission_denial: true });
    expect(r.structuredContent.reason).toBe('permission_denied');
    expect(getAgent(m.id)!.sessionId).toBe(minted);
    expect(updateSpy.mock.calls.filter(([id, partial]) => id === m.id && (partial as any).sessionId === minted).length).toBeGreaterThanOrEqual(2);
  });
});
