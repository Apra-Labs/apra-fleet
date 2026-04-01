/**
 * Integration tests for Phase 3 tool changes — provider-aware tools.
 *
 * Covers:
 * - execute-prompt with each provider (Claude, Gemini, Codex, Copilot)
 * - provision-auth API key flow for each provider
 * - update-agent-cli with each provider
 * - mixed fleet: Claude + Gemini member in same test
 * - fleetProcessCheck uses correct processName per provider
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { executePrompt } from '../src/tools/execute-prompt.js';
import { provisionAuth } from '../src/tools/provision-auth.js';
import { updateAgentCli } from '../src/tools/update-agent-cli.js';
import { getOsCommands } from '../src/os/index.js';
import { getProvider } from '../src/providers/index.js';
import type { SSHExecResult, LlmProvider } from '../src/types.js';

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();
const mockTestConnection = vi.fn<() => Promise<{ ok: boolean; latencyMs: number; error?: string }>>();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: mockTestConnection,
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

const mockCollectOobApiKey = vi.fn<() => Promise<{ password: string } | { fallback: string }>>();
vi.mock('../src/services/auth-socket.js', () => ({
  collectOobApiKey: (...args: unknown[]) => mockCollectOobApiKey(...(args as [])),
}));

// ---------------------------------------------------------------------------
// execute-prompt: each provider parses its own response format
// ---------------------------------------------------------------------------

describe('executePrompt — provider routing', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    restoreRegistry();
    vi.useRealTimers();
  });

  it('routes Claude member through claude CLI and parses JSON response', async () => {
    const agent = makeTestAgent({ friendlyName: 'claude-agent', llmProvider: 'claude' });
    addAgent(agent);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'claude response', session_id: 'sess-c' }),
      stderr: '',
      code: 0,
    });

    const result = await executePrompt({ member_id: agent.id, prompt: 'hi', resume: false, timeout_ms: 5000 });
    expect(result).toContain('claude response');
    expect(result).toContain('sess-c');

    const cmd = mockExecCommand.mock.calls[0][0] as string;
    expect(cmd).toContain('claude');
    expect(cmd).toContain('--output-format json');
  });

  it('routes Gemini member through gemini CLI and parses response', async () => {
    const agent = makeTestAgent({ friendlyName: 'gemini-agent', llmProvider: 'gemini' });
    addAgent(agent);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ response: 'gemini response' }),
      stderr: '',
      code: 0,
    });

    const result = await executePrompt({ member_id: agent.id, prompt: 'hi', resume: false, timeout_ms: 5000 });
    expect(result).toContain('gemini response');

    const cmd = mockExecCommand.mock.calls[0][0] as string;
    expect(cmd).toContain('gemini');
  });

  it('routes Codex member through codex CLI', async () => {
    const agent = makeTestAgent({ friendlyName: 'codex-agent', llmProvider: 'codex' });
    addAgent(agent);
    // Codex returns NDJSON — last line has the result
    const ndjson = [
      JSON.stringify({ type: 'start' }),
      JSON.stringify({ type: 'message', content: 'codex response' }),
      JSON.stringify({ type: 'done', exitCode: 0 }),
    ].join('\n');
    mockExecCommand.mockResolvedValue({ stdout: ndjson, stderr: '', code: 0 });

    const result = await executePrompt({ member_id: agent.id, prompt: 'hi', resume: false, timeout_ms: 5000 });
    expect(result).toBeDefined();

    const cmd = mockExecCommand.mock.calls[0][0] as string;
    expect(cmd).toContain('codex');
  });

  it('routes Copilot member through copilot CLI', async () => {
    const agent = makeTestAgent({ friendlyName: 'copilot-agent', llmProvider: 'copilot' });
    addAgent(agent);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'copilot response' }),
      stderr: '',
      code: 0,
    });

    const result = await executePrompt({ member_id: agent.id, prompt: 'hi', resume: false, timeout_ms: 5000 });
    expect(result).toBeDefined();

    const cmd = mockExecCommand.mock.calls[0][0] as string;
    expect(cmd).toContain('copilot');
  });

  it('mixed fleet: Claude and Gemini members use different CLIs', async () => {
    const claudeAgent = makeTestAgent({ id: 'claude-1', friendlyName: 'claude-1', llmProvider: 'claude' });
    const geminiAgent = makeTestAgent({ id: 'gemini-1', friendlyName: 'gemini-1', llmProvider: 'gemini' });
    addAgent(claudeAgent);
    addAgent(geminiAgent);

    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'ok' }),
      stderr: '',
      code: 0,
    });

    await executePrompt({ member_id: claudeAgent.id, prompt: 'hello', resume: false, timeout_ms: 5000 });
    const claudeCmd = mockExecCommand.mock.calls[0][0] as string;
    expect(claudeCmd).toContain('claude');
    expect(claudeCmd).not.toContain('gemini');

    mockExecCommand.mockClear();

    await executePrompt({ member_id: geminiAgent.id, prompt: 'hello', resume: false, timeout_ms: 5000 });
    const geminiCmd = mockExecCommand.mock.calls[0][0] as string;
    expect(geminiCmd).toContain('gemini');
    expect(geminiCmd).not.toContain('claude -p');
  });
});

// ---------------------------------------------------------------------------
// provision-auth: API key uses provider.authEnvVar
// ---------------------------------------------------------------------------

describe('provisionAuth — API key per provider', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreRegistry();
  });

  const providers: LlmProvider[] = ['claude', 'gemini', 'codex', 'copilot'];

  for (const llmProvider of providers) {
    it(`provisions ${llmProvider} API key using correct env var`, async () => {
      const agent = makeTestAgent({ friendlyName: `${llmProvider}-member`, llmProvider });
      addAgent(agent);
      mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
      mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

      const provider = getProvider(llmProvider);
      const result = await provisionAuth({ member_id: agent.id, api_key: 'test-key-12345' });

      expect(result).toContain('API key provisioned');

      const cmds = mockExecCommand.mock.calls.map(c => c[0] as string);
      expect(cmds.some(c => c.includes(provider.authEnvVar))).toBe(true);
    });
  }

  it('uses OOB API key entry for non-Claude providers without api_key', async () => {
    const agent = makeTestAgent({ friendlyName: 'gemini-oauth', llmProvider: 'gemini' });
    addAgent(agent);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockCollectOobApiKey.mockResolvedValue({ fallback: '🔐 Could not open terminal. Run manually.' });

    const result = await provisionAuth({ member_id: agent.id });
    expect(mockCollectOobApiKey).toHaveBeenCalledWith('gemini-oauth', 'provision_auth');
    expect(result).toContain('Could not open terminal');
  });
});

// ---------------------------------------------------------------------------
// update-agent-cli: uses provider install/update commands
// ---------------------------------------------------------------------------

describe('updateAgentCli — provider install/update', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('uses gemini version command when member is gemini provider', async () => {
    const agent = makeTestAgent({ friendlyName: 'gemini-member', llmProvider: 'gemini' });
    addAgent(agent);
    mockExecCommand
      .mockResolvedValueOnce({ stdout: 'gemini 1.0.0', stderr: '', code: 0 })  // version before
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })               // update
      .mockResolvedValueOnce({ stdout: 'gemini 1.1.0', stderr: '', code: 0 }); // version after

    const result = await updateAgentCli({ member_id: agent.id });
    expect(result).toContain('gemini-member');

    const cmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    expect(cmds.some(c => c.includes('gemini'))).toBe(true);
  });

  it('defaults to claude when llmProvider is undefined', async () => {
    const agent = makeTestAgent({ friendlyName: 'default-member' });
    addAgent(agent);
    mockExecCommand
      .mockResolvedValueOnce({ stdout: 'claude 1.0.0', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: 'claude 1.1.0', stderr: '', code: 0 });

    await updateAgentCli({ member_id: agent.id });

    const cmds = mockExecCommand.mock.calls.map(c => c[0] as string);
    expect(cmds.some(c => c.includes('claude'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fleetProcessCheck: processName parameter
// ---------------------------------------------------------------------------

/** Checks that a command references a process name, accounting for Linux's
 *  bracket-escape trick where `claude` becomes `[c]laude`. */
function commandReferencesProcess(cmd: string, name: string): boolean {
  return cmd.includes(name) || cmd.includes(`[${name[0]}]${name.slice(1)}`);
}

describe('fleetProcessCheck — processName per provider', () => {
  const linux = getOsCommands('linux');
  const windows = getOsCommands('windows');

  const cases: { provider: LlmProvider; processName: string }[] = [
    { provider: 'claude', processName: 'claude' },
    { provider: 'gemini', processName: 'gemini' },
    { provider: 'codex', processName: 'codex' },
    { provider: 'copilot', processName: 'copilot' },
  ];

  for (const { provider, processName } of cases) {
    it(`linux: fleetProcessCheck uses "${processName}" for ${provider}`, () => {
      const cmd = linux.fleetProcessCheck('/work', undefined, processName);
      expect(commandReferencesProcess(cmd, processName)).toBe(true);
    });

    it(`windows: fleetProcessCheck uses "${processName}" for ${provider}`, () => {
      const cmd = windows.fleetProcessCheck('C:\\work', undefined, processName);
      expect(cmd).toContain(processName);
    });
  }

  it('linux: defaults to claude when no processName given', () => {
    const cmd = linux.fleetProcessCheck('/work');
    expect(commandReferencesProcess(cmd, 'claude')).toBe(true);
  });

  it('windows: defaults to claude when no processName given', () => {
    const cmd = windows.fleetProcessCheck('C:\\work');
    expect(cmd).toContain('claude');
  });
});
