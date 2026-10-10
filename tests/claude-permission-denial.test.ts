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
import { addAgent, getAgent } from '../src/services/registry.js';
import { isKnownSession } from '../src/services/known-sessions.js';
import { getStoredPid } from '../src/utils/agent-helpers.js';
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

  it('a healable:false denial carries NO suggested grant, overall or per call; a healable one keeps them', () => {
    for (const unattended of ['auto', 'dangerous'] as const) {
      const d = claude.parseResponse(run(RESULT), { unattended, model: 'opus' }).permissionDenial!;
      expect(d.healable).toBe(false);
      expect(d.suggestedGrants).toEqual([]);
      for (const item of d.denials) expect(item.suggestedGrants).toEqual([]);
      expect(d.hint).not.toMatch(/Bash\(/);
    }
    const healable = claude.parseResponse(run(RESULT), { unattended: 'auto', model: 'haiku' }).permissionDenial!;
    expect(healable.suggestedGrants).toEqual(EXPECTED_GRANTS);
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

    const result: any = await executePrompt({ member_id: member.id, prompt: 'review the plan', resume: false, timeout_s: 5, fail_on_permission_denial: true });

    expect(result.structuredContent.isError).toBe(true);
    expect(result.structuredContent.reason).toBe('permission_denied');
    expect(result.structuredContent.sessionId).toBe(SESSION);
    // The refusal-laden reply is kept as a partial response, never as the result.
    expect(result.structuredContent.response).toContain('requires approval');
    // Clean exit, no error result, non-empty text: the server says the reply
    // is complete, so a caller can judge the refusal by its impact.
    expect(result.structuredContent.replyComplete).toBe(true);
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
    expect(result.structuredContent.permissionWarning.suggestedGrants).toEqual([]);
    expect(result.structuredContent.permissionWarning.hint).toContain('no grant is ever added');
    expect(result.text).toContain('[WARN]');
    // The dispatch ran with the auto flag.
    expect(mockExecCommand.mock.calls.some(([cmd]) => String(cmd).includes('--permission-mode auto'))).toBe(true);
  });

  it('auto mode: an EMPTY reply with denials still fails permission_denied, but healable false', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-auto-empty', llmProvider: 'claude', unattended: 'auto' });
    addAgent(member);
    mockExecCommand.mockResolvedValue(run(JSON.stringify({ ...JSON.parse(RESULT), result: '' })));
    const result: any = await executePrompt({ member_id: member.id, prompt: 'review the plan', resume: false, timeout_s: 5, fail_on_permission_denial: true });
    expect(result.structuredContent.reason).toBe('permission_denied');
    expect(result.structuredContent.replyComplete).toBe(false);
    expect(result.structuredContent.permissionDenied.healable).toBe(false);
    expect(result.structuredContent.permissionDenied.suggestedGrants).toEqual([]);
    expect(permissionDenialOf(result).healable).toBe(false);
    expect(result.text).not.toMatch(/Bash\(bd/);
  });

  it('auto requested on haiku (no auto support): runs acceptEdits, and its denial is healable', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-haiku', llmProvider: 'claude', unattended: 'auto' });
    addAgent(member);
    mockExecCommand.mockResolvedValue(run(RESULT));
    const result: any = await executePrompt({ member_id: member.id, prompt: 'review the plan', resume: false, timeout_s: 5, model: 'cheap', fail_on_permission_denial: true });
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

  // Without fail_on_permission_denial a Claude reply stands, as in v0.4.3.
  it('no flag, acceptEdits: a complete reply with denials is a SUCCESS carrying a healable permissionWarning', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-nonstrict', llmProvider: 'claude' });
    addAgent(member);
    mockExecCommand.mockResolvedValue(run(RESULT));
    const result: any = await executePrompt({ member_id: member.id, prompt: 'review the plan', resume: false, timeout_s: 5 });
    expect(result.structuredContent.isError).not.toBe(true);
    expect(result.structuredContent.reason).toBeUndefined();
    expect(result.structuredContent.response).toContain('requires approval');
    expect(result.structuredContent.permissionWarning.healable).toBe(true);
    expect(result.structuredContent.permissionWarning.suggestedGrants).toEqual(EXPECTED_GRANTS);
    expect(result.text).toContain('[RESULT]');
    expect(result.text).toContain('[WARN]');
  });

  it('no flag: an EMPTY Claude reply with denials keeps its ordinary reason (empty_response), denial attached', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-nonstrict-empty', llmProvider: 'claude', unattended: 'auto' });
    addAgent(member);
    mockExecCommand.mockResolvedValue(run(JSON.stringify({ ...JSON.parse(RESULT), result: '' })));
    const result: any = await executePrompt({ member_id: member.id, prompt: 'review the plan', resume: false, timeout_s: 5 });
    expect(result.structuredContent.reason).toBe('empty_response');
    expect(result.structuredContent.permissionDenied.healable).toBe(false);
  });

  it('strict permission_denied keeps the session, usage and budget bookkeeping of a dispatch that ran', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-bookkeeping', llmProvider: 'claude', tokenUsage: { input: 0, output: 0 } });
    addAgent(member);
    // The CLI honors the minted --session-id (a differing id is a mismatch,
    // which is not persisted -- see the mismatch tests below).
    let minted = '';
    mockExecCommand.mockImplementation(async (cmd: string) => {
      const m = cmd.match(/--session-id "?([0-9a-f-]{36})"?/);
      if (!m) return run('');
      minted = m[1];
      return run(RESULT.replaceAll(SESSION, minted));
    });
    const result: any = await executePrompt({ member_id: member.id, prompt: 'review the plan', resume: false, timeout_s: 5, fail_on_permission_denial: true });
    expect(result.structuredContent.reason).toBe('permission_denied');
    const after = getAgent(member.id)!;
    // The stored session advanced, so a later resume:true continues this turn.
    expect(after.sessionId).toBe(minted);
    expect(after.tokenUsage!.input).toBe(1840);
    expect(isKnownSession(member.id, minted)).toBe(true);
    expect(getStoredPid(member.id)).toBeUndefined();
  });

  // A typed failure wins over a denial carried in the same result, in either
  // permission mode and with or without the strict flag.
  const maxTurnsResult = () => run(JSON.stringify({
    ...JSON.parse(RESULT), is_error: true, subtype: 'error_max_turns', terminal_reason: 'max_turns',
  }), 'Error: Reached max turns (50)', 1);
  for (const unattended of [undefined, 'auto'] as const) {
    for (const strict of [true, false]) {
      it(`max_turns + denials (${unattended ?? 'acceptEdits'}, strict=${strict}) is max_turns_exhausted with the denial attached`, async () => {
        const member = makeTestAgent({ friendlyName: `claude-mt-${unattended ?? 'ae'}-${strict}`, llmProvider: 'claude', unattended });
        addAgent(member);
        mockExecCommand.mockResolvedValue(maxTurnsResult());
        const result: any = await executePrompt({ member_id: member.id, prompt: 'do it', resume: false, timeout_s: 5, fail_on_permission_denial: strict });
        expect(result.structuredContent.reason).toBe('max_turns_exhausted');
        expect(result.structuredContent.permissionDenied.actions).toEqual(['Bash']);
      });
    }
  }

  it('auth failure + denials (strict) is auth, not permission_denied', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-auth', llmProvider: 'claude' });
    addAgent(member);
    mockExecCommand.mockResolvedValue(run(JSON.stringify({ ...JSON.parse(RESULT), is_error: true, result: 'Failed to authenticate. OAuth session expired.' }), 'Failed to authenticate: OAuth session expired', 1));
    const result: any = await executePrompt({ member_id: member.id, prompt: 'do it', resume: false, timeout_s: 5, fail_on_permission_denial: true });
    expect(result.structuredContent.reason).toBe('auth');
    expect(result.structuredContent.permissionDenied).toBeDefined();
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
