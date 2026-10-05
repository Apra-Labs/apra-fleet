import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { memberDetail } from '../src/tools/member-detail.js';
import { FLEET_MCP_FIX, fleetMcpFixLine } from '../src/services/member-fleet-install.js';
import type { SSHExecResult, FleetMcpStatus } from '../src/types.js';

// b4g.65.2/65.3: member_detail prints the fleetMcp reason and a one-line fix
// whenever the member's KB/code tools are not usable.

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();
const mockTestConnection = vi.fn<() => Promise<{ ok: boolean; latencyMs: number; error?: string }>>();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({ execCommand: mockExecCommand, testConnection: mockTestConnection, transferFiles: vi.fn(), close: vi.fn() }),
}));

async function detail(fleetMcp: FleetMcpStatus | undefined, format: 'json' | 'compact'): Promise<string> {
  const member = makeTestAgent({ friendlyName: 'fix-member', fleetMcp });
  addAgent(member);
  return memberDetail({ member_id: member.id, format });
}

describe('member_detail fleetMcp fix line', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 3 });
    mockExecCommand.mockResolvedValue({ stdout: 'N/A', stderr: '', code: 0 });
  });
  afterEach(() => restoreRegistry());

  const unavailable: FleetMcpStatus = { state: 'unavailable', reason: 'mcp-entry-missing', detail: 'no entry', checkedAt: 'x' };
  const agy: FleetMcpStatus = { state: 'unavailable', reason: 'no-per-project-mcp', unverified: true, checkedAt: 'x' };
  const ok: FleetMcpStatus = { state: 'available', version: '1.2.3', checkedAt: 'x' };

  it('unavailable (mcp-entry-missing): text shows reason and a one-line fix; JSON carries fleetMcpFix', async () => {
    const text = await detail(unavailable, 'compact');
    expect(text).toContain('fleetMcp=unavailable (mcp-entry-missing)');
    const fixLine = text.split('\n').find(l => l.includes('fleetMcp fix:'));
    expect(fixLine).toBeDefined();
    expect(fixLine).toContain('compose_permissions');
    const json = JSON.parse(await detail(unavailable, 'json')) as { fleetMcpFix: string; fleetMcp: { reason: string } };
    expect(json.fleetMcp.reason).toBe('mcp-entry-missing');
    expect(json.fleetMcpFix).toBe(FLEET_MCP_FIX['mcp-entry-missing']);
    expect(json.fleetMcpFix).not.toContain('\n');
  });

  it('agy (unverified, no-per-project-mcp) shows a reason and a fix', async () => {
    const text = await detail(agy, 'compact');
    expect(text).toContain('(no-per-project-mcp)');
    expect(text).toContain(`fleetMcp fix: ${FLEET_MCP_FIX['no-per-project-mcp']}`);
  });

  it('an available, verified member shows no fix line and a null fleetMcpFix', async () => {
    expect(await detail(ok, 'compact')).not.toContain('fleetMcp fix');
    const json = JSON.parse(await detail(ok, 'json')) as { fleetMcpFix: string | null };
    expect(json.fleetMcpFix).toBeNull();
  });

  it('every fix is a single ASCII line and an unknown reason still gets a generic fix', () => {
    for (const [reason, fix] of Object.entries(FLEET_MCP_FIX)) {
      expect(fix, reason).toMatch(/^[\x20-\x7e]+$/);
    }
    expect(fleetMcpFixLine({ state: 'unavailable', reason: 'brand-new-reason' })).toContain('refresh:true');
    expect(fleetMcpFixLine(null)).toBeNull();
  });
});
