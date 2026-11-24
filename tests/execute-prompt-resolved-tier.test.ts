/**
 * execute_prompt reports the tier that actually ran and the concrete model it
 * dispatched with (resolved_tier / resolved_model in structuredContent). A
 * member lacking the requested tier reports the fallback tier, not the request.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { executePrompt } from '../src/tools/execute-prompt.js';
import type { ExecutePromptResult } from '../src/tools/execute-prompt.js';
import type { SSHExecResult } from '../src/types.js';

vi.mock('../src/services/agent-shadow.js', () => ({
  ensureNoProjectAgentShadows: vi.fn(async () => undefined),
}));
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

const okResponse = JSON.stringify({ result: 'done', session_id: 'sess-rt' });

describe('execute_prompt -- resolved_tier / resolved_model', () => {
  let tmpDir: string;

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-resolved-tier-'));
    mockExecCommand.mockResolvedValue({ stdout: okResponse, stderr: '', code: 0 });
  });

  afterEach(() => {
    restoreRegistry();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const run = async (
    modelTiers: Record<string, string> | undefined,
    model?: string,
  ): Promise<ExecutePromptResult> => {
    const member = makeTestLocalAgent({
      friendlyName: `rt-${Math.random().toString(36).slice(2, 8)}`,
      workFolder: tmpDir,
      llmProvider: 'claude',
      os: 'linux',
      ...(modelTiers ? { modelTiers } : {}),
    } as any);
    addAgent(member);
    const input: any = { member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 };
    if (model !== undefined) input.model = model;
    return (await executePrompt(input)) as ExecutePromptResult;
  };

  const tiers = { cheap: 'm-cheap', standard: 'm-std', premium: 'm-prem' };

  it('tier keyword: resolved_tier is the keyword, resolved_model the member premium model', async () => {
    const r = await run(tiers, 'premium');
    expect(r.structuredContent?.resolved_tier).toBe('premium');
    expect(r.structuredContent?.resolved_model).toBe('m-prem');
  });

  it('model omitted: resolved_tier is standard', async () => {
    const r = await run(tiers);
    expect(r.structuredContent?.resolved_tier).toBe('standard');
    expect(r.structuredContent?.resolved_model).toBe('m-std');
  });

  it('literal model id: resolved_tier null, resolved_model is the literal', async () => {
    const r = await run(tiers, 'my-literal-model-9');
    expect(r.structuredContent?.resolved_tier).toBeNull();
    expect(r.structuredContent?.resolved_model).toBe('my-literal-model-9');
  });

  it('member without premium tier: resolved_tier is the standard fallback that ran, not the request', async () => {
    const r = await run({ cheap: 'm-cheap', standard: 'm-std' }, 'premium');
    expect(r.structuredContent?.resolved_tier).toBe('standard');
    expect(r.structuredContent?.resolved_model).toBe('m-std');
  });

  it('member with only a cheap model: a premium request reports resolved_tier cheap', async () => {
    const r = await run({ cheap: 'm-cheap' }, 'premium');
    expect(r.structuredContent?.resolved_tier).toBe('cheap');
    expect(r.structuredContent?.resolved_model).toBe('m-cheap');
  });

  it('failure after resolution still carries both fields', async () => {
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: 'boom', code: 1 });
    const r = await run(tiers, 'cheap');
    expect(r.structuredContent?.isError).toBe(true);
    expect(r.structuredContent?.resolved_tier).toBe('cheap');
    expect(r.structuredContent?.resolved_model).toBe('m-cheap');
  });
});
