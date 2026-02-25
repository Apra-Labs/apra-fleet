import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { agentDetail } from '../src/tools/agent-detail.js';
import type { SSHExecResult } from '../src/types.js';

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

/** Default mock: all auth checks return "nothing found", other commands return safe defaults */
function setupDefaultMock() {
  mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 3 });
  mockExecCommand.mockImplementation(async (cmd: string) => {
    if (cmd.includes('.credentials.json')) return { stdout: 'missing', stderr: '', code: 0 };
    if (cmd.includes('ANTHROPIC_API_KEY')) return { stdout: '', stderr: '', code: 0 };
    if (cmd.includes('--version')) return { stdout: '1.0.42', stderr: '', code: 0 };
    if (cmd.includes('pgrep') || cmd.includes('wmic process')) return { stdout: 'idle', stderr: '', code: 0 };
    return { stdout: 'N/A', stderr: '', code: 0 };
  });
}

describe('agentDetail auth detection', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('reports "No authentication" when nothing is found', async () => {
    const agent = makeTestAgent({ friendlyName: 'bare-agent' });
    addAgent(agent);
    setupDefaultMock();

    const result = await agentDetail({ agent_id: agent.id });
    expect(result).toContain('No authentication detected');
  });

  it('detects both auth methods when present', async () => {
    const agent = makeTestAgent({ friendlyName: 'multi-auth' });
    addAgent(agent);
    setupDefaultMock();

    mockExecCommand.mockImplementation(async (cmd: string) => {
      if (cmd.includes('.credentials.json')) return { stdout: 'found', stderr: '', code: 0 };
      if (cmd.includes('ANTHROPIC_API_KEY')) return { stdout: 'sk-ant-api', stderr: '', code: 0 };
      if (cmd.includes('--version')) return { stdout: '1.0.42', stderr: '', code: 0 };
      if (cmd.includes('pgrep') || cmd.includes('wmic process')) return { stdout: 'idle', stderr: '', code: 0 };
      return { stdout: 'N/A', stderr: '', code: 0 };
    });

    const result = await agentDetail({ agent_id: agent.id });
    expect(result).toContain('OAuth credentials file');
    expect(result).toContain('API key (env)');
  });

  it('detects API key only', async () => {
    const agent = makeTestAgent({ friendlyName: 'apikey-only' });
    addAgent(agent);
    setupDefaultMock();

    mockExecCommand.mockImplementation(async (cmd: string) => {
      if (cmd.includes('.credentials.json')) return { stdout: 'missing', stderr: '', code: 0 };
      if (cmd.includes('ANTHROPIC_API_KEY')) return { stdout: 'sk-ant-api', stderr: '', code: 0 };
      if (cmd.includes('--version')) return { stdout: '1.0.42', stderr: '', code: 0 };
      if (cmd.includes('pgrep') || cmd.includes('wmic process')) return { stdout: 'idle', stderr: '', code: 0 };
      return { stdout: 'N/A', stderr: '', code: 0 };
    });

    const result = await agentDetail({ agent_id: agent.id });
    expect(result).toContain('API key (env)');
    expect(result).not.toContain('OAuth credentials file');
  });
});
