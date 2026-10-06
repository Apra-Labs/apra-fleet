/**
 * Claude permission refusals: a result event with a non-empty
 * permission_denials (is_error false, reply otherwise complete) is a
 * permission failure, reported by execute_prompt as reason 'permission_denied'
 * with a permissionDenied block the client's permissionDenialOf() accepts.
 *
 * Fixture: tests/fixtures/claude-permission-denied/ (see its README for
 * provenance).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ClaudeProvider } from '../src/providers/claude.js';
import { detectClaudePermissionDenial } from '../src/providers/claude-permission-denial.js';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { executePrompt } from '../src/tools/execute-prompt.js';
// @ts-ignore -- plain ESM client package without type declarations
import { permissionDenialOf } from '../packages/apra-fleet-client/src/client/api.mjs';
import type { SSHExecResult } from '../src/types.js';

const RESULT = fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-permission-denied', 'result.json'), 'utf-8').trim();
const SESSION = '7f3f3564-c1ab-496c-b07d-f11f463e1679';
const run = (stdout: string, stderr = '', code = 0): SSHExecResult => ({ stdout, stderr, code });
const claude = new ClaudeProvider();

const EXPECTED_GRANTS = ['Bash(bd:*)', 'Bash(bd show apra-fleet-b4g.90)', 'Bash(bd list --parent apra-fleet-b4g.90 --json)'];

describe('detectClaudePermissionDenial', () => {
  it('recorded result: Bash denials with targets (deduped), suggested grants, hint and signal', () => {
    const d = detectClaudePermissionDenial(RESULT)!;
    expect(d).toBeDefined();
    expect(d.actions).toEqual(['Bash']);
    expect(d.denials).toEqual([
      { action: 'Bash', target: 'bd show apra-fleet-b4g.90' },
      { action: 'Bash', target: 'bd list --parent apra-fleet-b4g.90 --json' },
    ]);
    expect(d.suggestedGrants).toEqual(EXPECTED_GRANTS);
    expect(d.signals).toEqual(['result_json']);
    expect(d.hint).toContain('Bash "bd show apra-fleet-b4g.90"');
    expect(d.hint).toContain('compose_permissions');
  });

  it('an empty permission_denials is not a denial', () => {
    const clean = JSON.stringify({ ...JSON.parse(RESULT), permission_denials: [] });
    expect(detectClaudePermissionDenial(clean)).toBeUndefined();
  });

  it('a result with no permission_denials field, or no output, is not a denial', () => {
    const { permission_denials: _drop, ...rest } = JSON.parse(RESULT);
    expect(detectClaudePermissionDenial(JSON.stringify(rest))).toBeUndefined();
    expect(detectClaudePermissionDenial('')).toBeUndefined();
    expect(detectClaudePermissionDenial('plain text reply')).toBeUndefined();
  });

  it('reads the result event from a JSON array of events and from JSONL', () => {
    const events = [{ type: 'system', subtype: 'init' }, { type: 'assistant', message: { content: [] } }, JSON.parse(RESULT)];
    expect(detectClaudePermissionDenial(JSON.stringify(events))?.suggestedGrants).toEqual(EXPECTED_GRANTS);
    expect(detectClaudePermissionDenial(events.map((e) => JSON.stringify(e)).join('\n'))?.suggestedGrants).toEqual(EXPECTED_GRANTS);
  });

  it('suggests no Bash grant for a chained command, and the tool name for other tools', () => {
    const d = detectClaudePermissionDenial(JSON.stringify({
      type: 'result',
      permission_denials: [
        { tool_name: 'Bash', tool_input: { command: 'bd show x && rm -rf /' } },
        { tool_name: 'Write', tool_input: { file_path: '/etc/hosts', content: 'x' } },
        { tool_name: 'mcp__apra-fleet__kb_query', tool_input: { query: 'x' } },
      ],
    }))!;
    expect(d.denials).toEqual([
      { action: 'Bash', target: 'bd show x && rm -rf /' },
      { action: 'Write', target: '/etc/hosts' },
      { action: 'mcp__apra-fleet__kb_query' },
    ]);
    expect(d.suggestedGrants).toEqual(['Write', 'mcp__apra-fleet__kb_query']);
  });
});

describe('ClaudeProvider.parseResponse', () => {
  it('keeps the reply, session and usage and attaches permissionDenial', () => {
    const p = claude.parseResponse(run(RESULT));
    expect(p.isError).toBe(false);
    expect(p.sessionId).toBe(SESSION);
    expect(p.result).toContain('requires approval');
    expect(p.usage?.input_tokens).toBe(1840);
    expect(p.permissionDenial?.suggestedGrants).toEqual(EXPECTED_GRANTS);
  });

  it('a clean result carries no permissionDenial', () => {
    const clean = JSON.stringify({ ...JSON.parse(RESULT), permission_denials: [] });
    expect(claude.parseResponse(run(clean)).permissionDenial).toBeUndefined();
  });
});

// --- execute_prompt: structured permission_denied result ---------------------

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();
vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({ execCommand: mockExecCommand, testConnection: vi.fn(), transferFiles: vi.fn(), close: vi.fn() }),
}));
vi.mock('../src/services/agent-provisioner.js', () => ({
  provisionAgents: vi.fn().mockResolvedValue({ pushed: [] }),
  remoteAgentsDir: vi.fn().mockReturnValue('.claude/agents/pm'),
}));

describe('execute_prompt -- Claude permission_denied', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
  });
  afterEach(() => restoreRegistry());

  it('a complete-looking reply with permission_denials is reason permission_denied, accepted by permissionDenialOf', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-denied', llmProvider: 'claude' });
    addAgent(member);
    mockExecCommand.mockResolvedValue(run(RESULT));

    const result: any = await executePrompt({ member_id: member.id, prompt: 'review the plan', resume: false, timeout_s: 5 });

    expect(result.structuredContent.isError).toBe(true);
    expect(result.structuredContent.reason).toBe('permission_denied');
    expect(result.structuredContent.sessionId).toBe(SESSION);
    // The refusal-laden reply is kept as a partial response, never as the result.
    expect(result.structuredContent.response).toContain('requires approval');
    expect(result.text).toContain('permission denied');
    const block = permissionDenialOf(result);
    expect(block).not.toBeNull();
    expect(block.actions).toEqual(['Bash']);
    expect(block.denials[0]).toEqual({ action: 'Bash', target: 'bd show apra-fleet-b4g.90' });
    expect(block.suggestedGrants).toEqual(EXPECTED_GRANTS);
    expect(block.signals).toEqual(['result_json']);
  });

  it('the same result with no denials is an ordinary success', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-clean', llmProvider: 'claude' });
    addAgent(member);
    mockExecCommand.mockResolvedValue(run(JSON.stringify({ ...JSON.parse(RESULT), permission_denials: [] })));
    const result: any = await executePrompt({ member_id: member.id, prompt: 'review the plan', resume: false, timeout_s: 5 });
    expect(result.structuredContent?.reason).not.toBe('permission_denied');
    expect(result.structuredContent?.isError).not.toBe(true);
  });
});
