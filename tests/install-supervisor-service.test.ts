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
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runInstall, _setSeaOverride, _setManifestOverride } from '../src/cli/install.js';
import { BEADS_PACKAGE } from '../src/cli/beads-pin.js';

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

import { SUPERVISOR_SERVE_SCRIPT, supervisorConfigPath, SUPERVISOR_DATA_DIR } from '../src/cli/supervisor.js';
// The REAL apra-fleet-se reader -- apra-fleet-i9ag.17.4.2's "Seeded" case
// asserts against this, not a restated literal shape, so a drift between
// the writer here and this reader is exactly what would fail. `node:fs` is
// mocked file-wide above, but this module only ever touches `node:fs/
// promises` (a separate specifier, unmocked) via its own injectable `fs`
// option, which the test below overrides directly -- no real disk I/O.
import { readSupervisorConfig } from '../packages/apra-fleet-se/src/supervisor/project-config.mjs';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
const savedDataDir = process.env.APRA_FLEET_DATA_DIR;
const savedPort = process.env.APRA_FLEET_PORT;
const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

/** Set by the process.exit spy; undefined means install never tried to exit. */
let exitCode: number | undefined;

const EXIT_SENTINEL = '__process_exit__';

/**
 * Mirrors tests/install-service.test.ts's fs mock, plus a present serve.mjs.
 *
 * `extraExists` layers additional exact-path -> boolean answers on top of
 * the defaults below (apra-fleet-i9ag.17.4.2's --project-dir cases use this
 * for the candidate project folder and, for the "preserved" case, an
 * already-existing supervisor.config.json). `statSync` for any path this
 * map marks `true` reports as a directory -- good enough for
 * seedSupervisorProjectDir()'s existsSync()+statSync().isDirectory() check,
 * without needing a second mock table just for stat.
 *
 * `extraReads` does the same for readFileSync: exact-path -> contents, so a
 * test can stand up an ALREADY-EXISTING supervisor.config.json (valid or
 * corrupt) and assert what the installer's write does to it.
 */
function makeFsMock(
  serveScriptExists = true,
  extraExists: Record<string, boolean> = {},
  extraReads: Record<string, string> = {},
): void {
  vi.mocked(fs.existsSync).mockImplementation((p: any) => {
    const ps = p.toString();
    if (Object.prototype.hasOwnProperty.call(extraExists, ps)) return extraExists[ps];
    if (ps === SUPERVISOR_SERVE_SCRIPT) return serveScriptExists;
    if (ps.includes('version.json')) return true;
    if (ps.includes('hooks-config.json')) return true;
    return false;
  });
  vi.mocked(fs.statSync).mockImplementation((p: any) => {
    const ps = p.toString();
    return { isDirectory: () => extraExists[ps] === true } as any;
  });
  vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
    const ps = p.toString();
    if (Object.prototype.hasOwnProperty.call(extraReads, ps)) return extraReads[ps];
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
  vi.mocked(fs.renameSync).mockImplementation(() => {});
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

// ---------------------------------------------------------------------------
// --project-dir seeds the supervisor's persisted project folder. Five
// independently named properties: seeded (and accepted by the REAL
// apra-fleet-se reader), ordering (the validation is SPLIT -- a no-bd
// preflight before any side effect, then the bd check and the write after
// install's own Beads step and before supervisor registration), rejected
// (bad path, non-zero exit, nothing written), omitted (no option -> no
// write, no behaviour change), and preserved (no option leaves an existing
// console-set config untouched).
// ---------------------------------------------------------------------------
// path.resolve() so the literal matches what seedSupervisorProjectDir()
// resolves it to on every host (a bare POSIX literal picks up a drive letter
// on Windows and would then never match the fs mock's keys).
const PROJECT_DIR = path.resolve('/mock/project-a');
const PROJECT_BEADS_DIR = path.join(PROJECT_DIR, '.beads');
const CONFIG_PATH = supervisorConfigPath(SUPERVISOR_DATA_DIR);

/**
 * The fs shape of a project folder a sprint could actually run in: the
 * folder itself plus its initialised `.beads`. Layered onto makeFsMock()'s
 * `extraExists` map.
 */
const USABLE_PROJECT_FS = { [PROJECT_DIR]: true, [PROJECT_BEADS_DIR]: true };

/**
 * The two child processes seedSupervisorProjectDir() runs to decide whether
 * a folder carries a usable beads identity: `git remote get-url origin` and
 * `bd` (a runnability probe, then `bd config get sync.remote --json`).
 *
 * Defaults describe a fully usable folder; each knob knocks out exactly one
 * requirement, so every refusal can be asserted on any host with no real bd
 * or git and no real project folder anywhere.
 */
function mockProjectDirProbes({
  gitOrigin = 'https://example.invalid/acme/demo.git',
  bdRunnable = true as boolean | 'after-npm-install',
  syncRemote = 'https://example.invalid/acme/demo.git',
} = {}): void {
  // 'after-npm-install' models the FRESH MACHINE this ordering exists for:
  // bd does not exist when the install starts and only becomes runnable once
  // install's own Beads step has npm-installed it.
  let bdInstalled = bdRunnable === true;
  vi.mocked(execFileSync).mockImplementation(((file: any, args: any) => {
    const argv: string[] = Array.isArray(args) ? args : [];
    if (file === 'npm' && argv[0] === 'install' && argv.includes(BEADS_PACKAGE)) {
      if (bdRunnable === 'after-npm-install') bdInstalled = true;
      return 'added 1 package\n' as any;
    }
    if (file === 'git') {
      if (!gitOrigin) throw new Error("fatal: No such remote 'origin'");
      return `${gitOrigin}\n` as any;
    }
    if (file === 'bd') {
      if (!bdInstalled) throw new Error('spawn bd ENOENT');
      if (argv[0] === '--version') return 'bd version 0.0.0-mock\n' as any;
      if (argv[0] === 'config') return JSON.stringify({ key: 'sync.remote', value: syncRemote }) as any;
    }
    return '' as any;
  }) as any);
}

/** Invocation orders of the execFileSync calls matching `pred`, so a case can
 *  pin WHERE in the install a child process ran relative to a config write. */
function execOrders(pred: (file: string, argv: string[]) => boolean): number[] {
  return vi
    .mocked(execFileSync)
    .mock.calls.map((call, i) => ({ call, order: vi.mocked(execFileSync).mock.invocationCallOrder[i] }))
    .filter(({ call }) => pred(String(call[0]), Array.isArray(call[1]) ? (call[1] as string[]) : []))
    .map(({ order }) => order);
}

/** The installer writes the config ATOMICALLY: temp file in the same dir,
 *  then rename. Asserting on the temp path is therefore asserting on the
 *  real write; `configRenames()` below pins the second half. */
const CONFIG_TMP_PATH = `${CONFIG_PATH}.tmp`;

/** Every fs.writeFileSync call this run made toward the supervisor config,
 *  in call order -- the content argument only. */
function configWriteContents(): string[] {
  return vi
    .mocked(fs.writeFileSync)
    .mock.calls.filter(([p]) => (p as any)?.toString() === CONFIG_TMP_PATH)
    .map(([, content]) => (content as any).toString());
}

/** Invocation orders of those same config writes. */
function configWriteOrders(): number[] {
  return vi
    .mocked(fs.writeFileSync)
    .mock.calls.map((call, i) => ({ call, order: vi.mocked(fs.writeFileSync).mock.invocationCallOrder[i] }))
    .filter(({ call }) => (call[0] as any)?.toString() === CONFIG_TMP_PATH)
    .map(({ order }) => order);
}

/** Every fs.renameSync call that published a config temp file. */
function configRenames(): Array<[string, string]> {
  return vi
    .mocked(fs.renameSync)
    .mock.calls.map(([from, to]) => [(from as any).toString(), (to as any).toString()] as [string, string])
    .filter(([, to]) => to === CONFIG_PATH);
}

describe('install --project-dir (apra-fleet-i9ag.17.4.2)', () => {
  it('seeded: writes supervisor.config.json under the resolved data dir, accepted by the REAL apra-fleet-se reader', async () => {
    makeFsMock(true, USABLE_PROJECT_FS);
    mockProjectDirProbes();
    await expect(
      runInstall(['--transport', 'http', '--skill', 'none', '--project-dir', PROJECT_DIR]),
    ).resolves.toBeUndefined();
    expect(exitCode).toBeUndefined();

    const writes = configWriteContents();
    expect(writes).toHaveLength(1);

    // Assert against the REAL reader (imported above), not a restated
    // literal shape -- a hardcoded-on-both-sides assertion cannot detect
    // drift, which is the specific risk this feature carries.
    const parsed = await readSupervisorConfig({
      dataDir: SUPERVISOR_DATA_DIR,
      fs: { readFile: async () => writes[0] },
    });
    expect(parsed.configured).toBe(true);
    expect(parsed.projectDir).toBe(PROJECT_DIR);
  });

  it('ordering: the config write lands after the Beads step and before the supervisor service registration call', async () => {
    makeFsMock(true, USABLE_PROJECT_FS);
    mockProjectDirProbes();
    await runInstall(['--transport', 'http', '--skill', 'none', '--project-dir', PROJECT_DIR]);
    expect(exitCode).toBeUndefined();

    const writeOrders = configWriteOrders();
    expect(writeOrders.length).toBeGreaterThan(0);

    // AFTER the Beads step: the deferred half of the validation runs
    // `bd config get sync.remote`, and bd is only guaranteed runnable once
    // that step has provisioned it. The step's own `bd --version` probe is
    // the first bd call of the run, so the write must follow it.
    const firstBdProbe = execOrders((file, argv) => file === 'bd' && argv[0] === '--version')[0];
    expect(firstBdProbe).toBeDefined();
    expect(writeOrders[0]).toBeGreaterThan(firstBdProbe);

    // BEFORE registration: the supervisor's first boot must already see the
    // config, or it resolves the wrong project and needs a restart.
    expect(supervisorMgr.register.mock.invocationCallOrder.length).toBeGreaterThan(0);
    expect(writeOrders[0]).toBeLessThan(supervisorMgr.register.mock.invocationCallOrder[0]);
  });

  it('ordering: a path the preflight rejects aborts before ANY install side effect -- not one file written', async () => {
    // The preflight half keeps the "fail loudly before a single file is
    // written" guarantee the original all-up-front validation had. Nothing
    // in runInstall() writes before it, so the strongest possible assertion
    // is available: no write of any kind, anywhere, occurred.
    makeFsMock(true, { [PROJECT_DIR]: false });
    mockProjectDirProbes();
    await expectLoudFailure(['--project-dir', PROJECT_DIR]);
    expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled();
    expect(vi.mocked(fs.mkdirSync)).not.toHaveBeenCalled();
    expect(vi.mocked(fs.copyFileSync)).not.toHaveBeenCalled();
    // ... and no child process ran either: the preflight never reaches bd.
    expect(execOrders(file => file === 'bd')).toHaveLength(0);
  });

  it("a fresh machine with no bd yet still installs: the preflight passes, the Beads step provisions bd, then the config is seeded", async () => {
    // THE DEFECT this ordering fixes (apra-fleet-i9ag.17): the whole
    // validation used to run up front, so `--project-dir` on a machine
    // without bd failed the install for a prerequisite the install was
    // about to satisfy itself, moments later, in its own Beads step.
    makeFsMock(true, USABLE_PROJECT_FS);
    mockProjectDirProbes({ bdRunnable: 'after-npm-install' });

    await expect(
      runInstall(['--transport', 'http', '--skill', 'none', '--project-dir', PROJECT_DIR]),
    ).resolves.toBeUndefined();
    expect(exitCode).toBeUndefined();

    // The Beads step really did have to install bd -- otherwise this case
    // would be the already-have-bd happy path wearing a different name.
    const npmInstall = execOrders(
      (file, argv) => file === 'npm' && argv[0] === 'install' && argv.includes(BEADS_PACKAGE),
    );
    expect(npmInstall).toHaveLength(1);

    const writeOrders = configWriteOrders();
    expect(writeOrders).toHaveLength(1);
    expect(writeOrders[0]).toBeGreaterThan(npmInstall[0]);
    expect(JSON.parse(configWriteContents()[0]).projectDir).toBe(PROJECT_DIR);
    expect(supervisorMgr.register).toHaveBeenCalled();
  });

  it('rejected: a nonexistent path fails the install with a non-zero exit and writes no config', async () => {
    makeFsMock(true, { [PROJECT_DIR]: false });
    mockProjectDirProbes();
    const out = await expectLoudFailure(['--project-dir', PROJECT_DIR]);
    expect(out).toContain(PROJECT_DIR);
    expect(configWriteContents()).toHaveLength(0);
    expect(supervisorMgr.register).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // The folder must be one a sprint could actually RUN in. The engine's
  // beads identity precondition is fatal, so seeding a folder that fails it
  // would hand the operator a supervisor that boots and then fails every
  // launch. Each requirement gets its own case, asserting BOTH the specific
  // fix in the message and that nothing was written.
  // ---------------------------------------------------------------------

  it('rejected: a folder with no initialised .beads names bd init and writes no config', async () => {
    makeFsMock(true, { [PROJECT_DIR]: true, [PROJECT_BEADS_DIR]: false });
    mockProjectDirProbes();
    const out = await expectLoudFailure(['--project-dir', PROJECT_DIR]);
    expect(out).toContain(PROJECT_DIR);
    expect(out).toContain("run 'bd init' there");
    expect(configWriteContents()).toHaveLength(0);
  });

  it("rejected: a folder with no git 'origin' remote names git remote add and writes no config", async () => {
    makeFsMock(true, USABLE_PROJECT_FS);
    mockProjectDirProbes({ gitOrigin: '' });
    const out = await expectLoudFailure(['--project-dir', PROJECT_DIR]);
    expect(out).toContain("run 'git remote add origin <url>' there");
    expect(configWriteContents()).toHaveLength(0);
  });

  it("rejected: a folder with no bd 'sync.remote' names bd config set and writes no config", async () => {
    makeFsMock(true, USABLE_PROJECT_FS);
    mockProjectDirProbes({ syncRemote: '' });
    const out = await expectLoudFailure(['--project-dir', PROJECT_DIR]);
    expect(out).toContain("run 'bd config set sync.remote <url>' there");
    expect(configWriteContents()).toHaveLength(0);
  });

  it('rejected LOUDLY, never skipped, when bd is STILL not runnable after the Beads step -- a skipped check is indistinguishable from a passed one', async () => {
    // --workflows none is the one path where bd is legitimately never
    // provisioned, so it is the case that can still reach the deferred
    // check with no bd. It must stay fatal: skipping the sync.remote check
    // would seed a folder whose first sprint launch is guaranteed to fail.
    makeFsMock(true, USABLE_PROJECT_FS);
    mockProjectDirProbes({ bdRunnable: false });
    const out = await expectLoudFailure(['--workflows', 'none', '--project-dir', PROJECT_DIR]);
    expect(out).toContain('bd could not be run');
    expect(out).toContain('on PATH');
    expect(configWriteContents()).toHaveLength(0);
  });

  it('a .beads path is accepted and normalised to its parent project folder, exactly as --beads-dir and the console do', async () => {
    makeFsMock(true, USABLE_PROJECT_FS);
    mockProjectDirProbes();
    await expect(
      runInstall(['--transport', 'http', '--skill', 'none', '--project-dir', PROJECT_BEADS_DIR]),
    ).resolves.toBeUndefined();
    expect(exitCode).toBeUndefined();
    const writes = configWriteContents();
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]).projectDir).toBe(PROJECT_DIR);
  });

  it('omitted: install with no --project-dir writes no config file', async () => {
    makeFsMock();
    await expect(
      runInstall(['--transport', 'http', '--skill', 'none']),
    ).resolves.toBeUndefined();
    expect(exitCode).toBeUndefined();
    expect(configWriteContents()).toHaveLength(0);
  });

  it('preserved: an install with no option leaves an existing console-set config file untouched (no write, no delete)', async () => {
    // Simulate a config file an operator already set from the console:
    // existsSync(CONFIG_PATH) is true, exactly as a real prior write would
    // leave it -- the point is that NOTHING in this run's code path
    // touches that path at all, since --project-dir was never supplied.
    makeFsMock(true, { [CONFIG_PATH]: true });
    await expect(
      runInstall(['--transport', 'http', '--skill', 'none']),
    ).resolves.toBeUndefined();
    expect(exitCode).toBeUndefined();
    expect(configWriteContents()).toHaveLength(0);
    expect(vi.mocked(fs.rmSync).mock.calls.some(([p]) => (p as any)?.toString() === CONFIG_PATH)).toBe(false);
    expect(vi.mocked(fs.unlinkSync).mock.calls.length).toBe(0);
  });

  it('an install that overwrites an existing installation (--force) still respects the option', async () => {
    makeFsMock(true, USABLE_PROJECT_FS);
    mockProjectDirProbes();
    await expect(
      runInstall(['--transport', 'http', '--skill', 'none', '--force', '--project-dir', PROJECT_DIR]),
    ).resolves.toBeUndefined();
    expect(exitCode).toBeUndefined();
    expect(configWriteContents()).toHaveLength(1);
  });

  // -------------------------------------------------------------------
  // The installer and the supervisor write the SAME file, so the installer
  // owes the same two guarantees the runtime writer documents: unknown
  // top-level keys survive, and the write is atomic (temp + rename in the
  // same directory). Without them an install silently destroys a field a
  // newer supervisor wrote, or leaves a truncated file behind.
  // -------------------------------------------------------------------

  it('the write is atomic: a temp file in the config directory, then a rename onto the real path', async () => {
    makeFsMock(true, USABLE_PROJECT_FS);
    mockProjectDirProbes();
    await runInstall(['--transport', 'http', '--skill', 'none', '--project-dir', PROJECT_DIR]);
    expect(exitCode).toBeUndefined();

    expect(configWriteContents()).toHaveLength(1);
    expect(configRenames()).toEqual([[CONFIG_TMP_PATH, CONFIG_PATH]]);
    // The real path is never written directly -- that is what makes a
    // half-finished write unobservable to the supervisor's next boot.
    const direct = vi.mocked(fs.writeFileSync).mock.calls.filter(([p]) => (p as any)?.toString() === CONFIG_PATH);
    expect(direct).toHaveLength(0);
  });

  it('an unknown top-level key already in the config survives the install-time write', async () => {
    makeFsMock(
      true,
      { ...USABLE_PROJECT_FS, [CONFIG_PATH]: true },
      { [CONFIG_PATH]: JSON.stringify({ projectDir: '/mock/older-project', futureSetting: { nested: [1, 2] } }) },
    );
    mockProjectDirProbes();
    await runInstall(['--transport', 'http', '--skill', 'none', '--project-dir', PROJECT_DIR]);
    expect(exitCode).toBeUndefined();

    const written = JSON.parse(configWriteContents()[0]);
    expect(written.projectDir).toBe(PROJECT_DIR);
    expect(written.futureSetting).toEqual({ nested: [1, 2] });
  });

  it('a malformed existing config is replaced by a good one rather than blocking the write', async () => {
    makeFsMock(
      true,
      { ...USABLE_PROJECT_FS, [CONFIG_PATH]: true },
      { [CONFIG_PATH]: '{ this is not json' },
    );
    mockProjectDirProbes();
    await runInstall(['--transport', 'http', '--skill', 'none', '--project-dir', PROJECT_DIR]);
    expect(exitCode).toBeUndefined();

    expect(JSON.parse(configWriteContents()[0])).toEqual({ projectDir: PROJECT_DIR });
  });

  it('the install help text documents --project-dir (apra-fleet-i9ag.17.4.1)', async () => {
    await expect(runInstall(['--help'])).rejects.toThrow(EXIT_SENTINEL);
    expect(exitCode).toBe(0);
    const out = operatorOutput();
    expect(out).toContain('--project-dir <path>');
  });
});
