import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInstall, _setSeaOverride, _setManifestOverride } from '../src/cli/install.js';
import { writeInstallConfig, INSTALL_CONFIG_PATH } from '../src/cli/config.js';

// apra-fleet-7pm.5 -- install.ts additive workflow-install step
// (~/.apra-fleet/node_modules, /schemas, /workflows/{auto-sprint,hello-world}),
// the --workflows <all|none> flag, and install-config workflowsMode persistence.
// See docs/workflow-subsystem-plan.md Section 6 / Section 2.1.

vi.mock('node:os', () => ({
  default: {
    homedir: vi.fn(() => '/mock/home'),
    platform: vi.fn(() => 'linux'),
  }
}));
vi.mock('node:fs');
vi.mock('node:child_process');

const mockHome = '/mock/home';
const NODE_MODULES_DIR = path.join(mockHome, '.apra-fleet', 'node_modules');
const SCHEMAS_DIR = path.join(mockHome, '.apra-fleet', 'schemas');
const WORKFLOWS_DIR = path.join(mockHome, '.apra-fleet', 'workflows');

const OLD_MANIFEST = { version: '0.1.0', hooks: {}, scripts: {}, skills: {}, fleetSkills: {}, agents: {}, workflows: {} };

const NEW_MANIFEST = {
  ...OLD_MANIFEST,
  workflowRuntime: {
    '@apralabs/apra-fleet-workflow/package.json': '@apralabs/apra-fleet-workflow/package.json',
    '@apralabs/apra-fleet-workflow/src/index.js': '@apralabs/apra-fleet-workflow/src/index.js',
    '@apralabs/apra-fleet-client/package.json': '@apralabs/apra-fleet-client/package.json',
    'ajv/package.json': 'ajv/package.json',
  },
  agentSchemas: {
    'agentSchemas/pm.schema.json': 'packages/apra-fleet-se/apra-pm/agents/schemas/pm.schema.json',
  },
  builtinWorkflows: {
    'auto-sprint/workflow.json': 'auto-sprint/workflow.json',
    'auto-sprint/main.mjs': 'auto-sprint/main.mjs',
    'hello-world/workflow.json': 'hello-world/workflow.json',
    'hello-world/main.mjs': 'hello-world/main.mjs',
  },
};

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
    return '';
  });
  vi.mocked(fs.readdirSync).mockReturnValue([] as any);
  vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
  vi.mocked(fs.chmodSync).mockImplementation(() => {});
  vi.mocked(fs.copyFileSync).mockImplementation(() => {});
  vi.mocked(fs.writeFileSync).mockImplementation(() => {});
  vi.mocked(fs.rmSync).mockImplementation(() => undefined as any);
  vi.mocked(fs.renameSync).mockImplementation(() => undefined as any);
}

describe('install-config workflowsMode persistence (writeInstallConfig unit test)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHome);
    makeFsMock();
  });

  it('defaults workflowsMode to "all" when not specified', () => {
    writeInstallConfig('claude', 'all');
    const call = vi.mocked(fs.writeFileSync).mock.calls.find(c => c[0] === INSTALL_CONFIG_PATH);
    expect(call).toBeDefined();
    const data = JSON.parse(call![1] as string);
    expect(data.providers.claude.workflowsMode).toBe('all');
  });

  it('persists workflowsMode "none" when passed explicitly', () => {
    writeInstallConfig('claude', 'all', 'none');
    const call = vi.mocked(fs.writeFileSync).mock.calls.find(c => c[0] === INSTALL_CONFIG_PATH);
    const data = JSON.parse(call![1] as string);
    expect(data.providers.claude.workflowsMode).toBe('none');
  });
});

describe('runInstall --workflows flag -> install-config.json (T: apra-fleet-7pm.5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHome);
    makeFsMock();
    _setSeaOverride(false);
    _setManifestOverride(OLD_MANIFEST as any);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    _setSeaOverride(null);
    _setManifestOverride(null);
  });

  it('a default install writes workflowsMode: "all"', async () => {
    await runInstall([]);
    const call = vi.mocked(fs.writeFileSync).mock.calls.find(c => c[0] === path.join(mockHome, '.apra-fleet', 'data', 'install-config.json'));
    const data = JSON.parse(call![1] as string);
    expect(data.providers.claude.workflowsMode).toBe('all');
  });

  it('--workflows none writes workflowsMode: "none"', async () => {
    await runInstall(['--workflows', 'none']);
    const call = vi.mocked(fs.writeFileSync).mock.calls.find(c => c[0] === path.join(mockHome, '.apra-fleet', 'data', 'install-config.json'));
    const data = JSON.parse(call![1] as string);
    expect(data.providers.claude.workflowsMode).toBe('none');
  });

  it('--workflows=none (equals form) writes workflowsMode: "none"', async () => {
    await runInstall(['--workflows=none']);
    const call = vi.mocked(fs.writeFileSync).mock.calls.find(c => c[0] === path.join(mockHome, '.apra-fleet', 'data', 'install-config.json'));
    const data = JSON.parse(call![1] as string);
    expect(data.providers.claude.workflowsMode).toBe('none');
  });

  it('rejects an invalid --workflows value', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    await expect(runInstall(['--workflows', 'bogus'])).rejects.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});

describe('runInstall --workflows none: byte-identical existing-step behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHome);
    makeFsMock();
    _setSeaOverride(false);
    _setManifestOverride(OLD_MANIFEST as any);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    _setSeaOverride(null);
    _setManifestOverride(null);
  });

  it('emits no workflow-runtime step line and no workflow-dir writes when --workflows none', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runInstall(['--skill', 'none', '--workflows', 'none']);
    const logs = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logs).not.toContain('Installing workflow runtime');
    // Pre-workflow-subsystem numbering preserved: base=6 steps (no skills, no service in dev
    // mode) +1 dolt (apra-fleet-ire.3, unconditional) = 7.
    expect(logs).toContain('[7/7]');

    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls.map(c => c[0].toString());
    expect(writeCalls.some(p => p.startsWith(NODE_MODULES_DIR))).toBe(false);
    expect(writeCalls.some(p => p.startsWith(SCHEMAS_DIR))).toBe(false);
    expect(writeCalls.some(p => p.startsWith(WORKFLOWS_DIR))).toBe(false);
    logSpy.mockRestore();
  });
});

describe('runInstall workflow-runtime extraction (new manifest)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHome);
    makeFsMock();
    _setSeaOverride(false);
    _setManifestOverride(NEW_MANIFEST as any);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    _setSeaOverride(null);
    _setManifestOverride(null);
  });

  it('extracts node_modules packages grouped by top-level package name (extract-to-temp-then-rename)', async () => {
    await runInstall(['--skill', 'none']);

    const renameCalls = vi.mocked(fs.renameSync).mock.calls;
    const workflowPkgDest = path.join(NODE_MODULES_DIR, '@apralabs', 'apra-fleet-workflow');
    const clientPkgDest = path.join(NODE_MODULES_DIR, '@apralabs', 'apra-fleet-client');
    const ajvPkgDest = path.join(NODE_MODULES_DIR, 'ajv');

    expect(renameCalls.some(c => c[1] === workflowPkgDest)).toBe(true);
    expect(renameCalls.some(c => c[1] === clientPkgDest)).toBe(true);
    expect(renameCalls.some(c => c[1] === ajvPkgDest)).toBe(true);

    // The temp source dir for each rename is a sibling of the final dir (extract-to-temp-then-rename).
    const workflowRename = renameCalls.find(c => c[1] === workflowPkgDest)!;
    expect((workflowRename[0] as string).startsWith(`${workflowPkgDest}.tmp-`)).toBe(true);
  });

  it('writes agent schemas under ~/.apra-fleet/schemas (agentSchemas/ prefix stripped)', async () => {
    await runInstall(['--skill', 'none']);
    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls.map(c => c[0].toString());
    expect(writeCalls).toContain(path.join(SCHEMAS_DIR, 'pm.schema.json'));
  });

  it('clears+extracts only the named built-in workflow subdirectory, never the workflows/ root', async () => {
    await runInstall(['--skill', 'none']);

    const renameCalls = vi.mocked(fs.renameSync).mock.calls;
    const autoSprintDest = path.join(WORKFLOWS_DIR, 'auto-sprint');
    const helloWorldDest = path.join(WORKFLOWS_DIR, 'hello-world');
    expect(renameCalls.some(c => c[1] === autoSprintDest)).toBe(true);
    expect(renameCalls.some(c => c[1] === helloWorldDest)).toBe(true);

    // clearDirSync/rmSync must never target the workflows/ root itself.
    const rmCalls = vi.mocked(fs.rmSync).mock.calls.map(c => c[0].toString());
    expect(rmCalls).not.toContain(WORKFLOWS_DIR);
  });

  it('writes workflows/.installed.json with the built-in list and installed version', async () => {
    await runInstall(['--skill', 'none']);
    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const installedCall = writeCalls.find(c => c[0] === path.join(WORKFLOWS_DIR, '.installed.json'));
    expect(installedCall).toBeDefined();
    const data = JSON.parse(installedCall![1] as string);
    expect(data.builtin.sort()).toEqual(['auto-sprint', 'hello-world']);
    expect(typeof data.version).toBe('string');
  });
});

describe('runInstall old-manifest compatibility (no workflow asset sections)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHome);
    makeFsMock();
    _setSeaOverride(false);
    _setManifestOverride(OLD_MANIFEST as any);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    _setSeaOverride(null);
    _setManifestOverride(null);
  });

  it('skips the workflow step with a warning instead of crashing when manifest keys are absent', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(runInstall(['--skill', 'none'])).resolves.toBeUndefined();
    const warns = warnSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(warns).toContain('no workflow-subsystem assets');

    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls.map(c => c[0].toString());
    expect(writeCalls.some(p => p.startsWith(NODE_MODULES_DIR))).toBe(false);
    expect(writeCalls.some(p => p.startsWith(SCHEMAS_DIR))).toBe(false);
    warnSpy.mockRestore();
  });
});

describe('runInstall EBUSY handling on a locked built-in workflow directory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHome);
    makeFsMock();
    _setSeaOverride(false);
    _setManifestOverride(NEW_MANIFEST as any);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    _setSeaOverride(null);
    _setManifestOverride(null);
  });

  it('warns and skips only the locked directory, install still exits 0 (resolves)', async () => {
    const autoSprintDest = path.join(WORKFLOWS_DIR, 'auto-sprint');
    vi.mocked(fs.renameSync).mockImplementation(((_src: any, dest: any) => {
      if (dest === autoSprintDest) {
        const err: NodeJS.ErrnoException = new Error('resource busy or locked');
        err.code = 'EBUSY';
        throw err;
      }
      return undefined as any;
    }) as any);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(runInstall(['--skill', 'none'])).resolves.toBeUndefined();

    const warns = warnSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(warns).toContain('workflows/auto-sprint');
    expect(warns).toContain('locked');

    // hello-world (not locked) still got its rename call through.
    const helloWorldDest = path.join(WORKFLOWS_DIR, 'hello-world');
    const renameCalls = vi.mocked(fs.renameSync).mock.calls;
    expect(renameCalls.some(c => c[1] === helloWorldDest)).toBe(true);

    warnSpy.mockRestore();
  }, 10000);
});

// apra-fleet-eft.19.2 -- regression coverage for apra-fleet-eft.19 (dev-mode
// install omits undici, crashing apra-fleet-client's transport.mjs with
// ERR_MODULE_NOT_FOUND). Every other suite in this file drives buildDevManifest()
// indirectly through a fully mocked node:fs (via _setManifestOverride), which
// can't observe what buildDevManifest() itself actually collects from disk.
// This suite unmocks node:fs for one test and calls the real buildDevManifest()
// (exposed as _buildDevManifestForTest) against this repo's real project root,
// so it fails if the undici collectPackageTree() call is ever dropped again.
describe('buildDevManifest bundles undici (regression for apra-fleet-eft.19)', () => {
  afterEach(() => {
    // Restore automocking for node:fs/node:child_process so later test files
    // (and, if vitest re-orders within this file, later tests here) get the
    // mocked fs used by every other suite above.
    vi.doMock('node:fs');
    vi.doMock('node:child_process');
  });

  it('includes an undici package-tree entry in the workflowRuntime manifest', async () => {
    vi.resetModules();
    vi.doUnmock('node:fs');
    vi.doUnmock('node:child_process');

    const real = await vi.importActual<typeof import('../src/cli/install.js')>('../src/cli/install.js');

    const testDir = path.dirname(fileURLToPath(import.meta.url));
    const projectRoot = path.resolve(testDir, '..');

    const manifest = real._buildDevManifestForTest(projectRoot);

    expect(manifest.workflowRuntime).toBeDefined();
    const keys = Object.keys(manifest.workflowRuntime ?? {});

    // Names undici explicitly: fails if the undici collectPackageTree() call
    // (apra-fleet-eft.19.1) is ever dropped from buildDevManifest again.
    expect(keys.some(k => k === 'undici/package.json')).toBe(true);
    expect(keys.some(k => k.startsWith('undici/'))).toBe(true);

    // undici-types is intentionally excluded (types-only, no runtime require
    // in undici's lib) -- assert the fix didn't over-bundle it either.
    expect(keys.some(k => k.startsWith('undici-types/'))).toBe(false);
  });
});
