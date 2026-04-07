import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { memberDetail } from '../src/tools/member-detail.js';
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

describe('memberDetail branch display', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('includes branch in json output when workFolder is a git repo', async () => {
    const agent = makeTestAgent({ friendlyName: 'branch-agent' });
    addAgent(agent);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 3 });
    mockExecCommand.mockImplementation(async (cmd: string) => {
      if (cmd.includes('.credentials.json')) return { stdout: 'missing', stderr: '', code: 0 };
      if (cmd.includes('ANTHROPIC_API_KEY')) return { stdout: '', stderr: '', code: 0 };
      if (cmd.includes('--version')) return { stdout: '1.0.42', stderr: '', code: 0 };
      if (cmd.includes('pgrep') || cmd.includes('wmic process')) return { stdout: 'idle', stderr: '', code: 0 };
      if (cmd.includes('branch --show-current')) return { stdout: 'main\n', stderr: '', code: 0 };
      return { stdout: 'N/A', stderr: '', code: 0 };
    });

    const result = JSON.parse(await memberDetail({ member_id: agent.id, format: 'json' }));
    expect(result.branch).toBe('main');
  });

  it('omits branch from output when not a git repo', async () => {
    const agent = makeTestAgent({ friendlyName: 'no-git-agent' });
    addAgent(agent);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 3 });
    mockExecCommand.mockImplementation(async (cmd: string) => {
      if (cmd.includes('.credentials.json')) return { stdout: 'missing', stderr: '', code: 0 };
      if (cmd.includes('ANTHROPIC_API_KEY')) return { stdout: '', stderr: '', code: 0 };
      if (cmd.includes('--version')) return { stdout: '1.0.42', stderr: '', code: 0 };
      if (cmd.includes('pgrep') || cmd.includes('wmic process')) return { stdout: 'idle', stderr: '', code: 0 };
      if (cmd.includes('branch --show-current')) return { stdout: '', stderr: '', code: 0 };
      return { stdout: 'N/A', stderr: '', code: 0 };
    });

    const result = JSON.parse(await memberDetail({ member_id: agent.id, format: 'json' }));
    expect(result.branch).toBeUndefined();
  });
});

describe('memberDetail auth detection', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('reports no auth when nothing is found', async () => {
    const agent = makeTestAgent({ friendlyName: 'bare-agent' });
    addAgent(agent);
    setupDefaultMock();

    const result = JSON.parse(await memberDetail({ member_id: agent.id, format: 'json' }));
    expect(result.llm_cli.auth).toBe('none');
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

    const result = JSON.parse(await memberDetail({ member_id: agent.id, format: 'json' }));
    expect(result.llm_cli.auth).toBe('api-key (WARNING: OAuth also present — API key takes precedence)');
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

    const result = JSON.parse(await memberDetail({ member_id: agent.id, format: 'json' }));
    expect(result.llm_cli.auth).toBe('api-key');
    expect(result.llm_cli.auth).not.toContain('OAuth');
  });
});
