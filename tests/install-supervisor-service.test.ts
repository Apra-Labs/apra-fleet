/**
 * The install step's LOUD-FAILURE policy for the fleet-supervisor service.
 *
 * The bug being fixed was not a missing message -- it was a correct-looking
 * message printed alongside a ZERO exit, so `apra-fleet install` reported success
 * while the always-on supervisor had silently not been registered. Every case
 * here therefore asserts BOTH the operator-visible reason AND a non-zero exit
 * code; asserting the string alone would not have caught the original bug.
 *
 * Deliberately NOT mocked: src/services/supervisor-service.js. This suite drives
 * the real registerSupervisorService() through runInstall() so each reason is
 * produced by production code rather than by a stub.
 *
 * Nothing here touches the real ~/.apra-fleet (node:fs and node:os are mocked)
 * and no real systemctl/launchctl/schtasks runs (the service manager is mocked).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import { runInstall, _setSeaOverride, _setManifestOverride } from '../src/cli/install.js';

// ---------------------------------------------------------------------------
// Service-id-aware manager mock: the MCP server and the supervisor must be
// independently controllable, since the whole point is that one warns and the
// other is fatal.
// ---------------------------------------------------------------------------
const { mockGetSvcMgr, mcpMgr, supervisorMgr } = vi.hoisted(() => {
  const makeMgr = () => ({
    register: vi.fn<(...a: any[]) => Promise<void>>().mockResolvedValue(undefined),
    unregister: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    start: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    stop: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    query: vi.fn<() => Promise<any>>().mockResolvedValue({ installed: false, running: false }),
    isInstalled: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
  });
  const mcpMgr = makeMgr();
  const supervisorMgr = makeMgr();
  return {
    mcpMgr,
    supervisorMgr,
    mockGetSvcMgr: vi.fn(async (id?: string) =>
      id === 'fleet-supervisor' ? supervisorMgr : mcpMgr,
    ),
  };
});

vi.mock('node:os', () => ({
  default: {
    homedir: vi.fn(() => '/mock/home'),
    platform: vi.fn(() => 'linux'),
    userInfo: vi.fn(() => ({ username: 'mockuser' })),
  },
}));
vi.mock('node:fs');
vi.mock('node:child_process');
vi.mock('../src/services/service-manager/index.js', () => ({
  getServiceManager: mockGetSvcMgr,
}));
vi.mock('../src/cli/install.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/cli/install.js')>();
  return { ...orig, isApraFleetRunning: vi.fn().mockReturnValue(false) };
});
vi.mock('node:readline/promises', () => ({ createInterface: vi.fn() }));

import { SUPERVISOR_SERVE_SCRIPT } from '../src/cli/supervisor.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
const savedDataDir = process.env.APRA_FLEET_DATA_DIR;
const savedPort = process.env.APRA_FLEET_PORT;
const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

/** Set by the process.exit spy; undefined means install never tried to exit. */
let exitCode: number | undefined;

const EXIT_SENTINEL = '__process_exit__';

/** Mirrors tests/install-service.test.ts's fs mock, plus a present serve.mjs. */
function makeFsMock(serveScriptExists = true): void {
  vi.mocked(fs.existsSync).mockImplementation((p: any) => {
    const ps = p.toString();
    if (ps === SUPERVISOR_SERVE_SCRIPT) return serveScriptExists;
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

/** Everything the operator would see on stdout+stderr. */
function operatorOutput(): string {
  return [
    ...vi.mocked(console.log).mock.calls,
    ...vi.mocked(console.warn).mock.calls,
    ...vi.mocked(console.error).mock.calls,
  ]
    .map(c => c.join(' '))
    .join('\n');
}

/** Run a SEA + HTTP install that is expected to hard-fail. Returns the output. */
async function expectLoudFailure(args: string[] = []): Promise<string> {
  await expect(
    runInstall(['--transport', 'http', '--skill', 'none', ...args]),
  ).rejects.toThrow(EXIT_SENTINEL);
  // The exact regression: a reason printed next to a ZERO exit.
  expect(exitCode).toBeDefined();
  expect(exitCode).not.toBe(0);
  expect(exitCode).toBe(1);
  return operatorOutput();
}

/**
 * vi.clearAllMocks() clears CALLS but keeps implementations, so a
 * mockRejectedValue set by one case would leak into every later case and
 * silently make the rest of the matrix assert the wrong reason. Reset the
 * manager mocks to their resolved defaults explicitly.
 */
function resetMgrMocks(): void {
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

beforeEach(() => {
  vi.clearAllMocks();
  resetMgrMocks();
  exitCode = undefined;
  // The supervisor unit is machine-global, so an overridden instance is refused.
  // tests/setup.ts always sets APRA_FLEET_DATA_DIR -- clear it so the cases that
  // are NOT about that reason can reach the reason they are about.
  delete process.env.APRA_FLEET_DATA_DIR;
  delete process.env.APRA_FLEET_PORT;
  vi.mocked(os.homedir).mockReturnValue('/mock/home');
  makeFsMock();
  _setSeaOverride(true);
  _setManifestOverride({ version: '0.1.0', hooks: {}, scripts: {}, skills: {}, fleetSkills: {} });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = typeof code === 'number' ? code : 0;
    throw new Error(EXIT_SENTINEL);
  }) as never);
});

afterEach(() => {
  _setSeaOverride(null);
  _setManifestOverride(null);
  if (savedDataDir === undefined) delete process.env.APRA_FLEET_DATA_DIR;
  else process.env.APRA_FLEET_DATA_DIR = savedDataDir;
  if (savedPort === undefined) delete process.env.APRA_FLEET_PORT;
  else process.env.APRA_FLEET_PORT = savedPort;
  Object.defineProperty(process, 'platform', origPlatform);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The loud-failure matrix: one case per reason, each asserting a NON-ZERO exit.
// ---------------------------------------------------------------------------
describe('install -- fleet-supervisor registration failures are LOUD', () => {
  it('exits non-zero naming the platform when the OS has no service support', async () => {
    Object.defineProperty(process, 'platform', { value: 'freebsd', configurable: true });
    const out = await expectLoudFailure();
    expect(out).toContain('freebsd');
    expect(out).toContain('fleet-supervisor');
    // A NoopServiceManager would have "succeeded" silently -- assert we never
    // pretended to register anything.
    expect(supervisorMgr.register).not.toHaveBeenCalled();
  });

  it('exits non-zero naming serve.mjs when the installed entry point is missing', async () => {
    makeFsMock(/* serveScriptExists */ false);
    const out = await expectLoudFailure();
    expect(out).toContain('serve.mjs');
    expect(supervisorMgr.register).not.toHaveBeenCalled();
  });

  it('exits non-zero surfacing the reason when register() throws', async () => {
    supervisorMgr.register.mockRejectedValue(new Error('systemd user mode is not available'));
    const out = await expectLoudFailure();
    expect(out).toContain('systemd user mode is not available');
  });

  it('exits non-zero AND rolls back, leaving no unit registered, when start() throws', async () => {
    supervisorMgr.start.mockRejectedValue(new Error('Failed to start fleet-supervisor.service'));
    const out = await expectLoudFailure();
    expect(out).toContain('Failed to start fleet-supervisor.service');
    // The rollback: no half-registered unit survives the failure.
    expect(supervisorMgr.unregister).toHaveBeenCalled();
  });

  it('exits non-zero when APRA_FLEET_DATA_DIR makes this a non-default instance', async () => {
    process.env.APRA_FLEET_DATA_DIR = '/tmp/sandboxed-instance';
    const out = await expectLoudFailure();
    expect(out).toContain('APRA_FLEET_DATA_DIR');
    expect(supervisorMgr.register).not.toHaveBeenCalled();
  });

  it('exits non-zero when APRA_FLEET_PORT makes this a non-default instance', async () => {
    process.env.APRA_FLEET_PORT = '8899';
    const out = await expectLoudFailure();
    expect(out).toContain('APRA_FLEET_PORT');
    expect(supervisorMgr.register).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The negative: the loud policy must not turn a legitimate skip into a failure.
// ---------------------------------------------------------------------------
describe('install --workflows none -- a legitimate skip, not a failure', () => {
  it('exits 0 and prints an explicit not-registered line', async () => {
    await expect(
      runInstall(['--transport', 'http', '--skill', 'none', '--workflows', 'none']),
    ).resolves.toBeUndefined();
    expect(exitCode).toBeUndefined();
    const out = operatorOutput();
    expect(out).toContain('fleet-supervisor service NOT registered');
    expect(out).toContain('--workflows none');
    expect(supervisorMgr.register).not.toHaveBeenCalled();
  });

  it('still registers the MCP server service, which does not live in the workflow tree', async () => {
    await runInstall(['--transport', 'http', '--skill', 'none', '--workflows', 'none']);
    expect(mcpMgr.register).toHaveBeenCalled();
    expect(exitCode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The happy path, so the matrix above is not vacuously green.
// ---------------------------------------------------------------------------
describe('install -- successful supervisor registration', () => {
  it('registers the binary subcommand, starts it and exits 0', async () => {
    await expect(
      runInstall(['--transport', 'http', '--skill', 'none']),
    ).resolves.toBeUndefined();
    expect(exitCode).toBeUndefined();
    expect(supervisorMgr.register).toHaveBeenCalledWith(
      expect.stringContaining('apra-fleet'),
      ['supervisor'],
      expect.any(String),
      expect.objectContaining({ workingDirectory: expect.stringContaining('fleet-sprint') }),
    );
    expect(supervisorMgr.start).toHaveBeenCalled();
    expect(supervisorMgr.unregister).not.toHaveBeenCalled();
    expect(operatorOutput()).toContain('fleet-supervisor service registered and started');
  });
});

// ---------------------------------------------------------------------------
// Regression guard: widening the loud policy to the MCP server step is OUT of
// scope for this change, and no ported case pins that boundary afterwards.
// ---------------------------------------------------------------------------
describe('install -- the mcp-server step still only WARNS', () => {
  it('keeps install at exit 0 when the MCP server registration fails', async () => {
    mcpMgr.register.mockRejectedValue(new Error('schtasks access denied'));
    await expect(
      runInstall(['--transport', 'http', '--skill', 'none']),
    ).resolves.toBeUndefined();
    expect(exitCode).toBeUndefined();
    expect(vi.mocked(console.warn).mock.calls.flat().join('\n')).toContain(
      'Service registration skipped',
    );
  });

  it('an MCP server failure does not prevent the supervisor from registering', async () => {
    mcpMgr.register.mockRejectedValue(new Error('schtasks access denied'));
    await runInstall(['--transport', 'http', '--skill', 'none']);
    expect(supervisorMgr.register).toHaveBeenCalled();
    expect(exitCode).toBeUndefined();
  });

  it('an MCP server start failure is also only a warning', async () => {
    mcpMgr.start.mockRejectedValue(new Error('launchctl kickstart failed'));
    await expect(
      runInstall(['--transport', 'http', '--skill', 'none']),
    ).resolves.toBeUndefined();
    expect(exitCode).toBeUndefined();
    expect(vi.mocked(console.warn).mock.calls.flat().join('\n')).toContain(
      'Service registration skipped',
    );
  });
});
