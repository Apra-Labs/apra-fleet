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
import { ClaudeProvider, claudeModelSupportsAuto, claudePermissionMode } from '../src/providers/claude.js';
import { WindowsCommands } from '../src/os/windows.js';
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
      { action: 'Bash', target: 'bd show apra-fleet-b4g.90', suggestedGrants: ['Bash(bd:*)', 'Bash(bd show apra-fleet-b4g.90)'] },
      { action: 'Bash', target: 'bd list --parent apra-fleet-b4g.90 --json', suggestedGrants: ['Bash(bd:*)', 'Bash(bd list --parent apra-fleet-b4g.90 --json)'] },
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
      { action: 'Bash', target: 'bd show x && rm -rf /', suggestedGrants: [] },
      { action: 'Write', target: '/etc/hosts', suggestedGrants: ['Write'] },
      { action: 'mcp__apra-fleet__kb_query', suggestedGrants: ['mcp__apra-fleet__kb_query'] },
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

  it('marks the denial by the session mode: auto and bypass are never healable, acceptEdits is', () => {
    expect(claude.parseResponse(run(RESULT), { unattended: 'auto', model: 'opus' }).permissionDenial)
      .toMatchObject({ permissionMode: 'auto', healable: false });
    expect(claude.parseResponse(run(RESULT), { unattended: 'dangerous', model: 'opus' }).permissionDenial)
      .toMatchObject({ permissionMode: 'bypassPermissions', healable: false });
    expect(claude.parseResponse(run(RESULT), { unattended: 'auto', model: 'haiku' }).permissionDenial)
      .toMatchObject({ permissionMode: 'acceptEdits', healable: true });
    expect(claude.parseResponse(run(RESULT), { unattended: false, model: 'opus' }).permissionDenial)
      .toMatchObject({ permissionMode: 'acceptEdits', healable: true });
  });
});

describe('Claude permission mode is model-aware (auto falls back to acceptEdits)', () => {
  it('claudeModelSupportsAuto: haiku and pre-4.6 Sonnet/Opus are unsupported', () => {
    for (const m of ['haiku', 'claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-sonnet-4-5-20250929', 'claude-opus-4-5', 'claude-opus-4-1', 'claude-sonnet-4-20250514', 'claude-3-5-sonnet-20240620']) {
      expect(claudeModelSupportsAuto(m), m).toBe(false);
    }
    for (const m of [undefined, 'opus', 'sonnet', 'fable', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1']) {
      expect(claudeModelSupportsAuto(m), String(m)).toBe(true);
    }
  });

  it('claudePermissionMode: only an explicit auto on a supported model is auto; unset stays acceptEdits', () => {
    expect(claudePermissionMode('auto', 'opus')).toBe('auto');
    expect(claudePermissionMode('auto', 'haiku')).toBe('acceptEdits');
    expect(claudePermissionMode(undefined, 'opus')).toBe('acceptEdits');
    expect(claudePermissionMode(false, 'opus')).toBe('acceptEdits');
    expect(claudePermissionMode('dangerous', 'haiku')).toBe('bypassPermissions');
  });

  it('resolvePermissionFlag and buildPromptCommand use the model', () => {
    expect(claude.resolvePermissionFlag('auto', 'haiku')).toBe('--permission-mode acceptEdits');
    expect(claude.resolvePermissionFlag('auto', 'sonnet')).toBe('--permission-mode auto');
    expect(claude.resolvePermissionFlag('auto')).toBe('--permission-mode auto');
    const haikuCmd = claude.buildPromptCommand({ folder: '/w', promptFile: 'p.md', unattended: 'auto', model: 'haiku' });
    expect(haikuCmd).toContain('--permission-mode acceptEdits');
    expect(haikuCmd).not.toContain('--permission-mode auto');
    expect(claude.buildPromptCommand({ folder: '/w', promptFile: 'p.md', unattended: 'auto', model: 'opus' })).toContain('--permission-mode auto');
  });

  it('the Windows dispatch path passes the model too', () => {
    const win = new WindowsCommands();
    const cmd = win.buildAgentPromptCommand(claude, { folder: 'C:\\w', promptFile: 'p.md', unattended: 'auto', model: 'haiku' });
    expect(cmd).toContain('acceptEdits');
    expect(cmd).not.toContain('--permission-mode auto');
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
    expect(block.denials[0]).toEqual({ action: 'Bash', target: 'bd show apra-fleet-b4g.90', suggestedGrants: ['Bash(bd:*)', 'Bash(bd show apra-fleet-b4g.90)'] });
    // A member with no unattended setting runs in acceptEdits: a grant may heal it.
    expect(block.permissionMode).toBe('acceptEdits');
    expect(block.healable).toBe(true);
    expect(block.suggestedGrants).toEqual(EXPECTED_GRANTS);
    expect(block.signals).toEqual(['result_json']);
  });

  // Auto-mode refusals come from the safety classifier or a deny rule: a
  // complete reply is a success carrying them as a warning, never a
  // permission_denied failure, and never healable.
  it('auto mode (supported model): a complete reply with denials is a success with permissionWarning, healable false', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-auto', llmProvider: 'claude', unattended: 'auto' });
    addAgent(member);
    mockExecCommand.mockResolvedValue(run(RESULT));
    const result: any = await executePrompt({ member_id: member.id, prompt: 'review the plan', resume: false, timeout_s: 5 });
    expect(result.structuredContent.isError).not.toBe(true);
    expect(result.structuredContent.reason).toBeUndefined();
    expect(result.structuredContent.response).toContain('requires approval');
    expect(result.structuredContent.permissionWarning.permissionMode).toBe('auto');
    expect(result.structuredContent.permissionWarning.healable).toBe(false);
    expect(result.structuredContent.permissionWarning.hint).toContain('no grant is ever added');
    expect(result.text).toContain('[WARN]');
    // The dispatch ran with the auto flag.
    expect(mockExecCommand.mock.calls.some(([cmd]) => String(cmd).includes('--permission-mode auto'))).toBe(true);
  });

  it('auto mode: an EMPTY reply with denials still fails permission_denied, but healable false', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-auto-empty', llmProvider: 'claude', unattended: 'auto' });
    addAgent(member);
    mockExecCommand.mockResolvedValue(run(JSON.stringify({ ...JSON.parse(RESULT), result: '' })));
    const result: any = await executePrompt({ member_id: member.id, prompt: 'review the plan', resume: false, timeout_s: 5 });
    expect(result.structuredContent.reason).toBe('permission_denied');
    expect(result.structuredContent.permissionDenied.healable).toBe(false);
    expect(permissionDenialOf(result).healable).toBe(false);
  });

  it('auto requested on haiku (no auto support): runs acceptEdits, and its denial is healable', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-haiku', llmProvider: 'claude', unattended: 'auto' });
    addAgent(member);
    mockExecCommand.mockResolvedValue(run(RESULT));
    const result: any = await executePrompt({ member_id: member.id, prompt: 'review the plan', resume: false, timeout_s: 5, model: 'cheap' });
    expect(result.structuredContent.reason).toBe('permission_denied');
    expect(result.structuredContent.permissionDenied.permissionMode).toBe('acceptEdits');
    expect(result.structuredContent.permissionDenied.healable).toBe(true);
    const cmds = mockExecCommand.mock.calls.map(([cmd]) => String(cmd)).filter((c) => c.includes('--model'));
    expect(cmds.length).toBeGreaterThan(0);
    for (const c of cmds) {
      expect(c).toContain('--permission-mode acceptEdits');
      expect(c).not.toContain('--permission-mode auto');
    }
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
