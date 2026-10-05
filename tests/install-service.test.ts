import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import * as readline from 'node:readline/promises';
import { runInstall, _setSeaOverride, _setManifestOverride, _setServiceHealthWaitOverride } from '../src/cli/install.js';
import { runUninstall } from '../src/cli/uninstall.js';
import * as install from '../src/cli/install.js';

// ---------------------------------------------------------------------------
// Hoisted mock refs for service manager
// ---------------------------------------------------------------------------
const { mockGetSvcMgr, mockSvcMgr } = vi.hoisted(() => {
  const mockSvcMgr = {
    register: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    start: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    stop: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    query: vi.fn<() => Promise<{ installed: boolean; running: boolean }>>()
      .mockResolvedValue({ installed: false, running: false }),
    isInstalled: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
    unregister: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
  return {
    mockGetSvcMgr: vi.fn<() => Promise<typeof mockSvcMgr>>().mockResolvedValue(mockSvcMgr),
    mockSvcMgr,
  };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('node:os', () => ({
  default: {
    homedir: vi.fn(() => '/mock/home'),
    platform: vi.fn(() => 'linux'),
  },
}));
vi.mock('node:fs');
vi.mock('node:child_process');
vi.mock('../src/services/service-manager/index.js', () => ({
  getServiceManager: mockGetSvcMgr,
}));
vi.mock('../src/cli/install.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/cli/install.js')>();
  return {
    ...orig,
    isApraFleetRunning: vi.fn().mockReturnValue(false),
  };
});
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(),
}));

// The fleet-supervisor service registration is NOT this suite's subject -- it is
// covered by tests/supervisor-service.test.ts and
// tests/install-supervisor-service.test.ts. It is stubbed as successful here
// because install now treats a failed supervisor registration as FATAL, and
// tests/setup.ts always sets APRA_FLEET_DATA_DIR -- so a real call would refuse
// to bake a machine-global unit and hard-fail every install in this file.
vi.mock('../src/services/supervisor-service.js', () => ({
  registerSupervisorService: vi.fn(async () => ({ registered: true })),
  unregisterSupervisorService: vi.fn(async () => {}),
  SUPERVISOR_SUBCOMMAND: 'supervisor',
}));

// ---------------------------------------------------------------------------
// FS mock helpers (mirrors install.test.ts pattern)
// ---------------------------------------------------------------------------
function makeFsMock() {
  vi.mocked(fs.existsSync).mockImplementation((p: any) => {
    const ps = p.toString();
    if (ps.includes('version.json')) return true;
    if (ps.includes('hooks-config.json')) return true;
    return false;
  });
  vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
    const ps = p.toString();
    if (ps.includes('version.json')) return JSON.stringify({ version: '0.1.0' });
    if (ps.includes('hooks-config.json')) return JSON.stringify({ hooks: { PostToolUse: [] } });
    if (ps.includes('install-config.json')) return JSON.stringify({ providers: { claude: { skill: 'all' } } });
    if (ps.includes('settings.json')) return JSON.stringify({});
    return '';
  });
  vi.mocked(fs.readdirSync).mockReturnValue([] as any);
  vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
  vi.mocked(fs.chmodSync).mockImplementation(() => {});
  vi.mocked(fs.copyFileSync).mockImplementation(() => {});
  vi.mocked(fs.writeFileSync).mockImplementation(() => {});
  vi.mocked(fs.rmSync).mockImplementation(() => undefined);
}

// ---------------------------------------------------------------------------
// Install service integration tests
// ---------------------------------------------------------------------------
describe('install -- service lifecycle (T11)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/mock/home');
    makeFsMock();
    _setManifestOverride({ version: '0.1.0', hooks: {}, scripts: {}, skills: {}, fleetSkills: {} });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    _setSeaOverride(null);
    _setManifestOverride(null);
    _setServiceHealthWaitOverride(null);
  });

  it('registers and starts service in SEA + HTTP mode', async () => {
    _setSeaOverride(true);
    await runInstall(['--transport', 'http', '--skill', 'none']);
    expect(mockGetSvcMgr).toHaveBeenCalled();
    expect(mockSvcMgr.register).toHaveBeenCalledWith(
      expect.stringContaining('apra-fleet'),
      ['--transport', 'http'],
      expect.any(String),
    );
    expect(mockSvcMgr.start).toHaveBeenCalled();
  });

  it('skips service registration in stdio transport mode', async () => {
    _setSeaOverride(true);
    await runInstall(['--transport', 'stdio', '--skill', 'none']);
    expect(mockSvcMgr.register).not.toHaveBeenCalled();
    expect(mockSvcMgr.start).not.toHaveBeenCalled();
  });

  it('skips service registration in dev (non-SEA) mode', async () => {
    _setSeaOverride(false);
    await runInstall(['--transport', 'http', '--skill', 'none']);
    expect(mockSvcMgr.register).not.toHaveBeenCalled();
    expect(mockSvcMgr.start).not.toHaveBeenCalled();
  });

  it('shows "Service: registered and running" only once the server answers /health', async () => {
    _setSeaOverride(true);
    _setServiceHealthWaitOverride(async () => true);
    const logSpy = vi.mocked(console.log);
    await runInstall(['--transport', 'http', '--skill', 'none']);
    const allOutput = logSpy.mock.calls.flat().join('\n');
    expect(allOutput).toContain('Service:');
    expect(allOutput).toContain('registered and running');
  });

  it('registered but the server never answers /health -> warns and never claims "running"', async () => {
    _setSeaOverride(true);
    _setServiceHealthWaitOverride(async () => false);
    const logSpy = vi.mocked(console.log);
    const warnSpy = vi.mocked(console.warn);
    await runInstall(['--transport', 'http', '--skill', 'none']);
    const allOutput = logSpy.mock.calls.flat().join('\n');
    expect(allOutput).not.toContain('registered and running');
    expect(allOutput).toContain('NOT answering /health');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not answering /health'));
  });

  it('warns (non-fatal) when service registration fails', async () => {
    _setSeaOverride(true);
    mockSvcMgr.register.mockRejectedValueOnce(new Error('schtasks access denied'));
    const warnSpy = vi.mocked(console.warn);
    await runInstall(['--transport', 'http', '--skill', 'none']);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Service registration skipped'));
  });

  it('increments totalSteps by 1 in SEA + HTTP mode', async () => {
    // With SEA + HTTP + no skills + no workflows: base=5 steps +1 dolt (apra-fleet-ire.3,
    // unconditional) +1 KB/code-intelligence setup = 7, +1 service = 8 total.
    // apra-fleet-i9ag.13.7.2: bd is part of fleet-se, so with --workflows none the
    // Beads step is skipped entirely (no step slot), not just non-fatal.
    _setSeaOverride(true);
    const logSpy = vi.mocked(console.log);
    await runInstall(['--transport', 'http', '--skill', 'none', '--workflows', 'none']);
    const allOutput = logSpy.mock.calls.flat().join('\n');
    // Service step should show as [8/8]
    expect(allOutput).toContain('[8/8]');
    // KB + code intelligence step should show as [7/8]
    expect(allOutput).toContain('[7/8]');
    // No Beads step line at all -- skipped under --workflows none
    expect(allOutput).not.toContain('Installing Beads task tracker');
    // Dolt step should show as [6/8]
    expect(allOutput).toContain('[6/8]');
  });
});

// ---------------------------------------------------------------------------
// Uninstall service integration tests
// ---------------------------------------------------------------------------
describe('uninstall -- service lifecycle (T12)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue('/mock/home');
    makeFsMock();
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ providers: { claude: { skill: 'all' } } }),
    );
    vi.mocked(install.isApraFleetRunning).mockReturnValue(false);
    (readline.createInterface as any).mockReturnValue({
      question: vi.fn().mockResolvedValue('y'),
      close: vi.fn(),
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
  });

  it('calls unregister when server is not running', async () => {
    await runUninstall(['--yes']);
    expect(mockSvcMgr.unregister).toHaveBeenCalled();
  });

  it('calls stop then unregister when server is running and --force is passed', async () => {
    vi.mocked(install.isApraFleetRunning).mockReturnValue(true);
    await runUninstall(['--yes', '--force']);
    expect(mockSvcMgr.stop).toHaveBeenCalled();
    expect(mockSvcMgr.unregister).toHaveBeenCalled();
    // stop must be called before unregister
    const stopOrder = mockSvcMgr.stop.mock.invocationCallOrder[0];
    const unregisterOrder = mockSvcMgr.unregister.mock.invocationCallOrder[0];
    expect(stopOrder).toBeLessThan(unregisterOrder);
  });

  it('does not call stop when server is not running', async () => {
    await runUninstall(['--yes']);
    expect(mockSvcMgr.stop).not.toHaveBeenCalled();
  });

  it('does not call unregister in dry-run mode', async () => {
    await runUninstall(['--dry-run', '--yes']);
    expect(mockSvcMgr.unregister).not.toHaveBeenCalled();
  });

  it('does not call stop in dry-run mode even with --force and running server', async () => {
    vi.mocked(install.isApraFleetRunning).mockReturnValue(true);
    await runUninstall(['--dry-run', '--force', '--yes']);
    expect(mockSvcMgr.stop).not.toHaveBeenCalled();
  });

  it('unregister error is swallowed (idempotent)', async () => {
    mockSvcMgr.unregister.mockRejectedValueOnce(new Error('task not found'));
    // Should complete without throwing
    await runUninstall(['--yes']);
  });

  it('errors if server is running without --force', async () => {
    vi.mocked(install.isApraFleetRunning).mockReturnValue(true);
    await expect(runUninstall(['--yes'])).rejects.toThrow('exit');
    expect(mockSvcMgr.stop).not.toHaveBeenCalled();
  });
});
