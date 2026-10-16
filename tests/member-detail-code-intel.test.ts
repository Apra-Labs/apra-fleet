import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTestAgent, makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { memberDetail } from '../src/tools/member-detail.js';
import type { SSHExecResult } from '../src/types.js';

// member_detail reports code intelligence availability, with the npx/node
// cause and a remedy when the server's PATH lacks them (same detector as the
// code_* errors: npxUnavailableReason).

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();
const mockTestConnection = vi.fn<() => Promise<{ ok: boolean; latencyMs: number; error?: string }>>();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({ execCommand: mockExecCommand, testConnection: mockTestConnection, transferFiles: vi.fn(), close: vi.fn() }),
}));

type CodeIntel = { provider: string; available: boolean; cause?: string; remedy?: string } | null;

describe('member_detail codeIntel', () => {
  const realPath = process.env.PATH;
  let emptyDir: string;
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 3 });
    mockExecCommand.mockResolvedValue({ stdout: 'N/A', stderr: '', code: 0 });
    emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-codeintel-'));
  });
  afterEach(() => {
    process.env.PATH = realPath;
    fs.rmSync(emptyDir, { recursive: true, force: true });
    restoreRegistry();
  });

  async function json(agent = makeTestLocalAgent({ friendlyName: 'ci-member', codeIntelProvider: 'gitnexus' })) {
    addAgent(agent);
    return JSON.parse(await memberDetail({ member_id: agent.id, format: 'json' })) as { codeIntel: CodeIntel };
  }

  it('gitnexus member whose service PATH lacks npx: unavailable with the npx cause and a remedy', async () => {
    process.env.PATH = emptyDir;
    const d = await json();
    expect(d.codeIntel).toMatchObject({ provider: 'gitnexus', available: false });
    expect(d.codeIntel?.cause).toContain("npx was not found on the apra-fleet server's PATH");
    expect(d.codeIntel?.remedy).toMatch(/apra-fleet install|PATH/);
  });

  it('compact output carries the cause and the fix', async () => {
    process.env.PATH = emptyDir;
    const agent = makeTestLocalAgent({ friendlyName: 'ci-compact', codeIntelProvider: 'gitnexus' });
    addAgent(agent);
    const text = await memberDetail({ member_id: agent.id, format: 'compact' });
    expect(text).toContain('codeIntel=unavailable (gitnexus)');
    expect(text).toContain('codeIntel cause: npx was not found');
    expect(text).toContain('codeIntel fix:');
  });

  it('provider none is reported unavailable with a remedy; codebase-memory is available', async () => {
    const none = await json(makeTestLocalAgent({ friendlyName: 'ci-none', codeIntelProvider: 'none' }));
    expect(none.codeIntel).toMatchObject({ provider: 'none', available: false });
    expect(none.codeIntel?.remedy).toContain('code_intel_provider');
    const cm = await json(makeTestLocalAgent({ friendlyName: 'ci-cm', codeIntelProvider: 'codebase-memory' }));
    expect(cm.codeIntel).toEqual({ provider: 'codebase-memory', available: true });
  });

  it('a remote member is not judged against this server\'s PATH (codeIntel is null)', async () => {
    process.env.PATH = emptyDir;
    const d = await json(makeTestAgent({ friendlyName: 'ci-remote', codeIntelProvider: 'gitnexus' }));
    expect(d.codeIntel).toBeNull();
  });
});
