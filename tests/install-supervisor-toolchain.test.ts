/**
 * The install-time toolchain-seed step (apra-fleet-i9ag.19.2): after the
 * fleet-se prerequisite gate and the Beads/bd provisioning step, and before
 * the fleet-supervisor service is registered, `apra-fleet install` resolves
 * node's (and bd's) absolute path and records it into supervisor.config.json
 * under a `toolchain` key, so the always-on supervisor -- started under a
 * service manager that does not inherit the login shell's PATH -- can find
 * them without depending on PATH at all.
 *
 * Like tests/install-fleet-se-prereqs.test.ts, this step spawns real child
 * processes in production and is therefore gated behind an explicit
 * NODE_ENV=test opt-in (APRA_FLEET_ENABLE_FLEET_SE_TOOLCHAIN_SEED=1) plus
 * injectable deps (_setFleetSeToolchainStepDeps), so every OTHER install
 * suite that does not care about this step sees no behaviour change at all
 * (asserted directly at the bottom of this file).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  runInstall,
  _setSeaOverride,
  _setManifestOverride,
  _setFleetSePrereqStepDeps,
  _resetFleetSePrereqStepDeps,
  _setFleetSeToolchainStepDeps,
  _resetFleetSeToolchainStepDeps,
} from '../src/cli/install.js';
import { BEADS_PACKAGE } from '../src/cli/beads-pin.js';
import type { FleetSePrereqResult, FleetSeToolchainPaths } from '../src/cli/fleet-se-prereqs.js';

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
    mockGetSvcMgr: vi.fn(async (id?: string) => (id === 'fleet-supervisor' ? supervisorMgr : mcpMgr)),
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

const mockHome = '/mock/home';
const CONFIG_PATH = supervisorConfigPath(SUPERVISOR_DATA_DIR);
const CONFIG_TMP_PATH = `${CONFIG_PATH}.tmp`;

const SATISFIED: FleetSePrereqResult = {
  node: { present: true, version: '22.16.0', satisfiesMin: true },
  npm: { present: true, version: '10.5.0' },
  ok: true,
  missing: [],
};

const RESOLVED_TOOLCHAIN: FleetSeToolchainPaths = {
  node: { path: '/opt/nvm/versions/node/v22.16.0/bin/node', version: '22.16.0', ok: true, reason: null },
  bd: { path: '/usr/local/bin/bd', version: '1.3.0', ok: true, reason: null },
};

const NODE_UNRESOLVED_TOOLCHAIN: FleetSeToolchainPaths = {
  node: { path: null, version: null, ok: false, reason: 'node -p process.execPath failed: spawn node ENOENT' },
  bd: { path: '/usr/local/bin/bd', version: '1.3.0', ok: true, reason: null },
};

const BD_UNRESOLVED_TOOLCHAIN: FleetSeToolchainPaths = {
  node: { path: '/usr/bin/node', version: '22.16.0', ok: true, reason: null },
  bd: { path: null, version: null, ok: false, reason: 'bd not found on PATH' },
};

function makeFsMock(extraExists: Record<string, boolean> = {}, extraReads: Record<string, string> = {}): void {
  vi.mocked(fs.existsSync).mockImplementation((p: any) => {
    const ps = p.toString();
    if (Object.prototype.hasOwnProperty.call(extraExists, ps)) return extraExists[ps];
    if (ps === SUPERVISOR_SERVE_SCRIPT) return true;
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

function operatorOutput(): string {
  return [
    ...vi.mocked(console.log).mock.calls,
    ...vi.mocked(console.warn).mock.calls,
    ...vi.mocked(console.error).mock.calls,
  ]
    .map(c => c.join(' '))
    .join('\n');
}

let exitCode: number | undefined;
const EXIT_SENTINEL = '__process_exit__';

async function expectLoudFailure(args: string[] = []): Promise<string> {
  await expect(runInstall(['--transport', 'http', '--skill', 'none', ...args])).rejects.toThrow(EXIT_SENTINEL);
  expect(exitCode).toBeDefined();
  expect(exitCode).not.toBe(0);
  expect(exitCode).toBe(1);
  return operatorOutput();
}

/** Config writes toward supervisor.config.json's temp path, in call order. */
function configWriteContents(): string[] {
  return vi
    .mocked(fs.writeFileSync)
    .mock.calls.filter(([p]) => (p as any)?.toString() === CONFIG_TMP_PATH)
    .map(([, content]) => (content as any).toString());
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMgrMocks();
  exitCode = undefined;
  delete process.env.APRA_FLEET_DATA_DIR;
  delete process.env.APRA_FLEET_PORT;
  vi.mocked(os.homedir).mockReturnValue('/mock/home');
  makeFsMock();
  _setSeaOverride(true);
  _setManifestOverride({ version: '0.1.0', hooks: {}, scripts: {}, skills: {}, fleetSkills: {} } as any);
  // bd already installed by default -- keeps the Beads step from attempting
  // a real npm install under these mocks.
  vi.mocked(execFileSync).mockReturnValue('bd 1.3.0\n' as any);
  _setFleetSePrereqStepDeps({ detectFleetSePrereqs: vi.fn().mockReturnValue(SATISFIED) });
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
  _resetFleetSePrereqStepDeps();
  _resetFleetSeToolchainStepDeps();
  delete process.env.APRA_FLEET_ENABLE_FLEET_SE_TOOLCHAIN_SEED;
  vi.restoreAllMocks();
});

describe('install -- toolchain-seed step disabled by default under NODE_ENV=test (no behaviour change to any other suite)', () => {
  it('writes no toolchain config when APRA_FLEET_ENABLE_FLEET_SE_TOOLCHAIN_SEED is unset, even with a resolver injected', async () => {
    const resolver = vi.fn().mockReturnValue(RESOLVED_TOOLCHAIN);
    _setFleetSeToolchainStepDeps({ resolveFleetSeToolchainPaths: resolver });

    await expect(runInstall(['--transport', 'http', '--skill', 'none'])).resolves.toBeUndefined();
    expect(exitCode).toBeUndefined();
    expect(resolver).not.toHaveBeenCalled();
    expect(configWriteContents()).toHaveLength(0);
  });
});

describe('install --workflows all (opted in) -- toolchain-seed step', () => {
  beforeEach(() => {
    process.env.APRA_FLEET_ENABLE_FLEET_SE_TOOLCHAIN_SEED = '1';
  });

  it('criterion 1: a normal install records an absolute nodePath and bdPath', async () => {
    const resolver = vi.fn().mockReturnValue(RESOLVED_TOOLCHAIN);
    _setFleetSeToolchainStepDeps({ resolveFleetSeToolchainPaths: resolver });

    await expect(runInstall(['--transport', 'http', '--skill', 'none'])).resolves.toBeUndefined();
    expect(exitCode).toBeUndefined();
    expect(resolver).toHaveBeenCalledTimes(1);

    const writes = configWriteContents();
    expect(writes).toHaveLength(1);
    const written = JSON.parse(writes[0]);
    expect(path.isAbsolute(written.toolchain.nodePath)).toBe(true);
    expect(written.toolchain.nodePath).toBe(RESOLVED_TOOLCHAIN.node.path);
    expect(written.toolchain.bdPath).toBe(RESOLVED_TOOLCHAIN.bd.path);
  });

  it('criterion 2: running install twice is idempotent -- no duplicated or lost keys', async () => {
    const resolver = vi.fn().mockReturnValue(RESOLVED_TOOLCHAIN);
    _setFleetSeToolchainStepDeps({ resolveFleetSeToolchainPaths: resolver });

    await runInstall(['--transport', 'http', '--skill', 'none']);
    const firstWrite = JSON.parse(configWriteContents()[0]);

    // The written file becomes the "existing" file the second install reads.
    makeFsMock({}, { [CONFIG_PATH]: JSON.stringify(firstWrite) });
    await runInstall(['--transport', 'http', '--skill', 'none']);
    const writesAfterSecondRun = configWriteContents();
    const secondWrite = JSON.parse(writesAfterSecondRun[writesAfterSecondRun.length - 1]);

    expect(Object.keys(secondWrite).sort()).toEqual(Object.keys(firstWrite).sort());
    expect(Object.keys(secondWrite.toolchain).sort()).toEqual(Object.keys(firstWrite.toolchain).sort());
    expect(secondWrite.toolchain.nodePath).toBe(firstWrite.toolchain.nodePath);
  });

  it('criterion 3: --project-dir plus this step ends with BOTH projectDir and toolchain present', async () => {
    const PROJECT_DIR = path.resolve('/mock/project-a');
    const PROJECT_BEADS_DIR = path.join(PROJECT_DIR, '.beads');
    makeFsMock({ [PROJECT_DIR]: true, [PROJECT_BEADS_DIR]: true });
    // The two seed writers (project-dir, toolchain) each read-merge-write the
    // SAME file, so this case needs a fs double that actually PERSISTS
    // between calls (unlike makeFsMock()'s static answers) to observe both
    // keys surviving in the final file -- exactly the "toolchain and
    // projectDir must never clobber each other" contract being asserted.
    let storedConfig: string | undefined;
    let tempConfig: string | undefined;
    vi.mocked(fs.writeFileSync).mockImplementation(((p: any, content: any) => {
      if (p.toString() === CONFIG_TMP_PATH) tempConfig = content.toString();
    }) as any);
    vi.mocked(fs.renameSync).mockImplementation(((from: any, to: any) => {
      if (to.toString() === CONFIG_PATH) storedConfig = tempConfig;
    }) as any);
    vi.mocked(fs.readFileSync).mockImplementation(((p: any) => {
      const ps = p.toString();
      if (ps === CONFIG_PATH) {
        if (storedConfig === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return storedConfig;
      }
      if (ps === PROJECT_DIR || ps === PROJECT_BEADS_DIR) return '';
      if (ps.includes('version.json')) return JSON.stringify({ version: '0.1.0' });
      if (ps.includes('hooks-config.json')) return JSON.stringify({ hooks: { PostToolUse: [] } });
      if (ps.includes('install-config.json')) return JSON.stringify({ providers: { claude: { skill: 'all' } } });
      if (ps.includes('settings.json')) return JSON.stringify({});
      return '';
    }) as any);
    vi.mocked(execFileSync).mockImplementation(((file: any, args: any) => {
      const argv: string[] = Array.isArray(args) ? args : [];
      if (file === 'npm') return 'added 1 package\n' as any;
      if (file === 'git') return 'https://example.invalid/acme/demo.git\n' as any;
      if (file === 'bd') {
        if (argv[0] === '--version') return 'bd 1.3.0\n' as any;
        if (argv[0] === 'config') return JSON.stringify({ key: 'sync.remote', value: 'https://example.invalid/acme/demo.git' }) as any;
      }
      return '' as any;
    }) as any);
    const resolver = vi.fn().mockReturnValue(RESOLVED_TOOLCHAIN);
    _setFleetSeToolchainStepDeps({ resolveFleetSeToolchainPaths: resolver });

    await expect(
      runInstall(['--transport', 'http', '--skill', 'none', '--project-dir', PROJECT_DIR]),
    ).resolves.toBeUndefined();
    expect(exitCode).toBeUndefined();

    const writes = configWriteContents();
    // One write for the project-dir seed, one for the toolchain seed (order
    // between them does not matter -- key preservation makes both survive).
    expect(writes.length).toBeGreaterThanOrEqual(2);
    const last = JSON.parse(writes[writes.length - 1]);
    expect(last.projectDir).toBe(PROJECT_DIR);
    expect(last.toolchain.nodePath).toBe(RESOLVED_TOOLCHAIN.node.path);
  });

  it('criterion 4: --workflows none writes nothing at all, even with the step opted in', async () => {
    const resolver = vi.fn().mockReturnValue(RESOLVED_TOOLCHAIN);
    _setFleetSeToolchainStepDeps({ resolveFleetSeToolchainPaths: resolver });

    await expect(
      runInstall(['--transport', 'http', '--skill', 'none', '--workflows', 'none']),
    ).resolves.toBeUndefined();
    expect(exitCode).toBeUndefined();
    expect(resolver).not.toHaveBeenCalled();
    expect(configWriteContents()).toHaveLength(0);
  });

  it('criterion 4b: an existing supervisor.config.json is left untouched by --workflows none', async () => {
    makeFsMock({ [CONFIG_PATH]: true }, { [CONFIG_PATH]: JSON.stringify({ projectDir: '/mock/older' }) });
    const resolver = vi.fn().mockReturnValue(RESOLVED_TOOLCHAIN);
    _setFleetSeToolchainStepDeps({ resolveFleetSeToolchainPaths: resolver });

    await runInstall(['--transport', 'http', '--skill', 'none', '--workflows', 'none']);
    expect(configWriteContents()).toHaveLength(0);
  });

  it('criterion 5a: an unresolvable node fails the install loudly and non-zero, naming the reason', async () => {
    const resolver = vi.fn().mockReturnValue(NODE_UNRESOLVED_TOOLCHAIN);
    _setFleetSeToolchainStepDeps({ resolveFleetSeToolchainPaths: resolver });

    const out = await expectLoudFailure();
    expect(out).toContain('node');
    expect(out).toContain(NODE_UNRESOLVED_TOOLCHAIN.node.reason);
    expect(configWriteContents()).toHaveLength(0);
    expect(supervisorMgr.register).not.toHaveBeenCalled();
  });

  it('criterion 5b: an unresolvable bd does NOT fail the install -- records a null bdPath and proceeds', async () => {
    const resolver = vi.fn().mockReturnValue(BD_UNRESOLVED_TOOLCHAIN);
    _setFleetSeToolchainStepDeps({ resolveFleetSeToolchainPaths: resolver });

    await expect(runInstall(['--transport', 'http', '--skill', 'none'])).resolves.toBeUndefined();
    expect(exitCode).toBeUndefined();

    const writes = configWriteContents();
    expect(writes).toHaveLength(1);
    const written = JSON.parse(writes[0]);
    expect(written.toolchain.bdPath).toBeNull();
    expect(written.toolchain.nodePath).toBe(BD_UNRESOLVED_TOOLCHAIN.node.path);
    expect(supervisorMgr.register).toHaveBeenCalled();
  });

  it('criterion 6: the recording happens before registerSupervisorService() is called', async () => {
    const resolver = vi.fn().mockReturnValue(RESOLVED_TOOLCHAIN);
    _setFleetSeToolchainStepDeps({ resolveFleetSeToolchainPaths: resolver });

    await runInstall(['--transport', 'http', '--skill', 'none']);
    expect(exitCode).toBeUndefined();

    const writeOrders = vi
      .mocked(fs.writeFileSync)
      .mock.calls.map((call, i) => ({ call, order: vi.mocked(fs.writeFileSync).mock.invocationCallOrder[i] }))
      .filter(({ call }) => (call[0] as any)?.toString() === CONFIG_TMP_PATH)
      .map(({ order }) => order);
    expect(writeOrders.length).toBeGreaterThan(0);
    expect(supervisorMgr.register.mock.invocationCallOrder.length).toBeGreaterThan(0);
    expect(writeOrders[0]).toBeLessThan(supervisorMgr.register.mock.invocationCallOrder[0]);
  });

  it('placement: resolveFleetSeToolchainPaths() is called after the Beads step has probed bd', async () => {
    const resolver = vi.fn().mockReturnValue(RESOLVED_TOOLCHAIN);
    _setFleetSeToolchainStepDeps({ resolveFleetSeToolchainPaths: resolver });

    // Force the Beads step to actually run its npm-install branch by making
    // the FIRST bd probe fail, then succeed after npm install.
    let bdInstalled = false;
    vi.mocked(execFileSync).mockImplementation(((file: any, args: any) => {
      const argv: string[] = Array.isArray(args) ? args : [];
      if (file === 'npm' && argv[0] === 'install') {
        bdInstalled = true;
        return 'added 1 package\n' as any;
      }
      if (file === 'bd') {
        if (!bdInstalled) throw new Error('spawn bd ENOENT');
        return 'bd 1.3.0\n' as any;
      }
      return '' as any;
    }) as any);

    await runInstall(['--transport', 'http', '--skill', 'none']);
    expect(exitCode).toBeUndefined();

    const npmInstallOrder = vi
      .mocked(execFileSync)
      .mock.calls.map((call, i) => ({ call, order: vi.mocked(execFileSync).mock.invocationCallOrder[i] }))
      .filter(({ call }) => call[0] === 'npm')
      .map(({ order }) => order)[0];
    const resolverCallOrder = resolver.mock.invocationCallOrder[0];
    expect(npmInstallOrder).toBeDefined();
    expect(resolverCallOrder).toBeGreaterThan(npmInstallOrder);
  });
});
