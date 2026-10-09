import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { AgyProvider, detectAgyPermissionDenial } from '../src/providers/agy.js';
import { LinuxCommands, WindowsCommands } from '../src/os/index.js';
import { executePrompt } from '../src/tools/execute-prompt.js';
import { addAgent } from '../src/services/registry.js';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import type { Agent, SSHExecResult } from '../src/types.js';

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
  readMemberStatus: vi.fn(() => 'idle'),
}));

const mockExecCommand = vi.fn<(cmd: string, timeout?: number, maxTotalMs?: number) => Promise<SSHExecResult>>();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: vi.fn().mockResolvedValue({ ok: true, latencyMs: 5 }),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock('../src/services/agy-project.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/agy-project.js')>()),
  ensureAgyProject: vi.fn(async (agent: { agyProjectId?: string }) => {
    agent.agyProjectId = agent.agyProjectId ?? '1afd6dbb-498f-4918-a9d9-6da64b75a204';
    return { projectId: agent.agyProjectId };
  }),
}));

vi.mock('../src/services/agent-shadow.js', () => ({
  ensureNoProjectAgentShadows: vi.fn(async () => undefined),
}));

function makeResult(stdout: string, code = 0): SSHExecResult {
  return { stdout, stderr: '', code };
}

// -- apra-fleet-qmb: parseResponse --
//
// execute_prompt against an agy member used to hand callers back an empty
// reply (structuredContent.response effectively "{}") because parseResponse
// was never exercised against a realistic captured transcript, and never
// captured the conversation id agy assigns even when the transcript exposed
// one. These tests pin both against a recorded (fixture) AGY CLI output --
// no live AGY dispatch involved anywhere here.
describe('AgyProvider parseResponse', () => {
  const p = new AgyProvider();
  const fixturePath = path.join(__dirname, 'fixtures', 'agy-transcript-output.txt');

  it('extracts the final PLANNER_RESPONSE reply text from the FLEET_TRANSCRIPT-wrapped JSONL', () => {
    const raw = fs.readFileSync(fixturePath, 'utf-8');
    const parsed = p.parseResponse(makeResult(raw));
    expect(parsed.result).toBe('Implemented the change in src/foo.ts and verified it builds cleanly.');
    expect(parsed.isError).toBe(false);
  });

  it('captures the conversation id exposed on an earlier transcript entry (not just the final one)', () => {
    const raw = fs.readFileSync(fixturePath, 'utf-8');
    const parsed = p.parseResponse(makeResult(raw));
    expect(parsed.sessionId).toBe('conv-9f8e7d6c-aaaa-bbbb-cccc-000000000001');
  });

  it('reflects a non-zero exit code as isError even with a captured reply', () => {
    const raw = fs.readFileSync(fixturePath, 'utf-8');
    const parsed = p.parseResponse(makeResult(raw, 1));
    expect(parsed.result).toBe('Implemented the change in src/foo.ts and verified it builds cleanly.');
    expect(parsed.isError).toBe(true);
  });

  it('leaves sessionId undefined when no transcript entry exposes a conversation id', () => {
    const raw = [
      'FLEET_TRANSCRIPT_START',
      '{"type":"USER_QUERY","status":"DONE","content":"do the task"}',
      '{"type":"PLANNER_RESPONSE","status":"DONE","content":"done"}',
      'FLEET_TRANSCRIPT_END',
    ].join('\n');
    const parsed = p.parseResponse(makeResult(raw));
    expect(parsed.result).toBe('done');
    expect(parsed.sessionId).toBeUndefined();
  });

  it('ignores non-DONE PLANNER_RESPONSE entries and malformed JSON lines, keeping the last valid DONE reply', () => {
    const raw = [
      'FLEET_TRANSCRIPT_START',
      '{not valid json}',
      '{"type":"PLANNER_RESPONSE","status":"IN_PROGRESS","content":"still working"}',
      '{"type":"PLANNER_RESPONSE","status":"DONE","content":"first done"}',
      '{"type":"PLANNER_RESPONSE","status":"DONE","content":"final done"}',
      'FLEET_TRANSCRIPT_END',
    ].join('\n');
    const parsed = p.parseResponse(makeResult(raw));
    expect(parsed.result).toBe('final done');
  });

  it('falls back to ANSI-stripped raw stdout when the transcript markers are missing entirely (e.g. FLEET_TRANSCRIPT_MISSING)', () => {
    const raw = 'FLEET_PID:1234\nFLEET_TRANSCRIPT_MISSING:NOT_IN_CACHE:/home/user/project\n';
    const parsed = p.parseResponse(makeResult(raw));
    expect(parsed.result).toContain('FLEET_TRANSCRIPT_MISSING');
    expect(parsed.sessionId).toBeUndefined();
    expect(parsed.isError).toBe(false);
  });

  it('never returns an empty {} result when the transcript carries a real reply (apra-fleet-qmb regression guard)', () => {
    const raw = fs.readFileSync(fixturePath, 'utf-8');
    const parsed = p.parseResponse(makeResult(raw));
    expect(parsed.result).not.toBe('');
    expect(parsed.result.length).toBeGreaterThan(0);
  });
});

describe('AgyProvider parseResponse -- Windows structured output and CRLF capture', () => {
  const p = new AgyProvider();

  const doerOutput = {
    status: 'VERIFY',
    closedIds: ['test-task-1'],
    notes: 'Fixed CRLF parsing on Windows',
  };
  const doerOutputJson = JSON.stringify(doerOutput, null, 2).replace(/\n/g, '\r\n');

  it('correctly extracts structured response from Windows single-line AGY native JSON envelope with CRLF', () => {
    const rawEnvelope = JSON.stringify({
      conversation_id: 'conv-win-001',
      status: 'SUCCESS',
      response: doerOutputJson,
      usage: { input_tokens: 250, output_tokens: 120 },
    });
    const stdout = `FLEET_PID:9876\r\nFLEET_SESSION_ID:conv-win-001\r\n${rawEnvelope}\r\n`;
    const parsed = p.parseResponse(makeResult(stdout));

    expect(parsed.isError).toBe(false);
    expect(parsed.sessionId).toBe('conv-win-001');
    expect(parsed.usage).toEqual({ input_tokens: 250, output_tokens: 120 });
    // Inner structured output is extracted, not outer envelope
    expect(parsed.result).toBe(doerOutputJson);
    const structured = JSON.parse(parsed.result);
    expect(structured.status).toBe('VERIFY');
    expect(structured.closedIds).toEqual(['test-task-1']);
  });

  it('correctly extracts structured response from Windows multiline AGY native JSON envelope with CRLF and trailing transcript', () => {
    const rawEnvelopeMultiline = [
      '{',
      '  "conversation_id": "conv-win-002",',
      '  "status": "SUCCESS",',
      `  "response": ${JSON.stringify(doerOutputJson)},`,
      '  "usage": {',
      '    "input_tokens": 300,',
      '    "output_tokens": 150',
      '  }',
      '}',
    ].join('\r\n');

    const transcript = [
      'FLEET_TRANSCRIPT_START',
      '{"type":"PLANNER_RESPONSE","status":"DONE","content":"some earlier note"}',
      'FLEET_TRANSCRIPT_END',
    ].join('\r\n');

    const stdout = `FLEET_PID:1122\r\nFLEET_SESSION_ID:conv-win-002\r\n${rawEnvelopeMultiline}\r\n${transcript}\r\n`;
    const parsed = p.parseResponse(makeResult(stdout));

    expect(parsed.isError).toBe(false);
    expect(parsed.sessionId).toBe('conv-win-002');
    expect(parsed.usage).toEqual({ input_tokens: 300, output_tokens: 150 });
    expect(parsed.result).toBe(doerOutputJson);
    const structured = JSON.parse(parsed.result);
    expect(structured.status).toBe('VERIFY');
    expect(structured.closedIds).toEqual(['test-task-1']);
  });

  it('handles CRLF line endings in error envelope from Windows AGY', () => {
    const rawEnvelope = JSON.stringify({
      conversation_id: 'conv-win-err',
      status: 'ERROR',
      error: 'Simulated Windows error occurred\r\nDetails on line 2',
    });
    const stdout = `FLEET_PID:4321\r\nFLEET_SESSION_ID:conv-win-err\r\n${rawEnvelope}\r\n`;
    const parsed = p.parseResponse(makeResult(stdout, 0));

    expect(parsed.isError).toBe(true);
    expect(parsed.sessionId).toBe('conv-win-err');
    expect(parsed.result).toBe('Simulated Windows error occurred\r\nDetails on line 2');
  });

  it('handles Windows envelope when FLEET_PID / FLEET_SESSION_ID prefixes have CRLF without transcript markers', () => {
    const rawEnvelope = JSON.stringify({
      conversation_id: 'conv-win-003',
      status: 'SUCCESS',
      response: 'Plain text output with \r\n CRLF preserved',
    });
    const stdout = `FLEET_PID:5555\r\nFLEET_SESSION_ID:conv-win-003\r\n${rawEnvelope}\r\n`;
    const parsed = p.parseResponse(makeResult(stdout));

    expect(parsed.isError).toBe(false);
    expect(parsed.sessionId).toBe('conv-win-003');
    expect(parsed.result).toBe('Plain text output with \r\n CRLF preserved');
  });
});

describe('AgyProvider headless permission mapping for Develop dispatch commands', () => {
  const p = new AgyProvider();
  const profilesDir = path.join(__dirname, '..', 'skills', 'fleet', 'profiles');
  const baseDev = JSON.parse(fs.readFileSync(path.join(profilesDir, 'base-dev.json'), 'utf-8'));
  const baseDevAllow: string[] = baseDev.permissions.allow;

  // The concrete commands and MCP tools executed during a doer Develop dispatch
  const developCommands = [
    'bd memories role:all',
    'bd memories doer:',
    'bd show test-task-1 --json',
    'bd list --parent test-task-1 --json',
    'bd update test-task-1 --claim',
    'bd show test-task-1',
    'bd close test-task-1',
    'git branch --show-current',
    'git log --oneline -10',
    'git diff --stat',
    'git status --short',
    'git commit -m "feat: implement test task"',
  ];

  const developMcpTools = [
    'apra-fleet/kb_session_prime',
    'apra-fleet/kb_query',
    'apra-fleet/code_impact',
    'apra-fleet/code_context',
    'apra-fleet/code_graph',
    'apra-fleet/code_query',
    'apra-fleet/kb_capture',
    'apra-fleet/kb_stats',
    'apra-fleet/kb_feedback',
  ];

  function isCommandAllowed(rules: string[], cmd: string): boolean {
    return rules.some(r => {
      if (r === 'command(*)') return true;
      if (r.startsWith('command(') && r.endsWith(')')) {
        const inner = r.slice(8, -1);
        if (inner.startsWith('regex:')) {
          const re = new RegExp(`^${inner.slice(6)}$`);
          return re.test(cmd);
        }
        return cmd === inner || cmd.startsWith(inner + ' ');
      }
      return false;
    });
  }

  function isMcpToolAllowed(rules: string[], serverAndTool: string): boolean {
    return rules.some(r => {
      if (r === 'mcp(*)') return true;
      if (r.startsWith('mcp(') && r.endsWith(')')) {
        return r.slice(4, -1) === serverAndTool;
      }
      return false;
    });
  }

  for (const os of ['linux', 'windows', 'macos'] as const) {
    it(`properly maps and allows all Develop dispatch commands and MCP tools on ${os}`, () => {
      const agent = { agyProjectId: 'proj-001', os } as unknown as Agent;
      const config = p.composePermissionConfig('doer', baseDevAllow, agent)[0] as any;
      const allowRules: string[] = config.permissionGrants.permissionGrants.allow;

      // Verify that every single Develop dispatch command is mapped and allowed
      for (const cmd of developCommands) {
        expect(isCommandAllowed(allowRules, cmd)).toBe(true);
      }

      // Verify that every single Develop dispatch MCP tool is mapped and allowed
      for (const tool of developMcpTools) {
        expect(isMcpToolAllowed(allowRules, tool)).toBe(true);
      }
    });
  }

  it('fails allow check when required develop commands or MCP tools are missing from compose permissions', () => {
    // Simulated config with empty or unmapped allowlist
    const restrictedAllow: string[] = ['read_file(*)', 'write_file(*)'];
    for (const cmd of developCommands) {
      expect(isCommandAllowed(restrictedAllow, cmd)).toBe(false);
    }
    for (const tool of developMcpTools) {
      expect(isMcpToolAllowed(restrictedAllow, tool)).toBe(false);
    }
  });

  it('detects auto-denial when an unmapped command is executed by headless AGY and suggests proper grant', () => {
    const unmappedCommand = 'docker run --rm test';
    const stderr = 'jetski: no output produced - a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. command(<target>)). Alternatively, re-run with --dangerously-skip-permissions to auto-approve all tools.';
    const transcript = [
      'FLEET_TRANSCRIPT_START',
      '{"type":"USER_INPUT","status":"DONE"}',
      JSON.stringify({
        source: 'MODEL',
        type: 'GENERIC',
        status: 'ERROR',
        error: `permission check failed for command "${unmappedCommand}": user denied permission to run command`,
      }),
      'FLEET_TRANSCRIPT_END',
    ].join('\n');
    const stdout = `FLEET_PID:9999\n{"conversation_id":"conv-deny-01","status":"SUCCESS","response":"","denied_actions":[{"action":"command"}]}\n${transcript}\n`;
    const denial = detectAgyPermissionDenial(makeResult(stdout), 'linux');

    expect(denial).toBeDefined();
    expect(denial?.actions).toContain('command');
    expect(denial?.denials[0]).toEqual({
      action: 'command',
      target: unmappedCommand,
      suggestedGrants: ['Bash(docker:*)', `Bash(${unmappedCommand})`],
    });
    expect(denial?.suggestedGrants).toContain('Bash(docker:*)');
  });

  it('detects auto-denial when an unmapped MCP tool is called by headless AGY and suggests proper grant', () => {
    const transcript = [
      'FLEET_TRANSCRIPT_START',
      '{"type":"USER_INPUT","status":"DONE"}',
      JSON.stringify({
        source: 'MODEL',
        type: 'GENERIC',
        status: 'ERROR',
        error: 'user denied permission for mcp(apra-fleet/unmapped_tool)',
      }),
      'FLEET_TRANSCRIPT_END',
    ].join('\n');
    const stdout = `FLEET_PID:9999\n{"conversation_id":"conv-deny-02","status":"SUCCESS","response":"","denied_actions":[{"action":"mcp"}]}\n${transcript}\n`;
    const denial = detectAgyPermissionDenial(makeResult(stdout), 'linux');

    expect(denial).toBeDefined();
    expect(denial?.actions).toContain('mcp');
    expect(denial?.denials[0]).toEqual({
      action: 'mcp',
      target: 'apra-fleet/unmapped_tool',
      suggestedGrants: ['mcp__apra-fleet__unmapped_tool'],
    });
    expect(denial?.suggestedGrants).toEqual(['mcp__apra-fleet__unmapped_tool']);
  });
});

describe('AgyProvider model resolution and execute_prompt dispatch', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    restoreRegistry();
    vi.useRealTimers();
  });

  it('execute_prompt with model "gemini-3.1-pro-high" produces --model "gemini-3.1-pro-high" on POSIX and Windows', async () => {
    for (const os of ['linux', 'windows'] as const) {
      const member = makeTestAgent({
        friendlyName: `agy-explicit-${os}`,
        llmProvider: 'agy',
        agyProjectId: `proj-${os}`,
        os,
      });
      addAgent(member);
      mockExecCommand.mockResolvedValue({ stdout: '{"result":"done"}', stderr: '', code: 0 });

      await executePrompt({ member_id: member.id, prompt: 'hello', resume: false, timeout_s: 5, model: 'gemini-3.1-pro-high' });

      const dispatchCall = mockExecCommand.mock.calls.find(c => c[0].includes('agy'));
      expect(dispatchCall).toBeDefined();
      expect(dispatchCall![0]).toContain('--model "gemini-3.1-pro-high"');
    }
  });

  it('execute_prompt with model "foo-bar-model" passes it through unchanged on POSIX and Windows', async () => {
    for (const os of ['linux', 'windows'] as const) {
      const member = makeTestAgent({
        friendlyName: `agy-custom-${os}`,
        llmProvider: 'agy',
        agyProjectId: `proj-${os}`,
        os,
      });
      addAgent(member);
      mockExecCommand.mockResolvedValue({ stdout: '{"result":"done"}', stderr: '', code: 0 });

      await executePrompt({ member_id: member.id, prompt: 'hello', resume: false, timeout_s: 5, model: 'foo-bar-model' });

      const dispatchCall = mockExecCommand.mock.calls.find(c => c[0].includes('agy'));
      expect(dispatchCall).toBeDefined();
      expect(dispatchCall![0]).toContain('--model "foo-bar-model"');
    }
  });

  it('an agy member with modelTiers {premium: "gemini-3.1-pro-high"} dispatched with tier "premium" gets --model "gemini-3.1-pro-high"', async () => {
    for (const os of ['linux', 'windows'] as const) {
      const member = makeTestAgent({
        friendlyName: `agy-tier-${os}`,
        llmProvider: 'agy',
        agyProjectId: `proj-tier-${os}`,
        os,
        modelTiers: {
          premium: 'gemini-3.1-pro-high',
        },
      });
      addAgent(member);
      mockExecCommand.mockResolvedValue({ stdout: '{"result":"done"}', stderr: '', code: 0 });

      await executePrompt({ member_id: member.id, prompt: 'hello', resume: false, timeout_s: 5, model: 'premium' });

      const dispatchCall = mockExecCommand.mock.calls.find(c => c[0].includes('agy'));
      expect(dispatchCall).toBeDefined();
      expect(dispatchCall![0]).toContain('--model "gemini-3.1-pro-high"');
    }

    // Also assert custom member modelTiers override (not matching any provider default)
    const customMember = makeTestAgent({
      friendlyName: 'agy-custom-tier',
      llmProvider: 'agy',
      agyProjectId: 'proj-custom-tier',
      modelTiers: {
        premium: 'custom-premium-override',
      },
    });
    addAgent(customMember);
    await executePrompt({ member_id: customMember.id, prompt: 'hello', resume: false, timeout_s: 5, model: 'premium' });
    const customCall = mockExecCommand.mock.calls.find(c => c[0].includes('custom-premium-override'));
    expect(customCall).toBeDefined();
  });

  it('direct command builder tests for explicit model and tier overrides (POSIX and Windows)', () => {
    const p = new AgyProvider();
    const linux = new LinuxCommands();
    const windows = new WindowsCommands();

    const baseOpts = {
      folder: '/repo',
      promptFile: '.fleet-task.md',
      projectId: 'proj-direct',
    };

    // Explicit model passed through unchanged
    expect(p.buildPromptCommand({ ...baseOpts, model: 'gemini-3.1-pro-high' })).toContain('--model "gemini-3.1-pro-high"');
    expect(p.buildPromptCommand({ ...baseOpts, model: 'foo-bar-model' })).toContain('--model "foo-bar-model"');
    expect(linux.buildAgentPromptCommand(p, { ...baseOpts, model: 'gemini-3.1-pro-high' })).toContain('--model "gemini-3.1-pro-high"');
    expect(linux.buildAgentPromptCommand(p, { ...baseOpts, model: 'foo-bar-model' })).toContain('--model "foo-bar-model"');
    expect(windows.buildAgentPromptCommand(p, { ...baseOpts, model: 'gemini-3.1-pro-high' })).toContain('--model "gemini-3.1-pro-high"');
    expect(windows.buildAgentPromptCommand(p, { ...baseOpts, model: 'foo-bar-model' })).toContain('--model "foo-bar-model"');

    // Tier defaults apply correctly
    expect(p.buildPromptCommand({ ...baseOpts, tier: 'cheap' })).toContain(`--model "${p.modelForTier('cheap')}"`);
    expect(p.buildPromptCommand({ ...baseOpts, tier: 'standard' })).toContain(`--model "${p.modelForTier('standard')}"`);
    expect(p.buildPromptCommand({ ...baseOpts, tier: 'premium' })).toContain(`--model "${p.modelForTier('premium')}"`);
  });
});

describe('AgyProvider compose_permissions unmappable token warnings', () => {
  const p = new AgyProvider();

  it('surfaces dropped unmappable tokens (Agent, unmapped mcp, custom) in opts.warnings', () => {
    const warnings: string[] = [];
    const mockAgent = {
      id: 'agent-123',
      friendlyName: 'agy-agent',
      llmProvider: 'agy',
      workFolder: '/home/user/my-project',
      agyProjectId: '1afd6dbb-498f-4918-a9d9-6da64b75a204',
      os: 'linux',
    } as any;

    p.composePermissionConfig('doer', ['Agent', 'mcp__badformat', 'UnknownToken', 'Read'], mockAgent, {
      memberHomeDir: '/home/user',
      warnings,
    });

    expect(warnings.some(w => w.includes('agy: dropped "Agent"'))).toBe(true);
    expect(warnings.some(w => w.includes('agy: dropped "mcp__badformat"'))).toBe(true);
    expect(warnings.some(w => w.includes('agy: dropped "UnknownToken"'))).toBe(true);
  });
});
