/**
 * AGY permission denials (docs/compose-permissions-design.md section 8.7).
 *
 * Recorded on fleet-agy-local (Windows, gitbash, agy 1.2.11): fleet's agy
 * command line with --project bound to a project granting only command(git),
 * prompt "Run exactly this shell command and reply with its raw output only:
 * git status --short --branch". agy exited 0 and reported the refusal in its
 * JSON result (stdout), on stderr, and as an ERROR step in the transcript
 * (tests/fixtures/agy-permission-denied/transcript.jsonl, verbatim).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { AgyProvider, detectAgyPermissionDenial } from '../src/providers/agy.js';
import { ClaudeProvider } from '../src/providers/claude.js';
import { CodexProvider } from '../src/providers/codex.js';
import { CopilotProvider } from '../src/providers/copilot.js';
import { OpenCodeProvider } from '../src/providers/opencode.js';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { executePrompt } from '../src/tools/execute-prompt.js';
import type { SSHExecResult } from '../src/types.js';

const RESULT_JSON = '{"conversation_id":"48ae7611-290b-4396-90c6-c266d09c9473","status":"SUCCESS","response":"","duration_seconds":2.3997223,"num_turns":1,"usage":{"input_tokens":17220,"output_tokens":68,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":17288},"denied_actions":[{"action":"command","display_name":"RunCommand"}]}';
// agy prints an em dash after "produced"; built here so the repo stays ASCII.
const STDERR = `jetski: no output produced ${String.fromCodePoint(0x2014)} a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. command(<target>)). Alternatively, re-run with --dangerously-skip-permissions to auto-approve all tools.`;
const TRANSCRIPT = fs.readFileSync(path.join(__dirname, 'fixtures', 'agy-permission-denied', 'transcript.jsonl'), 'utf-8').trim();
const CONV = '48ae7611-290b-4396-90c6-c266d09c9473';
const transcriptBlock = (body = TRANSCRIPT) => `FLEET_SESSION_ID:${CONV}\nFLEET_TRANSCRIPT_START\n${body}\nFLEET_TRANSCRIPT_END`;
const run = (stdout: string, stderr = '', code = 0): SSHExecResult => ({ stdout, stderr, code });

const agy = new AgyProvider();

describe('detectAgyPermissionDenial -- recorded agy outputs', () => {
  it('all three signals together: action, exact target, suggested grant and hint', () => {
    const r = run(`FLEET_PID:4242\n${RESULT_JSON}\n${transcriptBlock()}`, STDERR);
    const d = detectAgyPermissionDenial(r)!;
    expect(d).toBeDefined();
    expect(d.actions).toEqual(['command']);
    expect(d.denials).toEqual([{ action: 'command', target: 'git status --short --branch' }]);
    expect(d.suggestedGrants).toEqual(['Bash(git status --short --branch)']);
    expect(d.signals).toEqual(['result_json', 'stderr', 'transcript']);
    expect(d.hint).toContain('command "git status --short --branch"');
    expect(d.hint).toContain('compose_permissions grant: ["Bash(git status --short --branch)"]');
  });

  it('JSON result alone (status SUCCESS, empty response, denied_actions) is a denial', () => {
    const d = detectAgyPermissionDenial(run(RESULT_JSON))!;
    expect(d.actions).toEqual(['command']);
    expect(d.denials).toEqual([{ action: 'command' }]);
    expect(d.signals).toEqual(['result_json']);
  });

  it('stderr alone is a denial', () => {
    const d = detectAgyPermissionDenial(run('', STDERR))!;
    expect(d.actions).toEqual(['command']);
    expect(d.signals).toEqual(['stderr']);
  });

  it('transcript alone (no JSON result on stdout, e.g. result went to CONOUT$) is a denial with its target', () => {
    const d = detectAgyPermissionDenial(run(transcriptBlock()))!;
    expect(d.denials).toEqual([{ action: 'command', target: 'git status --short --branch' }]);
    expect(d.signals).toEqual(['transcript']);
  });

  it('a clean run is not a denial', () => {
    const ok = '{"conversation_id":"bd7b7b06-8acb-4a2d-9b06-2a9d06aa9c2e","status":"SUCCESS","response":"## fix/agy-prompt-body-toolsearch\\n","num_turns":1}';
    expect(detectAgyPermissionDenial(run(ok))).toBeUndefined();
  });

  it('a genuinely empty reply is not a denial', () => {
    expect(detectAgyPermissionDenial(run(''))).toBeUndefined();
    expect(detectAgyPermissionDenial(run('{"conversation_id":"x","status":"SUCCESS","response":""}'))).toBeUndefined();
  });

  it('ignores denials from earlier turns of a resumed conversation', () => {
    const laterTurn = '{"step_index":3,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","content":"next"}\n{"step_index":4,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","content":"fine"}';
    expect(detectAgyPermissionDenial(run(transcriptBlock(`${TRANSCRIPT}\n${laterTurn}`)))).toBeUndefined();
  });

  it('a JSON result without denied_actions overrides stale transcript errors', () => {
    const ok = '{"conversation_id":"x","status":"SUCCESS","response":"done"}';
    expect(detectAgyPermissionDenial(run(`${ok}\n${transcriptBlock()}`))).toBeUndefined();
  });

  it('refuses to suggest a grant for a chained command, and maps other actions', () => {
    const t = (err: string) => `{"type":"USER_INPUT","status":"DONE"}\n${JSON.stringify({ status: 'ERROR', error: err })}`;
    const chained = detectAgyPermissionDenial(run(transcriptBlock(t('permission check failed for command "git status | head": user denied permission to run command'))))!;
    expect(chained.suggestedGrants).toEqual([]);
    expect(chained.hint).toContain('No compose_permissions grant maps');
    const mcp = detectAgyPermissionDenial(run(transcriptBlock(t('user denied permission for mcp(apra-fleet/kb_session_prime)'))))!;
    expect(mcp.denials).toEqual([{ action: 'mcp', target: 'apra-fleet/kb_session_prime' }]);
    expect(mcp.suggestedGrants).toEqual(['mcp__apra-fleet__kb_session_prime']);
  });
});

describe('parseResponse attaches the denial for agy only', () => {
  const recorded = run(`FLEET_PID:4242\n${RESULT_JSON}\n${transcriptBlock()}`, STDERR);

  it('agy: keeps the parsed session and usage and adds permissionDenial', () => {
    const p = agy.parseResponse(recorded);
    expect(p.sessionId).toBe(CONV);
    expect(p.usage).toEqual({ input_tokens: 17220, output_tokens: 68 });
    expect(p.permissionDenial?.actions).toEqual(['command']);
  });

  it('claude, codex, copilot and opencode results are unchanged (no permissionDenial)', () => {
    for (const p of [new ClaudeProvider(), new CodexProvider(), new CopilotProvider(), new OpenCodeProvider()]) {
      expect(p.parseResponse(recorded).permissionDenial).toBeUndefined();
    }
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
vi.mock('../src/services/agy-project.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/agy-project.js')>()),
  ensureAgyProject: vi.fn(async () => ({ projectId: '1afd6dbb-498f-4918-a9d9-6da64b75a204' })),
}));

describe('execute_prompt -- permission_denied', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
  });
  afterEach(() => restoreRegistry());

  it('returns reason permission_denied with action and target, not empty_response', async () => {
    const member = makeTestAgent({ friendlyName: 'agy-denied', llmProvider: 'agy' });
    addAgent(member);
    mockExecCommand.mockResolvedValue(run(`FLEET_PID:4242\n${RESULT_JSON}\n${transcriptBlock()}`, STDERR));

    const result: any = await executePrompt({ member_id: member.id, prompt: 'run git status', resume: false, timeout_s: 5 });

    expect(result.structuredContent.isError).toBe(true);
    expect(result.structuredContent.reason).toBe('permission_denied');
    expect(result.structuredContent.permissionDenied.actions).toEqual(['command']);
    expect(result.structuredContent.permissionDenied.denials).toEqual([{ action: 'command', target: 'git status --short --branch' }]);
    expect(result.structuredContent.permissionDenied.suggestedGrants).toEqual(['Bash(git status --short --branch)']);
    expect(result.structuredContent.sessionId).toBe(CONV);
    expect(result.structuredContent.usage).toEqual({ input_tokens: 17220, output_tokens: 68, total_tokens: 17288 });
    expect(result.text).toContain('permission denied');
    expect(result.text).toContain('git status --short --branch');
  });

  it('keeps a partial reply when the model answered before the denial', async () => {
    const member = makeTestAgent({ friendlyName: 'agy-partial', llmProvider: 'agy' });
    addAgent(member);
    const partialJson = RESULT_JSON.replace('"response":""', '"response":"I could not run git."');
    mockExecCommand.mockResolvedValue(run(partialJson));
    const result: any = await executePrompt({ member_id: member.id, prompt: 'run git status', resume: false, timeout_s: 5 });
    expect(result.structuredContent.reason).toBe('permission_denied');
    expect(result.structuredContent.response).toBe('I could not run git.');
  });

  it('a genuinely empty agy reply still reports empty_response', async () => {
    const member = makeTestAgent({ friendlyName: 'agy-empty', llmProvider: 'agy' });
    addAgent(member);
    mockExecCommand.mockResolvedValue(run('{"conversation_id":"x","status":"SUCCESS","response":""}'));
    const result: any = await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });
    expect(result.structuredContent.reason).not.toBe('permission_denied');
  });
});
