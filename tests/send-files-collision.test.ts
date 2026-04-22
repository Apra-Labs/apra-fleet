import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { sendFiles } from '../src/tools/send-files.js';

const mockTransferFiles = vi.fn();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    transferFiles: mockTransferFiles,
    testConnection: vi.fn().mockResolvedValue({ ok: true, latencyMs: 1 }),
    close: vi.fn(),
  }),
}));

vi.mock('../src/services/cloud/lifecycle.js', () => ({
  ensureCloudReady: (agent: any) => Promise.resolve(agent),
}));

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
}));

vi.mock('../src/utils/agent-helpers.js', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/agent-helpers.js')>('../src/utils/agent-helpers.js');
  return { ...actual, touchAgent: vi.fn() };
});

describe('sendFiles - basename collision detection', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
  });
  afterEach(() => restoreRegistry());

  it('blocks transfer when two files share a basename', async () => {
    const agent = makeTestAgent({ friendlyName: 'test-member' });
    addAgent(agent);

    const result = await sendFiles({
      member_id: agent.id,
      local_paths: ['/a/dir/report.txt', '/b/dir/report.txt'],
    });

    expect(result).toContain('⛔');
    expect(result).toContain('report.txt');
    expect(mockTransferFiles).not.toHaveBeenCalled();
  });

  it('blocks when three files have two sharing a basename', async () => {
    const agent = makeTestAgent({ friendlyName: 'test-member' });
    addAgent(agent);

    const result = await sendFiles({
      member_id: agent.id,
      local_paths: ['/a/log.txt', '/b/unique.txt', '/c/log.txt'],
    });

    expect(result).toContain('⛔');
    expect(result).toContain('log.txt');
    expect(mockTransferFiles).not.toHaveBeenCalled();
  });

  it('allows transfer when all basenames are unique', async () => {
    const agent = makeTestAgent({ friendlyName: 'test-member' });
    addAgent(agent);
    mockTransferFiles.mockResolvedValue({ success: ['a.txt', 'b.txt'], failed: [] });

    const result = await sendFiles({
      member_id: agent.id,
      local_paths: ['/a/a.txt', '/b/b.txt'],
    });

    expect(result).not.toContain('⛔');
    expect(mockTransferFiles).toHaveBeenCalledOnce();
  });

  it('allows single file transfer without collision check issues', async () => {
    const agent = makeTestAgent({ friendlyName: 'test-member' });
    addAgent(agent);
    mockTransferFiles.mockResolvedValue({ success: ['only.txt'], failed: [] });

    const result = await sendFiles({
      member_id: agent.id,
      local_paths: ['/some/path/only.txt'],
    });

    expect(result).not.toContain('⛔');
    expect(mockTransferFiles).toHaveBeenCalledOnce();
  });
});
