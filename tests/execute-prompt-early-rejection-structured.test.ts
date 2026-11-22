/**
 * Every execute_prompt early rejection returns structuredContent
 * {isError: true, reason: <typed>} (not a bare string), so a schemaless
 * workflow dispatch fails on the typed signal instead of treating the guard
 * text as the LLM's answer. No LLM CLI is invoked: exec is mocked and must
 * never be called for a pre-dispatch rejection.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, makeTestLocalAgent, backupAndResetRegistry, restoreRegistry, resultText } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { executePrompt, inFlightAgents } from '../src/tools/execute-prompt.js';
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

function structured(result: string | { text: string; structuredContent?: any }): any {
  expect(typeof result).not.toBe('string');
  return (result as { structuredContent?: any }).structuredContent;
}

describe('execute_prompt early rejections carry typed structuredContent', () => {
  let tmpDir: string;

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-early-'));
  });

  afterEach(() => {
    restoreRegistry();
    inFlightAgents.clear();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('secret token in prompt -> secret_in_prompt', async () => {
    const member = makeTestAgent({ friendlyName: 'early-secret' });
    addAgent(member);
    const result = await executePrompt({ member_id: member.id, prompt: 'use {{secret.tok}}', resume: false, timeout_s: 5 } as any);
    expect(structured(result)).toMatchObject({ isError: true, reason: 'secret_in_prompt', dispatched: false });
    expect(resultText(result)).toContain('{{secret.NAME}}');
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('fork + session_id -> invalid_arguments', async () => {
    const member = makeTestAgent({ friendlyName: 'early-fork-sid' });
    addAgent(member);
    const result = await executePrompt({ member_id: member.id, prompt: 'hi', fork: true, session_id: 's1', resume: true, timeout_s: 5 } as any);
    expect(structured(result)).toMatchObject({ isError: true, reason: 'invalid_arguments', dispatched: false });
    expect(resultText(result)).toContain('session_id');
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('fork + non-default resume -> invalid_arguments', async () => {
    const member = makeTestAgent({ friendlyName: 'early-fork-resume' });
    addAgent(member);
    const result = await executePrompt({ member_id: member.id, prompt: 'hi', fork: 'src', resume: false, timeout_s: 5 } as any);
    expect(structured(result)).toMatchObject({ isError: true, reason: 'invalid_arguments', dispatched: false });
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('invalid substitution key -> substitution_failed', async () => {
    const member = makeTestAgent({ friendlyName: 'early-subst-key' });
    addAgent(member);
    const result = await executePrompt({ member_id: member.id, prompt: 'hi {{a}}', substitutions: { 'bad key!': 'x' }, resume: false, timeout_s: 5 } as any);
    expect(structured(result)).toMatchObject({ isError: true, reason: 'substitution_failed', dispatched: false });
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('unresolved placeholder -> substitution_failed', async () => {
    const member = makeTestAgent({ friendlyName: 'early-subst-missing' });
    addAgent(member);
    const result = await executePrompt({ member_id: member.id, prompt: 'hi {{missing}}', substitutions: { other: 'x' }, resume: false, timeout_s: 5 } as any);
    expect(structured(result)).toMatchObject({ isError: true, reason: 'substitution_failed', dispatched: false });
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('llm_provider none -> provider_none', async () => {
    const member = makeTestAgent({ friendlyName: 'early-none', llmProvider: 'none' } as any);
    addAgent(member);
    const result = await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 } as any);
    expect(structured(result)).toMatchObject({ isError: true, reason: 'provider_none', dispatched: false });
    expect(resultText(result)).toContain('llm_provider: "none"');
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('missing agent file on a local member -> agent_file_not_found', async () => {
    const member = makeTestLocalAgent({ friendlyName: 'early-agent-file', workFolder: tmpDir, llmProvider: 'claude', os: 'linux' });
    addAgent(member);
    const result = await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5, agent: 'no-such-agent-xyz' } as any);
    expect(structured(result)).toMatchObject({ isError: true, reason: 'agent_file_not_found', dispatched: false });
    expect(resultText(result)).toContain('no-such-agent-xyz');
  });

  it('missing agent file on a remote member -> agent_file_not_found', async () => {
    // Every remote probe reports the file missing; no CLI dispatch may follow.
    mockExecCommand.mockResolvedValue({ stdout: 'missing', stderr: '', code: 0 });
    const member = makeTestAgent({ friendlyName: 'early-remote-agent-file', llmProvider: 'claude', os: 'linux' } as any);
    addAgent(member);
    const result = await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5, agent: 'no-such-remote-agent' } as any);
    expect(structured(result)).toMatchObject({ isError: true, reason: 'agent_file_not_found', dispatched: false });
    expect(resultText(result)).toContain('not found on "early-remote-agent-file"');
    for (const [cmd] of mockExecCommand.mock.calls) expect(String(cmd)).not.toMatch(/claude\s+-p|--agent/);
  });

  it('neither member_id nor member_name -> invalid_arguments', async () => {
    const result = await executePrompt({ prompt: 'hi', resume: false, timeout_s: 5 } as any);
    expect(structured(result)).toMatchObject({ isError: true, reason: 'invalid_arguments', dispatched: false });
    expect(resultText(result)).toContain('member_id');
    expect(mockExecCommand).not.toHaveBeenCalled();
  });
});
