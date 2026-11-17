/**
 * Surface-integration tests for execute_prompt's `fork` field (apra-fleet-lmtg.4):
 * schema acceptance plus the fork/resume and fork/session_id mutual-exclusivity
 * guard. Fork MODE RESOLUTION (actually minting/wiring a forked session) is a
 * separate task -- these tests only cover the schema shape and the early
 * validation guard, which must reject before any exec call is made.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry, resultText } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { executePrompt, executePromptSchema, inFlightAgents } from '../src/tools/execute-prompt.js';
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

const successResponse = JSON.stringify({ result: 'done', session_id: 'sess-x' });

function setupExec(): void {
  mockExecCommand.mockResolvedValue({ stdout: successResponse, stderr: '', code: 0 });
}

describe('execute_prompt -- fork schema + mutual-exclusivity guard', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    restoreRegistry();
    vi.useRealTimers();
    inFlightAgents.clear();
  });

  it('schema accepts fork as a boolean', () => {
    const parsed = executePromptSchema.safeParse({ member_id: 'x', prompt: 'hi', fork: true });
    expect(parsed.success).toBe(true);
  });

  it('schema accepts fork as a session-id string', () => {
    const parsed = executePromptSchema.safeParse({ member_id: 'x', prompt: 'hi', fork: 'sess-123' });
    expect(parsed.success).toBe(true);
  });

  it('schema omits fork by default (undefined), preserving prior shape', () => {
    const parsed = executePromptSchema.safeParse({ member_id: 'x', prompt: 'hi' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.fork).toBeUndefined();
  });

  it('fork=true + session_id is rejected before any exec call', async () => {
    setupExec();
    const member = makeTestAgent({ friendlyName: 'fork-vs-session-id' });
    addAgent(member);

    const result = await executePrompt({
      member_id: member.id,
      prompt: 'hello',
      fork: true,
      session_id: 'existing-session',
      resume: true,
      timeout_s: 5,
    } as any);

    expect(resultText(result)).toContain('fork');
    expect(resultText(result)).toContain('session_id');
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('fork="id" + resume=false is rejected before any exec call', async () => {
    setupExec();
    const member = makeTestAgent({ friendlyName: 'fork-vs-resume-false' });
    addAgent(member);

    const result = await executePrompt({
      member_id: member.id,
      prompt: 'hello',
      fork: 'source-session',
      resume: false,
      timeout_s: 5,
    } as any);

    expect(resultText(result)).toContain('fork');
    expect(resultText(result)).toContain('resume');
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('fork=true + resume="explicit-session-id" (non-default resume) is rejected before any exec call', async () => {
    setupExec();
    const member = makeTestAgent({ friendlyName: 'fork-vs-resume-string' });
    addAgent(member);

    const result = await executePrompt({
      member_id: member.id,
      prompt: 'hello',
      fork: true,
      resume: 'some-other-session',
      timeout_s: 5,
    } as any);

    expect(resultText(result)).toContain('fork');
    expect(resultText(result)).toContain('resume');
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('fork=true with default resume (true) and no session_id passes the guard and proceeds to dispatch', async () => {
    setupExec();
    const member = makeTestAgent({ friendlyName: 'fork-alone' });
    addAgent(member);

    // executePrompt() is invoked here as the handler would be, post-schema-
    // parse -- the real dispatch path always sees `resume` populated with its
    // schema default (true) since executePromptSchema.shape is what the MCP
    // SDK actually validates against before calling this handler. Passing it
    // explicitly here reproduces that, since this test calls executePrompt()
    // directly without going through the schema parse.
    const result = await executePrompt({
      member_id: member.id,
      prompt: 'hello',
      fork: true,
      resume: true,
      timeout_s: 5,
    } as any);

    // Guard did not block it -- the call proceeded far enough to invoke exec.
    expect(mockExecCommand).toHaveBeenCalled();
    expect(resultText(result)).not.toContain('cannot set both "fork"');
  });

  it('no fork specified behaves exactly as before -- no exec-blocking regression', async () => {
    setupExec();
    const member = makeTestAgent({ friendlyName: 'no-fork' });
    addAgent(member);

    const result = await executePrompt({
      member_id: member.id,
      prompt: 'hello',
      resume: false,
      timeout_s: 5,
    });

    expect(mockExecCommand).toHaveBeenCalled();
    expect(resultText(result)).not.toContain('cannot set both "fork"');
  });
});
