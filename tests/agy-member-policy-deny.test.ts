/**
 * Member tool policy vs AGY permission refusals (mirror of
 * claude-member-policy-deny.test.ts).
 *
 * compose writes deny rules (agyMemberDenyRules) for every fleet tool outside
 * the member allowlist. A refusal of one of those is member policy, never a
 * missing grant: healable:false / cause 'policy_deny' / no suggested grants,
 * so a complete reply under fail_on_permission_denial is a warning and the
 * heal stops not_healable. A refusal of an ordinary command stays healable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgyProvider, detectAgyPermissionDenial } from '../src/providers/agy.js';
import { agyMemberDenyRules } from '../src/services/member-config-io.js';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { executePrompt } from '../src/tools/execute-prompt.js';
// @ts-ignore -- plain ESM client package without type declarations
import { permissionDenialOf } from '../packages/apra-fleet-client/src/client/api.mjs';
import type { SSHExecResult } from '../src/types.js';

const CONV = '48ae7611-290b-4396-90c6-c266d09c9473';
const ADMIN = 'apra-fleet/execute_prompt';
const run = (stdout: string, stderr = '', code = 0): SSHExecResult => ({ stdout, stderr, code });
const step = (err: string) => `{"type":"USER_INPUT","status":"DONE"}\n${JSON.stringify({ status: 'ERROR', error: err })}`;
const transcript = (err: string) => `FLEET_SESSION_ID:${CONV}\nFLEET_TRANSCRIPT_START\n${step(err)}\nFLEET_TRANSCRIPT_END`;
const envelope = (response: string, action: string) =>
  `{"conversation_id":"${CONV}","status":"SUCCESS","response":${JSON.stringify(response)},"num_turns":1,"denied_actions":[{"action":"${action}"}]}`;
const STDERR_MCP = 'jetski: no output produced - a tool required the "mcp" permission that headless mode cannot prompt for, so it was auto-denied.';

const POLICY_T = transcript(`user denied permission for mcp(${ADMIN})`);
const POLICY_T2 = transcript(`permission check failed for mcp "${ADMIN}": user denied permission`);
const SHELL_T = transcript('permission check failed for command "git status": user denied permission to run command');

function expectPolicy(d: any) {
  expect(d).toBeDefined();
  expect(d.healable).toBe(false);
  expect(d.cause).toBe('policy_deny');
  expect(d.suggestedGrants).toEqual([]);
  for (const item of d.denials) expect(item.suggestedGrants).toEqual([]);
  expect(d.hint).toContain('member tool allowlist');
  expect(d.hint).toContain('no grant is ever added');
}

describe('detectAgyPermissionDenial: member tool policy denials', () => {
  it('the deny rules really cover the admin tool used here', () => {
    expect(agyMemberDenyRules()).toContain(`mcp(${ADMIN})`);
  });

  it('transcript form (user denied permission for mcp(...)) is policy_deny', () => {
    expectPolicy(detectAgyPermissionDenial(run(POLICY_T)));
  });
  it('transcript form (permission check failed for mcp "...") is policy_deny', () => {
    expectPolicy(detectAgyPermissionDenial(run(POLICY_T2)));
  });
  it('JSON denied_actions envelope plus transcript target is policy_deny', () => {
    const d = detectAgyPermissionDenial(run(`${envelope('', 'mcp')}\n${POLICY_T}`));
    expectPolicy(d);
    expect(d!.signals).toEqual(['result_json', 'transcript']);
  });
  it('stderr plus transcript target is policy_deny', () => {
    const d = detectAgyPermissionDenial(run(POLICY_T, STDERR_MCP));
    expectPolicy(d);
    expect(d!.signals).toEqual(['stderr', 'transcript']);
  });
  it('a policy call mixed with an ordinary command makes the whole denial non-healable', () => {
    const both = transcript(`user denied permission for mcp(${ADMIN})`).replace('FLEET_TRANSCRIPT_END',
      `${JSON.stringify({ status: 'ERROR', error: 'permission check failed for command "git status": user denied permission to run command' })}\nFLEET_TRANSCRIPT_END`);
    const d = detectAgyPermissionDenial(run(both))!;
    expectPolicy(d);
    expect(d.actions).toEqual(['mcp', 'command']);
  });
  it('a refused MEMBER tool (kb_query) is not policy: healable with its grant', () => {
    const d = detectAgyPermissionDenial(run(transcript('user denied permission for mcp(apra-fleet/kb_query)')))!;
    expect(d.healable).toBeUndefined();
    expect(d.cause).toBeUndefined();
    expect(d.suggestedGrants).toEqual(['mcp__apra-fleet__kb_query']);
  });
  it('a refused shell command keeps its suggested grants and no policy flags', () => {
    const d = detectAgyPermissionDenial(run(SHELL_T))!;
    expect(d.healable).toBeUndefined();
    expect(d.cause).toBeUndefined();
    expect(d.suggestedGrants).toEqual(['Bash(git:*)', 'Bash(git status)']);
  });
  it('parseResponse attaches the policy denial', () => {
    expectPolicy(new AgyProvider().parseResponse(run(POLICY_T)).permissionDenial);
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
vi.mock('../src/services/agy-project.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/agy-project.js')>()),
  ensureAgyProject: vi.fn(async () => ({ projectId: '1afd6dbb-498f-4918-a9d9-6da64b75a204' })),
}));

describe('execute_prompt on an AGY member: policy denial', () => {
  beforeEach(() => { backupAndResetRegistry(); vi.clearAllMocks(); });
  afterEach(() => restoreRegistry());
  const agyMember = (name: string) => { const m = makeTestAgent({ friendlyName: name, llmProvider: 'agy' }); addAgent(m); return m; };

  it('strict flag, complete reply: a success with a policy_deny permissionWarning', async () => {
    const m = agyMember('agy-policy-complete');
    mockExecCommand.mockResolvedValue(run(`${envelope('All done without that tool.', 'mcp')}\n${POLICY_T}`));
    const r: any = await executePrompt({ member_id: m.id, prompt: 'work', resume: false, timeout_s: 5, fail_on_permission_denial: true });
    expect(r.structuredContent.isError).not.toBe(true);
    expect(r.structuredContent.reason).toBeUndefined();
    expect(r.structuredContent.permissionWarning).toMatchObject({ healable: false, cause: 'policy_deny', suggestedGrants: [] });
  });

  it('strict flag, empty reply: permission_denied with healable false, read through permissionDenialOf', async () => {
    const m = agyMember('agy-policy-empty');
    mockExecCommand.mockResolvedValue(run(`${envelope('', 'mcp')}\n${POLICY_T}`));
    const r: any = await executePrompt({ member_id: m.id, prompt: 'work', resume: false, timeout_s: 5, fail_on_permission_denial: true });
    expect(r.structuredContent.reason).toBe('permission_denied');
    const block = permissionDenialOf(r);
    expect(block.healable).toBe(false);
    expect(block.cause).toBe('policy_deny');
    expect(block.suggestedGrants).toEqual([]);
  });

  it('an ordinary-command refusal with a complete reply is still permission_denied (strict, healable)', async () => {
    const m = agyMember('agy-shell-complete');
    mockExecCommand.mockResolvedValue(run(`${envelope('partial', 'command')}\n${SHELL_T}`));
    const r: any = await executePrompt({ member_id: m.id, prompt: 'work', resume: false, timeout_s: 5, fail_on_permission_denial: true });
    expect(r.structuredContent.reason).toBe('permission_denied');
    expect(r.structuredContent.permissionDenied.suggestedGrants).toEqual(['Bash(git:*)', 'Bash(git status)']);
  });
});
