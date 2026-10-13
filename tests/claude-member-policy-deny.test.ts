/**
 * Member tool policy vs Claude permission refusals.
 *
 * A member session's .claude/settings.local.json carries deliberate deny rules
 * for every fleet tool outside the member allowlist (claudeMemberDenyRules).
 * A refusal of one of those is the member tool policy, never a missing grant:
 * in ANY permission mode it must be healable:false / cause 'policy_deny' with
 * no suggested grant, a warning (not a failure) on a complete reply even with
 * fail_on_permission_denial, and never healed by granting the denied tool.
 *
 * Conversely, compose_permissions must allow every member-allowlisted tool
 * (kb_*, code_*, ...), so an acceptEdits session (Haiku, pre-4.6 models) is
 * not refused a member tool for lack of an allow rule.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ClaudeProvider } from '../src/providers/claude.js';
import { claudeMemberDenyRules, memberMcpAllowRules } from '../src/services/member-config-io.js';
import { MEMBER_ALLOWED_TOOLS, MEMBER_MAINTAINER_TOOLS, MEMBER_NEVER_TOOLS, MEMBER_BASE_TOOLS } from '../src/services/member-tool-allowlist.js';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { executePrompt } from '../src/tools/execute-prompt.js';
// @ts-ignore -- plain ESM client package without type declarations
import { permissionDenialOf } from '../packages/apra-fleet-client/src/client/api.mjs';
import type { SSHExecResult } from '../src/types.js';

const BASE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-permission-denied', 'result.json'), 'utf-8').trim());
const run = (stdout: string, stderr = '', code = 0): SSHExecResult => ({ stdout, stderr, code });
const claude = new ClaudeProvider();

const ADMIN_TOOL = 'mcp__apra-fleet__execute_prompt';
const withDenials = (denials: unknown[], overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ ...BASE, permission_denials: denials, ...overrides });
const POLICY_ONLY = withDenials([{ tool_name: ADMIN_TOOL, tool_use_id: 'toolu_1', tool_input: { member_name: 'other', prompt: 'x' } }]);
const MIXED = withDenials([
  { tool_name: ADMIN_TOOL, tool_use_id: 'toolu_1', tool_input: { member_name: 'other', prompt: 'x' } },
  { tool_name: 'Bash', tool_use_id: 'toolu_2', tool_input: { command: 'bd show x' } },
]);
const NON_POLICY = withDenials([{ tool_name: 'Bash', tool_use_id: 'toolu_2', tool_input: { command: 'bd show x' } }]);

describe('ClaudeProvider.parseResponse: member tool policy denials', () => {
  it('the deny rules really cover the admin tool used here', () => {
    expect(claudeMemberDenyRules()).toContain(ADMIN_TOOL);
  });

  for (const [label, ctx] of [
    ['acceptEdits (Haiku, auto requested)', { unattended: 'auto' as const, model: 'haiku' }],
    ['acceptEdits (unattended unset)', { unattended: false as const, model: 'opus' }],
    ['auto', { unattended: 'auto' as const, model: 'opus' }],
    ['bypass', { unattended: 'dangerous' as const, model: 'opus' }],
  ] as const) {
    it(`${label}: a refused non-member fleet tool is healable:false, cause policy_deny, no grant anywhere`, () => {
      const d = claude.parseResponse(run(POLICY_ONLY), ctx).permissionDenial!;
      expect(d).toBeDefined();
      expect(d.healable).toBe(false);
      expect(d.cause).toBe('policy_deny');
      expect(d.suggestedGrants).toEqual([]);
      for (const item of d.denials) expect(item.suggestedGrants).toEqual([]);
      expect(d.hint).toContain('member tool allowlist');
      expect(d.hint).toContain('no grant is ever added');
      expect(d.hint).not.toContain('Re-compose');
    });
  }

  it('mixed (policy deny + missing Bash grant) in acceptEdits: the whole denial is non-healable, no grant kept', () => {
    const d = claude.parseResponse(run(MIXED), { unattended: 'auto', model: 'haiku' }).permissionDenial!;
    expect(d.healable).toBe(false);
    expect(d.cause).toBe('policy_deny');
    expect(d.suggestedGrants).toEqual([]);
    for (const item of d.denials) expect(item.suggestedGrants).toEqual([]);
    expect(d.actions).toEqual([ADMIN_TOOL, 'Bash']);
  });

  it('a refused MEMBER tool (kb_query) is not policy: acceptEdits keeps it healable with its grant', () => {
    const d = claude.parseResponse(run(withDenials([{ tool_name: 'mcp__apra-fleet__kb_query', tool_input: { query: 'x' } }])), { unattended: 'auto', model: 'haiku' }).permissionDenial!;
    expect(d.cause).toBeUndefined();
    expect(d.healable).toBe(true);
    expect(d.suggestedGrants).toEqual(['mcp__apra-fleet__kb_query']);
  });

  it('auto mode without a policy tool is unchanged (healable:false, no cause)', () => {
    const d = claude.parseResponse(run(NON_POLICY), { unattended: 'auto', model: 'opus' }).permissionDenial!;
    expect(d.healable).toBe(false);
    expect(d.cause).toBeUndefined();
    expect(d.permissionMode).toBe('auto');
  });
});

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();
vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({ execCommand: mockExecCommand, testConnection: vi.fn(), transferFiles: vi.fn(), close: vi.fn() }),
}));
vi.mock('../src/services/agent-provisioner.js', () => ({
  provisionAgents: vi.fn().mockResolvedValue({ pushed: [] }),
  remoteAgentsDir: vi.fn().mockReturnValue('.claude/agents/pm'),
}));

describe('execute_prompt: a member tool policy denial in an acceptEdits (Haiku) session', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
  });
  afterEach(() => restoreRegistry());

  const haikuMember = (name: string) => {
    const m = makeTestAgent({ friendlyName: name, llmProvider: 'claude', unattended: 'auto' });
    addAgent(m);
    return m;
  };

  it('flag off, complete reply: success with a policy_deny permissionWarning', async () => {
    const m = haikuMember('policy-nonstrict');
    mockExecCommand.mockResolvedValue(run(POLICY_ONLY));
    const result: any = await executePrompt({ member_id: m.id, prompt: 'work', resume: false, timeout_s: 5, model: 'cheap' });
    expect(result.structuredContent.isError).not.toBe(true);
    expect(result.structuredContent.reason).toBeUndefined();
    expect(result.structuredContent.permissionWarning).toMatchObject({ healable: false, cause: 'policy_deny', permissionMode: 'acceptEdits', suggestedGrants: [] });
    expect(result.text).toContain('[WARN]');
  });

  it('flag on (fleet-sprint), complete reply: STILL a warning, never permission_denied', async () => {
    const m = haikuMember('policy-strict');
    mockExecCommand.mockResolvedValue(run(POLICY_ONLY));
    const result: any = await executePrompt({ member_id: m.id, prompt: 'work', resume: false, timeout_s: 5, model: 'cheap', fail_on_permission_denial: true });
    expect(result.structuredContent.isError).not.toBe(true);
    expect(result.structuredContent.reason).toBeUndefined();
    expect(result.structuredContent.permissionWarning).toMatchObject({ healable: false, cause: 'policy_deny' });
  });

  it('flag on, mixed denial, complete reply: a warning too (the policy call makes it non-healable)', async () => {
    const m = haikuMember('policy-mixed');
    mockExecCommand.mockResolvedValue(run(MIXED));
    const result: any = await executePrompt({ member_id: m.id, prompt: 'work', resume: false, timeout_s: 5, model: 'cheap', fail_on_permission_denial: true });
    expect(result.structuredContent.reason).toBeUndefined();
    expect(result.structuredContent.permissionWarning).toMatchObject({ healable: false, cause: 'policy_deny', suggestedGrants: [] });
  });

  it('flag on, EMPTY reply: permission_denied with healable:false / policy_deny, read through permissionDenialOf', async () => {
    const m = haikuMember('policy-empty');
    mockExecCommand.mockResolvedValue(run(withDenials(JSON.parse(POLICY_ONLY).permission_denials, { result: '' })));
    const result: any = await executePrompt({ member_id: m.id, prompt: 'work', resume: false, timeout_s: 5, model: 'cheap', fail_on_permission_denial: true });
    expect(result.structuredContent.reason).toBe('permission_denied');
    const block = permissionDenialOf(result);
    expect(block.healable).toBe(false);
    expect(block.cause).toBe('policy_deny');
    expect(block.suggestedGrants).toEqual([]);
    expect(result.text).not.toContain(`grant: ["${ADMIN_TOOL}"]`);
  });
});

describe('member MCP allow rules', () => {
  it('cover exactly the member allowlist: every kb_/code_ member tool, no maintainer, never-served or denied tool', () => {
    const rules = memberMcpAllowRules();
    expect(rules).toEqual(MEMBER_ALLOWED_TOOLS.map(t => `mcp__apra-fleet__${t}`));
    for (const t of MEMBER_BASE_TOOLS.filter(t => t.startsWith('kb_') || t.startsWith('code_'))) {
      expect(rules).toContain(`mcp__apra-fleet__${t}`);
    }
    for (const t of [...MEMBER_MAINTAINER_TOOLS, ...MEMBER_NEVER_TOOLS]) expect(rules).not.toContain(`mcp__apra-fleet__${t}`);
    const deny = new Set(claudeMemberDenyRules());
    for (const r of rules) expect(deny.has(r)).toBe(false);
  });
});
