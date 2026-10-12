/**
 * Local member registration stays within its time bound when an onboarding
 * probe hangs (apra-fleet-njeb).
 *
 * A local Windows registration took 82s: every member probe is a PowerShell
 * cold start, and the loopback fleetMcp member-session probe had no bound at
 * all. These tests drive a LOCAL registration through a fake exec / fake
 * member session where one probe never returns, with a short injected bound,
 * and assert registration returns within that bound, the member is
 * registered, and the result names the degraded probe. A normal run (nothing
 * hangs) must be unchanged: no degraded line, no timeout warning.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupAndResetRegistry, restoreRegistry, makeConfigAwareExec } from './test-helpers.js';
import { registerMember } from '../src/tools/register-member.js';
import { getAllAgents } from '../src/services/registry.js';
import {
  __setMemberFleetMcpDeps,
  defaultMemberFleetMcpDeps,
  type MemberSession,
} from '../src/services/member-fleet-install.js';
import type { SSHExecResult } from '../src/types.js';

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: async () => ({ ok: true, latencyMs: 0 }),
    transferFiles: vi.fn(),
    receiveFiles: vi.fn(),
    deleteFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
}));

const NEVER = <T>() => new Promise<T>(() => {});
const BOUND = 250;
/** Generous slack for a contended CI host; the hang itself is infinite. */
const SLACK = 5_000;

function decodeIfEncoded(command: string): string {
  const m = /-EncodedCommand\s+(\S+)/.exec(command);
  return m ? Buffer.from(m[1], 'base64').toString('utf16le') : command;
}

function isShellProbe(cmd: string): boolean {
  const script = decodeIfEncoded(cmd);
  return script.includes('BASHCAND:') || script.includes('PSMAJOR:') || script.includes('PSEDITION:');
}

/** A healthy local member session: version answers, kb_* and code_* listed. */
function healthySession(): MemberSession {
  return {
    mcpClient: {
      callTool: async () => ({ content: [{ type: 'text', text: 'apra-fleet v0.5.0' }] }),
      listTools: async () => ({ tools: [{ name: 'kb_query' }, { name: 'code_impact' }] }),
    },
    close: async () => {},
  };
}

function useFleetMcp(connect: () => Promise<MemberSession>) {
  __setMemberFleetMcpDeps({
    ...defaultMemberFleetMcpDeps(),
    connectLocalMember: connect,
    roleAgents: async () => ({ ok: true }),
  });
}

describe('register_member (local): a hanging onboarding probe is bounded', () => {
  let workFolder: string;
  let platform: PropertyDescriptor | undefined;

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    workFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'njeb-bounds-'));
    platform = Object.getOwnPropertyDescriptor(process, 'platform');
    mockExecCommand.mockImplementation(makeConfigAwareExec(''));
  });

  afterEach(() => {
    if (platform) Object.defineProperty(process, 'platform', platform);
    __setMemberFleetMcpDeps(null);
    restoreRegistry();
    fs.rmSync(workFolder, { recursive: true, force: true });
  });

  it('a local member session that never opens: returns within the fleet-mcp bound, member registered, fleet-mcp degraded', async () => {
    useFleetMcp(() => NEVER<MemberSession>());

    const started = Date.now();
    const result = await registerMember(
      { friendly_name: 'local-mcp-hang', member_type: 'local', work_folder: workFolder, llm_provider: 'claude' } as never,
      { stepBoundsMs: { 'fleet-mcp': BOUND } },
    );
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(BOUND + SLACK);
    expect(result).toContain('registered successfully');
    expect(result).toContain('fleetMcp: unavailable (probe-failed) -- fleetMcp probe timed out after 250ms');
    expect(result).toContain('Degraded: fleet-mcp (timed out after 250ms)');
    const agent = getAllAgents().find(a => a.friendlyName === 'local-mcp-hang');
    expect(agent).toBeTruthy();
    // The timeout is recorded on the member, not just printed.
    expect(agent!.fleetMcp).toMatchObject({ state: 'unavailable', reason: 'probe-failed' });
  });

  it('a local Windows member whose shell probe never returns: returns within the shell-probe bound with powershell5 and shell-probe degraded', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const configExec = makeConfigAwareExec('');
    mockExecCommand.mockImplementation(async (cmd: string) => (isShellProbe(cmd) ? NEVER<SSHExecResult>() : configExec(cmd)));
    useFleetMcp(async () => healthySession());

    const started = Date.now();
    const result = await registerMember(
      { friendly_name: 'local-win-hang', member_type: 'local', work_folder: workFolder, llm_provider: 'claude' } as never,
      { stepBoundsMs: { 'shell-probe': BOUND } },
    );
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(BOUND + SLACK);
    expect(result).toContain('registered successfully');
    expect(result).toContain('OS:      windows');
    expect(result).toContain('Degraded: shell-probe (timed out after 250ms)');
    const agent = getAllAgents().find(a => a.friendlyName === 'local-win-hang');
    expect(agent?.shell).toBe('powershell5');
  });

  it('a normal local run is unchanged: no degraded line, no timeout warning, fleetMcp available', async () => {
    useFleetMcp(async () => healthySession());

    const result = await registerMember(
      { friendly_name: 'local-normal', member_type: 'local', work_folder: workFolder, llm_provider: 'claude' } as never,
      { stepBoundsMs: { 'fleet-mcp': BOUND, 'shell-probe': BOUND, 'cli-version': BOUND } },
    );

    expect(result).toContain('registered successfully');
    expect(result).toContain('fleetMcp: available (apra-fleet v0.5.0)');
    expect(result).not.toContain('Degraded:');
    expect(result).not.toContain('did not finish within');
    expect(getAllAgents().find(a => a.friendlyName === 'local-normal')?.fleetMcp?.state).toBe('available');
  });
});
