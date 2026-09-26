import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Hoisted, SERVICE-ID-AWARE service manager mock.
//
// The whole point of this epic is that there are now TWO independently
// registered services, so a single shared mock (as tests/cli-verbs.test.ts
// uses) could not tell "started the MCP server" from "started the
// supervisor". getServiceManager(id) here hands back a different mock per id.
// ---------------------------------------------------------------------------
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
vi.mock('node:child_process');

import {
  SUPERVISOR_SUBCOMMAND,
  registerSupervisorService,
  unregisterSupervisorService,
} from '../src/services/supervisor-service.js';
// Canonical home of the installed-tree constants (one definition, not two).
import {
  SUPERVISOR_SERVE_SCRIPT,
  SUPERVISOR_WORKING_DIR,
} from '../src/cli/supervisor.js';
import { SUPERVISOR_LOG_FILE_PATH } from '../src/paths.js';
import { WORKFLOWS_DIR } from '../src/cli/config.js';
import { runStart } from '../src/cli/start.js';
import { runStop } from '../src/cli/stop.js';
import { runStatus } from '../src/cli/status.js';

function resetMgrMocks() {
  for (const mgr of [mcpMgr, supervisorMgr]) {
    mgr.register.mockReset().mockResolvedValue(undefined);
    mgr.unregister.mockReset().mockResolvedValue(undefined);
    mgr.start.mockReset().mockResolvedValue(undefined);
    mgr.stop.mockReset().mockResolvedValue(undefined);
    mgr.query.mockReset().mockResolvedValue({ installed: false, running: false });
    mgr.isInstalled.mockReset().mockResolvedValue(false);
  }
  mockGetSvcMgr.mockClear();
}

// ---------------------------------------------------------------------------
// Installed-layout constants
// ---------------------------------------------------------------------------
describe('supervisor installed layout', () => {
  it('points at the fleet-sprint built-in workflow tree staged by the installer', () => {
    // install.ts's workflow step extracts packages/apra-fleet-se under the
    // 'fleet-sprint' built-in name into WORKFLOWS_DIR, so bin/serve.mjs lands here.
    expect(SUPERVISOR_WORKING_DIR).toBe(path.join(WORKFLOWS_DIR, 'fleet-sprint'));
    expect(SUPERVISOR_SERVE_SCRIPT).toBe(path.join(WORKFLOWS_DIR, 'fleet-sprint', 'bin', 'serve.mjs'));
  });
});

// ---------------------------------------------------------------------------
// registerSupervisorService
// ---------------------------------------------------------------------------
describe('registerSupervisorService', () => {
  const BINARY = '/home/dev/.apra-fleet/bin/apra-fleet';
  const savedDataDir = process.env.APRA_FLEET_DATA_DIR;

  beforeEach(() => {
    vi.clearAllMocks();
    resetMgrMocks();
    // A machine-global unit is refused for an overridden instance, and
    // tests/setup.ts always sets APRA_FLEET_DATA_DIR -- so the happy path is
    // unreachable unless that override is cleared here.
    delete process.env.APRA_FLEET_DATA_DIR;
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
  });

  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.APRA_FLEET_DATA_DIR;
    else process.env.APRA_FLEET_DATA_DIR = savedDataDir;
    vi.restoreAllMocks();
  });

  it('registers the apra-fleet binary supervisor subcommand, its own log and WorkingDirectory', async () => {
    const result = await registerSupervisorService(BINARY);
    expect(result).toEqual({ registered: true });
    expect(mockGetSvcMgr).toHaveBeenCalledWith('fleet-supervisor');
    expect(supervisorMgr.register).toHaveBeenCalledWith(
      BINARY,
      [SUPERVISOR_SUBCOMMAND],
      SUPERVISOR_LOG_FILE_PATH,
      { workingDirectory: SUPERVISOR_WORKING_DIR },
    );
    expect(SUPERVISOR_SUBCOMMAND).toBe('supervisor');
    expect(supervisorMgr.start).toHaveBeenCalled();
    // The MCP server's own service must not be touched.
    expect(mcpMgr.register).not.toHaveBeenCalled();
    expect(mcpMgr.start).not.toHaveBeenCalled();
  });

  it('puts no node path and no serve.mjs path in the registered command', async () => {
    await registerSupervisorService(BINARY);
    const [execArg, argsArg] = supervisorMgr.register.mock.calls[0];
    expect(String(execArg)).toBe(BINARY);
    expect(argsArg).toEqual(['supervisor']);
    expect(JSON.stringify([execArg, argsArg])).not.toContain('serve.mjs');
  });

  it('uses a log file distinct from the MCP server log', async () => {
    await registerSupervisorService(BINARY);
    const logArg = String(supervisorMgr.register.mock.calls[0][2]);
    expect(logArg).toContain('fleet-supervisor.log');
    expect(logArg).not.toMatch(/[\\/]fleet\.log$/);
  });

  it('reports a reason when the installed serve.mjs is missing', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const result = await registerSupervisorService(BINARY);
    expect(result.registered).toBe(false);
    expect(result.reason).toContain('serve.mjs');
    expect(supervisorMgr.register).not.toHaveBeenCalled();
  });

  it('refuses to bake a machine-global unit for an overridden instance', async () => {
    process.env.APRA_FLEET_DATA_DIR = '/tmp/sandboxed';
    const result = await registerSupervisorService(BINARY);
    expect(result.registered).toBe(false);
    expect(result.reason).toContain('APRA_FLEET_DATA_DIR');
    expect(supervisorMgr.register).not.toHaveBeenCalled();
  });

  it('reports the reason instead of throwing when register fails', async () => {
    supervisorMgr.register.mockRejectedValueOnce(new Error('systemd user mode is not available'));
    const result = await registerSupervisorService(BINARY);
    expect(result).toEqual({ registered: false, reason: 'systemd user mode is not available' });
  });

  it('rolls the registration back when start fails, leaving no half-registered unit', async () => {
    supervisorMgr.start.mockRejectedValueOnce(new Error('Failed to start fleet-supervisor.service'));
    const result = await registerSupervisorService(BINARY);
    expect(result.registered).toBe(false);
    expect(supervisorMgr.unregister).toHaveBeenCalled();
  });

  it('unregisterSupervisorService never throws', async () => {
    supervisorMgr.unregister.mockRejectedValueOnce(new Error('unit not found'));
    await expect(unregisterSupervisorService()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// CLI wiring: start / stop / status
//
// start.ts skips machine-global service registrations for sandboxed instances
// (non-default port/data dir). tests/setup.ts always sets APRA_FLEET_DATA_DIR,
// so the supervisor path is unreachable unless that override is cleared here.
// ---------------------------------------------------------------------------
describe('CLI supervisor wiring', () => {
  const savedDataDir = process.env.APRA_FLEET_DATA_DIR;

  beforeEach(() => {
    vi.clearAllMocks();
    resetMgrMocks();
    delete process.env.APRA_FLEET_DATA_DIR;
    mockCheckRunning.mockResolvedValue({ running: false });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);
  });

  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.APRA_FLEET_DATA_DIR;
    else process.env.APRA_FLEET_DATA_DIR = savedDataDir;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('runStart', () => {
    it('starts the supervisor service even when the MCP server is already running', async () => {
      mockCheckRunning.mockResolvedValue({ running: true, url: 'http://127.0.0.1:7523/mcp', pid: 1 });
      supervisorMgr.isInstalled.mockResolvedValue(true);
      await runStart([]);
      expect(supervisorMgr.start).toHaveBeenCalled();
      // The MCP server service is still deliberately left alone in this path.
      expect(mcpMgr.start).not.toHaveBeenCalled();
    });

    it('does not start the supervisor when its service is not registered', async () => {
      mockCheckRunning.mockResolvedValue({ running: true, url: 'http://127.0.0.1:7523/mcp', pid: 1 });
      supervisorMgr.isInstalled.mockResolvedValue(false);
      await runStart([]);
      expect(supervisorMgr.start).not.toHaveBeenCalled();
    });

    it('does not restart a supervisor that is already running', async () => {
      mockCheckRunning.mockResolvedValue({ running: true, url: 'http://127.0.0.1:7523/mcp', pid: 1 });
      supervisorMgr.isInstalled.mockResolvedValue(true);
      supervisorMgr.query.mockResolvedValue({ installed: true, running: true });
      await runStart([]);
      expect(supervisorMgr.start).not.toHaveBeenCalled();
    });

    it('leaves the machine-global supervisor alone for a sandboxed instance', async () => {
      process.env.APRA_FLEET_DATA_DIR = '/tmp/sandboxed';
      mockCheckRunning.mockResolvedValue({ running: true, url: 'http://127.0.0.1:7523/mcp', pid: 1 });
      supervisorMgr.isInstalled.mockResolvedValue(true);
      await runStart([]);
      expect(supervisorMgr.isInstalled).not.toHaveBeenCalled();
      expect(supervisorMgr.start).not.toHaveBeenCalled();
    });

    it('a supervisor start failure is non-fatal for the MCP server start', async () => {
      mockCheckRunning.mockResolvedValue({ running: true, url: 'http://127.0.0.1:7523/mcp', pid: 1 });
      supervisorMgr.isInstalled.mockResolvedValue(true);
      supervisorMgr.start.mockRejectedValue(new Error('no D-Bus session'));
      await expect(runStart([])).resolves.toBeUndefined();
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('supervisor'));
    });
  });

  describe('runStop', () => {
    it('stops the supervisor service when it is registered', async () => {
      supervisorMgr.isInstalled.mockResolvedValue(true);
      mcpMgr.isInstalled.mockResolvedValue(true);
      await runStop([]);
      expect(supervisorMgr.stop).toHaveBeenCalled();
      expect(mcpMgr.stop).toHaveBeenCalled();
    });

    it('does not touch the supervisor when its service is not registered', async () => {
      supervisorMgr.isInstalled.mockResolvedValue(false);
      mcpMgr.isInstalled.mockResolvedValue(true);
      await runStop([]);
      expect(supervisorMgr.stop).not.toHaveBeenCalled();
    });

    it('a supervisor stop failure does not prevent stopping the MCP server', async () => {
      supervisorMgr.isInstalled.mockResolvedValue(true);
      supervisorMgr.stop.mockRejectedValue(new Error('schtasks access denied'));
      mcpMgr.isInstalled.mockResolvedValue(true);
      await expect(runStop([])).resolves.toBeUndefined();
      expect(mcpMgr.stop).toHaveBeenCalled();
    });
  });

  describe('runStatus', () => {
    function output(): string {
      return vi.mocked(console.log).mock.calls.map(c => c.join(' ')).join('\n');
    }

    it('labels the two services separately so an operator can tell them apart', async () => {
      mcpMgr.query.mockResolvedValue({ installed: true, running: true, enabled: true });
      supervisorMgr.query.mockResolvedValue({ installed: false, running: false });
      await runStatus([]);
      expect(output()).toContain('Service (MCP server):');
      expect(output()).toContain('Service (fleet supervisor):');
    });

    it('reports each service independently', async () => {
      mcpMgr.query.mockResolvedValue({ installed: false, running: false });
      supervisorMgr.query.mockResolvedValue({ installed: true, running: true, enabled: true });
      await runStatus([]);
      const lines = output().split('\n');
      const mcpLine = lines.find(l => l.includes('Service (MCP server):'))!;
      const supLine = lines.find(l => l.includes('Service (fleet supervisor):'))!;
      expect(mcpLine).toContain('not installed');
      expect(supLine).toContain('installed (enabled)');
      expect(supLine).toContain('running');
    });

    it('a failing supervisor query degrades to "not installed" rather than throwing', async () => {
      supervisorMgr.query.mockRejectedValue(new Error('launchctl missing'));
      await expect(runStatus([])).resolves.toBeUndefined();
      const supLine = output().split('\n').find(l => l.includes('Service (fleet supervisor):'))!;
      expect(supLine).toContain('not installed');
    });
  });
});
