import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent, getAgent } from '../src/services/registry.js';
import { updateMember } from '../src/tools/update-member.js';
import { listMembers } from '../src/tools/list-members.js';
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

beforeEach(() => backupAndResetRegistry());
afterEach(() => restoreRegistry());

beforeEach(() => {
  vi.clearAllMocks();
});

describe('gbrain config — register_member', () => {
  it('agent with gbrain: true persists the field', () => {
    const agent = makeTestAgent({ gbrain: true });
    addAgent(agent);
    const stored = getAgent(agent.id);
    expect(stored?.gbrain).toBe(true);
  });

  it('agent without gbrain field defaults to undefined (falsy)', () => {
    const agent = makeTestAgent();
    addAgent(agent);
    const stored = getAgent(agent.id);
    expect(stored?.gbrain).toBeFalsy();
  });

  it('local agent supports gbrain field', () => {
    const agent = makeTestLocalAgent({ gbrain: true });
    addAgent(agent);
    const stored = getAgent(agent.id);
    expect(stored?.gbrain).toBe(true);
  });
});

describe('gbrain config — update_member', () => {
  it('enables gbrain on an existing member', async () => {
    const agent = makeTestAgent({ gbrain: false });
    addAgent(agent);

    const result = await updateMember({ member_id: agent.id, gbrain: true });
    expect(result).toContain('updated');

    const stored = getAgent(agent.id);
    expect(stored?.gbrain).toBe(true);
  });

  it('disables gbrain on an existing member', async () => {
    const agent = makeTestAgent({ gbrain: true });
    addAgent(agent);

    const result = await updateMember({ member_id: agent.id, gbrain: false });
    expect(result).toContain('updated');

    const stored = getAgent(agent.id);
    expect(stored?.gbrain).toBe(false);
  });
});

describe('gbrain config — list_members display', () => {
  it('compact output includes gbrain=enabled for gbrain member', async () => {
    const agent = makeTestLocalAgent({ gbrain: true, friendlyName: 'brain-member' });
    addAgent(agent);

    const output = await listMembers({});
    expect(output).toContain('gbrain=enabled');
  });

  it('compact output omits gbrain line for non-gbrain member', async () => {
    const agent = makeTestLocalAgent({ gbrain: false, friendlyName: 'plain-member' });
    addAgent(agent);

    const output = await listMembers({});
    expect(output).not.toContain('gbrain=enabled');
  });

  it('json output includes gbrain field for each member', async () => {
    const agent = makeTestLocalAgent({ gbrain: true, friendlyName: 'json-brain-member' });
    addAgent(agent);

    const output = await listMembers({ format: 'json' });
    const parsed = JSON.parse(output);
    expect(parsed.members[0].gbrain).toBe(true);
  });
});

describe('gbrain config — member_detail display', () => {
  beforeEach(() => {
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 3 });
    mockExecCommand.mockImplementation(async (cmd: string) => {
      if (cmd.includes('.credentials.json')) return { stdout: 'missing', stderr: '', code: 0 };
      if (cmd.includes('ANTHROPIC_API_KEY')) return { stdout: '', stderr: '', code: 0 };
      if (cmd.includes('--version')) return { stdout: '1.0.42', stderr: '', code: 0 };
      if (cmd.includes('pgrep') || cmd.includes('wmic process')) return { stdout: 'idle', stderr: '', code: 0 };
      return { stdout: 'N/A', stderr: '', code: 0 };
    });
  });

  it('compact output includes gbrain=enabled for gbrain member', async () => {
    const agent = makeTestAgent({ gbrain: true, friendlyName: 'detail-brain' });
    addAgent(agent);

    const output = await memberDetail({ member_id: agent.id });
    expect(output).toContain('gbrain=enabled');
  });

  it('compact output omits gbrain for non-gbrain member', async () => {
    const agent = makeTestAgent({ gbrain: false, friendlyName: 'detail-plain' });
    addAgent(agent);

    const output = await memberDetail({ member_id: agent.id });
    expect(output).not.toContain('gbrain=enabled');
  });

  it('json output includes gbrain field', async () => {
    const agent = makeTestAgent({ gbrain: true, friendlyName: 'detail-json-brain' });
    addAgent(agent);

    const output = await memberDetail({ member_id: agent.id, format: 'json' });
    const parsed = JSON.parse(output);
    expect(parsed.gbrain).toBe(true);
  });
});
