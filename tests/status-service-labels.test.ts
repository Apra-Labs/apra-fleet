/**
 * `apra-fleet status` service lines -- label + run-state matrix.
 *
 * REGRESSION CONTEXT (the bug this file exists for): on a fresh Windows
 * install both scheduled tasks (ApraFleet, ApraFleetSupervisor) were running
 * and answering /health, yet `apra-fleet status` listed BOTH as "installed
 * (disabled)". Two causes: the Windows manager never populated
 * ServiceStatus.enabled, and src/cli/status.ts rendered any non-true `enabled`
 * -- including undefined -- as a definite "disabled". The second half is what
 * is pinned here.
 *
 * runStatus() is driven with getServiceManager() mocked so each of the two
 * services returns a chosen ServiceStatus, and console.log is captured. Every
 * expected string below is written out LITERALLY rather than computed from
 * serviceLabelFor()/runStateFor(), so a revert on the production side cannot
 * quietly move the expectation with it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';

// Service-id-aware manager mock: the MCP server and the fleet supervisor are
// two independently registered OS services, so a single shared mock could not
// tell their two status lines apart.
const { mockGetSvcMgr, mcpMgr, supervisorMgr, mockCheckRunning } = vi.hoisted(() => {
  const makeMgr = (serviceId: string) => ({
    serviceId,
    register: vi.fn<(...a: any[]) => Promise<void>>().mockResolvedValue(undefined),
    unregister: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    start: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    stop: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    query: vi.fn<() => Promise<any>>().mockResolvedValue({ installed: false, running: false }),
    isInstalled: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
  });
  const mcpMgr = makeMgr('mcp-server');
  const supervisorMgr = makeMgr('fleet-supervisor');
  return {
    mcpMgr,
    supervisorMgr,
    mockGetSvcMgr: vi.fn(async (id?: string) => (id === 'fleet-supervisor' ? supervisorMgr : mcpMgr)),
    mockCheckRunning: vi.fn<() => Promise<any>>().mockResolvedValue({ running: false }),
  };
});

vi.mock('../src/services/service-manager/index.js', () => ({
  getServiceManager: mockGetSvcMgr,
}));
vi.mock('../src/services/singleton.js', () => ({
  checkRunningInstance: mockCheckRunning,
}));

import { runStatus } from '../src/cli/status.js';

/** Explicit ServiceStatus fixtures -- the four states an operator can be in. */
const ENABLED_RUNNING = { installed: true, running: true, enabled: true };
/** Today's macOS shape, and a Windows host whose task-state probe cannot run. */
const UNKNOWN_ENABLE_RUNNING = { installed: true, running: true };
const UNKNOWN_ENABLE_STOPPED = { installed: true, running: false };
const DISABLED_STOPPED = { installed: true, running: false, enabled: false };
const NOT_INSTALLED = { installed: false, running: false };

const STOPPED_INSTANCE = { running: false as const };
const RUNNING_INSTANCE = { running: true as const, url: 'http://127.0.0.1:7523/mcp', pid: 1234 };
const SERVER_INFO = JSON.stringify({ pid: 1234, port: 7523, url: 'http://127.0.0.1:7523/mcp' });
const HEALTH_BODY = JSON.stringify({ version: 'v0.1', uptime: 30, sessions: 1 });

describe('apra-fleet status service lines', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRunning.mockResolvedValue(STOPPED_INSTANCE);
    for (const mgr of [mcpMgr, supervisorMgr]) {
      mgr.query.mockReset().mockResolvedValue(NOT_INSTALLED);
    }
    // readServerInfo() / getHealth() are stubbed so nothing touches the real
    // installed tree or a real socket -- this suite is about the two labels.
    vi.spyOn(fs, 'readFileSync').mockReturnValue(SERVER_INFO as any);
    const mockReq = { on: vi.fn().mockReturnThis(), end: vi.fn(), destroy: vi.fn() };
    vi.spyOn(http, 'get').mockImplementation((_opts: any, cb?: (res: any) => void) => {
      cb?.({
        on(ev: string, handler: (...a: any[]) => void) {
          if (ev === 'data') handler(Buffer.from(HEALTH_BODY));
          if (ev === 'end') handler();
        },
      });
      return mockReq as any;
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function output(): string {
    return logSpy.mock.calls.map(c => c.join(' ')).join('\n');
  }

  function mcpLine(): string {
    return output().split('\n').find(l => l.includes('Service (MCP server):'))!;
  }

  function supervisorLine(): string {
    return output().split('\n').find(l => l.includes('Service (fleet supervisor):'))!;
  }

  /**
   * Run both code paths of runStatus(): the stopped branch
   * (checkRunningInstance -> not running, the early return) and the running
   * branch. Neither may lose the label or the run state.
   */
  const BRANCHES: Array<{ name: string; instance: any }> = [
    { name: 'server stopped (early-return branch)', instance: STOPPED_INSTANCE },
    { name: 'server running (health branch)', instance: RUNNING_INSTANCE },
  ];

  describe.each(BRANCHES)('$name', ({ instance }) => {
    beforeEach(() => {
      mockCheckRunning.mockResolvedValue(instance);
    });

    it('enabled + running: BOTH service lines read "installed (enabled), running"', async () => {
      mcpMgr.query.mockResolvedValue(ENABLED_RUNNING);
      supervisorMgr.query.mockResolvedValue(ENABLED_RUNNING);
      await runStatus([]);
      expect(mcpLine()).toContain('installed (enabled), running');
      expect(supervisorLine()).toContain('installed (enabled), running');
    });

    it('REGRESSION: an enabled service is never described as disabled anywhere', async () => {
      mcpMgr.query.mockResolvedValue(ENABLED_RUNNING);
      supervisorMgr.query.mockResolvedValue(ENABLED_RUNNING);
      await runStatus([]);
      // The reported bug: two running, enabled, health-answering tasks were
      // both printed as "installed (disabled)".
      expect(output()).not.toContain('disabled');
    });

    it('REGRESSION: an UNKNOWN enable state is never described as disabled', async () => {
      // enabled === undefined means "this platform could not tell", which is
      // not the same claim as "disabled". Plain "installed" is the honest label.
      mcpMgr.query.mockResolvedValue(UNKNOWN_ENABLE_RUNNING);
      supervisorMgr.query.mockResolvedValue(UNKNOWN_ENABLE_RUNNING);
      await runStatus([]);
      expect(output()).not.toContain('disabled');
      expect(mcpLine()).toContain('installed, running');
      expect(supervisorLine()).toContain('installed, running');
    });

    it('unknown enable state + stopped reads "installed, stopped"', async () => {
      mcpMgr.query.mockResolvedValue(UNKNOWN_ENABLE_STOPPED);
      supervisorMgr.query.mockResolvedValue(UNKNOWN_ENABLE_STOPPED);
      await runStatus([]);
      expect(mcpLine()).toContain('installed, stopped');
      expect(supervisorLine()).toContain('installed, stopped');
      expect(output()).not.toContain('disabled');
    });

    it('a genuinely disabled service reads "installed (disabled), stopped"', async () => {
      mcpMgr.query.mockResolvedValue(DISABLED_STOPPED);
      supervisorMgr.query.mockResolvedValue(DISABLED_STOPPED);
      await runStatus([]);
      expect(mcpLine()).toContain('installed (disabled), stopped');
      expect(supervisorLine()).toContain('installed (disabled), stopped');
    });

    it('an unregistered service reads "not installed" with no run-state suffix', async () => {
      mcpMgr.query.mockResolvedValue(NOT_INSTALLED);
      supervisorMgr.query.mockResolvedValue(NOT_INSTALLED);
      await runStatus([]);
      for (const line of [mcpLine(), supervisorLine()]) {
        expect(line).toContain('not installed');
        expect(line).not.toContain('stopped');
        expect(line).not.toContain('running');
      }
    });

    it('the two services are labelled independently, each with its own run state', async () => {
      mcpMgr.query.mockResolvedValue(ENABLED_RUNNING);
      supervisorMgr.query.mockResolvedValue(DISABLED_STOPPED);
      await runStatus([]);
      expect(mcpLine()).toContain('installed (enabled), running');
      expect(supervisorLine()).toContain('installed (disabled), stopped');
    });
  });
});
